/**
 * Normalize receipt.branch on existing receipts to canonical branch key (branches._key).
 * Uses getCanonicalBranchKey() so display names like "AMEER PET" become "2", etc.
 * Run once: node scripts/normalize-receipt-branches.js
 */

import 'dotenv/config'
import { q, getCanonicalBranchKey } from '../config/database.js'

async function main() {
  console.log('Fetching distinct receipt.branch values...')
  const distinct = await q(`
    FOR receipt IN receipts
      FILTER receipt.branch != null AND receipt.branch != ""
      COLLECT branch = receipt.branch WITH COUNT INTO c
      RETURN { branch, count: c }
  `)

  if (!distinct.length) {
    console.log('No receipts with branch set.')
    return
  }

  console.log(`Found ${distinct.length} distinct branch values.\n`)

  let updated = 0
  let skipped = 0
  let failed = 0

  for (const { branch, count } of distinct) {
    const canonical = await getCanonicalBranchKey(branch)
    if (!canonical) {
      console.log(`  Skip "${branch}" (${count} receipts) — no matching branch`)
      failed += count
      continue
    }
    if (String(canonical) === String(branch)) {
      skipped += count
      continue
    }
    const result = await q(`
      FOR receipt IN receipts
        FILTER receipt.branch == @current
        UPDATE receipt WITH { branch: @canonical } IN receipts
        RETURN OLD._key
    `, { current: branch, canonical })
    const n = result.length
    updated += n
    console.log(`  "${branch}" → "${canonical}" (${n} receipts)`)
  }

  console.log(`\nDone. Updated: ${updated}, already canonical: ${skipped}, unresolved: ${failed}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
