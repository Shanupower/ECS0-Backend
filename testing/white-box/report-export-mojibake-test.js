import assert from 'node:assert/strict'

import { fixUtf8Mojibake } from '../../services/reports/report-export.js'

assert.equal(
  fixUtf8Mojibake('HDFC Gold ETF \u00e2\u20ac\u201c Regular \u00e2\u20ac\u201c Growth'),
  'HDFC Gold ETF \u2013 Regular \u2013 Growth'
)

assert.equal(fixUtf8Mojibake('Plain scheme'), 'Plain scheme')
assert.equal(fixUtf8Mojibake(null), '')

console.log('[White Box] report-export mojibake tests passed')
