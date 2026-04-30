// Receipt approval-workflow migration service.
//
// Purpose: when an admin edits the intake-team configuration in System
// Settings (default intake team and/or per-category map), recompute which
// receipts should be moved to which team and run a background job that
// actually moves them by calling
// `receiptStageEngine.forceMoveToTeam(...)` for each one.
//
// Public surface (all async unless noted):
//   previewMigration(cfgPatch)                  -> { total, will_move, already_correct, by_team, unresolved }
//   startMigrationJob(cfgPatch, actor, opts?)   -> { job_id }   (also throws 409 if a job is already running)
//   getJob(jobId)                                                (sync) -> snapshot or null
//
// Storage: jobs live in-memory (single PM2 process is sufficient for Dev).
// Last 50 jobs are retained; older jobs are pruned on each new run. PM2
// restarts during a job will lose the job; the frontend handles 404 with a
// "migration interrupted" message.

import { q } from '../config/database.js'
import { getAppConfig } from '../routes/app-config.js'
import { forceMoveToTeam, receiptProductCategory } from './receipt-stage-engine.js'

const BATCH_SIZE = 50
const MAX_RETAINED_ERRORS = 50
const MAX_RETAINED_JOBS = 50
const DEFAULT_FINAL_LABEL = 'Completed'
const STATUS_NEEDS_CHANGES = 'Needs Changes'
const STATUS_DRAFT = 'Draft'

const jobs = new Map() // jobId -> snapshot
let activeJobId = null

