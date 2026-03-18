/**
 * Find receipts with missing product.category (nested tree) and set it from
 * product_details or legacy product_category. Optionally backfill transaction.amount.
 * Uses "Other" as fallback when category cannot be inferred.
 * Writes only to the nested tree (product.category, transaction.amount).
 *
 * Run: node scripts/fix-receipt-product-category.js
 * Dry run (list only): DRY_RUN=1 node scripts/fix-receipt-product-category.js
 */

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const FALLBACK_CATEGORY = process.env.FALLBACK_CATEGORY || 'Other'

function inferCategory(receipt) {
  const cat = receipt.product?.category ?? receipt.product_category ?? receipt.productCategory
  if (cat && String(cat).trim()) return String(cat).trim()
  const pd = receipt.product_details
  if (pd?.mf) return 'MF'
  if (pd?.fd) return 'FD'
  if (pd?.bond) return 'BOND'
  if (pd?.ins) return 'INS'
  if (pd?.misc) return 'MISC'
  return FALLBACK_CATEGORY
}

function inferAmount(receipt, category) {
  const txn = receipt.transaction
  if (txn?.amount != null) {
    const n = Number(txn.amount)
    if (!isNaN(n)) return n
  }
  if (receipt.product_details?.fd?.deposit?.amount != null) {
    const n = Number(receipt.product_details.fd.deposit.amount)
    if (!isNaN(n)) return n
  }
  if (receipt.investment_amount != null) {
    const n = Number(receipt.investment_amount)
    if (!isNaN(n)) return n
  }
  if (receipt.fd_deposit_amount != null) {
    const n = Number(receipt.fd_deposit_amount)
    if (!isNaN(n)) return n
  }
  if (receipt.service_price != null) {
    const n = Number(receipt.service_price)
    if (!isNaN(n)) return n
  }
  return null
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN (no updates)\n' : 'Fix missing product.category (nested tree) on receipts\n')

  const rows = await q(`
    FOR receipt IN receipts
      FILTER receipt.is_deleted != true
      LET hasCategory = receipt.product != null && receipt.product.category != null && receipt.product.category != ""
      FILTER !hasCategory
      LIMIT 5000
      RETURN {
        _key: receipt._key,
        receipt_no: receipt.receipt_no,
        date: receipt.date,
        product: receipt.product,
        product_details: receipt.product_details,
        product_category: receipt.product_category,
        transaction: receipt.transaction,
        investment_amount: receipt.investment_amount,
        fd_deposit_amount: receipt.fd_deposit_amount,
        service_price: receipt.service_price
      }
  `)

  if (!rows.length) {
    console.log('No receipts with missing product.category.')
    return
  }

  console.log(`Found ${rows.length} receipt(s) with missing product.category.\n`)

  let updated = 0
  let noInfer = 0
  const receiptsColl = getCollection('receipts')

  for (const r of rows) {
    const category = inferCategory(r)
    const amount = inferAmount(r, category)

    const updates = {}
    updates.product = { ...(r.product && typeof r.product === 'object' ? r.product : {}), category }
    if (amount != null && (r.transaction == null || r.transaction.amount == null)) {
      updates.transaction = { ...(r.transaction && typeof r.transaction === 'object' ? r.transaction : {}), amount }
    }
    if (category === FALLBACK_CATEGORY) noInfer++
    console.log(`  ${r.receipt_no} (${r._key}) → product.category=${category}${category === FALLBACK_CATEGORY ? ' (fallback)' : ''}${updates.transaction?.amount != null ? `, transaction.amount=${updates.transaction.amount}` : ''}`)

    if (!DRY_RUN) {
      await receiptsColl.update(r._key, updates)
      updated++
    }
  }

  if (DRY_RUN) {
    console.log(`\nWould update ${rows.length} receipt(s) (${noInfer} using fallback "${FALLBACK_CATEGORY}"). Run without DRY_RUN=1 to apply.`)
  } else {
    console.log(`\nUpdated ${updated} receipt(s) (${noInfer} set to fallback "${FALLBACK_CATEGORY}").`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
