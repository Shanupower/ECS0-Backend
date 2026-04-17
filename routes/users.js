import express from 'express'
import bcrypt from 'bcryptjs'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { validateEmail, validateEmpCode, validateMobile, validatePassword, validateRequired } from '../utils/validators.js'

const router = express.Router()

// Allowed dashboard widget IDs for validation (single source of truth)
const ALLOWED_DASHBOARD_WIDGETS = [
  'kpi_cards', 'overdue_tasks', 'by_category', 'daily_timeline', 'branch_performance',
  'target_vs_actual', 'recent_receipts', 'status_breakdown', 'category_donut', 'monthly_cc_si',
  'top_employees', 'leads_snapshot', 'issues_snapshot', 'average_ticket', 'cc_vs_si', 'investor_heatmap'
]

function parseOptionalNonNegativeNumber(value, fieldLabel) {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null || value === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isFinite(n)) return { ok: false, error: `${fieldLabel} must be a number` }
  if (n < 0) return { ok: false, error: `${fieldLabel} cannot be negative` }
  return { ok: true, value: n }
}

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

  // Resolve branch_name for display (user.branch may be id or name; prefer branch_name from branches)
  let branch_name = user.branch
  let branch_code = user.branch_code ?? null
  if (user.branch_code) {
    const branches = await q(`
      FOR b IN branches
      FILTER b.branch_code == @code
      LIMIT 1
      RETURN b.branch_name
    `, { code: user.branch_code })
    if (branches.length) branch_name = branches[0]
  }
  
  res.json({
    id: user._key,
    emp_code: user.emp_code,
    name: user.name,
    email: user.email ?? null,
    mobile: user.mobile ?? null,
    branch: user.branch,
    branch_code,
    branch_name,
    role: user.role,
    is_active: user.is_active,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    must_change_password: !!mustChangePassword,
    dashboard_widgets: Array.isArray(user.dashboard_widgets) ? user.dashboard_widgets : null,
    personal_monthly_target: user.personal_monthly_target != null ? Number(user.personal_monthly_target) : null
  })
})

