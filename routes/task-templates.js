// Task Templates CRUD + role-linked scheduler trigger.
//
// A template is a blueprint for creating one or more tasks on a schedule.
// Fields:
//   _key, name, description, enabled,
//   schedule: 'daily' | 'weekly' | 'monthly' | 'cron:<expr>',
//   roles:    ['cashier', 'manager', 'admin'],       // materialised per user in these roles
//   branches: ['CHEMBUR', ...],                      // optional branch filter
//   template: { ...same shape as automation template... },
//   lookahead_days: 1,                                // pre-create N days of instances
//   last_run_at: ISO,
//   next_run_at: ISO
//
// This file exposes CRUD for admins/managers and a `runDueTemplates()` function
// invoked by the scheduler in server.js.

import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { createTaskFromRule } from '../services/task-factory.js'

const router = express.Router()

function now() { return new Date().toISOString() }

function parseSchedule(schedule) {
  // Returns a function f(lastRunIso) -> nextRunIso.
  const s = String(schedule || '').trim()
  if (s === 'daily') return (last) => {
    const d = last ? new Date(last) : new Date()
    d.setDate(d.getDate() + 1); d.setHours(6, 0, 0, 0)
    return d.toISOString()
  }
  if (s === 'weekly') return (last) => {
    const d = last ? new Date(last) : new Date()
    d.setDate(d.getDate() + 7); d.setHours(9, 0, 0, 0)
    return d.toISOString()
  }
  if (s === 'monthly') return (last) => {
    const d = last ? new Date(last) : new Date()
    d.setMonth(d.getMonth() + 1); d.setHours(9, 0, 0, 0)
    return d.toISOString()
  }
  // cron: fall back to 24h cadence; a real cron parser can be added later.
  return (last) => new Date((last ? new Date(last) : new Date()).getTime() + 24 * 3600_000).toISOString()
}

router.get('/', requireAuth, requireRole(['admin', 'manager']), async (_req, res) => {
  try {
    const list = await q('FOR t IN task_templates SORT t.name RETURN t')
    res.json({ items: list })
  } catch (err) { res.status(500).json({ error: 'server_error', detail: err.message }) }
})

router.post('/', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const body = req.body || {}
    if (!body.name || !body.template) return res.status(400).json({ error: 'validation_error', detail: 'name and template are required' })
    const col = getCollection('task_templates')
    const doc = {
      name: String(body.name).trim(),
      description: body.description || null,
      enabled: body.enabled !== false,
      schedule: body.schedule || 'daily',
      roles: Array.isArray(body.roles) ? body.roles : [],
      branches: Array.isArray(body.branches) ? body.branches : [],
      template: body.template,
      lookahead_days: Number(body.lookahead_days) || 0,
      last_run_at: null,
      next_run_at: parseSchedule(body.schedule || 'daily')(null),
      created_at: now(),
      updated_at: now()
    }
    const saved = await col.save(doc)
    res.status(201).json({ _key: saved._key, ...doc })
  } catch (err) { res.status(500).json({ error: 'server_error', detail: err.message }) }
})

router.patch('/:id', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const col = getCollection('task_templates')
    const existing = await col.document(req.params.id).catch(() => null)
    if (!existing) return res.status(404).json({ error: 'not_found' })
    const patch = { ...req.body, updated_at: now() }
    if (patch.schedule && patch.schedule !== existing.schedule) {
      patch.next_run_at = parseSchedule(patch.schedule)(existing.last_run_at)
    }
    const upd = await col.update(req.params.id, patch, { returnNew: true })
    res.json(upd.new)
  } catch (err) { res.status(500).json({ error: 'server_error', detail: err.message }) }
})

router.delete('/:id', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const col = getCollection('task_templates')
    await col.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: 'server_error', detail: err.message }) }
})

router.post('/:id/run', requireAuth, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const col = getCollection('task_templates')
    const tpl = await col.document(req.params.id).catch(() => null)
    if (!tpl) return res.status(404).json({ error: 'not_found' })
    const created = await runTemplate(tpl)
    await col.update(tpl._key, { last_run_at: now(), next_run_at: parseSchedule(tpl.schedule)(now()), updated_at: now() })
    res.json({ ok: true, created })
  } catch (err) { res.status(500).json({ error: 'server_error', detail: err.message }) }
})

async function runTemplate(tpl) {
  const ctx = { rule: { _key: tpl._key, name: tpl.name }, event: { payload: {}, branch: null } }
  // Find the users this template should target.
  const users = await q(`
    FOR u IN users
      FILTER u.is_active != false
      ${Array.isArray(tpl.roles) && tpl.roles.length > 0 ? 'FILTER u.role IN @roles' : ''}
      ${Array.isArray(tpl.branches) && tpl.branches.length > 0 ? 'FILTER u.branch IN @branches' : ''}
      RETURN u
  `, { roles: tpl.roles || [], branches: tpl.branches || [] })

  let created = 0
  for (const u of users) {
    const scopedTemplate = {
      ...tpl.template,
      assignee_id: u._key,
      branch: u.branch || tpl.template.branch || null
    }
    try {
      await createTaskFromRule(scopedTemplate, { ...ctx, event: { payload: { user_id: u._key, branch: u.branch }, branch: u.branch } })
      created++
    } catch (err) {
      console.warn('[templates] create failed for', u.emp_code, err?.message)
    }
  }
  return created
}

/** Called by the scheduler: runs every template whose next_run_at is past. */
export async function runDueTemplates() {
  try {
    const due = await q(`
      FOR t IN task_templates
        FILTER t.enabled != false AND (t.next_run_at == null OR t.next_run_at <= @now)
        RETURN t
    `, { now: now() })
    if (!due.length) return { ran: 0, created: 0 }
    let totalCreated = 0
    const col = getCollection('task_templates')
    for (const tpl of due) {
      try {
        const n = await runTemplate(tpl)
        totalCreated += n
        await col.update(tpl._key, {
          last_run_at: now(),
          next_run_at: parseSchedule(tpl.schedule)(now()),
          updated_at: now()
        })
      } catch (err) {
        console.warn('[templates] template run failed', tpl.name, err?.message)
      }
    }
    if (totalCreated > 0) console.log(`[templates] ran ${due.length} template(s), created ${totalCreated} task(s)`)
    return { ran: due.length, created: totalCreated }
  } catch (err) {
    console.error('[templates] runDueTemplates failed:', err?.message)
    return { ran: 0, created: 0, error: err?.message }
  }
}

export default router
