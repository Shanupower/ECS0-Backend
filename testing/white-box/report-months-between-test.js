import assert from 'node:assert/strict'

import {
  computeMisMonthsFromRow,
  computeMonthsBetweenDates,
  computePerpetualSipEndDate,
  resolveSipDisplayEndDate
} from '../../services/reports/report-date-helpers.js'

assert.equal(computeMonthsBetweenDates('2024-01-01', '2024-12-31'), 11)
assert.equal(computeMonthsBetweenDates('2024-01-15', '2025-01-14'), 11)
assert.equal(computeMonthsBetweenDates('2024-01-01', '2025-01-01'), 12)
assert.equal(computeMonthsBetweenDates('2024-01-01', '2024-01-01'), 0)
assert.equal(computeMonthsBetweenDates('2025-01-01', '2024-01-01'), null)
assert.equal(computeMonthsBetweenDates('', '2024-01-01'), null)

assert.equal(
  computeMisMonthsFromRow({
    sip_start_date: '2020-01-01',
    sip_end_date: '2022-01-01'
  }),
  24
)

assert.equal(
  computeMisMonthsFromRow({
    sip_start_date: '2020-01-01',
    sip_is_perpetual: true
  }),
  480
)

assert.equal(computePerpetualSipEndDate('2020-01-01'), '2060-01-01')
assert.equal(
  resolveSipDisplayEndDate({
    start_date: '2020-06-15',
    sip_is_perpetual: true
  }),
  '2060-06-15'
)

assert.equal(
  computeMisMonthsFromRow({
    fd_deposit_date: '2023-06-01',
    fd_maturity_date: '2025-06-01'
  }),
  24
)

assert.equal(
  computeMisMonthsFromRow({
    start_date: '2021-03-01',
    end_date: '2022-03-01'
  }),
  12
)

console.log('[White Box] report months-between tests passed')
