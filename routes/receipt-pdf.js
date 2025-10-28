import express from 'express'
import PDFDocument from 'pdfkit'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

// Generate professional receipt PDF
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
      // Helper function to add key-value pair with better formatting
      const addKeyValue = (key, value, x, y, maxWidth) => {
        if (!value || value === 'N/A') return y
        
        const labelWidth = 140
        const valueWidth = maxWidth - labelWidth
        
        doc.fontSize(9).font('Helvetica').fillColor('#666').text(key + ':', x, y, { width: labelWidth })
        doc.fontSize(10).font('Helvetica').fillColor('#000').text(String(value), x + labelWidth, y, { width: valueWidth })
        
        return y + 20
      }
      
      // Helper to add section header
      const addSectionHeader = (title, y) => {
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#dc2626').text(title, 50, y)
        // Underline
        const textWidth = doc.widthOfString(title)
        doc.moveTo(50, y + 15).lineTo(50 + textWidth, y + 15).strokeColor('#dc2626').lineWidth(2).stroke()
        return y + 30
      }
      
      // Header Section with Box
      doc.rect(40, 40, 515, 80).strokeColor('#dc2626').lineWidth(2).stroke()
      doc.fontSize(32).font('Helvetica-Bold').fillColor('#dc2626').text('ECS FINANCIAL', 60, 55)
      doc.fontSize(11).font('Helvetica').fillColor('#666').text('AMFI Registered Mutual Fund Distributor', 60, 85)
      
      // Receipt Number and Date (Right Aligned in header box)
      const receiptNo = receipt.receipt_no || receipt.receiptNo || 'N/A'
      const dateStr = receipt.date ? new Date(receipt.date).toLocaleDateString('en-IN') : 'N/A'
      
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#000').text(`Receipt: ${receiptNo}`, { align: 'right', width: 200 })
      doc.fontSize(10).font('Helvetica').fillColor('#666').text(`Date: ${dateStr}`, { align: 'right', width: 200 })
      
      let yPos = 150
      
      // Employee Details Section
      yPos = addSectionHeader('EMPLOYEE INFORMATION', yPos)
      
      yPos = addKeyValue('Name', receipt.employee_name || receipt.employeeName, 60, yPos, 490)
      yPos = addKeyValue('Code', receipt.emp_code || receipt.empCode, 60, yPos, 490)
      yPos = addKeyValue('Branch', receipt.branch, 60, yPos, 490)
      
      yPos += 20
      
      // Investor Details Section
      yPos = addSectionHeader('INVESTOR INFORMATION', yPos)
      
      yPos = addKeyValue('Investor ID', receipt.investor_id || receipt.investorId, 60, yPos, 490)
      yPos = addKeyValue('Name', receipt.investor_name || receipt.investorName, 60, yPos, 490)
      yPos = addKeyValue('PAN', receipt.pan, 60, yPos, 490)
      yPos = addKeyValue('Email', receipt.email, 60, yPos, 490)
      yPos = addKeyValue('PIN Code', receipt.pin_code || receipt.pinCode, 60, yPos, 490)
      yPos = addKeyValue('Address', receipt.investor_address || receipt.investorAddress, 60, yPos, 490)
      
      yPos += 20
      
      // Investment Details Section
      yPos = addSectionHeader('INVESTMENT DETAILS', yPos)
      
      if (receipt.product_category || receipt.productCategory) {
        yPos = addKeyValue('Product Category', receipt.product_category || receipt.productCategory, 60, yPos, 490)
      }
      
      // New MF-specific details
      if (receipt.amc_name || receipt.amc_code) {
        yPos = addKeyValue('AMC', receipt.amc_name || receipt.amc_code, 60, yPos, 490)
      }
      if (receipt.scheme_name || receipt.schemeName) {
        const schemeName = receipt.scheme_name || receipt.schemeName
        const nfoTag = receipt.scheme_is_nfo ? ' [NFO]' : ''
        yPos = addKeyValue('Scheme Name', schemeName + nfoTag, 60, yPos, 490)
      }
      if (receipt.scheme_category) {
        yPos = addKeyValue('Category', `${receipt.scheme_category}${receipt.scheme_sub_category ? ' - ' + receipt.scheme_sub_category : ''}`, 60, yPos, 490)
      }
      if (receipt.scheme_plan && receipt.scheme_type) {
        yPos = addKeyValue('Plan & Type', `${receipt.scheme_plan} - ${receipt.scheme_type}`, 60, yPos, 490)
      }
      if (receipt.folio_number) {
        yPos = addKeyValue('Folio Number', receipt.folio_number, 60, yPos, 490)
      }
      
      // Transaction type details (skip for FD)
      if (receipt.transaction_type && !receipt.fd_issuer_name) {
        yPos += 10
        yPos = addKeyValue('Transaction Type', receipt.transaction_type, 60, yPos, 490)
        
        // SIP details
        if (receipt.transaction_type === 'SIP' && receipt.sip_frequency) {
          yPos = addKeyValue('SIP Frequency', receipt.sip_frequency, 60, yPos, 490)
        }
        if (receipt.sip_start_date) {
          yPos = addKeyValue('Start Date', new Date(receipt.sip_start_date).toLocaleDateString('en-IN'), 60, yPos, 490)
        }
        if (receipt.sip_end_date) {
          yPos = addKeyValue('End Date', new Date(receipt.sip_end_date).toLocaleDateString('en-IN'), 60, yPos, 490)
        } else if (receipt.sip_is_perpetual) {
          yPos = addKeyValue('Type', 'Perpetual (30 years)', 60, yPos, 490)
        }
        
        // SWP details
        if (receipt.transaction_type === 'SWP' && receipt.swp_frequency) {
          yPos = addKeyValue('SWP Frequency', receipt.swp_frequency, 60, yPos, 490)
        }
        if (receipt.swp_start_date) {
          yPos = addKeyValue('SWP Start Date', new Date(receipt.swp_start_date).toLocaleDateString('en-IN'), 60, yPos, 490)
        }
        if (receipt.swp_amount) {
          yPos = addKeyValue('SWP Amount', new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(receipt.swp_amount), 60, yPos, 490)
        }
        
        // STP details
        if (receipt.transaction_type === 'STP' && receipt.stp_target_scheme_name) {
          yPos = addKeyValue('Transfer to Scheme', receipt.stp_target_scheme_name, 60, yPos, 490)
        }
        if (receipt.stp_frequency) {
          yPos = addKeyValue('STP Frequency', receipt.stp_frequency, 60, yPos, 490)
        }
        if (receipt.stp_start_date) {
          yPos = addKeyValue('STP Start Date', new Date(receipt.stp_start_date).toLocaleDateString('en-IN'), 60, yPos, 490)
        }
        if (receipt.stp_amount) {
          yPos = addKeyValue('Transfer Amount', new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(receipt.stp_amount), 60, yPos, 490)
        }
        
        // Switch Over details
        if (receipt.transaction_type === 'Switch Over' && receipt.switch_to_scheme_name) {
          yPos = addKeyValue('Switch to Scheme', receipt.switch_to_scheme_name, 60, yPos, 490)
        }
        if (receipt.switch_from_scheme_name) {
          yPos = addKeyValue('Switch from Scheme', receipt.switch_from_scheme_name, 60, yPos, 490)
        }
        if (receipt.switch_type && receipt.switch_value) {
          const switchValue = receipt.switch_type === 'Amount' 
            ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(receipt.switch_value)
            : `${receipt.switch_value} units`
          yPos = addKeyValue('Switch Value', switchValue, 60, yPos, 490)
        }
      }
      // Skip generic fields for FD receipts
      if (!receipt.fd_issuer_name) {
        if (receipt.txn_type || receipt.txnType) {
          yPos = addKeyValue('Transaction Type', receipt.txn_type || receipt.txnType, 60, yPos, 490)
        }
        if (receipt.mode) {
          yPos = addKeyValue('Mode', receipt.mode, 60, yPos, 490)
        }
        if (receipt.investment_amount || receipt.investmentAmount) {
          const amount = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.investment_amount || receipt.investmentAmount)
          yPos = addKeyValue('Investment Amount', amount, 60, yPos, 490)
        }
        if (receipt.folio_policy_no || receipt.folioPolicyNo) {
          yPos = addKeyValue('Folio/Policy No', receipt.folio_policy_no || receipt.folioPolicyNo, 60, yPos, 490)
        }
        if (receipt.issuer_company || receipt.issuerCompany) {
          yPos = addKeyValue('Issuer Company', receipt.issuer_company || receipt.issuerCompany, 60, yPos, 490)
        }
      }
      
      // FD-specific details
      if (receipt.fd_issuer_name) {
        yPos += 10
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#dc2626').text('FIXED DEPOSIT DETAILS', 60, yPos)
        yPos += 20
        
        yPos = addKeyValue('Issuer', receipt.fd_issuer_name + (receipt.fd_issuer_type ? ` (${receipt.fd_issuer_type})` : ''), 60, yPos, 490)
        yPos = addKeyValue('Scheme', receipt.fd_scheme_name, 60, yPos, 490)
        if (receipt.fd_deposit_amount) {
          const amount = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.fd_deposit_amount)
          yPos = addKeyValue('Deposit Amount', amount, 60, yPos, 490)
        }
        if (receipt.fd_tenure_months) {
          yPos = addKeyValue('Tenure', `${receipt.fd_tenure_months} months (${Math.floor(receipt.fd_tenure_months/12)} years)`, 60, yPos, 490)
        }
        if (receipt.fd_payout_frequency) {
          yPos = addKeyValue('Payout Frequency', receipt.fd_payout_frequency, 60, yPos, 490)
        }
        if (receipt.fd_locked_interest_rate_pa) {
          yPos = addKeyValue('Interest Rate', `${receipt.fd_locked_interest_rate_pa.toFixed(2)}% p.a.`, 60, yPos, 490)
        }
        if (receipt.fd_maturity_amount) {
          const maturityAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.fd_maturity_amount)
          yPos = addKeyValue('Maturity Amount', maturityAmt, 60, yPos, 490)
        }
        if (receipt.fd_maturity_date) {
          yPos = addKeyValue('Maturity Date', new Date(receipt.fd_maturity_date).toLocaleDateString('en-IN'), 60, yPos, 490)
        }
        if (receipt.fd_application_number) {
          yPos = addKeyValue('Application/FD Number', receipt.fd_application_number, 60, yPos, 490)
        }
      }
      
      // Additional details in two columns
      if (receipt.scheme_option || receipt.schemeOption || receipt.roi_percent || receipt.roi || 
          receipt.period_installments || receipt.deposit_period_ym) {
        yPos += 10
        const additionalDetails = []
        if (receipt.scheme_option || receipt.schemeOption) additionalDetails.push(['Scheme Option', receipt.scheme_option || receipt.schemeOption])
        if (receipt.roi_percent || receipt.roi) additionalDetails.push(['ROI', `${receipt.roi_percent || receipt.roi}%`])
        if (receipt.deposit_period_ym || receipt.depositPeriodYM) additionalDetails.push(['Period', receipt.deposit_period_ym || receipt.depositPeriodYM])
        if (receipt.fd_type || receipt.fdType) additionalDetails.push(['FD Type', receipt.fd_type || receipt.fdType])
        
        // Display in two columns with better alignment
        const leftCol = 60
        const rightCol = 320
        additionalDetails.forEach((detail, index) => {
          const col = (index % 2 === 0) ? leftCol : rightCol
          const row = Math.floor(index / 2)
          addKeyValue(detail[0], detail[1], col, yPos + (row * 20), 250)
        })
        
        yPos += (Math.ceil(additionalDetails.length / 2) * 20)
      }
      
      // Footer
      if (yPos > 700) {
        doc.addPage()
        yPos = 50
      }
      
      yPos += 30
      doc.moveTo(60, yPos).lineTo(530, yPos).strokeColor('#ddd').lineWidth(1).stroke()
      yPos += 25
      
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000').text('Notes:', 60, yPos)
      yPos += 15
      doc.fontSize(8).font('Helvetica').fillColor('#666')
      doc.text('• This is a system generated receipt.', 70, yPos)
      yPos += 12
      doc.text('• For any queries, please contact your relationship manager.', 70, yPos)
      yPos += 12
      doc.text('• Thank you for your business with ECS Financial.', 70, yPos)
      yPos += 20
      
      // Signature line
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#000').text('Signature: _______________________', 60, yPos)
      
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
    
    // Check if PDF already exists in database
    if (receipt.pdf_data) {
      // PDF exists, convert from base64
      pdfBuffer = Buffer.from(receipt.pdf_data, 'base64')
    } else {
      // PDF doesn't exist, generate it
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

// Generate PDFs for all existing receipts (Admin only)
router.post('/generate-pdfs', requireAuth, async (req, res) => {
  try {
    // Only admins can access this
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'admin_only' })
    }
    
    const { limit = 100 } = req.body
    
    // Get all receipts
    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      LIMIT @limit
      RETURN receipt
    `, { limit })
    
    if (!receipts.length) {
      return res.json({ message: 'no_receipts_found', generated: 0 })
    }
    
    // Return success - PDFs will be generated on demand when accessed
    res.json({ 
      message: 'pdf_generation_ready',
      total_receipts: receipts.length,
      info: 'PDFs will be generated on-demand when users download receipts'
    })
    
  } catch (error) {
    console.error('Error in PDF generation route:', error)
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

