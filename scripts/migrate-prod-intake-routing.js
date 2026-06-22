#!/usr/bin/env node
// Batched prod migration: legacy Pending → Draft, submit to intake teams, fix in-flight intake routing.
//
// Usage (set ARANGO_* to prod):
//   node scripts/migrate-prod-intake-routing.js --dry-run
//   node scripts/migrate-prod-intake-routing.js
//   node scripts/migrate-prod-intake-routing.js --skip-pending
//   node scripts/migrate-prod-intake-routing.js --batch=100

import 'dotenv/config'
import db, { q } from '../config/database.js'
import * as engine from '../services/receipt-stage-engine.js'
import { getAppConfig } from '../routes/app-config.js'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const SKIP_PENDING = args.includes('--skip-pending')
const SKIP_SUBMIT = args.includes('--skip-submit')
const SKIP_INFLIGHT = args.includes('--skip-inflight')
const BATCH = (() => {
  const a = args.find((x) => x.startsWith('--batch='))
  return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 100) : 100
})()
const REASON = (() => {
  const a = args.find((x) => x.startsWith('--reason='))
  return a ? a.slice('--reason='.length) : 'Intake routing migration (prod batch script)'
})()

function now() {
  return new Date().toISOString()
}

function actorForReceipt(r) {
  return {
    sub: r.user_id || null,
    _key: r.user_id || null,
    emp_code: r.emp_code || null,
    name: r.user_name || r.emp_code || null,
    role: 'admin'
  }
}

function intakeStageIdsFromCfg(cfg) {
  const ids = new Set()
  if (cfg?.receipt_intake_team_id) ids.add(String(cfg.receipt_intake_team_id))
  if (cfg?.receipt_intake_non_online_team_id) ids.add(String(cfg.receipt_intake_non_online_team_id))
  const map = cfg?.receipt_intake_teams_by_category && typeof cfg.receipt_intake_teams_by_category === 'object'
    ? cfg.receipt_intake_teams_by_category
    : {}
  for (const v of Object.values(map)) {
    if (v != null && String(v).trim() !== '') ids.add(String(v))
  }
  return ids
}

async function stepPendingToDraft() {
  const [pendingCount] = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Pending"
        RETURN 1
    )
  `)
  if (DRY_RUN) {
    console.log(`[pending→draft] dry-run: would update ${pendingCount} Pending receipt(s)`)
    return pendingCount
  }

  let total = 0
  while (true) {
    const rows = await q(`
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Pending"
        SORT r.created_at ASC
        LIMIT @batch
        RETURN r._key
    `, { batch: BATCH })
    if (!rows.length) break

    await q(`
      FOR k IN @keys
        FOR doc IN receipts FILTER doc._key == k
          UPDATE doc WITH {
            status: "Draft",
            current_team_id: doc.current_team_id != null ? doc.current_team_id : null,
            current_approval_task_key: doc.current_approval_task_key != null ? doc.current_approval_task_key : null,
            approval_cycle_id: doc.approval_cycle_id != null ? doc.approval_cycle_id : null,
            approved_by_team_ids: IS_ARRAY(doc.approved_by_team_ids) ? doc.approved_by_team_ids : [],
            stage_history: IS_ARRAY(doc.stage_history) ? doc.stage_history : [],
            updated_at: @now
          } IN receipts
    `, { keys: rows, now: now() })

    total += rows.length
    console.log(`[pending→draft] updated ${rows.length} (total ${total})`)
    if (rows.length < BATCH) break
  }
  return total
}

async function stepSubmitDrafts() {
  const [draftCount] = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Draft"
        FILTER r.current_team_id == null OR r.current_team_id == ""
        RETURN 1
    )
  `)
  if (DRY_RUN) {
    console.log(`[submit] dry-run: would submit ${draftCount} Draft receipt(s) to intake teams`)
    return { submitted: draftCount, skipped: 0, failed: 0, errors: [] }
  }

  let submitted = 0
  let skipped = 0
  let failed = 0
  const errors = []

  while (true) {
    const candidates = await q(`
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Draft"
        FILTER r.current_team_id == null OR r.current_team_id == ""
        SORT r.created_at ASC
        LIMIT @batch
        RETURN r
    `, { batch: BATCH })

    if (!candidates.length) break

    for (const r of candidates) {
      try {
        const actor = actorForReceipt(r)
        if (!actor.sub) {
          skipped++
          errors.push({ _key: r._key, reason: 'no_user_id' })
          continue
        }
        await engine.submit(r._key, actor)
        submitted++
      } catch (err) {
        failed++
        errors.push({ _key: r._key, code: err.code, detail: err.message })
      }
    }
    console.log(`[submit] batch done — submitted=${submitted} skipped=${skipped} failed=${failed}`)
    if (candidates.length < BATCH) break
  }

  return { submitted, skipped, failed, errors }
}

