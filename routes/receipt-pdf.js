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

const PRODUCT_TYPE_LABELS = {
  MF: 'Mutual Funds', INS: 'Insurance', FD: 'Fixed Deposit',
  BOND: 'Bonds/NCD', NCD: 'Bonds/NCD', GOVT_FD: 'Government Schemes', MISC: 'Misc Services',
  SIF: 'SIF', PMS: 'PMS', AIF: 'AIF', GIFT_CITY_FUNDS: 'Gift City Funds'
}

function fmtINR(num, maxFractionDigits = 2) {
  if (num == null || num === '') return ''
  const n = Number(num)
  if (isNaN(n)) return String(num)
  return 'Rs. ' + new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: maxFractionDigits === 0 ? 0 : 2
  }).format(n)
}

function fmtDate(d) {
  if (!d) return null
  try { return new Date(d).toLocaleDateString('en-IN') } catch { return String(d) }
}

function val(...sources) {
  for (const s of sources) {
    if (s != null && s !== '' && s !== 'N/A' && s !== '—') return s
  }
  return null
}

export function generateReceiptPDF(receipt) {
  return new Promise((resolve, reject) => {
    const margin = 36
    const pageWidth = 595
    const pageHeight = 842
    const contentRight = pageWidth - margin
    const contentWidth = contentRight - margin
    const maxY = pageHeight - margin

    const doc = new PDFDocument({ margin, size: 'A4', autoFirstPage: true, bufferPages: false })
    const buffers = []
    doc.on('data', buffers.push.bind(buffers))
    doc.on('end', () => resolve(Buffer.concat(buffers)))
    doc.on('error', reject)

    try {
      let y = margin

      const field = (label, value, x, currentY, lw = 140, vw = contentWidth - 140) => {
        if (currentY >= maxY) return currentY
        const v = value != null && value !== '' && value !== 'N/A' ? String(value) : null
        if (!v) return currentY
        const h = Math.max(10, Math.ceil(doc.fontSize(8).heightOfString(v, { width: vw }) / 9) * 9 + 2)
        if (currentY + h > maxY) return currentY
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text(label + ':', x, currentY, { width: lw })
        doc.fontSize(8).font('Helvetica').fillColor('#111827').text(v, x + lw, currentY, { width: vw, lineGap: 1 })
        return currentY + h
      }

      const amountField = (label, value, x, currentY) => {
        if (currentY + 16 > maxY || value == null || value === '') return currentY
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text(label + ':', x, currentY, { width: 140 })
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text(fmtINR(value), x + 140, currentY - 1, { width: contentWidth - 140 })
        return currentY + 16
      }

      const sectionLine = (currentY) => {
        if (currentY + 6 > maxY) return currentY
        doc.moveTo(margin, currentY).lineTo(contentRight, currentY).strokeColor('#E5E7EB').lineWidth(0.5).stroke()
        return currentY + 6
      }

      const sectionTitle = (title, currentY) => {
        if (currentY + 14 > maxY) return currentY
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#111827').text(title, margin, currentY)
        return currentY + 12
      }

      // ─── HEADER ───
      const logoPath = path.join(__dirname, '../assets/ecs-logo.png')
      let logoH = 40
      try {
        if (fs.existsSync(logoPath)) {
          const img = doc.openImage(logoPath)
          logoH = 70 * (img.height / img.width)
          doc.image(logoPath, margin, y, { width: 70 })
        }
      } catch { /* skip logo */ }

      const boxW = 150, boxH = 44, boxX = contentRight - boxW
      doc.rect(boxX, y, boxW, boxH).fillColor('#FEF2F2').fill()
      doc.rect(boxX, y, boxW, boxH).strokeColor('#DC2626').lineWidth(0.8).stroke()
      const dateStr = receipt.date ? fmtDate(receipt.date) : fmtDate(new Date())
      const receiptNo = String(receipt.receipt_no || receipt.receiptNo || '')
      doc.fontSize(6.5).font('Helvetica').fillColor('#6B7280').text('Date', boxX + 5, y + 5)
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#111827').text(dateStr, boxX + 5, y + 13)
      doc.fontSize(6.5).font('Helvetica').fillColor('#6B7280').text('Receipt No', boxX + 5, y + 25)
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#DC2626').text(receiptNo, boxX + 5, y + 33, { width: boxW - 10 })
      y += Math.max(logoH, boxH) + 8

      doc.moveTo(margin, y).lineTo(contentRight, y).strokeColor('#DC2626').lineWidth(1.5).stroke()
      y += 8

      // Banner
      doc.rect(margin, y, contentWidth, 16).fillColor('#FEF2F2').fill()
      doc.rect(margin, y, contentWidth, 16).strokeColor('#DC2626').lineWidth(1).stroke()
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#DC2626').text('ACKNOWLEDGEMENT RECEIPT', margin, y + 3, { align: 'center', width: contentWidth })
      y += 22

      // ─── Resolve all fields once ───
      const empName = val(receipt.employee?.name, receipt.employee_name, receipt.employeeName)
      const empCode = val(receipt.employee?.code, receipt.emp_code, receipt.empCode)
      const empBranch = val(receipt.employee?.branch, receipt.branch)

      const invName = val(receipt.investor?.name, receipt.investor_name, receipt.investorName)
      const invId = val(receipt.investor?.id, receipt.investor_id, receipt.investorId)
      const invAddr = typeof receipt.investor?.address === 'object' && receipt.investor.address
        ? [receipt.investor.address.line1, receipt.investor.address.line2, receipt.investor.address.line3,
           receipt.investor.address.city, receipt.investor.address.state].filter(Boolean).join(', ') || null
        : val(receipt.investor_address, receipt.investorAddress)
      const invPin = val(
        typeof receipt.investor?.address === 'object' ? receipt.investor.address?.pin_code : null,
        receipt.pin_code, receipt.pinCode
      )
      const invPan = val(receipt.investor?.pan, receipt.pan)
      const invMobile = val(receipt.investor?.mobile, receipt.investor_mobile, receipt.mobile)
      const invEmail = val(receipt.investor?.email, receipt.email)

      const cat = val(receipt.product?.category, receipt.product_category, receipt.productCategory) || ''
      const catUpper = cat.toUpperCase()
      const catLabel = PRODUCT_TYPE_LABELS[catUpper] || cat
      const isMF = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS'].includes(catUpper)
      const isFD = catUpper === 'FD' || catUpper === 'GOVT_FD'
      const isBond = catUpper === 'BOND' || catUpper === 'NCD'
      const isINS = catUpper === 'INS'
      const isMISC = catUpper === 'MISC'

      const txn = receipt.transaction || {}
      const pd = receipt.product_details || {}
      const mf = pd.mf || null
      const fd = pd.fd || null
      const bond = pd.bond || null
      const ins = pd.insurance || null
      const misc = pd.misc || null
      const pmt = receipt.payment || {}

      // ─── 1. EMPLOYEE DETAILS ───
      y = sectionTitle('Employee Details', y)
      if (empName) y = field('Name', empName, margin, y)
      if (empCode) y = field('Code', empCode, margin, y)
      if (empBranch) y = field('Branch', empBranch, margin, y)
      y += 4

      // ─── 2. INVESTOR DETAILS ───
      y = sectionLine(y)
      y = sectionTitle('Investor Details', y)
      if (invId) y = field('ID', invId, margin, y)
      if (invName) y = field('Name', invName, margin, y)
      if (invAddr) y = field('Address', invAddr, margin, y)
      if (invPin) y = field('PIN', invPin, margin, y)
      if (invPan) y = field('PAN', invPan, margin, y)
      if (invMobile) y = field('Mobile', invMobile, margin, y)
      if (invEmail) y = field('Email', invEmail, margin, y)
      y += 4

      // ─── 3. INVESTMENT DETAILS ───
      y = sectionLine(y)
      y = sectionTitle('Investment Details', y)

      // Product type badge
      if (y + 16 <= maxY) {
        doc.rect(margin, y, contentWidth, 14).fillColor('#FEF2F2').fill()
        doc.rect(margin, y, contentWidth, 14).strokeColor('#DC2626').lineWidth(0.8).stroke()
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#DC2626').text(catLabel, margin + 8, y + 3)
        y += 18
      }

      // ── MF ──
      if (isMF) {
        const mode = val(txn.mode, receipt.mode)
        const txnType = val(txn.type, receipt.txn_type, receipt.transaction_type, receipt.txnType) || 'Fresh'
        const amcName = val(mf?.amc?.name, receipt.amc_name)
        const schemeName = val(mf?.scheme?.name, receipt.scheme_name, receipt.schemeName, receipt.product?.name)
        const nfo = receipt.scheme_is_nfo || mf?.scheme?.is_nfo
        const sCategory = val(mf?.scheme?.category, receipt.scheme_category)
        const sSubCat = val(mf?.scheme?.sub_category, receipt.scheme_sub_category)
        const sPlan = val(mf?.scheme?.plan, receipt.scheme_plan)
        const sOption = val(receipt.scheme_option, receipt.schemeOption, mf?.scheme?.option)
        const sType = val(mf?.scheme?.type, receipt.scheme_type)
        const folioNo = val(receipt.folio_number, receipt.folio_policy_no, receipt.folioPolicyNo, txn.folio_number)
        const investAmt = val(txn.amount, receipt.investment_amount, receipt.investmentAmount)
        const amcCat = val(receipt.mf_amc_category, mf?.amc_category)

        y = field('Product Type', catLabel, margin, y)
        y = field('Transaction', txnType, margin, y)
        if (mode) y = field('Mode', mode, margin, y)
        if (investAmt != null) y = amountField('Amount', investAmt, margin, y)
        if (folioNo) y = field('Folio / Policy No', folioNo, margin, y)

        // Scheme display: for Switch Over show "From → To"
        const switchFrom = val(txn.switch_over?.from_scheme_name, receipt.switch_from_scheme_name)
        const switchTo = val(txn.switch_over?.to_scheme_name, receipt.switch_to_scheme_name, schemeName)
        if (txnType === 'Switch Over' && switchFrom && switchTo) {
          y = field('Scheme', `${switchFrom}  →  ${switchTo}`, margin, y, 140, contentWidth - 140)
        } else if (schemeName) {
          y = field('Scheme', schemeName + (nfo ? ' [NFO]' : ''), margin, y, 140, contentWidth - 140)
        }
        if (sOption) {
          let optTxt = sOption
          if (sOption === 'IDCW_PAYOUT') optTxt = 'IDCW - Payout'
          else if (sOption === 'IDCW_REINVEST') optTxt = 'IDCW - Reinvestment'
          y = field('Option', optTxt, margin, y)
        }

        // MF detail sub-section
        if (amcName) y = field('AMC', amcName, margin, y)
        if (amcCat && amcCat !== 'MF') y = field('AMC Category', amcCat, margin, y)
        if (sCategory) {
          const catStr = sSubCat ? `${sCategory} / ${sSubCat}` : sCategory
          y = field('Category', catStr, margin, y)
        }
        if (sPlan || sType) {
          const planType = [sPlan, sType].filter(Boolean).join(', ')
          y = field('Plan & Type', planType, margin, y)
        }
        if (folioNo) y = field('Folio Number', folioNo, margin, y)

        // SIP
        const sip = txn.sip || {}
        const sipFreq = val(sip.frequency, receipt.sip_frequency)
        const sipStart = val(sip.start_date, receipt.sip_start_date)
        const sipEnd = val(sip.end_date, receipt.sip_end_date)
        const sipPerp = sip.is_perpetual || receipt.sip_is_perpetual
        if (sipFreq || sipStart) {
          if (sipFreq) y = field('SIP Frequency', sipFreq, margin, y)
          if (sipStart) y = field('Start Date', fmtDate(sipStart), margin, y)
          if (sipEnd) y = field('End Date', fmtDate(sipEnd), margin, y)
          else if (sipPerp) y = field('Type', 'Perpetual (40 years)', margin, y)
        }

        // STP
        const stp = txn.stp || {}
        const stpTarget = val(stp.from_scheme_name, receipt.stp_target_scheme_name)
        const stpFreq = val(stp.frequency, receipt.stp_frequency)
        const stpStart = val(stp.start_date, receipt.stp_start_date)
        const stpAmt = val(stp.amount, receipt.stp_amount)
        if (stpTarget || stpFreq) {
          if (stpTarget) y = field('Transfer to Scheme', stpTarget, margin, y, 140, contentWidth - 140)
          if (stpFreq) y = field('STP Frequency', stpFreq, margin, y)
          if (stpStart) y = field('Start Date', fmtDate(stpStart), margin, y)
          if (stpAmt != null) y = amountField('Transfer Amount', stpAmt, margin, y)
        }

        // SWP
        const swp = txn.swp || {}
        const swpFreq = val(swp.frequency, receipt.swp_frequency)
        const swpStart = val(swp.start_date, receipt.swp_start_date)
        const swpAmt = val(swp.amount, receipt.swp_amount)
        if (swpFreq || swpStart) {
          if (swpFreq) y = field('SWP Frequency', swpFreq, margin, y)
          if (swpStart) y = field('Start Date', fmtDate(swpStart), margin, y)
          if (swpAmt != null) y = amountField('Withdrawal Amount', swpAmt, margin, y)
        }

        // Switch Over value
        if (txnType === 'Switch Over') {
          const sw = txn.switch_over || {}
          const swType = val(sw.type, receipt.switch_type)
          const swVal = val(sw.value, receipt.switch_value)
          if (swType) y = field('Switch Type', swType, margin, y)
          if (swVal != null) {
            y = field('Switch Value', swType === 'Amount' ? fmtINR(swVal) : `${swVal} units`, margin, y)
          }
        }
      }

      // ── FD / GOVT_FD ──
      if (isFD) {
        const issuerName = val(fd?.issuer?.name, receipt.fd_issuer_name)
        const issuerType = val(fd?.issuer?.type, receipt.fd_issuer_type)
        const schemeName = val(fd?.scheme?.name, receipt.fd_scheme_name)
        const depositAmt = val(fd?.deposit?.amount, receipt.fd_deposit_amount)
        const tenure = val(fd?.deposit?.tenure_months, receipt.fd_tenure_months)
        const payoutFreq = val(fd?.deposit?.payout_frequency, receipt.fd_payout_frequency)
        const rate = val(fd?.rates?.locked_interest_rate_pa, receipt.fd_locked_interest_rate_pa)
        const maturityAmt = val(fd?.maturity?.amount, receipt.fd_maturity_amount)
        const maturityDate = val(fd?.maturity?.date, receipt.fd_maturity_date)
        const appNo = val(fd?.application?.number, receipt.fd_application_number)
        const fdTxnType = val(fd?.application?.transaction_type, receipt.fd_transaction_type, receipt.txn_type) || 'Fresh'
        const renewType = val(fd?.application?.renewal?.investment_type, receipt.fd_renewal_investment_type)
        const renewAmt = val(fd?.application?.renewal?.additional_amount, receipt.fd_renewal_additional_amount)

        if (issuerName) y = field('Issuer', issuerName + (issuerType ? ` (${issuerType})` : ''), margin, y)
        if (schemeName) y = field('Scheme', schemeName, margin, y)
        if (depositAmt != null) y = amountField('Deposit Amount', depositAmt, margin, y)
        if (tenure) y = field('Tenure', `${tenure} months (${Math.floor(tenure / 12)} years)`, margin, y)
        if (payoutFreq) y = field('Payout Frequency', payoutFreq, margin, y)
        if (rate) y = field('Interest Rate', `${Number(rate).toFixed(2)}% p.a.`, margin, y)
        if (maturityAmt != null) y = field('Maturity Amount', fmtINR(maturityAmt), margin, y)
        if (maturityDate) y = field('Maturity Date', fmtDate(maturityDate), margin, y)
        if (appNo) y = field('Application / FD Number', appNo, margin, y)
        y = field('Transaction Type', fdTxnType, margin, y)
        if (fdTxnType === 'Renewal' && renewType) {
          let txt = renewType === 'same' ? 'Same Amount'
            : renewType === 'increased' ? 'Increased Amount' + (renewAmt ? ` (Additional: ${fmtINR(renewAmt)})` : '')
            : renewType === 'decreased' ? 'Decreased Amount' + (renewAmt ? ` (Withdrawal: ${fmtINR(renewAmt)})` : '')
            : renewType
          y = field('Renewal Investment', txt, margin, y)
        }
      }

      // ── BOND / NCD ──
      if (isBond) {
        const issuer = val(bond?.issuer?.name, receipt.bond_issuer_name, receipt.issuer_company)
        const issuerType = val(bond?.issuer?.type, receipt.bond_issuer_type)
        const scheme = val(bond?.scheme?.name, receipt.bond_scheme_name, receipt.scheme_name, receipt.schemeName, receipt.product?.name)
        const amt = val(bond?.transaction?.amount, receipt.investment_amount, receipt.investmentAmount, txn.amount)
        const coupon = val(bond?.instrument?.coupon_rate, receipt.bond_coupon_rate, receipt.roi, receipt.roi_percent)
        const faceVal = val(bond?.instrument?.face_value, receipt.bond_face_value)
        const issueDate = val(bond?.instrument?.issue_date, receipt.bond_issue_date)
        const matDate = val(bond?.instrument?.maturity_date, receipt.bond_maturity_date, receipt.renewal_due_date)
        const appNo = val(bond?.application?.number, receipt.bond_application_number)
        const bondTxnType = val(bond?.transaction?.type, receipt.bond_transaction_type, receipt.txn_type, receipt.transaction_type)
        const isin = val(bond?.scheme?.isin, receipt.bond_isin)

        if (issuer) y = field('Issuer', issuer + (issuerType ? ` (${issuerType})` : ''), margin, y)
        if (scheme) y = field('Scheme', scheme, margin, y)
        if (amt != null) y = amountField('Amount', amt, margin, y)
        if (coupon != null) y = field('Coupon Rate', `${Number(coupon).toFixed(2)}% p.a.`, margin, y)
        if (faceVal != null) y = field('Face Value', fmtINR(faceVal, 0), margin, y)
        if (issueDate) y = field('Issue Date', fmtDate(issueDate), margin, y)
        if (matDate) y = field('Maturity / Renewal Due', fmtDate(matDate), margin, y)
        if (appNo) y = field('Application Number', appNo, margin, y)
        if (bondTxnType) y = field('Transaction Type', bondTxnType, margin, y)
        if (isin) y = field('ISIN', isin, margin, y)
      }

      // ── INSURANCE ──
      if (isINS) {
        const issuer = val(ins?.issuer?.name, receipt.issuer_company, receipt.fd_issuer_name)
        const product = val(ins?.product?.name, receipt.insurance_product_name, receipt.scheme_name, receipt.schemeName)
        const premAmt = val(ins?.policy?.premium_amount, receipt.investment_amount, receipt.investmentAmount)
        const policyNo = val(ins?.policy?.number, receipt.insurance_policy_number, receipt.folio_policy_no, receipt.folioPolicyNo)
        const sumAssured = val(ins?.coverage?.sum_assured, receipt.insurance_sum_assured)
        const policyTerm = val(ins?.coverage?.policy_term_years, receipt.insurance_policy_term_years)
        const premFreq = val(ins?.policy?.premium_frequency, receipt.insurance_premium_frequency)
        const startDate = val(ins?.coverage?.policy_start_date, receipt.insurance_date_of_issue)
        const matDate = val(ins?.coverage?.maturity_date, receipt.insurance_maturity_date)
        const insTxnType = val(receipt.fd_transaction_type, receipt.txn_type, ins?.policy?.type) || 'Fresh'

        if (issuer) y = field('Issuer', issuer, margin, y)
        if (product) y = field('Product', product, margin, y)
        if (premAmt != null) y = amountField('Premium Amount', premAmt, margin, y)
        if (policyNo) y = field('Policy Number', policyNo, margin, y)
        if (sumAssured != null) y = field('Sum Assured', fmtINR(sumAssured, 0), margin, y)
        if (policyTerm) y = field('Policy Term', `${policyTerm} years`, margin, y)
        if (premFreq) y = field('Premium Frequency', premFreq, margin, y)
        if (startDate) y = field('Date of Issue', fmtDate(startDate), margin, y)
        if (matDate) y = field('Maturity Date', fmtDate(matDate), margin, y)
        y = field('Transaction Type', insTxnType, margin, y)
      }

      // ── MISC ──
      if (isMISC) {
        const svcName = val(misc?.service_name, receipt.service_name, receipt.serviceName)
        const svcPrice = val(misc?.service_price, receipt.service_price, receipt.servicePrice)
        if (svcName) y = field('Service Name', svcName, margin, y)
        if (svcPrice != null) y = amountField('Service Price', svcPrice, margin, y)
      }

      // CC / SI (Collection Credit & Service Income) — what counts toward targets
      const ccVal = val(
        receipt.total_cc, receipt.cc_amount,
        receipt.calculations?.collection_credit, receipt.calculations?.cc,
        receipt.collection_credit, receipt.cc
      )
      const siVal = val(
        receipt.total_si, receipt.si_amount,
        receipt.calculations?.service_income, receipt.calculations?.si,
        receipt.service_income, receipt.si
      )
      if (ccVal != null && Number(ccVal) > 0) y = field('Collection Credit (CC)', fmtINR(ccVal), margin, y)
      if (siVal != null && Number(siVal) > 0) y = field('Service Income (SI)', fmtINR(siVal), margin, y)

      y += 4

      // ─── 4. PAYMENT / TRANSACTION DETAILS ───
      const entryMode = val(pmt.entry_mode, receipt.entry_mode, receipt.transactionType)
      const channel = val(pmt.channel, receipt.transaction_channel, receipt.othersTransactionType)
      const refNo = val(pmt.reference_no, receipt.transaction_details?.reference_no, receipt.transactionNumber, receipt.reference_no)
      const txnDate = val(pmt.transaction_date, receipt.transaction_details?.txn_date, receipt.txn_date, receipt.chequeDate, receipt.instrumentDate)
      const bankName = val(pmt.instrument?.bank?.name, receipt.transaction_details?.bank_name, receipt.bankName, receipt.bank_name)
      const bankBranch = val(pmt.instrument?.bank?.branch, receipt.transaction_details?.bank_branch, receipt.bankBranch, receipt.bank_branch)
      const notes = val(pmt.notes, receipt.transaction_details?.notes, receipt.othersTransactionType, receipt.notes)
      const instType = val(pmt.instrument?.type, receipt.instrument_type, receipt.instrumentType)
      const instNo = val(pmt.instrument?.number, receipt.instrument_no, receipt.instrumentNo)
      const instDate = val(pmt.instrument?.date, receipt.instrument_date, receipt.instrumentDate)

      const hasPayment = entryMode || channel || refNo || bankName || instNo || notes
      if (hasPayment) {
        y = sectionLine(y)
        y = sectionTitle('Payment / Transaction Details', y)

        const mode = entryMode || (bankName ? 'Offline' : (notes || (channel && channel !== 'Cheque') ? 'Others' : 'Online'))
        const modeLabel = mode === 'Online' ? 'Online Payment'
          : mode === 'Offline' ? 'Offline Payment (Cheque / Demand Draft)'
          : mode === 'Others' ? 'Other Payment Method' : mode
        y = field('Payment Type', modeLabel, margin, y)

        if (mode === 'Online') {
          if (refNo || channel) y = field('Reference / Transaction Number', refNo || channel, margin, y)
        }
        if (mode === 'Offline' || bankName || instNo) {
          if (instNo || refNo) y = field('Cheque / Instrument Number', instNo || refNo, margin, y)
          const payDate = instDate || txnDate
          if (payDate) y = field('Date', fmtDate(payDate), margin, y)
          if (bankName) y = field('Bank', bankName, margin, y)
          if (bankBranch) y = field('Branch', bankBranch, margin, y)
        }
        if (mode === 'Others') {
          if (notes || channel) y = field('Details', notes || channel, margin, y)
        }
        if (txnDate && mode !== 'Offline') {
          y = field('Transaction Date', fmtDate(txnDate), margin, y)
        }
        if (notes && mode !== 'Others') {
          y = field('Notes', notes, margin, y)
        }
      }

      y += 4

      // ─── FOOTER ───
      if (y + 60 <= maxY) {
        y = sectionLine(y)
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#111827').text('Terms and Conditions:', margin, y)
        y += 8
        doc.fontSize(6.5).font('Helvetica').fillColor('#374151')
          .text('This receipt is proof of payment towards the specified investment and does not guarantee returns. Investments are subject to market risks; please read the scheme details carefully before investing. For queries, contact your branch manager or visit our website.', margin + 4, y, { width: contentWidth - 8, lineGap: 1 })
        y += 16
        if (y + 26 <= maxY) {
          doc.rect(margin, y, contentWidth, 18).fillColor('#FEF2F2').fill()
          doc.rect(margin, y, contentWidth, 18).strokeColor('#DC2626').lineWidth(1).stroke()
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#DC2626')
            .text('Thank you for choosing ECS Financial. We acknowledge the receipt of your payment and truly appreciate your trust.', margin + 8, y + 4, { align: 'center', width: contentWidth - 16 })
          y += 22
          doc.moveTo(margin, y).lineTo(contentRight, y).strokeColor('#DC2626').lineWidth(0.8).stroke()
          y += 8
          if (y + 8 <= maxY) {
            doc.fontSize(7).font('Helvetica').fillColor('#374151').text('Authorized Signature', margin, y)
            doc.fontSize(7).font('Helvetica').fillColor('#374151').text('Company Stamp', contentRight - 80, y)
          }
        }
      }

      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

// ─── ROUTES ───

router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN receipt
    `, { id: receiptId })

    if (!receiptRows.length) return res.status(404).json({ error: 'receipt_not_found' })
    const receipt = receiptRows[0]

    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }

    let pdfBuffer
    const forceRegenerate = req.query.force === 'true' || req.query.regenerate === 'true'

    if (receipt.pdf_data && !forceRegenerate) {
      pdfBuffer = Buffer.from(receipt.pdf_data, 'base64')
    } else {
      pdfBuffer = await generateReceiptPDF(receipt)
      const receiptsCollection = getCollection('receipts')
      await receiptsCollection.update(receiptId, {
        pdf_data: pdfBuffer.toString('base64'),
        pdf_generated_at: new Date().toISOString()
      })
    }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Receipt-${receipt.receipt_no || receipt.receiptNo}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    res.send(pdfBuffer)
  } catch (error) {
    console.error('Error generating receipt PDF:', error)
    res.status(500).json({ error: 'pdf_generation_failed', detail: error.message })
  }
})

router.post('/regenerate-pdfs', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' })
    const { limit = 1000, batchSize = 50 } = req.body

    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      LIMIT ${Number(limit) || 1000}
      RETURN receipt
    `, {})

    if (!receipts.length) return res.json({ message: 'no_receipts_found', generated: 0, total: 0 })

    const receiptsCollection = getCollection('receipts')
    let generated = 0, errors = 0
    const errorDetails = []

    for (let i = 0; i < receipts.length; i += batchSize) {
      const batch = receipts.slice(i, i + batchSize)
      await Promise.all(batch.map(async (receipt) => {
        try {
          const pdfBuffer = await generateReceiptPDF(receipt)
          await receiptsCollection.update(receipt._key || receipt.id, {
            pdf_data: pdfBuffer.toString('base64'),
            pdf_generated_at: new Date().toISOString()
          })
          generated++
        } catch (error) {
          errors++
          errorDetails.push({ receipt_id: receipt._key || receipt.id, receipt_no: receipt.receipt_no || receipt.receiptNo, error: error.message })
        }
      }))
      console.log(`Regenerated PDFs: ${Math.min(i + batchSize, receipts.length)}/${receipts.length}`)
    }

    res.json({ message: 'pdf_regeneration_complete', total_receipts: receipts.length, generated, errors, error_details: errorDetails.length > 0 ? errorDetails : undefined })
  } catch (error) {
    console.error('Error in PDF regeneration route:', error)
    res.status(500).json({ error: 'operation_failed', detail: error.message })
  }
})

router.post('/:id/generate-pdf', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' })
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN receipt
    `, { id: req.params.id })

    if (!receiptRows.length) return res.status(404).json({ error: 'receipt_not_found' })

    const pdfBuffer = await generateReceiptPDF(receiptRows[0])
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Receipt-${receiptRows[0].receipt_no || receiptRows[0].receiptNo}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    res.send(pdfBuffer)
  } catch (error) {
    console.error('Error generating receipt PDF:', error)
    res.status(500).json({ error: 'pdf_generation_failed', detail: error.message })
  }
})

export default router
