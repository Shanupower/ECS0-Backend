import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

const LEAD_STAGES = ['New', 'Contacted', 'Meeting Scheduled', 'Met', 'Proposal Sent', 'Won', 'Lost']

async function ensureLeadsCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('leads')
  const exists = await col.exists()
  if (!exists) {
    await col.create()
  }
  return getCollection('leads')
}

function normalizeBranch(branch) {
  if (!branch) return null
  return String(branch).trim().toUpperCase()
}

async function getCurrentUserBranch(userId) {
  const users = await q(`
    FOR user IN users
    FILTER user._key == @id
    LIMIT 1
    RETURN { branch: user.branch, emp_code: user.emp_code }
  `, { id: userId })
  return users.length ? users[0] : null
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

  if (role === 'admin') return { filterAql: '', bindVars: {} }
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

// POST / - Create lead
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, contact_phone, contact_email, stage, notes, assigned_to_id, source, expected_value } = req.body || {}
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'validation_error', detail: 'name is required' })
    }

    const assignee = await resolveAssignableUser(assigned_to_id || req.user.sub, req.user)
    if (!assignee) {
      return res.status(400).json({ error: 'validation_error', detail: 'Invalid or unauthorized assignee' })
    }

    const stageVal = LEAD_STAGES.includes(stage) ? stage : 'New'
    const me = await getCurrentUserBranch(req.user.sub)
    const branch = (me && me.branch) ? me.branch : null

    const leadDoc = {
      name: name.trim(),
      contact_phone: contact_phone ? String(contact_phone).trim() : null,
      contact_email: contact_email ? String(contact_email).trim() : null,
      stage: stageVal,
      notes: notes ? String(notes).trim() : null,
      assigned_to_id: assignee._key,
      assigned_to_emp_code: assignee.emp_code,
      branch,
      source: source ? String(source).trim() : null,
      expected_value: expected_value != null ? expected_value : null,
      converted_to_customer_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const col = await ensureLeadsCollection()
    const result = await col.save(leadDoc)
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
    const { stage, assignee_id, limit = '100', page = '1' } = req.query
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 100))
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const pageSkip = (pageNum - 1) * limitNum

    const scope = await buildListFilter(req)
    const bindVars = { ...scope.bindVars }

    let filterParts = [scope.filterAql].filter(Boolean)
    filterParts.push('FILTER lead.converted_to_customer_id == null')
    if (stage) {
      bindVars.stageVal = stage
      filterParts.push('FILTER lead.stage == @stageVal')
    }
    if ((req.user.role === 'admin' || req.user.role === 'manager') && assignee_id) {
      bindVars.assignee_filter = String(assignee_id).trim()
      filterParts.push('FILTER lead.assigned_to_id == @assignee_filter || lead.assigned_to_emp_code == @assignee_filter')
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
    const { name, contact_phone, contact_email, stage, notes, assigned_to_id, source, expected_value } = req.body || {}

    const leads = await q(`FOR lead IN leads FILTER lead._key == @id LIMIT 1 RETURN lead`, { id })
    if (!leads.length) return res.status(404).json({ error: 'not_found' })
    const lead = leads[0]

    const scope = await buildListFilter(req)
    const canAccess = await q(`
      FOR lead IN leads FILTER lead._key == @id ${scope.filterAql} LIMIT 1 RETURN true
    `, { id, ...scope.bindVars })
    if (!canAccess.length) return res.status(403).json({ error: 'forbidden' })

    const updates = { updated_at: new Date().toISOString() }
    if (name !== undefined) updates.name = String(name).trim()
    if (contact_phone !== undefined) updates.contact_phone = contact_phone ? String(contact_phone).trim() : null
    if (contact_email !== undefined) updates.contact_email = contact_email ? String(contact_email).trim() : null
    if (stage !== undefined && LEAD_STAGES.includes(stage)) updates.stage = stage
    if (notes !== undefined) updates.notes = notes ? String(notes).trim() : null
    if (source !== undefined) updates.source = source ? String(source).trim() : null
    if (expected_value !== undefined) updates.expected_value = expected_value
    if (assigned_to_id !== undefined) {
      const assignee = await resolveAssignableUser(assigned_to_id, req.user)
      if (!assignee) return res.status(400).json({ error: 'validation_error', detail: 'Invalid assignee' })
      updates.assigned_to_id = assignee._key
      updates.assigned_to_emp_code = assignee.emp_code
    }

    if (Object.keys(updates).length <= 1) return res.status(400).json({ error: 'no_updates' })

    const col = getCollection('leads')
    await col.update(id, updates)
    const updated = await q(`FOR l IN leads FILTER l._key == @id LIMIT 1 RETURN l`, { id })
    res.json(updated[0])
  } catch (error) {
    console.error('Error updating lead:', error)
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

    await getCollection('leads').update(id, {
      converted_to_customer_id: customerId,
      stage: 'Won',
      updated_at: new Date().toISOString()
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

export default router
