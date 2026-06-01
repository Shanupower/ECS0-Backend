import assert from 'node:assert/strict'

import {
  computeNextSipDueDate,
  computeNextSipDueDateInWindow,
  dateWindowContains,
  normalizeReportDateBasis
} from '../../services/reports/report-date-helpers.js'

function testNormalizeReportDateBasis() {
  assert.equal(normalizeReportDateBasis('transaction'), 'transaction')
  assert.equal(normalizeReportDateBasis('fd_maturity'), 'fd_maturity')
  assert.equal(normalizeReportDateBasis('sip_due'), 'sip_due')
  assert.equal(normalizeReportDateBasis('sip_end'), 'sip_end')
  assert.equal(normalizeReportDateBasis('unexpected'), 'receipt')
}

function testComputeNextSipDueDate() {
  assert.equal(computeNextSipDueDate('2026-01-10', 'Monthly', '2026-05-25'), '2026-06-10')
  assert.equal(computeNextSipDueDate('2026-05-30', 'Monthly', '2026-05-25'), '2026-05-30')
  assert.equal(computeNextSipDueDate('2026-01-10', 'Quarterly', '2026-05-25'), '2026-07-10')
  assert.equal(computeNextSipDueDate('2026-01-10', 'Monthly', '2026-05-25', '2026-05-10'), '')
}

function testComputeNextSipDueDateInWindow() {
  assert.equal(
    computeNextSipDueDateInWindow('2026-01-10', 'Monthly', '2026-07-01', '2026-07-31', '2026-05-25'),
    '2026-07-10'
  )
  assert.equal(
    computeNextSipDueDateInWindow('2026-01-10', 'Monthly', '2026-04-01', '2026-04-30', '2026-05-25'),
    '2026-04-10'
  )
  assert.equal(
    computeNextSipDueDateInWindow('2026-01-10', 'Monthly', '2026-07-01', '2026-07-31', '2026-05-25', '2026-06-10'),
    ''
  )
  assert.equal(
    computeNextSipDueDateInWindow('2020-01-01', 'Daily', '2026-07-01', '2026-07-31', '2026-05-25'),
    '2026-07-01'
  )
  assert.equal(
    computeNextSipDueDateInWindow('2026-01-10', 'Monthly', '', '2026-04-30', '2026-05-25'),
    '2026-01-10'
  )
}

function testDateWindowContains() {
  assert.equal(dateWindowContains('2026-05-25', '2026-05-01', '2026-05-31'), true)
  assert.equal(dateWindowContains('2026-06-01', '2026-05-01', '2026-05-31'), false)
  assert.equal(dateWindowContains('', '2026-05-01', '2026-05-31'), false)
}

testNormalizeReportDateBasis()
testComputeNextSipDueDate()
testComputeNextSipDueDateInWindow()
testDateWindowContains()

console.log('[White Box] report helper tests passed')
