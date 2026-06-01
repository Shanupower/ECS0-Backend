import assert from 'node:assert/strict'

import {
  maskServiceIncomeTotals,
  sumNumericFields
} from '../../services/reports/report-totals.js'

const rows = [
  { applications: 2, amount: 1000, collection_credit: 25, incentive_amount: 10 },
  { applications: '3', amount: '2500.5', collection_credit: null, incentive_amount: null },
  { applications: 1, amount: 'not-a-number', collection_credit: 5, incentive_amount: 2 }
]

assert.deepEqual(sumNumericFields(rows, ['applications', 'amount', 'collection_credit', 'incentive_amount']), {
  applications: 6,
  amount: 3500.5,
  collection_credit: 30,
  incentive_amount: 12
})

assert.deepEqual(sumNumericFields([{ incentive_amount: null }], ['incentive_amount']), {
  incentive_amount: null
})

assert.deepEqual(
  maskServiceIncomeTotals({ role: 'manager' }, { amount: 100, incentive_amount: 20, incentive_paid: 15 }),
  { amount: 100, incentive_amount: null, incentive_paid: null }
)

assert.deepEqual(
  maskServiceIncomeTotals({ role: 'admin' }, { amount: 100, incentive_amount: 20, incentive_paid: 15 }),
  { amount: 100, incentive_amount: 20, incentive_paid: 15 }
)

console.log('[White Box] report totals helper tests passed')
