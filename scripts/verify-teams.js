// Self-contained verification for /api/teams.
// Boots an in-process Express server on an ephemeral port, exercises the
// teams router end-to-end using real DB connections, then cleans up and exits.
//
// Run with:  node scripts/verify-teams.js
// Uses the DB specified in .env (should be the local clone).

import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import axios from 'axios'
import { q, getCollection } from '../config/database.js'
import teamRoutes from '../routes/teams.js'
import { JWT_SECRET } from '../config/environment.js'

const app = express()
app.use(express.json())
app.use('/api/teams', teamRoutes)

const server = app.listen(0)
const port = server.address().port
const base = `http://127.0.0.1:${port}`

function tokenFor(user) {
  return jwt.sign({
    sub: user._key,
    emp_code: user.emp_code,
    role: user.role,
    branch: user.branch,
    branch_code: user.branch_code
  }, JWT_SECRET, { expiresIn: '1h' })
}

function clientFor(user) {
  return axios.create({
    baseURL: base,
    headers: { Authorization: `Bearer ${tokenFor(user)}` },
    validateStatus: () => true
  })
}

async function main() {
  const results = []
  const pass = (name, ok, extra = {}) => { results.push({ name, ok, ...extra }); console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' — ' + JSON.stringify(extra)}`) }

  let createdId = null
  try {
    const admin = (await q("FOR u IN users FILTER u.role == 'admin' AND u.is_active != false LIMIT 1 RETURN u"))[0]
    const anyEmp = (await q("FOR u IN users FILTER u.role != 'admin' AND u.is_active != false LIMIT 1 RETURN u"))[0]
    if (!admin) throw new Error('no admin user found in DB')
    if (!anyEmp) throw new Error('no non-admin user found in DB')

    const adminClient = clientFor(admin)
    const empClient = clientFor(anyEmp)

    const uniqueName = `VERIFY_TEAM_${Date.now()}`
    const payload = {
      name: uniqueName,
      description: 'verify-teams.js',
      lead_user_id: admin._key,
      member_ids: [admin._key, anyEmp._key]
    }

    // 1. admin create
    let res = await adminClient.post('/api/teams', payload)
    createdId = res.data?.id || res.data?._key
    pass('admin creates team', res.status === 201 && createdId, { status: res.status, body: res.data })

    // 2. duplicate name rejected
    res = await adminClient.post('/api/teams', payload)
    pass('duplicate name rejected', [400, 409].includes(res.status), { status: res.status })

    // 3. lead not in members rejected
    res = await adminClient.post('/api/teams', { ...payload, name: `${uniqueName}_bad`, member_ids: [anyEmp._key] })
    pass('lead must be in members', res.status === 400, { status: res.status })

    // 4. non-admin cannot create
    res = await empClient.post('/api/teams', { ...payload, name: `${uniqueName}_emp` })
    pass('non-admin create rejected', res.status === 403, { status: res.status })

    // 5. non-admin can list
    res = await empClient.get('/api/teams')
    pass('non-admin list allowed', res.status === 200 && Array.isArray(res.data), { status: res.status })

    // 6. admin list contains created
    res = await adminClient.get('/api/teams')
    pass('list includes created team', Array.isArray(res.data) && res.data.some(t => t.id === createdId))

    // 7. get single hydrates members + lead
    res = await adminClient.get(`/api/teams/${createdId}`)
    pass('get hydrates members+lead',
      res.status === 200 &&
      Array.isArray(res.data?.members) && res.data.members.length === 2 &&
      res.data?.lead?.id === admin._key,
      { status: res.status, members: res.data?.members?.length }
    )

    // 8. unknown user id rejected
    res = await adminClient.post('/api/teams', {
      name: `${uniqueName}_unknown`,
      lead_user_id: 'does-not-exist',
      member_ids: ['does-not-exist']
    })
    pass('unknown user rejected', res.status === 400, { status: res.status })

    // 9. update description
    res = await adminClient.patch(`/api/teams/${createdId}`, { description: 'updated via verify-teams' })
    pass('update description', res.status === 200 && res.data?.description === 'updated via verify-teams', { status: res.status })

    // 10. workload endpoint
    res = await adminClient.get(`/api/teams/${createdId}/workload`)
    pass('workload (admin)', res.status === 200 && res.data?.team_id === createdId && typeof res.data?.open_approval_tasks === 'number', { status: res.status, body: res.data })

    // 11. workload forbidden to employee
    res = await empClient.get(`/api/teams/${createdId}/workload`)
    pass('workload (non-admin/manager) rejected', res.status === 403, { status: res.status })

    // 12. team_in_use blocks delete when a receipt holds it.
    //    Simulate by writing current_team_id on one receipt, then try delete.
    const receiptKey = (await q("FOR r IN receipts LIMIT 1 RETURN r._key"))[0]
    if (receiptKey) {
      await q("UPDATE @rk WITH { current_team_id: @tid } IN receipts", { rk: receiptKey, tid: createdId })
      res = await adminClient.delete(`/api/teams/${createdId}`)
      pass('delete blocked while team_in_use', res.status === 409 && res.data?.error === 'team_in_use', { status: res.status, body: res.data })
      // unblock for next step
      await q("UPDATE @rk WITH { current_team_id: null } IN receipts", { rk: receiptKey })
    }

    // 13. soft-delete when not in use
    res = await adminClient.delete(`/api/teams/${createdId}`)
    pass('soft-delete succeeds', res.status === 200 && res.data?.ok === true, { status: res.status })

    // 14. after delete, hidden from active list
    res = await adminClient.get('/api/teams')
    pass('deactivated hidden from active list', !res.data.some(t => t.id === createdId))

    // 15. visible with include_inactive
    res = await adminClient.get('/api/teams?include_inactive=1')
    pass('deactivated visible with include_inactive', res.data.some(t => t.id === createdId))
  } catch (err) {
    console.error('Fatal:', err.message)
    pass('fatal', false, { error: err.message })
  } finally {
    // Cleanup: hard-delete the verification team doc so we don't leave cruft.
    if (createdId) {
      try { await getCollection('teams').remove(createdId) } catch { /* already gone */ }
    }
    server.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
