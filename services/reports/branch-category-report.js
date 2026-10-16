import { q, getUserBranch } from '../../config/database.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import { BRANCH_CODE_AQL, BRANCH_NAME_AQL, CATEGORY_AQL } from '../../utils/report-aql-fragments.js'
import { buildReceiptReportFilters, canViewServiceIncome } from './report-query-builders.js'
import { parseBranchCodes, parseProductCategories } from '../../utils/query-list.js'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import {
  EXPORT_COMPANY_NAME,
  EXPORT_TIMEZONE,
  buildCsvHeaderLines,
  formatDateRange,
  formatExportTimestamp,
  normalizeReportTitle,
  escapeCsvField
} from './report-export.js'

export const CATEGORY_LABELS = {
  MF: 'Mutual Funds',
  FD: 'Fixed Deposit',
  GOVT_FD: 'Government Schemes',
  BOND: 'Bonds',
  NCD: 'NCD',
  INS: 'Insurance',
  SIF: 'Specialized Funds (SIF)',
  PMS: 'PMS',
  AIF: 'AIF',
  GIFT_CITY_FUNDS: 'GIFT City Funds',
  MISC: 'Misc Services',
  Other: 'Other'
}

const CATEGORY_ORDER = [
  'MF',
  'FD',
  'GOVT_FD',
  'BOND',
  'NCD',
  'INS',
  'SIF',
  'PMS',
  'AIF',
  'GIFT_CITY_FUNDS',
  'MISC',
  'Other'
]

export function formatCategoryLabel(catKey) {
  return CATEGORY_LABELS[catKey] || String(catKey || '').replace(/_/g, ' ') || 'Other'
}

/**
 * Runs the Branch-wise & Category-wise matrix aggregation.
 * Guarantees all active branches are returned (even if they have zero transactions),
 * and structures the output for 2-tier matrix display (Branch rows x Category columns).
 */
