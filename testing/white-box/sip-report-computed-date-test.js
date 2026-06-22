import assert from 'node:assert/strict'

import { runSipReport } from '../../services/reports/operational-reports.js'

async function testComputedDateSipReportDoesNotPassUnusedPaginationBindVars() {
  await assert.doesNotReject(
    () => runSipReport(
      { role: 'admin', sub: '217870', emp_code: 'ECS0000' },
      {
        date_basis: 'sip_due',
        from: '2026-05-26',
        to: '2026-11-26',
        include_pending: '1',
        page: '1',
        page_size: '25'
      }
    ),
    /bind parameter 'offset' was not declared/
  )
}

await testComputedDateSipReportDoesNotPassUnusedPaginationBindVars()

console.log('[White Box] SIP computed date report tests passed')
