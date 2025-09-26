import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { Database } from 'arangojs'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const {
  PORT = 8080,
  ARANGO_URL = 'http://localhost:8529',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend',
  JWT_SECRET = 'change-me',
  CORS_ORIGIN = '*'
} = process.env

// File upload configuration
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const uploadsDir = path.join(__dirname, 'uploads', 'receipts')

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, `receipt-${uniqueSuffix}${ext}`)
  }
})

const fileFilter = (req, file, cb) => {
  // Allow images, PDFs, and common document formats
  const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt/
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
  const mimetype = allowedTypes.test(file.mimetype)
  
  if (mimetype && extname) {
    return cb(null, true)
  } else {
    cb(new Error('Only images, PDFs, and documents are allowed'))
  }
}

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: fileFilter
})

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, credentials: true }))

// Serve uploaded files statically
app.use('/uploads', express.static(uploadsDir))
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })

// ArangoDB connection
const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
})

// Helper function to execute AQL queries
const q = async (query, bindVars = {}) => {
  try {
    const cursor = await db.query(query, bindVars)
    return await cursor.all()
  } catch (error) {
    console.error('ArangoDB query error:', error)
    throw error
  }
}

// Helper function to get a collection
const getCollection = (name) => db.collection(name)

const requireAuth = (req, res, next) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (!token) return res.status(401).json({ error: 'unauthorized' })
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = payload
    next()
  } catch {
    return res.status(401).json({ error: 'unauthorized' })
  }
}

const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) return res.status(403).json({ error: 'forbidden' })
  next()
}

/* AUTH */
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { emp_code, password } = req.body || {}
  if (!emp_code || !password) return res.status(400).json({ error: 'missing_fields' })
  
  const users = await q(`
    FOR user IN users 
    FILTER user.emp_code == @emp_code AND user.is_active == true
    LIMIT 1
    RETURN user
  `, { emp_code })
  
  if (!users.length) return res.status(401).json({ error: 'invalid_credentials' })
  const user = users[0]
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' })
  
  await q(`
    UPDATE @id WITH { last_login_at: DATE_NOW() } IN users
  `, { id: user._id })
  
  const token = jwt.sign({ sub: user._key, role: user.role, emp_code: user.emp_code, name: user.name }, JWT_SECRET, { expiresIn: '8h' })
  res.json({ token, user: { id: user._key, emp_code: user.emp_code, role: user.role, name: user.name, branch: user.branch } })
})

/* USERS */
app.get('/api/users/me', requireAuth, async (req, res) => {
  const users = await q(`
    FOR user IN users 
    FILTER user._key == @id
    LIMIT 1
    RETURN {
      id: user._key,
      emp_code: user.emp_code,
      name: user.name,
      email: user.email,
      branch: user.branch,
      role: user.role,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
      created_at: user.created_at
    }
  `, { id: req.user.sub })
  
  if (!users.length) return res.status(404).json({ error: 'not_found' })
  res.json(users[0])
})

