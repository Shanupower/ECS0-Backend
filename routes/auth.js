import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { q } from '../config/database.js'
import { JWT_SECRET } from '../config/environment.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { recordLoginEvent } from '../services/login-events.js'

const router = express.Router()

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
    
    const mustChangePassword = user.password_changed_at == null
    
    await q(`
      UPDATE @id WITH { last_login_at: DATE_NOW() } IN users
    `, { id: user._key })

    await recordLoginEvent({ user, req, loginType: 'password' })

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
        branch_code: user.branch_code,
        must_change_password: !!mustChangePassword
      } 
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'internal_server_error', message: error.message })
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

// Admin impersonation: login as another user without their password
router.post('/impersonate', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { emp_code } = req.body || {}
    if (!emp_code) {
      return res.status(400).json({ error: 'validation_error', detail: 'emp_code is required' })
    }

    const users = await q(`
      FOR user IN users
      FILTER user.emp_code == @emp_code AND user.is_active == true
      LIMIT 1
      RETURN user
    `, { emp_code })

    if (!users.length) {
      return res.status(404).json({ error: 'user_not_found', detail: 'No active user found with that employee code' })
    }

    const target = users[0]

    await recordLoginEvent({
      user: target,
      req,
      loginType: 'impersonation',
      impersonatedBy: req.user.sub
    })

    const token = jwt.sign({
      sub: target._key,
      role: target.role,
      emp_code: target.emp_code,
      name: target.name,
      branch_code: target.branch_code,
      impersonated_by: req.user.sub
    }, JWT_SECRET, { expiresIn: '4h' })

    res.json({
      token,
      user: {
        id: target._key,
        emp_code: target.emp_code,
        role: target.role,
        name: target.name,
        branch: target.branch,
        branch_code: target.branch_code
      }
    })
  } catch (error) {
    console.error('Impersonation error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
