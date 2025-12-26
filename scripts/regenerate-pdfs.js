/**
 * Script to regenerate all receipt PDFs with the new design
 * Run with: node scripts/regenerate-pdfs.js
 */

import { q, getCollection } from '../config/database.js'
import { generateReceiptPDF } from '../routes/receipt-pdf.js'

async function regenerateAllPDFs() {
  try {
    console.log('Starting PDF regeneration...')
    
    // Get all receipts
    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      RETURN receipt
    `)
    
    if (!receipts.length) {
      console.log('No receipts found to regenerate')
      return
    }
    
    console.log(`Found ${receipts.length} receipts to regenerate`)
    
    const receiptsCollection = getCollection('receipts')
    let generated = 0
    let errors = 0
    const batchSize = 50
    
    // Process in batches
    for (let i = 0; i < receipts.length; i += batchSize) {
      const batch = receipts.slice(i, i + batchSize)
      
      await Promise.all(batch.map(async (receipt) => {
        try {
          const receiptId = receipt._key || receipt.id
          const receiptNo = receipt.receipt_no || receipt.receiptNo
          
          console.log(`Regenerating PDF for receipt ${receiptNo} (${receiptId})...`)
          
          const pdfBuffer = await generateReceiptPDF(receipt)
          
          await receiptsCollection.update(receiptId, {
            pdf_data: pdfBuffer.toString('base64'),
            pdf_generated_at: new Date().toISOString()
          })
          
          generated++
          console.log(`✓ Generated PDF for receipt ${receiptNo}`)
        } catch (error) {
          errors++
          const receiptNo = receipt.receipt_no || receipt.receiptNo
          console.error(`✗ Error generating PDF for receipt ${receiptNo}:`, error.message)
        }
      }))
      
      console.log(`Progress: ${Math.min(i + batchSize, receipts.length)}/${receipts.length} receipts processed`)
    }
    
    console.log('\n=== PDF Regeneration Complete ===')
    console.log(`Total receipts: ${receipts.length}`)
    console.log(`Successfully generated: ${generated}`)
    console.log(`Errors: ${errors}`)
    
  } catch (error) {
    console.error('Fatal error during PDF regeneration:', error)
    process.exit(1)
  }
}

// Run the regeneration
regenerateAllPDFs()
  .then(() => {
    console.log('Script completed successfully')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Script failed:', error)
    process.exit(1)
  })

