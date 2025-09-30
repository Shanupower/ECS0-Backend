import express from 'express'
import bcrypt from 'bcryptjs'
import { q } from '../config/database.js'
import { requireAuth, requireRole, requireBranchAccess } from '../middleware/auth.js'

const router = express.Router()

// Get all branches
router.get('/', requireAuth, async (req, res) => {
  try {
    const { includeInactive = '0' } = req.query
    
    let filterClause = ''
    let bindVars = {}
    
    if (includeInactive !== '1') {
      filterClause = 'FILTER branch.is_active == true'
    }
    
    const query = `
      FOR branch IN branches
      ${filterClause}
      SORT branch.branch_name ASC
      RETURN {
        id: branch._key,
        branch_code: branch.branch_code,
        branch_name: branch.branch_name,
        branch_type: branch.branch_type,
        manager_name: branch.manager_name,
        manager_email: branch.manager_email,
        manager_phone: branch.manager_phone,
        address: branch.address,
        city: branch.city,
        state: branch.state,
        pin_code: branch.pin_code,
        is_active: branch.is_active,
        total_employees: branch.total_employees,
        total_customers: branch.total_customers,
        total_receipts: branch.total_receipts,
        total_investments: branch.total_investments,
        created_at: branch.created_at,
        updated_at: branch.updated_at
      }
    `
    
    const branches = await q(query, bindVars)
    res.json(branches)
  } catch (error) {
    console.error('Error fetching branches:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get single branch
router.get('/:branchCode', requireAuth, requireBranchAccess, async (req, res) => {
  try {
    const { branchCode } = req.params
    
    const branches = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      LIMIT 1
      RETURN branch
    `, { branchCode })
    
    if (!branches.length) return res.status(404).json({ error: 'not_found' })
    
    res.json(branches[0])
  } catch (error) {
    console.error('Error fetching branch:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get branch statistics
router.get('/:branchCode/stats', requireAuth, requireBranchAccess, async (req, res) => {
  try {
    const { branchCode } = req.params
    const { from, to, includeDeleted = '0' } = req.query
    
    // Get branch info
    const branchQuery = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      LIMIT 1
      RETURN branch
    `, { branchCode })
    
    if (!branchQuery.length) return res.status(404).json({ error: 'branch_not_found' })
    
    const branch = branchQuery[0]
    
    // Build date filter
    let dateFilter = ''
    let bindVars = {}
    
    if (from && to) {
      dateFilter = 'FILTER receipt.date >= @from AND receipt.date <= @to'
      bindVars.from = from
      bindVars.to = to
    }
    
    // Build deleted filter
    let deletedFilter = ''
    if (includeDeleted !== '1') {
      deletedFilter = 'FILTER receipt.is_deleted == false'
    }
    
    // Get branch statistics - only include completed receipts
    const statsQuery = `
      FOR receipt IN receipts
      FILTER receipt.branch == @branchName
      FILTER receipt.status == "Completed"
      ${dateFilter}
      ${deletedFilter}
      COLLECT AGGREGATE 
        total_receipts = LENGTH(1),
        total_investments = SUM(receipt.investment_amount || 0)
      RETURN { total_receipts, total_investments }
    `
    
    const stats = await q(statsQuery, { ...bindVars, branchName: branch.branch_name })
    
    // Get employee count for this branch
    const employeeCount = await q(`
      FOR user IN users
      FILTER user.branch == @branchName AND user.is_active == true
      COLLECT WITH COUNT INTO total
      RETURN total
    `, { branchName: branch.branch_name })
    
    // Get customer count for this branch
    const customerCount = await q(`
      FOR receipt IN receipts
      FILTER receipt.branch == @branchName
      ${dateFilter}
      ${deletedFilter}
      COLLECT investor_id = receipt.investor_id WITH COUNT INTO total
      COLLECT WITH COUNT INTO unique_customers
      RETURN unique_customers
    `, { ...bindVars, branchName: branch.branch_name })
    
    const result = {
      branch: {
        id: branch._key,
        branch_code: branch.branch_code,
        branch_name: branch.branch_name,
        branch_type: branch.branch_type
      },
      statistics: {
        total_employees: employeeCount[0] || 0,
        total_customers: customerCount[0] || 0,
        total_receipts: stats[0]?.total_receipts || 0,
        total_investments: stats[0]?.total_investments || 0,
        commissions: (stats[0]?.total_investments || 0) * 0.01
      }
    }
    
    res.json(result)
  } catch (error) {
    console.error('Error fetching branch stats:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get branch receipts
router.get('/:branchCode/receipts', requireAuth, requireBranchAccess, async (req, res) => {
  try {
    const { branchCode } = req.params
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      from,
      to,
      category,
      mode,
      includeDeleted = '0'
    } = req.query
    
    // Get branch info
    const branchQuery = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      LIMIT 1
      RETURN branch
    `, { branchCode })
    
    if (!branchQuery.length) return res.status(404).json({ error: 'branch_not_found' })
    
    const branch = branchQuery[0]
    
    // Sanitize pagination
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    
    // Sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'date', 'amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'
    
    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit
    
    let filterClause = 'FILTER receipt.branch == @branchName'
    let bindVars = { branchName: branch.branch_name, limit: numLimit, offset: numOffset }
    
    // Date filter
    if (from && to && !isNaN(Date.parse(from)) && !isNaN(Date.parse(to))) {
      filterClause += ' AND receipt.date >= @from AND receipt.date <= @to'
      bindVars.from = from
      bindVars.to = to
    }
    
    // Category filter
    if (category) {
      filterClause += ' AND receipt.product_category == @category'
      bindVars.category = category
    }
    
    // Mode filter
    if (mode) {
      filterClause += ' AND receipt.mode == @mode'
      bindVars.mode = mode
    }
    
    // Deleted filter
    if (includeDeleted !== '1') {
      filterClause += ' AND receipt.is_deleted == false'
    }
    
    const query = `
      FOR receipt IN receipts
      ${filterClause}
      SORT receipt.${orderBy} ${sortDir}
      LIMIT @offset, @limit
      RETURN MERGE(receipt, {
        media_count: LENGTH(receipt.files || [])
      })
    `
    
    const countQuery = `
      FOR receipt IN receipts
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.offset
    
    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])
    
    const total = totalResult[0] || 0
    
    res.json({ 
      branch: branch.branch_name,
      page: numPage, 
      size: numLimit, 
      total, 
      items: rows 
    })
  } catch (error) {
    console.error('Error fetching branch receipts:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Create new branch (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { branch_code, branch_name, branch_type, address, phone, email, password } = req.body
    
    if (!branch_code || !branch_name) {
      return res.status(400).json({ error: 'missing_fields', detail: 'Branch code and name are required' })
    }

    // Check if branch already exists
    const existingBranches = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branch_code OR LOWER(branch.branch_name) == LOWER(@branch_name)
      RETURN branch
    `, { branch_code, branch_name })

    if (existingBranches.length > 0) {
      return res.status(409).json({ error: 'branch_exists', detail: 'Branch with this code or name already exists' })
    }

    // Hash the password
    const password_hash = await bcrypt.hash(password || 'password123', 10)

    // Create new branch
    const newBranch = {
      branch_code: branch_code.toUpperCase(),
      branch_name: branch_name,
      branch_type: branch_type || 'operational',
      address: address || '',
      phone: phone || '',
      email: email || '',
      password_hash: password_hash,
      created_at: new Date().toISOString(),
      is_active: true
    }

    const result = await q(`
      INSERT @branch INTO branches
      RETURN NEW
    `, { branch: newBranch })

    res.status(201).json({
      message: 'Branch created successfully',
      branch: result[0]
    })
  } catch (error) {
    console.error('Branch creation error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to create branch' })
  }
})

// Update branch (admin only)
router.put('/:branchCode', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { branchCode } = req.params
    const { branch_name, branch_type, address, phone, email, password } = req.body

    const updateData = {
      updated_at: new Date().toISOString()
    }

    if (branch_name) updateData.branch_name = branch_name
    if (branch_type) updateData.branch_type = branch_type
    if (address !== undefined) updateData.address = address
    if (phone !== undefined) updateData.phone = phone
    if (email !== undefined) updateData.email = email
    if (password) updateData.password_hash = await bcrypt.hash(password, 10)

    const result = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      UPDATE branch WITH @updateData IN branches
      RETURN NEW
    `, { branchCode, updateData })

    if (!result.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Branch not found' })
    }

    res.json({
      message: 'Branch updated successfully',
      branch: result[0]
    })
  } catch (error) {
    console.error('Branch update error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to update branch' })
  }
})

// Delete branch (admin only)
router.delete('/:branchCode', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { branchCode } = req.params

    // Check if branch has any users
    const branchUsers = await q(`
      FOR user IN users
      FILTER user.branch_code == @branchCode AND user.is_active == true
      RETURN user
    `, { branchCode })

    if (branchUsers.length > 0) {
      return res.status(409).json({ 
        error: 'branch_has_users', 
        detail: 'Cannot delete branch with active users. Please reassign users first.' 
      })
    }

    const result = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      UPDATE branch WITH { is_active: false, deleted_at: DATE_NOW() } IN branches
      RETURN NEW
    `, { branchCode })

    if (!result.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Branch not found' })
    }

    res.json({ message: 'Branch deactivated successfully' })
  } catch (error) {
    console.error('Branch deletion error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to delete branch' })
  }
})

// Assign users to branch (admin only)
router.post('/:branchCode/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { branchCode } = req.params
    const { user_ids } = req.body

    if (!user_ids || !Array.isArray(user_ids)) {
      return res.status(400).json({ error: 'missing_fields', detail: 'User IDs array is required' })
    }

    // Verify branch exists
    const branch = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode AND branch.is_active == true
      RETURN branch
    `, { branchCode })

    if (!branch.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Branch not found' })
    }

    // Update users to assign them to the branch
    const results = []
    for (const userId of user_ids) {
      const result = await q(`
        UPDATE @id WITH { 
          branch: @branchName, 
          branch_code: @branchCode,
          updated_at: DATE_NOW() 
        } IN users
        RETURN NEW
      `, { id: userId, branchName: branch[0].branch_name, branchCode })

      if (result.length) {
        results.push(result[0])
      }
    }

    res.json({
      message: 'Users assigned to branch successfully',
      updated_users: results.length,
      users: results
    })
  } catch (error) {
    console.error('Branch user assignment error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to assign users to branch' })
  }
})

export default router
