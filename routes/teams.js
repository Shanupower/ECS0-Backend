// Teams API — global approver groups used by the receipt-approval workflow.
//
// A team is { name, lead_user_id, member_ids[], is_active }. Teams are global
// (not per-branch). When a receipt is routed to a team, an approval task is
// created assigned to the lead with the other members as watchers; any member
// can approve.
//
// Permissions:
//   - admin          — full CRUD
//   - any auth user  — read-only (list + single)
//   - admin, manager — /:key/workload

import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { ensureTaskSetup } from '../config/tasks-collections.js'

const router = express.Router()

// Lazy idempotent setup so the teams collection + indexes exist before first use.
let __setupPromise = null
async function ensureReady() {
  if (!__setupPromise) {
    __setupPromise = ensureTaskSetup().catch((err) => {
      console.error('[teams] ensureTaskSetup failed:', err)
      __setupPromise = null
      throw err
    })
  }
  return __setupPromise
}

function now() { return new Date().toISOString() }

function sanitizeName(s) {
  return String(s ?? '').trim()
}

async function hydrateMembers(memberIds) {
  if (!Array.isArray(memberIds) || !memberIds.length) return []
  const rows = await q(`
    FOR u IN users
      FILTER u._key IN @ids
      RETURN { id: u._key, name: u.name, emp_code: u.emp_code, role: u.role, is_active: u.is_active }
  `, { ids: memberIds.map(String) })
  const byId = new Map(rows.map(r => [r.id, r]))
  // Preserve original order, include unknowns as { id, missing: true }.
  return memberIds.map(id => byId.get(String(id)) || { id: String(id), missing: true })
}

/**
 * Validates a create/update payload. Pass existingDoc for updates so we can
 * merge and validate the combined shape.
 * Returns { errors: string[], doc?: {...} } where doc is the normalized save-ready doc
 * (only present when errors is empty).
 */
async function validateTeamPayload(body, { existingDoc = null } = {}) {
  const errors = []
  const merged = { ...(existingDoc || {}), ...(body || {}) }

  const name = sanitizeName(merged.name)
  if (!name) errors.push('name is required')
  if (name.length > 80) errors.push('name must be <= 80 chars')

  const leadId = merged.lead_user_id != null ? String(merged.lead_user_id).trim() : ''
  if (!leadId) errors.push('lead_user_id is required')

  const memberIds = Array.isArray(merged.member_ids)
    ? [...new Set(merged.member_ids.map(x => String(x).trim()).filter(Boolean))]
    : []
  if (!memberIds.length) errors.push('member_ids must be non-empty')
  if (leadId && !memberIds.includes(leadId)) errors.push('lead_user_id must be included in member_ids')

  if (errors.length) return { errors }

  // Verify lead + all members exist and are active users.
  const allIds = [...new Set([leadId, ...memberIds])]
  const userRows = await q(`
    FOR u IN users FILTER u._key IN @ids RETURN { id: u._key, is_active: u.is_active }
  `, { ids: allIds })
  const seen = new Map(userRows.map(r => [r.id, r]))
  const missing = allIds.filter(id => !seen.has(id))
  if (missing.length) errors.push(`unknown user ids: ${missing.join(',')}`)
  const inactive = allIds.filter(id => seen.get(id) && seen.get(id).is_active === false)
  if (inactive.length) errors.push(`inactive user ids: ${inactive.join(',')}`)

  // Name uniqueness (case-insensitive). Skip the current doc on update.
  const dupRows = await q(`
    FOR t IN teams
      FILTER LOWER(TRIM(t.name)) == @n
      LIMIT 1 RETURN t._key
  `, { n: name.toLowerCase() })
  if (dupRows.length && dupRows[0] !== existingDoc?._key) {
    errors.push('name must be unique')
  }

  if (errors.length) return { errors }

  const doc = {
    name,
    description: merged.description != null ? String(merged.description).trim() : null,
    lead_user_id: leadId,
    member_ids: memberIds,
    is_active: merged.is_active === undefined ? true : !!merged.is_active
  }
  return { errors: [], doc }
}

// ------------------------------------------------------------------
// Read
// ------------------------------------------------------------------

