/**
 * Migration: reclassify legacy FD receipts to GOVT_FD when issuer type indicates govt/post-office.
 *
 * Modes:
 *   - Dry run (default): node scripts/migrate-govt-fd-category.js
 *   - Dry run (explicit): node scripts/migrate-govt-fd-category.js --dry-run
 *   - Apply: node scripts/migrate-govt-fd-category.js --apply
 *
 * Optional env:
 *   - BATCH_SIZE=100
 */

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

const argv = new Set(process.argv.slice(2))
const APPLY = argv.has('--apply')
const DRY_RUN = !APPLY // default

const BATCH_SIZE = Math.max(1, parseInt(process.env.BATCH_SIZE, 10) || 100)
const PREVIEW_LIMIT = 20
const TARGET_CATEGORY = 'GOVT_FD'

function normalizeIssuerType(v) {
  if (v == null) return ''
  return String(v).trim().toLowerCase()
}

function issuerIndicatesGovt(raw) {
  const s = normalizeIssuerType(raw)
  if (!s) return false
  // Avoid common negation that would otherwise false-positive on "government".
  if (s.includes('non-government') || s.includes('non government')) return false
  return s.includes('govt') || s.includes('government') || s.includes('post office') || s.includes('post-office') || s.includes('postoffice')
}

function buildUpdates(receipt) {
  const updates = { product_category: TARGET_CATEGORY }
  if (receipt.product && typeof receipt.product === 'object') {
    updates.product = { ...receipt.product, category: TARGET_CATEGORY }
  }
  return updates
}

async function getCandidateCount() {
  const rows = await q(
    `
    RETURN LENGTH(
      FOR receipt IN receipts
        FILTER receipt.is_deleted != true
        LET storedCat = (
          receipt.product_category != null ? receipt.product_category
          : (receipt.product != null ? receipt.product.category : null)
        )
        FILTER UPPER(TO_STRING(storedCat)) == 'FD'
        FILTER receipt.product_category != @target
        FILTER (receipt.product == null || receipt.product.category != @target)
        LET issuerType = (
          receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null
            ? receipt.product_details.fd.issuer.type
            : receipt.fd_issuer_type
        )
        FILTER issuerType != null && issuerType != ''
        LET t = LOWER(TRIM(TO_STRING(issuerType)))
        FILTER (CONTAINS(t, 'govt') OR CONTAINS(t, 'government') OR CONTAINS(t, 'post office') OR CONTAINS(t, 'post-office') OR CONTAINS(t, 'postoffice'))
          AND NOT (CONTAINS(t, 'non-government') OR CONTAINS(t, 'non government'))
        RETURN 1
    )
  `,
    { target: TARGET_CATEGORY }
  )
  return rows?.[0] ?? 0
}

async function getPreview() {
  return await q(
    `
    FOR receipt IN receipts
      FILTER receipt.is_deleted != true
      LET storedCat = (
        receipt.product_category != null ? receipt.product_category
        : (receipt.product != null ? receipt.product.category : null)
      )
      FILTER UPPER(TO_STRING(storedCat)) == 'FD'
      FILTER receipt.product_category != @target
      FILTER (receipt.product == null || receipt.product.category != @target)
      LET issuerType = (
        receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null
          ? receipt.product_details.fd.issuer.type
          : receipt.fd_issuer_type
      )
      FILTER issuerType != null && issuerType != ''
      LET t = LOWER(TRIM(TO_STRING(issuerType)))
      FILTER (CONTAINS(t, 'govt') OR CONTAINS(t, 'government') OR CONTAINS(t, 'post office') OR CONTAINS(t, 'post-office') OR CONTAINS(t, 'postoffice'))
        AND NOT (CONTAINS(t, 'non-government') OR CONTAINS(t, 'non government'))
      SORT receipt.created_at DESC
      LIMIT @limit
      RETURN {
        _key: receipt._key,
        receipt_no: receipt.receipt_no,
        product_category: receipt.product_category,
        product: receipt.product,
        issuer_type: issuerType
      }
  `,
    { target: TARGET_CATEGORY, limit: PREVIEW_LIMIT }
  )
}

async function getBatch(afterKey) {
  return await q(
    `
    FOR receipt IN receipts
      FILTER receipt.is_deleted != true
      FILTER @afterKey == null OR receipt._key > @afterKey
      LET storedCat = (
        receipt.product_category != null ? receipt.product_category
        : (receipt.product != null ? receipt.product.category : null)
      )
      FILTER UPPER(TO_STRING(storedCat)) == 'FD'
      FILTER receipt.product_category != @target
      FILTER (receipt.product == null || receipt.product.category != @target)
      LET issuerType = (
        receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null
          ? receipt.product_details.fd.issuer.type
          : receipt.fd_issuer_type
      )
      FILTER issuerType != null && issuerType != ''
      LET t = LOWER(TRIM(TO_STRING(issuerType)))
      FILTER (CONTAINS(t, 'govt') OR CONTAINS(t, 'government') OR CONTAINS(t, 'post office') OR CONTAINS(t, 'post-office') OR CONTAINS(t, 'postoffice'))
        AND NOT (CONTAINS(t, 'non-government') OR CONTAINS(t, 'non government'))
      SORT receipt._key ASC
      LIMIT @limit
      RETURN {
        _key: receipt._key,
        receipt_no: receipt.receipt_no,
        product_category: receipt.product_category,
        product: receipt.product,
        issuer_type: issuerType
      }
  `,
    { target: TARGET_CATEGORY, afterKey: afterKey ?? null, limit: BATCH_SIZE }
  )
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN (no updates)\n' : 'APPLY mode (writing updates)\n')
  console.log('Batch size:', BATCH_SIZE)

  const total = await getCandidateCount()
  console.log(`Matching receipts to reclassify FD → ${TARGET_CATEGORY}:`, total)

  const preview = await getPreview()
  if (preview.length) {
    console.log(`\nPreview (first ${Math.min(PREVIEW_LIMIT, preview.length)}):`)
    for (const r of preview) {
      const storedCat = r.product?.category ?? r.product_category
      const issuer = normalizeIssuerType(r.issuer_type)
      const ok = issuerIndicatesGovt(r.issuer_type)
      console.log(`  ${r.receipt_no ?? '(no receipt_no)'} (${r._key}) cat=${storedCat ?? '(none)'} issuer="${issuer}"${ok ? '' : ' [WARN: issuer did not match helper]'} `)
    }
  } else {
    console.log('\nPreview: (no matches)')
  }

  if (DRY_RUN) return
  if (!total) return

  const coll = getCollection('receipts')
  let updated = 0
  let afterKey = null
  let batches = 0

  while (true) {
    const batch = await getBatch(afterKey)
    if (!batch.length) break
    batches++

    for (const r of batch) {
      const updates = buildUpdates(r)
      await coll.update(r._key, updates)
      updated++
      afterKey = r._key
    }

    console.log(`Progress: updated ${updated}/${total} (last _key=${afterKey}, batches=${batches})`)
    if (batch.length < BATCH_SIZE) break
  }

  console.log(`\nDone. Updated ${updated} receipt(s).`)
}

main().catch((e) => {
  console.error('Migration failed:', e)
  process.exit(1)
})

