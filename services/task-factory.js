// Helper to create tasks from templates/rules. Accepts a template object
// (fields referenced via {{payload.X}} get interpolated from the event payload)
// and saves a new task document that matches the shape expected by routes/tasks.js.
//
// Intentionally lives outside routes/tasks.js to avoid circular imports with
// the automation engine.

import { q, getCollection } from '../config/database.js'

function now() { return new Date().toISOString() }
function today() { return now().slice(0, 10) }

function interpolate(val, ctx) {
  if (typeof val !== 'string') return val
  return val.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), ctx)
    return v == null ? '' : String(v)
  })
}

function addDaysYmd(days) {
  const d = new Date()
  d.setDate(d.getDate() + Number(days || 0))
  return d.toISOString().slice(0, 10)
}

function addHoursIso(hours) {
  const d = new Date()
  d.setHours(d.getHours() + Number(hours || 0))
  return d.toISOString().slice(0, 10)
}

async function resolveAssigneeByStrategy(strategy, ctx) {
  if (!strategy) return null
  const payload = ctx.payload || {}
  if (strategy === 'event.assignee_id') return payload.assignee_id || null
  if (strategy === 'event.actor_id') return ctx.actor?.id || null
  if (strategy === 'fixed') return null // handled by direct assignee_id on template
  if (strategy === 'branch_manager') {
    const branch = payload.branch || payload.branch_code || null
    if (!branch) return null
    try {
      const rows = await q(`
        FOR u IN users
          FILTER u.role == 'manager' AND (u.branch == @b OR u.branch_code == @b)
          LIMIT 1
          RETURN u._key
      `, { b: String(branch) })
      return rows[0] || null
    } catch { return null }
  }
  if (strategy === 'round_robin') {
    const branch = payload.branch || payload.branch_code || null
    try {
      const rows = await q(`
        FOR u IN users
          FILTER u.is_active != false AND (u.branch == @b OR u.branch_code == @b)
          SORT RAND()
          LIMIT 1
          RETURN u._key
      `, { b: String(branch || '') })
      return rows[0] || null
    } catch { return null }
  }
  return null
}

/**
 * @param template - Task template fields (title, priority, status, labels, due_in_days,
 *                   assignee_from_field, sla_tier, checklist_template, description,
 *                   customer_id_from, lead_id_from, receipt_id_from)
 * @param context  - { rule, event } context from the automation engine
 */
export async function createTaskFromRule(template, context) {
  if (!template || !template.title) return null
  const { event, rule } = context || {}
  const ctx = { payload: event?.payload || {}, actor: event?.actor, rule }

  const assigneeFromField = template.assignee_from_field
  let assigneeId = template.assignee_id ? interpolate(template.assignee_id, ctx) : null
  let assigneeEmpCode = null
  if (!assigneeId && assigneeFromField) {
    const v = assigneeFromField.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), ctx)
    if (v) assigneeId = v
  }
  if (!assigneeId && template.assignee_strategy) {
    assigneeId = await resolveAssigneeByStrategy(template.assignee_strategy, ctx)
  }

  if (assigneeId) {
    try {
      const matched = await q(`
        FOR u IN users
          FILTER u._key == @v OR u.emp_code == @v
          LIMIT 1
          RETURN u
      `, { v: String(assigneeId) })
      if (matched[0]) {
        assigneeId = matched[0]._key
        assigneeEmpCode = matched[0].emp_code || null
      }
    } catch { /* best-effort */ }
  }

  const doc = {
    title: interpolate(template.title, ctx),
    description: template.description ? interpolate(template.description, ctx) : null,
    status: template.status || 'todo',
    priority: template.priority || 'p2',
    labels: Array.isArray(template.labels) ? template.labels.slice() : [],
    assignee_id: assigneeId,
    assignee_emp_code: assigneeEmpCode,
    assigned_by_id: 'system',
    assigned_by_emp_code: 'SYSTEM',
    branch: event?.branch || template.branch || null,
    start_date: null,
    due_date: template.due_in_hours != null
      ? addHoursIso(template.due_in_hours)
      : (template.due_in_days != null
          ? addDaysYmd(template.due_in_days)
          : (template.due_on ? interpolate(template.due_on, ctx) : (template.due_date || null))),
    scheduled_date: null,
    completed_at: null,
    parent_task_id: null,
    estimate_minutes: Number.isFinite(Number(template.estimate_minutes)) ? Number(template.estimate_minutes) : null,
    checklist: Array.isArray(template.checklist_template)
      ? template.checklist_template.map(t => ({ text: interpolate(t, ctx), done: false }))
      : [],
    watchers: [],
    customer_id: template.customer_id_from ? interpolate(`{{${template.customer_id_from}}}`, ctx) || null : (template.customer_id ? (interpolate(template.customer_id, ctx) || null) : null),
    lead_id: template.lead_id_from ? interpolate(`{{${template.lead_id_from}}}`, ctx) || null : (template.lead_id ? (interpolate(template.lead_id, ctx) || null) : null),
    receipt_id: template.receipt_id_from ? interpolate(`{{${template.receipt_id_from}}}`, ctx) || null : (template.receipt_id ? (interpolate(template.receipt_id, ctx) || null) : null),
    loan_id: template.loan_id_from ? interpolate(`{{${template.loan_id_from}}}`, ctx) || null : (template.loan_id ? (interpolate(template.loan_id, ctx) || null) : null),
    related_entities: [],
    recurrence_rule: template.recurrence_rule || null,
    recurrence_series_id: null,
    sla_tier: template.sla_tier || null,
    sla_breached_at: null,
    custom_fields: template.custom_fields || {},
    source: template.source || 'automation',
    source_rule_id: rule?._key || rule?.name || null,
    archived_at: null,
    created_at: now(),
    updated_at: now()
  }

  const col = getCollection('tasks')
  const saved = await col.save(doc)
  return { _key: saved._key, ...doc }
}
