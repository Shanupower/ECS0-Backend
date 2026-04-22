// Tasks API (world-class redesign — Phase 0).
//
// Responsibilities:
//   - CRUD on `tasks` with the extended field set
//   - Rich search, my-tasks, overdue, tasks-by-entity shortcut
//   - Bulk update, subtasks, watchers, attachments, comments, activities
//   - Append-only audit trail in `task_activities`
//
// Permissions model:
//   - admin        — see + edit everything
//   - manager      — see/edit tasks in their branch
//   - assigner     — can edit the task they created
//   - assignee     — can update status / add comments / log activity
//   - employee     — only sees own tasks

import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { ensureTaskSetup } from '../config/tasks-collections.js'
import { getAppConfig } from './app-config.js'
import { publishEvent } from '../services/task-events.js'

const router = express.Router()

// ------------------------------------------------------------------
// Setup / helpers
// ------------------------------------------------------------------

let __taskSetupPromise = null
/** Ensure collections+indexes exist. Lazily memoised so the first request does the work. */
async function ensureReady() {
  if (!__taskSetupPromise) {
    __taskSetupPromise = ensureTaskSetup().catch((err) => {
      console.error('[tasks] ensureTaskSetup failed:', err)
      __taskSetupPromise = null // allow retry on next request
      throw err
    })
  }
  return __taskSetupPromise
}

const DEFAULT_STATUS_KEYS  = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled']
const DEFAULT_PRIORITY_KEYS = ['p0', 'p1', 'p2', 'p3']
const COMPLETED_STATUSES = new Set(['done', 'cancelled'])

// Legacy -> new mapping so existing UI payloads keep working.
const LEGACY_STATUS = { pending: 'todo' }
const LEGACY_PRIORITY = { low: 'p3', medium: 'p2', high: 'p1' }

function now() { return new Date().toISOString() }
function today() { return now().slice(0, 10) }

function normalizeBranch(b) {
  if (!b) return null
  return String(b).trim().toUpperCase()
}

function coerceStatus(s, configKeys) {
  if (!s) return null
  const v = LEGACY_STATUS[s] || s
  return configKeys.includes(v) ? v : null
}
function coercePriority(p, configKeys) {
  if (!p) return null
  const v = LEGACY_PRIORITY[p] || p
  return configKeys.includes(v) ? v : null
}

function configStatusKeys(cfg) {
  return (cfg?.task_statuses || []).map(s => s.key).filter(Boolean).concat(DEFAULT_STATUS_KEYS.filter(k => !(cfg?.task_statuses || []).some(s => s.key === k)))
}
function configPriorityKeys(cfg) {
  const keys = (cfg?.task_priorities || []).map(s => s.key).filter(Boolean)
  return keys.length ? keys : DEFAULT_PRIORITY_KEYS
}

async function getCurrentUserBranch(userId) {
  const rows = await q(`
    FOR u IN users FILTER u._key == @id LIMIT 1
    RETURN { branch: u.branch, emp_code: u.emp_code, role: u.role, name: u.name }
  `, { id: userId })
  return rows[0] || null
}

/** Resolve an assignee by _key or emp_code. Enforces role+branch permission. */
async function resolveAssignee(aid, currentUser) {
  if (!aid) return null
  const rows = await q(`
    FOR u IN users
      FILTER u._key == @aid OR u.emp_code == @aid
      FILTER u.is_active == true
      LIMIT 1
      RETURN u
  `, { aid: String(aid).trim() })
  if (!rows.length) return null
  const u = rows[0]
  if (currentUser.role === 'admin') return u
  if (currentUser.role === 'manager') {
    const me = await getCurrentUserBranch(currentUser.sub)
    if (!me?.branch) return null
    if (normalizeBranch(u.branch) !== normalizeBranch(me.branch)) return null
    return u
  }
  if (['employee', 'branch'].includes(currentUser.role)) {
    if (u._key !== currentUser.sub && u.emp_code !== currentUser.emp_code) return null
    return u
  }
  return u
}

/** Build the scope filter applied to EVERY task query. */
async function buildScope(req) {
  const { role, sub, emp_code } = req.user
  if (role === 'admin') return { filterAql: '', bindVars: {} }
  if (role === 'manager') {
    const me = await getCurrentUserBranch(sub)
    if (!me?.branch) return { filterAql: 'FILTER false', bindVars: {} }
    return {
      filterAql: 'FILTER task.branch != null && UPPER(TRIM(task.branch)) == @__branchNorm',
      bindVars: { __branchNorm: normalizeBranch(me.branch) }
    }
  }
  // employee/branch: own (assignee) or created (assigner) or watching
  return {
    filterAql: 'FILTER task.assignee_id == @__sub OR task.assignee_emp_code == @__emp OR task.assigned_by_id == @__sub OR @__sub IN (task.watchers OR [])',
    bindVars: { __sub: sub, __emp: emp_code || '' }
  }
}

