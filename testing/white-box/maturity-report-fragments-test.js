import assert from 'node:assert/strict'

import {
  MATURITY_AMOUNT_AQL,
  MATURITY_DATE_AQL
} from '../../services/reports/operational-reports.js'

assert.match(MATURITY_DATE_AQL, /product_details\.fd\.maturity\.date/)
assert.match(MATURITY_DATE_AQL, /fd_maturity_date/)
assert.match(MATURITY_DATE_AQL, /product_details\.bond\.instrument\.maturity_date/)
assert.match(MATURITY_DATE_AQL, /bond_maturity_date/)
assert.match(MATURITY_DATE_AQL, /product_details\.insurance\.coverage\.maturity_date/)
assert.match(MATURITY_DATE_AQL, /insurance_maturity_date/)
assert.match(MATURITY_DATE_AQL, /insurance_renewal_date/)
assert.match(MATURITY_DATE_AQL, /product_details\.insurance\.policy\.renewal_date/)
assert.match(MATURITY_DATE_AQL, /renewal_due_date/)

assert.match(MATURITY_AMOUNT_AQL, /product_details\.fd\.maturity\.amount/)
assert.match(MATURITY_AMOUNT_AQL, /fd_maturity_amount/)

console.log('[White Box] maturity report fragment tests passed')
