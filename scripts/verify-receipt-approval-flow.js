// Self-contained black-box test for the receipt-approval workflow (Phase 3).
// Boots an in-process Express server (same routes as server.js) on an
// ephemeral port, flips the feature flag, creates teams + a test receipt,
// and walks through the full happy + reject-resubmit paths.
//
// Run with:  node scripts/verify-receipt-approval-flow.js
// Uses the DB from .env (should be the local clone).

import 'dotenv/config'
import express from 'express'
import jwt from 'jsonwebtoken'
import axios from 'axios'
import { q, getCollection } from '../config/database.js'
import teamRoutes from '../routes/teams.js'
import receiptRoutes from '../routes/receipts.js'
import appConfigRoutes, { getAppConfig } from '../routes/app-config.js'
import { JWT_SECRET } from '../config/environment.js'

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use('/api/teams', teamRoutes)
app.use('/api/receipts', receiptRoutes)
app.use('/api/app-config', appConfigRoutes)

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

const results = []
const pass = (name, ok, extra = {}) => {
  results.push({ name, ok, ...extra })
  console.log(`${ok ? '\u2713' : '\u2717'} ${name}${ok ? '' : ' \u2014 ' + JSON.stringify(extra)}`)
}

async function createReceipt(creator) {
  const doc = {
    user_id: creator._key,
    emp_code: creator.emp_code || null,
    branch: creator.branch || null,
    investor_id: 1,
    product_category: 'MF',
    investment_amount: 1234,
    status: 'Draft',
    current_team_id: null,
    current_approval_task_key: null,
    approval_cycle_id: null,
    approved_by_team_ids: [],
    stage_history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    __verify_marker: true
  }
  const saved = await getCollection('receipts').save(doc)
  return saved._key
}

async function createTeam(name, members, lead) {
  const saved = await getCollection('teams').save({
    name,
    description: 'verify-receipt-approval-flow',
    lead_user_id: lead._key,
    member_ids: [...new Set([lead._key, ...members.map(m => m._key)])],
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })
  return saved._key
}

