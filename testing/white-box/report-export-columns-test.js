import assert from 'node:assert/strict'

import { filterReportExportColumns } from '../../routes/reports.js'

const headers = ['Name', 'Amount', 'CC', 'SI', 'Incentive']
const rows = [
  ['Ravi', 100, 10, 2, 3]
]

const hidden = filterReportExportColumns(headers, rows, { hide_cc: '1', hide_si: '1' })

assert.deepEqual(hidden.headers, ['Name', 'Amount'])
assert.deepEqual(hidden.rows, [['Ravi', 100]])

console.log('[White Box] report export column tests passed')