app.get('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const users = await q(`
    FOR user IN users 
    SORT user.created_at DESC
    RETURN {
      id: user._key,
      emp_code: user.emp_code,
      name: user.name,
      email: user.email,
      branch: user.branch,
      role: user.role,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
      created_at: user.created_at
    }
  `)
  res.json(users)
})

app.post('/api/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { emp_code, name, email, branch, role = 'employee', password } = req.body || {}
  if (!emp_code || !name || !password) return res.status(400).json({ error: 'missing_fields' })
  const hash = await bcrypt.hash(password, 10)
  try {
    const userDoc = {
      emp_code,
      name,
      email: email || null,
      branch: branch || null,
      role,
      password_hash: hash,
      is_active: true,
      created_at: new Date().toISOString()
    }
    const result = await getCollection('users').save(userDoc)
    res.status(201).json({ id: result._key })
  } catch (e) {
    res.status(400).json({ error: 'create_failed', detail: e.code || String(e) })
  }
})

app.patch('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = req.params.id
  const { name, email, branch, role, is_active } = req.body || {}
  const updates = {}
  
  if (name !== undefined) updates.name = name
  if (email !== undefined) updates.email = email
  if (branch !== undefined) updates.branch = branch
  if (role !== undefined) updates.role = role
  if (is_active !== undefined) updates.is_active = is_active
  
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_updates' })
  
  try {
    await getCollection('users').update(id, updates)
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

app.patch('/api/users/:id/password', requireAuth, async (req, res) => {
  const uid = req.params.id
  if (!(req.user.role === 'admin' || String(req.user.sub) === String(uid))) return res.status(403).json({ error: 'forbidden' })
  const { password } = req.body || {}
  if (!password) return res.status(400).json({ error: 'missing_password' })
  const hash = await bcrypt.hash(password, 10)
  
  try {
    await getCollection('users').update(uid, { password_hash: hash })
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

app.delete('/api/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = req.params.id
  try {
    await getCollection('users').update(id, { is_active: false })
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

/* CUSTOMERS */
app.get('/api/customers', requireAuth, async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      search,
      includeDeleted = '0'
    } = req.query

    // Sanitize pagination
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))

    // Sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'investor_name', 'investor_id'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }

    // Search functionality
    if (search) {
      filterClause = `
        FILTER customer.investor_name LIKE @search 
           OR customer.investor_id LIKE @search 
           OR customer.pan LIKE @search 
           OR customer.email LIKE @search 
           OR customer.phone LIKE @search
      `
      bindVars.search = `%${search}%`
    }

    const query = `
      FOR customer IN customers
      ${filterClause}
      SORT customer.${orderBy} ${sortDir}
      LIMIT @offset, @limit
      RETURN customer
    `

    const countQuery = `
      FOR customer IN customers
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, bindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ page: numPage, size: numLimit, total, items: rows })
  } catch (error) {
    console.error('Error fetching customers:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.get('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    const customers = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id })
    
    if (!customers.length) return res.status(404).json({ error: 'not_found' })
    res.json(customers[0])
  } catch (error) {
    console.error('Error fetching customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.post('/api/customers', requireAuth, async (req, res) => {
  try {
    const {
      investor_name,
      investor_address,
      pin_code,
      pan,
      email,
      phone,
      dob
    } = req.body || {}

    if (!investor_name) {
      return res.status(400).json({ error: 'missing_fields', detail: 'investor_name is required' })
    }

    // Check if PAN already exists (if provided)
    if (pan) {
      const existingPan = await q(`
        FOR customer IN customers 
        FILTER customer.pan == @pan
        LIMIT 1
        RETURN customer.investor_id
      `, { pan })
      if (existingPan.length) {
        return res.status(400).json({ error: 'duplicate_pan', detail: 'PAN number already exists' })
      }
    }

    // Get the next investor_id
    const maxIdResult = await q(`
      FOR customer IN customers
      COLLECT AGGREGATE maxId = MAX(customer.investor_id)
      RETURN maxId
    `)
    const nextId = (maxIdResult[0] || 0) + 1

    const customerDoc = {
      investor_id: nextId,
      investor_name,
      investor_address: investor_address || null,
      pin_code: pin_code || null,
      pan: pan || null,
      email: email || null,
      phone: phone || null,
      dob: dob || null,
      created_at: new Date().toISOString()
    }

    const result = await getCollection('customers').save(customerDoc)
    res.status(201).json({ investor_id: nextId })
  } catch (error) {
    console.error('Error creating customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.post('/api/customers/bulk', requireAuth, async (req, res) => {
  try {
    const { customers } = req.body || {}

    if (!Array.isArray(customers) || customers.length === 0) {
      return res.status(400).json({ error: 'invalid_data', detail: 'customers array is required' })
    }

    if (customers.length > 100) {
      return res.status(400).json({ error: 'too_many_items', detail: 'Maximum 100 customers per batch' })
    }

    const results = []
    const errors = []

    for (let i = 0; i < customers.length; i++) {
      const customer = customers[i]
      const {
        investor_name,
        investor_address,
        pin_code,
        pan,
        email,
        phone,
        dob
      } = customer

      try {
        if (!investor_name) {
          errors.push({ index: i, error: 'investor_name is required' })
          continue
        }

        // Check if PAN already exists (if provided)
        if (pan) {
          const existingPan = await q(`
            FOR customer IN customers 
            FILTER customer.pan == @pan
            LIMIT 1
            RETURN customer.investor_id
          `, { pan })
          if (existingPan.length) {
            errors.push({ index: i, error: 'PAN number already exists' })
            continue
          }
        }

        // Get the next investor_id
        const maxIdResult = await q(`
          FOR customer IN customers
          COLLECT AGGREGATE maxId = MAX(customer.investor_id)
          RETURN maxId
        `)
        const nextId = (maxIdResult[0] || 0) + 1

        const customerDoc = {
          investor_id: nextId,
          investor_name,
          investor_address: investor_address || null,
          pin_code: pin_code || null,
          pan: pan || null,
          email: email || null,
          phone: phone || null,
          dob: dob || null,
          created_at: new Date().toISOString()
        }

        const result = await getCollection('customers').save(customerDoc)
        results.push({ index: i, investor_id: nextId, investor_name })
      } catch (error) {
        errors.push({ index: i, error: error.message })
      }
    }

    res.status(201).json({
      message: `Processed ${customers.length} customers`,
      successful: results.length,
      failed: errors.length,
      results,
      errors
    })
  } catch (error) {
    console.error('Error in bulk customer creation:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.patch('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    const {
      investor_name,
      investor_address,
      pin_code,
      pan,
      email,
      phone,
      dob
    } = req.body || {}

    // Check if customer exists
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer._id
    `, { id })
    if (!existing.length) {
      return res.status(404).json({ error: 'not_found' })
    }

    // Check if PAN already exists for another customer (if provided)
    if (pan) {
      const existingPan = await q(`
        FOR customer IN customers 
        FILTER customer.pan == @pan AND customer.investor_id != @id
        LIMIT 1
        RETURN customer.investor_id
      `, { pan, id })
      if (existingPan.length) {
        return res.status(400).json({ error: 'duplicate_pan', detail: 'PAN number already exists for another customer' })
      }
    }

    const updates = {}
    if (investor_name !== undefined) updates.investor_name = investor_name
    if (investor_address !== undefined) updates.investor_address = investor_address
    if (pin_code !== undefined) updates.pin_code = pin_code
    if (pan !== undefined) updates.pan = pan
    if (email !== undefined) updates.email = email
    if (phone !== undefined) updates.phone = phone
    if (dob !== undefined) updates.dob = dob

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_updates' })
    }

    await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      UPDATE customer WITH @updates IN customers
    `, { id, updates })

    res.status(204).end()
  } catch (error) {
    console.error('Error updating customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id

    // Check if customer exists
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer._id
    `, { id })
    if (!existing.length) {
      return res.status(404).json({ error: 'not_found' })
    }

    // Check if customer has any receipts
    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.investor_id == @id AND receipt.is_deleted == false
      COLLECT WITH COUNT INTO count
      RETURN count
    `, { id })
    if (receipts[0] > 0) {
      return res.status(400).json({ 
        error: 'cannot_delete', 
        detail: `Cannot delete customer with ${receipts[0]} associated receipts` 
      })
    }

    // Hard delete since customers table doesn't have soft delete columns
    await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      REMOVE customer IN customers
    `, { id })

    res.status(204).end()
  } catch (error) {
    console.error('Error deleting customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Note: Restore endpoint removed since customers table doesn't have soft delete columns

/* RECEIPTS: CREATE */
app.post('/api/receipts', requireAuth, upload.array('files', 10), async (req, res) => {
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
      investment_amount: d.investmentAmount || d.investment_amount || null,
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
/* RECEIPTS: LIST */
app.get('/api/receipts', requireAuth, async (req, res) => {
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
    const allowedSort = new Set(['created_at', 'date', 'investment_amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage  = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }

    // safe date filter (only if both provided and valid)
    if (
      from &&
      to &&
      !isNaN(Date.parse(from)) &&
      !isNaN(Date.parse(to))
    ) {
      filterClause += 'FILTER receipt.date >= @from AND receipt.date <= @to\n'
      bindVars.from = from
      bindVars.to = to
    }

    if (category) {
      filterClause += 'FILTER receipt.product_category == @category\n'
      bindVars.category = category
    }
    if (mode) {
      filterClause += 'FILTER receipt.mode == @mode\n'
      bindVars.mode = mode
    }
    if (issuer) {
      filterClause += 'FILTER receipt.issuer_company LIKE @issuer\n'
      bindVars.issuer = `%${issuer}%`
    }

    if (req.user.role === 'employee') {
      filterClause += 'FILTER receipt.user_id == @user_id\n'
      bindVars.user_id = req.user.sub
    } else if (emp_code) {
      filterClause += 'FILTER receipt.emp_code == @emp_code\n'
      bindVars.emp_code = emp_code
    }

    // only admins can include deleted
    if (!(req.user.role === 'admin' && includeDeleted === '1')) {
      filterClause += 'FILTER receipt.is_deleted == false\n'
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

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, bindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ page: numPage, size: numLimit, total, items: rows })
 
  } catch (err) {
    console.error('Error fetching receipts:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

/* RECEIPTS: LIST BY EMP_CODE */
app.get('/api/receipts/emp/:empCode', requireAuth, async (req, res) => {
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
    const allowedSort = new Set(['created_at', 'date', 'investment_amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage  = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = 'FILTER receipt.emp_code == @emp_code\n'
    let bindVars = { emp_code: requestedEmpCode, limit: numLimit, offset: numOffset }

    // Safe date filter only if both are valid
    if (
      typeof from === 'string' && typeof to === 'string' &&
      from.trim() && to.trim() &&
      !isNaN(Date.parse(from.trim())) &&
      !isNaN(Date.parse(to.trim()))
    ) {
      filterClause += 'FILTER receipt.date >= @from AND receipt.date <= @to\n'
      bindVars.from = from.trim()
      bindVars.to = to.trim()
    }

    // includeDeleted only for admins
    if (!(isAdmin && includeDeleted === '1')) {
      filterClause += 'FILTER receipt.is_deleted == false\n'
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

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, bindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ page: numPage, size: numLimit, total, items: rows })
  } catch (err) {
    console.error('Error fetching receipts by emp_code:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

/* RECEIPTS: GET ONE */
app.get('/api/receipts/:id', requireAuth, async (req, res) => {
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

/* RECEIPTS: UPDATE */
app.patch('/api/receipts/:id', requireAuth, async (req, res) => {
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

/* RECEIPTS: SOFT DELETE / RESTORE */
app.delete('/api/receipts/:id', requireAuth, async (req, res) => {
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

app.post('/api/receipts/:id/restore', requireAuth, requireRole('admin'), async (req, res) => {
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

/* RECEIPT MEDIA UPLOAD */
app.post('/api/receipts/:id/media', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    const receiptId = req.params.id
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'no_files_uploaded' })
    }
    
    // Parse existing files or initialize empty array
    let existingFiles = receipt.files || []
    
    const uploadedFiles = []
    
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
      
      existingFiles.push(fileData)
      uploadedFiles.push(fileData)
    }
    
    // Update the receipt with new files array
    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH { files: @files } IN receipts
    `, { id: receiptId, files: existingFiles })
    
    res.status(201).json({
      message: 'Files uploaded successfully',
      files: uploadedFiles
    })
    
  } catch (error) {
    console.error('Media upload error:', error)
    
    // Clean up uploaded files if database update fails
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path)
        } catch (unlinkError) {
          console.error('Failed to clean up file:', unlinkError)
        }
      })
    }
    
    res.status(500).json({ error: 'upload_failed', detail: error.message })
  }
})

