import express from 'express'
import fs from 'fs'
import path from 'path'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadMultiple, uploadsDir } from '../middleware/upload.js'

const router = express.Router()

// Create new receipt
router.post('/', requireAuth, uploadMultiple, async (req, res) => {
  try {
    const d = req.body || {}
    const today = new Date().toISOString().slice(0,10)

    // Replace placeholders if needed
    const receiptNo = (d.receiptNo || '').replace('{{today}}', today)
    const date = d.date === '{{today}}' ? today : d.date || null

    const receiptDoc = {
      receipt_no: receiptNo,
      date: date,
      branch: d.branch || null,
      employee_name: d.employeeName || d.employee_name || null,
      emp_code: d.empCode || d.emp_code || null,
      user_id: req.user.sub,
      investor_id: d.investorId || d.investor_id || null,
      investor_name: d.investorName || d.investor_name || null,
      investor_address: d.investorAddress || d.investor_address || null,
      pin_code: d.pinCode || d.pin_code || null,
      pan: d.pan || null,
      email: d.email || null,
      scheme_name: d.schemeName || d.scheme_name || null,
      scheme_option: d.schemeOption || d.scheme_option || null,
      product_category: d.product_category || d.productCategory || null,
      investment_amount: d.investmentAmount || d.amount || null,
      folio_policy_no: d.folioPolicyNo || d.folio_policy_no || null,
      mode: d.mode || null,
      period_installments: d.period_installments || d.sip_stp_swp_period || null,
      installments_count: d.noOfInstallments || d.installments_count || null,
      txn_type: d.txnType || d.txn_type || null,
      from_text: d.from || d.from_text || null,
      to_text: d.to || d.to_text || null,
      units_or_amount: d.unitsOrAmount || d.units_or_amount || null,
      fd_type: d.fdType || d.fd_type || null,
      client_type: d.clientType || d.client_type || null,
      deposit_period_ym: d.depositPeriodYM || d.deposit_period_ym || null,
      roi_percent: d.roi || d.roi_percent || null,
      interest_payable: d.interestPayable || d.interest_payable || null,
      interest_frequency: d.interestFrequency || d.interest_frequency || null,
      instrument_type: d.instrumentType || d.instrument_type || null,
      instrument_no: d.instrumentNo || d.instrument_no || null,
      instrument_date: d.instrumentDate || d.instrument_date || null,
      bank_name: d.bankName || d.bank_name || null,
      bank_branch: d.bankBranch || d.bank_branch || null,
      fdr_demat_policy: d.fdr_demat_policy || null,
      renewal_due_date: d.renewalDueDate || d.renewal_due_date || null,
      maturity_amount: d.maturityAmount || d.maturity_amount || null,
      renewal_amount: d.renewalAmount || d.renewal_amount || null,
      issuer_company: d.issuerCompany || d.issuer_company || null,
      issuer_category: d.issuerCategory || d.issuer_category || null,
      is_deleted: false,
      created_at: new Date().toISOString()
    }

    const result = await getCollection('receipts').save(receiptDoc)
    const receiptId = result._key

    // Handle file uploads if any
    let uploadedFiles = []
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileData = {
          id: Date.now() + Math.random(), // Generate unique ID
          original_name: file.originalname,
          filename: file.filename,
          file_size: file.size,
          mime_type: file.mimetype,
          uploaded_by: req.user.sub,
          uploaded_at: new Date().toISOString()
        }
        uploadedFiles.push(fileData)
      }

      // Update the receipt with files
      await getCollection('receipts').update(receiptId, { files: uploadedFiles })
    }

    res.status(201).json({ 
      id: receiptId,
      files: uploadedFiles
    })
  } catch (e) {
    console.error('Insert failed:', e)
    
    // Clean up uploaded files if database insert fails
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path)
        } catch (unlinkError) {
          console.error('Failed to clean up file:', unlinkError)
        }
      })
    }
    
    res.status(400).json({ error: 'save_failed', detail: e.code || e.message || String(e) })
  }
})

