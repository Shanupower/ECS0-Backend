import assert from 'node:assert/strict'

import {
  amountsWithinTolerance,
  buildDupTxnKey,
  buildSummaryFromRows,
  classifyReceiptErrors,
  groupHasNearDuplicateAmounts,
  isDuplicateTxnPair,
  parseErrorTypeFilter,
  resolveEffectiveAmount,
  resolvePaymentInstrument,
  resolveReferenceNo,
  resolveSchemeName,
  resolveTxnDate
} from '../../services/reports/receipt-errors-report.js'

function testBuildDupTxnKey() {
  assert.equal(buildDupTxnKey('C001', 'MF', 'HDFC Top 100', '2026-01-15', 'UTR1'), 'C001|mf|hdfc top 100|2026-01-15|utr1')
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
  assert.equal(resolveReferenceNo({ channel: 'RTGS-999' }), 'RTGS-999')
  assert.equal(resolveReferenceNo({}), null)
}

function testResolvePaymentInstrument() {
  assert.equal(resolvePaymentInstrument({ payment: { reference_no: 'UTR123' } }), 'UTR123')
  assert.equal(resolvePaymentInstrument({ chequeNumber: '004521' }), '004521')
  assert.equal(resolvePaymentInstrument({ payment: { instrument: { number: 'CHQ99' } } }), 'CHQ99')
  assert.equal(resolvePaymentInstrument({ channel: 'RTGS-999' }), 'RTGS-999')
  assert.equal(resolvePaymentInstrument({}), '')
}

function testOptionBDuplicateLogic() {
  // Case 1: Same client, same date, same amount, BUT DIFFERENT SCHEMES => NOT DUPLICATE!
  const r1 = {
    investor: { id: 'C001' },
    product: { category: 'MF' },
    scheme_name: 'HDFC Top 100',
    date: '2026-09-24',
    transaction: { amount: 10000 },
    payment: { reference_no: 'UTR100' }
  }
  const r2 = {
    investor: { id: 'C001' },
    product: { category: 'MF' },
    scheme_name: 'SBI Bluechip',
    date: '2026-09-24',
    transaction: { amount: 10000 },
    payment: { reference_no: 'UTR100' }
  }
  assert.equal(isDuplicateTxnPair(r1, r2), false, 'Different schemes must not be flagged as duplicates')

  // Case 2: Same client, same scheme, same date, same amount, SAME UTR => DUPLICATE!
  const r3 = {
    investor: { id: 'C001' },
    product: { category: 'MF' },
    scheme_name: 'HDFC Top 100',
    date: '2026-09-24',
    transaction: { amount: 10000 },
    payment: { reference_no: 'UTR100' }
  }
  assert.equal(isDuplicateTxnPair(r1, r3), true, 'Same UTR + same scheme + same client + date + amt must be duplicate')

  // Case 3: Same client, same scheme, same date, same amount, DIFFERENT UTR => NOT DUPLICATE!
  const r4 = {
    investor: { id: 'C001' },
    product: { category: 'MF' },
    scheme_name: 'HDFC Top 100',
    date: '2026-09-24',
    transaction: { amount: 10000 },
    payment: { reference_no: 'UTR999' }
  }
  assert.equal(isDuplicateTxnPair(r1, r4), false, 'Different UTRs must not be flagged as duplicates')

  // Case 4: Same client, same scheme, same date, same amount, SAME CHEQUE => DUPLICATE!
  const chq1 = {
    investor: { id: 'C002' },
    product: { category: 'FD' },
    scheme_name: 'Bajaj Finance FD',
    date: '2026-09-24',
    transaction: { amount: 50000 },
    chequeNumber: '004521'
  }
  const chq2 = {
    investor: { id: 'C002' },
    product: { category: 'FD' },
    scheme_name: 'Bajaj Finance FD',
    date: '2026-09-24',
    transaction: { amount: 50000 },
    chequeNumber: '004521'
  }
  assert.equal(isDuplicateTxnPair(chq1, chq2), true, 'Same cheque + same scheme + same client + date + amt must be duplicate')

  // Case 5: Option B Fallback: Both UTR/Cheque blank => DUPLICATE!
  const blankRef1 = {
    investor: { id: 'C003' },
    product: { category: 'MF' },
    scheme_name: 'Axis Midcap',
    date: '2026-09-24',
    transaction: { amount: 2000 }
  }
  const blankRef2 = {
    investor: { id: 'C003' },
    product: { category: 'MF' },
    scheme_name: 'Axis Midcap',
    date: '2026-09-24',
    transaction: { amount: 2000 }
  }
  assert.equal(isDuplicateTxnPair(blankRef1, blankRef2), true, 'Blank payment ref fallback must match identical client, scheme, date, amount')
}

