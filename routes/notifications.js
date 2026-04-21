// In-app notifications.
//
// Collection shape (created in config/tasks-collections.js):
//   { _key, user_id, channel: 'in_app' | 'whatsapp' | 'email' | 'sms',
//     title, body, data, created_at, read_at }
//
// Channel adapters beyond in_app are stubbed (pluggable later).

import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

async function ensureCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('notifications')
  if (!(await col.exists())) await col.create()
}

function currentUserId(user) {
  return user?.sub || user?.id || user?._key || null
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureCollection()
    const uid = currentUserId(req.user)
    if (!uid) return res.json({ items: [], unread: 0 })
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))
    const onlyUnread = req.query.unread === '1' || req.query.unread === 'true'
    const items = await q(`
      FOR n IN notifications
        FILTER n.user_id == @uid
        ${onlyUnread ? 'FILTER n.read_at == null' : ''}
        SORT n.created_at DESC
        LIMIT @limit
        RETURN n
    `, { uid, limit })
    const unread = (await q(`
      FOR n IN notifications FILTER n.user_id == @uid AND n.read_at == null COLLECT WITH COUNT INTO c RETURN c
    `, { uid }))[0] || 0
    res.json({ items, unread })
  } catch (error) {
    console.error('notifications list error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/mark-read', requireAuth, async (req, res) => {
  try {
    await ensureCollection()
    const uid = currentUserId(req.user)
    const { ids } = req.body || {}
    const nowIso = new Date().toISOString()
    if (Array.isArray(ids) && ids.length) {
      await q(`
        FOR n IN notifications FILTER n._key IN @ids AND n.user_id == @uid
          UPDATE n WITH { read_at: @t } IN notifications
      `, { ids, uid, t: nowIso })
    } else {
      await q(`
        FOR n IN notifications FILTER n.user_id == @uid AND n.read_at == null
          UPDATE n WITH { read_at: @t } IN notifications
      `, { uid, t: nowIso })
    }
    res.json({ ok: true })
  } catch (error) {
    console.error('notifications mark-read error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await ensureCollection()
    const uid = currentUserId(req.user)
    const rows = await q('FOR n IN notifications FILTER n._key == @k AND n.user_id == @uid LIMIT 1 RETURN n._key', { k: req.params.id, uid })
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    await getCollection('notifications').remove(req.params.id)
    res.json({ ok: true })
  } catch (error) {
    console.error('notifications delete error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
