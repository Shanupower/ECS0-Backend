import express from 'express'
import bcrypt from 'bcryptjs'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { validateEmail, validateEmpCode, validatePassword, validateRequired } from '../utils/validators.js'

const router = express.Router()

// Get current user profile
router.get('/me', requireAuth, async (req, res) => {
  const users = await q(`
    FOR user IN users 
    FILTER user._key == @id
    LIMIT 1
    RETURN user
  `, { id: req.user.sub })
  
  if (!users.length) return res.status(404).json({ error: 'not_found' })
  const user = users[0]
  const mustChangePassword = user.password_changed_at == null
  
  res.json({
    id: user._key,
    emp_code: user.emp_code,
    name: user.name,
    email: user.email ?? null,
    mobile: user.mobile ?? null,
    branch: user.branch,
    role: user.role,
    is_active: user.is_active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    must_change_password: !!mustChangePassword
  })
})

// Update current user profile (email, mobile only)
router.patch('/me', requireAuth, async (req, res) => {
  const id = req.user.sub
  const { email, mobile } = req.body || {}
  const updates = {}
  
  if (email !== undefined) {
    const emailValidation = validateEmail(email, false)
    if (!emailValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
    }
    updates.email = emailValidation.value || null
  }
  if (mobile !== undefined) updates.mobile = mobile === '' ? null : String(mobile).trim() || null
  
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_updates' })
  
  try {
    await getCollection('users').update(id, updates)
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

// Get all users (admin only)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const users = await q(`
    FOR user IN users 
    SORT user.created_at DESC
    RETURN {
      id: user._key,
      emp_code: user.emp_code,
      name: user.name,
      email: user.email,
      branch: user.branch,
      branch_code: user.branch_code,
      role: user.role,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
      created_at: user.created_at
    }
  `)
  res.json(users)
})

// Get users that the current user can assign tasks to (admin: all; manager: same branch; employee: self only)
router.get('/assignable', requireAuth, async (req, res) => {
  try {
    const role = req.user.role
    const sub = req.user.sub

    if (role === 'admin') {
      const users = await q(`
        FOR user IN users
        FILTER user.is_active == true
        SORT user.name
        RETURN { id: user._key, emp_code: user.emp_code, name: user.name, branch: user.branch, role: user.role }
      `)
      return res.json(users)
    }

    if (role === 'manager') {
      const me = await q(`
        FOR user IN users
        FILTER user._key == @id
        LIMIT 1
        RETURN user.branch
      `, { id: sub })
      const myBranch = me[0] ? String(me[0]).trim().toUpperCase() : null
      if (!myBranch) return res.json([])
      const users = await q(`
        FOR user IN users
        FILTER user.is_active == true
        FILTER user.branch != null && UPPER(TRIM(user.branch)) == @myBranch
        SORT user.name
        RETURN { id: user._key, emp_code: user.emp_code, name: user.name, branch: user.branch, role: user.role }
      `, { myBranch })
      return res.json(users)
    }

    const self = await q(`
      FOR user IN users
      FILTER user._key == @id && user.is_active == true
      LIMIT 1
      RETURN { id: user._key, emp_code: user.emp_code, name: user.name, branch: user.branch, role: user.role }
    `, { id: sub })
    res.json(self || [])
  } catch (error) {
    console.error('Error listing assignable users:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Create new user (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { emp_code, name, email, branch, role = 'employee', password } = req.body || {}
  
  // Validate required fields
  const nameValidation = validateRequired(name, 'Name')
  if (!nameValidation.valid) {
    return res.status(400).json({ error: 'validation_error', detail: nameValidation.error })
  }

  // Validate employee code
  const empCodeValidation = validateEmpCode(emp_code, true)
  if (!empCodeValidation.valid) {
    return res.status(400).json({ error: 'validation_error', detail: empCodeValidation.error })
  }

  // Validate password strength
  const passwordValidation = validatePassword(password, true)
  if (!passwordValidation.valid) {
    return res.status(400).json({ error: 'validation_error', detail: passwordValidation.error })
  }

  // Validate email if provided
  if (email) {
    const emailValidation = validateEmail(email, false)
    if (!emailValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
    }
  }
  
  const hash = await bcrypt.hash(passwordValidation.value, 10)
  try {
    // If branch is provided, look up branch_code
    let branchCode = null
    if (branch) {
      const branchQuery = await q(`
        FOR b IN branches
        FILTER b.branch_name == @branchName OR b.branch_code == @branchName
        LIMIT 1
        RETURN b
      `, { branchName: branch })
      
      if (branchQuery.length > 0) {
        branchCode = branchQuery[0].branch_code
      }
    }
    
    const userDoc = {
      emp_code: empCodeValidation.value,
      name: nameValidation.value,
      email: email || null,
      branch: branch || null,
      branch_code: branchCode,
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

// Update user (admin only)
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = req.params.id
  const { name, email, branch, role, is_active } = req.body || {}
  const updates = {}
  
  if (name !== undefined) updates.name = name
  if (email !== undefined) updates.email = email
  if (role !== undefined) updates.role = role
  if (is_active !== undefined) updates.is_active = is_active
  
  // If branch is being updated, also update branch_code
  if (branch !== undefined) {
    updates.branch = branch
    
    // Look up branch_code
    if (branch) {
      try {
        const branchQuery = await q(`
          FOR b IN branches
          FILTER b.branch_name == @branchName OR b.branch_code == @branchName
          LIMIT 1
          RETURN b
        `, { branchName: branch })
        
        if (branchQuery.length > 0) {
          updates.branch_code = branchQuery[0].branch_code
        } else {
          updates.branch_code = null
        }
      } catch (err) {
        console.error('Error looking up branch:', err)
        updates.branch_code = null
      }
    } else {
      updates.branch_code = null
    }
  }
  
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_updates' })
  
  try {
    await getCollection('users').update(id, updates)
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

// Update user password
router.patch('/:id/password', requireAuth, async (req, res) => {
  const uid = req.params.id
  if (!(req.user.role === 'admin' || String(req.user.sub) === String(uid))) return res.status(403).json({ error: 'forbidden' })
  
  const { password } = req.body || {}
  
  // Validate password strength
  const passwordValidation = validatePassword(password, true)
  if (!passwordValidation.valid) {
    return res.status(400).json({ error: 'validation_error', detail: passwordValidation.error })
  }
  
  const hash = await bcrypt.hash(passwordValidation.value, 10)
  
  const isSelfChange = String(req.user.sub) === String(uid)
  const updates = {
    password_hash: hash,
    password_changed_at: isSelfChange ? new Date().toISOString() : null
  }
  
  try {
    await getCollection('users').update(uid, updates)
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

// Delete user (admin only) - soft delete
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = req.params.id
  try {
    await getCollection('users').update(id, { is_active: false })
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

export default router
