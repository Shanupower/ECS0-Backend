import express from 'express'
import { q } from '../config/database.js'
import { requireAuth, requireRole, requireBranchAccess } from '../middleware/auth.js'
import { validateBranchCode, validateEmail, validateMobile, validatePIN, validateRequired } from '../utils/validators.js'
import { appendCategoryToFilterString, appendMfTxnTypeToFilterString } from '../utils/receipt-filters.js'

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
        monthly_target: branch.monthly_target != null ? TO_NUMBER(branch.monthly_target) : null,
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

    const doc = { ...branches[0] }
    delete doc.password_hash
    res.json(doc)
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
    const branchIdentifiers = [branch._key, branch.branch_code, branch.branch_name].filter(Boolean).map(String)
    
    // Build date filter (fallback to created_at date when receipt.date is missing)
    let dateFilter = ''
    let bindVars = {}
    const receiptDateExpr = '(receipt.date != null && receipt.date != "" ? receipt.date : SUBSTRING(receipt.created_at, 0, 10))'
    
    if (from && to) {
      dateFilter = `FILTER ${receiptDateExpr} >= @from AND ${receiptDateExpr} <= @to`
      bindVars.from = from
      bindVars.to = to
    }
    
    // Build deleted filter
    let deletedFilter = ''
    if (includeDeleted !== '1') {
      deletedFilter = 'FILTER receipt.is_deleted == false'
    }
    
    // Get branch statistics - include pending if requested (same logic as /stats/summary)
    const includePending = req.query.includePending === '1'
    const statusFilter = includePending
      ? 'FILTER (receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)'
      : 'FILTER receipt.status == "Completed"'
    // Same investment amount formula as stats: nested transaction.amount / product_details.fd first, then flat
    const invAmountExpr = '(TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0) : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0) : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0)'
    const statsQuery = `
      FOR receipt IN receipts
      FILTER receipt.branch IN @branchIdentifiers
      ${statusFilter}
      ${dateFilter}
      ${deletedFilter}
      COLLECT AGGREGATE 
        total_receipts = SUM(1),
        total_investments = SUM(${invAmountExpr}),
        total_cc = SUM(TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0),
        total_si = SUM(TO_NUMBER(receipt.service_income || receipt.si || 0) || 0)
      RETURN { total_receipts, total_investments, total_cc, total_si }
    `
    
    const stats = await q(statsQuery, { ...bindVars, branchIdentifiers })
    
    // Get employee count for this branch
    const employeeCount = await q(`
      FOR user IN users
      FILTER user.branch == @branchName AND user.is_active == true
      COLLECT WITH COUNT INTO total
      RETURN total
    `, { branchName: branch.branch_name })
    
    // Get customer count for this branch - use canonical branch key and customer.branches
    const branchKey = branch._key
    const customerCount = await q(`
      FOR customer IN customers
        FILTER IS_ARRAY(customer.branches) && @branchKey IN customer.branches
        COLLECT WITH COUNT INTO total
        RETURN total
    `, { branchKey })
    
    const totalInvestments = stats[0]?.total_investments || 0
    const totalCC = stats[0]?.total_cc || 0
    const totalSI = stats[0]?.total_si || 0
    
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
        total_investments: totalInvestments,
        collection_credit: totalCC,
        commissions: totalCC // Alias for backward compatibility
      }
    }
    
    // Only include service income for admins
    if (req.user.role === 'admin') {
      result.statistics.service_income = totalSI
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
      txn_type,
      status,
      emp_code,
      search,
      amount_min,
      amount_max,
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
    const branchIdentifiers = [branch._key, branch.branch_code, branch.branch_name].filter(Boolean).map(String)
    
    // Sanitize pagination
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    
    // Sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'date', 'amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'
    const effectiveAmountExpr = '((TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0) : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0) : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0))'
    const orderExpr = orderBy === 'amount' ? effectiveAmountExpr : `receipt.${orderBy}`
    
    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = 'FILTER receipt.branch IN @branchIdentifiers'
    let bindVars = { branchIdentifiers }
    
    // Date filter (fallback to created_at date when receipt.date is missing)
    const receiptDateExpr = '(receipt.date != null && receipt.date != "" ? receipt.date : SUBSTRING(receipt.created_at, 0, 10))'
    if (from && to && !isNaN(Date.parse(from)) && !isNaN(Date.parse(to))) {
      filterClause += ` AND ${receiptDateExpr} >= @from AND ${receiptDateExpr} <= @to`
      bindVars.from = from
      bindVars.to = to
    }
    
    if (category) {
      filterClause = appendCategoryToFilterString(filterClause, bindVars, category)
    }
    if (txn_type || mode) {
      filterClause = appendMfTxnTypeToFilterString(filterClause, bindVars, txn_type, mode)
    }

    // Status filter
    if (status) {
      if (status === 'Pending') {
        filterClause += ' AND (receipt.status == null OR receipt.status == @status)'
      } else {
        filterClause += ' AND receipt.status == @status'
      }
      bindVars.status = status
    }

    // Employee code filter (receipt.emp_code or receipt.employee.code)
    if (emp_code) {
      filterClause += ' AND (receipt.emp_code == @emp_code OR (receipt.employee != null && receipt.employee.code == @emp_code))'
      bindVars.emp_code = emp_code
    }
    
    // Deleted filter
    if (includeDeleted !== '1') {
      filterClause += ' AND receipt.is_deleted == false'
    }

    // Search filter: receipt no / investor fields
    if (search && String(search).trim()) {
      const s = String(search).trim()
      filterClause += ` AND (
        LIKE(receipt.receipt_no, CONCAT("%", @search, "%"), true)
        OR (receipt.investor != null && (
          LIKE(receipt.investor.name, CONCAT("%", @search, "%"), true)
          OR LIKE(receipt.investor.id, CONCAT("%", @search, "%"), true)
          OR LIKE(receipt.investor.pan, CONCAT("%", @search, "%"), true)
        ))
        OR LIKE(receipt.investor_name, CONCAT("%", @search, "%"), true)
        OR LIKE(receipt.investor_id, CONCAT("%", @search, "%"), true)
        OR LIKE(receipt.pan, CONCAT("%", @search, "%"), true)
      )`
      bindVars.search = s
    }

    // Amount range filter (best-effort numeric amount)
    const minAmt = amount_min != null && String(amount_min).trim() !== '' ? Number(amount_min) : null
    const maxAmt = amount_max != null && String(amount_max).trim() !== '' ? Number(amount_max) : null
    if (minAmt != null && !Number.isNaN(minAmt)) {
      filterClause += ` AND (${effectiveAmountExpr}) >= @amount_min`
      bindVars.amount_min = minAmt
    }
    if (maxAmt != null && !Number.isNaN(maxAmt)) {
      filterClause += ` AND (${effectiveAmountExpr}) <= @amount_max`
      bindVars.amount_max = maxAmt
    }
    
    const query = `
      FOR receipt IN receipts
      ${filterClause}
      SORT ${orderExpr} ${sortDir}
      LIMIT ${numOffset}, ${numLimit}
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
    const { branch_code, branch_name, branch_type, address, phone, email, monthly_target } = req.body
    
    // Validate required fields
    const branchCodeValidation = validateBranchCode(branch_code, true)
    if (!branchCodeValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: branchCodeValidation.error })
    }

    const branchNameValidation = validateRequired(branch_name, 'Branch name')
    if (!branchNameValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: branchNameValidation.error })
    }

    // Validate email if provided
    if (email) {
      const emailValidation = validateEmail(email, false)
      if (!emailValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
      }
    }

    // Validate phone if provided
    if (phone) {
      const phoneValidation = validateMobile(phone, false)
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: phoneValidation.error })
      }
    }

    // Check if branch already exists
    const existingBranches = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branch_code OR LOWER(branch.branch_name) == LOWER(@branch_name)
      RETURN branch
    `, { branch_code: branchCodeValidation.value, branch_name: branchNameValidation.value })

    if (existingBranches.length > 0) {
      return res.status(409).json({ error: 'branch_exists', detail: 'Branch with this code or name already exists' })
    }

    // Hash the password
    const password_hash = await bcrypt.hash(password || 'password123', 10)

    const newBranch = {
      branch_code: branch_code.toUpperCase(),
      branch_name: branch_name,
      branch_type: branch_type || 'operational',
      address: address || '',
      phone: phone || '',
      email: email || '',
      password_hash: password_hash,
      created_at: new Date().toISOString(),
      is_active: true,
      monthly_target:
        monthly_target !== undefined && monthly_target !== '' && monthly_target != null
          ? Number(monthly_target)
          : null
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
    const { branch_name, branch_type, address, phone, email, monthly_target } = req.body

    // Validate email if provided
    if (email !== undefined && email !== null && email !== '') {
      const emailValidation = validateEmail(email, false)
      if (!emailValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
      }
    }

    // Validate phone if provided
    if (phone !== undefined && phone !== null && phone !== '') {
      const phoneValidation = validateMobile(phone, false)
      if (!phoneValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: phoneValidation.error })
      }
    }

    const updateData = {
      updated_at: new Date().toISOString()
    }

    if (branch_name) updateData.branch_name = branch_name
    if (branch_type) updateData.branch_type = branch_type
    if (address !== undefined) updateData.address = address
    if (phone !== undefined && phone !== null && phone !== '') {
      const phoneValidation = validateMobile(phone, false)
      updateData.phone = phoneValidation.value
    } else if (phone !== undefined) {
      updateData.phone = phone
    }
    if (email !== undefined && email !== null && email !== '') {
      const emailValidation = validateEmail(email, false)
      updateData.email = emailValidation.value
    } else if (email !== undefined) {
      updateData.email = email
    }
    if (monthly_target !== undefined) {
      updateData.monthly_target =
        monthly_target === '' || monthly_target === null ? null : Number(monthly_target)
    }

    // Fetch existing branch to detect name changes
    const existing = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      LIMIT 1
      RETURN branch
    `, { branchCode })

    if (!existing.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Branch not found' })
    }

    const oldBranch = existing[0]

    const result = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      UPDATE branch WITH @updateData IN branches
      RETURN NEW
    `, { branchCode, updateData })

    const updatedBranch = result[0]

    // If branch_name changed, propagate to related customers (relationship_manager / display)
    if (branch_name && branch_name !== oldBranch.branch_name) {
      const oldName = oldBranch.branch_name
      const newName = branch_name
      console.log(`[Branch Rename] Propagating branch name change from "${oldName}" to "${newName}" to customers`)

      try {
        await q(`
          FOR customer IN customers
            LET rm = customer.relationship_manager
            LET rmd = customer.relationship_manager_display
            LET new_rm = (
              rm == null ? null :
              IS_ARRAY(rm)
                ? (FOR b IN rm RETURN b == @old ? @neu : b)
                : (rm == @old ? @neu : rm)
            )
            LET new_rmd = (
              rmd == null ? null :
              IS_ARRAY(rmd)
                ? (FOR b IN rmd RETURN b == @old ? @neu : b)
                : (rmd == @old ? @neu : rmd)
            )
            FILTER new_rm != rm OR new_rmd != rmd
            UPDATE customer WITH {
              relationship_manager: new_rm,
              relationship_manager_display: new_rmd
            } IN customers
        `, { old: oldName, neu: newName })
      } catch (propError) {
        console.error('[Branch Rename] Failed to propagate to customers:', propError)
        // Do not fail the branch update if propagation fails; just log for manual follow-up
      }
    }

    res.json({
      message: 'Branch updated successfully',
      branch: updatedBranch
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
