import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

export const EXPORT_COMPANY_NAME = 'ECS Financial'
export const EXPORT_TIMEZONE = 'Asia/Kolkata'
const HEADER_FILL = 'FFE8E8E8'

/**
 * @typedef {{ reportTitle?: string, from?: string, to?: string, exportedAt?: Date }} ExportMeta
 */

/** Repair common UTF-8-as-Latin-1 mojibake (e.g. en-dash shown as â€“). */
export function fixUtf8Mojibake(value) {
  const s = String(value ?? '')
  if (!s) return s
  return s
    .replace(/\u00e2\u20ac\u201c/g, '\u2013')
    .replace(/\u00e2\u20ac\u201d/g, '\u2014')
    .replace(/\u00e2\u20ac\u2122/g, '\u2019')
    .replace(/\u00e2\u20ac\u0153/g, '\u201c')
    .replace(/\u00e2\u20ac\u009d/g, '\u201d')
}

export function escapeCsvField(v) {
  if (v == null || v === '') return ''
  const s = fixUtf8Mojibake(String(v))
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function formatDisplayDate(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const d = new Date(`${raw}T00:00:00`)
  if (Number.isNaN(d.getTime())) return raw
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(d)
}

export function formatDateRange(from, to) {
  const fromLabel = formatDisplayDate(from)
  const toLabel = formatDisplayDate(to)
  if (fromLabel && toLabel) return `From Date: ${fromLabel} – To Date: ${toLabel}`
  if (fromLabel) return `From Date: ${fromLabel}`
  if (toLabel) return `To Date: ${toLabel}`
  return 'All records'
}

export function formatExportTimestamp(date = new Date()) {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: EXPORT_TIMEZONE
  }).format(date)
  return `Exported: ${formatted} IST`
}

export function normalizeReportTitle(title) {
  const base = String(title || 'Report').trim() || 'Report'
  return /report$/i.test(base) ? base : `${base} Report`
}

/**
 * @param {{ reportTitle?: string, from?: string, to?: string, exportedAt?: Date }} input
 * @returns {Required<Pick<ExportMeta, 'reportTitle'>> & ExportMeta}
 */
export function buildExportMeta({ reportTitle, from, to, exportedAt = new Date() }) {
  return {
    reportTitle: normalizeReportTitle(reportTitle),
    from: from ? String(from).trim() : '',
    to: to ? String(to).trim() : '',
    exportedAt
  }
}

/**
 * @param {ExportMeta | undefined} meta
 * @returns {string[]}
 */
export function buildCsvHeaderLines(meta) {
  if (!meta?.reportTitle) return []
  const lines = [
    EXPORT_COMPANY_NAME,
    normalizeReportTitle(meta.reportTitle),
    formatDateRange(meta.from, meta.to),
    formatExportTimestamp(meta.exportedAt)
  ]
  return lines
}

/**
 * @param {import('exceljs').Worksheet} sheet
 * @param {ExportMeta | undefined} meta
 * @returns {number} 1-based row index where column headers should be written
 */
export function appendXlsxHeaderBlock(sheet, meta) {
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
}

/**
 * Insert standardized export header rows at the top of an existing worksheet.
 * @param {import('exceljs').Worksheet} sheet
 * @param {ExportMeta | undefined} meta
 * @returns {number} Number of rows inserted (0 when meta absent)
 */
export function insertExportHeaderRows(sheet, meta) {
  if (!meta?.reportTitle) return 0
  sheet.spliceRows(
    1,
    0,
    [EXPORT_COMPANY_NAME],
    [normalizeReportTitle(meta.reportTitle)],
    [formatDateRange(meta.from, meta.to)],
    [formatExportTimestamp(meta.exportedAt)],
    []
  )
  sheet.getRow(1).getCell(1).font = { bold: true, size: 14 }
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }
  sheet.getRow(2).getCell(1).font = { bold: true, size: 12 }
  sheet.getRow(2).alignment = { vertical: 'middle', horizontal: 'center' }
  sheet.getRow(3).alignment = { vertical: 'middle', horizontal: 'center' }
  sheet.getRow(4).alignment = { vertical: 'middle', horizontal: 'center' }
  return 5
}

