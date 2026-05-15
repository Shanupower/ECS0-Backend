import ExcelJS from 'exceljs'

export function escapeCsvField(v) {
  if (v == null || v === '') return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * @param {import('express').Response} res
 * @param {string} filenameBase
 * @param {string[]} headers
 * @param {unknown[][]} rows
 */
export function sendCsvReport(res, filenameBase, headers, rows) {
  const stamp = new Date().toISOString().split('T')[0]
  const lines = [headers.map(escapeCsvField).join(',')]
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
 */
export async function sendXlsxReport(res, filenameBase, headers, rows) {
  const stamp = new Date().toISOString().split('T')[0]
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Report')
  sheet.addRow(headers)
  for (const row of rows) sheet.addRow(row)
  const buf = await workbook.xlsx.writeBuffer()
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.xlsx"`)
  res.send(Buffer.from(buf))
}
