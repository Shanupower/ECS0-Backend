// Receipt approval workflow state machine.
//
// See docs/superpowers/specs/2026-04-22-receipt-approval-workflow-design.md
//
// Public surface (all async):
//   submit(receiptKey, actor)
//   routeToTeam(receiptKey, actor, nextTeamId, comment?)
//   completeReceipt(receiptKey, actor, comment?)
//   rejectToCreator(receiptKey, actor, comment)
//   adminOverride(receiptKey, actor, { nextTeamId?, complete?, reject?, comment? })
//   isReceiptEditable(receipt, user) -> boolean        (synchronous helper)
//   getReceiptHistory(receiptKey) -> { stage_history, ... }
//
// Errors are thrown as `EngineError` instances with a stable `.code` and an
// HTTP-friendly `.status`. Route handlers translate those to JSON responses.
//
// Concurrency: each state transition uses AQL compare-and-set (FILTER inside
// UPDATE) on `receipts.current_team_id` / `receipts.status`. If the filter
// matches zero documents, we know another actor changed the receipt first and
// we abort with `EngineError('stale_state', 409)`. Orphan approval tasks that
// briefly exist between "create task" and "receipt CAS update" are cleaned up
// in the catch path.

import { q, getCollection } from '../config/database.js'
import { getAppConfig } from '../routes/app-config.js'
import { publishEvent } from './task-events.js'
import { ensureTaskSetup } from '../config/tasks-collections.js'

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export class EngineError extends Error {
  constructor(code, status, detail) {
    super(detail || code)
    this.code = code
    this.status = status || 400
    this.detail = detail || code
  }
}

const STATUS_DRAFT = 'Draft'
const STATUS_NEEDS_CHANGES = 'Needs Changes'
const DEFAULT_FINAL_LABEL = 'Completed'
const TERMINAL_STATUSES = new Set([STATUS_DRAFT, STATUS_NEEDS_CHANGES])

function now() { return new Date().toISOString() }

