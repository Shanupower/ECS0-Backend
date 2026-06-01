import assert from 'node:assert/strict'

import {
  parseCustomerDetailInvestorIds,
  MAX_CUSTOMER_DETAIL_INVESTOR_IDS,
  CustomerDetailReportError,
  buildCustomerDetailCsvRows
} from '../../services/reports/customer-detail-report.js'

assert.throws(() => parseCustomerDetailInvestorIds({}), CustomerDetailReportError)
assert.throws(() => parseCustomerDetailInvestorIds({ investor_ids: '' }), CustomerDetailReportError)

const ids = parseCustomerDetailInvestorIds({ investor_ids: '101,202' })
assert.deepEqual(ids, ['101', '202'])

const tooMany = Array.from({ length: MAX_CUSTOMER_DETAIL_INVESTOR_IDS + 1 }, (_, i) => String(i + 1)).join(',')
assert.throws(() => parseCustomerDetailInvestorIds({ investor_ids: tooMany }), CustomerDetailReportError)

const sample = {
  customers: [
    {
      customer_id: 101,
      profile: { name: 'Test User', pan: 'X', pin: '500001' },
      summary: { applications: 2, total_investment: 1000, collection_credit: 10, incentive_amount: 1 },
      by_product: [{ product_category: 'MF', applications: 2, amount: 1000, collection_credit: 10, incentive_amount: 1 }],
      by_scheme_category: [],
      by_fund: []
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

console.log('[White Box] customer-detail-report tests passed')