async function ensureCanAccess(id, req, { write = false } = {}) {
  const tasks = await q('FOR t IN tasks FILTER t._key == @id LIMIT 1 RETURN t', { id })
  if (!tasks.length) return { ok: false, code: 404, detail: 'Task not found' }
  const scope = await buildScope(req)
  const rows = await q(`
    FOR t IN tasks FILTER t._key == @id ${scope.filterAql}
    LIMIT 1 RETURN true
  `, { id, ...scope.bindVars })
  if (!rows.length) return { ok: false, code: 403, detail: 'Access denied', task: tasks[0] }
  if (write) {
    const task = tasks[0]
    const isAssignee = task.assignee_id === req.user.sub || task.assignee_emp_code === req.user.emp_code
    const isAssigner = task.assigned_by_id === req.user.sub
    const isAdminMgr = req.user.role === 'admin' || req.user.role === 'manager'
    if (!(isAssignee || isAssigner || isAdminMgr)) {
      return { ok: false, code: 403, detail: 'Write access denied', task }
    }
  }
  return { ok: true, task: tasks[0] }
}

// ------------------------------------------------------------------
// Activity log helpers
// ------------------------------------------------------------------

const TRACKED_FIELDS = [
  'title', 'description', 'status', 'priority', 'due_date', 'start_date', 'scheduled_date',
  'assignee_id', 'assignee_emp_code', 'labels', 'estimate_minutes', 'parent_task_id',
  'customer_id', 'lead_id', 'receipt_id', 'loan_id', 'checklist', 'watchers',
  'recurrence_rule', 'archived_at', 'sla_tier'
]

async function writeActivity(taskKey, actor, kind, payload = {}) {
  try {
    const col = getCollection('task_activities')
    await col.save({
      task_key: taskKey,
      kind,
      payload,
      actor_id: actor?.sub || null,
      actor_emp_code: actor?.emp_code || null,
      actor_name: actor?.name || null,
      created_at: now()
    })
  } catch (err) {
    // Never fail the parent request because of an activity log write.
    console.warn('[tasks] writeActivity failed:', err.message)
  }
}

function diffFields(prev, next) {
  const changes = {}
  for (const f of TRACKED_FIELDS) {
    const a = prev?.[f]
    const b = next?.[f]
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[f] = { from: a ?? null, to: b ?? null }
  }
  return changes
}

// ------------------------------------------------------------------
// Create
// ------------------------------------------------------------------

const TASK_INPUT_WHITELIST = [
  'title', 'description', 'status', 'priority', 'labels',
  'assignee_id', 'due_date', 'start_date', 'scheduled_date',
  'estimate_minutes', 'parent_task_id', 'checklist', 'watchers',
  'customer_id', 'lead_id', 'receipt_id', 'loan_id', 'related_entities',
  'recurrence_rule', 'recurrence_series_id', 'sla_tier', 'custom_fields',
  'source', 'source_rule_id'
]

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k]
  return out
}

/** Core task-creation logic, shared by POST / and POST /:id/subtasks. */
async function createTaskInner(body, currentUser) {
  const cfg = await getAppConfig()
  const statusKeys = configStatusKeys(cfg)
  const priorityKeys = configPriorityKeys(cfg)
  const input = pick(body || {}, TASK_INPUT_WHITELIST)
  if (!input.title || typeof input.title !== 'string' || !input.title.trim()) {
    return { error: 'validation_error', detail: 'title is required', status: 400 }
  }
  const assignee = await resolveAssignee(input.assignee_id || currentUser.sub, currentUser)
  if (!assignee) return { error: 'validation_error', detail: 'Invalid or unauthorized assignee', status: 400 }
  const status = coerceStatus(input.status, statusKeys) || 'todo'
  const priority = coercePriority(input.priority, priorityKeys) || 'p2'
  const me = await getCurrentUserBranch(currentUser.sub)
  const taskDoc = {
    title: input.title.trim(),
    description: input.description ? String(input.description).trim() : null,
    status,
    priority,
    labels: Array.isArray(input.labels) ? input.labels.filter(Boolean) : [],
    assignee_id: assignee._key,
    assignee_emp_code: assignee.emp_code || null,
    assigned_by_id: currentUser.sub,
    assigned_by_emp_code: currentUser.emp_code || null,
    branch: (assignee.branch || me?.branch || null),
    start_date: input.start_date || null,
    due_date: input.due_date || null,
    scheduled_date: input.scheduled_date || null,
    completed_at: COMPLETED_STATUSES.has(status) ? now() : null,
    parent_task_id: input.parent_task_id || null,
    estimate_minutes: Number.isFinite(Number(input.estimate_minutes)) ? Number(input.estimate_minutes) : null,
    checklist: Array.isArray(input.checklist) ? input.checklist : [],
    watchers: Array.isArray(input.watchers) ? input.watchers : [],
    customer_id: input.customer_id || null,
    lead_id: input.lead_id || null,
    receipt_id: input.receipt_id || null,
    loan_id: input.loan_id || null,
    related_entities: Array.isArray(input.related_entities) ? input.related_entities : [],
    recurrence_rule: input.recurrence_rule || null,
    recurrence_series_id: input.recurrence_series_id || null,
    sla_tier: input.sla_tier || null,
    sla_breached_at: null,
    custom_fields: input.custom_fields && typeof input.custom_fields === 'object' ? input.custom_fields : {},
    source: input.source || 'manual',
    source_rule_id: input.source_rule_id || null,
    archived_at: null,
    created_at: now(),
    updated_at: now()
  }
  const col = getCollection('tasks')
  const result = await col.save(taskDoc)
  const saved = { id: result._key, _key: result._key, ...taskDoc }
  writeActivity(result._key, { ...currentUser, name: me?.name }, 'created', { title: saved.title, status, priority })
  publishEvent({
    type: 'task.created',
    payload: {
      task_id: result._key,
      title: saved.title,
      status,
      priority,
      assignee_id: saved.assignee_id,
      branch: saved.branch,
      sla_tier: saved.sla_tier,
      source: saved.source,
      source_rule_id: saved.source_rule_id,
      customer_id: saved.customer_id,
      lead_id: saved.lead_id,
      receipt_id: saved.receipt_id,
      loan_id: saved.loan_id
    },
    actor: { id: currentUser.sub, emp_code: currentUser.emp_code },
    branch: saved.branch
  })
  return { task: saved }
}

