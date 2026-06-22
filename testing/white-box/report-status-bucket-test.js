import assert from 'node:assert/strict'

import { RECEIPT_STATUS_BUCKET_AQL } from '../../services/reports/receipt-scope-filter.js'

assert.match(RECEIPT_STATUS_BUCKET_AQL, /Completed/)
assert.match(RECEIPT_STATUS_BUCKET_AQL, /Pending/)
assert.match(RECEIPT_STATUS_BUCKET_AQL, /current_team_id/)

console.log('[Backend] report status bucket tests passed')
