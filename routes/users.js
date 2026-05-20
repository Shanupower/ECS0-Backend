import express from 'express'
import bcrypt from 'bcryptjs'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { validateEmail, validateEmpCode, validateMobile, validatePassword, validateRequired } from '../utils/validators.js'
import {
  normalizeBranchRef,
  resolveBranchAliases,
  getCurrentUserBranchRef
} from '../utils/branch-scope.js'

const router = express.Router()

const AUDIT_COLLECTION = 'branch_audit_events'

async function ensureAuditCollection() {
  const col = getCollection(AUDIT_COLLECTION)
  try {
    const exists = await col.exists()
    if (!exists) await col.create()
  } catch (e) {
    console.error('[Audit] ensureAuditCollection failed:', e?.message || e)
  }
  return col
}

// Allowed dashboard widget IDs for validation (single source of truth)
const LEGACY_KPI_BLOCK = 'kpi_cards'
const KPI_WIDGET_IDS = [
  'total_receipts',
  'total_investments',
  'total_customers',
  'collection_credit_earned',
  'service_income_earned'
]
const ALLOWED_DASHBOARD_WIDGETS = [
  LEGACY_KPI_BLOCK,
  ...KPI_WIDGET_IDS,
  'overdue_tasks',
  'by_category',
  'daily_timeline',
  'branch_performance',
  'target_vs_actual',
  'recent_receipts',
  'status_breakdown',
  'category_donut',
  'monthly_cc_si',
  'top_employees',
  'leads_snapshot',
  'issues_snapshot',
  'average_ticket',
  'cc_vs_si',
  'pending_approvals'
]

const DASHBOARD_LAYOUT_COLS = 15
const REMOVED_DASHBOARD_WIDGETS = new Set(['investor_heatmap'])

function migrateDashboardWidgets(widgets) {
  if (widgets == null) return null
  if (!Array.isArray(widgets)) return widgets
  let out = widgets.map((id) => String(id).trim()).filter(Boolean)
  out = out.filter((id) => !REMOVED_DASHBOARD_WIDGETS.has(id))
  if (!out.includes(LEGACY_KPI_BLOCK)) return out
  out = out.filter((id) => id !== LEGACY_KPI_BLOCK)
  for (const kid of KPI_WIDGET_IDS) {
    if (!out.includes(kid)) out.push(kid)
  }
  return out
}

function validateDashboardLayout(layout) {
  if (layout === null) return { ok: true, value: null }
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) {
    return { ok: false, error: 'dashboard_layout must be an object or null' }
  }
  const lg = layout.lg
  if (!Array.isArray(lg)) {
    return { ok: false, error: 'dashboard_layout.lg must be an array' }
  }
  const seen = new Set()
  const normalized = []
  for (const item of lg) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Each layout item must be an object' }
    }
    const i = typeof item.i === 'string' ? item.i.trim() : ''
    if (!i || REMOVED_DASHBOARD_WIDGETS.has(i)) continue
    if (!ALLOWED_DASHBOARD_WIDGETS.includes(i)) {
      return { ok: false, error: `Invalid layout widget id: ${item.i}` }
    }
    if (seen.has(i)) {
      return { ok: false, error: `Duplicate layout widget id: ${i}` }
    }
    seen.add(i)
    const x = Number(item.x)
    const y = Number(item.y)
    const w = Number(item.w)
    const h = Number(item.h)
    if (![x, y, w, h].every((n) => Number.isInteger(n) && n >= 0)) {
      return { ok: false, error: `Layout item ${i} requires integer x, y, w, h >= 0` }
    }
    if (w < 1 || h < 1) {
      return { ok: false, error: `Layout item ${i} requires w and h >= 1` }
    }
    if (x + w > DASHBOARD_LAYOUT_COLS) {
      return { ok: false, error: `Layout item ${i} exceeds grid width (${DASHBOARD_LAYOUT_COLS} columns)` }
    }
    normalized.push({ i, x, y, w, h })
  }
  const value = { lg: normalized }
  const layoutVersion = Number(layout.layoutVersion)
  if (Number.isInteger(layoutVersion) && layoutVersion >= 1) {
    value.layoutVersion = layoutVersion
  }
  return { ok: true, value }
}