function newJobId() {
  return `mig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function pruneOldJobs() {
  if (jobs.size <= MAX_RETAINED_JOBS) return
  const sorted = [...jobs.entries()].sort((a, b) => (a[1].started_at || '').localeCompare(b[1].started_at || ''))
  const drop = sorted.length - MAX_RETAINED_JOBS
  for (let i = 0; i < drop; i++) {
    if (sorted[i][0] !== activeJobId) jobs.delete(sorted[i][0])
  }
}

// Apply caller-provided patch on top of the live config so we can reason
// about what intake assignments WOULD look like once the admin saves.
function applyPatch(cfg, patch) {
  if (!patch || typeof patch !== 'object') return cfg
  const next = { ...cfg }
  if ('receipt_intake_team_id' in patch) {
    next.receipt_intake_team_id = patch.receipt_intake_team_id || null
  }
  if ('receipt_intake_teams_by_category' in patch
    && patch.receipt_intake_teams_by_category
    && typeof patch.receipt_intake_teams_by_category === 'object') {
    // Normalize: drop blank values so unset categories fall back to default.
    const map = {}
    for (const [k, v] of Object.entries(patch.receipt_intake_teams_by_category)) {
      const id = v == null ? '' : String(v).trim()
      if (id) map[String(k).trim().toUpperCase()] = id
    }
    next.receipt_intake_teams_by_category = map
  }
  return next
}

/**
 * Compute the would-be intake team for a receipt against an arbitrary cfg.
 * Mirrors the resolution semantics of receipt-stage-engine.resolveIntakeTeam,
 * but is pure (no team-active validation) so the preview can stay fast.
 *
 * Returns { teamId | null, reason: 'category' | 'ncd_fallback' | 'default' | 'unresolved' }
 */
function resolveIntakeFromCfg(receipt, cfg) {
  const map = (cfg?.receipt_intake_teams_by_category && typeof cfg.receipt_intake_teams_by_category === 'object')
    ? cfg.receipt_intake_teams_by_category
    : {}
  const cat = receiptProductCategory(receipt)
  if (cat && map[cat]) return { teamId: String(map[cat]).trim(), reason: 'category' }
  if (cat === 'NCD' && map.BOND) return { teamId: String(map.BOND).trim(), reason: 'ncd_fallback' }
  const fallback = cfg?.receipt_intake_team_id ? String(cfg.receipt_intake_team_id).trim() : ''
  if (fallback) return { teamId: fallback, reason: 'default' }
  return { teamId: null, reason: 'unresolved' }
}

// Receipts in these statuses are not eligible for forced moves. Final label
// is configurable; Draft is excluded because draft receipts haven't been
// submitted yet and aren't really "in flight".
function buildTerminalStatusSet(cfg) {
  const finalLabel = cfg?.receipt_final_status_label || DEFAULT_FINAL_LABEL
  return new Set([finalLabel, STATUS_NEEDS_CHANGES, STATUS_DRAFT])
}

async function loadCandidateReceipts(cfg) {
  const terminal = [...buildTerminalStatusSet(cfg)]
  return q(`
    FOR r IN receipts
      FILTER r.status NOT IN @terminal
      RETURN {
        _key: r._key,
        status: r.status,
        current_team_id: r.current_team_id,
        product: r.product,
        product_category: r.product_category,
        branch: r.branch
      }
  `, { terminal })
}

// Look up team docs in bulk so we can show team names in the preview / job.
async function loadTeamMap(teamIds) {
  const ids = [...new Set(teamIds.filter(Boolean).map(String))]
  if (!ids.length) return new Map()
  const rows = await q(
    'FOR t IN teams FILTER t._key IN @ids RETURN { _key: t._key, name: t.name, is_active: t.is_active }',
    { ids }
  )
  return new Map(rows.map(r => [r._key, r]))
}

/**
 * Preview the intake migration for a hypothetical config patch.
 *
 * Pure read: does not modify any documents.
 */
export async function previewMigration(cfgPatch) {
  const liveCfg = await getAppConfig()
  const effectiveCfg = applyPatch(liveCfg, cfgPatch)

  const candidates = await loadCandidateReceipts(effectiveCfg)
  const targetCounts = new Map() // teamId -> count
  const unresolvedByCategory = new Map()
  let willMove = 0
  let alreadyCorrect = 0

  for (const r of candidates) {
    const { teamId, reason } = resolveIntakeFromCfg(r, effectiveCfg)
    if (!teamId) {
      const cat = receiptProductCategory(r) || '(no category)'
      unresolvedByCategory.set(cat, (unresolvedByCategory.get(cat) || 0) + 1)
      continue
    }
    if (r.current_team_id === teamId) {
      alreadyCorrect++
      continue
    }
    willMove++
    targetCounts.set(teamId, (targetCounts.get(teamId) || 0) + 1)
    void reason // (kept available if we later want to surface why)
  }

  // Hydrate team names; mark inactive/missing teams so the UI can warn.
  const teamMap = await loadTeamMap([...targetCounts.keys()])
  const byTeam = [...targetCounts.entries()].map(([teamId, count]) => {
    const t = teamMap.get(teamId)
    return {
      team_id: teamId,
      team_name: t?.name || `(unknown ${teamId})`,
      is_active: t?.is_active !== false,
      missing: !t,
      count
    }
  }).sort((a, b) => b.count - a.count)

  const unresolved = [...unresolvedByCategory.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)

  return {
    total: candidates.length,
    will_move: willMove,
    already_correct: alreadyCorrect,
    by_team: byTeam,
    unresolved
  }
}

function makeJob(id, total, byTeamPreview) {
  const by_team = {}
  for (const row of byTeamPreview) {
    by_team[row.team_id] = {
      team_id: row.team_id,
      team_name: row.team_name,
      target: row.count,
      moved: 0,
      errors: 0
    }
  }
  return {
    id,
    status: 'running',
    total,
    processed: 0,
    moved: 0,
    skipped: 0,
    error_count: 0,
    by_team,
    errors: [],
    started_at: new Date().toISOString(),
    finished_at: null
  }
}

function recordError(job, _key, code, detail) {
  job.error_count++
  if (job.errors.length < MAX_RETAINED_ERRORS) {
    job.errors.push({ _key, code, detail })
  }
}

async function processBatch(job, batch, actor, effectiveCfg, reason) {
  await Promise.all(batch.map(async (receipt) => {
    const { teamId } = resolveIntakeFromCfg(receipt, effectiveCfg)
    if (!teamId) {
      recordError(job, receipt._key, 'no_intake_team_configured', 'No intake team for this receipt under the new config')
      job.processed++
      return
    }
    if (receipt.current_team_id === teamId) {
      job.skipped++
      job.processed++
      return
    }
    try {
      await forceMoveToTeam(receipt._key, actor, teamId, { reason })
      job.moved++
      const teamRow = job.by_team[teamId]
      if (teamRow) teamRow.moved++
    } catch (err) {
      const code = err?.code || 'unknown_error'
      recordError(job, receipt._key, code, err?.detail || err?.message || String(err))
      const teamRow = job.by_team[teamId]
      if (teamRow) teamRow.errors++
    } finally {
      job.processed++
    }
  }))
}

/**
 * Start a background migration job. Returns immediately with the job id.
 * Subsequent state is observable via getJob(jobId).
 *
 * Throws an Error with .code='migration_in_progress' if another job is live.
 */
export async function startMigrationJob(cfgPatch, actor, { reason = 'admin_intake_remap' } = {}) {
  if (activeJobId && jobs.get(activeJobId)?.status === 'running') {
    const err = new Error('A migration is already in progress')
    err.code = 'migration_in_progress'
    err.status = 409
    err.active_job_id = activeJobId
    throw err
  }

  const liveCfg = await getAppConfig()
  const effectiveCfg = applyPatch(liveCfg, cfgPatch)
  const preview = await previewMigration(cfgPatch)

  const id = newJobId()
  const job = makeJob(id, preview.will_move, preview.by_team)
  jobs.set(id, job)
  activeJobId = id
  pruneOldJobs()

  // Kick off processing without awaiting so the HTTP handler can return.
  // Errors inside the runner are captured into the job snapshot, not thrown.
  setImmediate(() => { runJob(id, effectiveCfg, actor, reason).catch(err => {
    console.error('[receipt-migration] runJob fatal:', err)
    const j = jobs.get(id)
    if (j) {
      j.status = 'failed'
      j.finished_at = new Date().toISOString()
      recordError(j, null, 'runner_crash', err?.message || String(err))
    }
    if (activeJobId === id) activeJobId = null
  }) })

  return { job_id: id }
}

async function runJob(id, effectiveCfg, actor, reason) {
  const job = jobs.get(id)
  if (!job) return

  // Re-load candidates so the run-set reflects the current DB (covers receipts
  // created between the preview and the run). We still respect the same
  // terminal-status filter as the preview.
  const candidates = await loadCandidateReceipts(effectiveCfg)

  // Filter to only those that would actually move under the patched config —
  // mirrors preview's `will_move` / unresolved bucketing.
  const toProcess = []
  for (const r of candidates) {
    const { teamId } = resolveIntakeFromCfg(r, effectiveCfg)
    if (!teamId) {
      recordError(job, r._key, 'no_intake_team_configured', 'No intake team configured')
      continue
    }
    if (r.current_team_id === teamId) {
      job.skipped++
      continue
    }
    toProcess.push(r)
  }
  job.total = toProcess.length + job.skipped // align total with actual run-set including pre-run skips

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE)
    await processBatch(job, batch, actor, effectiveCfg, reason)
    // Yield so the event loop can serve other requests / polling.
    await new Promise(r => setImmediate(r))
  }

  job.status = job.error_count > 0 && job.moved === 0 ? 'failed' : 'done'
  job.finished_at = new Date().toISOString()
  if (activeJobId === id) activeJobId = null
}

export function getJob(jobId) {
  if (!jobId) return null
  const j = jobs.get(String(jobId))
  if (!j) return null
  // Return a shallow snapshot: by_team is a flat map of small records, errors
  // is already capped, so cloning is cheap and prevents accidental mutation.
  return {
    ...j,
    by_team: { ...j.by_team },
    errors: [...j.errors]
  }
}

export function getActiveJobId() {
  return activeJobId
}
