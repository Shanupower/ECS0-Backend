// Recurrence materializer: expands tasks with `recurrence_rule` (RRULE string
// or friendly phrase) into future instances up to a lookahead window.
//
// Strategy:
//   - A "series anchor" is any task where `recurrence_rule` is set AND
//     `recurrence_series_id` is null (or equals its own _key). On first sweep
//     we assign the anchor's _key as `recurrence_series_id` and materialise
//     the next occurrences within LOOKAHEAD_DAYS.
//   - Generated instances are inserted with `recurrence_series_id = anchor._key`
//     and `source = 'recurrence'`. They inherit assignee, priority, labels,
//     checklist template, and entity links from the anchor.
//   - Duplicate protection: we upsert by (series_id, due_date). If an instance
//     already exists for the same day we skip creation.
//
// The sweep is idempotent and safe to run every hour.

// rrule ships a CJS-only entry in package.json's `main`, so Node's ESM loader
// only exposes a default export. Pull `RRule` off the default to stay compatible.
import rrulePkg from 'rrule'
const { RRule } = rrulePkg
import { q, getCollection } from '../config/database.js'

const LOOKAHEAD_DAYS = 7

function now() { return new Date().toISOString() }
function ymd(d) { return d.toISOString().slice(0, 10) }

// Turn a user-friendly phrase like "every monday" or "every 2 weeks" into an
// RRULE string. Falls through when the input already looks like an RFC 5545
// rrule (has FREQ= marker).
function toRRuleString(input) {
  if (!input) return null
  const s = String(input).trim()
  if (/FREQ=/i.test(s)) return s
  const lower = s.toLowerCase()
  const dayMap = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' }

  let m = lower.match(/^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/)
  if (m) return `FREQ=WEEKLY;BYDAY=${dayMap[m[1]]}`
  m = lower.match(/^every\s+weekday$/)
  if (m) return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  m = lower.match(/^every\s+weekend$/)
  if (m) return 'FREQ=WEEKLY;BYDAY=SA,SU'
  m = lower.match(/^every\s+(day|week|month|year)$/)
  if (m) return `FREQ=${({ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' })[m[1]]}`
  m = lower.match(/^every\s+(\d+)\s+(days?|weeks?|months?|years?)$/)
  if (m) {
    const freq = { day: 'DAILY', days: 'DAILY', week: 'WEEKLY', weeks: 'WEEKLY', month: 'MONTHLY', months: 'MONTHLY', year: 'YEARLY', years: 'YEARLY' }[m[2]]
    return `FREQ=${freq};INTERVAL=${m[1]}`
  }
  return null
}

function expandDates(ruleStr, anchorDate, windowDays) {
  try {
    const rule = RRule.fromString('DTSTART:' + new Date(anchorDate + 'T00:00:00Z').toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z\nRRULE:' + ruleStr)
    const from = new Date()
    const to = new Date(from.getTime() + windowDays * 86_400_000)
    return rule.between(from, to, true)
  } catch (err) {
    // Fallback for DTSTART-less rules.
    try {
      const rule = RRule.fromString(ruleStr)
      const from = new Date()
      const to = new Date(from.getTime() + windowDays * 86_400_000)
      return rule.between(from, to, true)
    } catch {
      return []
    }
  }
}

export async function runRecurrenceSweep({ lookaheadDays = LOOKAHEAD_DAYS } = {}) {
  const tasksCol = getCollection('tasks')
  // Find active anchors. An anchor is any non-archived task with a rule
  // whose series points to itself (or is missing).
  const anchors = await q(`
    FOR t IN tasks
      FILTER t.recurrence_rule != null AND t.archived_at == null
      FILTER t.recurrence_series_id == null OR t.recurrence_series_id == t._key
      RETURN t
  `)

  let created = 0
  for (const anchor of anchors) {
    const ruleStr = toRRuleString(anchor.recurrence_rule)
    if (!ruleStr) continue

    // Self-assign series id if missing.
    if (!anchor.recurrence_series_id) {
      await tasksCol.update(anchor._key, { recurrence_series_id: anchor._key, updated_at: now() })
      anchor.recurrence_series_id = anchor._key
    }

    const baseDate = anchor.due_date || anchor.start_date || ymd(new Date())
    const dates = expandDates(ruleStr, baseDate, lookaheadDays)
    if (!dates.length) continue

    // Existing instances for de-dup (by due_date within this series).
    const existing = await q(`
      FOR t IN tasks
        FILTER t.recurrence_series_id == @sid AND t._key != @sid
        RETURN t.due_date
    `, { sid: anchor._key })
    const existingSet = new Set(existing.filter(Boolean))

    for (const d of dates) {
      const dueYmd = ymd(d)
      if (dueYmd === baseDate) continue // anchor already covers this
      if (existingSet.has(dueYmd)) continue
      const doc = {
        title: anchor.title,
        description: anchor.description,
        status: 'todo',
        priority: anchor.priority || 'p2',
        labels: Array.isArray(anchor.labels) ? [...anchor.labels] : [],
        assignee_id: anchor.assignee_id,
        assignee_emp_code: anchor.assignee_emp_code,
        assigned_by_id: anchor.assigned_by_id,
        assigned_by_emp_code: anchor.assigned_by_emp_code,
        branch: anchor.branch,
        start_date: null,
        due_date: dueYmd,
        scheduled_date: null,
        completed_at: null,
        parent_task_id: null,
        estimate_minutes: anchor.estimate_minutes ?? null,
        checklist: Array.isArray(anchor.checklist) ? anchor.checklist.map(c => ({ text: c.text, done: false })) : [],
        watchers: Array.isArray(anchor.watchers) ? [...anchor.watchers] : [],
        customer_id: anchor.customer_id || null,
        lead_id: anchor.lead_id || null,
        receipt_id: anchor.receipt_id || null,
        loan_id: anchor.loan_id || null,
        related_entities: Array.isArray(anchor.related_entities) ? anchor.related_entities : [],
        recurrence_rule: null,
        recurrence_series_id: anchor._key,
        sla_tier: anchor.sla_tier || null,
        sla_breached_at: null,
        custom_fields: anchor.custom_fields || {},
        source: 'recurrence',
        source_rule_id: null,
        archived_at: null,
        created_at: now(),
        updated_at: now()
      }
      try {
        await tasksCol.save(doc)
        created++
      } catch (err) {
        console.warn('[recurrence] failed to materialise instance:', err?.message)
      }
    }
  }
  if (created > 0) console.log(`[recurrence] materialised ${created} future task instance(s) across ${anchors.length} series`)
  return { anchors: anchors.length, created }
}
