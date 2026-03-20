import 'dotenv/config'
import { q } from '../config/database.js'

/**
 * Seeds branches.monthly_target from the sum of users.monthly_target for users
 * belonging to that branch (branch_code or branch matches branch _key, code, or name).
 * Then clears users.monthly_target.
 *
 * Only writes when branches.monthly_target is null/undefined/missing, unless
 * OVERWRITE_BRANCH_TARGET=1.
 *
 * Usage (from ECS0-Backend):
 *   node scripts/migrate-monthly-target-to-branches.js
 *   DRY_RUN=false node scripts/migrate-monthly-target-to-branches.js
 */

const DRY_RUN = process.env.DRY_RUN !== 'false'
const OVERWRITE = process.env.OVERWRITE_BRANCH_TARGET === '1'

async function main() {
  const branches = await q(`
    FOR b IN branches
      RETURN { key: b._key, code: b.branch_code, name: b.branch_name, current: b.monthly_target }
  `)

  const finalUpdates = []
  for (const b of branches) {
    const codes = [...new Set([b.key, b.code, b.name].filter(Boolean).map((x) => String(x).trim()))]
    if (!codes.length) continue

    const sums = await q(
      `
      RETURN SUM(
        FOR u IN users
          FILTER u.is_active == true
          FILTER u.monthly_target != null AND TO_NUMBER(u.monthly_target) > 0
          FILTER (u.branch_code != null AND u.branch_code IN @codes)
             OR (u.branch != null AND u.branch IN @codes)
          RETURN TO_NUMBER(u.monthly_target)
      )
    `,
      { codes }
    )
    const summed = Number(sums[0]) || 0
    if (summed <= 0) continue

    const existingNum = b.current != null && b.current !== '' ? Number(b.current) : null
    const hasExisting = existingNum != null && !Number.isNaN(existingNum) && existingNum > 0
    if (hasExisting && !OVERWRITE) continue

    finalUpdates.push({ key: b.key, code: b.code, summed, previous: b.current })
  }

  console.log(DRY_RUN ? '[DRY RUN] Would update branches:' : 'Updating branches:')
  for (const u of finalUpdates) {
    console.log(`  ${u.code || u.key}: monthly_target=${u.summed} (was ${u.previous ?? 'unset'})`)
  }

  if (!DRY_RUN) {
    for (const u of finalUpdates) {
      await q(
        `
        FOR b IN branches
          FILTER b._key == @key
          UPDATE b WITH { monthly_target: @val, updated_at: @ts } IN branches
        `,
        { key: u.key, val: u.summed, ts: new Date().toISOString() }
      )
    }

    const cleared = await q(`
      FOR u IN users
        FILTER u.monthly_target != null
        UPDATE u WITH { monthly_target: null } IN users
        RETURN 1
    `)
    console.log(`Cleared monthly_target on ${cleared.length} user document(s).`)
  } else {
    const wouldClear = await q(`
      FOR u IN users
        FILTER u.monthly_target != null
        COLLECT WITH COUNT INTO n
        RETURN n
    `)
    console.log(`[DRY RUN] Would clear monthly_target on ${wouldClear[0] || 0} user(s).`)
  }

  console.log('Done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
