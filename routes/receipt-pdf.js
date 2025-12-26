import express from 'express'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const router = express.Router()

// Generate professional receipt PDF matching traditional receipt format
export function generateReceiptPDF(receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' })
    const buffers = []
    
    doc.on('data', buffers.push.bind(buffers))
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers)
      resolve(pdfBuffer)
    })
    doc.on('error', reject)
    
    try {
      // Helper to add key-value pair in traditional format (compact spacing)
      const addField = (label, value, x, y, labelWidth = 180, valueWidth = 300) => {
        if (!value || value === 'N/A' || value === '—') {
          doc.fontSize(9).font('Helvetica').fillColor('#666').text(label + ':', x, y, { width: labelWidth })
          doc.fontSize(9).font('Helvetica').fillColor('#000').text('N/A', x + labelWidth, y, { width: valueWidth })
          return y + 15
        }
        doc.fontSize(9).font('Helvetica').fillColor('#666').text(label + ':', x, y, { width: labelWidth })
        doc.fontSize(9).font('Helvetica').fillColor('#000').text(String(value), x + labelWidth, y, { width: valueWidth })
        return y + 15
      }
      
      let yPos = 40
      
      // Page number (top right)
      doc.fontSize(8).font('Helvetica').fillColor('#666').text('Page 1 of 1', 450, yPos, { align: 'right' })
      yPos += 12
      
      // Date and Receipt ID (top right)
      const dateStr = receipt.date ? new Date(receipt.date).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN')
      const receiptNo = receipt.receipt_no || receipt.receiptNo || 'N/A'
      const receiptId = `ECS-${dateStr.replace(/\//g, '')}-${receiptNo}`
      
      doc.fontSize(9).font('Helvetica').fillColor('#000').text(`Date: ${dateStr}`, 400, yPos, { align: 'right', width: 150 })
      yPos += 12
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text(`Receipt ID: ${receiptId}`, 400, yPos, { align: 'right', width: 150 })
      yPos += 15
      
      // Logo and Company Header (smaller)
      const logoPath = path.join(__dirname, '../assets/ecs-logo.png')
      try {
        if (fs.existsSync(logoPath)) {
          doc.image(logoPath, 50, yPos, { width: 45, height: 45 })
        }
      } catch (error) {
        console.warn('Could not load logo:', error.message)
      }
      
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#dc2626').text('ECS Financial', 105, yPos + 8)
      doc.fontSize(8).font('Helvetica').fillColor('#666').text('AMFI Regd. Mutual Fund Distributor', 105, yPos + 25)
      
      yPos += 60
      
      // Divider line
      doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#000').lineWidth(1).stroke()
      yPos += 12
      
      // ACKNOWLEDGEMENT RECEIPT Section Header
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('ACKNOWLEDGEMENT RECEIPT', 50, yPos)
      yPos += 18
      
      // Branch / Place and Relationship Manager Section
      yPos = addField('Branch / Place', receipt.branch || 'N/A', 50, yPos)
      yPos = addField('Relationship Manager', receipt.employee_name || receipt.employeeName || 'N/A', 50, yPos)
      yPos = addField('Manager Mobile', receipt.employee_mobile || 'N/A', 50, yPos)
      yPos = addField('Email ID (Manager)', receipt.employee_email || receipt.email || 'N/A', 50, yPos)
      
      yPos += 8
      
      // Investor Details Section
      yPos = addField('Investor Name', receipt.investor_name || receipt.investorName || 'N/A', 50, yPos)
      yPos = addField('Investor ID', receipt.investor_id || receipt.investorId || 'N/A', 50, yPos)
      yPos = addField('Mobile Number (Investor)', receipt.investor_mobile || receipt.mobile || 'N/A', 50, yPos)
      yPos = addField('PAN', receipt.pan || 'N/A', 50, yPos)
      yPos = addField('Email ID (Investor)', receipt.email || 'N/A', 50, yPos)
      
      yPos += 12
      
      // Divider line
      doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#000').lineWidth(1).stroke()
      yPos += 12
      
      // Investment Details Section
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Investment Details', 50, yPos)
      yPos += 18
      
      // Product category box (red shade box) - smaller
      const productCategory = receipt.product_category || receipt.productCategory || 'Mutual Funds'
      const boxHeight = 22
      // Light red shade background
      doc.rect(50, yPos, 495, boxHeight).fillColor('#fee2e2').fill()
      doc.rect(50, yPos, 495, boxHeight).strokeColor('#dc2626').lineWidth(1).stroke()
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#dc2626').text(productCategory, 60, yPos + 6)
      yPos += boxHeight + 10
      
      // Investment fields
      if (receipt.amc_name || receipt.amc_code) {
        yPos = addField('AMC Name', receipt.amc_name || receipt.amc_code, 50, yPos)
      }
      
      if (receipt.scheme_name || receipt.schemeName) {
        const schemeName = receipt.scheme_name || receipt.schemeName
        const nfoTag = receipt.scheme_is_nfo ? ' [NFO]' : ''
        yPos = addField('Target Scheme', schemeName + nfoTag, 50, yPos)
      }
      
      if (receipt.switch_from_scheme_name || receipt.from_scheme_name) {
        yPos = addField('Existing Scheme', receipt.switch_from_scheme_name || receipt.from_scheme_name, 50, yPos)
      }
      
      if (receipt.scheme_plan || receipt.plan) {
        yPos = addField('Plan', receipt.scheme_plan || receipt.plan, 50, yPos)
      }
      
      if (receipt.scheme_option || receipt.schemeOption) {
        const option = receipt.scheme_option || receipt.schemeOption
        let optionText = option
        if (option === 'GROWTH') optionText = 'GROWTH'
        else if (option === 'IDCW_PAYOUT') optionText = 'IDCW - Payout'
        else if (option === 'IDCW_REINVEST') optionText = 'IDCW - Reinvestment'
        yPos = addField('Option', optionText, 50, yPos)
      }
      
      if (receipt.transaction_type || receipt.txn_type || receipt.txnType) {
        const txnType = receipt.transaction_type || receipt.txn_type || receipt.txnType
        yPos = addField('Transaction Type', txnType, 50, yPos)
      }
      
      if (receipt.folio_number || receipt.folio_policy_no || receipt.folioPolicyNo) {
        const folioNo = receipt.folio_number || receipt.folio_policy_no || receipt.folioPolicyNo
        yPos = addField('Folio Status', 'Existing Folio', 50, yPos)
        yPos = addField('Number (Folio Number)', folioNo, 50, yPos)
      }
      
      if (receipt.investment_amount || receipt.investmentAmount) {
        const amount = new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: 'INR',
          maximumFractionDigits: 2
        }).format(receipt.investment_amount || receipt.investmentAmount)
        yPos = addField('Amount', amount, 50, yPos)
      }
      
      // Switch Over details
      if (receipt.transaction_type === 'Switch Over' || receipt.txn_type === 'Switch Over') {
        if (receipt.switch_type && receipt.switch_value) {
          const switchValue = receipt.switch_type === 'Amount' 
            ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(receipt.switch_value)
            : `${receipt.switch_value} units`
          yPos = addField('Switch Type', receipt.switch_type, 50, yPos)
          yPos = addField('Switch Value', switchValue, 50, yPos)
        }
      }
      
      // SIP details
      if (receipt.transaction_type === 'SIP' || receipt.txn_type === 'SIP') {
        if (receipt.sip_frequency) yPos = addField('SIP Frequency', receipt.sip_frequency, 50, yPos)
        if (receipt.sip_start_date) {
          yPos = addField('Start Date', new Date(receipt.sip_start_date).toLocaleDateString('en-IN'), 50, yPos)
        }
        if (receipt.sip_end_date) {
          yPos = addField('End Date', new Date(receipt.sip_end_date).toLocaleDateString('en-IN'), 50, yPos)
        } else if (receipt.sip_is_perpetual) {
          yPos = addField('Type', 'Perpetual (30 years)', 50, yPos)
        }
      }
      
      // STP details
      if (receipt.transaction_type === 'STP' || receipt.txn_type === 'STP') {
        if (receipt.stp_target_scheme_name) {
          yPos = addField('Target Scheme', receipt.stp_target_scheme_name, 50, yPos)
        }
        if (receipt.stp_original_amount) {
          const originalAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.stp_original_amount)
          yPos = addField('Total Original Scheme Amount', originalAmt, 50, yPos)
        }
        if (receipt.stp_frequency) yPos = addField('STP Frequency', receipt.stp_frequency, 50, yPos)
        if (receipt.stp_start_date) {
          yPos = addField('STP Start Date', new Date(receipt.stp_start_date).toLocaleDateString('en-IN'), 50, yPos)
        }
        if (receipt.stp_amount) {
          const stpAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.stp_amount)
          yPos = addField('Transfer Amount', stpAmt, 50, yPos)
        }
      }
      
      // SWP details
      if (receipt.transaction_type === 'SWP' || receipt.txn_type === 'SWP') {
        if (receipt.swp_frequency) yPos = addField('SWP Frequency', receipt.swp_frequency, 50, yPos)
        if (receipt.swp_start_date) {
          yPos = addField('SWP Start Date', new Date(receipt.swp_start_date).toLocaleDateString('en-IN'), 50, yPos)
        }
        if (receipt.swp_amount) {
          const swpAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.swp_amount)
          yPos = addField('Withdrawal Amount', swpAmt, 50, yPos)
        }
      }
      
      // Branch Manager
      if (receipt.employee_name || receipt.employeeName) {
        const empCode = receipt.emp_code || receipt.empCode || ''
        yPos = addField('Branch Manager', `${receipt.employee_name || receipt.employeeName}${empCode ? ` (${empCode})` : ''}`, 50, yPos)
      }
      
      yPos += 10
      
      // FD Details (if applicable)
      if (receipt.fd_issuer_name) {
        doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#000').lineWidth(1).stroke()
        yPos += 12
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Fixed Deposit Details', 50, yPos)
        yPos += 18
        
        // FD category box (red shade) - smaller
        doc.rect(50, yPos, 495, 22).fillColor('#fee2e2').fill()
        doc.rect(50, yPos, 495, 22).strokeColor('#dc2626').lineWidth(1).stroke()
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#dc2626').text('Fixed Deposit', 60, yPos + 6)
        yPos += 32
        
        yPos = addField('Issuer', receipt.fd_issuer_name + (receipt.fd_issuer_type ? ` (${receipt.fd_issuer_type})` : ''), 50, yPos)
        if (receipt.fd_scheme_name) yPos = addField('Scheme', receipt.fd_scheme_name, 50, yPos)
        if (receipt.fd_deposit_amount) {
          const amount = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.fd_deposit_amount)
          yPos = addField('Deposit Amount', amount, 50, yPos)
        }
        if (receipt.fd_tenure_months) {
          yPos = addField('Tenure', `${receipt.fd_tenure_months} months (${Math.floor(receipt.fd_tenure_months/12)} years)`, 50, yPos)
        }
        if (receipt.fd_payout_frequency) {
          yPos = addField('Payout Frequency', receipt.fd_payout_frequency, 50, yPos)
        }
        if (receipt.fd_locked_interest_rate_pa) {
          yPos = addField('Interest Rate', `${receipt.fd_locked_interest_rate_pa.toFixed(2)}% p.a.`, 50, yPos)
        }
        if (receipt.fd_maturity_amount) {
          const maturityAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.fd_maturity_amount)
          yPos = addField('Maturity Amount', maturityAmt, 50, yPos)
        }
        if (receipt.fd_maturity_date) {
          yPos = addField('Maturity Date', new Date(receipt.fd_maturity_date).toLocaleDateString('en-IN'), 50, yPos)
        }
        if (receipt.fd_application_number) {
          yPos = addField('Application/FD Number', receipt.fd_application_number, 50, yPos)
        }
        if (receipt.fd_transaction_type || receipt.txn_type) {
          yPos = addField('Transaction Type', receipt.fd_transaction_type || receipt.txn_type || 'Fresh', 50, yPos)
        }
        if (receipt.fd_transaction_type === 'Renewal' && receipt.fd_renewal_investment_type) {
          let renewalText = ''
          if (receipt.fd_renewal_investment_type === 'same') {
            renewalText = 'Same Amount'
          } else if (receipt.fd_renewal_investment_type === 'increased') {
            renewalText = 'Increased Amount'
            if (receipt.fd_renewal_additional_amount) {
              const additionalAmt = new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: 'INR',
                maximumFractionDigits: 2
              }).format(receipt.fd_renewal_additional_amount)
              renewalText += ` (Additional: ${additionalAmt})`
            }
          } else if (receipt.fd_renewal_investment_type === 'decreased') {
            renewalText = 'Decreased Amount'
            if (receipt.fd_renewal_additional_amount) {
              const withdrawalAmt = new Intl.NumberFormat('en-IN', {
                style: 'currency',
                currency: 'INR',
                maximumFractionDigits: 2
              }).format(receipt.fd_renewal_additional_amount)
              renewalText += ` (Withdrawal: ${withdrawalAmt})`
            }
          }
          yPos = addField('Renewal Investment', renewalText, 50, yPos)
        }
        
        yPos += 10
      }
      
      // Ensure we don't exceed page height (A4 is ~842pt, with margins ~742pt usable)
      // If we're getting close, compress remaining sections
      const maxY = 750
      const remainingSpace = maxY - yPos
      
      // Divider line
      doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#000').lineWidth(1).stroke()
      yPos += 10
      
      // Terms and Conditions (compact)
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('Terms and Conditions:', 50, yPos)
      yPos += 12
      
      doc.fontSize(8).font('Helvetica').fillColor('#000')
      const terms = [
        '• This receipt is proof of payment towards the specified investment and does not guarantee returns.',
        '• Investments are subject to market risks; please read the scheme details carefully before investing.',
        '• For queries, contact your branch manager or visit our website.'
      ]
      
      terms.forEach((term) => {
        doc.text(term, 60, yPos, { width: 485 })
        yPos += 12
      })
      
      yPos += 8
      
      // Thank you message
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text('Thank you for Your Trust', 50, yPos, { align: 'center', width: 495 })
      yPos += 20
      
      // Signature lines
      doc.moveTo(50, yPos).lineTo(545, yPos).strokeColor('#000').lineWidth(0.5).stroke()
      yPos += 12
      
      doc.fontSize(8).font('Helvetica').fillColor('#000').text('Authorized Signature', 50, yPos)
      doc.fontSize(8).font('Helvetica').fillColor('#000').text('Company Stamp', 350, yPos)
      
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