export async function runBranchCategoryReport(user, query = {}) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})

  // 1. Fetch all applicable active branches so even branches with zero transactions appear
  const branchCodes = parseBranchCodes(query)
  let branchFilter = 'FILTER branch.is_active == true'
  let branchBindVars = {}

  if (user?.role === 'employee' || user?.role === 'manager' || user?.role === 'branch') {
    const userBranch = await getUserBranch(user.sub)
    if (userBranch) {
      branchFilter += ' AND (branch.branch_code == @userBranch OR branch.branch_name == @userBranch OR branch._key == @userBranch)'
      branchBindVars.userBranch = userBranch
    }
  } else if (branchCodes.length > 0) {
    branchFilter += ' AND (branch.branch_code IN @branchCodes OR branch.branch_name IN @branchCodes OR branch._key IN @branchCodes)'
    branchBindVars.branchCodes = branchCodes
  }

  const allBranches = await q(`
    FOR branch IN branches
    ${branchFilter}
    SORT branch.branch_name ASC
    RETURN {
      branch_code: (branch.branch_code != null && branch.branch_code != "") ? branch.branch_code : branch._key,
      branch_name: (branch.branch_name != null && branch.branch_name != "") ? branch.branch_name : (branch.branch_code || "Unknown")
    }
  `, branchBindVars)

  // 2. Query receipt aggregates grouped by branch and category
  const aql = `
    FOR receipt IN receipts
    ${filterClause}
    LET b_name = ${BRANCH_NAME_AQL}
    LET b_code = ${BRANCH_CODE_AQL}
    LET cat = ${CATEGORY_AQL}
    COLLECT branch_name = (b_name != null && b_name != "" ? b_name : "Unknown"),
            branch_code = (b_code != null && b_code != "" ? b_code : "UNKNOWN"),
            product_category = (cat != null && cat != "" ? cat : "Other")
    AGGREGATE applications = LENGTH(1),
              amount = SUM(${INV_AMOUNT_AQL}),
              collection_credit = SUM(${CC_AQL}),
              incentive_amount = SUM(${SI_AQL})
    SORT branch_name ASC, amount DESC
    RETURN {
      branch_name,
      branch_code,
      product_category,
      applications,
      amount,
      collection_credit,
      incentive_amount
    }
  `

  const rawRows = await q(aql, bindVars)
  const isSiAllowed = canViewServiceIncome(user)

  // 3. Determine categories to include
  const requestedCats = parseProductCategories(query)
  const detectedCategoriesSet = new Set()

  if (requestedCats.length > 0) {
    requestedCats.forEach((cat) => detectedCategoriesSet.add(cat))
  } else {
    // Standard categories always visible
    const standardCategories = ['MF', 'FD', 'GOVT_FD', 'BOND', 'NCD', 'INS', 'MISC']
    standardCategories.forEach((cat) => detectedCategoriesSet.add(cat))
    // Also include any categories present in receipts
    for (const row of rawRows) {
      if (row.product_category) {
        detectedCategoriesSet.add(row.product_category)
      }
    }
  }

  // Order categories: standard order first, then any extra alphabetically
  const sortedCategories = Array.from(detectedCategoriesSet).sort((a, b) => {
    const idxA = CATEGORY_ORDER.indexOf(a)
    const idxB = CATEGORY_ORDER.indexOf(b)
    if (idxA !== -1 && idxB !== -1) return idxA - idxB
    if (idxA !== -1) return -1
    if (idxB !== -1) return 1
    return a.localeCompare(b)
  })

  const categoryMetaList = sortedCategories.map((key) => ({
    key,
    label: formatCategoryLabel(key),
    short_label: key
  }))

  // 4. Initialize all active branches into branchMap (even if zero receipts)
  const branchMap = new Map()
  for (const b of allBranches) {
    const bKey = `${b.branch_code}___${b.branch_name}`
    if (!branchMap.has(bKey)) {
      branchMap.set(bKey, {
        branch_code: b.branch_code,
        branch_name: b.branch_name,
        categories: {},
        total_applications: 0,
        total_collected_amount: 0,
        total_collection_credit: 0,
        total_incentive_amount: isSiAllowed ? 0 : null
      })
    }
  }

  const categoryTotals = {}
  for (const cat of sortedCategories) {
    categoryTotals[cat] = {
      applications: 0,
      amount: 0,
      collection_credit: 0,
      incentive_amount: isSiAllowed ? 0 : null
    }
  }

  let grandTotalApplications = 0
  let grandTotalAmount = 0
  let grandTotalCollectionCredit = 0
  let grandTotalIncentiveAmount = 0

  // 5. Populate receipts into branchMap
  for (const row of rawRows) {
    const bKey = `${row.branch_code}___${row.branch_name}`
    if (!branchMap.has(bKey)) {
      branchMap.set(bKey, {
        branch_code: row.branch_code,
        branch_name: row.branch_name,
        categories: {},
        total_applications: 0,
        total_collected_amount: 0,
        total_collection_credit: 0,
        total_incentive_amount: isSiAllowed ? 0 : null
      })
    }

    const b = branchMap.get(bKey)
    const cat = row.product_category || 'Other'
    const appCount = Number(row.applications) || 0
    const amt = Number(row.amount) || 0
    const cc = Number(row.collection_credit) || 0
    const si = isSiAllowed ? (Number(row.incentive_amount) || 0) : null

    b.categories[cat] = {
      applications: appCount,
      amount: amt,
      collection_credit: cc,
      incentive_amount: si
    }

    b.total_applications += appCount
    b.total_collected_amount += amt
    b.total_collection_credit += cc
    if (isSiAllowed && b.total_incentive_amount != null) {
      b.total_incentive_amount += Number(row.incentive_amount) || 0
    }

    if (!categoryTotals[cat]) {
      categoryTotals[cat] = { applications: 0, amount: 0, collection_credit: 0, incentive_amount: isSiAllowed ? 0 : null }
    }
    categoryTotals[cat].applications += appCount
    categoryTotals[cat].amount += amt
    categoryTotals[cat].collection_credit += cc
    if (isSiAllowed && categoryTotals[cat].incentive_amount != null) {
      categoryTotals[cat].incentive_amount += Number(row.incentive_amount) || 0
    }

    grandTotalApplications += appCount
    grandTotalAmount += amt
    grandTotalCollectionCredit += cc
    if (isSiAllowed) {
      grandTotalIncentiveAmount += Number(row.incentive_amount) || 0
    }
  }

  // 6. Ensure every branch has all categories initialized (0 if no transactions)
  const rows = Array.from(branchMap.values()).map((b) => {
    const fullCategories = {}
    for (const cat of sortedCategories) {
      fullCategories[cat] = b.categories[cat] || {
        applications: 0,
        amount: 0,
        collection_credit: 0,
        incentive_amount: isSiAllowed ? 0 : null
      }
    }
    return {
      ...b,
      categories: fullCategories
    }
  })

  // Sort rows alphabetically by branch_name
  rows.sort((a, b) => a.branch_name.localeCompare(b.branch_name))

  const totals = {
    total_applications: grandTotalApplications,
    total_collected_amount: grandTotalAmount,
    total_collection_credit: grandTotalCollectionCredit,
    total_incentive_amount: isSiAllowed ? grandTotalIncentiveAmount : null,
    categories: categoryTotals
  }

  return {
    categories: categoryMetaList,
    rows,
    totals,
    raw_rows: rawRows.map((r) => ({
      ...r,
      incentive_amount: isSiAllowed ? r.incentive_amount : null
    }))
  }
}

