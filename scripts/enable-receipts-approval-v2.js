#!/usr/bin/env node
// Phase 4 cutover helper: flips the `receipts_approval_v2` feature flag in
// app_config. Idempotent; re-running is a no-op after the first success.
//
//   node scripts/enable-receipts-approval-v2.js            # flip ON (default)
//   node scripts/enable-receipts-approval-v2.js --off      # flip OFF (rollback)
//
// Safety: refuses to flip ON unless `receipt_intake_team_id` is set or at least
// one entry exists in `receipt_intake_teams_by_category`, and all referenced
// teams exist and are active.

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'
import { getAppConfig } from '../routes/app-config.js'

async function validateTeamId(kid) {
  const team = (await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: String(kid) }))[0]
  if (!team) {
    console.error(`[flag] ERROR: team (${kid}) not found.`)
    return false
  }
  if (team.is_active === false) {
    console.error(`[flag] ERROR: team "${team.name}" (${kid}) is not active.`)
    return false
  }
  return true
}

async function main() {
  const turnOff = process.argv.includes('--off')
  const target = !turnOff
  console.log(`[flag] requesting receipts_approval_v2 = ${target}`)

  const existing = (await q('FOR c IN app_config FILTER c._key == "default" LIMIT 1 RETURN c'))[0] || null
  const currentFlags = (existing && existing.feature_flags && typeof existing.feature_flags === 'object') ? existing.feature_flags : {}

  const cfg = await getAppConfig()
  const intakeId = cfg?.receipt_intake_team_id || null
  const map = cfg?.receipt_intake_teams_by_category && typeof cfg.receipt_intake_teams_by_category === 'object'
    ? cfg.receipt_intake_teams_by_category
    : {}
  const mappedTeamIds = [...new Set(
    Object.values(map)
      .filter((v) => v != null && String(v).trim() !== '')
      .map((v) => String(v).trim())
  )]

  if (target) {
    if (!intakeId && mappedTeamIds.length === 0) {
      console.error('[flag] ERROR: Set receipt_intake_team_id or at least one receipt_intake_teams_by_category team in app_config before enabling.')
      process.exit(2)
    }
    if (intakeId && !(await validateTeamId(intakeId))) process.exit(2)
    for (const id of mappedTeamIds) {
      if (!(await validateTeamId(id))) process.exit(2)
    }
  }

  if (currentFlags.receipts_approval_v2 === target) {
    console.log(`[flag] already ${target ? 'ON' : 'OFF'}; nothing to do`)
    process.exit(0)
  }

  const patch = {
    feature_flags: { ...currentFlags, receipts_approval_v2: target },
    updated_at: new Date().toISOString()
  }
  const col = getCollection('app_config')
  if (existing) await col.update('default', patch)
  else await col.save({ _key: 'default', ...patch })

  console.log(`[flag] receipts_approval_v2 is now ${target ? 'ON' : 'OFF'}`)
  process.exit(0)
}

main().catch(err => { console.error('[flag] FAILED:', err); process.exit(1) })
