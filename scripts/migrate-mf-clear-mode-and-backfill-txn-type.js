/**
 * Backfill MF `txn_type` from legacy `mode`, then clear deprecated `mode` fields.
 *
 * Why:
 * - Backend filtering uses `receipt.txn_type` for MF.
 * - Legacy MF receipts may have only `receipt.mode` (ex: "Lump Sum", "Switch Over").
 * - We now determine MF "mode" display from `txn_type` (+ sip/swp/stp fields) instead.
 *
 * Run:
 *   node scripts/migrate-mf-clear-mode-and-backfill-txn-type.js
 * Dry run:
 *   DRY_RUN=1 node scripts/migrate-mf-clear-mode-and-backfill-txn-type.js
 * Limit receipts processed:
 *   LIMIT=50000 node scripts/migrate-mf-clear-mode-and-backfill-txn-type.js
 */

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const LIMIT = Math.max(1, parseInt(process.env.LIMIT, 10) || 50000)
const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE, 10) || 500)

function normTxnTypeFromMode(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  const upper = v.toUpperCase()
  const lower = v.toLowerCase()

  // Switch Over
  if (
    upper === 'SWITCHOVER' ||
    lower === 'switch over' ||
    v === 'Switch Over' ||
    v === 'SwitchOver' ||
    upper === 'SWITCH_OVER'
  ) return 'Switch Over'

  // Lump Sum
  if (v === 'Lump Sum' || v === 'Lumpsum' || v === 'LumpSum' || v === 'Lump Sum' || upper === 'LUMPSUM') return 'Lumpsum'

  // SIP/SWP/STP
  if (v === 'SIP' || v === 'SWP' || v === 'STP') return v

  return v
}

function normTxnType(raw) {
  const v = String(raw || '').trim()
  if (!v) return ''
  // Reuse mapping logic
  return normTxnTypeFromMode(v)
}

function shouldClearModeField(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN: backfill txn_type + clear mode' : 'Running migration: backfill txn_type + clear mode')
  console.log('Limit (receipts processed):', LIMIT)
  console.log('Batch size:', BATCH_SIZE)

  let processed = 0
  let updated = 0
  let backfilledTxnType = 0
  let clearedModeRoot = 0
  let clearedModeNested = 0

  const coll = getCollection('receipts')

  while (processed < LIMIT) {
    const batch = await q(`
      FOR receipt IN receipts
        FILTER receipt.is_deleted != true
        LET cat = (receipt.product_category != null ? receipt.product_category : (receipt.product != null ? receipt.product.category : null))
        FILTER cat != null
        FILTER (
          receipt.mode != null
          OR (receipt.transaction != null && receipt.transaction.mode != null)
          OR (
            cat == 'MF'
            AND (receipt.txn_type == null || receipt.txn_type == '')
            AND (receipt.mode != null OR (receipt.transaction != null && receipt.transaction.mode != null))
          )
        )
        SORT receipt.created_at DESC
        LIMIT ${processed}, ${BATCH_SIZE}
        RETURN {
          _key: receipt._key,
          product_category: cat,
          txn_type: receipt.txn_type,
          txnType: receipt.txnType,
          mode: receipt.mode,
          transaction: receipt.transaction
        }
    `)

    if (!batch.length) break

    for (const r of batch) {
      if (processed >= LIMIT) break
      processed++

      const cat = r.product_category
      const existingRootTxnType = r.txn_type ?? r.txnType ?? null
      const existingNestedTxnType = r.transaction?.type ?? r.transaction?.txn_type ?? null
      const legacyMode = r.mode ?? r.transaction?.mode ?? null

      let nextTxnType = existingRootTxnType
      if (!nextTxnType && cat === 'MF') {
        // Prefer txn_type from nested transaction.type, else derive from legacy mode.
        nextTxnType = existingNestedTxnType ?? normTxnTypeFromMode(legacyMode)
      } else if (cat === 'MF' && nextTxnType) {
        // Normalize legacy values if needed.
        nextTxnType = normTxnType(nextTxnType) || nextTxnType
      }

      const updates = {}

      // Backfill root txn_type only for MF (others don't use it).
      if (cat === 'MF' && (!r.txn_type || String(r.txn_type).trim() === '') && nextTxnType) {
        updates.txn_type = nextTxnType
        backfilledTxnType++
      }

      // Clear deprecated root mode.
      if (shouldClearModeField(r.mode)) {
        updates.mode = null
        clearedModeRoot++
      }

      // Clear deprecated nested transaction.mode.
      if (r.transaction && shouldClearModeField(r.transaction.mode)) {
        updates.transaction = { ...r.transaction, mode: null }
        clearedModeNested++
      }

      if (Object.keys(updates).length === 0) continue

      if (!DRY_RUN) {
        await coll.update(r._key, updates)
      }
      updated++
    }
  }

  console.log('Processed receipts:', processed)
  console.log('Would/updated receipts:', updated)
  console.log('Backfilled txn_type:', backfilledTxnType)
  console.log('Cleared root mode:', clearedModeRoot)
  console.log('Cleared nested transaction.mode:', clearedModeNested)
}

main().catch((e) => {
  console.error('Migration failed:', e)
  process.exit(1)
})

