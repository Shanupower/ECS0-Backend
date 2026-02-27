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
        notes: receipt.notes || '',
        cc: receipt.collection_credit || receipt.cc || 0,
        si: receipt.service_income || receipt.si || 0
      }
    `
    
    const receipts = await q(query, bindVars)
    
    // Convert to CSV
    const headers = [
      'Receipt ID', 'Investor ID', 'Investor Name', 'PAN', 'Phone', 'Email',
      'Amount', 'Category', 'Payment Method', 'Branch Code', 'Branch Name',
      'Created By', 'Created At', 'Status', 'Notes', 'CC', 'SI'
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
        `"${receipt.notes || ''}"`,
        receipt.cc || 0,
        // Hide SI from non-admins
        req.user.role === 'admin' ? (receipt.si || 0) : ''
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

// Export detailed transaction history to CSV
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const {
      from,
      to,
      branch_code,
      emp_code,
      status,
      category,
      mode,
      txn_type
    } = req.query

    let query = `
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
    `
    const bindVars = {}

    if (from) {
      query += ` AND receipt.date >= @from`
      bindVars.from = from
    }
    if (to) {
      query += ` AND receipt.date <= @to`
      bindVars.to = to
    }
    if (branch_code) {
      query += ` AND receipt.branch == @branch_code`
      bindVars.branch_code = branch_code
    }
    if (emp_code) {
      query += ` AND receipt.emp_code == @emp_code`
      bindVars.emp_code = emp_code
    }
    if (status) {
      if (status === 'Pending') {
        query += ` AND (receipt.status == null OR receipt.status == @status)`
      } else {
        query += ` AND receipt.status == @status`
      }
      bindVars.status = status
    }
    if (category) {
      query += ` AND receipt.product_category == @category`
      bindVars.category = category
    }
    if (mode) {
      // Handle Switch Over specially - it's selected as a mode but stored as transaction type
      if (mode === 'Switch Over' || mode === 'SwitchOver' || mode === 'SWITCH_OVER' || mode === 'switch_over') {
        // For Switch Over, check transaction type fields instead of mode
        query += ` AND (receipt.txn_type == @switch_over_mode OR receipt.txn_type == @switch_over_mode_alt1 OR receipt.txn_type == @switch_over_mode_alt2 OR receipt.txn_type == @switch_over_mode_alt3 OR receipt.transaction_type == @switch_over_mode OR receipt.transaction_type == @switch_over_mode_alt1 OR receipt.transaction_type == @switch_over_mode_alt2 OR receipt.transaction_type == @switch_over_mode_alt3 OR receipt.switch_to_scheme_name != null)`
        bindVars.switch_over_mode = 'Switch Over'
        bindVars.switch_over_mode_alt1 = 'SwitchOver'
        bindVars.switch_over_mode_alt2 = 'SWITCH_OVER'
        bindVars.switch_over_mode_alt3 = 'switch_over'
      } else {
        // For other modes (SIP, SWP, STP, Lump Sum), filter by mode field
        query += ` AND receipt.mode == @mode`
        bindVars.mode = mode
      }
    }

    query += `
      SORT receipt.date DESC
      RETURN {
        receipt_id: receipt._key,
        date: receipt.date,
        branch: receipt.branch,
        emp_code: receipt.emp_code,
        investor_id: receipt.investor_id,
        investor_name: receipt.investor_name,
        product_category: receipt.product_category,
        investment_amount: receipt.investment_amount,
        cc: receipt.collection_credit || receipt.cc || 0,
        si: receipt.service_income || receipt.si || 0,
        status: receipt.status || 'Pending',
        transaction_type: receipt.transaction_type || receipt.txn_type || null,
        mode: receipt.mode || null,
        payment: receipt.payment || null,
        transaction_details: receipt.transaction_details || null
      }
    `

    const rows = await q(query, bindVars)

    const headers = [
      'Receipt ID', 'Date', 'Branch', 'Employee Code',
      'Investor ID', 'Investor Name', 'Product Category',
      'Investment Amount', 'CC', 'SI', 'Status',
      'Transaction Type', 'Mode',
      'Entry Mode', 'Channel', 'Reference No', 'Txn Date',
      'Instrument Type', 'Instrument No', 'Instrument Date',
      'Bank Name', 'Bank Branch', 'Txn Account Last4', 'Txn Notes'
    ]

    const csvRows = [headers.join(',')]

    rows.forEach(r => {
      // Prefer receipt.payment (stored format); fallback to legacy transaction_details
      const payment = r.payment || {}
      const legacy = r.transaction_details || {}
      const entryMode = payment.entry_mode ?? legacy.entry_mode ?? ''
      const channel = payment.channel ?? legacy.channel ?? ''
      const referenceNo = payment.reference_no ?? legacy.reference_no ?? ''
      const txnDate = payment.transaction_date ?? legacy.txn_date ?? ''
      const instrumentType = payment.instrument?.type ?? ''
      const instrumentNo = payment.instrument?.number ?? ''
      const instrumentDate = payment.instrument?.date ?? ''
      const bankName = payment.instrument?.bank?.name ?? legacy.bank_name ?? ''
      const bankBranch = payment.instrument?.bank?.branch ?? legacy.bank_branch ?? ''
      const accountLast4 = payment.account_last4 ?? legacy.account_last4 ?? ''
      const notes = payment.notes ?? legacy.notes ?? ''

      const row = [
        r.receipt_id,
        r.date || '',
        `"${r.branch || ''}"`,
        r.emp_code || '',
        r.investor_id || '',
        `"${r.investor_name || ''}"`,
        r.product_category || '',
        r.investment_amount || 0,
        r.cc || 0,
        // Hide SI for non-admins
        req.user.role === 'admin' ? (r.si || 0) : '',
        r.status || 'Pending',
        r.transaction_type || '',
        r.mode || '',
        entryMode,
        channel,
        referenceNo,
        txnDate,
        instrumentType,
        instrumentNo,
        instrumentDate,
        `"${bankName}"`,
        `"${bankBranch}"`,
        accountLast4,
        `"${notes}"`
      ]
      csvRows.push(row.join(','))
    })

    const csv = csvRows.join('\n')

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="transactions_${new Date().toISOString().split('T')[0]}.csv"`)
    res.send(csv)
  } catch (error) {
    console.error('CSV transaction export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export transactions' })
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
