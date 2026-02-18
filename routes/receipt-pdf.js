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
    const doc = new PDFDocument({ margin: 40, size: 'A4' })
    const buffers = []
    
    doc.on('data', buffers.push.bind(buffers))
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers)
      resolve(pdfBuffer)
    })
    doc.on('error', reject)
    
    try {
      // Helper to add key-value pair with improved spacing and typography
      // Returns the new y position after adding the field
      const addField = (label, value, x, y, labelWidth = 200, valueWidth = 320, lineSpacing = 18) => {
        if (!value || value === 'N/A' || value === '—') {
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151').text(label + ':', x, y, { width: labelWidth })
          doc.fontSize(10).font('Helvetica').fillColor('#6B7280').text('N/A', x + labelWidth, y, { width: valueWidth })
          return y + lineSpacing
        }
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151').text(label + ':', x, y, { width: labelWidth })
        
        // Calculate text height for multi-line values (scheme names, etc.)
        const textHeight = doc.heightOfString(String(value), { width: valueWidth })
        const lines = Math.ceil(textHeight / 12) // Approximate line height
        const actualHeight = Math.max(lineSpacing, (lines * 12) + 4) // Add extra spacing for multi-line
        
        doc.fontSize(10).font('Helvetica').fillColor('#111827').text(String(value), x + labelWidth, y, { width: valueWidth, lineGap: 2 })
        return y + actualHeight
      }
      
      let yPos = 30
      
      // Professional Header with Larger Logo (no text needed as logo contains company name)
      const logoPath = path.join(__dirname, '../assets/ecs-logo.png')
      try {
        if (fs.existsSync(logoPath)) {
          // Larger logo size
          doc.image(logoPath, 40, yPos, { width: 120, height: 120 })
        }
      } catch (error) {
        console.warn('Could not load logo:', error.message)
      }
      
      // AMFI registration text below logo (smaller, right-aligned)
      doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('AMFI Registered Mutual Fund Distributor', 40, yPos + 125, { width: 520, align: 'right' })
      
      // Receipt info in top right with better styling
      const dateStr = receipt.date ? new Date(receipt.date).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN')
      const receiptNo = receipt.receipt_no || receipt.receiptNo || 'N/A'
      const receiptId = `ECS-${dateStr.replace(/\//g, '')}-${receiptNo}`
      
      // Background box for receipt info (aligned with logo area)
      const receiptInfoY = yPos + 10
      doc.rect(380, receiptInfoY, 180, 50).fillColor('#FEF2F2').fill()
      doc.rect(380, receiptInfoY, 180, 50).strokeColor('#DC2626').lineWidth(1.5).stroke()
      
      doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('Date:', 390, receiptInfoY + 8)
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#111827').text(dateStr, 390, receiptInfoY + 20)
      doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('Receipt No:', 390, receiptInfoY + 35)
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(receiptNo, 390, receiptInfoY + 47, { width: 160 })
      
      // Move yPos down to account for larger logo
      yPos += 145
      
      // Professional divider line
      doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#DC2626').lineWidth(2).stroke()
      yPos += 20
      
      // ACKNOWLEDGEMENT RECEIPT Section Header with background
      doc.rect(40, yPos, 520, 28).fillColor('#FEF2F2').fill()
      doc.rect(40, yPos, 520, 28).strokeColor('#DC2626').lineWidth(1.5).stroke()
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#DC2626').text('ACKNOWLEDGEMENT RECEIPT', 50, yPos + 7, { align: 'center', width: 500 })
      yPos += 35
      
      // Branch / Place and Relationship Manager Section
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Branch & Relationship Manager', 40, yPos)
      yPos += 20
      
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

      yPos = addField('Branch / Place', branch, 40, yPos)
      yPos = addField('Relationship Manager', employeeName, 40, yPos)
      yPos = addField('Manager Code', receipt.employee?.code ?? receipt.emp_code ?? receipt.empCode ?? 'N/A', 40, yPos)
      yPos = addField('Manager Mobile', employeeMobile, 40, yPos)
      yPos = addField('Email ID (Manager)', employeeEmail, 40, yPos)
      
      yPos += 15
      
      // Divider line
      doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
      yPos += 15
      
      // Investor Details Section
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Investor Details', 40, yPos)
      yPos += 20
      
      yPos = addField('Investor Name', investorName, 40, yPos)
      yPos = addField('Investor ID', investorId, 40, yPos)
      yPos = addField('Mobile Number (Investor)', investorMobile, 40, yPos)
      yPos = addField('PAN', investorPan, 40, yPos)
      yPos = addField('Email ID (Investor)', investorEmail, 40, yPos)
      const investorAddress = receipt.investor?.address
      const addressStr = typeof investorAddress === 'object' && investorAddress
        ? [investorAddress.line1, investorAddress.line2, investorAddress.line3].filter(Boolean).join('\n') || null
        : (receipt.investor_address ?? receipt.investorAddress ?? null)
      if (addressStr) yPos = addField('Address', addressStr, 40, yPos)
      const pinCode = (typeof investorAddress === 'object' && investorAddress?.pin_code) ?? receipt.pin_code ?? receipt.pinCode
      if (pinCode) yPos = addField('PIN Code', pinCode, 40, yPos)
      
      yPos += 15
      
      // Divider line
      doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
      yPos += 15
      
      // Investment Details Section
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Investment Details', 40, yPos)
      yPos += 20
      
      // Product category box with improved styling
      const productCategory = receipt.product_category || receipt.productCategory || 'Mutual Funds'
      const boxHeight = 28
      // Professional red shade background
      doc.rect(40, yPos, 520, boxHeight).fillColor('#FEF2F2').fill()
      doc.rect(40, yPos, 520, boxHeight).strokeColor('#DC2626').lineWidth(1.5).stroke()
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#DC2626').text(productCategory, 50, yPos + 8)
      yPos += boxHeight + 15
      
      // Investment fields
      if (receipt.amc_name || receipt.amc_code) {
        yPos = addField('AMC Name', receipt.amc_name || receipt.amc_code, 40, yPos)
      }
      
      if (receipt.scheme_name || receipt.schemeName || receipt.product?.name) {
        const schemeName = receipt.scheme_name || receipt.schemeName || receipt.product?.name
        const nfoTag = receipt.scheme_is_nfo || receipt.product_details?.mf?.scheme?.is_nfo ? ' [NFO]' : ''
        // Use larger line spacing for scheme names (they can be long/multi-line)
        yPos = addField('Target Scheme', schemeName + nfoTag, 40, yPos, 200, 320, 22)
      }
      
      if (receipt.switch_from_scheme_name || receipt.from_scheme_name) {
        yPos = addField('Existing Scheme', receipt.switch_from_scheme_name || receipt.from_scheme_name, 40, yPos)
      }
      
      if (receipt.scheme_plan || receipt.plan) {
        yPos = addField('Plan', receipt.scheme_plan || receipt.plan, 40, yPos)
      }
      
      if (receipt.scheme_option || receipt.schemeOption) {
        const option = receipt.scheme_option || receipt.schemeOption
        let optionText = option
        if (option === 'GROWTH') optionText = 'GROWTH'
        else if (option === 'IDCW_PAYOUT') optionText = 'IDCW - Payout'
        else if (option === 'IDCW_REINVEST') optionText = 'IDCW - Reinvestment'
        yPos = addField('Option', optionText, 40, yPos)
      }
      
      if (receipt.transaction_type || receipt.txn_type || receipt.txnType) {
        const txnType = receipt.transaction_type || receipt.txn_type || receipt.txnType
        yPos = addField('Transaction Type', txnType, 40, yPos)
      }
      
      if (receipt.folio_number || receipt.folio_policy_no || receipt.folioPolicyNo) {
        const folioNo = receipt.folio_number || receipt.folio_policy_no || receipt.folioPolicyNo
        yPos = addField('Folio Status', 'Existing Folio', 40, yPos)
        yPos = addField('Number (Folio Number)', folioNo, 40, yPos)
      }
      
      if (receipt.investment_amount || receipt.investmentAmount) {
        const amount = new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: 'INR',
          maximumFractionDigits: 2
        }).format(receipt.investment_amount || receipt.investmentAmount)
        // Highlight amount with larger font
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151').text('Investment Amount:', 40, yPos, { width: 200 })
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#DC2626').text(amount, 240, yPos - 2, { width: 320 })
        yPos += 22
      }
      
      // Switch Over details
      if (receipt.transaction_type === 'Switch Over' || receipt.txn_type === 'Switch Over') {
        if (receipt.switch_type && receipt.switch_value) {
          const switchValue = receipt.switch_type === 'Amount' 
            ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(receipt.switch_value)
            : `${receipt.switch_value} units`
          yPos = addField('Switch Type', receipt.switch_type, 40, yPos)
          yPos = addField('Switch Value', switchValue, 40, yPos)
        }
      }
      
      // SIP details
      if (receipt.transaction_type === 'SIP' || receipt.txn_type === 'SIP') {
        if (receipt.sip_frequency) yPos = addField('SIP Frequency', receipt.sip_frequency, 40, yPos)
        if (receipt.sip_start_date) {
          yPos = addField('Start Date', new Date(receipt.sip_start_date).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.sip_end_date) {
          yPos = addField('End Date', new Date(receipt.sip_end_date).toLocaleDateString('en-IN'), 40, yPos)
        } else if (receipt.sip_is_perpetual) {
          yPos = addField('Type', 'Perpetual (40 years)', 40, yPos)
        }
      }
      
      // STP details
      if (receipt.transaction_type === 'STP' || receipt.txn_type === 'STP') {
        if (receipt.stp_target_scheme_name) {
          yPos = addField('Target Scheme', receipt.stp_target_scheme_name, 40, yPos)
        }
        if (receipt.stp_original_amount) {
          const originalAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.stp_original_amount)
          yPos = addField('Total Original Scheme Amount', originalAmt, 40, yPos)
        }
        if (receipt.stp_frequency) yPos = addField('STP Frequency', receipt.stp_frequency, 40, yPos)
        if (receipt.stp_start_date) {
          yPos = addField('STP Start Date', new Date(receipt.stp_start_date).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.stp_amount) {
          const stpAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.stp_amount)
          yPos = addField('Transfer Amount', stpAmt, 40, yPos)
        }
      }
      
      // SWP details
      if (receipt.transaction_type === 'SWP' || receipt.txn_type === 'SWP') {
        if (receipt.swp_frequency) yPos = addField('SWP Frequency', receipt.swp_frequency, 40, yPos)
        if (receipt.swp_start_date) {
          yPos = addField('SWP Start Date', new Date(receipt.swp_start_date).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.swp_amount) {
          const swpAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.swp_amount)
          yPos = addField('Withdrawal Amount', swpAmt, 40, yPos)
        }
      }
      
      yPos += 15
      
      // FD Details (if applicable)
      if (receipt.fd_issuer_name) {
        doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 15
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Fixed Deposit Details', 40, yPos)
        yPos += 20
        
        // FD category box with improved styling
        doc.rect(40, yPos, 520, 28).fillColor('#FEF2F2').fill()
        doc.rect(40, yPos, 520, 28).strokeColor('#DC2626').lineWidth(1.5).stroke()
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#DC2626').text('Fixed Deposit', 50, yPos + 8)
        yPos += 35
        
        yPos = addField('Issuer', receipt.fd_issuer_name + (receipt.fd_issuer_type ? ` (${receipt.fd_issuer_type})` : ''), 40, yPos)
        if (receipt.fd_scheme_name) yPos = addField('Scheme', receipt.fd_scheme_name, 40, yPos)
        if (receipt.fd_deposit_amount) {
          const amount = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.fd_deposit_amount)
          // Highlight deposit amount
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151').text('Deposit Amount:', 40, yPos, { width: 200 })
          doc.fontSize(14).font('Helvetica-Bold').fillColor('#DC2626').text(amount, 240, yPos - 2, { width: 320 })
          yPos += 22
        }
        if (receipt.fd_tenure_months) {
          yPos = addField('Tenure', `${receipt.fd_tenure_months} months (${Math.floor(receipt.fd_tenure_months/12)} years)`, 40, yPos)
        }
        if (receipt.fd_payout_frequency) {
          yPos = addField('Payout Frequency', receipt.fd_payout_frequency, 40, yPos)
        }
        if (receipt.fd_locked_interest_rate_pa) {
          yPos = addField('Interest Rate', `${receipt.fd_locked_interest_rate_pa.toFixed(2)}% p.a.`, 40, yPos)
        }
        if (receipt.fd_maturity_amount) {
          const maturityAmt = new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 2
          }).format(receipt.fd_maturity_amount)
          yPos = addField('Maturity Amount', maturityAmt, 40, yPos)
        }
        if (receipt.fd_maturity_date) {
          yPos = addField('Maturity Date', new Date(receipt.fd_maturity_date).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.fd_application_number) {
          yPos = addField('Application/FD Number', receipt.fd_application_number, 40, yPos)
        }
        if (receipt.fd_transaction_type || receipt.txn_type) {
          yPos = addField('Transaction Type', receipt.fd_transaction_type || receipt.txn_type || 'Fresh', 40, yPos)
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
          yPos = addField('Renewal Investment', renewalText, 40, yPos)
        }
        
        yPos += 15
      }
      
      // Bond/NCD Details (if applicable) — productCategory already declared above
      if ((productCategory === 'BOND' || productCategory === 'NCD') && (receipt.bond_issuer_name || receipt.bond_scheme_name || receipt.product_details?.bond?.issuer?.name)) {
        doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 15
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Bond / NCD Details', 40, yPos)
        yPos += 20
        
        const bondIssuer = receipt.bond_issuer_name || receipt.product_details?.bond?.issuer?.name || receipt.issuer_company || 'N/A'
        const bondType = receipt.bond_issuer_type || receipt.product_details?.bond?.issuer?.type
        yPos = addField('Issuer', bondType ? `${bondIssuer} (${bondType})` : bondIssuer, 40, yPos)
        if (receipt.bond_scheme_name || receipt.product_details?.bond?.scheme?.name) {
          yPos = addField('Scheme', receipt.bond_scheme_name || receipt.product_details?.bond?.scheme?.name, 40, yPos)
        }
        if (receipt.investment_amount || receipt.investmentAmount || receipt.product_details?.bond?.transaction?.amount) {
          const amt = receipt.investment_amount || receipt.investmentAmount || receipt.product_details?.bond?.transaction?.amount
          const amountStr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amt)
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151').text('Amount:', 40, yPos, { width: 200 })
          doc.fontSize(14).font('Helvetica-Bold').fillColor('#DC2626').text(amountStr, 240, yPos - 2, { width: 320 })
          yPos += 22
        }
        if (receipt.bond_coupon_rate || receipt.product_details?.bond?.instrument?.coupon_rate) {
          const rate = receipt.bond_coupon_rate ?? receipt.product_details?.bond?.instrument?.coupon_rate
          yPos = addField('Coupon Rate', `${Number(rate).toFixed(2)}% p.a.`, 40, yPos)
        }
        if (receipt.bond_face_value || receipt.product_details?.bond?.instrument?.face_value) {
          const fv = receipt.bond_face_value ?? receipt.product_details?.bond?.instrument?.face_value
          yPos = addField('Face Value', new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(fv), 40, yPos)
        }
        if (receipt.bond_issue_date || receipt.product_details?.bond?.instrument?.issue_date) {
          const d = receipt.bond_issue_date || receipt.product_details?.bond?.instrument?.issue_date
          yPos = addField('Issue Date', new Date(d).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.bond_maturity_date || receipt.renewal_due_date || receipt.product_details?.bond?.instrument?.maturity_date) {
          const d = receipt.bond_maturity_date || receipt.renewal_due_date || receipt.product_details?.bond?.instrument?.maturity_date
          yPos = addField('Maturity / Renewal Due', new Date(d).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.bond_application_number || receipt.product_details?.bond?.application?.number) {
          yPos = addField('Application Number', receipt.bond_application_number || receipt.product_details?.bond?.application?.number, 40, yPos)
        }
        if (receipt.bond_transaction_type || receipt.txn_type || receipt.product_details?.bond?.transaction?.type) {
          yPos = addField('Transaction Type', receipt.bond_transaction_type || receipt.txn_type || receipt.product_details?.bond?.transaction?.type || 'N/A', 40, yPos)
        }
        if (receipt.bond_isin || receipt.product_details?.bond?.scheme?.isin) {
          yPos = addField('ISIN', receipt.bond_isin || receipt.product_details?.bond?.scheme?.isin, 40, yPos)
        }
        yPos += 15
      }
      
      // Insurance Details (if applicable)
      if (productCategory === 'INS' && (receipt.insurance_issuer_key || receipt.insurance_product_name || receipt.product_details?.insurance?.issuer?.name || (receipt.issuer_company && productCategory === 'INS'))) {
        doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 15
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Insurance Details', 40, yPos)
        yPos += 20
        
        const insIssuer = receipt.product_details?.insurance?.issuer?.name || receipt.issuer_company || receipt.fd_issuer_name || 'N/A'
        yPos = addField('Issuer', insIssuer, 40, yPos)
        const insProduct = receipt.insurance_product_name || receipt.product_details?.insurance?.product?.name || receipt.scheme_name || receipt.schemeName
        if (insProduct) yPos = addField('Product', insProduct, 40, yPos)
        if (receipt.investment_amount || receipt.investmentAmount || receipt.product_details?.insurance?.policy?.premium_amount) {
          const amt = receipt.investment_amount || receipt.investmentAmount || receipt.product_details?.insurance?.policy?.premium_amount
          const amountStr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amt)
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#374151').text('Premium Amount:', 40, yPos, { width: 200 })
          doc.fontSize(14).font('Helvetica-Bold').fillColor('#DC2626').text(amountStr, 240, yPos - 2, { width: 320 })
          yPos += 22
        }
        const policyNo = receipt.insurance_policy_number || receipt.product_details?.insurance?.policy?.number || receipt.folio_policy_no || receipt.folioPolicyNo
        if (policyNo) yPos = addField('Policy Number', policyNo, 40, yPos)
        if (receipt.insurance_sum_assured || receipt.product_details?.insurance?.coverage?.sum_assured) {
          const sa = receipt.insurance_sum_assured ?? receipt.product_details?.insurance?.coverage?.sum_assured
          yPos = addField('Sum Assured', new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(sa), 40, yPos)
        }
        if (receipt.insurance_policy_term_years || receipt.product_details?.insurance?.coverage?.policy_term_years) {
          const term = receipt.insurance_policy_term_years ?? receipt.product_details?.insurance?.coverage?.policy_term_years
          yPos = addField('Policy Term', `${term} years`, 40, yPos)
        }
        if (receipt.insurance_premium_frequency || receipt.product_details?.insurance?.policy?.premium_frequency) {
          yPos = addField('Premium Frequency', receipt.insurance_premium_frequency || receipt.product_details?.insurance?.policy?.premium_frequency, 40, yPos)
        }
        if (receipt.insurance_date_of_issue || receipt.product_details?.insurance?.coverage?.policy_start_date) {
          const d = receipt.insurance_date_of_issue || receipt.product_details?.insurance?.coverage?.policy_start_date
          yPos = addField('Date of Issue', new Date(d).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.insurance_maturity_date || receipt.product_details?.insurance?.coverage?.maturity_date) {
          const d = receipt.insurance_maturity_date || receipt.product_details?.insurance?.coverage?.maturity_date
          yPos = addField('Maturity Date', new Date(d).toLocaleDateString('en-IN'), 40, yPos)
        }
        if (receipt.fd_transaction_type || receipt.txn_type || receipt.product_details?.insurance?.policy?.type) {
          yPos = addField('Transaction Type', receipt.fd_transaction_type || receipt.txn_type || receipt.product_details?.insurance?.policy?.type || 'Fresh', 40, yPos)
        }
        yPos += 15
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
        // Divider line
        doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
        yPos += 15
        
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111827').text('Transaction/Payment Details', 40, yPos)
        yPos += 20
        
        // Infer payment mode when not stored (legacy or flat data)
        const displayEntryMode = entryMode || (bankName ? 'Offline' : (notes || (channel && channel !== 'Cheque') ? 'Others' : 'Online'))
        let entryModeText = displayEntryMode
        if (displayEntryMode === 'Online') entryModeText = 'Online Payment'
        else if (displayEntryMode === 'Offline') entryModeText = 'Offline Payment (Cheque/Demand Draft)'
        else if (displayEntryMode === 'Others') entryModeText = 'Other Payment Method'
        yPos = addField('Payment Mode', entryModeText, 40, yPos)
        
        // Online: reference / transaction number
        if (displayEntryMode === 'Online' && (referenceNo || channel)) {
          yPos = addField('Transaction/Reference Number', referenceNo || channel, 40, yPos)
        }
        
        // Others: details (e.g. RTGS, NEFT)
        if (displayEntryMode === 'Others' && (notes || channel)) {
          yPos = addField('Payment Details', notes || channel, 40, yPos, 200, 320, 20)
        }
        
        // Offline: instrument, bank, branch, date
        if (displayEntryMode === 'Offline' || bankName || instrumentNo) {
          if (instrumentType) yPos = addField('Instrument Type', instrumentType, 40, yPos)
          else if (channel) yPos = addField('Instrument Type', channel, 40, yPos)
          if (instrumentNo || referenceNo) {
            yPos = addField('Cheque/Draft Number', instrumentNo || referenceNo, 40, yPos)
          }
          const payDate = instrumentDate || transactionDate
          if (payDate) {
            yPos = addField('Instrument/Transaction Date', new Date(payDate).toLocaleDateString('en-IN'), 40, yPos)
          }
          if (bankName) yPos = addField('Bank Name', bankName, 40, yPos)
          if (bankBranch) yPos = addField('Bank Branch', bankBranch, 40, yPos)
        }
        
        // Transaction date (for Online/Others; Offline date already shown as Instrument/Transaction Date)
        if (transactionDate && displayEntryMode !== 'Offline') {
          yPos = addField('Transaction Date', new Date(transactionDate).toLocaleDateString('en-IN'), 40, yPos)
        }
        
        if (notes && displayEntryMode !== 'Others') {
          yPos = addField('Notes', notes, 40, yPos, 200, 320, 20)
        }
        
        yPos += 15
      }
      
      // Ensure we don't exceed page height (A4 is ~842pt, with margins ~762pt usable)
      const maxY = 770
      const remainingSpace = maxY - yPos
      
      // Divider line
      doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#E5E7EB').lineWidth(1).stroke()
      yPos += 15
      
      // Terms and Conditions with better styling
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#111827').text('Terms and Conditions:', 40, yPos)
      yPos += 15
      
      doc.fontSize(9).font('Helvetica').fillColor('#374151')
      const terms = [
        '• This receipt is proof of payment towards the specified investment and does not guarantee returns.',
        '• Investments are subject to market risks; please read the scheme details carefully before investing.',
        '• For queries, contact your branch manager or visit our website.'
      ]
      
      terms.forEach((term) => {
        doc.text(term, 50, yPos, { width: 500 })
        yPos += 14
      })
      
      yPos += 15
      
      // Professional thank you message
      doc.rect(40, yPos, 520, 35).fillColor('#FEF2F2').fill()
      doc.rect(40, yPos, 520, 35).strokeColor('#DC2626').lineWidth(1.5).stroke()
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#DC2626').text('Thank you for choosing ECS Financial', 50, yPos + 10, { align: 'center', width: 500 })
      doc.fontSize(9).font('Helvetica').fillColor('#6B7280').text('We acknowledge the receipt of your payment and truly appreciate your trust.', 50, yPos + 25, { align: 'center', width: 500 })
      yPos += 45
      
      // Signature lines with better styling
      doc.moveTo(40, yPos).lineTo(560, yPos).strokeColor('#DC2626').lineWidth(1).stroke()
      yPos += 20
      
      doc.fontSize(9).font('Helvetica').fillColor('#374151').text('Authorized Signature', 40, yPos)
      doc.fontSize(9).font('Helvetica').fillColor('#374151').text('Company Stamp', 400, yPos)
      
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