/**
 * @param {import('exceljs').Worksheet} sheet
 * @param {number} headerRowIndex
 */
export function styleWorksheetTableHeaderRow(sheet, headerRowIndex) {
  const row = sheet.getRow(headerRowIndex)
  row.font = { bold: true, size: 12 }
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: HEADER_FILL }
  }
  row.alignment = { vertical: 'middle', horizontal: 'center' }
  row.commit()
}

/**
 * @param {import('exceljs').Worksheet} sheet
 * @param {number} headerRowIndex
 * @param {string[]} headers
 */
export function styleXlsxHeaderRow(sheet, headerRowIndex, headers) {
  const row = sheet.getRow(headerRowIndex)
  headers.forEach((header, index) => {
    const cell = row.getCell(index + 1)
    cell.value = header
    cell.font = { bold: true }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_FILL }
    }
  })
  row.commit()
}

/**
 * @param {import('express').Response} res
 * @param {string} filenameBase
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {ExportMeta} [meta]
 */
export function sendCsvReport(res, filenameBase, headers, rows, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  const lines = []
  for (const line of buildCsvHeaderLines(meta)) {
    lines.push(escapeCsvField(line))
  }
  if (lines.length) lines.push('')
  lines.push(headers.map(escapeCsvField).join(','))
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','))
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.csv"`)
  res.send('\uFEFF' + lines.join('\n'))
}

/**
 * @param {import('express').Response} res
 * @param {string} filenameBase
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {ExportMeta} [meta]
 */
export async function sendXlsxReport(res, filenameBase, headers, rows, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Report')
  const headerRowIndex = appendXlsxHeaderBlock(sheet, meta)
  styleXlsxHeaderRow(sheet, headerRowIndex, headers)
  for (const row of rows) sheet.addRow(row)
  const buf = await workbook.xlsx.writeBuffer()
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.xlsx"`)
  res.send(Buffer.from(buf))
}

function drawPdfHeader(doc, meta) {
  doc.font('Helvetica-Bold').fontSize(14).text(EXPORT_COMPANY_NAME, { align: 'center' })
  doc.moveDown(0.2)
  doc.font('Helvetica-Bold').fontSize(12).text(normalizeReportTitle(meta?.reportTitle), { align: 'center' })
  doc.font('Helvetica').fontSize(10).text(formatDateRange(meta?.from, meta?.to), { align: 'center' })
  doc.font('Helvetica').fontSize(9).text(formatExportTimestamp(meta?.exportedAt), { align: 'center' })
  doc.moveDown(1)
}

function pdfColumnWeight(header) {
  const h = String(header || '').toLowerCase()
  if (/name|investor|scheme|company|fund|client|issuer|product|email|phone/i.test(h)) return 2.5
  if (/date|period|month|branch|receipt|application|folio|status|type/i.test(h)) return 1.2
  if (/amount|applications|cc|incentive|si|paid/i.test(h)) return 1
  return 1
}

function pdfColumnWidths(headers, usableWidth) {
  const weights = headers.map(pdfColumnWeight)
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  return weights.map((weight) => (weight / total) * usableWidth)
}

function pdfNumericHeader(header) {
  return /applications|amount|cc|incentive|si|paid/i.test(String(header || ''))
}

