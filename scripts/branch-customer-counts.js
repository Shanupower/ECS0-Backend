import 'dotenv/config'
import { q, normalizeBranchName } from '../config/database.js'

/**
 * Compare per-branch customer counts using:
 * - OLD logic: relationship_manager string/array
 * - NEW logic: branches[] array (post-migration)
 *
 * Usage:
 *   node scripts/branch-customer-counts.js
 *
 * Run this:
 * - Before migration (on prod and/or clone) to capture baseline (old vs new).
 * - After migration to confirm OLD and NEW counts are identical for each branch.
 */

async function getDistinctUserBranches() {
  const rows = await q(`
    FOR u IN users
      FILTER u.branch != null
      RETURN DISTINCT u.branch
  `)
  return rows.map(String)
}

async function buildBranchLookup() {
  const branches = await q(`
    FOR b IN branches
      RETURN { key: b._key, name: b.branch_name, code: b.branch_code }
  `)

  const byKey = new Map()
  const byName = new Map()
  const byCode = new Map()

  for (const b of branches) {
    if (!b || !b.key) continue
    byKey.set(String(b.key), b)
    if (b.name) byName.set(String(b.name).trim(), b)
    if (b.code) byCode.set(String(b.code).trim(), b)
  }

  return { byKey, byName, byCode }
}

function resolveCanonicalBranch(normalized, branchLookup) {
  if (!normalized) return null
  const val = String(normalized).trim()
  if (!val) return null

  // Match by exact branch_code
  if (branchLookup.byCode.has(val)) {
    return String(branchLookup.byCode.get(val).key)
  }

  // Match by exact branch_name
  if (branchLookup.byName.has(val)) {
    return String(branchLookup.byName.get(val).key)
  }

  // If normalized matches a key directly
  if (branchLookup.byKey.has(val)) {
    return String(val)
  }

  return null
}

async function countCustomersOldLogic(normalizedBranch) {
  const result = await q(
    `
    LET b = @b
    RETURN LENGTH(
      FOR c IN customers
        FILTER
          (IS_ARRAY(c.relationship_manager) && b IN c.relationship_manager) ||
          (!IS_ARRAY(c.relationship_manager) && c.relationship_manager == b)
        RETURN 1
    )
  `,
    { b: normalizedBranch }
  )
  return result[0] || 0
}

async function countCustomersNewLogic(canonicalBranch) {
  if (!canonicalBranch) return 0
  const result = await q(
    `
    LET b = @b
    RETURN LENGTH(
      FOR c IN customers
        FILTER IS_ARRAY(c.branches) && b IN c.branches
        RETURN 1
    )
  `,
    { b: canonicalBranch }
  )
  return result[0] || 0
}

async function main() {
  console.log('====================================')
  console.log(' Branch-wise customer count report')
  console.log(' (OLD vs NEW logic)')
  console.log('====================================')

  const rawBranches = await getDistinctUserBranches()
  const branchLookup = await buildBranchLookup()
  const rows = []

  for (const userBranch of rawBranches) {
    const normalized = normalizeBranchName(userBranch) || String(userBranch).trim()
    const canonical = resolveCanonicalBranch(normalized, branchLookup)
    if (!normalized) {
      rows.push({
        userBranch,
        normalized: null,
        canonical,
        oldCount: 0,
        newCount: 0,
        note: 'Skipped: normalizeBranchName returned null'
      })
      continue
    }

    const oldCount = await countCustomersOldLogic(normalized)
    const newCount = await countCustomersNewLogic(canonical)

    rows.push({
      userBranch,
      normalized,
      canonical,
      oldCount,
      newCount,
      delta: newCount - oldCount
    })
  }

  console.log(JSON.stringify(rows, null, 2))
  console.log('====================================')
  console.log(' Done.')
  console.log('====================================')
}

main().catch((err) => {
  console.error('branch-customer-counts failed:', err)
  process.exit(1)
})

