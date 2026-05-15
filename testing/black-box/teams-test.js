// Black-box tests for the /api/teams endpoints.
// Requires the API server to be reachable at TEST_CONFIG.API_BASE_URL
// with the receipt-approval-v2 teams route mounted.

import { createAuthenticatedClient, formatTestResult } from '../utils/test-helpers.js'
import { TEST_CONFIG } from '../config.js'

async function findTwoActiveUsers(client) {
  // Admin-only endpoint; we're authenticated as admin in these tests.
  const res = await client.get('/api/users')
  const users = Array.isArray(res.data) ? res.data : (res.data?.users || [])
  const active = users.filter(u => u.is_active !== false)
  if (active.length < 2) throw new Error('Need at least 2 active users to run teams tests')
  return [active[0], active[1]]
}

/**
 * Walks the full CRUD + permission + constraint matrix for /api/teams:
 *   create -> list -> get -> update -> unique-name conflict -> inactive-deactivate -> delete
 */
export async function testTeamsApi() {
  console.log('[Black Box] Testing teams API...')
  const results = []
  const started = Date.now()
  let createdTeamId = null

  try {
    const admin = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)

    // Non-admin should be able to read but not write.
    let employee = null
    try { employee = await createAuthenticatedClient(TEST_CONFIG.TEST_EMPLOYEE) }
    catch { /* optional */ }

    const [u1, u2] = await findTwoActiveUsers(admin)
    const uniqueSuffix = Date.now()
    const payload = {
      name: `TEST_TEAM_${uniqueSuffix}`,
      description: 'Created by teams black-box test',
      lead_user_id: String(u1.id || u1._key),
      member_ids: [String(u1.id || u1._key), String(u2.id || u2._key)]
    }

    // 1. Create (admin)
    try {
      const res = await admin.post('/api/teams', payload)
      createdTeamId = res.data?.id || res.data?._key
      results.push({
        test: 'create team (admin)',
        passed: res.status === 201 && !!createdTeamId && res.data.name === payload.name,
        details: { id: createdTeamId }
      })
    } catch (err) {
      results.push({ test: 'create team (admin)', passed: false, error: err.response?.data || err.message })
    }

    if (!createdTeamId) throw new Error('create failed; bailing on teams tests')

    // 2. Duplicate name rejected
    try {
      await admin.post('/api/teams', payload)
      results.push({ test: 'duplicate name rejected', passed: false, error: 'should have failed' })
    } catch (err) {
      results.push({
        test: 'duplicate name rejected',
        passed: err.response?.status === 400 || err.response?.status === 409,
        status: err.response?.status
      })
    }

    // 3. Lead not in members rejected
    try {
      await admin.post('/api/teams', {
        name: `${payload.name}_bad`,
        lead_user_id: String(u1.id || u1._key),
        member_ids: [String(u2.id || u2._key)]
      })
      results.push({ test: 'lead must be in members', passed: false, error: 'should have failed' })
    } catch (err) {
      results.push({
        test: 'lead must be in members',
        passed: err.response?.status === 400,
        status: err.response?.status
      })
    }

    // 4. List (auth) contains created
    try {
      const res = await admin.get('/api/teams')
      const found = Array.isArray(res.data) && res.data.some(t => t.id === createdTeamId)
      results.push({ test: 'list teams includes created', passed: found })
    } catch (err) {
      results.push({ test: 'list teams includes created', passed: false, error: err.message })
    }

    // 5. Get one hydrates members
    try {
      const res = await admin.get(`/api/teams/${createdTeamId}`)
      const ok = res.data?.members?.length >= 2 && res.data?.lead?.id === payload.lead_user_id
      results.push({ test: 'get team hydrates members+lead', passed: ok })
    } catch (err) {
      results.push({ test: 'get team hydrates members+lead', passed: false, error: err.message })
    }

    // 6. Non-admin cannot create
    if (employee) {
      try {
        await employee.post('/api/teams', { ...payload, name: `${payload.name}_emp` })
        results.push({ test: 'non-admin create rejected', passed: false, error: 'should have failed' })
      } catch (err) {
        results.push({
          test: 'non-admin create rejected',
          passed: err.response?.status === 403,
          status: err.response?.status
        })
      }
    }

    // 7. Non-admin can list
    if (employee) {
      try {
        const res = await employee.get('/api/teams')
        results.push({ test: 'non-admin list allowed', passed: res.status === 200 && Array.isArray(res.data) })
      } catch (err) {
        results.push({ test: 'non-admin list allowed', passed: false, error: err.response?.data || err.message })
      }
    }

    // 8. Update description
    try {
      const res = await admin.patch(`/api/teams/${createdTeamId}`, { description: 'updated by test' })
      results.push({ test: 'update team description', passed: res.data?.description === 'updated by test' })
    } catch (err) {
      results.push({ test: 'update team description', passed: false, error: err.response?.data || err.message })
    }

    // 9. Workload endpoint responds
    try {
      const res = await admin.get(`/api/teams/${createdTeamId}/workload`)
      results.push({
        test: 'workload endpoint responds',
        passed: res.status === 200 && res.data?.team_id === createdTeamId && typeof res.data?.open_approval_tasks === 'number'
      })
    } catch (err) {
      results.push({ test: 'workload endpoint responds', passed: false, error: err.response?.data || err.message })
    }

    // 10. Soft-delete
    try {
      const res = await admin.delete(`/api/teams/${createdTeamId}`)
      results.push({ test: 'soft-delete team', passed: res.data?.ok === true && res.data?.soft_deleted === true })
    } catch (err) {
      results.push({ test: 'soft-delete team', passed: false, error: err.response?.data || err.message })
    }

    // 11. After delete, team no longer in active list
    try {
      const res = await admin.get('/api/teams')
      const stillThere = Array.isArray(res.data) && res.data.some(t => t.id === createdTeamId)
      results.push({ test: 'deactivated team hidden from active list', passed: !stillThere })
    } catch (err) {
      results.push({ test: 'deactivated team hidden from active list', passed: false, error: err.message })
    }

    return formatTestResult(
      'Black Box - Teams API',
      results.every(r => r.passed),
      Date.now() - started,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Black Box - Teams API',
      false,
      Date.now() - started,
      { error: error.message, testCases: results }
    )
  }
}

export async function runAllTeamsTests() {
  const out = await testTeamsApi()
  console.log(`\n[Teams] ${out.passed ? 'PASS' : 'FAIL'} (${out.duration}ms)`)
  for (const tc of (out.testCases || [])) {
    console.log(`  ${tc.passed ? '✓' : '✗'} ${tc.test}${tc.error ? ' — ' + JSON.stringify(tc.error) : ''}`)
  }
  return [out]
}

if (process.argv[1]?.endsWith('teams-test.js') || import.meta.url.endsWith('teams-test.js')) {
  runAllTeamsTests()
    .then(r => process.exit(r[0]?.passed ? 0 : 1))
    .catch(err => { console.error('Fatal:', err); process.exit(1) })
}