function drawPdfTable(doc, headers, rows, { sectionTitle = '' } = {}) {
  const margin = doc.page.margins.left || 40
  const usableWidth = doc.page.width - margin * 2
  const colWidths = pdfColumnWidths(headers, usableWidth)
  const cellPaddingX = 4
  const cellPaddingY = 3
  const headerFill = '#E8E8E8'
  const borderColor = '#CCCCCC'

  let y = doc.y

  if (sectionTitle) {
    doc.font('Helvetica-Bold').fontSize(11).text(sectionTitle, margin, y, { width: usableWidth })
    y = doc.y + 6
    doc.y = y
  }

  const ensureSpace = (rowHeight, redrawHeader = false) => {
    const bottom = doc.page.height - (doc.page.margins.bottom || margin)
    if (y + rowHeight > bottom) {
      doc.addPage()
      y = doc.page.margins.top || margin
      doc.y = y
      if (redrawHeader) drawHeaderRow()
    }
  }

  const drawHeaderRow = () => {
    const fontSize = 8
    doc.font('Helvetica-Bold').fontSize(fontSize)
    const colHeights = headers.map((header, index) => {
      const txt = String(header || '')
      return doc.heightOfString(txt, { width: colWidths[index] - cellPaddingX * 2, align: 'left' })
    })
    const rowHeight = Math.max(...colHeights, 12) + cellPaddingY * 2
    ensureSpace(rowHeight, false)

    let x = margin
    headers.forEach((header, index) => {
      const width = colWidths[index]
      doc.rect(x, y, width, rowHeight).fillAndStroke(headerFill, borderColor)
      doc.fillColor('#000000')
      doc.text(String(header || ''), x + cellPaddingX, y + cellPaddingY, {
        width: width - cellPaddingX * 2,
        align: pdfNumericHeader(header) ? 'right' : 'left'
      })
      x += width
    })
    y += rowHeight
    doc.y = y
  }

  const drawDataRow = (row) => {
    const fontSize = 7
    doc.font('Helvetica').fontSize(fontSize)
    const colHeights = headers.map((header, index) => {
      const txt = row[index] == null ? '' : String(row[index])
      return doc.heightOfString(txt, {
        width: colWidths[index] - cellPaddingX * 2,
        align: pdfNumericHeader(header) ? 'right' : 'left'
      })
    })
    const rowHeight = Math.max(...colHeights, 11) + cellPaddingY * 2
    ensureSpace(rowHeight, true)

    let x = margin
    headers.forEach((header, index) => {
      const width = colWidths[index]
      doc.rect(x, y, width, rowHeight).stroke(borderColor)
      doc.fillColor('#000000')
      const txt = row[index] == null ? '' : String(row[index])
      doc.text(txt, x + cellPaddingX, y + cellPaddingY, {
        width: width - cellPaddingX * 2,
        align: pdfNumericHeader(header) ? 'right' : 'left'
      })
      x += width
    })
    y += rowHeight
    doc.y = y
  }

  drawHeaderRow()
  for (const row of rows || []) {
    drawDataRow(row)
  }
}

/**
 * @param {import('express').Response} res
 * @param {string} filenameBase
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {ExportMeta} [meta]
 */
export async function sendPdfReport(res, filenameBase, headers, rows, meta) {
  const stamp = new Date().toISOString().split('T')[0]

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.pdf"`)

  const layout = (headers?.length || 0) > 6 ? 'landscape' : 'portrait'
  const doc = new PDFDocument({ size: 'A4', layout, margin: 36 })
  doc.pipe(res)

  drawPdfHeader(doc, meta)
  drawPdfTable(doc, headers, rows)
  doc.end()
}

const MIS_SUMMARY_TABLE_HEADERS = ['Name', 'Applications', 'Amount', 'CC', 'Incentive']

function misSummaryAggregateRow(nameKey) {
  return (row) => [
    row[nameKey] ?? '',
    row.applications ?? 0,
    row.amount ?? 0,
    row.collection_credit ?? 0,
    row.incentive_amount ?? ''
  ]
}

function groupMisSummaryIssuerSales(issuerSales = [], productSummary = []) {
  const groups = new Map()
  for (const row of issuerSales) {
    const key = String(row.product_type ?? 'Other')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const order = productSummary.map((row) => String(row.product_type ?? ''))
  const keys = [...groups.keys()]
  keys.sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    if (ia >= 0 && ib >= 0) return ia - ib
    if (ia >= 0) return -1
    if (ib >= 0) return 1
    return a.localeCompare(b)
  })
  return keys.map((key) => ({ productType: key, rows: groups.get(key) || [] }))
}