/* RECEIPT MEDIA LIST */
app.get('/api/receipts/:id/media', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    // Parse files from JSON column
    let mediaFiles = []
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
        
        mediaFiles = filesData.map(file => ({
          ...file,
          uploaded_by_name: userMap[file.uploaded_by] || 'Unknown'
        }))
      }
    } catch (parseError) {
      console.warn('Failed to parse files JSON:', parseError)
      mediaFiles = []
    }
    
    res.json(mediaFiles)
    
  } catch (error) {
    console.error('Media list error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/* RECEIPT MEDIA DOWNLOAD */
app.get('/api/receipts/:id/media/:mediaId', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    const mediaId = req.params.mediaId // Keep as string since it's generated as timestamp + random
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    // Parse files from JSON column and find the specific media
    let mediaFile = null
    try {
      if (receipt.files) {
        const filesData = receipt.files
        mediaFile = filesData.find(file => String(file.id) === String(mediaId))
      }
    } catch (parseError) {
      console.warn('Failed to parse files JSON:', parseError)
    }
    
    if (!mediaFile) {
      return res.status(404).json({ error: 'media_not_found' })
    }
    
    // Construct file path
    const filePath = path.join(uploadsDir, mediaFile.filename)
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'file_not_found' })
    }
    
    // Set appropriate headers
    res.setHeader('Content-Type', mediaFile.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${mediaFile.original_name}"`)
    res.setHeader('Content-Length', mediaFile.file_size)
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath)
    fileStream.pipe(res)
    
  } catch (error) {
    console.error('Media download error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/* RECEIPT MEDIA DELETE */
app.delete('/api/receipts/:id/media/:mediaId', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    const mediaId = req.params.mediaId // Keep as string since it's generated as timestamp + random
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    // Parse files from JSON column and find the specific media
    let filesData = receipt.files || []
    let mediaFile = null
    try {
      mediaFile = filesData.find(file => String(file.id) === String(mediaId))
    } catch (parseError) {
      console.warn('Failed to parse files JSON:', parseError)
    }
    
    if (!mediaFile) {
      return res.status(404).json({ error: 'media_not_found' })
    }
    
    // Remove the file from the array
    const updatedFiles = filesData.filter(file => String(file.id) !== String(mediaId))
    
    // Update the receipt with the new files array
    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH { files: @files } IN receipts
    `, { id: receiptId, files: updatedFiles })
    
    // Optionally delete the physical file (uncomment if you want to delete files permanently)
    // try {
    //   const filePath = path.join(uploadsDir, mediaFile.filename)
    //   fs.unlinkSync(filePath)
    // } catch (unlinkError) {
    //   console.error('Failed to delete physical file:', unlinkError)
    // }
    
    res.status(204).end()
    
  } catch (error) {
    console.error('Media delete error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/* STATS */
app.get('/api/stats/summary', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  
  if (from) { 
    filterClause += 'FILTER receipt.date >= @from\n'
    bindVars.from = from
  }
  if (to) { 
    filterClause += 'FILTER receipt.date <= @to\n'
    bindVars.to = to
  }
  if (req.user.role === 'employee') {
    filterClause += 'FILTER receipt.user_id == @user_id\n'
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterClause += 'FILTER receipt.emp_code == @emp_code\n'
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterClause += 'FILTER receipt.is_deleted == false\n'
  }
  
  const totalsQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE 
      total_receipts = LENGTH(1),
      total_collections = SUM(receipt.investment_amount || 0)
    RETURN { total_receipts, total_collections }
  `
  
  const byCatQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT category = receipt.product_category WITH COUNT INTO n
    AGGREGATE amount = SUM(receipt.investment_amount || 0)
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const byDayQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date WITH COUNT INTO n
    AGGREGATE amount = SUM(receipt.investment_amount || 0)
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const [totals, byCat, byDay] = await Promise.all([
    q(totalsQuery, bindVars),
    q(byCatQuery, bindVars),
    q(byDayQuery, bindVars)
  ])
  
  const totalCollections = totals[0]?.total_collections || 0
  const commissions_total = Number(totalCollections) * 0.01
  
  res.json({
    total_receipts: Number(totals[0]?.total_receipts || 0),
    total_collections: Number(totalCollections),
    commissions_total,
    by_category: byCat,
    by_day: byDay
  })
})

app.get('/api/stats/by-category', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  
  if (from) { 
    filterClause += 'FILTER receipt.date >= @from\n'
    bindVars.from = from
  }
  if (to) { 
    filterClause += 'FILTER receipt.date <= @to\n'
    bindVars.to = to
  }
  if (req.user.role === 'employee') {
    filterClause += 'FILTER receipt.user_id == @user_id\n'
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterClause += 'FILTER receipt.emp_code == @emp_code\n'
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterClause += 'FILTER receipt.is_deleted == false\n'
  }
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT category = receipt.product_category WITH COUNT INTO n
    AGGREGATE amount = SUM(receipt.investment_amount || 0)
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
})

app.get('/api/stats/by-day', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  
  if (from) { 
    filterClause += 'FILTER receipt.date >= @from\n'
    bindVars.from = from
  }
  if (to) { 
    filterClause += 'FILTER receipt.date <= @to\n'
    bindVars.to = to
  }
  if (req.user.role === 'employee') {
    filterClause += 'FILTER receipt.user_id == @user_id\n'
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterClause += 'FILTER receipt.emp_code == @emp_code\n'
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterClause += 'FILTER receipt.is_deleted == false\n'
  }
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date WITH COUNT INTO n
    AGGREGATE amount = SUM(receipt.investment_amount || 0)
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
})

/* HEALTH */
app.get('/health', async (req, res) => {
  try { 
    await q('RETURN 1')
    res.json({ ok: true }) 
  }
  catch { 
    res.status(500).json({ ok: false }) 
  }
})

const tals = (n) => Number(n || 0)

app.listen(PORT, () => {
  console.log('API listening on', PORT)
})