function serializeDashboardLayout(layout) {
  if (layout == null) return null
  if (typeof layout === 'object' && Array.isArray(layout.lg)) {
    const out = {
      lg: layout.lg.map((item) => ({
        i: item.i,
        x: Number(item.x),
        y: Number(item.y),
        w: Number(item.w),
        h: Number(item.h)
      }))
    }
    const layoutVersion = Number(layout.layoutVersion)
    if (Number.isInteger(layoutVersion) && layoutVersion >= 1) {
      out.layoutVersion = layoutVersion
    }
    return out
  }
  return null
}

function parseOptionalNonNegativeNumber(value, fieldLabel) {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null || value === '') return { ok: true, value: null }
  const n = Number(value)
  if (!Number.isFinite(n)) return { ok: false, error: `${fieldLabel} must be a number` }
  if (n < 0) return { ok: false, error: `${fieldLabel} cannot be negative` }
  return { ok: true, value: n }
}

async function getUserBranchRefForUserId(userId) {
  const rows = await q(
    `
    FOR u IN users
      FILTER u._key == @id
      LIMIT 1
      RETURN { branch_code: u.branch_code, branch: u.branch }
  `,
    { id: userId }
  )
  const r = rows?.[0]
  const branch_code = r?.branch_code != null && String(r.branch_code).trim() !== '' ? String(r.branch_code).trim() : null
  const branch = r?.branch != null && String(r.branch).trim() !== '' ? String(r.branch).trim() : null
  return { branch_code, branch }
}

function normalizeBranchRefForCompare(value) {
  return String(value ?? '').trim().toLowerCase()
}

// buildUserListFilter mirrors leads.js::buildListFilter but matches against both
// `user.branch_code` AND `user.branch` (either may hold the canonical id, code,
// or name depending on how the row was created). Returns everything callers need
// to stitch into a `FOR user IN users ${filterAql} ...` query.
//
// Returns { filterAql, bindVars, activeOnly, sort, scope }.
//   - activeOnly: true when we should hide deactivated users (manager + employee).
//   - sort: AQL sort expression (without the SORT keyword).
//   - scope: 'admin-all' | 'admin-branch' | 'manager' | 'employee' — for logging / auditing.
async function buildUserListFilter(req) {
  const role = req.user?.role
  const sub = req.user?.sub

  const BRANCH_MATCH = `FILTER (
    (user.branch_code != null && UPPER(TRIM(TO_STRING(user.branch_code))) IN @bAliases)
    OR (user.branch != null && UPPER(TRIM(TO_STRING(user.branch))) IN @bAliases)
  )`

  if (role === 'admin') {
    const ref = String(req.query.branch_code || '').trim()
    if (!ref) {
      return { filterAql: '', bindVars: {}, activeOnly: false, sort: 'user.created_at DESC', scope: 'admin-all' }
    }
    const aliases = await resolveBranchAliases(ref)
    if (!aliases.length) {
      return { filterAql: 'FILTER false', bindVars: {}, activeOnly: false, sort: 'user.created_at DESC', scope: 'admin-branch' }
    }
    return { filterAql: BRANCH_MATCH, bindVars: { bAliases: aliases }, activeOnly: false, sort: 'user.name ASC', scope: 'admin-branch' }
  }

  if (role === 'manager') {
    const me = await getCurrentUserBranchRef(sub)
    if (!me?.aliases?.length) {
      return { filterAql: 'FILTER false', bindVars: {}, activeOnly: true, sort: 'user.name ASC', scope: 'manager' }
    }
    return { filterAql: BRANCH_MATCH, bindVars: { bAliases: me.aliases }, activeOnly: true, sort: 'user.name ASC', scope: 'manager' }
  }

  // Employees (and any other role) see only themselves. Mirrors leads' employee
  // clause which restricts rows to what the caller already owns.
  return {
    filterAql: 'FILTER user._key == @sub',
    bindVars: { sub: sub || '' },
    activeOnly: false,
    sort: 'user.name ASC',
    scope: 'employee'
  }
}

