import assert from 'node:assert/strict'

import {
  BRANCH_NAME_AQL,
  CLIENT_ADDRESS_AQL
} from '../../utils/report-aql-fragments.js'

assert.match(BRANCH_NAME_AQL, /branch_name/)
assert.match(BRANCH_NAME_AQL, /FOR branch IN branches/)
assert.match(CLIENT_ADDRESS_AQL, /investor\.address/)
assert.match(CLIENT_ADDRESS_AQL, /investor_address/)

console.log('[White Box] report-aql-fragments tests passed')