function testClassifyReceiptErrors() {
  const dupTxnReceiptIds = ['R-100']
  const dupReceiptNos = ['R-100']

  const full = classifyReceiptErrors(
    {
      _key: 'R-100',
      receipt_no: 'R-100',
      date: '2026-01-15',
      investor: { id: 'C001', pan: '', mobile: '' },
      product: { category: 'MF' },
      transaction: { amount: 0 }
    },
    { dupTxnReceiptIds, dupReceiptNos }
  )
  assert.ok(full.includes('duplicate_transaction'))
  assert.ok(full.includes('duplicate_receipt_number'))
  assert.ok(full.includes('invalid_amount'))
  assert.equal(full.includes('missing_pan'), false)
  assert.equal(full.includes('missing_mobile'), false)
  assert.equal(full.includes('blank_reference'), false)

  const invalidNumeric = classifyReceiptErrors({
    receipt_no: 'R-200',
    date: '2026-01-16',
    investor: { id: 'C002', pan: 'ABCDE1234F', mobile: '9876543210' },
    product: { category: 'FD' },
    transaction: { amount: 'not-a-number' },
    payment: { reference_no: 'UTR1' }
  })
  assert.deepEqual(invalidNumeric, ['invalid_amount'])

  const peerDup = classifyReceiptErrors(
    {
      _key: 'R-400',
      receipt_no: 'R-400',
      date: '2026-01-18',
      investor: { id: 'C004' },
      product: { category: 'MF' },
      scheme_name: 'HDFC Top 100',
      transaction: { amount: 1000 },
      payment: { reference_no: 'UTR9' }
    },
    {
      peers: [
        {
          _key: 'R-401',
          receipt_no: 'R-401',
          date: '2026-01-18',
          investor: { id: 'C004' },
          product: { category: 'MF' },
          scheme_name: 'HDFC Top 100',
          transaction: { amount: 1001 },
          payment: { reference_no: 'UTR9' }
        }
      ]
    }
  )
  assert.deepEqual(peerDup, ['duplicate_transaction'])
}

function testBuildSummaryFromRows() {
  const summary = buildSummaryFromRows([
    { error_types: ['duplicate_transaction', 'invalid_amount'] },
    { error_types: ['duplicate_transaction'] }
  ])
  assert.equal(summary.duplicate_transaction, 2)
  assert.equal(summary.invalid_amount, 1)
  assert.equal(summary.total_receipts_with_issues, 2)
}

function testParseErrorTypeFilter() {
  assert.deepEqual(parseErrorTypeFilter({ error_type: 'duplicate_transaction,invalid_amount' }), [
    'duplicate_transaction',
    'invalid_amount'
  ])
  assert.deepEqual(parseErrorTypeFilter({ error_type: 'missing_pan' }), [])
  assert.deepEqual(parseErrorTypeFilter({ error_type: 'unknown' }), [])
}

testBuildDupTxnKey()
testAmountsWithinTolerance()
testGroupHasNearDuplicateAmounts()
testResolveEffectiveAmount()
testResolveReferenceNo()
testResolvePaymentInstrument()
testOptionBDuplicateLogic()
testClassifyReceiptErrors()
testBuildSummaryFromRows()
testParseErrorTypeFilter()

console.log('[White Box] receipt-errors-report tests passed')