function newCycleId() {
  // 22-char base62-ish; good enough for per-receipt cycle marker.
  return `cyc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

// Lazy setup gate so routes that call the engine before `setup-arangodb.js`
// ran still get their collections/indexes.
let __setupPromise = null
async function ensureReady() {
  if (!__setupPromise) {
    __setupPromise = ensureTaskSetup().catch((err) => {
      console.error('[receipt-stage-engine] ensureTaskSetup failed:', err)
      __setupPromise = null
      throw err
    })
  }
  return __setupPromise
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadReceipt(key) {
  const rows = await q('FOR r IN receipts FILTER r._key == @k LIMIT 1 RETURN r', { k: String(key) })
  if (!rows.length) throw new EngineError('receipt_not_found', 404, 'Receipt not found')
  return rows[0]
}

async function loadTeam(key) {
  const rows = await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: String(key) })
  if (!rows.length) throw new EngineError('team_not_found', 404, 'Team not found')
  return rows[0]
}

/** Uppercase trimmed product.category from nested or legacy receipt fields. */
export function receiptProductCategory(receipt) {
  const raw = receipt?.product?.category ?? receipt?.product_category ?? ''
  const s = String(raw).trim().toUpperCase()
  return s || null
}

/**
 * Resolve intake team for a receipt from per-category map, then fallback to receipt_intake_team_id.
 * NCD may fall back to BOND’s team if NCD is unmapped.
 */
export async function resolveIntakeTeam(receipt) {
  const cfg = await getAppConfig()
  const map = (cfg?.receipt_intake_teams_by_category && typeof cfg.receipt_intake_teams_by_category === 'object')
    ? cfg.receipt_intake_teams_by_category
    : {}
  const cat = receipt ? receiptProductCategory(receipt) : null
  let intakeId = null
  if (cat && map[cat]) {
    intakeId = String(map[cat]).trim()
  }
  if (!intakeId && cat === 'NCD' && map.BOND) {
    intakeId = String(map.BOND).trim()
  }
  if (!intakeId) {
    intakeId = cfg?.receipt_intake_team_id ? String(cfg.receipt_intake_team_id).trim() : ''
  }
  if (!intakeId) {
    throw new EngineError('no_intake_team_configured', 409, 'Admin has not set receipt_intake_team_id or a team for this product category')
  }
  const t = await loadTeam(intakeId).catch(() => null)
  if (!t || t.is_active === false) {
    throw new EngineError('no_intake_team_configured', 409, 'Configured intake team is missing or inactive')
  }
  return { team: t, finalLabel: cfg?.receipt_final_status_label || DEFAULT_FINAL_LABEL, cfg }
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function isAdmin(user) { return user?.role === 'admin' }

function isCreator(receipt, user) {
  if (!user) return false
  return receipt.user_id === user.sub || receipt.user_id === user._key
    || (receipt.emp_code && user.emp_code && receipt.emp_code === user.emp_code)
}

function isTeamMember(team, user) {
  if (!team || !user) return false
  const uid = user.sub || user._key
  return Array.isArray(team.member_ids) && team.member_ids.includes(uid)
}

// ---------------------------------------------------------------------------
// Approval task primitives
// ---------------------------------------------------------------------------

/** Create the approval task for a receipt entering a team. Returns the new task doc. */
async function createApprovalTask(receipt, team, cycleId, actor) {
  const tasks = getCollection('tasks')
  const watchers = (team.member_ids || []).filter(id => id !== team.lead_user_id)
  const doc = {
    title: `Approve receipt ${receipt._key} — ${team.name}`,
    description: `Receipt ${receipt._key} is awaiting approval from team "${team.name}". Approve & route to next team, Approve & Complete, or Reject back to the creator.`,
    status: 'todo',
    priority: 'p1',
    labels: ['approval', `team:${team.name}`],
    assignee_id: team.lead_user_id || null,
    assignee_emp_code: null,
    assigned_by_id: actor?.sub || actor?._key || 'system',
    assigned_by_emp_code: actor?.emp_code || null,
    branch: receipt.branch || null,
    start_date: null,
    due_date: null,
    scheduled_date: null,
    completed_at: null,
    parent_task_id: null,
    estimate_minutes: null,
    checklist: [],
    watchers,
    customer_id: receipt.investor_id != null ? String(receipt.investor_id) : null,
    lead_id: null,
    receipt_id: receipt._key,
    loan_id: null,
    related_entities: [],
    recurrence_rule: null,
    recurrence_series_id: null,
    sla_tier: null,
    sla_breached_at: null,
    custom_fields: {},
    // Approval-specific fields (kind allows route guards + indexing).
    kind: 'receipt_approval',
    team_id: team._key,
    approval_cycle_id: cycleId,
    source: 'receipt_approval_engine',
    source_rule_id: null,
    archived_at: null,
    created_at: now(),
    updated_at: now()
  }
  const saved = await tasks.save(doc)

  // Mirror watcher rows so existing notification pipeline pings every team member.
  const watchersCol = getCollection('task_watchers')
  const allWatchers = [...new Set([team.lead_user_id, ...watchers].filter(Boolean))]
  for (const uid of allWatchers) {
    try {
      await watchersCol.save({ task_key: saved._key, user_id: uid, added_at: now() })
    } catch (err) {
      // Unique index (task_key, user_id) — harmless if pre-existing.
      if (err?.errorNum !== 1210) console.warn('[engine] watcher save warn:', err.message)
    }
  }

  writeTaskActivity(saved._key, actor, 'created', {
    title: doc.title,
    kind: 'receipt_approval',
    team_id: team._key,
    approval_cycle_id: cycleId,
    receipt_id: receipt._key
  })
  return { _key: saved._key, ...doc }
}

/** Mark the approval task as resolved (done/cancelled) and log an activity row. */
async function closeApprovalTask(taskKey, resolution, actor, comment) {
  if (!taskKey) return null
  const statusFor = { approved: 'done', rejected: 'cancelled', forced: 'done' }[resolution] || 'done'
  const rows = await q(`
    FOR t IN tasks FILTER t._key == @k
      UPDATE t WITH {
        status: @status,
        completed_at: @now,
        updated_at: @now,
        custom_fields: MERGE(t.custom_fields OR {}, { approval_resolution: @resolution, approval_comment: @comment })
      } IN tasks
      RETURN NEW
  `, { k: String(taskKey), status: statusFor, now: now(), resolution, comment: comment || null })

  writeTaskActivity(taskKey, actor, 'status_changed', {
    status: statusFor,
    resolution,
    comment: comment || null
  })
  if (comment) {
    try {
      const commentsCol = getCollection('task_comments')
      await commentsCol.save({
        task_key: String(taskKey),
        parent_comment_id: null,
        body: comment,
        author_id: actor?.sub || actor?._key || null,
        author_emp_code: actor?.emp_code || null,
        author_name: actor?.name || null,
        created_at: now()
      })
    } catch (err) { console.warn('[engine] comment save warn:', err.message) }
  }
  return rows[0] || null
}

/** Fire-and-forget activity writer shared with approval task operations. */
function writeTaskActivity(taskKey, actor, kind, payload = {}) {
  if (!taskKey) return
  try {
    const col = getCollection('task_activities')
    // Intentional: don't await — activity-log failures must not break the flow.
    col.save({
      task_key: String(taskKey),
      kind,
      payload,
      actor_id: actor?.sub || actor?._key || null,
      actor_emp_code: actor?.emp_code || null,
      actor_name: actor?.name || null,
      created_at: now()
    }).catch(err => console.warn('[engine] activity save warn:', err.message))
  } catch (err) {
    console.warn('[engine] activity writer warn:', err.message)
  }
}

// ---------------------------------------------------------------------------
// Stage history
// ---------------------------------------------------------------------------

// Each history entry grows an optional `attachment_ids: string[]` that
// references files on `receipt.files[]`. Uploads happen via the existing
// media endpoint; the engine just records which file IDs belong to this
// decision so the timeline can render them in the correct slot.
function sanitizeAttachmentIds(ids) {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.map((x) => (x == null ? '' : String(x))).filter(Boolean))]
}

function newStageEventId() {
  return `se_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function openHistoryEntry({ cycleId, team, actor, taskKey, attachmentIds = [] }) {
  return {
    stage_event_id: newStageEventId(),
    cycle_id: cycleId,
    team_id: team?._key || null,
    team_name: team?.name || null,
    entered_at: now(),
    exited_at: null,
    resolution: null,
    next_team_id: null,
    next_team_name: null,
    actor_id: actor?.sub || actor?._key || null,
    actor_name: actor?.name || null,
    comment: null,
    task_key: taskKey || null,
    attachment_ids: sanitizeAttachmentIds(attachmentIds)
  }
}

function closeHistoryEntry(entry, { resolution, nextTeam, comment, actor, forced, attachmentIds }) {
  const existing = Array.isArray(entry.attachment_ids) ? entry.attachment_ids : []
  const merged = attachmentIds !== undefined
    ? sanitizeAttachmentIds([...existing, ...sanitizeAttachmentIds(attachmentIds)])
    : existing
  return {
    ...entry,
    exited_at: now(),
    resolution,
    next_team_id: nextTeam?._key || null,
    next_team_name: nextTeam?.name || null,
    comment: comment || entry.comment || null,
    actor_id: actor?.sub || actor?._key || entry.actor_id || null,
    actor_name: actor?.name || entry.actor_name || null,
    forced: forced ? true : undefined,
    attachment_ids: merged
  }
}

// ---------------------------------------------------------------------------
// CAS-based receipt updater
// ---------------------------------------------------------------------------

/**
 * Apply `patch` to a receipt only if its current snapshot matches
 * `expected` (shallow compare on the listed keys). Returns the updated doc or
 * throws `EngineError('stale_state')`.
 */
async function casUpdateReceipt(receiptKey, expected, patch) {
  const keys = Object.keys(expected)
  const filters = keys.map(k => `r.${k} == @e_${k}`).join(' AND ')
  const expectedBinds = Object.fromEntries(keys.map(k => [`e_${k}`, expected[k] ?? null]))
  const rows = await q(`
    FOR r IN receipts FILTER r._key == @k ${filters ? 'FILTER ' + filters : ''}
      UPDATE r WITH @patch IN receipts
      RETURN NEW
  `, { k: String(receiptKey), patch, ...expectedBinds })
  if (!rows.length) throw new EngineError('stale_state', 409, 'Receipt state changed concurrently; retry')
  return rows[0]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Submit a receipt: from Draft / Needs Changes -> intake team.
 * Starts a new cycle, clears approved_by_team_ids, creates an approval task.
 */
export async function submit(receiptKey, actor, { attachmentIds = [] } = {}) {
  await ensureReady()
  const receipt = await loadReceipt(receiptKey)
  if (!(isCreator(receipt, actor) || isAdmin(actor))) {
    throw new EngineError('forbidden', 403, 'Only the receipt creator or an admin can submit')
  }
  if (!TERMINAL_STATUSES.has(receipt.status)) {
    throw new EngineError('receipt_not_in_flight', 409, `Receipt is already ${receipt.status}; cannot submit`)
  }
  const { team: intake } = await resolveIntakeTeam(receipt)

  const cycleId = newCycleId()
  const task = await createApprovalTask(receipt, intake, cycleId, actor)

  let updated
  try {
    const expected = { status: receipt.status, current_team_id: receipt.current_team_id ?? null }
    const history = Array.isArray(receipt.stage_history) ? [...receipt.stage_history] : []
    history.push(openHistoryEntry({ cycleId, team: intake, actor, taskKey: task._key, attachmentIds }))
    updated = await casUpdateReceipt(receiptKey, expected, {
      status: intake.name,
      current_team_id: intake._key,
      current_approval_task_key: task._key,
      approval_cycle_id: cycleId,
      approved_by_team_ids: [],
      stage_history: history,
      updated_at: now()
    })
  } catch (err) {
    // Compensate: drop the task we just created so we don't orphan it.
    try { await getCollection('tasks').remove(task._key) } catch { /* best effort */ }
    throw err
  }

  publishEvent({
    type: 'receipt.submitted',
    payload: { receipt_id: receiptKey, cycle_id: cycleId, intake_team_id: intake._key, actor_id: actor?.sub || actor?._key },
    actor, branch: receipt.branch || null
  })
  return { receipt: updated, task }
}

/**
 * Approve the current stage and route to `nextTeamId`.
 */
export async function routeToTeam(receiptKey, actor, nextTeamId, comment, { attachmentIds = [] } = {}) {
  await ensureReady()
  const receipt = await loadReceipt(receiptKey)
  if (!receipt.current_team_id) {
    throw new EngineError('receipt_not_in_flight', 409, 'Receipt is not currently held by a team')
  }
  const currentTeam = await loadTeam(receipt.current_team_id)
  if (!(isTeamMember(currentTeam, actor) || isAdmin(actor))) {
    throw new EngineError('not_current_team_member', 403, `Only members of team "${currentTeam.name}" can approve`)
  }
  const nextTeam = await loadTeam(nextTeamId)
  validateNextTeam({ currentTeam, nextTeam, receipt })

  await closeApprovalTask(receipt.current_approval_task_key, 'approved', actor, comment)

  const newTask = await createApprovalTask(receipt, nextTeam, receipt.approval_cycle_id, actor)

  let updated
  try {
    const expected = {
      current_team_id: receipt.current_team_id,
      approval_cycle_id: receipt.approval_cycle_id
    }
    const history = Array.isArray(receipt.stage_history) ? [...receipt.stage_history] : []
    // Close the most recent open entry for the current team/cycle.
    const idx = findOpenHistoryIndex(history, receipt.approval_cycle_id, currentTeam._key)
    if (idx >= 0) {
      history[idx] = closeHistoryEntry(history[idx], { resolution: 'routed', nextTeam, comment, actor, attachmentIds })
    }
    history.push(openHistoryEntry({ cycleId: receipt.approval_cycle_id, team: nextTeam, actor, taskKey: newTask._key }))
    const approvedBy = [...(receipt.approved_by_team_ids || []), currentTeam._key]
    updated = await casUpdateReceipt(receiptKey, expected, {
      status: nextTeam.name,
      current_team_id: nextTeam._key,
      current_approval_task_key: newTask._key,
      approved_by_team_ids: approvedBy,
      stage_history: history,
      updated_at: now()
    })
  } catch (err) {
    try { await getCollection('tasks').remove(newTask._key) } catch { /* best effort */ }
    throw err
  }

  publishEvent({
    type: 'receipt.routed',
    payload: {
      receipt_id: receiptKey,
      from_team_id: currentTeam._key,
      to_team_id: nextTeam._key,
      cycle_id: receipt.approval_cycle_id,
      actor_id: actor?.sub || actor?._key
    },
    actor, branch: receipt.branch || null
  })
  return { receipt: updated, task: newTask }
}

/** Approve and finalize: status -> final label, current_team_id cleared. */
export async function completeReceipt(receiptKey, actor, comment, { forced = false, attachmentIds = [] } = {}) {
  await ensureReady()
  const receipt = await loadReceipt(receiptKey)
  if (!receipt.current_team_id) {
    throw new EngineError('receipt_not_in_flight', 409, 'Receipt is not currently held by a team')
  }
  const currentTeam = await loadTeam(receipt.current_team_id)
  if (!forced && !(isTeamMember(currentTeam, actor) || isAdmin(actor))) {
    throw new EngineError('not_current_team_member', 403, `Only members of team "${currentTeam.name}" can approve`)
  }
  const cfg = await getAppConfig()
  const finalLabel = cfg?.receipt_final_status_label || DEFAULT_FINAL_LABEL

  await closeApprovalTask(receipt.current_approval_task_key, 'approved', actor, comment)

  const expected = {
    current_team_id: receipt.current_team_id,
    approval_cycle_id: receipt.approval_cycle_id
  }
  const history = Array.isArray(receipt.stage_history) ? [...receipt.stage_history] : []
  const idx = findOpenHistoryIndex(history, receipt.approval_cycle_id, currentTeam._key)
  if (idx >= 0) {
    history[idx] = closeHistoryEntry(history[idx], { resolution: 'approved', comment, actor, forced, attachmentIds })
  }
  const approvedBy = [...(receipt.approved_by_team_ids || []), currentTeam._key]
  const updated = await casUpdateReceipt(receiptKey, expected, {
    status: finalLabel,
    current_team_id: null,
    current_approval_task_key: null,
    approved_by_team_ids: approvedBy,
    stage_history: history,
    status_updated_at: now(),
    status_updated_by: actor?.sub || actor?._key || null,
    updated_at: now()
  })
  publishEvent({
    type: 'receipt.completed',
    payload: { receipt_id: receiptKey, cycle_id: receipt.approval_cycle_id, actor_id: actor?.sub || actor?._key, forced },
    actor, branch: receipt.branch || null
  })
  return { receipt: updated, task: null }
}

/** Reject back to the creator. Comment is required. */
export async function rejectToCreator(receiptKey, actor, comment, { forced = false, attachmentIds = [] } = {}) {
  await ensureReady()
  if (!comment || !String(comment).trim()) {
    throw new EngineError('comment_required', 400, 'A rejection comment is required')
  }
  const receipt = await loadReceipt(receiptKey)
  if (!receipt.current_team_id) {
    throw new EngineError('receipt_not_in_flight', 409, 'Receipt is not currently held by a team')
  }
  const currentTeam = await loadTeam(receipt.current_team_id)
  if (!forced && !(isTeamMember(currentTeam, actor) || isAdmin(actor))) {
    throw new EngineError('not_current_team_member', 403, `Only members of team "${currentTeam.name}" can reject`)
  }

  await closeApprovalTask(receipt.current_approval_task_key, 'rejected', actor, comment)

  const expected = {
    current_team_id: receipt.current_team_id,
    approval_cycle_id: receipt.approval_cycle_id
  }
  const history = Array.isArray(receipt.stage_history) ? [...receipt.stage_history] : []
  const idx = findOpenHistoryIndex(history, receipt.approval_cycle_id, currentTeam._key)
  if (idx >= 0) {
    history[idx] = closeHistoryEntry(history[idx], { resolution: 'rejected', comment, actor, forced, attachmentIds })
  }
  const updated = await casUpdateReceipt(receiptKey, expected, {
    status: STATUS_NEEDS_CHANGES,
    current_team_id: null,
    current_approval_task_key: null,
    stage_history: history,
    rejection_remark: comment,
    rejected_at: now(),
    rejected_by: actor?.sub || actor?._key || null,
    updated_at: now()
  })
  publishEvent({
    type: 'receipt.rejected',
    payload: {
      receipt_id: receiptKey,
      team_id: currentTeam._key,
      cycle_id: receipt.approval_cycle_id,
      comment,
      actor_id: actor?.sub || actor?._key,
      forced
    },
    actor, branch: receipt.branch || null
  })
  return { receipt: updated, task: null }
}

/**
 * Admin-only escape hatch. One of nextTeamId / complete / reject must be set.
 * Records `forced: true` on the resulting history entry and fires an activity
 * row on the current approval task.
 */
export async function adminOverride(receiptKey, actor, { nextTeamId = null, complete = false, reject = false, comment = '', attachmentIds = [] } = {}) {
  if (!isAdmin(actor)) throw new EngineError('forbidden', 403, 'Admin only')
  const flags = [!!nextTeamId, !!complete, !!reject].filter(Boolean).length
  if (flags !== 1) throw new EngineError('validation_error', 400, 'Specify exactly one of nextTeamId, complete, reject')

  let receipt = await loadReceipt(receiptKey)

  // Terminal receipt + override -> submit first so the next action has a current team.
  if (!receipt.current_team_id) {
    await submit(receiptKey, actor)
    receipt = await loadReceipt(receiptKey)
  }

  if (receipt.current_approval_task_key) {
    writeTaskActivity(receipt.current_approval_task_key, actor, 'admin_override', {
      nextTeamId: nextTeamId || null,
      complete: !!complete,
      reject: !!reject,
      comment: comment || null,
      attachment_ids: sanitizeAttachmentIds(attachmentIds)
    })
  }

  if (complete) return completeReceipt(receiptKey, actor, comment || 'admin completed', { forced: true, attachmentIds })
  if (reject) return rejectToCreator(receiptKey, actor, comment || 'admin rejected', { forced: true, attachmentIds })
  return routeToTeam(receiptKey, actor, nextTeamId, comment || 'admin routed', { attachmentIds })
}

// ---------------------------------------------------------------------------
// Validations
// ---------------------------------------------------------------------------

function validateNextTeam({ currentTeam, nextTeam, receipt }) {
  if (!nextTeam || nextTeam.is_active === false) {
    throw new EngineError('invalid_next_team', 400, 'Next team is missing or inactive')
  }
  if (nextTeam._key === currentTeam._key) {
    throw new EngineError('invalid_next_team', 400, 'Next team cannot be the same as the current team')
  }
  const alreadyApproved = new Set(receipt.approved_by_team_ids || [])
  if (alreadyApproved.has(nextTeam._key)) {
    throw new EngineError('invalid_next_team', 400, `Team "${nextTeam.name}" already approved this cycle`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOpenHistoryIndex(history, cycleId, teamKey) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h && h.cycle_id === cycleId && h.team_id === teamKey && !h.exited_at) return i
  }
  return -1
}

/**
 * Edit-lock rule (replaces the legacy `status !== 'Pending'` rule in receipts.js):
 *   - Draft / Needs Changes -> creator may edit freely.
 *   - Any other status      -> only admin may edit (and only with an audit reason; caller enforces the header check).
 */
export function isReceiptEditable(receipt, user) {
  if (!receipt || !user) return false
  if (isAdmin(user)) return true
  if (TERMINAL_STATUSES.has(receipt.status) && isCreator(receipt, user)) return true
  return false
}

export async function getReceiptHistory(receiptKey) {
  const receipt = await loadReceipt(receiptKey)
  let currentTeam = null
  let currentTask = null
  if (receipt.current_team_id) {
    try { currentTeam = await loadTeam(receipt.current_team_id) } catch { /* deleted */ }
  }
  if (receipt.current_approval_task_key) {
    try {
      const rows = await q('FOR t IN tasks FILTER t._key == @k LIMIT 1 RETURN t', { k: receipt.current_approval_task_key })
      currentTask = rows[0] || null
    } catch { /* ignore */ }
  }

  // Hydrate attachment_ids referenced by any history entry so the UI timeline
  // can render file chips without a second round-trip. Looks files up in
  // `receipt.files[]` (keyed by `id`) and enriches with uploader's display name.
  const filesArr = Array.isArray(receipt.files) ? receipt.files : []
  const filesById = new Map(filesArr.map((f) => [String(f.id), f]))
  const rawHistory = Array.isArray(receipt.stage_history) ? receipt.stage_history : []
  const allUploaderIds = [...new Set(filesArr.map((f) => f.uploaded_by).filter(Boolean).map(String))]
  let uploaderNameById = {}
  if (allUploaderIds.length) {
    try {
      const userRows = await q(
        'FOR u IN users FILTER u._key IN @ids RETURN { id: u._key, name: u.name, emp_code: u.emp_code }',
        { ids: allUploaderIds }
      )
      uploaderNameById = Object.fromEntries(userRows.map((u) => [String(u.id), u.name || u.emp_code || `User ${u.id}`]))
    } catch { /* best effort */ }
  }
  const hydrateIds = (ids) => (Array.isArray(ids) ? ids : []).map((fid) => {
    const f = filesById.get(String(fid))
    if (!f) return { id: String(fid), missing: true }
    return {
      id: String(f.id),
      original_name: f.original_name,
      filename: f.filename,
      file_size: f.file_size,
      mime_type: f.mime_type,
      uploaded_at: f.uploaded_at,
      uploaded_by: f.uploaded_by,
      uploaded_by_name: uploaderNameById[String(f.uploaded_by)] || null,
      cycle_id: f.cycle_id || null,
      team_id: f.team_id || null,
      team_name: f.team_name || null,
      uploaded_during: f.uploaded_during || null,
      url: `/api/receipts/${receipt._key}/media/${f.id}`
    }
  })
  const stage_history = rawHistory.map((ev) => ({
    ...ev,
    attachments: hydrateIds(ev.attachment_ids)
  }))

  return {
    receipt_id: receipt._key,
    status: receipt.status,
    approval_cycle_id: receipt.approval_cycle_id || null,
    current_team: currentTeam && { id: currentTeam._key, name: currentTeam.name },
    current_approval_task: currentTask,
    approved_by_team_ids: receipt.approved_by_team_ids || [],
    stage_history
  }
}

// Convenience mapping from EngineError.code -> HTTP status used by routes.
export const ENGINE_STATUS_BY_CODE = {
  receipt_not_found: 404,
  team_not_found: 404,
  forbidden: 403,
  not_current_team_member: 403,
  invalid_next_team: 400,
  no_intake_team_configured: 409,
  receipt_not_in_flight: 409,
  comment_required: 400,
  team_in_use: 409,
  stale_state: 409,
  validation_error: 400
}
