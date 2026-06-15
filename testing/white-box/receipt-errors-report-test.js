import assert from 'node:assert/strict'

import {
  amountsWithinTolerance,
  buildDupTxnKey,
  buildSummaryFromRows,
  classifyReceiptErrors,
  groupHasNearDuplicateAmounts,
  parseErrorTypeFilter,
  resolveEffectiveAmount,
  resolveReferenceNo
} from '../../services/reports/receipt-errors-report.js'

function testBuildDupTxnKey() {
  assert.equal(buildDupTxnKey('C001', 'MF', '2026-01-15'), 'C001|MF|2026-01-15')
}

function testAmountsWithinTolerance() {
  assert.equal(amountsWithinTolerance(1000, 1001), true)
  assert.equal(amountsWithinTolerance(1000, 1002), false)
  assert.equal(amountsWithinTolerance('1000', '1000.5'), true)
  assert.equal(amountsWithinTolerance('abc', 1000), false)
}

function testGroupHasNearDuplicateAmounts() {
  assert.equal(groupHasNearDuplicateAmounts([1000, 1001]), true)
  assert.equal(groupHasNearDuplicateAmounts([1000, 1002]), false)
  assert.equal(groupHasNearDuplicateAmounts([1000]), false)
}

function testResolveEffectiveAmount() {
  assert.equal(resolveEffectiveAmount({ transaction: { amount: 5000 } }), 5000)
  assert.equal(resolveEffectiveAmount({ investment_amount: 2500 }), 2500)
  assert.equal(resolveEffectiveAmount({ product_details: { fd: { deposit: { amount: 10000 } } } }), 10000)
  assert.equal(resolveEffectiveAmount({ service_price: 999 }), 999)
  assert.equal(resolveEffectiveAmount({}), 0)
}

function testResolveReferenceNo() {
  assert.equal(resolveReferenceNo({ payment: { reference_no: 'UTR123' } }), 'UTR123')
  assert.equal(resolveReferenceNo({ reference_no: 'REF1' }), 'REF1')
  assert.equal(resolveReferenceNo({ transaction_reference_no: 'REF2' }), 'REF2')
  assert.equal(resolveReferenceNo({}), null)
}

function testClassifyReceiptErrors() {
  const dupTxnKeys = [buildDupTxnKey('C001', 'MF', '2026-01-15')]
  const dupReceiptNos = ['R-100']

  const full = classifyReceiptErrors(
    {
      receipt_no: 'R-100',
      date: '2026-01-15',
      investor: { id: 'C001', pan: '', mobile: '' },
      product: { category: 'MF' },
      transaction: { amount: 0 }
    },
    { dupTxnKeys, dupReceiptNos }
  )
  assert.ok(full.includes('duplicate_transaction'))
  assert.ok(full.includes('duplicate_receipt_number'))
  assert.ok(full.includes('missing_pan'))
  assert.ok(full.includes('missing_mobile'))
  assert.ok(full.includes('invalid_amount'))

  const invalidNumeric = classifyReceiptErrors({
    receipt_no: 'R-200',
    date: '2026-01-16',
    investor: { id: 'C002', pan: 'ABCDE1234F', mobile: '9876543210' },
    product: { category: 'FD' },
    transaction: { amount: 'not-a-number' },
    payment: { reference_no: 'UTR1' }
  })
  assert.deepEqual(invalidNumeric, ['invalid_amount'])

  const blankRef = classifyReceiptErrors({
    receipt_no: 'R-300',
    date: '2026-01-17',
    investor: { id: 'C003', pan: 'ABCDE1234F', mobile: '9876543210' },
    product: { category: 'MF' },
    transaction: { amount: 5000 },
    payment: { reference_no: '  ' }
  })
  assert.deepEqual(blankRef, ['blank_reference'])

  const peerDup = classifyReceiptErrors(
    {
      receipt_no: 'R-400',
      date: '2026-01-18',
      investor: { id: 'C004', pan: 'ABCDE1234F', mobile: '9876543210' },
      product: { category: 'MF' },
      transaction: { amount: 1000 },
      payment: { reference_no: 'UTR9' }
    },
    {
      peerAmountsByKey: {
        [buildDupTxnKey('C004', 'MF', '2026-01-18')]: [1001]
      }
    }
  )
  assert.deepEqual(peerDup, ['duplicate_transaction'])
}

function testBuildSummaryFromRows() {
  const summary = buildSummaryFromRows([
    { error_types: ['missing_pan', 'blank_reference'] },
    { error_types: ['missing_pan'] }
  ])
  assert.equal(summary.missing_pan, 2)
  assert.equal(summary.blank_reference, 1)
  assert.equal(summary.total_receipts_with_issues, 2)
}

function testParseErrorTypeFilter() {
  assert.deepEqual(parseErrorTypeFilter({ error_type: 'missing_pan,invalid_amount' }), [
    'missing_pan',
    'invalid_amount'
  ])
  assert.deepEqual(parseErrorTypeFilter({ error_type: 'unknown' }), [])
}

testBuildDupTxnKey()
testAmountsWithinTolerance()
testGroupHasNearDuplicateAmounts()
testResolveEffectiveAmount()
testResolveReferenceNo()
testClassifyReceiptErrors()
testBuildSummaryFromRows()
testParseErrorTypeFilter()

console.log('[White Box] receipt-errors-report tests passed')
