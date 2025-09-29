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

// Trust proxy for rate limiting behind Nginx
app.set('trust proxy', 1)

app.use(express.json({ limit: '1mb' }))
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, credentials: true }))

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'ECS Backend API Server', 
    status: 'online',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  })
})

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database: ARANGO_DATABASE,
    uptime: process.uptime()
  })
})

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

// Helper function to get user's branch for filtering
const getUserBranch = async (userId) => {
  try {
    const users = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.branch
    `, { id: userId })
    return users.length > 0 ? users[0] : null
  } catch (error) {
    console.error('Error getting user branch:', error)
    return null
  }
}

// Helper function to normalize branch names for customer filtering
const normalizeBranchName = (userBranch) => {
  if (!userBranch) return null
  
  // Map user branch names to customer relationship_manager names
  const branchMapping = {
    'H.O': 'HEADOFFICE',
    'HO': 'HEADOFFICE',
    'HEAD OFFICE': 'HEADOFFICE',
    'HEADOFFICE': 'HEADOFFICE',
    'CHENNAI RO': 'CHENNAI T NAGAR',
    'JAYANAGAR': 'JAYA NAGAR',
    'CHEMBUR - MUMBAI': 'CHEMBUR-MUMBAI',
    'VIZAG': 'VISHAKAPATNAM',
    'MALLESWARAM': 'MALLESWARAM-BENGALURU',
    'BAGH AMBERPET': 'BAGHAMBERPET',
    'KUKAT PALLY': 'KUKATPALLY',
    'AMEER PET': 'AMEERPET',
    'CHENNAI - MADIPAKKAM': 'MADIPAKKAM CHENNAI',
    'RAJAHMUNDRY': 'RAJAMUNDRY'
  }
  
  return branchMapping[userBranch] || userBranch
}

// Helper function to check if user can access customer (branch-based filtering)
const canAccessCustomer = async (userId, customerRelationshipManager) => {
  try {
    console.log(`[Access Check] Checking access for user ${userId} to customer with RM ${customerRelationshipManager}`)
    
    // Admin users can access all customers
    const users = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: userId })
    
    if (users.length > 0 && users[0] === 'admin') {
      console.log(`[Access Check] User ${userId} is admin - access granted`)
      return true
    }
    
    // Non-admin users can only access their branch customers
    const userBranch = await getUserBranch(userId)
    console.log(`[Access Check] User ${userId} branch: ${userBranch}`)
    
    const normalizedUserBranch = normalizeBranchName(userBranch)
    console.log(`[Access Check] Normalized user branch: ${normalizedUserBranch}`)
    console.log(`[Access Check] Customer RM: ${customerRelationshipManager}`)
    
    const hasAccess = normalizedUserBranch && normalizedUserBranch === customerRelationshipManager
    console.log(`[Access Check] Access result: ${hasAccess}`)
    
    return hasAccess
  } catch (error) {
    console.error(`[Access Check] Error checking access for user ${userId}:`, error)
    throw error
  }
}

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

const requireBranch = (req, res, next) => {
  if (!req.user || !req.user.branch) return res.status(403).json({ error: 'branch_required' })
  next()
}

const requireBranchAccess = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' })
  
  // Admin and branch users can access any branch
  if (req.user.role === 'admin' || req.user.role === 'branch') {
    return next()
  }
  
  // For regular users, check if they have access to the requested branch
  const requestedBranch = req.params.branchCode || req.query.branch_code
  if (requestedBranch) {
    const userBranchLower = req.user.branch?.toLowerCase()
    const requestedBranchLower = requestedBranch.toLowerCase()
    
    if (userBranchLower !== requestedBranchLower) {
      return res.status(403).json({ error: 'branch_access_denied' })
    }
  }
  
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
  `, { id: user._key })
  
  const token = jwt.sign({ sub: user._key, role: user.role, emp_code: user.emp_code, name: user.name, branch_code: user.branch_code }, JWT_SECRET, { expiresIn: '8h' })
  res.json({ token, user: { id: user._key, emp_code: user.emp_code, role: user.role, name: user.name, branch: user.branch, branch_code: user.branch_code } })
})

