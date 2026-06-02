import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

export const EXPORT_COMPANY_NAME = 'ECS Financial'
export const EXPORT_TIMEZONE = 'Asia/Kolkata'
const HEADER_FILL = 'FFE8E8E8'

/**
 * @typedef {{ reportTitle?: string, from?: string, to?: string, exportedAt?: Date }} ExportMeta
 */

export function escapeCsvField(v) {
  if (v == null || v === '') return ''
  const s = String(v)
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

function drawPdfTable(doc, headers, rows) {
  const margin = doc.page.margins.left || 40
  const usableWidth = doc.page.width - margin * 2
  const colCount = Math.max(1, headers.length)
  const colWidth = usableWidth / colCount

  const numericHeader = (h) => /applications|amount|cc|incentive/i.test(String(h || ''))

  const cellPaddingX = 2
  const cellPaddingY = 2

  let y = doc.y

  const ensureSpace = (rowHeight) => {
    const bottom = doc.page.height - margin
    if (y + rowHeight > bottom) {
      doc.addPage()
      y = doc.y
    }
  }

  const drawRow = (row, { isHeader = false } = {}) => {
    const font = isHeader ? 'Helvetica-Bold' : 'Helvetica'
    const fontSize = isHeader ? 10 : 9
    doc.font(font).fontSize(fontSize)

    const colHeights = headers.map((_, i) => {
      const txt = row[i] == null ? '' : String(row[i])
      return doc.heightOfString(txt, { width: colWidth - cellPaddingX * 2, align: 'left' })
    })

    const rowHeight = Math.max(...colHeights, 14) + cellPaddingY * 2
    ensureSpace(rowHeight)

    headers.forEach((h, i) => {
      const txt = row[i] == null ? '' : String(row[i])
      const x = margin + i * colWidth + cellPaddingX
      const align = numericHeader(h) ? 'right' : 'left'
      doc.text(txt, x, y, { width: colWidth - cellPaddingX * 2, align })
    })

    y += rowHeight
    doc.y = y
  }

  // Header row
  drawRow(headers, { isHeader: true })
  // Data rows
  for (const r of rows || []) {
    drawRow(r)
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

  const doc = new PDFDocument({ size: 'A4', margin: 40 })
  doc.pipe(res)

  drawPdfHeader(doc, meta)
  drawPdfTable(doc, headers, rows)
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