router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const out = await createTaskInner(req.body, req.user)
    if (out.error) return res.status(out.status || 400).json({ error: out.error, detail: out.detail })
    res.status(201).json(out.task)
  } catch (error) {
    console.error('Error creating task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// List + rich search
// ------------------------------------------------------------------

function buildListFilters(params, statusKeys, priorityKeys) {
  const parts = []
  const bind = {}

  if (params.archived === '1' || params.archived === 'true') {
    parts.push('FILTER task.archived_at != null')
  } else if (params.archived !== 'all') {
    parts.push('FILTER task.archived_at == null')
  }

  if (params.status) {
    const list = String(params.status).split(',').map(s => coerceStatus(s.trim(), statusKeys)).filter(Boolean)
    if (list.length) {
      bind.statusList = list
      parts.push('FILTER task.status IN @statusList')
    }
  }

  if (params.priority) {
    const list = String(params.priority).split(',').map(s => coercePriority(s.trim(), priorityKeys)).filter(Boolean)
    if (list.length) {
      bind.priorityList = list
      parts.push('FILTER task.priority IN @priorityList')
    }
  }

  if (params.label) {
    const list = String(params.label).split(',').map(s => s.trim()).filter(Boolean)
    if (list.length) {
      bind.labelList = list
      parts.push('FILTER LENGTH(INTERSECTION(task.labels OR [], @labelList)) > 0')
    }
  }

  if (params.assignee_id) {
    const val = String(params.assignee_id).trim()
    if (val === '__none' || val === 'unassigned') {
      parts.push('FILTER task.assignee_id == null OR task.assignee_id == ""')
    } else {
      bind.assigneeFilter = val
      parts.push('FILTER task.assignee_id == @assigneeFilter OR task.assignee_emp_code == @assigneeFilter')
    }
  }

  if (params.branch) {
    bind.branchFilter = normalizeBranch(params.branch)
    parts.push('FILTER task.branch != null && UPPER(TRIM(task.branch)) == @branchFilter')
  }

  if (params.customer_id) { bind.customerId = params.customer_id; parts.push('FILTER task.customer_id == @customerId') }
  if (params.lead_id)     { bind.leadId = params.lead_id;     parts.push('FILTER task.lead_id == @leadId') }
  if (params.receipt_id)  { bind.receiptId = params.receipt_id; parts.push('FILTER task.receipt_id == @receiptId') }

  if (params.due_from) { bind.due_from = params.due_from; parts.push('FILTER task.due_date >= @due_from') }
  if (params.due_to)   { bind.due_to   = params.due_to;   parts.push('FILTER task.due_date <= @due_to') }

  const t = today()
  if (params.overdue === '1' || params.overdue === 'true') {
    bind.__today = t
    parts.push('FILTER task.due_date != null && task.due_date < @__today && task.status != "done" && task.status != "cancelled"')
  }
  if (params.due === 'today') {
    bind.__today = t
    parts.push('FILTER task.due_date == @__today')
  } else if (params.due === 'upcoming') {
    bind.__today = t
    parts.push('FILTER task.due_date != null && task.due_date > @__today')
  } else if (params.due === 'overdue') {
    bind.__today = t
    parts.push('FILTER task.due_date != null && task.due_date < @__today && task.status != "done" && task.status != "cancelled"')
  } else if (params.due === 'this_week') {
    bind.__today = t
    const end = new Date(); end.setDate(end.getDate() + 7)
    bind.__weekEnd = end.toISOString().slice(0, 10)
    parts.push('FILTER task.due_date != null && task.due_date >= @__today && task.due_date <= @__weekEnd')
  }

  if (params.parent_task_id !== undefined) {
    if (params.parent_task_id === 'null' || params.parent_task_id === '') {
      parts.push('FILTER task.parent_task_id == null')
    } else {
      bind.parentId = params.parent_task_id
      parts.push('FILTER task.parent_task_id == @parentId')
    }
  }

  if (params.sla_breached === '1' || params.sla_breached === 'true') {
    parts.push('FILTER task.sla_breached_at != null')
  }

  if (params.q || params.search) {
    const term = String(params.q || params.search || '').trim()
    if (term) {
      bind.qTerm = `%${term.toLowerCase()}%`
      parts.push('FILTER LIKE(LOWER(task.title || ""), @qTerm) OR LIKE(LOWER(task.description || ""), @qTerm)')
    }
  }

  return { filterAql: parts.join(' '), bindVars: bind }
}

function buildSort(params) {
  const sort = String(params.sort || '').toLowerCase()
  switch (sort) {
    case 'priority':
      return 'SORT task.priority ASC, (task.due_date == null ? 1 : 0), task.due_date ASC'
    case 'created':
      return 'SORT task.created_at DESC'
    case 'updated':
      return 'SORT task.updated_at DESC'
    case 'title':
      return 'SORT LOWER(task.title) ASC'
    default: // due
      return 'SORT (task.due_date == null ? 1 : 0), task.due_date ASC, task.priority ASC, task.created_at DESC'
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const cfg = await getAppConfig()
    const statusKeys = configStatusKeys(cfg)
    const priorityKeys = configPriorityKeys(cfg)

    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit ?? '100', 10) || 100))
    const page = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1)
    const skip = (page - 1) * limit

    const scope = await buildScope(req)
    const filt = buildListFilters(req.query, statusKeys, priorityKeys)
    const filterAql = [scope.filterAql, filt.filterAql].filter(Boolean).join(' ')
    const bindVars = { ...scope.bindVars, ...filt.bindVars }
    const sortAql = buildSort(req.query)

    const items = await q(`
      FOR task IN tasks
      ${filterAql}
      ${sortAql}
      LIMIT ${skip}, ${limit}
      RETURN task
    `, bindVars)

    const countRows = await q(`
      FOR task IN tasks
      ${filterAql}
      COLLECT WITH COUNT INTO c
      RETURN c
    `, bindVars)
    const total = countRows[0] ?? 0

    res.json({ items, total, page, size: limit })
  } catch (error) {
    console.error('Error listing tasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Aggregated stats for the TasksPage stats strip.
// ------------------------------------------------------------------

router.get('/stats', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const scope = await buildScope(req)
    const t = today()
    // Week start = last Monday in ISO.
    const d = new Date()
    const dow = (d.getUTCDay() + 6) % 7 // Mon=0..Sun=6
    const weekStart = new Date(d.getTime() - dow * 86400000).toISOString().slice(0, 10)

    const rows = await q(`
      LET base = (
        FOR task IN tasks
        ${scope.filterAql}
        FILTER task.archived_at == null
        RETURN task
      )
      RETURN {
        total: LENGTH(base),
        open: LENGTH(FOR t IN base FILTER t.status != "done" && t.status != "cancelled" RETURN 1),
        due_today: LENGTH(FOR t IN base FILTER t.due_date == @today && t.status != "done" && t.status != "cancelled" RETURN 1),
        overdue: LENGTH(FOR t IN base FILTER t.due_date != null && t.due_date < @today && t.status != "done" && t.status != "cancelled" RETURN 1),
        unassigned: LENGTH(FOR t IN base FILTER t.assignee_id == null OR t.assignee_id == "" RETURN 1),
        done_this_week: LENGTH(FOR t IN base FILTER t.status == "done" && t.completed_at != null && DATE_FORMAT(t.completed_at, "%yyyy-%mm-%dd") >= @weekStart RETURN 1),
        sla_breached: LENGTH(FOR t IN base FILTER t.sla_breached_at != null && t.status != "done" && t.status != "cancelled" RETURN 1),
        by_status: MERGE(
          FOR t IN base COLLECT s = t.status WITH COUNT INTO c RETURN { [s]: c }
        ),
        by_priority: MERGE(
          FOR t IN base COLLECT p = t.priority WITH COUNT INTO c RETURN { [p]: c }
        )
      }
    `, { ...scope.bindVars, today: t, weekStart })

    res.json(rows[0] || { total: 0, open: 0, due_today: 0, overdue: 0, unassigned: 0, done_this_week: 0, sla_breached: 0, by_status: {}, by_priority: {} })
  } catch (error) {
    console.error('Error getting task stats:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Shortcuts: /my, /search, /entity/:type/:id, /:id
// ------------------------------------------------------------------

router.get('/my', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const scope = await buildScope(req)
    const filter = `FILTER (task.assignee_id == @__meSub OR task.assignee_emp_code == @__meEmp) AND task.archived_at == null`
    const items = await q(`
      FOR task IN tasks ${scope.filterAql} ${filter}
      SORT (task.due_date == null ? 1 : 0), task.due_date ASC
      LIMIT 200
      RETURN task
    `, { ...scope.bindVars, __meSub: req.user.sub, __meEmp: req.user.emp_code || '' })
    res.json({ items, total: items.length })
  } catch (error) {
    console.error('Error listing my tasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// -----------------------------------------------------------------
// Reports: aggregated completion + SLA + workload data for the reports page.
// -----------------------------------------------------------------
router.get('/reports', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const fromDate = req.query.from || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10) })()
    const toDate = req.query.to || new Date().toISOString().slice(0, 10)
    const branch = req.query.branch || null
    const scopeFilter = branch ? 'FILTER t.branch == @branch' : ''
    const branchBind = branch ? { branch } : {}

    const completionByDay = await q(`
      FOR t IN tasks
        FILTER t.completed_at != null && SUBSTRING(t.completed_at, 0, 10) >= @from && SUBSTRING(t.completed_at, 0, 10) <= @to
        ${scopeFilter}
        COLLECT day = SUBSTRING(t.completed_at, 0, 10) WITH COUNT INTO cnt
        SORT day ASC
        RETURN { day, count: cnt }
    `, { from: fromDate, to: toDate, ...branchBind })

    const createdByDay = await q(`
      FOR t IN tasks
        FILTER t.created_at != null && SUBSTRING(t.created_at, 0, 10) >= @from && SUBSTRING(t.created_at, 0, 10) <= @to
        ${scopeFilter}
        COLLECT day = SUBSTRING(t.created_at, 0, 10) WITH COUNT INTO cnt
        SORT day ASC
        RETURN { day, count: cnt }
    `, { from: fromDate, to: toDate, ...branchBind })

    const workload = await q(`
      FOR t IN tasks
        FILTER t.archived_at == null AND t.status NOT IN ['done', 'cancelled']
        ${scopeFilter}
        COLLECT assignee = t.assignee_emp_code
        AGGREGATE total = LENGTH(1),
                  overdue_count = SUM(t.due_date != null && t.due_date < @today ? 1 : 0),
                  sla_breaches = SUM(t.sla_breached_at != null ? 1 : 0)
        SORT total DESC
        LIMIT 20
        RETURN { assignee, total, overdue: overdue_count, sla_breached: sla_breaches }
    `, { today: new Date().toISOString().slice(0, 10), ...branchBind })

    const byBranch = await q(`
      FOR t IN tasks
        FILTER t.archived_at == null
        COLLECT b = t.branch
        AGGREGATE total = LENGTH(1),
                  open_count = SUM(t.status NOT IN ['done', 'cancelled'] ? 1 : 0),
                  completed = SUM(t.status == 'done' ? 1 : 0),
                  sla = SUM(t.sla_breached_at != null ? 1 : 0)
        SORT total DESC
        RETURN { branch: b, total, open: open_count, completed, sla_breached: sla }
    `)

    const slaSummary = await q(`
      LET totalWithSla = LENGTH(FOR t IN tasks FILTER t.sla_tier != null RETURN 1)
      LET breached = LENGTH(FOR t IN tasks FILTER t.sla_breached_at != null RETURN 1)
      RETURN { tracked: totalWithSla, breached: breached, adherence_pct: totalWithSla == 0 ? 100 : (100 - (breached * 100 / totalWithSla)) }
    `)

    res.json({
      range: { from: fromDate, to: toDate, branch },
      completion_by_day: completionByDay,
      created_by_day: createdByDay,
      workload,
      by_branch: byBranch,
      sla_summary: slaSummary[0] || { tracked: 0, breached: 0, adherence_pct: 100 }
    })
  } catch (error) {
    console.error('Error building reports:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/search', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const cfg = await getAppConfig()
    const statusKeys = configStatusKeys(cfg)
    const priorityKeys = configPriorityKeys(cfg)

    const params = { ...req.body }
    const limit = Math.min(500, Math.max(1, parseInt(params.limit ?? '100', 10) || 100))
    const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1)
    const skip = (page - 1) * limit

    const scope = await buildScope(req)
    const filt = buildListFilters(params, statusKeys, priorityKeys)
    const filterAql = [scope.filterAql, filt.filterAql].filter(Boolean).join(' ')
    const bind = { ...scope.bindVars, ...filt.bindVars }
    const sortAql = buildSort(params)

    const items = await q(`FOR task IN tasks ${filterAql} ${sortAql} LIMIT ${skip}, ${limit} RETURN task`, bind)
    const cnt = await q(`FOR task IN tasks ${filterAql} COLLECT WITH COUNT INTO c RETURN c`, bind)
    res.json({ items, total: cnt[0] ?? 0, page, size: limit })
  } catch (error) {
    console.error('Error searching tasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.get('/entity/:type/:id', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const { type, id } = req.params
    const fieldMap = { customer: 'customer_id', lead: 'lead_id', receipt: 'receipt_id', loan: 'loan_id' }
    const field = fieldMap[type]
    if (!field) return res.status(400).json({ error: 'validation_error', detail: 'unsupported entity type' })
    const scope = await buildScope(req)
    const items = await q(`
      FOR task IN tasks ${scope.filterAql}
      FILTER task.${field} == @id OR (task.related_entities != null && LENGTH(FOR r IN task.related_entities FILTER r.type == @type && r.id == @id RETURN 1) > 0)
      SORT (task.status == "done" || task.status == "cancelled" ? 1 : 0), (task.due_date == null ? 1 : 0), task.due_date ASC
      LIMIT 200
      RETURN task
    `, { ...scope.bindVars, id, type })
    res.json({ items, total: items.length })
  } catch (error) {
    console.error('Error entity tasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.get('/:id', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.code === 404 ? 'not_found' : 'forbidden', detail: access.detail })
    res.json(access.task)
  } catch (error) {
    console.error('Error fetching task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// PATCH
// ------------------------------------------------------------------

async function applyPatch(task, patch, currentUser, statusKeys, priorityKeys) {
  const updates = { updated_at: now() }
  const isAssignee = task.assignee_id === currentUser.sub || task.assignee_emp_code === currentUser.emp_code
  const isAssigner = task.assigned_by_id === currentUser.sub
  const isAdminMgr = currentUser.role === 'admin' || currentUser.role === 'manager'
  const canWrite = isAssignee || isAssigner || isAdminMgr
  const canManage = isAssigner || isAdminMgr

  const reasons = []

  if (patch.status !== undefined) {
    const s = coerceStatus(patch.status, statusKeys)
    if (!s) return { error: 'invalid status', status: 400 }
    if (!canWrite) return { error: 'forbidden', status: 403 }
    updates.status = s
    if (COMPLETED_STATUSES.has(s) && !task.completed_at) updates.completed_at = now()
    if (!COMPLETED_STATUSES.has(s) && task.completed_at) updates.completed_at = null
  }
  if (patch.priority !== undefined) {
    if (!canManage) return { error: 'forbidden', status: 403 }
    const p = coercePriority(patch.priority, priorityKeys)
    if (!p) return { error: 'invalid priority', status: 400 }
    updates.priority = p
  }
  for (const f of ['title', 'description', 'due_date', 'start_date', 'scheduled_date', 'estimate_minutes', 'sla_tier', 'parent_task_id', 'customer_id', 'lead_id', 'receipt_id', 'loan_id', 'recurrence_rule', 'source']) {
    if (patch[f] !== undefined) {
      if (!canManage) return { error: 'forbidden', status: 403 }
      updates[f] = patch[f] === '' ? null : patch[f]
    }
  }
  for (const f of ['labels', 'checklist', 'watchers', 'related_entities']) {
    if (patch[f] !== undefined) {
      if (!canWrite) return { error: 'forbidden', status: 403 }
      updates[f] = Array.isArray(patch[f]) ? patch[f] : []
    }
  }
  if (patch.custom_fields !== undefined) {
    if (!canManage) return { error: 'forbidden', status: 403 }
    updates.custom_fields = patch.custom_fields && typeof patch.custom_fields === 'object' ? patch.custom_fields : {}
  }

  // Assignee change — allowed for assigner / admin / manager
  if (patch.assignee_id !== undefined) {
    if (!canManage) return { error: 'forbidden', status: 403 }
    const u = await resolveAssignee(patch.assignee_id, currentUser)
    if (!u) return { error: 'invalid assignee', status: 400 }
    updates.assignee_id = u._key
    updates.assignee_emp_code = u.emp_code || null
  }

  if (patch.archived === true || patch.archived_at) {
    if (!canManage) return { error: 'forbidden', status: 403 }
    updates.archived_at = patch.archived_at || now()
  } else if (patch.archived === false) {
    if (!canManage) return { error: 'forbidden', status: 403 }
    updates.archived_at = null
  }

  if (Object.keys(updates).length <= 1) return { error: 'no updates', status: 400 }

  return { updates, reasons }
}

router.patch('/:id', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const cfg = await getAppConfig()
    const statusKeys = configStatusKeys(cfg)
    const priorityKeys = configPriorityKeys(cfg)
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.code === 404 ? 'not_found' : 'forbidden', detail: access.detail })

    const patch = pick(req.body || {}, [...TASK_INPUT_WHITELIST, 'archived', 'archived_at'])

    // Receipt-approval tasks are managed by services/receipt-stage-engine.js.
    // Block any manual status/assignee change; comments and watchers still flow through the normal endpoints.
    if (access.task.kind === 'receipt_approval') {
      const forbiddenFields = ['status', 'assignee_id', 'assignee_emp_code', 'completed_at']
      const touched = forbiddenFields.filter(k => Object.prototype.hasOwnProperty.call(patch, k))
      if (touched.length) {
        return res.status(409).json({
          error: 'use_receipt_approval_api',
          detail: `Use POST /api/receipts/:id/{route|complete|reject} — direct task updates (${touched.join(', ')}) are not allowed on approval tasks`
        })
      }
    }

    const applied = await applyPatch(access.task, patch, req.user, statusKeys, priorityKeys)
    if (applied.error) return res.status(applied.status || 400).json({ error: applied.error })

    const col = getCollection('tasks')
    await col.update(req.params.id, applied.updates)
    const rows = await q('FOR t IN tasks FILTER t._key == @id LIMIT 1 RETURN t', { id: req.params.id })
    const updated = rows[0]

    const changes = diffFields(access.task, updated)
    if (Object.keys(changes).length) {
      await writeActivity(req.params.id, req.user, 'updated', { changes })
      publishEvent({
        type: 'task.updated',
        payload: { task_id: req.params.id, changes, status: updated.status, branch: updated.branch, assignee_id: updated.assignee_id },
        actor: { id: req.user.sub, emp_code: req.user.emp_code },
        branch: updated.branch
      })
      if (changes.status && COMPLETED_STATUSES.has(updated.status) && !COMPLETED_STATUSES.has(access.task.status)) {
        publishEvent({
          type: 'task.completed',
          payload: { task_id: req.params.id, status: updated.status, assignee_id: updated.assignee_id, branch: updated.branch },
          actor: { id: req.user.sub, emp_code: req.user.emp_code },
          branch: updated.branch
        })
      }
    }
    res.json(updated)
  } catch (error) {
    console.error('Error updating task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Bulk update
// ------------------------------------------------------------------

router.post('/bulk-update', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const cfg = await getAppConfig()
    const statusKeys = configStatusKeys(cfg)
    const priorityKeys = configPriorityKeys(cfg)

    const { ids, patch } = req.body || {}
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'validation_error', detail: 'ids required' })
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'validation_error', detail: 'patch required' })

    const col = getCollection('tasks')
    const results = { updated: 0, skipped: 0, errors: [] }
    for (const id of ids) {
      const access = await ensureCanAccess(id, req)
      if (!access.ok) { results.skipped++; results.errors.push({ id, error: access.detail }); continue }
      if (access.task.kind === 'receipt_approval') {
        const forbiddenFields = ['status', 'assignee_id', 'assignee_emp_code', 'completed_at']
        if (forbiddenFields.some(k => Object.prototype.hasOwnProperty.call(patch, k))) {
          results.skipped++; results.errors.push({ id, error: 'use_receipt_approval_api' }); continue
        }
      }
      const applied = await applyPatch(access.task, patch, req.user, statusKeys, priorityKeys)
      if (applied.error) { results.skipped++; results.errors.push({ id, error: applied.error }); continue }
      await col.update(id, applied.updates)
      const rows = await q('FOR t IN tasks FILTER t._key == @id LIMIT 1 RETURN t', { id })
      const changes = diffFields(access.task, rows[0])
      if (Object.keys(changes).length) await writeActivity(id, req.user, 'bulk_updated', { changes })
      results.updated++
    }
    res.json(results)
  } catch (error) {
    console.error('Error bulk-updating tasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// DELETE
// ------------------------------------------------------------------

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.code === 404 ? 'not_found' : 'forbidden', detail: access.detail })
    const task = access.task
    if (task.kind === 'receipt_approval') {
      return res.status(409).json({
        error: 'use_receipt_approval_api',
        detail: 'Approval tasks cannot be deleted directly; use POST /api/receipts/:id/reject or admin override'
      })
    }
    const isAssigner = task.assigned_by_id === req.user.sub
    if (!['admin', 'manager'].includes(req.user.role) && !isAssigner) {
      return res.status(403).json({ error: 'forbidden', detail: 'Only assigner, admin, or manager can delete' })
    }

    const col = getCollection('tasks')
    await col.remove(req.params.id)
    writeActivity(req.params.id, req.user, 'deleted', { title: task.title })
    res.status(204).end()
  } catch (error) {
    console.error('Error deleting task:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Subtasks (convenience wrapper)
// ------------------------------------------------------------------

router.get('/:id/subtasks', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const items = await q(`
      FOR task IN tasks FILTER task.parent_task_id == @pid
      SORT (task.due_date == null ? 1 : 0), task.due_date ASC, task.created_at ASC
      RETURN task
    `, { pid: req.params.id })
    res.json({ items, total: items.length })
  } catch (error) {
    console.error('Error listing subtasks:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/:id/subtasks', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req, { write: true })
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const parent = access.task
    const body = {
      ...(req.body || {}),
      parent_task_id: parent._key,
      customer_id: req.body?.customer_id ?? parent.customer_id,
      lead_id: req.body?.lead_id ?? parent.lead_id,
      receipt_id: req.body?.receipt_id ?? parent.receipt_id
    }
    const out = await createTaskInner(body, req.user)
    if (out.error) return res.status(out.status || 400).json({ error: out.error, detail: out.detail })
    await writeActivity(parent._key, req.user, 'subtask_created', { subtask_id: out.task._key, title: out.task.title })
    res.status(201).json(out.task)
  } catch (error) {
    console.error('Error creating subtask:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Watchers
// ------------------------------------------------------------------

router.get('/:id/watchers', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const rows = await q(`
      FOR w IN task_watchers FILTER w.task_key == @id
      FOR u IN users FILTER u._key == w.user_id LIMIT 1
      RETURN { user_id: u._key, name: u.name, emp_code: u.emp_code, added_at: w.created_at }
    `, { id: req.params.id })
    res.json({ items: rows })
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/:id/watchers', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const uid = String(req.body?.user_id || req.user.sub)
    const col = getCollection('task_watchers')
    const existing = await q('FOR w IN task_watchers FILTER w.task_key == @id && w.user_id == @u LIMIT 1 RETURN w', { id: req.params.id, u: uid })
    if (!existing.length) {
      await col.save({ task_key: req.params.id, user_id: uid, created_at: now() })
      await writeActivity(req.params.id, req.user, 'watcher_added', { user_id: uid })
    }
    res.status(201).json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.delete('/:id/watchers/:uid', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const col = getCollection('task_watchers')
    const rows = await q('FOR w IN task_watchers FILTER w.task_key == @id && w.user_id == @u LIMIT 1 RETURN w', { id: req.params.id, u: req.params.uid })
    for (const w of rows) await col.remove(w._key)
    await writeActivity(req.params.id, req.user, 'watcher_removed', { user_id: req.params.uid })
    res.status(204).end()
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Comments (threaded)
// ------------------------------------------------------------------

router.get('/:id/comments', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const items = await q(`
      FOR c IN task_comments FILTER c.task_key == @id
      SORT c.created_at ASC
      RETURN c
    `, { id: req.params.id })
    res.json({ items, total: items.length })
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const { body, parent_comment_id, mentions } = req.body || {}
    if (!body || typeof body !== 'string' || !body.trim()) return res.status(400).json({ error: 'validation_error', detail: 'body required' })
    const col = getCollection('task_comments')
    const saved = await col.save({
      task_key: req.params.id,
      parent_comment_id: parent_comment_id || null,
      body: body.trim(),
      mentions: Array.isArray(mentions) ? mentions.filter(Boolean) : [],
      author_id: req.user.sub,
      author_emp_code: req.user.emp_code || null,
      author_name: req.user.name || null,
      created_at: now()
    })
    await writeActivity(req.params.id, req.user, 'commented', { comment_id: saved._key, preview: body.slice(0, 140) })
    const rows = await q('FOR c IN task_comments FILTER c._key == @k LIMIT 1 RETURN c', { k: saved._key })
    res.status(201).json(rows[0])
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.delete('/:id/comments/:cid', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const rows = await q('FOR c IN task_comments FILTER c._key == @k LIMIT 1 RETURN c', { k: req.params.cid })
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    const c = rows[0]
    if (c.author_id !== req.user.sub && !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    await getCollection('task_comments').remove(req.params.cid)
    await writeActivity(req.params.id, req.user, 'comment_removed', { comment_id: req.params.cid })
    res.status(204).end()
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Activities (audit trail)
// ------------------------------------------------------------------

router.get('/:id/activities', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const items = await q(`
      FOR a IN task_activities FILTER a.task_key == @id
      SORT a.created_at DESC LIMIT 500
      RETURN a
    `, { id: req.params.id })
    res.json({ items, total: items.length })
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ------------------------------------------------------------------
// Attachments (multipart)
// ------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const UPLOAD_DIR = path.resolve(__dirname, '..', 'uploads', 'tasks')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_')
      cb(null, `${Date.now()}_${Math.floor(Math.random() * 1e6)}_${safe}`)
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB
})

router.get('/:id/attachments', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const items = await q('FOR a IN task_attachments FILTER a.task_key == @id SORT a.created_at DESC RETURN a', { id: req.params.id })
    res.json({ items })
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/:id/attachments', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const col = getCollection('task_attachments')
    const saved = []
    for (const f of (req.files || [])) {
      const doc = {
        task_key: req.params.id,
        filename: f.originalname,
        stored_path: path.relative(path.resolve(__dirname, '..'), f.path).replace(/\\/g, '/'),
        mime: f.mimetype,
        size: f.size,
        url: `/uploads/tasks/${path.basename(f.path)}`,
        uploaded_by_id: req.user.sub,
        uploaded_by_emp_code: req.user.emp_code || null,
        created_at: now()
      }
      const r = await col.save(doc)
      saved.push({ _key: r._key, ...doc })
      await writeActivity(req.params.id, req.user, 'attachment_added', { filename: doc.filename, url: doc.url })
    }
    res.status(201).json({ items: saved })
  } catch (error) {
    console.error('Error uploading attachment:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.delete('/:id/attachments/:aid', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const access = await ensureCanAccess(req.params.id, req)
    if (!access.ok) return res.status(access.code).json({ error: access.detail })
    const rows = await q('FOR a IN task_attachments FILTER a._key == @k LIMIT 1 RETURN a', { k: req.params.aid })
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    const att = rows[0]
    try {
      if (att.stored_path) fs.unlinkSync(path.resolve(__dirname, '..', att.stored_path))
    } catch { /* tolerate missing files */ }
    await getCollection('task_attachments').remove(req.params.aid)
    await writeActivity(req.params.id, req.user, 'attachment_removed', { filename: att.filename })
    res.status(204).end()
  } catch (error) {
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
