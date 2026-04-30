import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { getAppConfig } from './app-config.js'
import { publishEvent } from '../services/task-events.js'
import {
  normalizeBranchRef,
  resolveBranchAliases,
  getCurrentUserBranchRef
} from '../utils/branch-scope.js'

// Thin shims preserve the legacy local names used throughout this file.
const normalizeBranch = normalizeBranchRef
const getCurrentUserBranch = getCurrentUserBranchRef

const router = express.Router()

// Fallback list if app_config isn't populated or the service is warming up.
export const DEFAULT_LEAD_STAGES = ['New', 'Contacted', 'Meeting Scheduled', 'Met', 'Proposal Sent', 'Won', 'Lost']

async function getConfig() {
  try {
    return await getAppConfig()
  } catch (e) {
    console.error('getAppConfig failed, falling back to defaults:', e)
    return {
      lead_stages: DEFAULT_LEAD_STAGES,
      lead_won_archive_days: 14,
      lead_lost_archive_days: 60
    }
  }
}

async function ensureLeadsCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('leads')
  const exists = await col.exists()
  if (!exists) {
    await col.create()
  }
  return getCollection('leads')
}

async function ensureLeadActivitiesCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('lead_activities')
  const exists = await col.exists()
  if (!exists) {
    await col.create()
  }
  return getCollection('lead_activities')
}

async function resolveAssignableUser(assigneeId, currentUser) {
  if (!assigneeId) return null
  const users = await q(`
    FOR user IN users
    FILTER (user._key == @aid OR user.emp_code == @aid) AND user.is_active == true
    LIMIT 1
    RETURN user
  `, { aid: String(assigneeId).trim() })
  if (!users.length) return null
  const u = users[0]
  if (currentUser.role === 'admin') return u
  if (currentUser.role === 'manager') {
    const me = await getCurrentUserBranch(currentUser.sub)
    if (!me || !me.branch) return null
    if (normalizeBranch(u.branch) !== normalizeBranch(me.branch)) return null
    return u
  }
  if (u._key !== currentUser.sub && u.emp_code !== currentUser.emp_code) return null
  return u
}

async function buildListFilter(req) {
  const role = req.user.role
  const sub = req.user.sub
  const empCode = req.user.emp_code

  if (role === 'admin') {
    const branchCodeParam = String(req.query.branch_code || '').trim()
    if (!branchCodeParam) return { filterAql: '', bindVars: {} }
    const aliases = await resolveBranchAliases(branchCodeParam)
    if (!aliases.length) return { filterAql: 'FILTER false', bindVars: {} }
    return {
      filterAql: 'FILTER lead.branch != null && UPPER(TRIM(lead.branch)) IN @branchAliases',
      bindVars: { branchAliases: aliases }
    }
  }
  if (role === 'manager') {
    const me = await getCurrentUserBranch(sub)
    if (!me || !me.branch) return { filterAql: 'FILTER false', bindVars: {} }
    const branchNorm = normalizeBranch(me.branch)
    return {
      filterAql: 'FILTER lead.branch != null && UPPER(TRIM(lead.branch)) == @branchNorm',
      bindVars: { branchNorm }
    }
  }
  return {
    filterAql: 'FILTER lead.assigned_to_id == @sub || lead.assigned_to_emp_code == @empCode',
    bindVars: { sub, empCode: empCode || '' }
  }
}

// Sanitise a string -> trimmed or null
function s(v) {
  if (v === undefined || v === null) return null
  const t = String(v).trim()
  return t.length ? t : null
}

// Sanitise an array of strings
function sArr(v) {
  if (!Array.isArray(v)) return null
  return v.map(x => s(x)).filter(Boolean)
}

async function writeActivity({ leadKey, branchCode, kind, body, outcome = null, from = null, to = null, createdBy, createdByName, createdByEmpCode }) {
  try {
    const col = await ensureLeadActivitiesCollection()
    const doc = {
      lead_key: leadKey,
      branch_code: branchCode || null,
      kind,
      body: body || null,
      outcome,
      from,
      to,
      created_by: createdBy,
      created_by_name: createdByName || null,
      created_by_emp_code: createdByEmpCode || null,
      created_at: new Date().toISOString()
    }
    const result = await col.save(doc)
    return { _key: result._key, ...doc }
  } catch (err) {
    console.error('writeActivity failed:', err)
    return null
  }
}