// Branch login endpoint
app.post('/api/auth/branch-login', authLimiter, async (req, res) => {
  try {
    const { branch_name, password } = req.body || {}
    if (!branch_name || !password) return res.status(400).json({ error: 'missing_fields', detail: 'Branch name and password are required' })

    // Find branch by name (case-insensitive)
    const branches = await q(`
      FOR branch IN branches
      FILTER LOWER(branch.branch_name) == LOWER(@branch_name)
      RETURN branch
    `, { branch_name })

    if (!branches.length) {
      return res.status(401).json({ error: 'invalid_credentials', detail: 'Invalid branch name or password' })
    }

    const branch = branches[0]

    // Check if branch has a password_hash, if not, create one with default password
    if (!branch.password_hash) {
      const hashedPassword = await bcrypt.hash('password123', 10)
      await q(`
        UPDATE @id WITH { password_hash: @hashedPassword } IN branches
      `, { id: branch._key, hashedPassword })
      branch.password_hash = hashedPassword
    }

    // Verify password using bcrypt
    const isValidPassword = await bcrypt.compare(password, branch.password_hash)
    if (!isValidPassword) {
      return res.status(401).json({ error: 'invalid_credentials', detail: 'Invalid branch name or password' })
    }

    // Find a representative user from this branch for token generation
    const branchUsers = await q(`
      FOR user IN users
      FILTER LOWER(user.branch) == LOWER(@branch_name) AND user.is_active == true
      LIMIT 1
      RETURN user
    `, { branch_name: branch.branch_name })

    let user = null
    if (branchUsers.length > 0) {
      user = branchUsers[0]
      // Ensure the user has branch_code field
      user.branch_code = branch.branch_code
    } else {
      // Create a virtual branch user if no real user exists
      user = {
        _key: `branch_${branch.branch_code}`,
        emp_code: `BRANCH_${branch.branch_code}`,
        name: `${branch.branch_name} Branch`,
        email: branch.email || '',
        role: 'branch',
        branch: branch.branch_name,
        branch_code: branch.branch_code
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { sub: user._key, role: 'branch', branch: branch.branch_name, branch_code: branch.branch_code },
      JWT_SECRET,
      { expiresIn: '8h' }
    )

    res.json({
      token,
      user: {
        id: user._key,
        emp_code: user.emp_code,
        name: user.name,
        email: user.email,
        role: 'branch',
        branch: branch.branch_name,
        branch_code: branch.branch_code
      },
      branch: {
        id: branch._key,
        branch_code: branch.branch_code,
        branch_name: branch.branch_name,
        branch_type: branch.branch_type,
        address: branch.address,
        phone: branch.phone,
        email: branch.email
      }
    })
  } catch (error) {
    console.error('Branch login error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Internal server error' })
  }
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

/* BRANCH MANAGEMENT */
app.post('/api/branches', requireAuth, requireRole('admin'), async (req, res) => {
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

app.put('/api/branches/:branchCode', requireAuth, requireRole('admin'), async (req, res) => {
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

app.delete('/api/branches/:branchCode', requireAuth, requireRole('admin'), async (req, res) => {
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

app.post('/api/branches/:branchCode/users', requireAuth, requireRole('admin'), async (req, res) => {
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

/* BRANCHES */
app.get('/api/branches', requireAuth, async (req, res) => {
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

app.get('/api/branches/:branchCode', requireAuth, requireBranchAccess, async (req, res) => {
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

app.get('/api/branches/:branchCode/stats', requireAuth, requireBranchAccess, async (req, res) => {
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

app.get('/api/branches/:branchCode/receipts', requireAuth, requireBranchAccess, async (req, res) => {
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

app.post('/api/branches/:branchCode/receipts', requireAuth, requireBranchAccess, upload.array('files', 10), async (req, res) => {
  try {
    const { branchCode } = req.params
    const d = req.body || {}
    const today = new Date().toISOString().slice(0, 10)
    
    // Get branch info
    const branchQuery = await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      LIMIT 1
      RETURN branch
    `, { branchCode })
    
    if (!branchQuery.length) return res.status(404).json({ error: 'branch_not_found' })
    
    const branch = branchQuery[0]
    
    // Replace placeholders if needed
    const receiptNo = (d.receiptNo || '').replace('{{today}}', today)
    const date = d.date === '{{today}}' ? today : d.date || null
    
    const receiptDoc = {
      receipt_no: receiptNo,
      date: date,
      branch: branch.branch_name, // Use branch name from branch record
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
          id: Date.now() + Math.random(),
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
    
    // Update branch statistics
    await q(`
      FOR branch IN branches
      FILTER branch.branch_code == @branchCode
      UPDATE branch WITH {
        total_receipts: branch.total_receipts + 1,
        total_investments: branch.total_investments + (@amount || 0),
        updated_at: DATE_NOW()
      } IN branches
    `, { branchCode, amount: receiptDoc.investment_amount || 0 })
    
    res.status(201).json({ 
      id: receiptId,
      branch: branch.branch_name,
      files: uploadedFiles
    })
  } catch (e) {
    console.error('Branch receipt creation failed:', e)
    
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

    // Get user's branch for filtering
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    const userRole = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: req.user.sub })

    const isAdmin = userRole.length > 0 && userRole[0] === 'admin'

    // Sanitize pagination
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))

    // Sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'name', 'investor_id'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }

    // Branch-based filtering (unless admin)
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER customer.relationship_manager == @userBranch`
      bindVars.userBranch = normalizedUserBranch
    }

    // Search functionality
    if (search) {
      const searchFilter = `
        FILTER customer.name LIKE @search 
           OR customer.investor_id LIKE @search 
           OR customer.pan LIKE @search 
           OR customer.email LIKE @search 
           OR customer.mobile LIKE @search
      `
      
      if (filterClause) {
        filterClause += ` AND (customer.name LIKE @search 
           OR customer.investor_id LIKE @search 
           OR customer.pan LIKE @search 
           OR customer.email LIKE @search 
           OR customer.mobile LIKE @search)`
      } else {
        filterClause = searchFilter
      }
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
      page: numPage, 
      size: numLimit, 
      total, 
      items: rows,
      branch_filter: !isAdmin ? normalizedUserBranch : 'all',
      user_role: isAdmin ? 'admin' : 'branch_user'
    })
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
    
    const customer = customers[0]
    
    // Check if user can access this customer (branch-based filtering)
    const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
    if (!canAccess) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied - customer belongs to different branch' })
    }
    
    res.json(customer)
  } catch (error) {
    console.error('Error fetching customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.post('/api/customers', requireAuth, upload.array('media', 10), async (req, res) => {
  try {
    const {
      name,
      pan,
      email,
      mobile,
      address1,
      address2,
      address3,
      city,
      state,
      pin,
      date_of_birth,
      father_name,
      mother_name,
      occupation,
      annual_income,
      aadhar_number,
      title,
      country
    } = req.body || {}

    if (!name) {
      return res.status(400).json({ error: 'missing_fields', detail: 'Customer name is required' })
    }

    // Get user's branch to assign as relationship manager
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    if (!normalizedUserBranch) {
      return res.status(400).json({ error: 'invalid_user', detail: 'User branch not found' })
    }

    // Check if PAN already exists (if provided)
    if (pan && pan.trim() !== '') {
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

    // Handle uploaded media files
    let mediaDocuments = []
    if (req.files && req.files.length > 0) {
      mediaDocuments = req.files.map(file => ({
        id: Date.now() + Math.random(),
        original_name: file.originalname,
        filename: file.filename,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: req.user.sub,
        uploaded_at: new Date().toISOString(),
        file_path: file.path
      }))
    }

    const customerDoc = {
      investor_id: nextId,
      title: title || null,
      name,
      pan: pan && pan.trim() !== '' ? pan : null,
      email: email || null,
      mobile: mobile || null,
      address1: address1 || null,
      address2: address2 || null,
      address3: address3 || null,
      city: city || null,
      state: state || null,
      pin: pin || null,
      country: country || 'India',
      date_of_birth: date_of_birth || null,
      father_name: father_name || null,
      mother_name: mother_name || null,
      occupation: occupation || null,
      annual_income: annual_income ? Number(annual_income) : null,
      aadhar_number: aadhar_number || null,
      media_documents: mediaDocuments,
      relationship_manager: normalizedUserBranch, // Auto-assign user's branch
      created_at: new Date().toISOString(),
      is_active: true,
      source_type: 'manual_entry'
    }

    const result = await getCollection('customers').save(customerDoc)
    res.status(201).json({ 
      investor_id: nextId,
      relationship_manager: normalizedUserBranch,
      media_files: mediaDocuments.length,
      message: 'Customer created and assigned to your branch'
    })
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
    console.log(`[Customer Update] Starting update for customer ID: ${id}, User: ${req.user.sub}`)
    
    // Validate input
    if (!id || isNaN(Number(id))) {
      console.log(`[Customer Update] Invalid customer ID: ${id}`)
      return res.status(400).json({ error: 'invalid_customer_id', detail: 'Customer ID must be a valid number' })
    }

    const {
      name,
      pan,
      email,
      mobile,
      address1,
      address2,
      address3,
      city,
      state,
      pin,
      date_of_birth,
      father_name,
      mother_name,
      occupation,
      annual_income,
      aadhar_number
    } = req.body || {}

    console.log(`[Customer Update] Request body fields:`, Object.keys(req.body || {}))

    // Check if customer exists and get full customer data
    console.log(`[Customer Update] Checking if customer exists...`)
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id: Number(id) })
    
    if (!existing.length) {
      console.log(`[Customer Update] Customer not found: ${id}`)
      return res.status(404).json({ error: 'not_found', detail: `Customer with ID ${id} not found` })
    }

    const customer = existing[0]
    console.log(`[Customer Update] Found customer: ${customer.investor_id} - ${customer.name || customer.investor_name}`)
    
    // Check if user can access this customer (branch-based filtering)
    console.log(`[Customer Update] Checking access permissions...`)
    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
      console.log(`[Customer Update] Access check result: ${canAccess}`)
      
      if (!canAccess) {
        console.log(`[Customer Update] Access denied for user ${req.user.sub} to customer ${id}`)
        return res.status(403).json({ 
          error: 'forbidden', 
          detail: 'Access denied - customer belongs to different branch',
          customer_branch: customer.relationship_manager,
          user_id: req.user.sub
        })
      }
    } catch (accessError) {
      console.error(`[Customer Update] Access check failed:`, accessError)
      return res.status(500).json({ 
        error: 'access_check_failed', 
        detail: 'Failed to verify access permissions',
        error_message: accessError.message
      })
    }

    // Check if PAN already exists for another customer (if provided)
    if (pan && pan.trim() !== '') {
      console.log(`[Customer Update] Checking PAN uniqueness: ${pan}`)
      try {
        const existingPan = await q(`
          FOR customer IN customers 
          FILTER customer.pan == @pan AND customer.investor_id != @id
          LIMIT 1
          RETURN customer.investor_id
        `, { pan: pan.trim().toUpperCase(), id: Number(id) })
        
        if (existingPan.length) {
          console.log(`[Customer Update] PAN already exists for customer: ${existingPan[0]}`)
          return res.status(400).json({ 
            error: 'duplicate_pan', 
            detail: `PAN number already exists for customer ID ${existingPan[0]}` 
          })
        }
      } catch (panError) {
        console.error(`[Customer Update] PAN check failed:`, panError)
        return res.status(500).json({ 
          error: 'pan_check_failed', 
          detail: 'Failed to verify PAN uniqueness',
          error_message: panError.message
        })
      }
    }

    // Build updates object
    const updates = {}
    if (name !== undefined) updates.name = name
    if (pan !== undefined) updates.pan = pan && pan.trim() !== '' ? pan.trim().toUpperCase() : null
    if (email !== undefined) updates.email = email
    if (mobile !== undefined) updates.mobile = mobile
    if (address1 !== undefined) updates.address1 = address1
    if (address2 !== undefined) updates.address2 = address2
    if (address3 !== undefined) updates.address3 = address3
    if (city !== undefined) updates.city = city
    if (state !== undefined) updates.state = state
    if (pin !== undefined) updates.pin = pin
    if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth
    if (father_name !== undefined) updates.father_name = father_name
    if (mother_name !== undefined) updates.mother_name = mother_name
    if (occupation !== undefined) updates.occupation = occupation
    if (annual_income !== undefined) updates.annual_income = annual_income ? Number(annual_income) : null
    if (aadhar_number !== undefined) updates.aadhar_number = aadhar_number

    // Add update timestamp
    updates.updated_at = new Date().toISOString()

    console.log(`[Customer Update] Update fields:`, Object.keys(updates))

    if (Object.keys(updates).length === 1) { // Only updated_at
      console.log(`[Customer Update] No fields to update`)
      return res.status(400).json({ error: 'no_updates', detail: 'No valid fields provided for update' })
    }

    // Perform the update
    console.log(`[Customer Update] Executing update query...`)
    const updateResult = await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      UPDATE customer WITH @updates IN customers
      RETURN NEW
    `, { id: Number(id), updates })

    if (!updateResult || updateResult.length === 0) {
      console.log(`[Customer Update] Update query returned no results`)
      return res.status(500).json({ 
        error: 'update_failed', 
        detail: 'Customer update query did not affect any records' 
      })
    }

    console.log(`[Customer Update] Successfully updated customer ${id}`)
    res.status(204).end()
    
  } catch (error) {
    console.error(`[Customer Update] Error updating customer ${req.params.id}:`, {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errorNum: error.errorNum
    })
    
    // Provide more specific error messages
    let errorMessage = error.message
    let statusCode = 500
    
    if (error.code === 1203) {
      errorMessage = 'Database connection failed'
      statusCode = 503
    } else if (error.code === 400) {
      errorMessage = 'Invalid query syntax'
      statusCode = 500
    } else if (error.message && error.message.includes('not found')) {
      statusCode = 404
    }
    
    res.status(statusCode).json({ 
      error: 'server_error', 
      detail: errorMessage,
      error_code: error.code,
      error_num: error.errorNum,
      customer_id: req.params.id
    })
  }
})

app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id

    // Check if customer exists and get full customer data
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id })
    if (!existing.length) {
      return res.status(404).json({ error: 'not_found' })
    }

    const customer = existing[0]
    
    // Check if user can access this customer (branch-based filtering)
    const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
    if (!canAccess) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied - customer belongs to different branch' })
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

// Customer search endpoint for receipt creation (branch-filtered)
app.get('/api/customers/search', requireAuth, async (req, res) => {
  try {
    const { q: searchQuery, limit = '10' } = req.query
    
    if (!searchQuery || searchQuery.trim().length < 2) {
      return res.status(400).json({ error: 'invalid_query', detail: 'Search query must be at least 2 characters' })
    }

    // Get user's branch for filtering
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    const userRole = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: req.user.sub })

    const isAdmin = userRole.length > 0 && userRole[0] === 'admin'
    const searchLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 10))

    let filterClause = ''
    let bindVars = { searchQuery: `%${searchQuery}%`, limit: searchLimit }

    // Branch-based filtering (unless admin)
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER customer.relationship_manager == @userBranch`
      bindVars.userBranch = normalizedUserBranch
    }

    // Add search filter
    const searchFilter = `
      FILTER customer.name LIKE @searchQuery 
         OR customer.investor_id LIKE @searchQuery 
         OR customer.pan LIKE @searchQuery 
         OR customer.mobile LIKE @searchQuery
    `
    
    if (filterClause) {
      filterClause += ` AND (customer.name LIKE @searchQuery 
         OR customer.investor_id LIKE @searchQuery 
         OR customer.pan LIKE @searchQuery 
         OR customer.mobile LIKE @searchQuery)`
    } else {
      filterClause = searchFilter
    }

    const query = `
      FOR customer IN customers
      ${filterClause}
      LIMIT @limit
      RETURN {
        investor_id: customer.investor_id,
        name: customer.name,
        pan: customer.pan,
        mobile: customer.mobile,
        email: customer.email,
        relationship_manager: customer.relationship_manager
      }
    `

    const customers = await q(query, bindVars)
    
    res.json({
      customers,
      total: customers.length,
      branch_filter: !isAdmin ? normalizedUserBranch : 'all',
      user_role: isAdmin ? 'admin' : 'branch_user'
    })
  } catch (error) {
    console.error('Error searching customers:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

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

/* RECEIPTS: UPDATE STATUS */
app.patch('/api/receipts/:id/status', requireAuth, async (req, res) => {
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

/* CSV EXPORT */
app.get('/api/export/receipts', requireAuth, async (req, res) => {
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

app.get('/api/export/customers', requireAuth, async (req, res) => {
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

app.get('/api/export/users', requireAuth, requireRole('admin'), async (req, res) => {
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

app.get('/api/export/branches', requireAuth, requireRole('admin'), async (req, res) => {
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

/* STATS */
app.get('/api/stats/summary', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  if (from) { 
    filterConditions.push('receipt.date >= @from')
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push('receipt.date <= @to')
    bindVars.to = to
  }
  if (req.user.role === 'employee') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
      filterConditions.push('receipt.emp_code == @emp_code')
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Only include completed receipts in investment calculations
  filterConditions.push('receipt.status == "Completed"')
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
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
    COLLECT category = receipt.product_category 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const byDayQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
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
  
  // Get total customers count - filter by branch for non-admin users
  let customersQuery = ''
  let customersBindVars = {}
  
  if (req.user.role === 'admin') {
    // Admin sees all customers
    customersQuery = `
      FOR customer IN customers
      RETURN LENGTH(1)
    `
  } else {
    // Non-admin users see only their branch customers
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    
    if (normalizedUserBranch) {
      customersQuery = `
        FOR customer IN customers
        FILTER customer.relationship_manager == @userBranch
        RETURN LENGTH(1)
      `
      customersBindVars.userBranch = normalizedUserBranch
    } else {
      customersQuery = `
        FOR customer IN customers
        FILTER customer.relationship_manager == null
        RETURN LENGTH(1)
      `
    }
  }
  
  const customersResult = await q(customersQuery, customersBindVars)
  const totalCustomers = customersResult.length

  res.json({
    total_receipts: Number(totals[0]?.total_receipts || 0),
    total_investments: Number(totalCollections),
    total_customers: totalCustomers,
    commissions_total,
    by_category: byCat,
    by_day: byDay
  })
})

app.get('/api/stats/by-category', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  if (from) { 
    filterConditions.push('receipt.date >= @from')
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push('receipt.date <= @to')
    bindVars.to = to
  }
  if (req.user.role === 'employee') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterConditions.push('receipt.emp_code == @emp_code')
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Only include completed receipts in investment calculations
  filterConditions.push('receipt.status == "Completed"')
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT category = receipt.product_category 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
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
  let filterConditions = []
  
  if (from) { 
    filterConditions.push('receipt.date >= @from')
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push('receipt.date <= @to')
    bindVars.to = to
  }
  if (req.user.role === 'employee') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterConditions.push('receipt.emp_code == @emp_code')
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Only include completed receipts in investment calculations
  filterConditions.push('receipt.status == "Completed"')
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
})

app.get('/api/stats/branches', requireAuth, async (req, res) => {
  try {
    const { from, to, includeDeleted = '0' } = req.query
    
    let dateFilter = ''
    let bindVars = {}
    let filterConditions = []
    
    if (from && to) {
      filterConditions.push('receipt.date >= @from AND receipt.date <= @to')
      bindVars.from = from
      bindVars.to = to
    }
    
    if (includeDeleted !== '1') {
      filterConditions.push('receipt.is_deleted == false')
    }
    // Only include completed receipts in investment calculations
    filterConditions.push('receipt.status == "Completed"')
    
    if (filterConditions.length > 0) {
      dateFilter = `FILTER ${filterConditions.join(' AND ')}\n`
    }
    
    // Get branch performance statistics
    const branchStatsQuery = `
      FOR receipt IN receipts
      ${dateFilter}
      COLLECT branch = receipt.branch 
      AGGREGATE receipt_count = LENGTH(1), total_investments = SUM(receipt.investment_amount || 0)
      SORT total_investments DESC
      RETURN {
        branch,
        total_receipts: receipt_count,
        total_investments,
        commissions: total_investments * 0.01
      }
    `
    
    const branchStats = await q(branchStatsQuery, bindVars)
    
    // Get employee count per branch
    const employeeStatsQuery = `
      FOR user IN users
      FILTER user.is_active == true AND user.branch != null
      COLLECT branch = user.branch WITH COUNT INTO employee_count
      RETURN { branch, employee_count }
    `
    
    const employeeStats = await q(employeeStatsQuery)
    
    // Merge branch and employee statistics
    const mergedStats = branchStats.map(branch => {
      const employeeData = employeeStats.find(emp => emp.branch === branch.branch)
      return {
        ...branch,
        total_employees: employeeData?.employee_count || 0
      }
    })
    
    res.json({
      total_branches: mergedStats.length,
      total_investments: mergedStats.reduce((sum, branch) => sum + branch.total_investments, 0),
      total_receipts: mergedStats.reduce((sum, branch) => sum + branch.total_receipts, 0),
      total_commissions: mergedStats.reduce((sum, branch) => sum + branch.commissions, 0),
      branches: mergedStats
    })
  } catch (error) {
    console.error('Error fetching branch stats:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/* ISSUE REPORTS */
app.post('/api/issues', upload.single('screenshot'), async (req, res) => {
  try {
    const { issue, description } = req.body || {}
    
    if (!issue || !description) {
      return res.status(400).json({ error: 'missing_fields', detail: 'Issue title and description are required' })
    }

    // Handle screenshot upload if provided
    let screenshotFile = null
    if (req.file) {
      screenshotFile = {
        id: Date.now() + Math.random(),
        original_name: req.file.originalname,
        filename: req.file.filename,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        uploaded_at: new Date().toISOString()
      }
    }

    const issueDoc = {
      issue,
      description,
      screenshot: screenshotFile,
      status: 'open',
      created_at: new Date().toISOString(),
      ip_address: req.ip,
      user_agent: req.get('User-Agent')
    }

    const result = await getCollection('issues').save(issueDoc)
    
    res.status(201).json({ 
      id: result._key,
      message: 'Issue reported successfully'
    })
  } catch (error) {
    console.error('Error creating issue report:', error)
    
    // Clean up uploaded file if database insert fails
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path)
      } catch (unlinkError) {
        console.error('Failed to clean up file:', unlinkError)
      }
    }
    
    res.status(500).json({ error: 'server_error', detail: 'Failed to create issue report' })
  }
})

app.get('/api/issues', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      status = 'all'
    } = req.query

    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numLimit = s
    const numOffset = (p - 1) * s

    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'status', 'issue'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }

    if (status !== 'all') {
      filterClause = 'FILTER issue.status == @status'
      bindVars.status = status
    }

    const query = `
      FOR issue IN issues
      ${filterClause}
      SORT issue.${orderBy} ${sortDir}
      LIMIT @offset, @limit
      RETURN issue
    `

    const countQuery = `
      FOR issue IN issues
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.offset

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ 
      page: p, 
      size: s, 
      total, 
      items: rows 
    })
  } catch (error) {
    console.error('Error fetching issues:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

app.patch('/api/issues/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body || {}
    
    if (!status) {
      return res.status(400).json({ error: 'missing_status', detail: 'Status is required' })
    }
    
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', detail: `Status must be one of: ${validStatuses.join(', ')}` })
    }
    
    const result = await q(`
      FOR issue IN issues
      FILTER issue._key == @id
      UPDATE issue WITH { 
        status: @status,
        updated_at: DATE_NOW(),
        updated_by: @user_id
      } IN issues
      RETURN NEW
    `, { id, status, user_id: req.user.sub })
    
    if (!result.length) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    res.json({ 
      message: 'Status updated successfully',
      issue: result[0]
    })
  } catch (error) {
    console.error('Error updating issue status:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
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