async function main() {
  const cleanup = { teamIds: [], receiptIds: [], restoreFlag: null, restoreIntake: null }
  try {
    const admin = (await q("FOR u IN users FILTER u.role == 'admin' AND u.is_active != false LIMIT 1 RETURN u"))[0]
    const empA = (await q("FOR u IN users FILTER u.role != 'admin' AND u.is_active != false LIMIT 1 RETURN u"))[0]
    const empB = (await q("FOR u IN users FILTER u.role != 'admin' AND u.is_active != false LIMIT 2 RETURN u"))[1]
    if (!admin || !empA || !empB) throw new Error('need 1 admin + 2 non-admin users in DB')

    const adminClient = clientFor(admin)
    const aClient = clientFor(empA)
    const bClient = clientFor(empB)

    // Snapshot current config so we can restore it.
    const before = await getAppConfig()
    cleanup.restoreFlag = !!before?.feature_flags?.receipts_approval_v2
    cleanup.restoreIntake = before?.receipt_intake_team_id ?? null

    // Create two throwaway teams (intake + second).
    const intakeName = `VERIFY_INTAKE_${Date.now()}`
    const nextName = `VERIFY_NEXT_${Date.now()}`
    const intakeId = await createTeam(intakeName, [empA], admin)       // lead=admin, member=empA
    const nextId = await createTeam(nextName, [empB], admin)           // lead=admin, member=empB
    cleanup.teamIds.push(intakeId, nextId)

    // Configure app: point intake team, enable flag.
    let res = await adminClient.put('/api/app-config', {
      receipt_intake_team_id: intakeId,
      feature_flags: { ...(before.feature_flags || {}), receipts_approval_v2: true }
    })
    pass('enable feature flag + set intake team',
      res.status === 200 &&
      res.data?.receipt_intake_team_id === intakeId &&
      res.data?.feature_flags?.receipts_approval_v2 === true,
      { status: res.status, body: res.data }
    )

    // Create a receipt (as empA) in Draft.
    const receiptKey = await createReceipt(empA)
    cleanup.receiptIds.push(receiptKey)

    // --- Happy path: submit -> route -> complete ---
    res = await aClient.post(`/api/receipts/${receiptKey}/submit`)
    pass('creator submits Draft', res.status === 200 && res.data?.receipt?.status === intakeName, { status: res.status, body: res.data })

    // empB (not in intake team) can't route.
    res = await bClient.post(`/api/receipts/${receiptKey}/route`, { next_team_id: nextId })
    pass('non-member cannot route', res.status === 403, { status: res.status, body: res.data })

    // empA (intake member) routes to next team.
    res = await aClient.post(`/api/receipts/${receiptKey}/route`, { next_team_id: nextId, comment: 'ok to proceed' })
    pass('intake member routes to next team', res.status === 200 && res.data?.receipt?.status === nextName, { status: res.status, body: res.data })

    // Routing back to a team already approved -> invalid_next_team.
    res = await bClient.post(`/api/receipts/${receiptKey}/route`, { next_team_id: intakeId })
    pass('cannot route back to prior team', res.status === 400 && res.data?.error === 'invalid_next_team', { status: res.status, body: res.data })

    // empB completes.
    res = await bClient.post(`/api/receipts/${receiptKey}/complete`, { comment: 'verified' })
    pass('next team completes', res.status === 200 && res.data?.receipt?.status === (before.receipt_final_status_label || 'Completed') && !res.data?.receipt?.current_team_id, { status: res.status, body: res.data })

    // History contains two entries resolved + closed.
    res = await aClient.get(`/api/receipts/${receiptKey}/history`)
    const hist = res.data?.stage_history || []
    pass('history has 2 resolved stages',
      res.status === 200 && hist.length >= 2 && hist[0].resolution === 'routed' && hist[1].resolution === 'approved',
      { status: res.status, count: hist.length, resolutions: hist.map(h => h.resolution) }
    )

    // Cannot submit an already-completed receipt.
    res = await aClient.post(`/api/receipts/${receiptKey}/submit`)
    pass('cannot submit completed receipt', res.status === 409 && res.data?.error === 'receipt_not_in_flight', { status: res.status })

    // --- Reject path: new receipt -> submit -> reject -> resubmit cycle reset ---
    const r2 = await createReceipt(empA)
    cleanup.receiptIds.push(r2)
    res = await aClient.post(`/api/receipts/${r2}/submit`)
    pass('submit 2nd receipt', res.status === 200, { status: res.status })

    // Reject without comment -> comment_required.
    res = await aClient.post(`/api/receipts/${r2}/reject`, {})
    pass('reject without comment rejected', res.status === 400 && res.data?.error === 'comment_required', { status: res.status, body: res.data })

    res = await aClient.post(`/api/receipts/${r2}/reject`, { comment: 'needs fix' })
    pass('reject with comment -> Needs Changes', res.status === 200 && res.data?.receipt?.status === 'Needs Changes', { status: res.status, body: res.data })

    // Resubmit: approved_by_team_ids is cleared, fresh cycle.
    const beforeCycle = (await q('FOR r IN receipts FILTER r._key == @k RETURN r.approval_cycle_id', { k: r2 }))[0]
    res = await aClient.post(`/api/receipts/${r2}/submit`)
    const afterCycle = res.data?.receipt?.approval_cycle_id
    pass('resubmit starts new cycle',
      res.status === 200 &&
      res.data?.receipt?.status === intakeName &&
      afterCycle && afterCycle !== beforeCycle &&
      Array.isArray(res.data?.receipt?.approved_by_team_ids) &&
      res.data.receipt.approved_by_team_ids.length === 0,
      { status: res.status, beforeCycle, afterCycle }
    )

    // --- Task kind guard: approval tasks cannot have status edited via /api/tasks ---
    const taskKey = res.data?.task?._key
    if (taskKey) {
      // Mount tasks router in-process quickly to verify guard (without a separate server).
      const taskRoutes = (await import('../routes/tasks.js')).default
      const guardApp = express()
      guardApp.use(express.json())
      guardApp.use('/api/tasks', taskRoutes)
      const guardServer = guardApp.listen(0)
      const guardBase = `http://127.0.0.1:${guardServer.address().port}`
      const guardClient = axios.create({ baseURL: guardBase, headers: { Authorization: `Bearer ${tokenFor(admin)}` }, validateStatus: () => true })
      const gr = await guardClient.patch(`/api/tasks/${taskKey}`, { status: 'done' })
      pass('approval task status edit blocked', gr.status === 409 && gr.data?.error === 'use_receipt_approval_api', { status: gr.status, body: gr.data })
      guardServer.close()
    } else {
      pass('approval task created', false, { detail: 'no task returned from resubmit' })
    }

    // --- Admin override via PATCH /status (flag ON) ---
    const r3 = await createReceipt(empA)
    cleanup.receiptIds.push(r3)

    // Missing x-admin-reason -> 400 comment_required
    res = await adminClient.patch(`/api/receipts/${r3}/status`, { status: 'Completed' })
    pass('admin override requires x-admin-reason', res.status === 400 && res.data?.error === 'comment_required', { status: res.status, body: res.data })

    // With reason -> completes receipt via engine (submits from Draft first)
    const reasonedAdmin = axios.create({
      baseURL: base,
      headers: { Authorization: `Bearer ${tokenFor(admin)}`, 'x-admin-reason': 'audit-fix-override' },
      validateStatus: () => true
    })
    res = await reasonedAdmin.patch(`/api/receipts/${r3}/status`, { status: 'Completed' })
    pass('admin override completes via engine',
      res.status === 200 &&
      res.data?.new_status === (before.receipt_final_status_label || 'Completed') &&
      res.data?.receipt?.current_team_id === null,
      { status: res.status, body: res.data }
    )

    // History from admin override path contains a forced entry.
    res = await adminClient.get(`/api/receipts/${r3}/history`)
    const ahist = res.data?.stage_history || []
    pass('admin override history marks forced',
      res.status === 200 && ahist.some(h => h.forced === true),
      { status: res.status, count: ahist.length, forced: ahist.map(h => !!h.forced) }
    )

    // --- Feature-flag gating: disable, then endpoint 404s ---
    await adminClient.put('/api/app-config', { feature_flags: { ...(before.feature_flags || {}), receipts_approval_v2: false } })
    res = await aClient.post(`/api/receipts/${r2}/submit`)
    pass('endpoint returns 404 when flag off', res.status === 404, { status: res.status })

  } catch (err) {
    console.error('Fatal:', err)
    pass('fatal', false, { error: err.message })
  } finally {
    // Restore config
    try {
      const adminUser = (await q("FOR u IN users FILTER u.role == 'admin' AND u.is_active != false LIMIT 1 RETURN u"))[0]
      if (adminUser) {
        const client = clientFor(adminUser)
        await client.put('/api/app-config', {
          receipt_intake_team_id: cleanup.restoreIntake,
          feature_flags: { receipts_approval_v2: cleanup.restoreFlag }
        })
      }
    } catch (e) { console.warn('config restore warn:', e.message) }

    for (const id of cleanup.teamIds) {
      try { await getCollection('teams').remove(id) } catch { /* ignore */ }
    }
    for (const id of cleanup.receiptIds) {
      try {
        const r = (await q('FOR r IN receipts FILTER r._key == @k RETURN r', { k: id }))[0]
        if (r?.current_approval_task_key) { try { await getCollection('tasks').remove(r.current_approval_task_key) } catch { /* ignore */ } }
        // Also remove tasks referencing this receipt (from history)
        const taskKeys = new Set()
        for (const h of (r?.stage_history || [])) if (h?.task_key) taskKeys.add(h.task_key)
        for (const tk of taskKeys) { try { await getCollection('tasks').remove(tk) } catch { /* ignore */ } }
        await getCollection('receipts').remove(id)
      } catch { /* ignore */ }
    }
    server.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