async function stepFixInFlightIntake(cfg) {
  const intakeIds = [...intakeStageIdsFromCfg(cfg)]
  if (!intakeIds.length) return { moved: 0, skipped: 0, failed: 0, errors: [] }

  const [onIntakeCount] = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.current_team_id != null && r.current_team_id != ""
        FILTER r.current_team_id IN @intakeIds
        RETURN 1
    )
  `, { intakeIds })

  if (DRY_RUN) {
    console.log(`[inflight] dry-run: ${onIntakeCount} receipt(s) on intake-stage teams (wrong-team moves computed on live run only)`)
    return { moved: 0, skipped: onIntakeCount, failed: 0, errors: [] }
  }

  let moved = 0
  let skipped = 0
  let failed = 0
  const errors = []

  while (true) {
    const rows = await q(`
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.current_team_id != null && r.current_team_id != ""
        FILTER r.current_team_id IN @intakeIds
        SORT r.created_at ASC
        LIMIT @batch
        RETURN r
    `, { intakeIds, batch: BATCH })

    if (!rows.length) break

    let batchMoved = 0
    for (const r of rows) {
      let target = null
      try {
        const resolved = await engine.resolveIntakeTeam(r)
        target = resolved?.team?._key || null
      } catch (err) {
        failed++
        errors.push({ _key: r._key, code: err.code, detail: err.message })
        continue
      }

      if (!target || String(target) === String(r.current_team_id)) {
        skipped++
        continue
      }

      try {
        const actor = actorForReceipt(r)
        await engine.adminOverride(r._key, actor, { nextTeamId: target, comment: REASON })
        moved++
        batchMoved++
      } catch (err) {
        failed++
        errors.push({ _key: r._key, code: err.code, detail: err.message })
      }
    }

    console.log(`[inflight] batch — moved=${moved} skipped=${skipped} failed=${failed}`)
    // Stop when every receipt in the batch is already on the correct team (avoids infinite re-scan).
    if (rows.length < BATCH || batchMoved === 0) break
  }

  return { moved, skipped, failed, errors }
}

async function main() {
  console.log(`[migrate-prod] ${process.env.ARANGO_URL} db=${process.env.ARANGO_DATABASE} batch=${BATCH} ${DRY_RUN ? '(dry-run)' : '(LIVE)'}`)
  const ver = await db.version()
  console.log(`[migrate-prod] ArangoDB ${ver.version}`)

  const cfg = await getAppConfig()
  if (!cfg?.feature_flags?.receipts_approval_v2) {
    console.error('[migrate-prod] ABORT: receipts_approval_v2 is not enabled.')
    process.exit(1)
  }

  const pendingBefore = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Pending" OR r.status == null
        RETURN 1
    )
  `)
  const draftBefore = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Draft"
        FILTER r.current_team_id == null OR r.current_team_id == ""
        RETURN 1
    )
  `)
  console.log(`[migrate-prod] before: pending=${pendingBefore[0]} unsubmitted_drafts=${draftBefore[0]}`)

  let pendingUpdated = 0
  if (!SKIP_PENDING) {
    pendingUpdated = await stepPendingToDraft()
    console.log(`[migrate-prod] pending→draft total: ${pendingUpdated}`)
  }

  let submitStats = { submitted: 0, skipped: 0, failed: 0, errors: [] }
  if (!SKIP_SUBMIT) {
    submitStats = await stepSubmitDrafts()
    console.log(`[migrate-prod] submit:`, submitStats)
  }

  let inflightStats = { moved: 0, skipped: 0, failed: 0, errors: [] }
  if (!SKIP_INFLIGHT) {
    inflightStats = await stepFixInFlightIntake(cfg)
    console.log(`[migrate-prod] in-flight intake fix:`, inflightStats)
  }

  const pendingAfter = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Pending" OR r.status == null
        RETURN 1
    )
  `)
  const draftAfter = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.status == "Draft"
        FILTER r.current_team_id == null OR r.current_team_id == ""
        RETURN 1
    )
  `)
  const inFlightAfter = await q(`
    RETURN LENGTH(
      FOR r IN receipts
        FILTER r.is_deleted != true
        FILTER r.current_team_id != null && r.current_team_id != ""
        RETURN 1
    )
  `)
  console.log(`[migrate-prod] after: pending=${pendingAfter[0]} unsubmitted_drafts=${draftAfter[0]} in_flight=${inFlightAfter[0]}`)

  const exitCode =
    (submitStats.failed || 0) + (inflightStats.failed || 0) > 0 ? 2 : 0
  process.exit(exitCode)
}

main().catch((err) => {
  console.error('[migrate-prod] FATAL:', err)
  process.exit(1)
})
