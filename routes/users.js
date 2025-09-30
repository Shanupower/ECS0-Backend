import express from 'express'
import bcrypt from 'bcryptjs'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

// Get current user profile
router.get('/me', requireAuth, async (req, res) => {
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
      role: user.role,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
      created_at: user.created_at
    }
  `)
  res.json(users)
})

// Create new user (admin only)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
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

// Update user (admin only)
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
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

// Update user password
router.patch('/:id/password', requireAuth, async (req, res) => {
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
