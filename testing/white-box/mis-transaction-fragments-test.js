import assert from 'node:assert/strict'

import {
  FD_DEPOSIT_DATE_AQL,
  FD_TENURE_DISPLAY_AQL,
  MIS_PERIOD_AQL,
  SIP_END_DATE_AQL,
  SIP_IS_PERPETUAL_AQL,
  SIP_START_DATE_AQL
} from '../../utils/report-aql-fragments.js'

assert.match(MIS_PERIOD_AQL, /period_installments/)
assert.match(MIS_PERIOD_AQL, /sip_stp_swp_period/)
assert.match(MIS_PERIOD_AQL, /deposit_period_ym/)
assert.match(MIS_PERIOD_AQL, /sip\.frequency/)

function assertBalancedParens(expr, label) {
  let depth = 0
  for (const ch of expr) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    assert.ok(depth >= 0, `${label}: unmatched ")"`)
  }
  assert.equal(depth, 0, `${label}: unclosed "("`)
}

assertBalancedParens(MIS_PERIOD_AQL, 'MIS_PERIOD_AQL')

assert.match(SIP_START_DATE_AQL, /transaction\.sip\.start_date/)
assert.match(SIP_START_DATE_AQL, /sip_start_date/)

assert.match(SIP_END_DATE_AQL, /transaction\.sip\.end_date/)
assert.match(SIP_END_DATE_AQL, /sip_end_date/)

assert.match(SIP_IS_PERPETUAL_AQL, /is_perpetual/)
assert.match(FD_DEPOSIT_DATE_AQL, /fd_deposit_date/)
assert.match(FD_TENURE_DISPLAY_AQL, /fd\.deposit\.tenure_value/)
assert.match(FD_TENURE_DISPLAY_AQL, /fd_tenure_months/)

console.log('[White Box] MIS transaction fragment tests passed')
