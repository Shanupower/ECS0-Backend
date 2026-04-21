import express from 'express'
import { q, getCollection, getUserBranch } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

const AUDIT_COLLECTION = 'branch_audit_events'

async function ensureAuditCollection() {
  const col = getCollection(AUDIT_COLLECTION)
  try {
    const exists = await col.exists()
    if (!exists) {
      await col.create()
    }
  } catch (e) {
    // If creation is blocked due to permissions, reads/writes will fail later with a clear error.
    console.error('[Audit] ensureAuditCollection failed:', e?.message || e)
  }
  return col
}

async function resolveBranchRefForCaller(req) {
  const role = req.user?.role
  if (role === 'manager') {
    const fromToken = req.user?.branch_code != null && String(req.user.branch_code).trim() !== '' ? String(req.user.branch_code).trim() : null
    if (fromToken) return fromToken
    const fromDb = await getUserBranch(req.user.sub)
    return fromDb ? String(fromDb).trim() : null
  }
  if (role === 'admin') {
    const qBranch = req.query.branch_code || req.query.branch
    if (qBranch != null && String(qBranch).trim() !== '') return String(qBranch).trim()
    return null
  }
  return null
}

// GET /api/audit/branch
// - manager: returns audit events for caller's branch
// - admin: requires ?branch_code=... (or ?branch=...) to scope results
router.get('/branch', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role
    if (!(role === 'admin' || role === 'manager')) {
      return res.status(403).json({ error: 'forbidden' })
    }

    const branchRef = await resolveBranchRefForCaller(req)
    if (!branchRef) {
      return res.status(400).json({
        error: 'validation_error',
        detail: role === 'admin' ? 'branch_code is required for admin audit queries' : 'Branch is not set for this manager'
      })
    }

    const limitRaw = req.query.limit != null ? Number(req.query.limit) : 50
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50

    // Ensure collection exists (best effort).
    await ensureAuditCollection()

    const items = await q(
      `
      FOR ev IN ${AUDIT_COLLECTION}
        FILTER LOWER(TRIM(TO_STRING(ev.branch_code))) == LOWER(TRIM(@branch_code))
        SORT ev.created_at DESC
        LIMIT @limit
        RETURN MERGE(
          { id: ev._key },
          UNSET(ev, "_id", "_key", "_rev")
        )
    `,
      { branch_code: branchRef, limit }
    )

    res.json(items)
  } catch (e) {
    console.error('[Audit] fetch error:', e)
    res.status(500).json({ error: 'server_error', detail: 'Failed to fetch audit events' })
  }
})

export default router