// Update current user profile (email, mobile, dashboard_widgets)
router.patch('/me', requireAuth, async (req, res) => {
  const id = req.user.sub
  const { email, mobile, dashboard_widgets } = req.body || {}
  const updates = {}
  
  if (email !== undefined) {
    const emailValidation = validateEmail(email, false)
    if (!emailValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
    }
    updates.email = emailValidation.value || null
  }
  if (mobile !== undefined) updates.mobile = mobile === '' ? null : String(mobile).trim() || null
  
  if (dashboard_widgets !== undefined) {
    if (dashboard_widgets === null) {
      updates.dashboard_widgets = null
    } else if (Array.isArray(dashboard_widgets)) {
      const invalid = dashboard_widgets.filter(id => typeof id !== 'string' || !id.trim() || !ALLOWED_DASHBOARD_WIDGETS.includes(id.trim()))
      if (invalid.length > 0) {
        return res.status(400).json({ error: 'validation_error', detail: `Invalid dashboard_widgets: ${invalid.join(', ')}` })
      }
      updates.dashboard_widgets = dashboard_widgets.map(id => id.trim())
    } else {
      return res.status(400).json({ error: 'validation_error', detail: 'dashboard_widgets must be an array or null' })
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
      mobile: user.mobile,
      branch: user.branch,
      branch_code: user.branch_code,
      role: user.role,
      is_active: user.is_active,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
      dashboard_widgets: IS_ARRAY(user.dashboard_widgets) ? user.dashboard_widgets : null,
      personal_monthly_target: user.personal_monthly_target != null ? TO_NUMBER(user.personal_monthly_target) : null
    }
  `)
  res.json(users)
})

// Audit users with missing/invalid branch mapping (admin only)
router.get('/branch-audit', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await q(`
      FOR u IN users
        LET role = u.role
        LET branchRef = u.branch_code != null && TRIM(TO_STRING(u.branch_code)) != "" ? TRIM(TO_STRING(u.branch_code)) : (u.branch != null ? TRIM(TO_STRING(u.branch)) : "")
        LET branchDoc = FIRST(
          FOR b IN branches
            FILTER b._key == branchRef
               OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(branchRef))
               OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(branchRef))
            LIMIT 1
            RETURN { key: b._key, code: b.branch_code, name: b.branch_name }
        )
        LET branchMissing = u.branch == null || TRIM(TO_STRING(u.branch)) == ""
        LET hasBranchButNoCode = !branchMissing && (u.branch_code == null || TRIM(TO_STRING(u.branch_code)) == "")
        LET invalidMapping = branchRef != "" && branchDoc == null
        FILTER branchMissing || hasBranchButNoCode || invalidMapping
        SORT u.emp_code ASC
        RETURN {
          id: u._key,
          emp_code: u.emp_code,
          name: u.name,
          role,
          is_active: u.is_active,
          branch: u.branch,
          branch_code: u.branch_code,
          resolved_branch: branchDoc,
          issues: {
            missing_branch: branchMissing,
            has_branch_but_no_branch_code: hasBranchButNoCode,
            invalid_mapping: invalidMapping
          }
        }
    `)

    const summary = rows.reduce(
      (acc, r) => {
        if (r.issues?.missing_branch) acc.missing_branch++
        if (r.issues?.has_branch_but_no_branch_code) acc.has_branch_but_no_branch_code++
        if (r.issues?.invalid_mapping) acc.invalid_mapping++
        acc.total++
        return acc
      },
      { total: 0, missing_branch: 0, has_branch_but_no_branch_code: 0, invalid_mapping: 0 }
    )

    res.json({ summary, items: rows })
  } catch (e) {
    console.error('Error running branch audit:', e)
    res.status(500).json({ error: 'server_error', detail: e.message })
  }
})

// Attempt to backfill branch_code for users with branch but no branch_code (admin only)
router.post('/branch-audit/fix', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const dryRun = String(req.query.dry_run || '0') === '1'

    const candidates = await q(`
      FOR u IN users
        FILTER u.is_active == true
          AND u.branch != null
          AND TRIM(TO_STRING(u.branch)) != ""
          AND (u.branch_code == null OR TRIM(TO_STRING(u.branch_code)) == "")
        SORT u.emp_code ASC
        RETURN { id: u._key, emp_code: u.emp_code, name: u.name, role: u.role, branch: u.branch }
    `)

    const updated = []
    const unresolved = []

    for (const u of candidates) {
      const branchRef = String(u.branch || '').trim()
      if (!branchRef) {
        unresolved.push({ ...u, reason: 'missing_branch_value' })
        continue
      }

      const branchRows = await q(
        `
        FOR b IN branches
          FILTER b._key == @branchRef
             OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@branchRef))
             OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@branchRef))
          LIMIT 1
          RETURN { branch_code: b.branch_code, branch_name: b.branch_name, key: b._key }
      `,
        { branchRef }
      )

      const resolved = branchRows?.[0]
      if (!resolved?.branch_code) {
        unresolved.push({ ...u, reason: 'branch_not_found', attempted: branchRef })
        continue
      }

      if (!dryRun) {
        await getCollection('users').update(u.id, { branch_code: resolved.branch_code })
      }

      updated.push({
        ...u,
        branch_code: resolved.branch_code,
        resolved_branch: resolved,
        ...(dryRun ? { dry_run: true } : {})
      })
    }

    res.json({
      dry_run: dryRun,
      summary: { candidates: candidates.length, updated: updated.length, unresolved: unresolved.length },
      updated,
      unresolved
    })
  } catch (e) {
    console.error('Error fixing branch codes:', e)
    res.status(500).json({ error: 'server_error', detail: e.message })
  }
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
  const { emp_code, name, email, mobile, branch, role = 'employee', password, personal_monthly_target } = req.body || {}
  
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

  const mobileValidation = validateMobile(mobile, false)
  if (!mobileValidation.valid) {
    return res.status(400).json({ error: 'validation_error', detail: mobileValidation.error })
  }

  const personalTargetParsed = parseOptionalNonNegativeNumber(personal_monthly_target, 'Personal monthly target')
  if (!personalTargetParsed.ok) {
    return res.status(400).json({ error: 'validation_error', detail: personalTargetParsed.error })
  }
  
  const hash = await bcrypt.hash(passwordValidation.value, 10)
  try {
    const roleRequiresBranch = new Set(['employee', 'manager', 'branch'])
    const normalizedRole = String(role || '').trim()
    if (roleRequiresBranch.has(normalizedRole) && (!branch || !String(branch).trim())) {
      return res.status(400).json({ error: 'validation_error', detail: 'Branch is required for this role' })
    }

    // If branch is provided, it must resolve to an existing branch (no silent null branch_code)
    let branchCode = null
    if (branch && String(branch).trim()) {
      const branchQuery = await q(
        `
        FOR b IN branches
          FILTER b._key == @branchRef
             OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@branchRef))
             OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@branchRef))
          LIMIT 1
          RETURN { branch_code: b.branch_code, branch_name: b.branch_name }
      `,
        { branchRef: String(branch).trim() }
      )

      if (!branchQuery.length || !branchQuery[0]?.branch_code) {
        return res.status(400).json({ error: 'validation_error', detail: `Invalid branch: "${String(branch).trim()}"` })
      }
      branchCode = branchQuery[0].branch_code
    }
    
    const userDoc = {
      emp_code: empCodeValidation.value,
      name: nameValidation.value,
      email: email || null,
      mobile: mobileValidation.value,
      branch: branch || null,
      branch_code: branchCode,
      role,
      password_hash: hash,
      personal_monthly_target: personalTargetParsed.value === undefined ? null : personalTargetParsed.value,
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
  const { name, email, mobile, branch, role, is_active, dashboard_widgets, personal_monthly_target } = req.body || {}
  const updates = {}
  
  if (name !== undefined) updates.name = name
  if (email !== undefined) updates.email = email
  if (mobile !== undefined) {
    const mobileValidation = validateMobile(mobile, false)
    if (!mobileValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: mobileValidation.error })
    }
    updates.mobile = mobileValidation.value
  }
  if (role !== undefined) updates.role = role
  if (is_active !== undefined) updates.is_active = is_active
  if (dashboard_widgets !== undefined) {
    if (dashboard_widgets === null) {
      updates.dashboard_widgets = null
    } else if (Array.isArray(dashboard_widgets)) {
      const invalid = dashboard_widgets.filter(w => typeof w !== 'string' || !w.trim() || !ALLOWED_DASHBOARD_WIDGETS.includes(w.trim()))
      if (invalid.length > 0) return res.status(400).json({ error: 'validation_error', detail: `Invalid dashboard_widgets: ${invalid.join(', ')}` })
      updates.dashboard_widgets = dashboard_widgets.map(w => w.trim())
    } else {
      return res.status(400).json({ error: 'validation_error', detail: 'dashboard_widgets must be an array or null' })
    }
  }

  const personalTargetParsed = parseOptionalNonNegativeNumber(personal_monthly_target, 'Personal monthly target')
  if (!personalTargetParsed.ok) {
    return res.status(400).json({ error: 'validation_error', detail: personalTargetParsed.error })
  }
  if (personalTargetParsed.value !== undefined) updates.personal_monthly_target = personalTargetParsed.value
  
  // If branch/role is being updated, enforce role-based branch requirement and resolve branch_code
  const roleRequiresBranch = new Set(['employee', 'manager', 'branch'])
  if (branch !== undefined || role !== undefined) {
    const existingRows = await q(
      `
      FOR u IN users
        FILTER u._key == @id
        LIMIT 1
        RETURN { role: u.role, branch: u.branch }
    `,
      { id }
    )
    if (!existingRows.length) return res.status(404).json({ error: 'not_found' })

    const finalRole = String((role !== undefined ? role : existingRows[0].role) || '').trim()
    const finalBranch = branch !== undefined ? branch : existingRows[0].branch

    if (branch !== undefined) updates.branch = branch

    if (roleRequiresBranch.has(finalRole) && (!finalBranch || !String(finalBranch).trim())) {
      return res.status(400).json({ error: 'validation_error', detail: 'Branch is required for this role' })
    }

    if (finalBranch && String(finalBranch).trim()) {
      try {
        const branchQuery = await q(
          `
          FOR b IN branches
            FILTER b._key == @branchRef
               OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@branchRef))
               OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@branchRef))
            LIMIT 1
            RETURN { branch_code: b.branch_code }
        `,
          { branchRef: String(finalBranch).trim() }
        )
        if (!branchQuery.length || !branchQuery[0]?.branch_code) {
          return res.status(400).json({ error: 'validation_error', detail: `Invalid branch: "${String(finalBranch).trim()}"` })
        }
        updates.branch_code = branchQuery[0].branch_code
      } catch (err) {
        console.error('Error looking up branch:', err)
        return res.status(500).json({ error: 'server_error', detail: 'Failed to resolve branch' })
      }
    } else {
      // Clearing branch
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

// Delete a user's drafts, tasks, and leads (admin only)
// This is a hard delete for related records and is intended for cleanup
router.delete('/:id/related-data', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = req.params.id

  try {
    // Delete receipt drafts created by the user
    await q(`
      FOR d IN receipt_drafts
      FILTER d.created_by == @userId
      REMOVE d IN receipt_drafts
    `, { userId })

    // Delete tasks where the user is the assignee or assigner
    await q(`
      FOR t IN tasks
      FILTER t.assignee_id == @userId
         OR t.assigned_by_id == @userId
      REMOVE t IN tasks
    `, { userId })

    // Delete leads where the user is the assignee
    await q(`
      FOR l IN leads
      FILTER l.assigned_to_id == @userId
      REMOVE l IN leads
    `, { userId })

    res.status(204).end()
  } catch (error) {
    console.error('Error deleting user related data:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to delete user related data' })
  }
})

export default router