// Get all receipts with filtering
router.get('/', requireAuth, async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      from,
      to,
      category,
      mode,
      issuer,
      emp_code,
      includeDeleted = '0'
    } = req.query

    // sanitize page & size
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))

    // sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'date', 'amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage  = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }
    let filterConditions = []

    // safe date filter (only if both provided and valid)
    if (
      from &&
      to &&
      !isNaN(Date.parse(from)) &&
      !isNaN(Date.parse(to))
    ) {
      filterConditions.push('receipt.date >= @from AND receipt.date <= @to')
      bindVars.from = from
      bindVars.to = to
    }

    if (category) {
      filterConditions.push('receipt.product_category == @category')
      bindVars.category = category
    }
    if (mode) {
      filterConditions.push('receipt.mode == @mode')
      bindVars.mode = mode
    }
    if (issuer) {
      filterConditions.push('receipt.issuer_company LIKE @issuer')
      bindVars.issuer = `%${issuer}%`
    }

    if (req.user.role === 'employee') {
      filterConditions.push('receipt.user_id == @user_id')
      bindVars.user_id = req.user.sub
    } else if (emp_code) {
      filterConditions.push('receipt.emp_code == @emp_code')
      bindVars.emp_code = emp_code
    }

    // only admins can include deleted
    if (!(req.user.role === 'admin' && includeDeleted === '1')) {
      filterConditions.push('receipt.is_deleted == false')
    }

    if (filterConditions.length > 0) {
      filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
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

    res.json({ page: numPage, size: numLimit, total, items: rows })
 
  } catch (err) {
    console.error('Error fetching receipts:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

// Get receipts by employee code
router.get('/emp/:empCode', requireAuth, async (req, res) => {
  try {
    const {
      from,
      to,
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      includeDeleted = '0'
    } = req.query

    const requestedEmpCode = req.params.empCode
    const isAdmin = req.user.role === 'admin'
    const authedEmpCode = req.user.emp_code

    // Role guard: employees can only access their own emp_code
    if (!isAdmin && requestedEmpCode !== authedEmpCode) {
      return res.status(403).json({ error: 'forbidden' })
    }

    // Paging + sorting
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'date', 'amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage  = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { emp_code: requestedEmpCode, limit: numLimit, offset: numOffset }
    let filterConditions = ['receipt.emp_code == @emp_code']

    // Safe date filter only if both are valid
    if (
      typeof from === 'string' && typeof to === 'string' &&
      from.trim() && to.trim() &&
      !isNaN(Date.parse(from.trim())) &&
      !isNaN(Date.parse(to.trim()))
    ) {
      filterConditions.push('receipt.date >= @from AND receipt.date <= @to')
      bindVars.from = from.trim()
      bindVars.to = to.trim()
    }

    // includeDeleted only for admins
    if (!(isAdmin && includeDeleted === '1')) {
      filterConditions.push('receipt.is_deleted == false')
    }

    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`

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

    res.json({ page: numPage, size: numLimit, total, items: rows })
  } catch (err) {
    console.error('Error fetching receipts by emp_code:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

// Get single receipt
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    
    // Get receipt with media count
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN MERGE(receipt, {
        media_count: LENGTH(receipt.files || [])
      })
    `, { id })
    
    if (!receiptRows.length) return res.status(404).json({ error: 'not_found' })
    
    const receipt = receiptRows[0]
    
    // Get media files if requested
    const includeMedia = req.query.include_media === 'true'
    if (includeMedia) {
      try {
        if (receipt.files) {
          const filesData = receipt.files
          // Get user names for uploaded_by fields
          const userIds = [...new Set(filesData.map(f => f.uploaded_by))]
          const users = await q(`
            FOR user IN users
            FILTER user._key IN @userIds
            RETURN { id: user._key, name: user.name }
          `, { userIds })
          const userMap = users.reduce((acc, user) => {
            acc[user.id] = user.name
            return acc
          }, {})
          
          receipt.media_files = filesData.map(file => ({
            ...file,
            uploaded_by_name: userMap[file.uploaded_by] || 'Unknown'
          }))
        } else {
          receipt.media_files = []
        }
      } catch (parseError) {
        console.warn('Failed to parse files JSON:', parseError)
        receipt.media_files = []
      }
    }
    
    res.json(receipt)
  } catch (error) {
    console.error('Error fetching receipt:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Update receipt
router.patch('/:id', requireAuth, async (req, res) => {
  const id = req.params.id
  const own = await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    LIMIT 1
    RETURN { id: receipt._key, user_id: receipt.user_id }
  `, { id })
  if (!own.length) return res.status(404).json({ error: 'not_found' })
  if (!(req.user.role === 'admin' || String(own[0].user_id) === String(req.user.sub))) return res.status(403).json({ error: 'forbidden' })
  
  const allowed = [
    'date','branch','scheme_name','scheme_option','investment_amount','folio_policy_no','mode',
    'period_installments','installments_count','txn_type','from_text','to_text','units_or_amount',
    'fd_type','client_type','deposit_period_ym','roi_percent','interest_payable','interest_frequency',
    'instrument_type','instrument_no','instrument_date','bank_name','bank_branch','fdr_demat_policy',
    'renewal_due_date','maturity_amount','renewal_amount','issuer_company','issuer_category','product_category'
  ]
  const d = req.body || {}
  const updates = {}
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(d, k)) {
      updates[k] = d[k]
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_updates' })
  
  await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    UPDATE receipt WITH @updates IN receipts
  `, { id, updates })
  res.status(204).end()
})

// Update receipt status
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    const { status } = req.body || {}
    
    if (!status) {
      return res.status(400).json({ error: 'missing_status', detail: 'Status is required' })
    }
    
    // Validate status values
    const validStatuses = ['Pending', 'Completed', 'Cancelled']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', detail: `Status must be one of: ${validStatuses.join(', ')}` })
    }
    
    // Check if receipt exists and get ownership info
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, status: receipt.status }
    `, { id })
    
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    const receipt = receiptRows[0]
    
    // Check permissions - only admin can update status
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', detail: 'Only admin users can update receipt status' })
    }
    
    // Update the receipt status
    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH { 
        status: @status,
        status_updated_at: DATE_ISO8601(DATE_NOW()),
        status_updated_by: @user_id
      } IN receipts
    `, { id, status, user_id: req.user.sub })
    
    res.status(200).json({ 
      message: 'Status updated successfully',
      receipt_id: id,
      new_status: status
    })
    
  } catch (error) {
    console.error('Error updating receipt status:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Soft delete receipt
router.delete('/:id', requireAuth, async (req, res) => {
  const id = req.params.id
  const { reason = null } = req.body || {}
  const rows = await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    LIMIT 1
    RETURN { id: receipt._key, user_id: receipt.user_id }
  `, { id })
  if (!rows.length) return res.status(404).json({ error: 'not_found' })

  await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    UPDATE receipt WITH {
      is_deleted: true,
      deleted_at: DATE_NOW(),
      deleted_by: @deleted_by,
      delete_reason: @reason
    } IN receipts
  `, { id, deleted_by: req.user.sub, reason })
  res.status(204).end()
})

// Restore receipt (admin only)
router.post('/:id/restore', requireAuth, requireRole('admin'), async (req, res) => {
  const id = req.params.id
  await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    UPDATE receipt WITH {
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      delete_reason: null
    } IN receipts
  `, { id })
  res.status(204).end()
})

export default router