/** List teams (active by default; pass ?include_inactive=1 for all).
 *  Hydrates `lead` and `members` with { id, name, emp_code, role } so the UI
 *  can display human-readable names without a second round-trip.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true'
    const rows = await q(`
      FOR t IN teams
        ${includeInactive ? '' : 'FILTER t.is_active == true'}
        SORT t.name ASC
        RETURN {
          id: t._key,
          name: t.name,
          description: t.description,
          lead_user_id: t.lead_user_id,
          member_ids: t.member_ids,
          member_count: LENGTH(t.member_ids),
          is_active: t.is_active,
          created_at: t.created_at,
          updated_at: t.updated_at
        }
    `)

    // Bulk-hydrate every user referenced across all teams in one round-trip.
    const allUserIds = [...new Set(rows.flatMap(t => (t.member_ids || []).map(String)))]
    const userRows = allUserIds.length
      ? await q(`FOR u IN users FILTER u._key IN @ids RETURN { id: u._key, name: u.name, emp_code: u.emp_code, role: u.role, is_active: u.is_active }`, { ids: allUserIds })
      : []
    const byId = new Map(userRows.map(u => [u.id, u]))
    const hydrate = (ids) => (ids || []).map(id => byId.get(String(id)) || { id: String(id), missing: true })

    const out = rows.map(t => ({
      ...t,
      lead: byId.get(String(t.lead_user_id)) || (t.lead_user_id ? { id: String(t.lead_user_id), missing: true } : null),
      members: hydrate(t.member_ids)
    }))
    res.json(out)
  } catch (err) {
    console.error('[teams] list error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

/** Get single team with members hydrated. */
router.get('/:key', requireAuth, async (req, res) => {
  try {
    await ensureReady()
    const rows = await q(`
      FOR t IN teams FILTER t._key == @key LIMIT 1
      RETURN t
    `, { key: String(req.params.key) })
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    const t = rows[0]
    const members = await hydrateMembers(t.member_ids || [])
    const lead = members.find(m => m.id === t.lead_user_id) || null
    res.json({
      id: t._key,
      name: t.name,
      description: t.description ?? null,
      lead_user_id: t.lead_user_id,
      lead,
      member_ids: t.member_ids || [],
      members,
      is_active: t.is_active,
      created_at: t.created_at,
      updated_at: t.updated_at
    })
  } catch (err) {
    console.error('[teams] get error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

// ------------------------------------------------------------------
// Workload (admin / manager)
// ------------------------------------------------------------------

/** Open approval-task counts for the team and each member (admin/manager only). */
router.get('/:key/workload', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await ensureReady()
    const key = String(req.params.key)
    const team = (await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: key }))[0]
    if (!team) return res.status(404).json({ error: 'not_found' })

    const openByTeam = await q(`
      RETURN LENGTH(
        FOR tk IN tasks
          FILTER tk.team_id == @k AND tk.kind == 'receipt_approval'
          FILTER tk.status NOT IN ['done', 'cancelled']
          RETURN 1
      )
    `, { k: key })

    const openByMember = await q(`
      FOR tk IN tasks
        FILTER tk.team_id == @k AND tk.kind == 'receipt_approval'
        FILTER tk.status NOT IN ['done', 'cancelled']
        COLLECT assignee = tk.assignee_id WITH COUNT INTO n
        RETURN { assignee_id: assignee, open_count: n }
    `, { k: key })

    res.json({
      team_id: key,
      team_name: team.name,
      open_approval_tasks: openByTeam[0] || 0,
      by_member: openByMember
    })
  } catch (err) {
    console.error('[teams] workload error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

// ------------------------------------------------------------------
// Create / Update / Delete (admin only)
// ------------------------------------------------------------------

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await ensureReady()
    const { errors, doc } = await validateTeamPayload(req.body || {})
    if (errors.length) return res.status(400).json({ error: 'validation_error', detail: errors.join('; ') })

    const col = getCollection('teams')
    // Let the collection's keyOptions decide the _key (may be traditional or autoincrement
    // depending on how teams was provisioned in a given environment).
    const saved = await col.save({
      ...doc,
      created_at: now(),
      updated_at: now(),
      created_by: req.user?.sub || null
    })
    const full = (await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: saved._key }))[0]
    res.status(201).json({ id: full._key, ...full })
  } catch (err) {
    console.error('[teams] create error:', err)
    if (err?.errorNum === 1210) { // unique constraint
      return res.status(409).json({ error: 'duplicate', detail: 'team name already in use' })
    }
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

router.patch('/:key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await ensureReady()
    const key = String(req.params.key)
    const col = getCollection('teams')
    const existing = (await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: key }))[0]
    if (!existing) return res.status(404).json({ error: 'not_found' })

    const { errors, doc } = await validateTeamPayload(req.body || {}, { existingDoc: existing })
    if (errors.length) return res.status(400).json({ error: 'validation_error', detail: errors.join('; ') })

    // If the client is trying to deactivate the team while a receipt is held
    // by it, block — the receipt would be stranded.
    if (existing.is_active && doc.is_active === false) {
      const held = await q(`
        RETURN LENGTH(FOR r IN receipts FILTER r.current_team_id == @k LIMIT 1 RETURN 1)
      `, { k: key })
      if ((held[0] || 0) > 0) {
        return res.status(409).json({ error: 'team_in_use', detail: 'cannot deactivate — receipt is currently held by this team' })
      }
    }

    await col.update(key, {
      ...doc,
      updated_at: now(),
      updated_by: req.user?.sub || null
    })
    const full = (await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: key }))[0]
    res.json({ id: full._key, ...full })
  } catch (err) {
    console.error('[teams] update error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

/**
 * Soft-delete: sets is_active=false. Refuses if a receipt currently holds this
 * team. Real hard delete is intentionally not exposed to preserve history.
 */
router.delete('/:key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await ensureReady()
    const key = String(req.params.key)
    const existing = (await q('FOR t IN teams FILTER t._key == @k LIMIT 1 RETURN t', { k: key }))[0]
    if (!existing) return res.status(404).json({ error: 'not_found' })

    const held = await q(`
      RETURN LENGTH(FOR r IN receipts FILTER r.current_team_id == @k LIMIT 1 RETURN 1)
    `, { k: key })
    if ((held[0] || 0) > 0) {
      return res.status(409).json({ error: 'team_in_use', detail: 'cannot delete — receipt is currently held by this team' })
    }

    const col = getCollection('teams')
    await col.update(key, { is_active: false, updated_at: now(), updated_by: req.user?.sub || null })
    res.json({ ok: true, soft_deleted: true })
  } catch (err) {
    console.error('[teams] delete error:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

export default router
