#!/usr/bin/env node
// Idempotent migration for the receipt-approval workflow (Phase 2).
//
// Back-fills the new approval fields on every existing receipt:
//   - current_team_id                 (null unless already set)
//   - current_approval_task_key       (null unless already set)
//   - approval_cycle_id               (null unless already set)
//   - approved_by_team_ids[]          ([] unless already set)
//   - stage_history[]                 ([] unless already set)
//
// Legacy status mapping:
//   - status == 'Pending' or missing -> 'Draft'     (creator has to re-submit)
//   - status == 'Completed'           -> kept as-is, with a single synthetic
//                                        history entry tagged legacy=true
//
// Safe to re-run. A receipt is considered "already migrated" if it has
// `approved_by_team_ids` set (array). The script reports how many docs it
// inspected / migrated / skipped on each run.

import 'dotenv/config'
import db, { q } from '../config/database.js'

const DRY_RUN = process.argv.includes('--dry-run')

function now() { return new Date().toISOString() }

function buildLegacyHistory(receipt) {
  if (receipt.status !== 'Completed') return []
  return [{
    cycle_id: 'legacy',
    team_id: null,
    team_name: null,
    entered_at: receipt.created_at || null,
    exited_at: receipt.status_updated_at || receipt.updated_at || receipt.created_at || null,
    resolution: 'approved',
    next_team_id: null,
    next_team_name: null,
    actor_id: receipt.status_updated_by || null,
    actor_name: null,
    comment: null,
    task_key: null,
    legacy: true
  }]
}

async function main() {
  console.log(`[migrate] connecting to ${process.env.ARANGO_URL} db=${process.env.ARANGO_DATABASE} ${DRY_RUN ? '(dry-run)' : ''}`)
  const ver = await db.version()
  console.log(`[migrate] connected to ArangoDB ${ver.version}`)

  const rows = await q(`FOR r IN receipts RETURN r`)
  let inspected = 0, migrated = 0, skipped = 0, updatedStatus = 0

  for (const r of rows) {
    inspected++
    const alreadyMigrated = Array.isArray(r.approved_by_team_ids)
      && Array.isArray(r.stage_history)
      && Object.prototype.hasOwnProperty.call(r, 'current_team_id')
      && Object.prototype.hasOwnProperty.call(r, 'approval_cycle_id')
    if (alreadyMigrated) { skipped++; continue }

    const patch = {
      current_team_id: r.current_team_id ?? null,
      current_approval_task_key: r.current_approval_task_key ?? null,
      approval_cycle_id: r.approval_cycle_id ?? null,
      approved_by_team_ids: Array.isArray(r.approved_by_team_ids) ? r.approved_by_team_ids : [],
      stage_history: Array.isArray(r.stage_history) ? r.stage_history : buildLegacyHistory(r),
      updated_at: now()
    }

    const isLegacyPending = !r.status || r.status === 'Pending'
    if (isLegacyPending) {
      patch.status = 'Draft'
      updatedStatus++
    }

    if (DRY_RUN) {
      migrated++
      continue
    }

    await q(`
      FOR doc IN receipts FILTER doc._key == @k
        UPDATE doc WITH @patch IN receipts
    `, { k: r._key, patch })
    migrated++

    if (migrated % 500 === 0) {
      console.log(`[migrate] ...${migrated} migrated so far`)
    }
  }

  console.log(`[migrate] done. inspected=${inspected} migrated=${migrated} skipped=${skipped} pending_to_draft=${updatedStatus}`)
  process.exit(0)
}

main().catch(err => {
  console.error('[migrate] FAILED:', err)
  process.exit(1)
})
