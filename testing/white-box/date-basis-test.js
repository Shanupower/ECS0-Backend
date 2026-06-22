import assert from 'node:assert/strict'

import {
  normalizeDateForCompareAql,
  normalizeQueryDate,
  transactionDateExprAql
} from '../../utils/date-basis.js'
import { buildReceiptReportFilters } from '../../services/reports/report-query-builders.js'

assert.match(normalizeDateForCompareAql('receipt.date'), /SUBSTRING\(TO_STRING\(receipt\.date\), 0, 10\)/)
assert.equal(normalizeQueryDate('2024-06-15T12:00:00Z'), '2024-06-15')
assert.equal(normalizeQueryDate('bad'), '')

assert.match(transactionDateExprAql(), /receipt\.transaction\.date/)

;(async () => {
  const user = { role: 'admin', sub: '1' }
  const { filterClause, bindVars } = await buildReceiptReportFilters(
    user,
    { from: '2024-01-01', to: '2024-12-31' },
    {}
  )
  assert.match(filterClause, /SUBSTRING\(TO_STRING/)
  assert.equal(bindVars.from, '2024-01-01')
  assert.equal(bindVars.to, '2024-12-31')
  console.log('[White Box] date-basis tests passed')
})()