async function enforcePersonalTargetCapForBranch({ branchRef, excludeUserId, nextPersonalTarget }) {
  // If no personal target is being set (null), nothing to cap.
  if (nextPersonalTarget == null) return { ok: true }
  if (!branchRef) return { ok: false, error: 'Branch is required to set a personal target' }

  const branchRows = await q(
    `
    FOR b IN branches
      FILTER b._key == @branchRef
         OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@branchRef))
         OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@branchRef))
      LIMIT 1
      RETURN { monthly_target: b.monthly_target, branch_name: b.branch_name, branch_code: b.branch_code, key: b._key }
  `,
    { branchRef: String(branchRef).trim() }
  )
  const branchDoc = branchRows?.[0]
  const monthlyTarget = branchDoc?.monthly_target != null && branchDoc?.monthly_target !== '' ? Number(branchDoc.monthly_target) : null
  if (monthlyTarget == null || !Number.isFinite(monthlyTarget) || monthlyTarget <= 0) {
    return { ok: false, error: 'Branch monthly target must be set before setting personal targets' }
  }

  const identifiers = [
    branchDoc?.key,
    branchDoc?.branch_code,
    branchDoc?.branch_name
  ].filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim())

  const sumRows = await q(
    `
    FOR u IN users
      FILTER u.is_active == true
        AND u.personal_monthly_target != null
        AND u.personal_monthly_target != ""
        AND (@excludeId == null OR u._key != @excludeId)
        AND (
          (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
          OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
        )
      COLLECT AGGREGATE total = SUM(TO_NUMBER(u.personal_monthly_target))
      RETURN total
  `,
    { ids: identifiers, excludeId: excludeUserId ?? null }
  )
  const existingSum = sumRows?.length ? Number(sumRows[0]) : 0
  const nextSum = existingSum + Number(nextPersonalTarget)
  if (nextSum > monthlyTarget) {
    return {
      ok: false,
      error: `Sum of personal targets (${nextSum}) exceeds branch monthly target (${monthlyTarget})`
    }
  }
  return { ok: true }
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
    dashboard_widgets: migrateDashboardWidgets(
      Array.isArray(user.dashboard_widgets) ? user.dashboard_widgets : null
    ),
    dashboard_layout: serializeDashboardLayout(user.dashboard_layout),
    personal_monthly_target: user.personal_monthly_target != null ? Number(user.personal_monthly_target) : null
  })
})

// Update current user profile (email, mobile, dashboard_widgets, dashboard_layout)
router.patch('/me', requireAuth, async (req, res) => {
  const id = req.user.sub
  const { email, mobile, dashboard_widgets, dashboard_layout } = req.body || {}
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
      updates.dashboard_widgets = migrateDashboardWidgets(dashboard_widgets.map(id => id.trim()))
    } else {
      return res.status(400).json({ error: 'validation_error', detail: 'dashboard_widgets must be an array or null' })
    }
  }

  if (dashboard_layout !== undefined) {
    const layoutCheck = validateDashboardLayout(dashboard_layout)
    if (!layoutCheck.ok) {
      return res.status(400).json({ error: 'validation_error', detail: layoutCheck.error })
    }
    updates.dashboard_layout = layoutCheck.value
  }
  
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_updates' })
  
  try {
    await getCollection('users').update(id, updates)
    res.status(204).end()
  } catch (e) {
    res.status(404).json({ error: 'not_found' })
  }
})

