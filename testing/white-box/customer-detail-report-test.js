import assert from 'node:assert/strict'

import {
  CustomerDetailReportError,
  MAX_CUSTOMER_DETAIL_INVESTOR_IDS,
  buildCustomerDetailCsvRows,
  parseCustomerDetailInvestorIds,
  parseCustomerListSort
} from '../../services/reports/customer-detail-report.js'

assert.throws(() => parseCustomerDetailInvestorIds({}), CustomerDetailReportError)

const tooMany = Array.from({ length: MAX_CUSTOMER_DETAIL_INVESTOR_IDS + 1 }, (_, i) => String(i + 1)).join(',')
assert.throws(() => parseCustomerDetailInvestorIds({ investor_ids: tooMany }), CustomerDetailReportError)

const sample = {
  customers: [
    {
      customer_id: 101,
      profile: { name: 'Test User', pan: 'X', pin: '500001' },
      summary: { applications: 2, total_investment: 1000, collection_credit: 10, incentive_amount: 1 },
      by_product: [{ product_category: 'MF', applications: 2, amount: 1000, collection_credit: 10, incentive_amount: 1 }],
      by_scheme_category: []
    }
  ],
  transactions: {
    rows: [
      {
        customer_id: 101,
        customer_name: 'Test User',
        date: '2025-01-01',
        receipt_number: 'R1',
        product_category: 'MF',
        amount: 500
      }
    ]
  }
}
const csvRows = buildCustomerDetailCsvRows(sample)
assert.ok(csvRows.some((r) => r[0] === 'Profile' && r[1] === 101))
assert.ok(csvRows.some((r) => r[0] === 'By Product'))
assert.ok(csvRows.some((r) => r[0] === 'Transaction'))

assert.deepEqual(parseCustomerListSort({ customer_sort: 'pin:desc' }), { field: 'pin', dir: 'DESC' })
assert.deepEqual(parseCustomerListSort({ customer_sort: 'total_investment:asc' }), {
  field: 'total_investment',
  dir: 'ASC'
})
assert.deepEqual(parseCustomerListSort({}), { field: 'name', dir: 'ASC' })

function receiptMatchFilterClause(requireReceiptMatch) {
  if (!requireReceiptMatch) return ''
  return 'FILTER @totals_lookup[TO_STRING(customer.investor_id)] != null\n'
}

assert.equal(receiptMatchFilterClause(false), '')
assert.match(receiptMatchFilterClause(true), /@totals_lookup/)

console.log('[White Box] customer-detail-report tests passed')