function buildMisSummarySections(data = {}) {
  const sections = [
    {
      title: 'Product Summary',
      headers: ['Product Type', ...MIS_SUMMARY_TABLE_HEADERS.slice(1)],
      rows: (data.product_summary || []).map((row) => [
        row.product_type ?? '',
        row.applications ?? 0,
        row.amount ?? 0,
        row.collection_credit ?? 0,
        row.incentive_amount ?? ''
      ])
    },
    {
      title: 'MF Category Summary',
      headers: ['Category', ...MIS_SUMMARY_TABLE_HEADERS.slice(1)],
      rows: (data.mf_category_summary || []).map((row) => [
        row.category ?? '',
        row.applications ?? 0,
        row.amount ?? 0,
        row.collection_credit ?? 0,
        row.incentive_amount ?? ''
      ])
    }
  ]

  for (const group of groupMisSummaryIssuerSales(data.issuer_sales, data.product_summary)) {
    sections.push({
      title: `Company / Fund Sales — ${group.productType}`,
      headers: ['Company / Fund', ...MIS_SUMMARY_TABLE_HEADERS.slice(1)],
      rows: group.rows.map(misSummaryAggregateRow('company_fund_name'))
    })
  }

  const pm = data.previous_month_totals || {}
  sections.push({
    title: 'Previous Month Totals',
    headers: ['Period', 'Applications', 'Amount', 'CC', 'Incentive', 'Period From', 'Period To'],
    rows: [[
      'Previous Month',
      pm.applications ?? 0,
      pm.amount ?? 0,
      pm.collection_credit ?? 0,
      pm.incentive_amount ?? '',
      pm.period_from ?? '',
      pm.period_to ?? ''
    ]]
  })

  return sections
}

export function sendMisSummaryCsvReport(res, filenameBase, data, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  const lines = []
  for (const line of buildCsvHeaderLines(meta)) {
    lines.push(escapeCsvField(line))
  }
  if (lines.length) lines.push('')

  for (const section of buildMisSummarySections(data)) {
    lines.push(escapeCsvField(section.title))
    lines.push(section.headers.map(escapeCsvField).join(','))
    for (const row of section.rows) {
      lines.push(row.map(escapeCsvField).join(','))
    }
    lines.push('')
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.csv"`)
  res.send('\uFEFF' + lines.join('\n'))
}

export async function sendMisSummaryXlsxReport(res, filenameBase, data, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  const workbook = new ExcelJS.Workbook()

  for (const section of buildMisSummarySections(data)) {
    const sheetName = section.title.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31)
    const sheet = workbook.addWorksheet(sheetName)
    const headerRowIndex = appendXlsxHeaderBlock(sheet, meta)
    styleXlsxHeaderRow(sheet, headerRowIndex, section.headers)
    for (const row of section.rows) sheet.addRow(row)
  }

  const buf = await workbook.xlsx.writeBuffer()
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.xlsx"`)
  res.send(Buffer.from(buf))
}

export async function sendMisSummaryPdfReport(res, filenameBase, data, meta) {
  const stamp = new Date().toISOString().split('T')[0]
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.pdf"`)

  const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 36 })
  doc.pipe(res)
  drawPdfHeader(doc, meta)

  const sections = buildMisSummarySections(data)
  sections.forEach((section, index) => {
    if (index > 0) doc.moveDown(0.8)
    drawPdfTable(doc, section.headers, section.rows, { sectionTitle: section.title })
  })
  doc.end()
}

/**
 * Build CSV string (for tests or inline use).
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {ExportMeta} [meta]
 */
export function buildCsvContent(headers, rows, meta) {
  const lines = []
  for (const line of buildCsvHeaderLines(meta)) {
    lines.push(escapeCsvField(line))
  }
  if (lines.length) lines.push('')
  lines.push(headers.map(escapeCsvField).join(','))
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','))
  }
  return '\uFEFF' + lines.join('\n')
}

/**
 * Build XLSX buffer (for tests or custom workbooks).
 * @param {string[]} headers
 * @param {unknown[][]} rows
 * @param {ExportMeta} [meta]
 */
export async function buildXlsxBuffer(headers, rows, meta) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Report')
  const headerRowIndex = appendXlsxHeaderBlock(sheet, meta)
  styleXlsxHeaderRow(sheet, headerRowIndex, headers)
  for (const row of rows) sheet.addRow(row)
  return workbook.xlsx.writeBuffer()
}