// POST / - Create lead
router.post('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {}
    const { name, contact_phone, contact_email, stage, notes, assigned_to_id } = body
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'validation_error', detail: 'name is required' })
    }

    const assignee = await resolveAssignableUser(assigned_to_id || req.user.sub, req.user)
    if (!assignee) {
      return res.status(400).json({ error: 'validation_error', detail: 'Invalid or unauthorized assignee' })
    }

    const cfg = await getConfig()
    const allowedStages = Array.isArray(cfg.lead_stages) && cfg.lead_stages.length ? cfg.lead_stages : DEFAULT_LEAD_STAGES
    const stageVal = allowedStages.includes(stage) ? stage : 'New'

    const me = await getCurrentUserBranch(req.user.sub)
    const branch = (me && me.branch) ? me.branch : null
    const nowIso = new Date().toISOString()

    const leadDoc = {
      name: name.trim(),
      contact_phone: s(contact_phone),
      contact_email: s(contact_email),
      stage: stageVal,
      notes: s(notes),
      assigned_to_id: assignee._key,
      assigned_to_emp_code: assignee.emp_code,
      branch,
      source: s(body.source),
      value: body.value != null && !Number.isNaN(Number(body.value)) ? Number(body.value) : null,
      expected_value: body.expected_value != null ? body.expected_value : null, // legacy
      next_follow_up_at: s(body.next_follow_up_at),
      tags: sArr(body.tags) || [],
      lost_reason: null,
      won_at: stageVal === 'Won' ? nowIso : null,
      lost_at: stageVal === 'Lost' ? nowIso : null,
      archived_at: null,
      converted_to_customer_id: null,
      created_at: nowIso,
      updated_at: nowIso
    }

    const col = await ensureLeadsCollection()
    const result = await col.save(leadDoc)

    await writeActivity({
      leadKey: result._key,
      branchCode: branch,
      kind: 'created',
      body: `Lead created at stage ${stageVal}`,
      createdBy: req.user.sub,
      createdByName: me?.name,
      createdByEmpCode: req.user.emp_code
    })

    publishEvent({
      type: 'lead.created',
      payload: { lead_id: result._key, stage: stageVal, assignee_id: assignee._key, branch, source: leadDoc.source, value: leadDoc.value },
      actor: { id: req.user.sub, emp_code: req.user.emp_code },
      branch
    })

    res.status(201).json({ id: result._key, _key: result._key, ...leadDoc })
  } catch (error) {
    console.error('Error creating lead:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// GET / - List leads
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureLeadsCollection()
    const { stage, assignee_id, limit = '100', page = '1', include_archived, source, search, tag } = req.query
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100))
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const pageSkip = (pageNum - 1) * limitNum

    const scope = await buildListFilter(req)
    const bindVars = { ...scope.bindVars }

    let filterParts = [scope.filterAql].filter(Boolean)
    filterParts.push('FILTER lead.converted_to_customer_id == null')
    // By default hide archived leads; admins can opt-in to see them.
    if (String(include_archived) !== '1') {
      filterParts.push('FILTER lead.archived_at == null')
    }
    if (stage) {
      bindVars.stageVal = stage
      filterParts.push('FILTER lead.stage == @stageVal')
    }
    if ((req.user.role === 'admin' || req.user.role === 'manager') && assignee_id) {
      bindVars.assignee_filter = String(assignee_id).trim()
      filterParts.push('FILTER lead.assigned_to_id == @assignee_filter || lead.assigned_to_emp_code == @assignee_filter')
    }
    if (source) {
      bindVars.sourceVal = String(source).trim()
      filterParts.push('FILTER lead.source == @sourceVal')
    }
    if (tag) {
      bindVars.tagVal = String(tag).trim()
      filterParts.push('FILTER IS_ARRAY(lead.tags) && @tagVal IN lead.tags')
    }
    if (search) {
      bindVars.searchLower = String(search).trim().toLowerCase()
      filterParts.push(`FILTER (
        (lead.name != null && CONTAINS(LOWER(lead.name), @searchLower)) ||
        (lead.contact_phone != null && CONTAINS(LOWER(TO_STRING(lead.contact_phone)), @searchLower)) ||
        (lead.contact_email != null && CONTAINS(LOWER(TO_STRING(lead.contact_email)), @searchLower))
      )`)
    }

    const filterAql = filterParts.join(' ')

    const list = await q(`
      FOR lead IN leads
      ${filterAql}
      SORT lead.updated_at DESC, lead.created_at DESC
      LIMIT ${pageSkip}, ${limitNum}
      RETURN lead
    `, bindVars)

    const countResult = await q(`
      FOR lead IN leads
      ${filterAql}
      COLLECT WITH COUNT INTO c
      RETURN c
    `, bindVars)
    const total = countResult[0] ?? 0

    res.json({ items: list, total, page: pageNum, size: limitNum })
  } catch (error) {
    console.error('Error listing leads:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// GET /:id - Get single lead
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const leads = await q(`
      FOR lead IN leads
      FILTER lead._key == @id
      LIMIT 1
      RETURN lead
    `, { id })
    if (!leads.length) return res.status(404).json({ error: 'not_found', detail: 'Lead not found' })

    const scope = await buildListFilter(req)
    const canSee = await q(`
      FOR lead IN leads
      FILTER lead._key == @id
      ${scope.filterAql}
      LIMIT 1
      RETURN true
    `, { id, ...scope.bindVars })
    if (!canSee.length) return res.status(403).json({ error: 'forbidden' })

    res.json(leads[0])
  } catch (error) {
    console.error('Error fetching lead:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// PATCH /:id - Update lead
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body || {}

    const leads = await q(`FOR lead IN leads FILTER lead._key == @id LIMIT 1 RETURN lead`, { id })
    if (!leads.length) return res.status(404).json({ error: 'not_found' })
    const lead = leads[0]

    const scope = await buildListFilter(req)
    const canAccess = await q(`
      FOR lead IN leads FILTER lead._key == @id ${scope.filterAql} LIMIT 1 RETURN true
    `, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    const cfg = await getConfig()
    const allowedStages = Array.isArray(cfg.lead_stages) && cfg.lead_stages.length ? cfg.lead_stages : DEFAULT_LEAD_STAGES

    const nowIso = new Date().toISOString()
    const updates = { updated_at: nowIso }
    let stageChanged = false
    let ownerChanged = false
    let prevStage = lead.stage
    let nextStage = lead.stage
    let prevAssignee = lead.assigned_to_emp_code
    let nextAssignee = prevAssignee

    if (body.name !== undefined) updates.name = String(body.name).trim()
    if (body.contact_phone !== undefined) updates.contact_phone = s(body.contact_phone)
    if (body.contact_email !== undefined) updates.contact_email = s(body.contact_email)
    if (body.notes !== undefined) updates.notes = s(body.notes)
    if (body.source !== undefined) updates.source = s(body.source)
    if (body.value !== undefined) {
      const n = Number(body.value)
      updates.value = body.value === null || Number.isNaN(n) ? null : n
    }
    if (body.expected_value !== undefined) updates.expected_value = body.expected_value
    if (body.next_follow_up_at !== undefined) updates.next_follow_up_at = s(body.next_follow_up_at)
    if (body.tags !== undefined) updates.tags = sArr(body.tags) || []
    if (body.archived_at !== undefined) updates.archived_at = s(body.archived_at)

    if (body.stage !== undefined && allowedStages.includes(body.stage) && body.stage !== lead.stage) {
      updates.stage = body.stage
      stageChanged = true
      nextStage = body.stage
      // Stamp won_at / lost_at lifecycle timestamps.
      if (body.stage === 'Won') {
        updates.won_at = nowIso
        updates.lost_at = null
        updates.lost_reason = null
      } else if (body.stage === 'Lost') {
        updates.lost_at = nowIso
        updates.won_at = null
        // Require a lost_reason when entering Lost.
        const reason = s(body.lost_reason)
        if (!reason) return res.status(400).json({ error: 'validation_error', detail: 'lost_reason is required when moving to Lost' })
        updates.lost_reason = reason
      } else {
        // Leaving Won/Lost: clear stamps, but keep the reason if user is editing it mid-flow.
        if (lead.stage === 'Won') updates.won_at = null
        if (lead.stage === 'Lost') {
          updates.lost_at = null
          updates.lost_reason = null
        }
      }
      // Moving out of archive when the stage changes to an active one — reactivation.
      if (lead.archived_at && body.stage !== 'Won' && body.stage !== 'Lost') {
        updates.archived_at = null
      }
    } else if (body.lost_reason !== undefined && lead.stage === 'Lost') {
      // Allow editing the lost reason without changing stage.
      updates.lost_reason = s(body.lost_reason)
    }

    if (body.assigned_to_id !== undefined) {
      const assignee = await resolveAssignableUser(body.assigned_to_id, req.user)
      if (!assignee) return res.status(400).json({ error: 'validation_error', detail: 'Invalid assignee' })
      if (assignee.emp_code !== lead.assigned_to_emp_code || assignee._key !== lead.assigned_to_id) {
        ownerChanged = true
        nextAssignee = assignee.emp_code
      }
      updates.assigned_to_id = assignee._key
      updates.assigned_to_emp_code = assignee.emp_code
    }

    if (Object.keys(updates).length <= 1) return res.status(400).json({ error: 'no_updates' })

    const col = getCollection('leads')
    await col.update(id, updates)
    const updated = await q(`FOR l IN leads FILTER l._key == @id LIMIT 1 RETURN l`, { id })

    // Emit activities for stage + owner changes.
    const me = await getCurrentUserBranch(req.user.sub)
    if (stageChanged) {
      await writeActivity({
        leadKey: id,
        branchCode: lead.branch,
        kind: 'stage_change',
        body: `Stage: ${prevStage} → ${nextStage}`,
        from: prevStage,
        to: nextStage,
        outcome: nextStage === 'Lost' ? s(body.lost_reason) : null,
        createdBy: req.user.sub,
        createdByName: me?.name,
        createdByEmpCode: req.user.emp_code
      })
    }
    if (ownerChanged) {
      await writeActivity({
        leadKey: id,
        branchCode: lead.branch,
        kind: 'owner_change',
        body: `Assignee: ${prevAssignee || '—'} → ${nextAssignee || '—'}`,
        from: prevAssignee,
        to: nextAssignee,
        createdBy: req.user.sub,
        createdByName: me?.name,
        createdByEmpCode: req.user.emp_code
      })
    }

    if (stageChanged) {
      publishEvent({
        type: 'lead.stage_changed',
        payload: { lead_id: id, from: prevStage, to: nextStage, assignee_id: updated[0]?.assigned_to_id, branch: lead.branch },
        actor: { id: req.user.sub, emp_code: req.user.emp_code },
        branch: lead.branch
      })
      if (nextStage === 'Won') {
        publishEvent({
          type: 'lead.won',
          payload: { lead_id: id, assignee_id: updated[0]?.assigned_to_id, branch: lead.branch, value: updated[0]?.value },
          actor: { id: req.user.sub, emp_code: req.user.emp_code },
          branch: lead.branch
        })
      } else if (nextStage === 'Lost') {
        publishEvent({
          type: 'lead.lost',
          payload: { lead_id: id, reason: s(body.lost_reason), branch: lead.branch },
          actor: { id: req.user.sub, emp_code: req.user.emp_code },
          branch: lead.branch
        })
      }
    }

    res.json(updated[0])
  } catch (error) {
    console.error('Error updating lead:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// POST /:id/reactivate - Move a Lost lead back into the pipeline
router.post('/:id/reactivate', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const leads = await q(`FOR lead IN leads FILTER lead._key == @id LIMIT 1 RETURN lead`, { id })
    if (!leads.length) return res.status(404).json({ error: 'not_found' })
    const lead = leads[0]
    if (lead.stage !== 'Lost') {
      return res.status(400).json({ error: 'invalid_operation', detail: 'Only Lost leads can be reactivated' })
    }

    const scope = await buildListFilter(req)
    const canAccess = await q(`FOR l IN leads FILTER l._key == @id ${scope.filterAql} LIMIT 1 RETURN true`, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    const col = getCollection('leads')
    const nowIso = new Date().toISOString()
    await col.update(id, {
      stage: 'New',
      lost_at: null,
      lost_reason: null,
      archived_at: null,
      updated_at: nowIso
    })
    const me = await getCurrentUserBranch(req.user.sub)
    await writeActivity({
      leadKey: id,
      branchCode: lead.branch,
      kind: 'reactivated',
      body: 'Lead reactivated from Lost → New',
      from: 'Lost',
      to: 'New',
      createdBy: req.user.sub,
      createdByName: me?.name,
      createdByEmpCode: req.user.emp_code
    })
    const updated = await q(`FOR l IN leads FILTER l._key == @id LIMIT 1 RETURN l`, { id })
    res.json(updated[0])
  } catch (error) {
    console.error('Error reactivating lead:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// GET /:id/activities - List activities for a lead
router.get('/:id/activities', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const scope = await buildListFilter(req)
    const canAccess = await q(`FOR lead IN leads FILTER lead._key == @id ${scope.filterAql} LIMIT 1 RETURN true`, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })
    await ensureLeadActivitiesCollection()
    const rows = await q(`
      FOR a IN lead_activities
      FILTER a.lead_key == @id
      SORT a.created_at DESC
      LIMIT 500
      RETURN a
    `, { id })
    res.json({ items: rows })
  } catch (error) {
    console.error('Error listing lead activities:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// POST /:id/activities - Create an activity on a lead
router.post('/:id/activities', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const body = req.body || {}
    const kindRaw = String(body.kind || 'note').toLowerCase()
    const allowedKinds = new Set(['note', 'call', 'meeting'])
    if (!allowedKinds.has(kindRaw)) {
      return res.status(400).json({ error: 'validation_error', detail: 'kind must be note, call, or meeting' })
    }

    const scope = await buildListFilter(req)
    const canAccess = await q(`FOR lead IN leads FILTER lead._key == @id ${scope.filterAql} LIMIT 1 RETURN true`, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    const leads = await q(`FOR l IN leads FILTER l._key == @id LIMIT 1 RETURN l`, { id })
    const lead = leads[0]
    if (!lead) return res.status(404).json({ error: 'not_found' })

    const me = await getCurrentUserBranch(req.user.sub)
    const activity = await writeActivity({
      leadKey: id,
      branchCode: lead.branch,
      kind: kindRaw,
      body: s(body.body),
      outcome: s(body.outcome),
      createdBy: req.user.sub,
      createdByName: me?.name,
      createdByEmpCode: req.user.emp_code
    })

    // If the activity carries a next_follow_up_at, sync it onto the lead.
    const leadUpdates = { updated_at: new Date().toISOString() }
    if (body.next_follow_up_at !== undefined) {
      leadUpdates.next_follow_up_at = s(body.next_follow_up_at)
    }
    if (Object.keys(leadUpdates).length > 1) {
      await getCollection('leads').update(id, leadUpdates)
    }

    res.status(201).json(activity)
  } catch (error) {
    console.error('Error creating lead activity:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// POST /:id/convert - Create customer from lead
router.post('/:id/convert', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const leads = await q(`FOR lead IN leads FILTER lead._key == @id LIMIT 1 RETURN lead`, { id })
    if (!leads.length) return res.status(404).json({ error: 'not_found' })
    const lead = leads[0]

    const scope = await buildListFilter(req)
    const canAccess = await q(`
      FOR lead IN leads FILTER lead._key == @id ${scope.filterAql} LIMIT 1 RETURN true
    `, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    if (lead.converted_to_customer_id) {
      return res.status(400).json({ error: 'already_converted', detail: 'Lead already converted to customer' })
    }

    const customerPayload = req.body.customer || req.body || {}
    const branch = lead.branch
    const relationshipManager = Array.isArray(branch) ? branch : (branch || null)

    const maxIdResult = await q(`
      LET customerMax = (
        FOR c IN customers COLLECT AGGREGATE maxId = MAX(c.investor_id) RETURN maxId
      )[0] || 0
      LET minorMax = (
        FOR c IN customers
        FILTER c.minors != null && LENGTH(c.minors) > 0
        FOR m IN c.minors COLLECT AGGREGATE maxId = MAX(m.investor_id) RETURN maxId
      )[0] || 0
      RETURN MAX([customerMax, minorMax])
    `)
    const nextInvestorId = (maxIdResult[0] || 0) + 1

    const customerDoc = {
      investor_id: nextInvestorId,
      name: customerPayload.name || lead.name,
      pan: customerPayload.pan || null,
      email: customerPayload.email || lead.contact_email || null,
      mobile: customerPayload.mobile || lead.contact_phone || null,
      address1: customerPayload.address1 || null,
      address2: customerPayload.address2 || null,
      address3: customerPayload.address3 || null,
      city: customerPayload.city || null,
      state: customerPayload.state || null,
      pin: customerPayload.pin || customerPayload.pin_code || null,
      relationship_manager: relationshipManager,
      is_active: true,
      created_at: new Date().toISOString(),
      source_type: 'lead_conversion'
    }
    if (customerPayload.title) customerDoc.title = customerPayload.title
    if (customerPayload.branches) customerDoc.branches = customerPayload.branches

    const customersCol = getCollection('customers')
    const custResult = await customersCol.save(customerDoc)
    const customerId = custResult._key

    const nowIso = new Date().toISOString()
    await getCollection('leads').update(id, {
      converted_to_customer_id: customerId,
      stage: 'Won',
      won_at: nowIso,
      updated_at: nowIso
    })

    const me = await getCurrentUserBranch(req.user.sub)
    await writeActivity({
      leadKey: id,
      branchCode: lead.branch,
      kind: 'converted',
      body: `Converted to customer (investor_id ${nextInvestorId})`,
      from: lead.stage,
      to: 'Won',
      createdBy: req.user.sub,
      createdByName: me?.name,
      createdByEmpCode: req.user.emp_code
    })

    const updatedLead = await q(`FOR l IN leads FILTER l._key == @id LIMIT 1 RETURN l`, { id })
    res.status(201).json({
      customer_id: customerId,
      investor_id: nextInvestorId,
      lead: updatedLead[0],
      message: 'Lead converted to customer'
    })
  } catch (error) {
    console.error('Error converting lead:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// DELETE /:id - Delete lead
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params

    const leads = await q(`FOR lead IN leads FILTER lead._key == @id LIMIT 1 RETURN lead`, { id })
    if (!leads.length) return res.status(404).json({ error: 'not_found', detail: 'Lead not found' })
    const lead = leads[0]

    const scope = await buildListFilter(req)
    const canAccess = await q(`
      FOR lead IN leads
      FILTER lead._key == @id
      ${scope.filterAql}
      LIMIT 1
      RETURN true
    `, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    if (lead.converted_to_customer_id) {
      return res.status(400).json({ error: 'invalid_operation', detail: 'Cannot delete a converted lead' })
    }

    const isAssignee = lead.assigned_to_id === req.user.sub || lead.assigned_to_emp_code === req.user.emp_code
    const isAdminOrManager = req.user.role === 'admin' || req.user.role === 'manager'
    if (!isAdminOrManager && !isAssignee) {
      return res.status(403).json({ error: 'forbidden', detail: 'Only assignee or admin/manager can delete lead' })
    }

    await getCollection('leads').remove(id)
    res.status(204).end()
  } catch (error) {
    console.error('Error deleting lead:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/**
 * Archive-sweep task. Idempotent. Runs once per day from server.js.
 * - Won leads (not converted) older than lead_won_archive_days → archived_at = now.
 * - Lost leads older than lead_lost_archive_days → archived_at = now.
 */
export async function runLeadArchiveSweep() {
  try {
    await ensureLeadsCollection()
    const cfg = await getConfig()
    const wonDays = Number(cfg.lead_won_archive_days || 14)
    const lostDays = Number(cfg.lead_lost_archive_days || 60)
    const now = new Date()
    const wonCutoff = new Date(now.getTime() - wonDays * 86400000).toISOString()
    const lostCutoff = new Date(now.getTime() - lostDays * 86400000).toISOString()
    const nowIso = now.toISOString()

    const result = await q(`
      FOR lead IN leads
      FILTER lead.archived_at == null
      FILTER (
        (lead.stage == 'Won' && lead.converted_to_customer_id == null && lead.won_at != null && lead.won_at < @wonCutoff)
        ||
        (lead.stage == 'Lost' && lead.lost_at != null && lead.lost_at < @lostCutoff)
      )
      UPDATE lead WITH { archived_at: @now } IN leads
      COLLECT WITH COUNT INTO c
      RETURN c
    `, { wonCutoff, lostCutoff, now: nowIso })
    const archived = result[0] || 0
    if (archived > 0) {
      console.log(`[lead-archive-sweep] archived ${archived} lead(s) — wonCutoff=${wonCutoff}, lostCutoff=${lostCutoff}`)
    }
    return archived
  } catch (err) {
    console.error('runLeadArchiveSweep error:', err)
    return 0
  }
}

export default router
