import 'dotenv/config'
import { q, getCollection, normalizeBranchName } from '../config/database.js'

/**
 * Branch migration script (runs against ecs_backend_clone first!)
 *
 * Goals:
 * - Normalize all user and customer branch fields to canonical branch codes
 * - Prepare the ground so runtime normalization logic can later be removed
 *
 * Usage (from ECS0-Backend directory):
 *   node scripts/migrate-branches.js          # dry run (no writes)
 *   DRY_RUN=false node scripts/migrate-branches.js   # apply changes
 */

const DRY_RUN = process.env.DRY_RUN !== 'false'

async function buildBranchLookup() {
  const branches = await q(`
    FOR b IN branches
      RETURN { key: b._key, name: b.branch_name }
  `)

  const byKey = new Map()
  const byName = new Map()

  for (const b of branches) {
    if (!b || !b.key) continue
    byKey.set(b.key, b)
    if (b.name) {
      byName.set(String(b.name).trim(), b)
    }
  }

  return { byKey, byName }
}

function normalizeToCanonical(raw, branchLookup) {
  if (raw == null || raw === '') return null

  const str = String(raw).trim()
  if (!str) return null

  // 1) If it's already a canonical key
  if (branchLookup.byKey.has(str)) return str

  // 2) If it matches a branch_name exactly
  if (branchLookup.byName.has(str)) {
    return branchLookup.byName.get(str).key
  }

  // 3) Fall back to existing normalizeBranchName helper
  const normalized = normalizeBranchName(str)
  if (normalized && branchLookup.byKey.has(normalized)) {
    return normalized
  }

  // 4) Last resort: return normalized even if not in branches (for logging)
  return normalized || str
}

async function migrateUsers(branchLookup) {
  console.log('=== Migrating users.branch to canonical codes ===')

  const users = await q(`
    FOR u IN users
      RETURN { _key: u._key, branch: u.branch }
  `)

  const userColl = getCollection('users')
  const stats = {
    total: users.length,
    changed: 0,
    unchanged: 0,
    unknown: new Set()
  }

  for (const u of users) {
    const current = u.branch
    if (!current) {
      stats.unchanged++
      continue
    }

    const canonical = normalizeToCanonical(current, branchLookup)

    if (!canonical) {
      stats.unknown.add(String(current))
      stats.unchanged++
      continue
    }

    if (canonical === current) {
      stats.unchanged++
      continue
    }

    stats.changed++
    console.log(`[USER] ${u._key}: "${current}" -> "${canonical}"`)

    if (!DRY_RUN) {
      await userColl.update(u._key, { branch: canonical })
    }
  }

  console.log('User migration stats:', {
    total: stats.total,
    changed: stats.changed,
    unchanged: stats.unchanged,
    unknownValues: Array.from(stats.unknown)
  })
}

const CUSTOMER_UPDATE_BATCH_SIZE = 200

async function migrateCustomers(branchLookup) {
  console.log('=== Migrating customers.relationship_manager to branches[] canonical codes ===')

  const customers = await q(`
    FOR c IN customers
      RETURN { _key: c._key, relationship_manager: c.relationship_manager, relationship_manager_display: c.relationship_manager_display, branches: c.branches }
  `)

  const custColl = getCollection('customers')
  const stats = {
    total: customers.length,
    changed: 0,
    unchanged: 0,
    unchangedNonEmpty: 0,
    unchangedExamples: [],
    unknown: new Set()
  }

  /** @type {{ _key: string, branches: string[], relationship_manager: string | string[] }[]} */
  const updateBatch = []

  const flushBatch = async () => {
    if (updateBatch.length === 0) return
    if (DRY_RUN) {
      updateBatch.length = 0
      return
    }
    await Promise.all(
      updateBatch.map(({ _key, branches, relationship_manager }) =>
        custColl.update(_key, {
          branches,
          relationship_manager: relationship_manager
        })
      )
    )
    console.log(`  ... updated batch of ${updateBatch.length} customers (total changed so far: ${stats.changed})`)
    updateBatch.length = 0
  }

  for (const c of customers) {
    const rm = c.relationship_manager
    let branchesArray = []

    if (Array.isArray(rm)) {
      branchesArray = rm
    } else if (rm != null && rm !== '') {
      branchesArray = [rm]
    } else {
      branchesArray = []
    }

    const canonicalSet = new Set()

    for (const raw of branchesArray) {
      const canonical = normalizeToCanonical(raw, branchLookup)
      if (!canonical) {
        stats.unknown.add(String(raw))
        continue
      }
      canonicalSet.add(canonical)
    }

    const canonicalBranches = Array.from(canonicalSet)

    // Decide if anything changed
    const prev = Array.isArray(rm) ? rm : (rm != null && rm !== '' ? [rm] : [])
    const prevSorted = [...prev].map(String).sort()
    const nextSorted = [...canonicalBranches].map(String).sort()

    // Compare relationship_manager values only
    const sameRm =
      prevSorted.length === nextSorted.length &&
      prevSorted.every((v, i) => v === nextSorted[i])

    // Compare existing branches field (if any) with canonicalBranches
    const existingBranches = Array.isArray(c.branches)
      ? c.branches
      : c.branches != null && c.branches !== ''
        ? [c.branches]
        : []
    const existingBranchesSorted = [...existingBranches].map(String).sort()
    const sameBranches =
      existingBranchesSorted.length === nextSorted.length &&
      existingBranchesSorted.every((v, i) => v === nextSorted[i])

    // Only treat as fully unchanged if BOTH RM and branches already match canonical values
    if (sameRm && sameBranches) {
      stats.unchanged++
      if (prevSorted.length > 0) {
        stats.unchangedNonEmpty++
        if (stats.unchangedExamples.length < 20) {
          stats.unchangedExamples.push({
            key: c._key,
            relationship_manager: c.relationship_manager,
            branches: c.branches,
            canonicalBranches
          })
        }
      }
      continue
    }

    stats.changed++
    if (stats.changed <= 30) {
      console.log(
        `[CUSTOMER] ${c._key}: ${JSON.stringify(prev)} -> ${JSON.stringify(
          canonicalBranches
        )}`
      )
    }

    const relationship_manager =
      canonicalBranches.length === 1 ? canonicalBranches[0] : canonicalBranches

    if (!DRY_RUN) {
      updateBatch.push({
        _key: c._key,
        branches: canonicalBranches,
        relationship_manager
      })
      if (updateBatch.length >= CUSTOMER_UPDATE_BATCH_SIZE) {
        await flushBatch()
      }
    }
  }

  await flushBatch()

  console.log('Customer migration stats:', {
    total: stats.total,
    changed: stats.changed,
    unchanged: stats.unchanged,
    unchangedNonEmpty: stats.unchangedNonEmpty,
    unknownValues: Array.from(stats.unknown)
  })

  if (stats.unchangedExamples.length > 0) {
    console.log('Sample unchanged customers (non-empty RMs):')
    for (const ex of stats.unchangedExamples) {
      console.log(
        `  - ${ex.key}: relationship_manager=${JSON.stringify(
          ex.relationship_manager
        )}, branches=${JSON.stringify(ex.branches)}, canonical=${JSON.stringify(
          ex.canonicalBranches
        )}`
      )
    }
  }
}

async function main() {
  console.log('====================================')
  console.log(' Branch migration script starting...')
  console.log(' DRY_RUN =', DRY_RUN)
  console.log('====================================')

  const branchLookup = await buildBranchLookup()

  await migrateUsers(branchLookup)
  await migrateCustomers(branchLookup)

  console.log('====================================')
  console.log(' Branch migration script finished.')
  console.log('====================================')
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})