/**
 * Exports branch-category matrix report to Excel (.xlsx) with true multi-level merged headers and clean labels.
 */
export async function sendBranchCategoryXlsxReport(res, filenameBase, data, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Branch & Category-wise')

  // Top company and metadata headers
  const headerStartRow = (function appendMetaHeaderBlock() {
    if (!meta?.reportTitle) return 1

    const titleRow = sheet.addRow([EXPORT_COMPANY_NAME])
    titleRow.getCell(1).font = { bold: true, size: 14 }
    titleRow.alignment = { vertical: 'middle', horizontal: 'center' }

    const reportRow = sheet.addRow([normalizeReportTitle(meta.reportTitle)])
    reportRow.getCell(1).font = { bold: true, size: 12 }
    reportRow.alignment = { vertical: 'middle', horizontal: 'center' }

    const dateRow = sheet.addRow([formatDateRange(meta.from, meta.to)])
    dateRow.alignment = { vertical: 'middle', horizontal: 'center' }
    const tsRow = sheet.addRow([formatExportTimestamp(meta.exportedAt)])
    tsRow.alignment = { vertical: 'middle', horizontal: 'center' }
    sheet.addRow([])

    return sheet.rowCount + 1
  })()

  const categories = data.categories || []
  const totalCols = 1 + categories.length * 2 + 2

  // Merge metadata header rows across table width
  for (let r = 1; r <= 4; r++) {
    sheet.mergeCells(r, 1, r, totalCols)
  }

  const row1Index = headerStartRow
  const row2Index = headerStartRow + 1

  const headerRow1 = sheet.getRow(row1Index)
  const headerRow2 = sheet.getRow(row2Index)

  // Column 1: Branch
  headerRow1.getCell(1).value = 'Branch'
  sheet.mergeCells(row1Index, 1, row2Index, 1)

  let colIdx = 2
  for (const cat of categories) {
    const startCol = colIdx
    const endCol = colIdx + 1

    // Clean full category label without short label badge
    headerRow1.getCell(startCol).value = cat.label
    sheet.mergeCells(row1Index, startCol, row1Index, endCol)

    headerRow2.getCell(startCol).value = 'Applications'
    headerRow2.getCell(endCol).value = 'Amount'

    colIdx += 2
  }

  // Overall Total columns
  const totalStartCol = colIdx
  const totalEndCol = colIdx + 1
  headerRow1.getCell(totalStartCol).value = 'TOTAL'
  sheet.mergeCells(row1Index, totalStartCol, row1Index, totalEndCol)

  headerRow2.getCell(totalStartCol).value = 'Applications'
  headerRow2.getCell(totalEndCol).value = 'Amount'

  // Style header rows
  const HEADER_FILL = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8E8E8' }
  }
  const BORDER_STYLE = {
    top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
    right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
  }

  for (let c = 1; c <= totalCols; c++) {
    const c1 = headerRow1.getCell(c)
    const c2 = headerRow2.getCell(c)
    for (const cell of [c1, c2]) {
      cell.fill = HEADER_FILL
      cell.font = { bold: true, size: 10 }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
      cell.border = BORDER_STYLE
    }
  }

  // Add Data Rows
  for (const branch of data.rows || []) {
    const rowValues = [branch.branch_name]
    for (const cat of categories) {
      const catData = branch.categories?.[cat.key] || { applications: 0, amount: 0 }
      rowValues.push(catData.applications || 0)
      rowValues.push(catData.amount || 0)
    }
    rowValues.push(branch.total_applications || 0)
    rowValues.push(branch.total_collected_amount || 0)

    const r = sheet.addRow(rowValues)
    r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' }
    r.getCell(1).border = BORDER_STYLE

    let cIndex = 2
    for (let i = 0; i <= categories.length; i++) {
      const applCell = r.getCell(cIndex)
      const amtCell = r.getCell(cIndex + 1)

      applCell.alignment = { vertical: 'middle', horizontal: 'right' }
      applCell.numFmt = '#,##0'
      applCell.border = BORDER_STYLE

      amtCell.alignment = { vertical: 'middle', horizontal: 'right' }
      amtCell.numFmt = '₹#,##0.00'
      amtCell.border = BORDER_STYLE

      cIndex += 2
    }
  }

  // Grand Total Row
  const totalRowValues = ['Grand Total']
  for (const cat of categories) {
    const catTotals = data.totals?.categories?.[cat.key] || { applications: 0, amount: 0 }
    totalRowValues.push(catTotals.applications || 0)
    totalRowValues.push(catTotals.amount || 0)
  }
  totalRowValues.push(data.totals?.total_applications || 0)
  totalRowValues.push(data.totals?.total_collected_amount || 0)

  const grandRow = sheet.addRow(totalRowValues)
  grandRow.font = { bold: true }
  grandRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' }
  grandRow.getCell(1).border = BORDER_STYLE

  let gColIdx = 2
  for (let i = 0; i <= categories.length; i++) {
    const applCell = grandRow.getCell(gColIdx)
    const amtCell = grandRow.getCell(gColIdx + 1)

    applCell.alignment = { vertical: 'middle', horizontal: 'right' }
    applCell.numFmt = '#,##0'
    applCell.border = BORDER_STYLE

    amtCell.alignment = { vertical: 'middle', horizontal: 'right' }
    amtCell.numFmt = '₹#,##0.00'
    amtCell.border = BORDER_STYLE

    gColIdx += 2
  }

  // Set column widths
  sheet.getColumn(1).width = 24
  for (let c = 2; c <= totalCols; c += 2) {
    sheet.getColumn(c).width = 16 // Applications
    sheet.getColumn(c + 1).width = 24 // Total Collected Amount
  }

  const buf = await workbook.xlsx.writeBuffer()
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.xlsx"`)
  res.send(Buffer.from(buf))
}

