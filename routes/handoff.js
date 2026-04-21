// Shift hand-off workflow.
//
// A hand-off is a lightweight document created by a user (typically at
// end-of-day) that hands their open, unfinished tasks over to another user
// (usually the next-shift cashier or branch manager). The recipient sees a
// banner on login until they acknowledge.

import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

async function ensureCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('handoffs')
  if (!(await col.exists())) await col.create()
  try { await col.ensureIndex({ type: 'persistent', fields: ['to_user_id', 'acknowledged_at'] }) } catch {}
  try { await col.ensureIndex({ type: 'persistent', fields: ['from_user_id', 'created_at'] }) } catch {}
  return col
}

function uid(user) { return user?.sub || user?.id || user?._key || null }

// Create a hand-off from current user -> someone else.
// Body: { to_user_id, task_ids[], note, branch }
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureCollection()
    const me = req.user
    const { to_user_id, task_ids = [], note = '', branch = null } = req.body || {}
    if (!to_user_id) return res.status(400).json({ error: 'validation_error', detail: 'to_user_id required' })

    // Snapshot the tasks so the hand-off is stable even if tasks move later.
    let snapshot = []
    if (Array.isArray(task_ids) && task_ids.length) {
      snapshot = await q(`
        FOR t IN tasks FILTER t._key IN @ids
        RETURN { id: t._key, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, customer_id: t.customer_id, receipt_id: t.receipt_id }
      `, { ids: task_ids })
    }

    const doc = {
      from_user_id: uid(me),
      from_emp_code: me?.emp_code || null,
      from_name: me?.name || null,
      to_user_id,
      branch,
      note: String(note || ''),
      task_ids: snapshot.map(s => s.id),
      tasks_snapshot: snapshot,
      created_at: new Date().toISOString(),
      acknowledged_at: null,
      acknowledged_by: null
    }
    const result = await getCollection('handoffs').save(doc)

    // Drop a notification for the recipient if the table exists.
    try {
      const notifCol = getCollection('notifications')
      await notifCol.save({
        user_id: to_user_id,
        channel: 'in_app',
        title: `Shift hand-off from ${me?.name || me?.emp_code || 'teammate'}`,
        body: snapshot.length ? `${snapshot.length} open task(s) handed to you.` : (note || 'Hand-off received.'),
        data: { handoff_id: result._key },
        created_at: new Date().toISOString(),
        read_at: null
      })
    } catch { /* notifications collection may not exist yet */ }

    res.status(201).json({ id: result._key, ...doc })
  } catch (error) {
    console.error('handoff create error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Inbox: pending hand-offs for the current user.
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    await ensureCollection()
    const me = uid(req.user)
    if (!me) return res.json({ items: [], pending: 0 })
    const items = await q(`
      FOR h IN handoffs FILTER h.to_user_id == @me AND h.acknowledged_at == null
        SORT h.created_at DESC
        LIMIT 50
        RETURN h
    `, { me })
    res.json({ items, pending: items.length })
  } catch (error) {
    console.error('handoff inbox error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Acknowledge a hand-off.
router.post('/:id/acknowledge', requireAuth, async (req, res) => {
  try {
    await ensureCollection()
    const me = uid(req.user)
    const rows = await q('FOR h IN handoffs FILTER h._key == @k LIMIT 1 RETURN h', { k: req.params.id })
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    if (rows[0].to_user_id !== me && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' })
    const patch = { acknowledged_at: new Date().toISOString(), acknowledged_by: me }
    await getCollection('handoffs').update(req.params.id, patch)
    res.json({ ok: true, ...patch })
  } catch (error) {
    console.error('handoff ack error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Helper to assemble a suggested EOD hand-off list (open tasks owned by current user).
router.get('/suggest-eod', requireAuth, async (req, res) => {
  try {
    const me = req.user
    const myId = uid(me)
    const tasks = await q(`
      FOR t IN tasks
        FILTER (t.assignee_id == @me OR t.assignee_emp_code == @emp)
          AND t.status NOT IN ['done', 'cancelled']
          AND t.archived_at == null
        SORT t.priority ASC, t.due_date ASC
        LIMIT 40
        RETURN t
    `, { me: myId, emp: me?.emp_code || '' })
    res.json({ items: tasks })
  } catch (error) {
    console.error('handoff suggest-eod error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
