#!/usr/bin/env node
// Backfill: submit every Draft receipt into the configured intake team.
//
// This runs `services/receipt-stage-engine.js`'s `submit()` for each receipt
// whose status is currently "Draft" and which is not already in-flight
// (current_team_id == null). Every submission:
//   - starts a fresh approval_cycle_id
//   - creates a real tasks row (kind='receipt_approval', assignee=lead, watchers=members)
//   - appends an entry to receipt.stage_history
//   - mirrors task_watchers rows so notifications fire
//   - publishes a `receipt.submitted` event
//
// Idempotent: a receipt already in-flight (current_team_id != null) is skipped.
//
// Actor attribution: uses the receipt's own creator (`receipt.user_id` /
// `receipt.emp_code`). The synthesized actor is marked `role: 'admin'` so the
// engine skips the "only creator/admin may submit" check — the *recorded*
// actor in stage_history is still the original creator, which is what we want
// for an auditable backfill.
//
// Usage:
//   node scripts/backfill-drafts-to-intake.js --dry-run   # count only
//   node scripts/backfill-drafts-to-intake.js             # live run
//   node scripts/backfill-drafts-to-intake.js --limit=50  # cap for testing
//   node scripts/backfill-drafts-to-intake.js --branch=2  # only branch 2

import 'dotenv/config'
import db, { q } from '../config/database.js'
import * as engine from '../services/receipt-stage-engine.js'
import { getAppConfig } from '../routes/app-config.js'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const LIMIT = (() => {
  const a = args.find(x => x.startsWith('--limit='))
  return a ? parseInt(a.split('=')[1], 10) || 0 : 0
})()
const BRANCH = (() => {
  const a = args.find(x => x.startsWith('--branch='))
  return a ? a.split('=')[1] : null
})()

function actorForReceipt(r) {
  return {
    sub: r.user_id || null,
    _key: r.user_id || null,
    emp_code: r.emp_code || null,
    name: r.user_name || r.emp_code || null,
    role: 'admin'
  }
}

async function main() {
  console.log(`[backfill] connecting to ${process.env.ARANGO_URL} db=${process.env.ARANGO_DATABASE} ${DRY_RUN ? '(dry-run)' : ''}`)
  const ver = await db.version()
  console.log(`[backfill] connected to ArangoDB ${ver.version}`)

  const cfg = await getAppConfig()
  if (!cfg?.feature_flags?.receipts_approval_v2) {
    console.error('[backfill] ABORT: feature_flags.receipts_approval_v2 is not enabled in app_config.')
    process.exit(1)
  }
  const map = cfg?.receipt_intake_teams_by_category && typeof cfg.receipt_intake_teams_by_category === 'object'
    ? cfg.receipt_intake_teams_by_category
    : {}
  const hasCategoryMapping = Object.values(map).some((v) => v && String(v).trim())
  if (!cfg?.receipt_intake_team_id && !hasCategoryMapping) {
    console.error('[backfill] ABORT: set receipt_intake_team_id and/or receipt_intake_teams_by_category (at least one category team).')
    process.exit(1)
  }
  if (cfg.receipt_intake_team_id) {
    const [intake] = await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: String(cfg.receipt_intake_team_id) })
    if (!intake) {
      console.error(`[backfill] ABORT: default intake team ${cfg.receipt_intake_team_id} not found.`)
      process.exit(1)
    }
    if (intake.is_active === false) {
      console.error(`[backfill] ABORT: default intake team "${intake.name}" is inactive.`)
      process.exit(1)
    }
    console.log(`[backfill] default intake: ${intake.name} (_key=${intake._key})`)
  } else {
    console.log('[backfill] no default intake id; relying on receipt_intake_teams_by_category per receipt')
  }
  const mappedKeys = Object.keys(map).filter((k) => map[k] && String(map[k]).trim())
  console.log(`[backfill] category map entries: ${mappedKeys.length ? mappedKeys.join(', ') : '—'}`)

  const filters = ['r.status == "Draft"', '(r.current_team_id == null OR r.current_team_id == "")']
  if (BRANCH) filters.push('r.branch == @branch')
  const binds = {}
  if (BRANCH) binds.branch = String(BRANCH)

  const candidates = await q(`
    FOR r IN receipts
      FILTER ${filters.join(' AND ')}
      SORT r.created_at ASC
      ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
      RETURN r
  `, binds)

  console.log(`[backfill] candidates: ${candidates.length} ${BRANCH ? `(branch=${BRANCH})` : ''}${LIMIT ? ` (limit=${LIMIT})` : ''}`)
  if (DRY_RUN) {
    const byBranch = {}
    for (const r of candidates) byBranch[r.branch || '—'] = (byBranch[r.branch || '—'] || 0) + 1
    console.log(`[backfill] by-branch counts:`, byBranch)
    console.log(`[backfill] dry-run; no changes made.`)
    process.exit(0)
  }

  let submitted = 0, skipped = 0, failed = 0
  const errors = []

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
      if (submitted % 100 === 0) {
        console.log(`[backfill] ...${submitted} submitted / ${failed} failed / ${skipped} skipped`)
      }
    } catch (err) {
      failed++
      errors.push({ _key: r._key, code: err.code, detail: err.message })
      if (failed <= 5) console.warn(`[backfill] receipt ${r._key} failed:`, err.code || err.message)
    }
  }

  console.log(`\n[backfill] done.`)
  console.log(`  submitted: ${submitted}`)
  console.log(`  skipped:   ${skipped}`)
  console.log(`  failed:    ${failed}`)
  if (errors.length) {
    const byCode = {}
    for (const e of errors) byCode[e.code || e.reason || 'unknown'] = (byCode[e.code || e.reason || 'unknown'] || 0) + 1
    console.log(`  error breakdown:`, byCode)
    if (errors.length <= 20) console.log(`  first errors:`, errors.slice(0, 20))
  }
  process.exit(failed > 0 ? 2 : 0)
}

main().catch(err => {
  console.error('[backfill] FATAL:', err)
  process.exit(1)
})
