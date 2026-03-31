import express from 'express'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { normalizeReceiptCategory } from '../utils/receipt-category.js'

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

function hasNonEmptyContact(v) {
  return v != null && String(v).trim() !== ''
}

/** When the receipt omits mobile, pull it from customers (single source for CRM). Returns enriched receipt + whether DB lookup added it (forces PDF regen if cached). */
export async function enrichReceiptWithCustomerMobile(receipt) {
  const existing = val(
    receipt.investor?.mobile,
    receipt.investor_mobile,
    receipt.mobile,
    receipt.phone,
    receipt.phone_number,
    receipt.phoneNumber,
    receipt.client_phone,
    receipt.clientPhone
  )
  if (hasNonEmptyContact(existing)) {
    return { receipt, didEnrichMobile: false }
  }
  const rawId = val(receipt.investor?.id, receipt.investor_id, receipt.investorId)
  if (rawId == null || String(rawId).trim() === '') {
    return { receipt, didEnrichMobile: false }
  }
  const rows = await q(`
    FOR c IN customers
      FILTER TO_STRING(c.investor_id) == @strId
      LIMIT 1
      RETURN c.mobile
  `, { strId: String(rawId).trim() })
  const m = rows[0]
  if (!hasNonEmptyContact(m)) {
    return { receipt, didEnrichMobile: false }
  }
  const enriched = {
    ...receipt,
    investor: { ...(receipt.investor || {}), mobile: m },
    mobile: m,
    investor_mobile: m
  }
  return { receipt: enriched, didEnrichMobile: true }
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

      const field = (label, value, x, currentY, lw = 120, vw = contentWidth - 120) => {
        if (currentY >= maxY) return currentY
        const v = value != null && value !== '' && value !== 'N/A' ? String(value) : null
        if (!v) return currentY
        const textH = 16
        if (currentY + textH > maxY) return currentY
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#6B7280').text(label.toUpperCase(), x, currentY, { width: lw })
        doc.fontSize(8.5).font('Helvetica').fillColor('#111827')
          .text(v, x + lw, currentY - 1, { width: vw, height: 14, ellipsis: true, lineBreak: true })
        return currentY + textH
      }

      const amountField = (label, value, x, currentY) => {
        if (currentY + 16 > maxY || value == null || value === '') return currentY
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#6B7280').text(label.toUpperCase(), x, currentY, { width: 120 })
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(fmtINR(value), x + 120, currentY - 1, { width: contentWidth - 120 })
        return currentY + 16
      }

      const sectionTitle = (title, currentY) => {
        if (currentY + 18 > maxY) return currentY
        doc.rect(margin, currentY, contentWidth, 16).fillColor('#F3F4F6').fill()
        doc.rect(margin, currentY, contentWidth, 16).strokeColor('#D1D5DB').lineWidth(0.8).stroke()
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(title, margin + 8, currentY + 4)
        return currentY + 22
      }

      const sectionBottomLine = (currentY) => {
        if (currentY + 8 > maxY) return currentY
        doc.moveTo(margin, currentY).lineTo(contentRight, currentY).strokeColor('#E5E7EB').lineWidth(0.8).stroke()
        return currentY + 8
      }

      const drawKpiRow = (cards, currentY) => {
        const validCards = cards.filter((c) => c?.value != null && c?.value !== '')
        if (!validCards.length) return currentY
        const gap = 6
        const cardW = (contentWidth - (gap * (validCards.length - 1))) / validCards.length
        const cardH = 34
        validCards.forEach((c, idx) => {
          const x = margin + idx * (cardW + gap)
          doc.rect(x, currentY, cardW, cardH).fillColor('#F3F4F6').fill()
          doc.rect(x, currentY, cardW, cardH).strokeColor('#D1D5DB').lineWidth(0.8).stroke()
          doc.fontSize(7).font('Helvetica-Bold').fillColor('#6B7280').text(c.label.toUpperCase(), x + 6, currentY + 5, { width: cardW - 12 })
          doc.fontSize(10.5).font('Helvetica-Bold').fillColor('#111827').text(c.value, x + 6, currentY + 15, { width: cardW - 12 })
        })
        return currentY + cardH + 8
      }

      const drawInlineTriplet = (items, currentY) => {
        const row = (items || []).slice(0, 3)
        while (row.length < 3) row.push({ label: '', value: null })
        const hasAnyValue = row.some((i) => i?.value != null && i?.value !== '')
        if (!hasAnyValue) return currentY
        const gap = 8
        const colW = (contentWidth - gap * 2) / 3
        let maxBottom = currentY
        for (let i = 0; i < 3; i++) {
          const item = row[i]
          const x = margin + i * (colW + gap)
          if (item?.label) {
            doc.fontSize(7).font('Helvetica-Bold').fillColor('#6B7280').text(item.label.toUpperCase(), x, currentY, { width: colW })
          }
          if (item?.value != null && item?.value !== '') {
            doc.fontSize(8.5).font('Helvetica').fillColor('#111827')
              .text(String(item.value), x, currentY + 9, { width: colW, height: 20, ellipsis: true, lineBreak: true })
          }
          maxBottom = Math.max(maxBottom, currentY + 29)
        }
        return maxBottom + 7
      }

      const drawSectionBox = (startY, endY) => {
        const h = Math.max(0, endY - startY)
        if (h <= 0) return
        doc.rect(margin, startY, contentWidth, h).strokeColor('#D1D5DB').lineWidth(0.8).stroke()
      }

      const drawKeyValueRows = (entries, currentY) => {
        const normalized = (entries || [])
          .filter((e) => e && e.value != null && e.value !== '')
          .map((e) => ({ label: String(e.label || ''), value: e.value }))
        let yPos = currentY
        for (let i = 0; i < normalized.length; i += 3) {
          yPos = drawInlineTriplet(normalized.slice(i, i + 3), yPos)
        }
        return yPos
      }

      // ─── HEADER ───
      const logoPath = path.join(__dirname, '../assets/ecs-logo.png')
      let logoH = 40
      try {
        if (fs.existsSync(logoPath)) {
          const img = doc.openImage(logoPath)
          logoH = 140 * (img.height / img.width)
          doc.image(logoPath, margin, y, { width: 140 })
        }
      } catch { /* skip logo */ }

      const boxW = 200, boxH = 44, boxX = contentRight - boxW
      doc.rect(margin, y - 8, contentWidth, 8).fillColor('#0E5BD7').fill()
      doc.rect(margin, y - 2, contentWidth * 0.33, 2).fillColor('#DC2626').fill()
      doc.rect(boxX, y, boxW, boxH).fillColor('#F9FAFB').fill()
      doc.rect(boxX, y, boxW, boxH).strokeColor('#D1D5DB').lineWidth(0.8).stroke()
      const dateStr = receipt.date ? fmtDate(receipt.date) : fmtDate(new Date())
      const receiptNo = String(receipt.receipt_no || receipt.receiptNo || '')
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#6B7280').text('RECEIPT DATE', boxX + 8, y + 6)
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(dateStr, boxX + 8, y + 15)
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#6B7280').text('RECEIPT NO', boxX + 8, y + 28)
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#111827').text(receiptNo, boxX + 78, y + 28, { width: boxW - 86 })
      y += Math.max(logoH, boxH) + 10

      doc.rect(contentRight - 150, y - 2, 150, 18).fillColor('#0E5BD7').fill()
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#FFFFFF').text('ACKNOWLEDGEMENT RECEIPT', contentRight - 150, y + 3, { width: 150, align: 'center' })
      y += 20

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
      // Client contact number (legacy receipts sometimes stored it under `phone`)
      const invMobile = val(
        receipt.investor?.mobile,
        receipt.investor_mobile,
        receipt.mobile,
        receipt.phone,
        receipt.phone_number,
        receipt.phoneNumber,
        receipt.client_phone,
        receipt.clientPhone
      )
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

      // ─── Header KPI row ───
      const fdDepositAmt = val(fd?.deposit?.amount, receipt.fd_deposit_amount, txn.amount, receipt.investment_amount, receipt.investmentAmount)
      const fdMaturityAmt = val(fd?.maturity?.amount, receipt.fd_maturity_amount)
      const fdMaturityDate = val(fd?.maturity?.date, receipt.fd_maturity_date)
      y = drawKpiRow([
        { label: 'Deposit Amount', value: fdDepositAmt != null ? fmtINR(fdDepositAmt) : null },
        { label: '', value: null },
        { label: 'Maturity Date', value: fdMaturityDate ? fmtDate(fdMaturityDate) : null }
      ], y)

      // ─── 1. EMPLOYEE DETAILS ───
      y = sectionTitle('Employee Details', y)
      const empBodyStart = y - 4
      y = drawInlineTriplet([
        { label: 'Employee Name', value: empName },
        { label: 'Employee Code', value: empCode },
        { label: 'Branch', value: empBranch }
      ], y)
      drawSectionBox(empBodyStart, y + 2)
      y = sectionBottomLine(y)

      // ─── 2. INVESTOR DETAILS ───
      y = sectionTitle('Investor Details', y)
      const invBodyStart = y - 4
      y = drawInlineTriplet([
        { label: 'Investor ID', value: invId },
        { label: 'Investor Name', value: invName },
        { label: 'PIN', value: invPin }
      ], y)
      if (invAddr) y = field('Address', invAddr, margin, y)
      y = drawInlineTriplet([
        { label: 'PAN', value: invPan },
        { label: 'Mobile', value: invMobile },
        { label: 'Email', value: invEmail }
      ], y)
      drawSectionBox(invBodyStart, y + 2)
      y = sectionBottomLine(y)

      // ─── 3. INVESTMENT DETAILS ───
      y = sectionTitle('Investment Details', y)
      const invstBodyStart = y - 4

      // Product type badge
      if (y + 16 <= maxY) {
        doc.rect(margin, y, contentWidth, 14).fillColor('#FFFFFF').fill()
        doc.rect(margin, y, contentWidth, 14).strokeColor('#D1D5DB').lineWidth(0.8).stroke()
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#111827').text(`Product: ${catLabel}`, margin + 8, y + 3)
        y += 18
      }

      // ── MF ──
      if (isMF) {
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

        const mfEntries = [
          { label: 'Product Type', value: catLabel },
          { label: 'Transaction Type', value: txnType },
          { label: 'Amount', value: investAmt != null ? fmtINR(investAmt) : null },
          { label: 'Folio / Policy No', value: folioNo }
        ]

        // Scheme display
        // - Switch Over: show Source Scheme + Target Scheme
        // - STP: show Source Scheme + Target Scheme
        // - Others: show Scheme
        const switchFrom = val(txn.switch_over?.from_scheme_name, receipt.switch_from_scheme_name)
        const switchTo = val(txn.switch_over?.to_scheme_name, receipt.switch_to_scheme_name, schemeName)
        const isSTP = String(txnType || '').trim().toUpperCase() === 'STP'
        const stpTargetForTop = val(txn.stp?.to_scheme_name, receipt.stp_target_scheme_name)
        if (txnType === 'Switch Over') {
          const sourceDisplay = switchFrom ? (switchFrom) : null
          const targetDisplay = switchTo ? (switchTo) : null
          if (sourceDisplay) mfEntries.push({ label: 'Source Scheme', value: sourceDisplay })
          if (targetDisplay) mfEntries.push({ label: 'Target Scheme', value: targetDisplay })
          if (!sourceDisplay && !targetDisplay && schemeName) {
            mfEntries.push({ label: 'Scheme', value: schemeName + (nfo ? ' [NFO]' : '') })
          }
        } else if (isSTP) {
          // For STP, DB stores:
          // - `scheme` (scheme_name) as the source scheme
          // - `stp_target_scheme_name` as the target scheme
          const sourceDisplay = schemeName ? (schemeName + (nfo ? ' [NFO]' : '')) : null
          const targetDisplay = stpTargetForTop ? stpTargetForTop : null
          if (sourceDisplay) mfEntries.push({ label: 'Source Scheme', value: sourceDisplay })
          if (targetDisplay) mfEntries.push({ label: 'Target Scheme', value: targetDisplay })
        } else if (schemeName) {
          mfEntries.push({ label: 'Scheme', value: schemeName + (nfo ? ' [NFO]' : '') })
        }
        if (sOption) {
          let optTxt = sOption
          if (sOption === 'IDCW_PAYOUT') optTxt = 'IDCW - Payout'
          else if (sOption === 'IDCW_REINVEST') optTxt = 'IDCW - Reinvestment'
          mfEntries.push({ label: 'Option', value: optTxt })
        }

        // MF detail sub-section
        if (amcName) mfEntries.push({ label: 'AMC', value: amcName })
        if (amcCat && amcCat !== 'MF') mfEntries.push({ label: 'AMC Category', value: amcCat })
        if (sCategory) {
          const catStr = sSubCat ? `${sCategory} / ${sSubCat}` : sCategory
          mfEntries.push({ label: 'Category', value: catStr })
        }
        if (sPlan || sType) {
          const planType = [sPlan, sType].filter(Boolean).join(', ')
          mfEntries.push({ label: 'Plan & Type', value: planType })
        }
        if (folioNo) mfEntries.push({ label: 'Folio Number', value: folioNo })

        // SIP
        const sip = txn.sip || {}
        const sipFreq = val(sip.frequency, receipt.sip_frequency)
        const sipStart = val(sip.start_date, receipt.sip_start_date)
        const sipEnd = val(sip.end_date, receipt.sip_end_date)
        const sipPerp = sip.is_perpetual || receipt.sip_is_perpetual
        if (sipFreq || sipStart) {
          if (sipFreq) mfEntries.push({ label: 'SIP Frequency', value: sipFreq })
          if (sipStart) mfEntries.push({ label: 'SIP Start Date', value: fmtDate(sipStart) })
          if (sipEnd) mfEntries.push({ label: 'SIP End Date', value: fmtDate(sipEnd) })
          else if (sipPerp) mfEntries.push({ label: 'SIP Type', value: 'Perpetual (40 years)' })
        }

        // STP
        const stp = txn.stp || {}
        const stpFreq = val(stp.frequency, receipt.stp_frequency)
        const stpStart = val(stp.start_date, receipt.stp_start_date)
        const stpAmt = val(stp.amount, receipt.stp_amount)
        if (stpFreq || stpStart || stpAmt != null) {
          if (stpFreq) mfEntries.push({ label: 'STP Frequency', value: stpFreq })
          if (stpStart) mfEntries.push({ label: 'STP Start Date', value: fmtDate(stpStart) })
          if (stpAmt != null) mfEntries.push({ label: 'STP Transfer Amount', value: fmtINR(stpAmt) })
        }

        // SWP
        const swp = txn.swp || {}
        const swpFreq = val(swp.frequency, receipt.swp_frequency)
        const swpStart = val(swp.start_date, receipt.swp_start_date)
        const swpAmt = val(swp.amount, receipt.swp_amount)
        if (swpFreq || swpStart) {
          if (swpFreq) mfEntries.push({ label: 'SWP Frequency', value: swpFreq })
          if (swpStart) mfEntries.push({ label: 'SWP Start Date', value: fmtDate(swpStart) })
          if (swpAmt != null) mfEntries.push({ label: 'SWP Withdrawal Amount', value: fmtINR(swpAmt) })
        }

        // Switch Over value
        if (txnType === 'Switch Over') {
          const sw = txn.switch_over || {}
          const swType = val(sw.type, receipt.switch_type)
          const swVal = val(sw.value, receipt.switch_value)
          if (swType) mfEntries.push({ label: 'Switch Type', value: swType })
          if (swVal != null) {
            mfEntries.push({ label: 'Switch Value', value: swType === 'Amount' ? fmtINR(swVal) : `${swVal} units` })
          }
        }

        y = drawKeyValueRows(mfEntries, y)
      }

      // ── FD / GOVT_FD ──
      if (isFD) {
        const productLabel = catUpper === 'GOVT_FD' ? 'Government Schemes' : 'Fixed Deposit'
        const issuerName = val(fd?.issuer?.name, receipt.fd_issuer_name)
        const issuerType = val(fd?.issuer?.type, receipt.fd_issuer_type)
        const schemeName = val(fd?.scheme?.name, receipt.fd_scheme_name)
        const depositAmt = val(fd?.deposit?.amount, receipt.fd_deposit_amount)
        const tenure = val(fd?.deposit?.tenure_months, receipt.fd_tenure_months)
        const payoutFreq = val(fd?.deposit?.payout_frequency, receipt.fd_payout_frequency)
        const rate = val(fd?.rates?.locked_interest_rate_pa, receipt.fd_locked_interest_rate_pa)
        const maturityDate = val(fd?.maturity?.date, receipt.fd_maturity_date)
        const appNo = val(fd?.application?.number, receipt.fd_application_number)
        const fdTxnType = val(fd?.application?.transaction_type, receipt.fd_transaction_type, receipt.txn_type) || 'Fresh'
        const renewType = val(fd?.application?.renewal?.investment_type, receipt.fd_renewal_investment_type)
        const renewAmt = val(fd?.application?.renewal?.additional_amount, receipt.fd_renewal_additional_amount)

        y = drawInlineTriplet([
          { label: 'Product', value: productLabel },
          { label: 'Issuer', value: issuerName ? issuerName + (issuerType ? ` (${issuerType})` : '') : null },
          { label: 'Scheme', value: schemeName }
        ], y)
        y = drawInlineTriplet([
          { label: 'Tenure', value: tenure ? `${tenure} months (${Math.floor(tenure / 12)} years)` : null },
          { label: 'Payout Frequency', value: payoutFreq },
          { label: 'Interest Rate', value: rate ? `${Number(rate).toFixed(2)}% p.a.` : null }
        ], y)

        y = drawInlineTriplet([
          { label: 'Deposit Amount', value: depositAmt != null ? fmtINR(depositAmt) : null },
          { label: '', value: null },
          { label: 'Maturity Date', value: maturityDate ? fmtDate(maturityDate) : null }
        ], y)
        y = drawInlineTriplet([
          { label: catUpper === 'GOVT_FD' ? 'Application / Scheme Number' : 'Application / FD Number', value: appNo },
          { label: 'Transaction Type', value: fdTxnType },
          { label: 'Renewal Investment', value: null }
        ], y)
        if (fdTxnType === 'Renewal' && renewType) {
          let txt = renewType === 'same' ? 'Same Amount'
            : renewType === 'increased' ? 'Increased Amount' + (renewAmt ? ` (Additional: ${fmtINR(renewAmt)})` : '')
            : renewType === 'decreased' ? 'Decreased Amount' + (renewAmt ? ` (Withdrawal: ${fmtINR(renewAmt)})` : '')
            : renewType
          y = drawInlineTriplet([
            { label: 'Renewal Investment', value: txt },
            { label: '', value: null },
            { label: '', value: null }
          ], y)
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

        y = drawKeyValueRows([
          { label: 'Issuer', value: issuer ? issuer + (issuerType ? ` (${issuerType})` : '') : null },
          { label: 'Scheme', value: scheme },
          { label: 'Amount', value: amt != null ? fmtINR(amt) : null },
          { label: 'Coupon Rate', value: coupon != null ? `${Number(coupon).toFixed(2)}% p.a.` : null },
          { label: 'Face Value', value: faceVal != null ? fmtINR(faceVal, 0) : null },
          { label: 'Issue Date', value: issueDate ? fmtDate(issueDate) : null },
          { label: 'Maturity / Renewal Due', value: matDate ? fmtDate(matDate) : null },
          { label: 'Application Number', value: appNo },
          { label: 'Transaction Type', value: bondTxnType },
          { label: 'ISIN', value: isin }
        ], y)
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

        y = drawKeyValueRows([
          { label: 'Issuer', value: issuer },
          { label: 'Product', value: product },
          { label: 'Premium Amount', value: premAmt != null ? fmtINR(premAmt) : null },
          { label: 'Policy Number', value: policyNo },
          { label: 'Sum Assured', value: sumAssured != null ? fmtINR(sumAssured, 0) : null },
          { label: 'Policy Term', value: policyTerm ? `${policyTerm} years` : null },
          { label: 'Premium Frequency', value: premFreq },
          { label: 'Date of Issue', value: startDate ? fmtDate(startDate) : null },
          { label: 'Maturity Date', value: matDate ? fmtDate(matDate) : null },
          { label: 'Transaction Type', value: insTxnType }
        ], y)
      }

      // ── MISC ──
      if (isMISC) {
        const svcName = val(misc?.service_name, receipt.service_name, receipt.serviceName)
        const svcPrice = val(misc?.service_price, receipt.service_price, receipt.servicePrice)
        y = drawKeyValueRows([
          { label: 'Service Name', value: svcName },
          { label: 'Service Price', value: svcPrice != null ? fmtINR(svcPrice) : null }
        ], y)
      }

      // CC / SI omitted from acknowledgement PDF (internal-only metrics)

      drawSectionBox(invstBodyStart, y + 2)
      y = sectionBottomLine(y)

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
        y = sectionTitle('Payment / Transaction Details', y)
        const payBodyStart = y - 4

        const mode = entryMode || (bankName ? 'Offline' : (notes || (channel && channel !== 'Cheque') ? 'Others' : 'Online'))
        const modeLabel = mode === 'Online' ? 'Online Payment'
          : mode === 'Offline' ? 'Offline Payment (Cheque / Demand Draft)'
          : mode === 'Others' ? 'Other Payment Method' : mode
        y = drawInlineTriplet([
          { label: 'Payment Type', value: modeLabel },
          { label: mode === 'Online' ? 'Reference / Transaction Number' : 'Cheque / Instrument Number', value: mode === 'Online' ? (refNo || channel) : (instNo || refNo) },
          { label: 'Date', value: (instDate || txnDate) ? fmtDate(instDate || txnDate) : null }
        ], y)

        y = drawInlineTriplet([
          { label: 'Bank', value: bankName },
          { label: 'Branch', value: bankBranch },
          { label: mode === 'Others' ? 'Details' : 'Transaction Date', value: mode === 'Others' ? (notes || channel) : (txnDate && mode !== 'Offline' ? fmtDate(txnDate) : null) }
        ], y)

        if (notes && mode !== 'Others') {
          y = drawInlineTriplet([
            { label: 'Notes', value: notes },
            { label: '', value: null },
            { label: '', value: null }
          ], y)
        }
        drawSectionBox(payBodyStart, y + 2)
      }

      y = sectionBottomLine(y)

      // ─── FOOTER ───
      if (y + 58 <= maxY) {
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#111827').text('Important Note', margin, y)
        y += 8
        doc.rect(margin, y, contentWidth, 22).fillColor('#FFFBEB').fill()
        doc.rect(margin, y, contentWidth, 22).strokeColor('#F59E0B').lineWidth(0.8).stroke()
        doc.fontSize(7).font('Helvetica').fillColor('#374151')
          .text('This acknowledgement confirms receipt of payment towards the above investment application. It does not constitute a guarantee of returns. Please verify the investor and transaction details carefully and retain this receipt for your records.', margin + 8, y + 5, { width: contentWidth - 16, lineGap: 1 })
        y += 30
        doc.moveTo(margin, y).lineTo(contentRight, y).strokeColor('#D1D5DB').lineWidth(0.8).stroke()
        y += 18
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('Investor Signature', margin + 8, y)
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151').text('Authorized Signature / Company Stamp', contentRight - 195, y)
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
    const rawReceipt = receiptRows[0]
    const { receipt: enrichedReceipt, didEnrichMobile } = await enrichReceiptWithCustomerMobile(rawReceipt)
    const receipt = normalizeReceiptCategory(enrichedReceipt)

    const isAdmin = req.user.role === 'admin'
    const sameUserId = String(receipt.user_id) === String(req.user.sub)
    const receiptEmpCode = val(receipt.emp_code, receipt.empCode, receipt.employee?.code)
    const sameEmpCode =
      receiptEmpCode != null &&
      req.user.emp_code &&
      String(receiptEmpCode).trim().toLowerCase() === String(req.user.emp_code).trim().toLowerCase()

    if (!(isAdmin || sameUserId || sameEmpCode)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    let pdfBuffer
    const forceRegenerate = req.query.force === 'true' || req.query.regenerate === 'true'

    // If normalization changes the category label (FD -> GOVT_FD), cached PDFs must be regenerated
    // so the PDF "Product" label stays correct.
    const rawCat = String(rawReceipt?.product?.category ?? rawReceipt?.product_category ?? '').trim().toUpperCase()
    const normalizedCat = String(receipt?.product?.category ?? receipt?.product_category ?? '').trim().toUpperCase()
    const shouldRegenerateForCategoryNormalization = rawCat === 'FD' && normalizedCat === 'GOVT_FD'

    const hasNonEmpty = (v) => v != null && String(v).trim() !== ''
    const hasMobileAlready = [receipt.mobile, receipt.investor?.mobile, receipt.investor_mobile].some(hasNonEmpty)
    const hasLegacyPhone = [receipt.phone, receipt.phone_number, receipt.phoneNumber, receipt.client_phone, receipt.clientPhone].some(hasNonEmpty)
    const shouldRegenerateForLegacyPhone = hasLegacyPhone && !hasMobileAlready

    if (receipt.pdf_data && !forceRegenerate && !shouldRegenerateForCategoryNormalization && !shouldRegenerateForLegacyPhone && !didEnrichMobile) {
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
          const { receipt: rec } = await enrichReceiptWithCustomerMobile(receipt)
          const normalized = normalizeReceiptCategory(rec)
          const pdfBuffer = await generateReceiptPDF(normalized)
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

    const { receipt: rec } = await enrichReceiptWithCustomerMobile(receiptRows[0])
    const normalized = normalizeReceiptCategory(rec)
    const pdfBuffer = await generateReceiptPDF(normalized)
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
