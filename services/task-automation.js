// Automation rule engine.
//
// Rule shape (stored in `task_automations` or inline in app_config.task_event_rules):
//   {
//     _key, name, enabled,
//     trigger: 'lead.created' | 'receipt.created' | 'task.created' | ...
//     conditions: [{ field, op, value }],          // AND-joined, dot-path fields against event.payload
//     actions: [
//       { type: 'create_task', template: { title, priority, status, labels, assignee_id, due_in_days, sla_tier, ... } },
//       { type: 'notify', channel: 'in_app', target: 'assignee' | 'watchers' | 'user_id', message: '...' },
//       { type: 'set_field', target_task_key_from: 'payload.task_key', patch: { priority: 'p0' } }
//     ],
//     cooldown_seconds?: number
//   }
//
// Conditions ops: eq, neq, gt, gte, lt, lte, in, contains, exists
//
// Telemetry: every fired rule appends a row to `task_automations` (not the
// rules themselves — we reuse the `task_activities` collection so every event
// produces a searchable audit record).

import { q, getCollection } from '../config/database.js'
import { getAppConfig } from '../routes/app-config.js'
import { subscribe, publishEvent } from './task-events.js'
import { createTaskFromRule } from './task-factory.js'

const ruleCooldown = new Map() // key = rule._key + ':' + entityKey -> unix ts

function getPath(obj, path) {
  if (!obj || !path) return undefined
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
}

function evaluateConditions(conds, event) {
  if (!Array.isArray(conds) || conds.length === 0) return true
  for (const c of conds) {
    if (!c || !c.field) continue
    const actual = getPath(event, c.field)
    const value = c.value
    const op = c.op || 'eq'
    switch (op) {
      case 'eq':      if (actual !== value) return false; break
      case 'neq':     if (actual === value) return false; break
      case 'gt':      if (!(Number(actual) > Number(value))) return false; break
      case 'gte':     if (!(Number(actual) >= Number(value))) return false; break
      case 'lt':      if (!(Number(actual) < Number(value))) return false; break
      case 'lte':     if (!(Number(actual) <= Number(value))) return false; break
      case 'in':      if (!Array.isArray(value) || !value.includes(actual)) return false; break
      case 'contains':if (!String(actual || '').toLowerCase().includes(String(value).toLowerCase())) return false; break
      case 'exists':  if ((actual == null) === !!value) return false; break
      default: return false
    }
  }
  return true
}

function normaliseSeededRule(r) {
  // Seeded rules in app-config use `event` + `template` + assignee_strategy/priority/sla_tier.
  // Wrap them into the generic rule shape the engine understands (trigger + actions).
  if (!r) return null
  if (r.actions && r.trigger) return r
  const trigger = r.trigger || r.event
  if (!trigger) return null
  const actions = []
  if (r.template) {
    actions.push({
      type: 'create_task',
      template: {
        ...r.template,
        priority: r.priority || r.template.priority,
        sla_tier: r.sla_tier || r.template.sla_tier,
        labels: r.template.labels || (r.label ? [r.label] : []),
        assignee_strategy: r.assignee_strategy || r.template.assignee_strategy,
        assignee_id: r.assignee_id || r.template.assignee_id
      }
    })
  }
  return {
    _key: r.key || r._key,
    name: r.label || r.name,
    enabled: r.enabled !== false,
    trigger,
    conditions: r.conditions || [],
    actions,
    cooldown_seconds: r.cooldown_seconds
  }
}

async function getActiveRules(triggerType) {
  // Merge DB rules with app-config seeded rules.
  const cfg = await getAppConfig()
  const seededRaw = Array.isArray(cfg?.task_event_rules) ? cfg.task_event_rules : []
  const seeded = seededRaw.map(normaliseSeededRule).filter(Boolean).filter(r => r.enabled !== false && r.trigger === triggerType)
  let stored = []
  try {
    stored = await q('FOR r IN task_automations FILTER r.enabled != false AND r.trigger == @t RETURN r', { t: triggerType })
  } catch { /* collection may not exist yet */ }
  return [...seeded, ...stored]
}

async function logFiring(rule, event, actions) {
  try {
    const activities = getCollection('task_activities')
    await activities.save({
      type: 'automation.fired',
      rule_id: rule._key || rule.name || null,
      rule_name: rule.name || null,
      trigger: rule.trigger,
      event_type: event.type,
      branch: event.branch || null,
      actions_count: Array.isArray(actions) ? actions.length : 0,
      created_at: new Date().toISOString()
    }).catch(() => null)
  } catch { /* noop */ }
}

async function runAction(action, rule, event) {
  if (!action) return
  switch (action.type) {
    case 'create_task': {
      await createTaskFromRule(action.template || {}, { rule, event })
      break
    }
    case 'notify': {
      // Persist into notifications collection (in-app). Channel adapters
      // (whatsapp/email/sms) can be added later as additional fanouts.
      const col = getCollection('notifications')
      const recipients = []
      if (action.target === 'assignee' && event.payload?.assignee_id) recipients.push(event.payload.assignee_id)
      else if (action.target === 'watchers' && Array.isArray(event.payload?.watchers)) recipients.push(...event.payload.watchers)
      else if (action.target && typeof action.target === 'string' && action.target !== 'assignee' && action.target !== 'watchers') recipients.push(action.target)
      for (const uid of recipients) {
        try {
          await col.save({
            user_id: uid,
            channel: action.channel || 'in_app',
            title: action.title || rule.name || 'Automation',
            body: action.message || '',
            data: { event, rule: rule._key || rule.name },
            created_at: new Date().toISOString(),
            read_at: null
          })
        } catch { /* noop */ }
      }
      break
    }
    case 'set_field': {
      const key = getPath(event, action.target_task_key_from) || event.payload?.task_key
      if (!key || !action.patch) return
      try {
        const col = getCollection('tasks')
        await col.update(key, { ...action.patch, updated_at: new Date().toISOString() })
      } catch { /* noop */ }
      break
    }
    default:
      // Unknown action types are ignored so future extensions don't break old data.
      break
  }
}

/**
 * Subscribe the engine to the event bus. Call once during boot.
 * Returns an unsubscribe function for tests.
 */
export function startAutomationEngine() {
  return subscribe(async (event) => {
    const rules = await getActiveRules(event.type)
    for (const rule of rules) {
      if (!evaluateConditions(rule.conditions, event)) continue

      // Cooldown protects against burst triggers (e.g. 200 receipts in 1 min).
      if (rule.cooldown_seconds) {
        const dedupeKey = `${rule._key || rule.name}:${event.payload?.customer_id || event.payload?.lead_id || event.payload?.task_key || ''}`
        const last = ruleCooldown.get(dedupeKey) || 0
        const nowTs = Date.now()
        if (nowTs - last < rule.cooldown_seconds * 1000) continue
        ruleCooldown.set(dedupeKey, nowTs)
      }

      const actions = Array.isArray(rule.actions) ? rule.actions : []
      for (const a of actions) {
        try { await runAction(a, rule, event) }
        catch (err) { console.warn('[automation] action failed:', err?.message) }
      }
      await logFiring(rule, event, actions)
    }
  })
}
