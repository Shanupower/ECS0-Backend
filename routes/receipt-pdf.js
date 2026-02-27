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

// Format INR for PDF using "Rs." (Helvetica has no Rupee symbol)
function fmtINR(num, maxFractionDigits = 2) {
  if (num == null || num === '') return ''
  const n = Number(num)
  if (isNaN(n)) return String(num)
  const formatted = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: maxFractionDigits === 0 ? 0 : 2
  }).format(n)
  return 'Rs. ' + formatted
}

// Generate professional receipt PDF — single page, presentable layout
export function generateReceiptPDF(receipt) {
  return new Promise((resolve, reject) => {
    const margin = 36
    const pageWidth = 595
    const pageHeight = 842
    const contentRight = pageWidth - margin
    const contentWidth = contentRight - margin
    const maxY = pageHeight - margin

    const doc = new PDFDocument({ margin, size: 'A4' })
    const buffers = []
    
    doc.on('data', buffers.push.bind(buffers))
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers)
      resolve(pdfBuffer)
    })
    doc.on('error', reject)
    
    try {
      // Compact line spacing so receipt fits on one page (maxY ~806)
      const addField = (label, value, x, y, labelWidth = 180, valueWidth = 300, lineSpacing = 10) => {
        if (!value || value === 'N/A' || value === '—') {
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text(label + ':', x, y, { width: labelWidth })
          doc.fontSize(8).font('Helvetica').fillColor('#6B7280').text('N/A', x + labelWidth, y, { width: valueWidth })
          return y + lineSpacing
        }
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text(label + ':', x, y, { width: labelWidth })
        const textHeight = doc.heightOfString(String(value), { width: valueWidth })
        const lines = Math.ceil(textHeight / 9)
        const actualHeight = Math.max(lineSpacing, (lines * 9) + 2)
        doc.fontSize(8).font('Helvetica').fillColor('#111827').text(String(value), x + labelWidth, y, { width: valueWidth, lineGap: 1 })
        return y + actualHeight
      }
      
      let yPos = margin
      
      // Header: logo only at true aspect ratio; Date & Receipt No box on right
      const logoPath = path.join(__dirname, '../assets/ecs-logo.png')
      const logoWidth = 80  // desired width in pt; height follows from image aspect ratio
      const boxWidth = 158
      const boxX = contentRight - boxWidth
      const boxHeight = 48
      let logoDisplayHeight = logoWidth

      try {
        if (fs.existsSync(logoPath)) {
          const img = doc.openImage(logoPath)
          logoDisplayHeight = logoWidth * (img.height / img.width)
          doc.image(logoPath, margin, yPos, { width: logoWidth })
        }
      } catch (error) {
        console.warn('Could not load logo:', error.message)
      }
      
      const dateStr = receipt.date ? new Date(receipt.date).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN')
      const receiptNo = (receipt.receipt_no || receipt.receiptNo || 'N/A').toString()
      
      doc.rect(boxX, yPos, boxWidth, boxHeight).fillColor('#FEF2F2').fill()
      doc.rect(boxX, yPos, boxWidth, boxHeight).strokeColor('#DC2626').lineWidth(1).stroke()
      doc.fontSize(7).font('Helvetica').fillColor('#6B7280').text('Date', boxX + 6, yPos + 6)
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827').text(dateStr, boxX + 6, yPos + 14)
      doc.fontSize(7).font('Helvetica').fillColor('#6B7280').text('Receipt No', boxX + 6, yPos + 28)
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#DC2626').text(receiptNo, boxX + 6, yPos + 34, { width: boxWidth - 12 })
      
      yPos += Math.max(logoDisplayHeight, boxHeight) + 10
      
      doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#DC2626').lineWidth(2).stroke()
      yPos += 10
      
      // ACKNOWLEDGEMENT RECEIPT
      doc.rect(margin, yPos, contentWidth, 18).fillColor('#FEF2F2').fill()
      doc.rect(margin, yPos, contentWidth, 18).strokeColor('#DC2626').lineWidth(1.5).stroke()
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#DC2626').text('ACKNOWLEDGEMENT RECEIPT', margin + 10, yPos + 3, { align: 'center', width: contentWidth - 20 })
      yPos += 24
      
      // Branch / Place and Relationship Manager
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text('Branch & Relationship Manager', margin, yPos)
      yPos += 10
      
      // Resolve employee/investor from nested (employee: { name, code, branch }) or flat keys
      const branch = receipt.employee?.branch ?? receipt.branch ?? 'N/A'
      const employeeName = receipt.employee?.name ?? receipt.employee_name ?? receipt.employeeName ?? 'N/A'
      const employeeMobile = receipt.employee?.mobile ?? receipt.employee_mobile ?? 'N/A'
      const employeeEmail = receipt.employee?.email ?? receipt.employee_email ?? receipt.email ?? 'N/A'
      const investorName = receipt.investor?.name ?? receipt.investor_name ?? receipt.investorName ?? 'N/A'
      const investorId = receipt.investor?.id ?? receipt.investor_id ?? receipt.investorId ?? 'N/A'
      const investorMobile = receipt.investor?.mobile ?? receipt.investor_mobile ?? receipt.mobile ?? 'N/A'
      const investorPan = receipt.investor?.pan ?? receipt.pan ?? 'N/A'
      const investorEmail = receipt.investor?.email ?? receipt.email ?? 'N/A'

      yPos = addField('Branch / Place', branch, margin, yPos)
      yPos = addField('Relationship Manager', employeeName, margin, yPos)
      yPos = addField('Manager Code', receipt.employee?.code ?? receipt.emp_code ?? receipt.empCode ?? 'N/A', margin, yPos)
      yPos = addField('Manager Mobile', employeeMobile, margin, yPos)
      yPos = addField('Email ID (Manager)', employeeEmail, margin, yPos)
      
      yPos += 6
      doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
      yPos += 6
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text('Investor Details', margin, yPos)
      yPos += 10
      
      yPos = addField('Investor Name', investorName, margin, yPos)
      yPos = addField('Investor ID', investorId, margin, yPos)
      yPos = addField('Mobile Number (Investor)', investorMobile, margin, yPos)
      yPos = addField('PAN', investorPan, margin, yPos)
      yPos = addField('Email ID (Investor)', investorEmail, margin, yPos)
      const investorAddress = receipt.investor?.address
      const addressStr = typeof investorAddress === 'object' && investorAddress
        ? [investorAddress.line1, investorAddress.line2, investorAddress.line3].filter(Boolean).join('\n') || null
        : (receipt.investor_address ?? receipt.investorAddress ?? null)
      if (addressStr) yPos = addField('Address', addressStr, margin, yPos)
      const pinCode = (typeof investorAddress === 'object' && investorAddress?.pin_code) ?? receipt.pin_code ?? receipt.pinCode
      if (pinCode) yPos = addField('PIN Code', pinCode, margin, yPos)
      
      yPos += 6
      doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
      yPos += 6
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text('Investment Details', margin, yPos)
      yPos += 10
      
      const productCategory = receipt.product_category || receipt.productCategory || receipt.product?.category || 'Mutual Funds'
      const productCategoryUpper = String(productCategory || '').toUpperCase()
      const categoryBoxHeight = 18
      doc.rect(margin, yPos, contentWidth, categoryBoxHeight).fillColor('#FEF2F2').fill()
      doc.rect(margin, yPos, contentWidth, categoryBoxHeight).strokeColor('#DC2626').lineWidth(1.5).stroke()
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(productCategory, margin + 10, yPos + 4)
      yPos += categoryBoxHeight + 8
      
      // Investment fields
      if (receipt.amc_name || receipt.amc_code) {
        yPos = addField('AMC Name', receipt.amc_name || receipt.amc_code, margin, yPos)
      }
      
      if (receipt.scheme_name || receipt.schemeName || receipt.product?.name) {
        const schemeName = receipt.scheme_name || receipt.schemeName || receipt.product?.name
        const nfoTag = receipt.scheme_is_nfo || receipt.product_details?.mf?.scheme?.is_nfo ? ' [NFO]' : ''
        yPos = addField('Target Scheme', schemeName + nfoTag, margin, yPos, 180, 300, 10)
      }
      
      if (receipt.switch_from_scheme_name || receipt.from_scheme_name) {
        yPos = addField('Existing Scheme', receipt.switch_from_scheme_name || receipt.from_scheme_name, margin, yPos)
      }
      
      if (receipt.scheme_plan || receipt.plan) {
        yPos = addField('Plan', receipt.scheme_plan || receipt.plan, margin, yPos)
      }
      
      if (receipt.scheme_option || receipt.schemeOption) {
        const option = receipt.scheme_option || receipt.schemeOption
        let optionText = option
        if (option === 'GROWTH') optionText = 'GROWTH'
        else if (option === 'IDCW_PAYOUT') optionText = 'IDCW - Payout'
        else if (option === 'IDCW_REINVEST') optionText = 'IDCW - Reinvestment'
        yPos = addField('Option', optionText, margin, yPos)
      }
      
      if (receipt.transaction_type || receipt.txn_type || receipt.txnType) {
        const txnType = receipt.transaction_type || receipt.txn_type || receipt.txnType
        yPos = addField('Transaction Type', txnType, margin, yPos)
      }
      
      if (receipt.folio_number || receipt.folio_policy_no || receipt.folioPolicyNo) {
        const folioNo = receipt.folio_number || receipt.folio_policy_no || receipt.folioPolicyNo
        yPos = addField('Folio Status', 'Existing Folio', margin, yPos)
        yPos = addField('Number (Folio Number)', folioNo, margin, yPos)
      }
      
      if (receipt.investment_amount || receipt.investmentAmount) {
        const amount = fmtINR(receipt.investment_amount || receipt.investmentAmount)
        // Highlight amount with larger font
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('Investment Amount:', margin, yPos, { width: 180 })
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(amount, margin + 180, yPos - 2, { width: contentWidth - (margin + 180) })
        yPos += 18
      }
      
      // Switch Over details
      if (receipt.transaction_type === 'Switch Over' || receipt.txn_type === 'Switch Over') {
        if (receipt.switch_type && receipt.switch_value) {
          const switchValue = receipt.switch_type === 'Amount' 
            ? fmtINR(receipt.switch_value, 2)
            : `${receipt.switch_value} units`
          yPos = addField('Switch Type', receipt.switch_type, margin, yPos)
          yPos = addField('Switch Value', switchValue, margin, yPos)
        }
      }
      
      // SIP details
      if (receipt.transaction_type === 'SIP' || receipt.txn_type === 'SIP') {
        if (receipt.sip_frequency) yPos = addField('SIP Frequency', receipt.sip_frequency, margin, yPos)
        if (receipt.sip_start_date) {
          yPos = addField('Start Date', new Date(receipt.sip_start_date).toLocaleDateString('en-IN'), margin, yPos)
        }
        if (receipt.sip_end_date) {
          yPos = addField('End Date', new Date(receipt.sip_end_date).toLocaleDateString('en-IN'), margin, yPos)
        } else if (receipt.sip_is_perpetual) {
          yPos = addField('Type', 'Perpetual (40 years)', margin, yPos)
        }
      }
      
      // STP details
      if (receipt.transaction_type === 'STP' || receipt.txn_type === 'STP') {
        if (receipt.stp_target_scheme_name) {
          yPos = addField('Target Scheme', receipt.stp_target_scheme_name, margin, yPos)
        }
        if (receipt.stp_original_amount) {
          const originalAmt = fmtINR(receipt.stp_original_amount)
          yPos = addField('Total Original Scheme Amount', originalAmt, margin, yPos)
        }
        if (receipt.stp_frequency) yPos = addField('STP Frequency', receipt.stp_frequency, margin, yPos)
        if (receipt.stp_start_date) {
          yPos = addField('STP Start Date', new Date(receipt.stp_start_date).toLocaleDateString('en-IN'), margin, yPos)
        }
        if (receipt.stp_amount) {
          const stpAmt = fmtINR(receipt.stp_amount)
          yPos = addField('Transfer Amount', stpAmt, margin, yPos)
        }
      }
      
      // SWP details
      if (receipt.transaction_type === 'SWP' || receipt.txn_type === 'SWP') {
        if (receipt.swp_frequency) yPos = addField('SWP Frequency', receipt.swp_frequency, margin, yPos)
        if (receipt.swp_start_date) {
          yPos = addField('SWP Start Date', new Date(receipt.swp_start_date).toLocaleDateString('en-IN'), margin, yPos)
        }
        if (receipt.swp_amount) {
          const swpAmt = fmtINR(receipt.swp_amount)
          yPos = addField('Withdrawal Amount', swpAmt, margin, yPos)
        }
      }
      
      yPos += 10
      
      // FD Details (if applicable)
      if (receipt.fd_issuer_name) {
        doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 8
        
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#111827').text('Fixed Deposit Details', margin, yPos)
        yPos += 14
        
        doc.rect(margin, yPos, contentWidth, 22).fillColor('#FEF2F2').fill()
        doc.rect(margin, yPos, contentWidth, 22).strokeColor('#DC2626').lineWidth(1.5).stroke()
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#DC2626').text('Fixed Deposit', margin + 10, yPos + 6)
        yPos += 28
        
        yPos = addField('Issuer', receipt.fd_issuer_name + (receipt.fd_issuer_type ? ` (${receipt.fd_issuer_type})` : ''), margin, yPos)
        if (receipt.fd_scheme_name) yPos = addField('Scheme', receipt.fd_scheme_name, margin, yPos)
        if (receipt.fd_deposit_amount) {
          const amount = fmtINR(receipt.fd_deposit_amount)
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('Deposit Amount:', margin, yPos, { width: 180 })
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(amount, margin + 180, yPos - 2, { width: contentWidth - (margin + 180) })
          yPos += 18
        }
        if (receipt.fd_tenure_months) {
          yPos = addField('Tenure', `${receipt.fd_tenure_months} months (${Math.floor(receipt.fd_tenure_months/12)} years)`, margin, yPos)
        }
        if (receipt.fd_payout_frequency) {
          yPos = addField('Payout Frequency', receipt.fd_payout_frequency, margin, yPos)
        }
        if (receipt.fd_locked_interest_rate_pa) {
          yPos = addField('Interest Rate', `${receipt.fd_locked_interest_rate_pa.toFixed(2)}% p.a.`, margin, yPos)
        }
        if (receipt.fd_maturity_amount) {
          const maturityAmt = fmtINR(receipt.fd_maturity_amount)
          yPos = addField('Maturity Amount', maturityAmt, margin, yPos)
        }
        if (receipt.fd_maturity_date) {
          yPos = addField('Maturity Date', new Date(receipt.fd_maturity_date).toLocaleDateString('en-IN'), margin, yPos)
        }
        if (receipt.fd_application_number) {
          yPos = addField('Application/FD Number', receipt.fd_application_number, margin, yPos)
        }
        if (receipt.fd_transaction_type || receipt.txn_type) {
          yPos = addField('Transaction Type', receipt.fd_transaction_type || receipt.txn_type || 'Fresh', margin, yPos)
        }
        if (receipt.fd_transaction_type === 'Renewal' && receipt.fd_renewal_investment_type) {
          let renewalText = ''
          if (receipt.fd_renewal_investment_type === 'same') {
            renewalText = 'Same Amount'
          } else if (receipt.fd_renewal_investment_type === 'increased') {
            renewalText = 'Increased Amount'
            if (receipt.fd_renewal_additional_amount) {
              const additionalAmt = fmtINR(receipt.fd_renewal_additional_amount)
              renewalText += ` (Additional: ${additionalAmt})`
            }
          } else if (receipt.fd_renewal_investment_type === 'decreased') {
            renewalText = 'Decreased Amount'
            if (receipt.fd_renewal_additional_amount) {
              const withdrawalAmt = fmtINR(receipt.fd_renewal_additional_amount)
              renewalText += ` (Withdrawal: ${withdrawalAmt})`
            }
          }
          yPos = addField('Renewal Investment', renewalText, margin, yPos)
        }
        
        yPos += 10
      }
      
      // Bond/NCD Details
      const bondDetails = receipt.product_details && receipt.product_details.bond ? receipt.product_details.bond : null
      const hasBondSection = (productCategoryUpper === 'BOND' || productCategoryUpper === 'NCD') &&
        (receipt.bond_issuer_name || receipt.bond_scheme_name || receipt.scheme_name || receipt.schemeName || receipt.product?.name || (bondDetails && (bondDetails.issuer?.name || bondDetails.scheme?.name)))
      if (hasBondSection) {
        doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 8
        
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text('Bond / NCD Details', margin, yPos)
        yPos += 10
        
        const bondIssuer = receipt.bond_issuer_name || bondDetails?.issuer?.name || receipt.issuer_company || 'N/A'
        const bondType = receipt.bond_issuer_type || bondDetails?.issuer?.type
        yPos = addField('Issuer', bondType ? `${bondIssuer} (${bondType})` : bondIssuer, margin, yPos)
        const bondSchemeName = receipt.bond_scheme_name || receipt.scheme_name || receipt.schemeName || bondDetails?.scheme?.name || receipt.product?.name
        if (bondSchemeName) {
          yPos = addField('Scheme', bondSchemeName, margin, yPos)
        }
        const bondAmount = receipt.investment_amount || receipt.investmentAmount || bondDetails?.transaction?.amount || receipt.transaction?.amount
        if (bondAmount != null && bondAmount !== '') {
          const amountStr = fmtINR(bondAmount)
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('Amount:', margin, yPos, { width: 180 })
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(amountStr, margin + 180, yPos - 2, { width: contentWidth - (margin + 180) })
          yPos += 18
        }
        const bondCouponRate = receipt.bond_coupon_rate ?? bondDetails?.instrument?.coupon_rate ?? receipt.roi ?? receipt.roi_percent
        if (bondCouponRate != null && bondCouponRate !== '') {
          yPos = addField('Coupon Rate', `${Number(bondCouponRate).toFixed(2)}% p.a.`, margin, yPos)
        }
        const bondFaceValue = receipt.bond_face_value ?? bondDetails?.instrument?.face_value
        if (bondFaceValue != null && bondFaceValue !== '') {
          yPos = addField('Face Value', fmtINR(bondFaceValue, 0), margin, yPos)
        }
        const bondIssueDate = receipt.bond_issue_date ?? bondDetails?.instrument?.issue_date
        if (bondIssueDate) {
          yPos = addField('Issue Date', new Date(bondIssueDate).toLocaleDateString('en-IN'), margin, yPos)
        }
        const bondMaturityDate = receipt.bond_maturity_date ?? receipt.renewal_due_date ?? bondDetails?.instrument?.maturity_date
        if (bondMaturityDate) {
          yPos = addField('Maturity / Renewal Due', new Date(bondMaturityDate).toLocaleDateString('en-IN'), margin, yPos)
        }
        const bondAppNumber = receipt.bond_application_number ?? bondDetails?.application?.number
        if (bondAppNumber) {
          yPos = addField('Application Number', bondAppNumber, margin, yPos)
        }
        const bondTxnType = receipt.bond_transaction_type ?? receipt.txn_type ?? receipt.transaction_type ?? bondDetails?.transaction?.type
        if (bondTxnType) {
          yPos = addField('Transaction Type', bondTxnType, margin, yPos)
        }
        const bondIsin = receipt.bond_isin ?? bondDetails?.scheme?.isin
        if (bondIsin) {
          yPos = addField('ISIN', bondIsin, margin, yPos)
        }
        yPos += 10
      }
      
      // Insurance Details
      if (productCategory === 'INS' && (receipt.insurance_issuer_key || receipt.insurance_product_name || receipt.product_details?.insurance?.issuer?.name || (receipt.issuer_company && productCategory === 'INS'))) {
        doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 8
        
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#111827').text('Insurance Details', margin, yPos)
        yPos += 14
        
        const insIssuer = receipt.product_details?.insurance?.issuer?.name || receipt.issuer_company || receipt.fd_issuer_name || 'N/A'
        yPos = addField('Issuer', insIssuer, margin, yPos)
        const insProduct = receipt.insurance_product_name || receipt.product_details?.insurance?.product?.name || receipt.scheme_name || receipt.schemeName
        if (insProduct) yPos = addField('Product', insProduct, margin, yPos)
        if (receipt.investment_amount || receipt.investmentAmount || receipt.product_details?.insurance?.policy?.premium_amount) {
          const amt = receipt.investment_amount || receipt.investmentAmount || receipt.product_details?.insurance?.policy?.premium_amount
          const amountStr = fmtINR(amt)
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('Premium Amount:', margin, yPos, { width: 180 })
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(amountStr, margin + 180, yPos - 2, { width: contentWidth - (margin + 180) })
          yPos += 18
        }
        const policyNo = receipt.insurance_policy_number || receipt.product_details?.insurance?.policy?.number || receipt.folio_policy_no || receipt.folioPolicyNo
        if (policyNo) yPos = addField('Policy Number', policyNo, margin, yPos)
        if (receipt.insurance_sum_assured || receipt.product_details?.insurance?.coverage?.sum_assured) {
          const sa = receipt.insurance_sum_assured ?? receipt.product_details?.insurance?.coverage?.sum_assured
          yPos = addField('Sum Assured', fmtINR(sa, 0), margin, yPos)
        }
        if (receipt.insurance_policy_term_years || receipt.product_details?.insurance?.coverage?.policy_term_years) {
          const term = receipt.insurance_policy_term_years ?? receipt.product_details?.insurance?.coverage?.policy_term_years
          yPos = addField('Policy Term', `${term} years`, margin, yPos)
        }
        if (receipt.insurance_premium_frequency || receipt.product_details?.insurance?.policy?.premium_frequency) {
          yPos = addField('Premium Frequency', receipt.insurance_premium_frequency || receipt.product_details?.insurance?.policy?.premium_frequency, margin, yPos)
        }
        if (receipt.insurance_date_of_issue || receipt.product_details?.insurance?.coverage?.policy_start_date) {
          const d = receipt.insurance_date_of_issue || receipt.product_details?.insurance?.coverage?.policy_start_date
          yPos = addField('Date of Issue', new Date(d).toLocaleDateString('en-IN'), margin, yPos)
        }
        if (receipt.insurance_maturity_date || receipt.product_details?.insurance?.coverage?.maturity_date) {
          const d = receipt.insurance_maturity_date || receipt.product_details?.insurance?.coverage?.maturity_date
          yPos = addField('Maturity Date', new Date(d).toLocaleDateString('en-IN'), margin, yPos)
        }
        if (receipt.fd_transaction_type || receipt.txn_type || receipt.product_details?.insurance?.policy?.type) {
          yPos = addField('Transaction Type', receipt.fd_transaction_type || receipt.txn_type || receipt.product_details?.insurance?.policy?.type || 'Fresh', margin, yPos)
        }
        yPos += 10
      }
      
      // Transaction/Payment Details Section
      // Extract payment data from structured format or flat format
      const paymentData = receipt.payment || {}
      const entryMode = paymentData.entry_mode || receipt.entry_mode || receipt.transactionType || null
      const channel = paymentData.channel || receipt.transaction_channel || receipt.othersTransactionType || null
      const referenceNo = paymentData.reference_no || receipt.transaction_details?.reference_no || receipt.transactionNumber || receipt.reference_no || null
      const transactionDate = paymentData.transaction_date || receipt.transaction_details?.txn_date || receipt.txn_date || receipt.chequeDate || receipt.instrumentDate || null
      const bankName = paymentData.instrument?.bank?.name || receipt.transaction_details?.bank_name || receipt.bankName || receipt.bank_name || null
      const bankBranch = paymentData.instrument?.bank?.branch || receipt.transaction_details?.bank_branch || receipt.bankBranch || receipt.bank_branch || null
      const notes = paymentData.notes || receipt.transaction_details?.notes || receipt.othersTransactionType || receipt.notes || null
      const instrumentType = paymentData.instrument?.type || receipt.instrument_type || receipt.instrumentType || null
      const instrumentNo = paymentData.instrument?.number || receipt.instrument_no || receipt.instrumentNo || null
      const instrumentDate = paymentData.instrument?.date || receipt.instrument_date || receipt.instrumentDate || null
      
      // Show payment section when any payment/transaction data exists (infer type when entry_mode missing)
      const hasPaymentData = entryMode || channel || referenceNo || bankName || bankBranch || notes || instrumentType || instrumentNo
      if (hasPaymentData) {
        doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 8
        
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text('Transaction/Payment Details', margin, yPos)
        yPos += 10
        
        // Infer payment mode when not stored (legacy or flat data)
        const displayEntryMode = entryMode || (bankName ? 'Offline' : (notes || (channel && channel !== 'Cheque') ? 'Others' : 'Online'))
        let entryModeText = displayEntryMode
        if (displayEntryMode === 'Online') entryModeText = 'Online Payment'
        else if (displayEntryMode === 'Offline') entryModeText = 'Offline Payment (Cheque/Demand Draft)'
        else if (displayEntryMode === 'Others') entryModeText = 'Other Payment Method'
        yPos = addField('Payment Mode', entryModeText, margin, yPos)
        
        // Online: reference / transaction number
        if (displayEntryMode === 'Online' && (referenceNo || channel)) {
          yPos = addField('Transaction/Reference Number', referenceNo || channel, margin, yPos)
        }
        
        // Others: details (e.g. RTGS, NEFT)
        if (displayEntryMode === 'Others' && (notes || channel)) {
          yPos = addField('Payment Details', notes || channel, margin, yPos, 180, 300, 10)
        }
        
        // Offline: instrument, bank, branch, date
        if (displayEntryMode === 'Offline' || bankName || instrumentNo) {
          if (instrumentType) yPos = addField('Instrument Type', instrumentType, margin, yPos)
          else if (channel) yPos = addField('Instrument Type', channel, margin, yPos)
          if (instrumentNo || referenceNo) {
            yPos = addField('Cheque/Draft Number', instrumentNo || referenceNo, margin, yPos)
          }
          const payDate = instrumentDate || transactionDate
          if (payDate) {
            yPos = addField('Instrument/Transaction Date', new Date(payDate).toLocaleDateString('en-IN'), margin, yPos)
          }
          if (bankName) yPos = addField('Bank Name', bankName, margin, yPos)
          if (bankBranch) yPos = addField('Bank Branch', bankBranch, margin, yPos)
        }
        
        // Transaction date (for Online/Others; Offline date already shown as Instrument/Transaction Date)
        if (transactionDate && displayEntryMode !== 'Offline') {
          yPos = addField('Transaction Date', new Date(transactionDate).toLocaleDateString('en-IN'), margin, yPos)
        }
        
        if (notes && displayEntryMode !== 'Others') {
          yPos = addField('Notes', notes, margin, yPos, 200, 320, 14)
        }
        
        yPos += 10
      }
      
      // Footer: compact terms + thank you + signature (single page)
      doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
      yPos += 6
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827').text('Terms and Conditions:', margin, yPos)
      yPos += 8
      doc.fontSize(7).font('Helvetica').fillColor('#374151')
      doc.text('• This receipt is proof of payment towards the specified investment and does not guarantee returns. • Investments are subject to market risks; please read the scheme details carefully before investing. • For queries, contact your branch manager or visit our website.', margin + 6, yPos, { width: contentWidth - 12, lineGap: 2 })
      yPos += 18
      doc.rect(margin, yPos, contentWidth, 20).fillColor('#FEF2F2').fill()
      doc.rect(margin, yPos, contentWidth, 20).strokeColor('#DC2626').lineWidth(1.5).stroke()
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#DC2626').text('Thank you for choosing ECS Financial. We acknowledge the receipt of your payment and truly appreciate your trust.', margin + 10, yPos + 5, { align: 'center', width: contentWidth - 20 })
      yPos += 26
      doc.moveTo(margin, yPos).lineTo(contentRight, yPos).strokeColor('#DC2626').lineWidth(1).stroke()
      yPos += 10
      doc.fontSize(8).font('Helvetica').fillColor('#374151').text('Authorized Signature', margin, yPos)
      doc.fontSize(8).font('Helvetica').fillColor('#374151').text('Company Stamp', contentRight - 100, yPos)
      
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
      LIMIT ${Number(limit) || 1000}
      RETURN receipt
    `, {})
    
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