// Get users (branch-scoped, leads-style)
// - Admin: all users by default; pass ?branch_code=<key|code|name> to narrow.
// - Manager: auto-scoped to their own branch (no scope= param required).
// - Everyone else: sees themselves only.
//
// The legacy `?scope=branch` query param is still honored as a no-op for
// backward compatibility with callers that set it.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { filterAql, bindVars, activeOnly, sort } = await buildUserListFilter(req)

    const activeFilter = activeOnly ? 'FILTER user.is_active == true' : ''
    const users = await q(
      `
      FOR user IN users
        ${activeFilter}
        ${filterAql}
        SORT ${sort}
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
      `,
      bindVars
    )
    res.json(users)
  } catch (err) {
    console.error('Error listing users:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
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

// Get users that the current user can assign tasks to.
// - Admin: all active users; accepts ?branch_code=<ref> to narrow to a branch.
// - Manager: active users in their own branch (alias-matched).
// - Employee (or any other role): themselves only.
//
// Uses the same branch scope helper as GET /, so the two endpoints never drift.
router.get('/assignable', requireAuth, async (req, res) => {
  try {
    const { filterAql, bindVars } = await buildUserListFilter(req)

    const users = await q(
      `
      FOR user IN users
        FILTER user.is_active == true
        ${filterAql}
        SORT user.name
        RETURN { id: user._key, emp_code: user.emp_code, name: user.name, branch: user.branch, role: user.role }
      `,
      bindVars
    )
    res.json(users)
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

    const cap = await enforcePersonalTargetCapForBranch({
      branchRef: branchCode || branch,
      excludeUserId: null,
      nextPersonalTarget: personalTargetParsed.value === undefined ? null : personalTargetParsed.value
    })
    if (!cap.ok) {
      return res.status(400).json({ error: 'validation_error', detail: cap.error })
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

// Update user
// - Admin: full update (existing behavior)\n+// - Manager: can update personal_monthly_target for active users in their own branch only
router.patch('/:id', requireAuth, async (req, res) => {
  const id = req.params.id
  const { name, email, mobile, branch, role, is_active, dashboard_widgets, dashboard_layout, personal_monthly_target } = req.body || {}
  const callerRole = req.user?.role

  if (!(callerRole === 'admin' || callerRole === 'manager')) {
    return res.status(403).json({ error: 'forbidden' })
  }

  if (callerRole === 'manager') {
    // Managers are restricted: only allow updating personal_monthly_target.
    const allowedKeys = new Set(['personal_monthly_target'])
    const bodyKeys = Object.keys(req.body || {})
    const invalidKeys = bodyKeys.filter((k) => !allowedKeys.has(k))
    if (invalidKeys.length > 0) {
      return res.status(403).json({ error: 'forbidden', detail: 'Managers can only update personal monthly target' })
    }
  }

  const updates = {}
  
  if (callerRole === 'admin') {
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
        updates.dashboard_widgets = migrateDashboardWidgets(dashboard_widgets.map(w => w.trim()))
      } else {
        return res.status(400).json({ error: 'validation_error', detail: 'dashboard_widgets must be an array or null' })
      }
    }
    if (dashboard_layout !== undefined) {
      const layoutCheck = validateDashboardLayout(dashboard_layout)
      if (!layoutCheck.ok) return res.status(400).json({ error: 'validation_error', detail: layoutCheck.error })
      updates.dashboard_layout = layoutCheck.value
    }
  }

  const personalTargetParsed = parseOptionalNonNegativeNumber(personal_monthly_target, 'Personal monthly target')
  if (!personalTargetParsed.ok) {
    return res.status(400).json({ error: 'validation_error', detail: personalTargetParsed.error })
  }
  if (personalTargetParsed.value !== undefined) updates.personal_monthly_target = personalTargetParsed.value
  
  // If branch/role is being updated, enforce role-based branch requirement and resolve branch_code
  const roleRequiresBranch = new Set(['employee', 'manager', 'branch'])
  if (callerRole === 'admin' && (branch !== undefined || role !== undefined)) {
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
    let auditContext = null
    // Manager: ensure the target user is active and in manager's branch.
    // Uses the shared alias resolver so a manager whose row has `branch_name`
    // can still update a teammate whose row has only `branch_code` (or vice
    // versa) — matching the leads scoping contract.
    if (callerRole === 'manager') {
      const [me, targetRows] = await Promise.all([
        getCurrentUserBranchRef(req.user.sub),
        q(
          `
          FOR u IN users
            FILTER u._key == @id
            LIMIT 1
            RETURN { is_active: u.is_active, branch_code: u.branch_code, branch: u.branch, emp_code: u.emp_code, personal_monthly_target: u.personal_monthly_target }
        `,
          { id }
        )
      ])
      if (!targetRows.length) return res.status(404).json({ error: 'not_found' })
      const target = targetRows[0]
      if (target?.is_active !== true) return res.status(403).json({ error: 'forbidden', detail: 'Target user is inactive' })

      const myAliases = me?.aliases || []
      const targetRef = (target.branch_code != null && String(target.branch_code).trim() !== '')
        ? String(target.branch_code).trim()
        : (target.branch != null ? String(target.branch).trim() : '')
      const targetAliases = targetRef ? await resolveBranchAliases(targetRef) : []

      const sameBranch = myAliases.length > 0 && targetAliases.some((a) => myAliases.includes(a))
      if (!sameBranch) {
        return res.status(403).json({ error: 'forbidden', detail: 'Managers can only update users in their branch' })
      }

      const myBranchRef = me?.branch_code || me?.branch
      const cap = await enforcePersonalTargetCapForBranch({
        branchRef: myBranchRef,
        excludeUserId: id,
        nextPersonalTarget: updates.personal_monthly_target
      })
      if (!cap.ok) {
        return res.status(400).json({ error: 'validation_error', detail: cap.error })
      }

      if (updates.personal_monthly_target !== undefined) {
        auditContext = {
          branch_code: String(myBranchRef),
          target_user_id: String(id),
          target_emp_code: target?.emp_code != null ? String(target.emp_code) : null,
          old_target: target?.personal_monthly_target != null && target.personal_monthly_target !== '' ? Number(target.personal_monthly_target) : null,
          new_target: updates.personal_monthly_target === '' ? null : updates.personal_monthly_target
        }
      }
    }

    // Admin: cap check if personal target is being set and the target user has a branch.
    if (callerRole === 'admin' && updates.personal_monthly_target !== undefined) {
      const targetRows = await q(
        `
        FOR u IN users
          FILTER u._key == @id
          LIMIT 1
          RETURN { branch_code: u.branch_code, branch: u.branch }
      `,
        { id }
      )
      if (!targetRows.length) return res.status(404).json({ error: 'not_found' })
      const target = targetRows[0]
      const targetBranchRef = (target.branch_code != null && String(target.branch_code).trim() !== '')
        ? String(target.branch_code).trim()
        : (target.branch != null ? String(target.branch).trim() : null)

      const cap = await enforcePersonalTargetCapForBranch({
        branchRef: targetBranchRef,
        excludeUserId: id,
        nextPersonalTarget: updates.personal_monthly_target
      })
      if (!cap.ok) {
        return res.status(400).json({ error: 'validation_error', detail: cap.error })
      }
    }

    await getCollection('users').update(id, updates)

    // Manager audit event (best-effort; do not fail update if logging fails)
    if (callerRole === 'manager' && auditContext) {
      try {
        const col = await ensureAuditCollection()
        await col.save({
          type: 'user_personal_target_updated',
          created_at: new Date().toISOString(),
          branch_code: auditContext.branch_code,
          actor_id: String(req.user.sub),
          actor_emp_code: req.user.emp_code != null ? String(req.user.emp_code) : null,
          target_user_id: auditContext.target_user_id,
          target_emp_code: auditContext.target_emp_code,
          old_target: auditContext.old_target,
          new_target: auditContext.new_target,
          summary: `${req.user.emp_code || req.user.sub} updated personal target for ${auditContext.target_emp_code || auditContext.target_user_id}: ${auditContext.old_target ?? '—'} → ${auditContext.new_target ?? '—'}`
        })
      } catch (e) {
        console.error('[Audit] save failed:', e?.message || e)
      }
    }

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
