import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import rateLimit from 'express-rate-limit'
import { q, getCollection, getUserBranch } from '../config/database.js'
import { JWT_SECRET } from '../config/environment.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })

// User login
router.post('/login', async (req, res) => {
  try {
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
    
    const token = jwt.sign({ 
      sub: user._key, 
      role: user.role, 
      emp_code: user.emp_code, 
      name: user.name, 
      branch_code: user.branch_code 
    }, JWT_SECRET, { expiresIn: '8h' })
    
    res.json({ 
      token, 
      user: { 
        id: user._key, 
        emp_code: user.emp_code, 
        role: user.role, 
        name: user.name, 
        branch: user.branch, 
        branch_code: user.branch_code 
      } 
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'internal_server_error', message: error.message })
  }
})

// Branch login endpoint
router.post('/branch-login', authLimiter, async (req, res) => {
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

// Debug endpoint to test authentication
router.get('/debug', requireAuth, async (req, res) => {
  try {
    res.json({
      message: 'Authentication successful',
      user: {
        id: req.user.sub,
        emp_code: req.user.emp_code,
        role: req.user.role,
        name: req.user.name,
        branch_code: req.user.branch_code
      },
      token_info: {
        issued_at: new Date(req.user.iat * 1000).toISOString(),
        expires_at: new Date(req.user.exp * 1000).toISOString(),
        is_expired: Date.now() > req.user.exp * 1000
      }
    })
  } catch (error) {
    console.error('Debug endpoint error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
