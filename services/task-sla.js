// SLA breach sweep: finds tasks that have a `sla_tier` configured but are
// still open past their SLA window, and stamps them with `sla_breached_at`.
//
// SLA tier definitions live in app_config.task_sla_tiers:
//   [{ key, label, p0_hours, p1_hours, p2_hours, p3_hours, respond_hours? }]
//
// The due-by clock starts at `created_at`. A task is "breached" when:
//   - now() - created_at >= window_hours(tier, priority)
//   - status is not `done` or `cancelled`
//   - `sla_breached_at` is null
//
// We also escalate by creating an optional `sla_breaches` record so analytics
// can show historical breach counts. Escalation side-effects (notifications,
// auto-reassign) are emitted as a domain event for subscribers to handle.

import { q, getCollection } from '../config/database.js'
import { getAppConfig } from '../routes/app-config.js'
import { publishEvent } from './task-events.js'

function hoursBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  return ms / 3_600_000
}

function windowHoursFor(tier, priority) {
  if (!tier) return null
  const key = { p0: 'p0_hours', p1: 'p1_hours', p2: 'p2_hours', p3: 'p3_hours' }[priority || 'p2']
  const v = key ? Number(tier[key]) : null
  return Number.isFinite(v) ? v : null
}

export async function runSlaBreachSweep() {
  const cfg = await getAppConfig()
  const tiers = new Map((cfg?.task_sla_tiers || []).map(t => [t.key, t]))
  if (tiers.size === 0) return { checked: 0, breached: 0 }

  const candidates = await q(`
    FOR t IN tasks
      FILTER t.sla_tier != null AND t.sla_breached_at == null AND t.archived_at == null
      FILTER t.status != "done" AND t.status != "cancelled"
      RETURN t
  `)

  const tasksCol = getCollection('tasks')
  const breachesCol = getCollection('sla_breaches')
  const nowIso = new Date().toISOString()
  let breached = 0

  for (const task of candidates) {
    const tier = tiers.get(task.sla_tier)
    const windowH = windowHoursFor(tier, task.priority)
    if (!windowH) continue
    const elapsed = hoursBetween(task.created_at || nowIso, nowIso)
    if (elapsed < windowH) continue

    try {
      await tasksCol.update(task._key, { sla_breached_at: nowIso, updated_at: nowIso })
      await breachesCol.save({
        task_key: task._key,
        tier: task.sla_tier,
        priority: task.priority,
        branch: task.branch,
        assignee_id: task.assignee_id,
        breached_at: nowIso,
        elapsed_hours: Math.round(elapsed * 10) / 10,
        window_hours: windowH
      }).catch(() => null)
      breached++
      publishEvent({
        type: 'task.sla.breached',
        payload: { task_key: task._key, tier: task.sla_tier, priority: task.priority, elapsed_hours: elapsed, window_hours: windowH },
        branch: task.branch
      })
    } catch (err) {
      console.warn('[sla] failed to mark breach for', task._key, err?.message)
    }
  }
  if (breached > 0) console.log(`[sla] ${breached} breach(es) recorded (checked ${candidates.length})`)
  return { checked: candidates.length, breached }
}