// Generate or get receipt PDF
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    
    // Get receipt
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN receipt
    `, { id: receiptId })
    
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    
    // Check permissions
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    let pdfBuffer
    
    // Check if we should force regeneration
    const forceRegenerate = req.query.force === 'true' || req.query.regenerate === 'true'
    
    // Check if PDF already exists in database
    if (receipt.pdf_data && !forceRegenerate) {
      // PDF exists, convert from base64
      pdfBuffer = Buffer.from(receipt.pdf_data, 'base64')
    } else {
      // PDF doesn't exist or force regenerate, generate it
      pdfBuffer = await generateReceiptPDF(receipt)
      
      // Store PDF in database as base64
      const receiptsCollection = getCollection('receipts')
      
      await receiptsCollection.update(receiptId, {
        pdf_data: pdfBuffer.toString('base64'),
        pdf_generated_at: new Date().toISOString()
      })
    }
    
    // Set response headers for PDF download
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Receipt-${receipt.receipt_no || receipt.receiptNo}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    
    // Send PDF
    res.send(pdfBuffer)
    
  } catch (error) {
    console.error('Error generating receipt PDF:', error)
    res.status(500).json({ error: 'pdf_generation_failed', detail: error.message })
  }
})

// Regenerate PDFs for all existing receipts (Admin only)
router.post('/regenerate-pdfs', requireAuth, async (req, res) => {
  try {
    // Only admins can access this
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'admin_only' })
    }
    
    const { limit = 1000, batchSize = 50 } = req.body
    
    // Get all receipts
    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      LIMIT @limit
      RETURN receipt
    `, { limit })
    
    if (!receipts.length) {
      return res.json({ message: 'no_receipts_found', generated: 0, total: 0 })
    }
    
    const receiptsCollection = getCollection('receipts')
    let generated = 0
    let errors = 0
    const errorDetails = []
    
    // Process in batches to avoid memory issues
    for (let i = 0; i < receipts.length; i += batchSize) {
      const batch = receipts.slice(i, i + batchSize)
      
      await Promise.all(batch.map(async (receipt) => {
        try {
          const pdfBuffer = await generateReceiptPDF(receipt)
          const receiptId = receipt._key || receipt.id
          
          await receiptsCollection.update(receiptId, {
            pdf_data: pdfBuffer.toString('base64'),
            pdf_generated_at: new Date().toISOString()
          })
          
          generated++
        } catch (error) {
          errors++
          errorDetails.push({
            receipt_id: receipt._key || receipt.id,
            receipt_no: receipt.receipt_no || receipt.receiptNo,
            error: error.message
          })
          console.error(`Error generating PDF for receipt ${receipt._key}:`, error)
        }
      }))
      
      // Log progress
      console.log(`Regenerated PDFs: ${Math.min(i + batchSize, receipts.length)}/${receipts.length}`)
    }
    
    res.json({ 
      message: 'pdf_regeneration_complete',
      total_receipts: receipts.length,
      generated,
      errors,
      error_details: errorDetails.length > 0 ? errorDetails : undefined
    })
    
  } catch (error) {
    console.error('Error in PDF regeneration route:', error)
    res.status(500).json({ error: 'operation_failed', detail: error.message })
  }
})

// Generate PDF for a specific receipt (for testing/setup)
router.post('/:id/generate-pdf', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    
    // Only admins can access this
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'admin_only' })
    }
    
    // Get receipt
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN receipt
    `, { id: receiptId })
    
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    
    // Generate PDF
    const pdfBuffer = await generateReceiptPDF(receipt)
    
    // Set response headers for PDF download
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Receipt-${receipt.receipt_no || receipt.receiptNo}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    
    // Send PDF
    res.send(pdfBuffer)
    
  } catch (error) {
    console.error('Error generating receipt PDF:', error)
    res.status(500).json({ error: 'pdf_generation_failed', detail: error.message })
  }
})

export default router