/**
 * Exports branch-category matrix report to CSV with clean full labels.
 */
export function sendBranchCategoryCsvReport(res, filenameBase, data, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  const lines = buildCsvHeaderLines(meta)
  if (lines.length) lines.push('')

  const categories = data.categories || []
  const headers = ['Branch']
  for (const cat of categories) {
    headers.push(`${cat.label} Applications`)
    headers.push(`${cat.label} Amount`)
  }
  headers.push('Total Applications')
  headers.push('Total Amount')

  lines.push(headers.map(escapeCsvField).join(','))

  for (const branch of data.rows || []) {
    const row = [branch.branch_name]
    for (const cat of categories) {
      const catData = branch.categories?.[cat.key] || { applications: 0, amount: 0 }
      row.push(catData.applications || 0)
      row.push(catData.amount || 0)
    }
    row.push(branch.total_applications || 0)
    row.push(branch.total_collected_amount || 0)
    lines.push(row.map(escapeCsvField).join(','))
  }

  // Grand Total row
  const totalRow = ['Grand Total']
  for (const cat of categories) {
    const catTotals = data.totals?.categories?.[cat.key] || { applications: 0, amount: 0 }
    totalRow.push(catTotals.applications || 0)
    totalRow.push(catTotals.amount || 0)
  }
  totalRow.push(data.totals?.total_applications || 0)
  totalRow.push(data.totals?.total_collected_amount || 0)
  lines.push(totalRow.map(escapeCsvField).join(','))

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.csv"`)
  res.send('\uFEFF' + lines.join('\n'))
}

