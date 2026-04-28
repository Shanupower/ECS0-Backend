// Receipt-approval admin routes.
//
// Currently exposes the migration job endpoints used by System Settings to
// re-route existing in-flight receipts when the intake-team configuration
// changes (default team or per-category map).
//
// Endpoints (all admin-only, JSON):
//   POST /api/receipt-approvals/migration/preview   -> { total, will_move, already_correct, by_team, unresolved }
//   POST /api/receipt-approvals/migration/run       -> { job_id }
//   GET  /api/receipt-approvals/migration/run/:id   -> job snapshot

import express from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import {
  previewMigration,
  startMigrationJob,
  getJob,
  getActiveJobId
} from '../services/receipt-migration.js'

const router = express.Router()

// Pull only the keys we care about from arbitrary request bodies; ignores
// everything else so callers can safely send the full app-config draft if
// they want.
function pickIntakePatch(body = {}) {
  const patch = {}
  if (Object.prototype.hasOwnProperty.call(body, 'receipt_intake_team_id')) {
    patch.receipt_intake_team_id = body.receipt_intake_team_id || null
  }
  if (Object.prototype.hasOwnProperty.call(body, 'receipt_intake_teams_by_category')) {
    patch.receipt_intake_teams_by_category = body.receipt_intake_teams_by_category || {}
  }
  return patch
}

router.post('/migration/preview', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const patch = pickIntakePatch(req.body || {})
    const out = await previewMigration(patch)
    res.json(out)
  } catch (err) {
    console.error('[receipt-approvals] preview error:', err)
    res.status(500).json({ error: 'preview_failed', detail: err.message || String(err) })
  }
})

router.post('/migration/run', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const patch = pickIntakePatch(req.body || {})
    const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim()) || 'admin_intake_remap'
    const { job_id } = await startMigrationJob(patch, req.user, { reason })
    res.json({ job_id, started_at: new Date().toISOString() })
  } catch (err) {
    if (err?.code === 'migration_in_progress') {
      return res.status(409).json({
        error: 'migration_in_progress',
        detail: 'Another receipt-migration job is already running',
        active_job_id: err.active_job_id || getActiveJobId() || null
      })
    }
    console.error('[receipt-approvals] run error:', err)
    res.status(500).json({ error: 'run_failed', detail: err.message || String(err) })
  }
})

router.get('/migration/run/:jobId', requireAuth, requireRole('admin'), (req, res) => {
  const job = getJob(req.params.jobId)
  if (!job) return res.status(404).json({ error: 'job_not_found' })
  res.json(job)
})

export default router
