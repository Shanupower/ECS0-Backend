/**
 * Mirrors POST /api/receipts/regenerate-pdfs (admin): enrich, normalize category, generate PDF, persist.
 * Use when you want bulk regeneration without HTTP + admin Bearer token.
 *
 * Examples:
 *   node scripts/regenerate-pdfs-bulk-direct.js --category=GOVT_FD
 *   node scripts/regenerate-pdfs-bulk-direct.js --all --limit=500 --batchSize=25
 */

import { q, getCollection } from '../config/database.js'
import {
  generateReceiptPDF,
  enrichReceiptWithCustomerMobile,
} from '../routes/receipt-pdf.js'
import { normalizeReceiptCategory } from '../utils/receipt-category.js'

function parseArgs() {
  const out = { category: null, all: false, limit: 1000, batchSize: 50 }
  for (const a of process.argv.slice(2)) {
    if (a === '--all') out.all = true
    else if (a.startsWith('--category=')) out.category = a.slice('--category='.length).trim().toUpperCase()
    else if (a.startsWith('--limit=')) out.limit = Math.max(1, Number(a.slice('--limit='.length)) || 1000)
    else if (a.startsWith('--batchSize=')) out.batchSize = Math.max(1, Number(a.slice('--batchSize='.length)) || 50)
  }
  if (!out.all && !out.category) out.category = 'GOVT_FD'
  return out
}

async function main() {
  const { category, all, limit, batchSize } = parseArgs()

  const filterClause = all
    ? ''
    : `
      LET cat = UPPER(TRIM(receipt.product.category || receipt.product_category || ''))
      FILTER cat == @category
    `

  const receipts = await q(
    `
    FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      ${filterClause}
      LIMIT @limit
      RETURN receipt
    `,
    all ? { limit } : { limit, category }
  )

  if (!receipts.length) {
    console.log('No receipts matched.')
    return
  }

  console.log(
    `Regenerating ${receipts.length} receipt PDF(s) (${all ? 'all categories' : `category=${category}`}, limit=${limit})…`
  )

  const receiptsCollection = getCollection('receipts')
  let generated = 0
  let errors = 0

  for (let i = 0; i < receipts.length; i += batchSize) {
    const batch = receipts.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (receipt) => {
        try {
          const { receipt: rec } = await enrichReceiptWithCustomerMobile(receipt)
          const normalized = normalizeReceiptCategory(rec)
          const pdfBuffer = await generateReceiptPDF(normalized)
          await receiptsCollection.update(receipt._key || receipt.id, {
            pdf_data: pdfBuffer.toString('base64'),
            pdf_generated_at: new Date().toISOString(),
          })
          generated++
          console.log(
            `✓ ${receipt.receipt_no || receipt.receiptNo || receipt._key}`
          )
        } catch (e) {
          errors++
          console.error(
            `✗ ${receipt.receipt_no || receipt.receiptNo || receipt._key}:`,
            e.message
          )
        }
      })
    )
    console.log(`Progress: ${Math.min(i + batchSize, receipts.length)}/${receipts.length}`)
  }

  console.log(`Done. generated=${generated} errors=${errors}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
