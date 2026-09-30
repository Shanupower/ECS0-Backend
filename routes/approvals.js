import express from 'express'
import { q } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { ensureTaskSetup } from '../config/tasks-collections.js'
import { buildReceiptScopeFilter } from '../services/reports/receipt-scope-filter.js'

const router = express.Router()

const OPEN_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked'])
const COMPLETED_STATUSES = new Set(['done', 'cancelled'])

let __setupPromise = null
async function ensureReady() {
  if (!__setupPromise) {
    __setupPromise = ensureTaskSetup().catch((err) => {
      __setupPromise = null
      throw err
    })
  }
  return __setupPromise
}


function parseDateRangeQuery(query = {}) {
  const from = String(query.from || '').trim().slice(0, 10)
  const to = String(query.to || '').trim().slice(0, 10)
  return { from, to }
}

function appendReceiptDateRangeFilters(bindVars, from, to) {
  const parts = []
  if (from) {
    bindVars.date_from = from
    parts.push(`rDateNorm >= @date_from`)
  }
  if (to) {
    bindVars.date_to = to
    parts.push(`rDateNorm <= @date_to`)
  }
  return parts
}

async function getCurrentUserBranch(userId) {
  const rows = await q(`
    FOR u IN users FILTER u._key == @id LIMIT 1
    RETURN { branch: u.branch, emp_code: u.emp_code, role: u.role }
  `, { id: userId })
  return rows[0] || null
}

async function buildTaskScope(req) {
  const { role, sub, emp_code } = req.user
  if (role === 'admin') return { filterAql: '', bindVars: {} }
  if (role === 'manager') {
    const me = await getCurrentUserBranch(sub)
    if (!me?.branch) return { filterAql: 'FILTER 1 == 0', bindVars: {} }
    return {
      filterAql: 'FILTER task.branch == @scope_branch',
      bindVars: { scope_branch: me.branch }
    }
  }
  return {
    filterAql: `FILTER task.assignee_id == @scope_uid OR task.assignee_emp_code == @scope_emp OR task.assigned_by_id == @scope_uid OR @scope_uid IN (task.watchers || [])`,
    bindVars: { scope_uid: sub, scope_emp: emp_code || '' }
  }
}

async function loadBranchNameMap() {
  const rows = await q(`FOR b IN branches RETURN { code: b.branch_code, key: b._key, name: b.branch_name }`)
  const map = new Map()
  for (const b of rows) {
    if (b.code) map.set(String(b.code).trim().toUpperCase(), b.name)
    if (b.key) map.set(String(b.key).trim(), b.name)
    if (b.name) map.set(String(b.name).trim().toUpperCase(), b.name)
  }
  return map
}

function resolveBranchName(branchCode, map) {
  if (!branchCode) return null
  const key = String(branchCode).trim()
  return map.get(key.toUpperCase()) || map.get(key) || branchCode
}

function extractReceiptSummary(receipt) {
  if (!receipt) return { scheme_name: null, amount: null }
  const scheme_name = receipt.product?.name
    || receipt.scheme_name
    || receipt.schemeName
    || receipt.fd_scheme_name
    || receipt.bond_scheme_name
    || receipt.insurance_product_name
    || null
  const amount = receipt.transaction?.amount ?? receipt.investment_amount ?? null
  return { scheme_name, amount }
}

async function fetchApprovalTasks(req) {
  await ensureReady()
  const { from, to } = parseDateRangeQuery(req.query)
  const scope = await buildTaskScope(req)
  const bindVars = { ...scope.bindVars }
  const dateParts = appendReceiptDateRangeFilters(bindVars, from, to)
  const dateFilter = dateParts.length ? `FILTER ${dateParts.join(' AND ')}\n` : ''
  const rows = await q(`
    FOR task IN tasks
      FILTER task.kind == 'receipt_approval'
      ${scope.filterAql}
      FILTER task.archived_at == null
      FILTER task.status NOT IN ['done', 'cancelled']
      LET r = DOCUMENT('receipts', TO_STRING(task.receipt_id))
      FILTER r != null && r.is_deleted != true
      LET rDate = (r.date != null && r.date != "" ? r.date : (r.receipt_date != null && r.receipt_date != "" ? r.receipt_date : SUBSTRING(r.created_at, 0, 10)))
      LET rDateNorm = SUBSTRING(TO_STRING(rDate), 0, 10)
      ${dateFilter}SORT rDateNorm DESC, task.created_at DESC
      LIMIT 500
      RETURN task
  `, bindVars)
  return rows
}

