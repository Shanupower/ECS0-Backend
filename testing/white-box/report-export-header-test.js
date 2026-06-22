import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'

import {
  buildCsvContent,
  buildExportMeta,
  buildXlsxBuffer,
  EXPORT_COMPANY_NAME,
  formatDateRange
} from '../../services/reports/report-export.js'
import { parsePagination } from '../../services/reports/report-query-builders.js'

const headers = ['Name', 'Amount']
const rows = [['Alpha', 100]]
const meta = buildExportMeta({
  reportTitle: 'MIS Summary',
  from: '2024-01-01',
  to: '2026-06-02',
  exportedAt: new Date('2026-06-02T10:15:30+05:30')
})

const csv = buildCsvContent(headers, rows, meta)
assert.ok(csv.includes(EXPORT_COMPANY_NAME), 'CSV should include company name')
assert.ok(csv.includes('MIS Summary Report'), 'CSV should include report title')
assert.ok(csv.includes(formatDateRange('2024-01-01', '2026-06-02')), 'CSV should include date range')
assert.ok(csv.includes('Exported:'), 'CSV should include export timestamp')
assert.ok(csv.includes('Name,Amount'), 'CSV should include column headers')
assert.ok(csv.includes('Alpha,100'), 'CSV should include data rows')

const xlsxBuf = await buildXlsxBuffer(headers, rows, meta)
const workbook = new ExcelJS.Workbook()
await workbook.xlsx.load(xlsxBuf)
const sheet = workbook.getWorksheet('Report')
assert.equal(sheet.getRow(1).getCell(1).value, EXPORT_COMPANY_NAME)
assert.equal(sheet.getRow(2).getCell(1).value, 'MIS Summary Report')
assert.equal(sheet.getRow(6).getCell(1).value, 'Name')
assert.equal(sheet.getRow(6).getCell(1).font?.bold, true)
assert.equal(sheet.getRow(6).getCell(2).font?.bold, true)
assert.equal(sheet.getRow(7).getCell(1).value, 'Alpha')

const pendingExportPagination = parsePagination(
  { page: '1', page_size: '50000', format: 'csv' },
  { maxPageSize: true ? 50000 : 200 }
)
assert.equal(pendingExportPagination.pageSize, 50000, 'export pagination should allow full dataset page size')

console.log('[White Box] report export header tests passed')
