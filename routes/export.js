import express from 'express'
import { q } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

// Export receipts to CSV
router.get('/receipts', requireAuth, async (req, res) => {
  try {
    const { from, to, branch_code } = req.query
    let query = `
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
    `
    let bindVars = {}
    
    if (from) {
      query += ` AND receipt.created_at >= @from`
      bindVars.from = from
    }
    if (to) {
      query += ` AND receipt.created_at <= @to`
      bindVars.to = to
    }
    if (branch_code) {
      query += ` AND receipt.branch == @branch_code`
      bindVars.branch_code = branch_code
    }
    
    query += `
      SORT receipt.created_at DESC
      RETURN {
        receipt_id: receipt._key,
        investor_id: receipt.investor_id,
        investor_name: receipt.investor_name,
        investor_pan: receipt.pan,
        investor_phone: receipt.phone || '',
        investor_email: receipt.email,
        amount: receipt.investment_amount,
        category: receipt.product_category,
        payment_method: receipt.mode,
        branch_code: receipt.branch,
        branch_name: receipt.branch,
        created_by: receipt.user_id,
        created_at: receipt.created_at,
        status: receipt.is_deleted ? 'deleted' : 'active',
        notes: receipt.notes || ''
      }
    `
    
    const receipts = await q(query, bindVars)
    
    // Convert to CSV
    const headers = [
      'Receipt ID', 'Investor ID', 'Investor Name', 'PAN', 'Phone', 'Email',
      'Amount', 'Category', 'Payment Method', 'Branch Code', 'Branch Name',
      'Created By', 'Created At', 'Status', 'Notes'
    ]
    
    const csvRows = [headers.join(',')]
    
    receipts.forEach(receipt => {
      const row = [
        receipt.receipt_id,
        receipt.investor_id,
        `"${receipt.investor_name}"`,
        receipt.investor_pan,
        receipt.investor_phone,
        receipt.investor_email,
        receipt.amount,
        receipt.category,
        receipt.payment_method,
        receipt.branch_code,
        `"${receipt.branch_name}"`,
        receipt.created_by,
        receipt.created_at,
        receipt.status,
        `"${receipt.notes || ''}"`
      ]
      csvRows.push(row.join(','))
    })
    
    const csv = csvRows.join('\n')
    
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="receipts_${new Date().toISOString().split('T')[0]}.csv"`)
    res.send(csv)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export receipts' })
  }
})

// Export customers to CSV
router.get('/customers', requireAuth, async (req, res) => {
  try {
    const customers = await q(`
      FOR customer IN customers
      RETURN {
        investor_id: customer.investor_id,
        name: customer.investor_name,
        pan: customer.pan,
        phone: customer.phone,
        email: customer.email,
        address: customer.investor_address,
        city: customer.city,
        state: customer.state,
        pincode: customer.pin_code,
        created_at: customer.created_at,
        updated_at: customer.updated_at
      }
    `)
    
    const headers = [
      'Investor ID', 'Name', 'PAN', 'Phone', 'Email', 'Address', 'City', 'State', 'Pincode', 'Created At', 'Updated At'
    ]
    
    const csvRows = [headers.join(',')]
    
    customers.forEach(customer => {
      const row = [
        customer.investor_id,
        `"${customer.name}"`,
        customer.pan,
        customer.phone,
        customer.email,
        `"${customer.address || ''}"`,
        `"${customer.city || ''}"`,
        `"${customer.state || ''}"`,
        customer.pincode,
        customer.created_at,
        customer.updated_at
      ]
      csvRows.push(row.join(','))
    })
    
    const csv = csvRows.join('\n')
    
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="customers_${new Date().toISOString().split('T')[0]}.csv"`)
    res.send(csv)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export customers' })
  }
})

// Export users to CSV (admin only)
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await q(`
      FOR user IN users
      RETURN {
        emp_code: user.emp_code,
        name: user.name,
        email: user.email,
        role: user.role,
        branch: user.branch,
        is_active: user.is_active,
        created_at: user.created_at,
        last_login_at: user.last_login_at
      }
    `)
    
    const headers = [
      'Employee Code', 'Name', 'Email', 'Role', 'Branch', 'Active', 'Created At', 'Last Login'
    ]
    
    const csvRows = [headers.join(',')]
    
    users.forEach(user => {
      const row = [
        user.emp_code,
        `"${user.name}"`,
        user.email,
        user.role,
        `"${user.branch || ''}"`,
        user.is_active,
        user.created_at,
        user.last_login_at || ''
      ]
      csvRows.push(row.join(','))
    })
    
    const csv = csvRows.join('\n')
    
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="users_${new Date().toISOString().split('T')[0]}.csv"`)
    res.send(csv)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export users' })
  }
})

// Export branches to CSV (admin only)
router.get('/branches', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const branches = await q(`
      FOR branch IN branches
      RETURN {
        branch_code: branch.branch_code,
        branch_name: branch.branch_name,
        branch_type: branch.branch_type,
        address: branch.address,
        phone: branch.phone,
        email: branch.email,
        created_at: branch.created_at
      }
    `)
    
    const headers = [
      'Branch Code', 'Branch Name', 'Type', 'Address', 'Phone', 'Email', 'Created At'
    ]
    
    const csvRows = [headers.join(',')]
    
    branches.forEach(branch => {
      const row = [
        branch.branch_code,
        `"${branch.branch_name}"`,
        branch.branch_type,
        `"${branch.address || ''}"`,
        branch.phone,
        branch.email,
        branch.created_at
      ]
      csvRows.push(row.join(','))
    })
    
    const csv = csvRows.join('\n')
    
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="branches_${new Date().toISOString().split('T')[0]}.csv"`)
    res.send(csv)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export branches' })
  }
})

export default router