async function enrichTasksWithReceipts(tasks, branchMap) {
  const receiptIds = [...new Set(tasks.map(t => t.receipt_id).filter(Boolean))]
  const receiptMap = new Map()
  if (receiptIds.length > 0) {
    const receipts = await q(`
      FOR id IN @ids
        LET r = DOCUMENT('receipts', id)
        FILTER r != null
        LET rDate = (r.date != null && r.date != "" ? r.date : (r.receipt_date != null && r.receipt_date != "" ? r.receipt_date : SUBSTRING(r.created_at, 0, 10)))
        RETURN {
          _key: r._key,
          receipt_no: r.receipt_no || r.receiptNo || null,
          receipt_date: SUBSTRING(TO_STRING(rDate), 0, 10),
          scheme_name: r.product.name || r.scheme_name || r.schemeName || r.fd_scheme_name || r.bond_scheme_name || r.insurance_product_name || null,
          amount: r.transaction.amount != null ? r.transaction.amount : (r.investment_amount != null ? r.investment_amount : null),
          branch: r.branch || null
        }
    `, { ids: receiptIds })
    for (const r of receipts) receiptMap.set(r._key, r)
  }

  return tasks.map((task) => {
    const receipt = task.receipt_id ? receiptMap.get(task.receipt_id) : null
    const branchCode = task.branch_name ? null : (task.branch || receipt?.branch || null)
    const branch_name = task.branch_name || resolveBranchName(branchCode, branchMap) || branchCode
    return {
      ...task,
      scheme_name: task.scheme_name || receipt?.scheme_name || null,
      amount: task.amount != null ? task.amount : (receipt?.amount != null ? receipt.amount : null),
      branch_name,
      receipt_no: receipt?.receipt_no || null,
      receipt_date: receipt?.receipt_date || null
    }
  })
}