/**
 * Exports branch-category matrix report to PDF with clean full labels.
 */
export async function sendBranchCategoryPdfReport(res, filenameBase, data, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.pdf"`)

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 20 })
  doc.pipe(res)

  // Header
  doc.font('Helvetica-Bold').fontSize(13).text(EXPORT_COMPANY_NAME, { align: 'center' })
  doc.moveDown(0.2)
  doc.font('Helvetica-Bold').fontSize(11).text(normalizeReportTitle(meta?.reportTitle), { align: 'center' })
  doc.font('Helvetica').fontSize(9).text(formatDateRange(meta?.from, meta?.to), { align: 'center' })
  doc.font('Helvetica').fontSize(8).text(formatExportTimestamp(meta?.exportedAt), { align: 'center' })
  doc.moveDown(0.8)

  const categories = data.categories || []
  const margin = 20
  const usableWidth = doc.page.width - margin * 2

  const branchWidth = Math.min(88, usableWidth * 0.12)
  const remWidth = usableWidth - branchWidth
  const numBlocks = Math.max(1, categories.length + 1)
  const blockWidth = remWidth / numBlocks
  const applWidth = Math.max(22, Math.floor(blockWidth * 0.28))
  const amtWidth = blockWidth - applWidth

  const headerFill = '#E8E8E8'
  const borderColor = '#CCCCCC'
  const cellPadX = 2
  const cellPadY = 2

  let y = doc.y

  const drawHeaders = () => {
    doc.font('Helvetica-Bold').fontSize(7)
    const row1Height = 14
    const row2Height = 13

    // Branch cell spanning row 1 & row 2
    doc.rect(margin, y, branchWidth, row1Height + row2Height).fillAndStroke(headerFill, borderColor)
    doc.fillColor('#000000')
    doc.text('Branch', margin + cellPadX, y + cellPadY + 4, { width: branchWidth - cellPadX * 2, align: 'left', lineBreak: false })

    let x = margin + branchWidth
    for (const cat of categories) {
      doc.rect(x, y, blockWidth, row1Height).fillAndStroke(headerFill, borderColor)
      doc.fillColor('#000000')
      // Clean category label
      doc.fontSize(6.5).text(cat.label, x + cellPadX, y + 3, { width: blockWidth - cellPadX * 2, align: 'center', lineBreak: false })

      // Row 2 sub-headers
      doc.rect(x, y + row1Height, applWidth, row2Height).fillAndStroke(headerFill, borderColor)
      doc.rect(x + applWidth, y + row1Height, amtWidth, row2Height).fillAndStroke(headerFill, borderColor)
      doc.fillColor('#000000')
      doc.fontSize(6).text('Appl', x + cellPadX, y + row1Height + 3, { width: applWidth - cellPadX * 2, align: 'right', lineBreak: false })
      doc.fontSize(6).text('Amount', x + applWidth + cellPadX, y + row1Height + 3, { width: amtWidth - cellPadX * 2, align: 'right', lineBreak: false })

      x += blockWidth
    }

    // TOTAL header
    doc.rect(x, y, blockWidth, row1Height).fillAndStroke(headerFill, borderColor)
    doc.fillColor('#000000')
    doc.fontSize(6.5).text('TOTAL', x + cellPadX, y + 3, { width: blockWidth - cellPadX * 2, align: 'center', lineBreak: false })

    doc.rect(x, y + row1Height, applWidth, row2Height).fillAndStroke(headerFill, borderColor)
    doc.rect(x + applWidth, y + row1Height, amtWidth, row2Height).fillAndStroke(headerFill, borderColor)
    doc.fillColor('#000000')
    doc.fontSize(6).text('Appl', x + cellPadX, y + row1Height + 3, { width: applWidth - cellPadX * 2, align: 'right', lineBreak: false })
    doc.fontSize(6).text('Amount', x + applWidth + cellPadX, y + row1Height + 3, { width: amtWidth - cellPadX * 2, align: 'right', lineBreak: false })

    y += row1Height + row2Height
    doc.y = y
  }

  const formatAmount = (num) => {
    if (!num) return '0'
    const rounded = Math.round(Number(num) || 0)
    return rounded.toLocaleString('en-IN', { maximumFractionDigits: 0 })
  }

  const drawRow = (branchName, catMap, totalAppl, totalAmt, isBold = false) => {
    const rowHeight = 13
    const bottom = doc.page.height - (doc.page.margins.bottom || margin)
    if (y + rowHeight > bottom) {
      doc.addPage()
      y = doc.page.margins.top || margin
      drawHeaders()
    }

    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica')

    // Branch Name
    doc.rect(margin, y, branchWidth, rowHeight).stroke(borderColor)
    doc.fillColor('#000000')
    doc.fontSize(6.5).text(branchName, margin + cellPadX, y + 3, { width: branchWidth - cellPadX * 2, align: 'left', lineBreak: false })

    let x = margin + branchWidth
    for (const cat of categories) {
      const catData = catMap[cat.key] || { applications: 0, amount: 0 }
      doc.rect(x, y, applWidth, rowHeight).stroke(borderColor)
      doc.fontSize(6.5).text(String(catData.applications || 0), x + cellPadX, y + 3, { width: applWidth - cellPadX * 2, align: 'right', lineBreak: false })

      doc.rect(x + applWidth, y, amtWidth, rowHeight).stroke(borderColor)
      const amtStr = formatAmount(catData.amount)
      const fSize = amtStr.length > 12 ? 5.5 : (amtStr.length > 9 ? 6 : 6.5)
      doc.fontSize(fSize).text(amtStr, x + applWidth + cellPadX, y + 3, { width: amtWidth - cellPadX * 2, align: 'right', lineBreak: false })

      x += blockWidth
    }

    // Totals
    doc.rect(x, y, applWidth, rowHeight).stroke(borderColor)
    doc.fontSize(6.5).text(String(totalAppl || 0), x + cellPadX, y + 3, { width: applWidth - cellPadX * 2, align: 'right', lineBreak: false })

    doc.rect(x + applWidth, y, amtWidth, rowHeight).stroke(borderColor)
    const totalAmtStr = formatAmount(totalAmt)
    const totalFSize = totalAmtStr.length > 12 ? 5.5 : (totalAmtStr.length > 9 ? 6 : 6.5)
    doc.fontSize(totalFSize).text(totalAmtStr, x + applWidth + cellPadX, y + 3, { width: amtWidth - cellPadX * 2, align: 'right', lineBreak: false })

    y += rowHeight
    doc.y = y
  }

  drawHeaders()

  for (const branch of data.rows || []) {
    drawRow(branch.branch_name, branch.categories || {}, branch.total_applications, branch.total_collected_amount, false)
  }

  // Grand Total row
  drawRow('Grand Total', data.totals?.categories || {}, data.totals?.total_applications, data.totals?.total_collected_amount, true)

  doc.end()
}