/** GET /api/approvals/queue — paginated open approval tasks enriched with receipt summary */
router.get('/queue', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const { from, to } = parseDateRangeQuery(req.query)
    const scope = await buildTaskScope(req)
    const bindVars = { ...scope.bindVars }

    const dateParts = appendReceiptDateRangeFilters(bindVars, from, to)
    const dateFilter = dateParts.length ? `FILTER ${dateParts.join(' AND ')}\n` : ''

    let teamFilter = ''
    if (req.query.team_id && req.query.team_id !== 'all') {
      bindVars.filter_team_id = String(req.query.team_id)
      teamFilter = 'FILTER task.team_id == @filter_team_id\n'
    }

    let statusFilter = ''
    const st = String(req.query.status || '').toLowerCase().trim()
    const nowIso = new Date().toISOString()
    if (st === 'overdue') {
      bindVars.now_iso = nowIso
      statusFilter = 'FILTER task.due_date != null AND task.due_date < @now_iso\n'
    } else if (st === 'in_review') {
      statusFilter = "FILTER task.status == 'in_review'\n"
    } else if (st && OPEN_STATUSES.has(st)) {
      bindVars.st_val = st
      statusFilter = 'FILTER task.status == @st_val\n'
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || req.query.limit, 10) || 25))
    const offset = (page - 1) * pageSize

    const countRows = await q(`
      FOR task IN tasks
        FILTER task.kind == 'receipt_approval'
        ${scope.filterAql}
        ${teamFilter}${statusFilter}FILTER task.archived_at == null
        FILTER task.status NOT IN ['done', 'cancelled']
        LET r = DOCUMENT('receipts', TO_STRING(task.receipt_id))
        FILTER r != null && r.is_deleted != true
        LET rDate = (r.date != null && r.date != "" ? r.date : (r.receipt_date != null && r.receipt_date != "" ? r.receipt_date : SUBSTRING(r.created_at, 0, 10)))
        LET rDateNorm = SUBSTRING(TO_STRING(rDate), 0, 10)
        ${dateFilter}COLLECT WITH COUNT INTO total
        RETURN total
    `, bindVars)

    const total = countRows[0] || 0

    const pageTasks = await q(`
      FOR task IN tasks
        FILTER task.kind == 'receipt_approval'
        ${scope.filterAql}
        ${teamFilter}${statusFilter}FILTER task.archived_at == null
        FILTER task.status NOT IN ['done', 'cancelled']
        LET r = DOCUMENT('receipts', TO_STRING(task.receipt_id))
        FILTER r != null && r.is_deleted != true
        LET rDate = (r.date != null && r.date != "" ? r.date : (r.receipt_date != null && r.receipt_date != "" ? r.receipt_date : SUBSTRING(r.created_at, 0, 10)))
        LET rDateNorm = SUBSTRING(TO_STRING(rDate), 0, 10)
        ${dateFilter}SORT rDateNorm DESC, task.created_at DESC
        LIMIT @offset, @pageSize
        RETURN task
    `, { ...bindVars, offset, pageSize })

    const branchMap = await loadBranchNameMap()
    const items = await enrichTasksWithReceipts(pageTasks, branchMap)

    res.json({
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize)
    })
  } catch (err) {
    console.error('[approvals] queue error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

/** GET /api/approvals/summary — status cards + per-team breakdown */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const { from, to } = parseDateRangeQuery(req.query)
    const scope = await buildTaskScope(req)
    const bindVars = { ...scope.bindVars }
    const dateParts = appendReceiptDateRangeFilters(bindVars, from, to)
    const dateFilter = dateParts.length ? `FILTER ${dateParts.join(' AND ')}\n` : ''

    const [tasks, teams] = await Promise.all([
      q(`
        FOR task IN tasks
          FILTER task.kind == 'receipt_approval'
          ${scope.filterAql}
          FILTER task.archived_at == null
          FILTER task.status NOT IN ['done', 'cancelled']
          LET r = DOCUMENT('receipts', TO_STRING(task.receipt_id))
          FILTER r != null && r.is_deleted != true
          LET rDate = (r.date != null && r.date != "" ? r.date : (r.receipt_date != null && r.receipt_date != "" ? r.receipt_date : SUBSTRING(r.created_at, 0, 10)))
          LET rDateNorm = SUBSTRING(TO_STRING(rDate), 0, 10)
          ${dateFilter}RETURN {
            team_id: task.team_id,
            status: task.status,
            due_date: task.due_date,
            created_at: task.created_at,
            receipt_date: rDateNorm
          }
      `, bindVars),
      q(`FOR t IN teams RETURN { _key: t._key, name: t.name }`)
    ])
    const nowMs = Date.now()

    const statusCards = {
      pending_on_my_teams: tasks.length,
      overdue: tasks.filter(t => t.due_date && new Date(t.due_date).getTime() < nowMs).length,
      in_review: tasks.filter(t => t.status === 'in_review').length,
      completed_in_range: 0
    }

    // Count completed receipts within the selected receipt date range matching user scope
    const { filterConditions: receiptScopeConditions, bindVars: receiptScopeBind } = await buildReceiptScopeFilter(req.user, req.query)
    const completedBind = { ...receiptScopeBind }
    const completedDateParts = []
    if (from) {
      completedBind.comp_from = from
      completedDateParts.push(`rDateNorm >= @comp_from`)
    }
    if (to) {
      completedBind.comp_to = to
      completedDateParts.push(`rDateNorm <= @comp_to`)
    }
    const completedConditions = [
      'receipt.is_deleted != true',
      'receipt.status == "Completed"',
      ...receiptScopeConditions,
      ...completedDateParts
    ]
    const completedFilterClause = `FILTER ${completedConditions.join(' AND ')}\n`

    const completedRecent = await q(`
      FOR receipt IN receipts
        LET rDate = (receipt.date != null && receipt.date != "" ? receipt.date : (receipt.receipt_date != null && receipt.receipt_date != "" ? receipt.receipt_date : SUBSTRING(receipt.created_at, 0, 10)))
        LET rDateNorm = SUBSTRING(TO_STRING(rDate), 0, 10)
        ${completedFilterClause}
        COLLECT WITH COUNT INTO c
        RETURN c
    `, completedBind)
    statusCards.completed_in_range = completedRecent[0] || 0

    const teamNameById = Object.fromEntries(teams.map(t => [String(t._key), t.name]))
    const byTeamMap = new Map()
    for (const task of tasks) {
      const teamId = String(task.team_id || 'unknown')
      if (!byTeamMap.has(teamId)) {
        byTeamMap.set(teamId, {
          team_id: teamId,
          team_name: teamNameById[teamId] || teamId,
          open_approvals: 0,
          overdue: 0,
          oldest_pending: null,
          total_age_days: 0
        })
      }
      const row = byTeamMap.get(teamId)
      row.open_approvals += 1
      if (task.due_date && new Date(task.due_date).getTime() < nowMs) row.overdue += 1
      const created = task.created_at ? new Date(task.created_at) : null
      if (created) {
        if (!row.oldest_pending || created < new Date(row.oldest_pending)) {
          row.oldest_pending = task.created_at
        }
        row.total_age_days += Math.max(0, Math.floor((nowMs - created.getTime()) / 86400000))
      }
    }

    const by_team = [...byTeamMap.values()].map(row => ({
      ...row,
      avg_age_days: row.open_approvals > 0 ? Math.round(row.total_age_days / row.open_approvals) : 0
    })).sort((a, b) => b.open_approvals - a.open_approvals)

    res.json({ status_cards: statusCards, by_team })
  } catch (err) {
    console.error('[approvals] summary error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

export default router
