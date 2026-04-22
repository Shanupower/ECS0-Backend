import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

const CONFIG_KEY = 'default'

// Hardcoded defaults. Anything missing in the DB doc falls back to these so the
// frontend always gets a complete, sane config payload.
export const DEFAULT_APP_CONFIG = {
  lead_stages: ['New', 'Contacted', 'Meeting Scheduled', 'Met', 'Proposal Sent', 'Won', 'Lost'],
  lead_stage_probabilities: {
    New: 0.10,
    Contacted: 0.25,
    'Meeting Scheduled': 0.35,
    Met: 0.50,
    'Proposal Sent': 0.75,
    Won: 1.0,
    Lost: 0
  },
  lead_sources: ['IndiaMart', 'Website', 'Referral', 'Walk-in', 'Cold call', 'Event', 'Other'],
  lead_lost_reasons: ['Price', 'Timing', 'Went with competitor', 'Unqualified', 'No response', 'Other'],
  lead_tags: ['HNI', 'NRI', 'Hot', 'Cold', 'VIP'],
  lead_stale_threshold_days: 7,
  lead_won_archive_days: 14,
  lead_lost_archive_days: 60,
  review_tier_cadence_months: { A: 12, B: 6, C: 3 },

  // -----------------------------------------------------------------
  // Tasks redesign (Phase 0). Categories drive kanban grouping:
  // unstarted / started / completed / cancelled.
  // -----------------------------------------------------------------
  task_statuses: [
    { key: 'backlog',     label: 'Backlog',     category: 'unstarted', color: 'slate'   },
    { key: 'todo',        label: 'To do',       category: 'unstarted', color: 'blue'    },
    { key: 'in_progress', label: 'In progress', category: 'started',   color: 'amber'   },
    { key: 'in_review',   label: 'In review',   category: 'started',   color: 'violet'  },
    { key: 'blocked',     label: 'Blocked',     category: 'started',   color: 'rose'    },
    { key: 'done',        label: 'Done',        category: 'completed', color: 'emerald' },
    { key: 'cancelled',   label: 'Cancelled',   category: 'cancelled', color: 'neutral' }
  ],
  task_priorities: [
    { key: 'p0', label: 'Urgent', color: 'rose'   },
    { key: 'p1', label: 'High',   color: 'orange' },
    { key: 'p2', label: 'Normal', color: 'slate'  },
    { key: 'p3', label: 'Low',    color: 'neutral'}
  ],
  // -----------------------------------------------------------------
  // Receipt-approval workflow (v2). Configures the dynamic, team-driven
  // approval flow documented in docs/superpowers/specs/2026-04-22-...
  // -----------------------------------------------------------------
  receipt_intake_team_id: null,          // teams._key receiving freshly-submitted receipts
  receipt_final_status_label: 'Completed',
  feature_flags: {
    receipts_approval_v2: false          // flipped on during Phase 4 cutover
  },
  task_labels: [],        // [{ key, label, color }] - admin editable
  task_sla_tiers: [
    // Hours from created_at by which a task must reach a completed status.
    { key: 'sla_same_day', label: 'Same day',   warn_hours: 6,  escalate_hours: 9,   escalate_to: 'manager', notify_channels: ['in_app'] },
    { key: 'sla_next_day', label: 'Next day',   warn_hours: 20, escalate_hours: 24,  escalate_to: 'manager', notify_channels: ['in_app'] },
    { key: 'sla_72h',      label: '72 hours',   warn_hours: 60, escalate_hours: 72,  escalate_to: 'manager', notify_channels: ['in_app'] },
    { key: 'sla_week',     label: '7 days',     warn_hours: 144, escalate_hours: 168, escalate_to: 'manager', notify_channels: ['in_app'] }
  ],
  task_event_rules: [
    // Sensible starter rules that admins can edit/disable in SystemSettings -> Autopilot.
    {
      key: 'new_lead_first_call',
      event: 'lead.created',
      enabled: true,
      label: 'First contact call on new lead',
      assignee_strategy: 'event.assignee_id',
      priority: 'p1',
      sla_tier: 'sla_same_day',
      conditions: [],
      template: {
        title: 'Call new lead {{payload.lead_id}}',
        description: 'Initial outreach within 4 working hours.',
        due_in_hours: 4,
        labels: ['lead'],
        lead_id: '{{payload.lead_id}}'
      }
    },
    {
      key: 'won_lead_onboarding',
      event: 'lead.won',
      enabled: true,
      label: 'Onboard converted lead',
      assignee_strategy: 'event.assignee_id',
      priority: 'p1',
      sla_tier: 'sla_next_day',
      conditions: [],
      template: {
        title: 'Onboard customer from lead {{payload.lead_id}}',
        description: 'KYC + welcome pack for the new customer.',
        due_in_hours: 24,
        labels: ['onboarding'],
        lead_id: '{{payload.lead_id}}'
      }
    },
    {
      key: 'lost_lead_followup',
      event: 'lead.lost',
      enabled: false,
      label: 'Nurture lost lead in 30 days',
      assignee_strategy: 'event.assignee_id',
      priority: 'p3',
      sla_tier: null,
      conditions: [],
      template: {
        title: 'Nurture call for lost lead {{payload.lead_id}}',
        due_in_days: 30,
        labels: ['nurture'],
        lead_id: '{{payload.lead_id}}'
      }
    },
    {
      key: 'new_customer_welcome',
      event: 'customer.created',
      enabled: true,
      label: 'Welcome call for new customer',
      assignee_strategy: 'event.actor_id',
      priority: 'p2',
      sla_tier: 'sla_next_day',
      conditions: [],
      template: {
        title: 'Welcome call for {{payload.name}}',
        due_in_hours: 24,
        labels: ['welcome'],
        customer_id: '{{payload.customer_id}}'
      }
    },
    {
      key: 'large_receipt_verify',
      event: 'receipt.created',
      enabled: true,
      label: 'Verify large receipt',
      assignee_strategy: 'branch_manager',
      priority: 'p1',
      sla_tier: 'sla_same_day',
      conditions: [
        { field: 'payload.amount', op: '>=', value: 100000 }
      ],
      template: {
        title: 'Verify receipt {{payload.receipt_id}} (₹{{payload.amount}})',
        due_in_hours: 8,
        labels: ['compliance'],
        receipt_id: '{{payload.receipt_id}}',
        customer_id: '{{payload.customer_id}}'
      }
    },
    {
      key: 'portfolio_review_next',
      event: 'portfolio_review.completed',
      enabled: true,
      label: 'Schedule next portfolio review',
      assignee_strategy: 'event.actor_id',
      priority: 'p2',
      sla_tier: null,
      conditions: [],
      template: {
        title: 'Portfolio review follow-up {{payload.investor_id}}',
        due_on: '{{payload.next_review_due}}',
        labels: ['review'],
        customer_id: '{{payload.customer_id}}'
      }
    }
  ],
  task_default_view: 'list' // 'list' | 'kanban' | 'calendar'
}

async function ensureAppConfigCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('app_config')
  const exists = await col.exists()
  if (!exists) await col.create()
  return getCollection('app_config')
}

function mergeDefaults(stored) {
  const out = { ...DEFAULT_APP_CONFIG, ...(stored || {}) }
  // Merge probability maps per stage so a user can tweak one without losing the rest.
  out.lead_stage_probabilities = {
    ...DEFAULT_APP_CONFIG.lead_stage_probabilities,
    ...((stored && stored.lead_stage_probabilities) || {})
  }
  out.review_tier_cadence_months = {
    ...DEFAULT_APP_CONFIG.review_tier_cadence_months,
    ...((stored && stored.review_tier_cadence_months) || {})
  }
  // Task enums/arrays fall back to defaults only when stored value is missing so admins
  // can safely clear a list (empty array) without accidentally inheriting seed entries.
  for (const k of ['task_statuses', 'task_priorities', 'task_labels', 'task_sla_tiers', 'task_event_rules']) {
    if (!Array.isArray(out[k])) out[k] = DEFAULT_APP_CONFIG[k]
  }
  if (!out.task_default_view) out.task_default_view = DEFAULT_APP_CONFIG.task_default_view
  // Feature flags: union of defaults + stored, with stored taking precedence.
  out.feature_flags = {
    ...DEFAULT_APP_CONFIG.feature_flags,
    ...((stored && stored.feature_flags && typeof stored.feature_flags === 'object') ? stored.feature_flags : {})
  }
  if (!out.receipt_final_status_label) out.receipt_final_status_label = DEFAULT_APP_CONFIG.receipt_final_status_label
  return out
}

/** Exposed for other routes (leads.js). Returns merged config (never throws). */
export async function getAppConfig() {
  try {
    await ensureAppConfigCollection()
    const rows = await q(`
      FOR c IN app_config FILTER c._key == @key LIMIT 1 RETURN c
    `, { key: CONFIG_KEY })
    return mergeDefaults(rows[0] || null)
  } catch (e) {
    console.error('getAppConfig error:', e)
    return mergeDefaults(null)
  }
}

// GET /api/app-config — any authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const cfg = await getAppConfig()
    res.json(cfg)
  } catch (error) {
    console.error('Error getting app config:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

function validatePayload(patch) {
  const errs = []

  if (patch.lead_stages !== undefined) {
    if (!Array.isArray(patch.lead_stages) || patch.lead_stages.length === 0) {
      errs.push('lead_stages must be a non-empty array')
    } else {
      const set = new Set(patch.lead_stages.map(s => String(s).trim()).filter(Boolean))
      if (!set.has('Won') || !set.has('Lost')) {
        errs.push("lead_stages must include both 'Won' and 'Lost'")
      }
    }
  }

  if (patch.lead_stage_probabilities !== undefined) {
    if (typeof patch.lead_stage_probabilities !== 'object' || Array.isArray(patch.lead_stage_probabilities)) {
      errs.push('lead_stage_probabilities must be an object')
    } else {
      for (const [k, v] of Object.entries(patch.lead_stage_probabilities)) {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > 1) errs.push(`lead_stage_probabilities.${k} must be between 0 and 1`)
      }
    }
  }

  for (const key of ['lead_sources', 'lead_lost_reasons', 'lead_tags']) {
    if (patch[key] !== undefined) {
      if (!Array.isArray(patch[key])) errs.push(`${key} must be an array`)
      else if (patch[key].some(x => typeof x !== 'string' || !x.trim())) errs.push(`${key} entries must be non-empty strings`)
    }
  }

  for (const key of ['lead_stale_threshold_days', 'lead_won_archive_days', 'lead_lost_archive_days']) {
    if (patch[key] !== undefined) {
      const n = Number(patch[key])
      if (!Number.isFinite(n) || n < 0 || n > 365) errs.push(`${key} must be a number between 0 and 365`)
    }
  }

  if (patch.review_tier_cadence_months !== undefined) {
    if (typeof patch.review_tier_cadence_months !== 'object' || Array.isArray(patch.review_tier_cadence_months)) {
      errs.push('review_tier_cadence_months must be an object')
    } else {
      for (const [k, v] of Object.entries(patch.review_tier_cadence_months)) {
        const n = Number(v)
        if (!Number.isFinite(n) || n <= 0 || n > 60) errs.push(`review_tier_cadence_months.${k} must be 1–60`)
      }
    }
  }

  // Tasks config validation
  if (patch.task_statuses !== undefined) {
    if (!Array.isArray(patch.task_statuses) || !patch.task_statuses.length) {
      errs.push('task_statuses must be a non-empty array')
    } else {
      const keys = new Set()
      const validCategories = new Set(['unstarted', 'started', 'completed', 'cancelled'])
      for (const s of patch.task_statuses) {
        if (!s || typeof s !== 'object') { errs.push('task_statuses entries must be objects'); continue }
        if (!s.key || typeof s.key !== 'string') { errs.push('task_statuses.key required'); continue }
        if (keys.has(s.key)) errs.push(`task_statuses duplicate key ${s.key}`)
        keys.add(s.key)
        if (!s.label || typeof s.label !== 'string') errs.push(`task_statuses.${s.key}.label required`)
        if (!validCategories.has(s.category)) errs.push(`task_statuses.${s.key}.category must be one of ${[...validCategories].join('/')}`)
      }
      if (![...keys].some(k => k === 'done')) errs.push('task_statuses must include a "done" key')
    }
  }
  if (patch.task_priorities !== undefined) {
    if (!Array.isArray(patch.task_priorities) || !patch.task_priorities.length) {
      errs.push('task_priorities must be a non-empty array')
    } else {
      for (const p of patch.task_priorities) {
        if (!p || typeof p !== 'object' || !p.key || !p.label) errs.push('task_priorities entries need key+label')
      }
    }
  }
  for (const key of ['task_labels', 'task_sla_tiers', 'task_event_rules']) {
    if (patch[key] !== undefined && !Array.isArray(patch[key])) errs.push(`${key} must be an array`)
  }
  if (patch.task_default_view !== undefined) {
    const allowed = ['list', 'kanban', 'calendar']
    if (!allowed.includes(patch.task_default_view)) errs.push(`task_default_view must be one of ${allowed.join('/')}`)
  }

  // Receipt-approval workflow validation.
  if (patch.receipt_intake_team_id !== undefined && patch.receipt_intake_team_id !== null) {
    if (typeof patch.receipt_intake_team_id !== 'string' || !patch.receipt_intake_team_id.trim()) {
      errs.push('receipt_intake_team_id must be a non-empty string (or null to unset)')
    }
  }
  if (patch.receipt_final_status_label !== undefined) {
    if (typeof patch.receipt_final_status_label !== 'string' || !patch.receipt_final_status_label.trim()) {
      errs.push('receipt_final_status_label must be a non-empty string')
    }
  }
  if (patch.feature_flags !== undefined) {
    if (!patch.feature_flags || typeof patch.feature_flags !== 'object' || Array.isArray(patch.feature_flags)) {
      errs.push('feature_flags must be an object')
    } else {
      for (const [k, v] of Object.entries(patch.feature_flags)) {
        if (typeof v !== 'boolean') errs.push(`feature_flags.${k} must be boolean`)
      }
    }
  }

  return errs
}

// PUT /api/app-config — admin or manager
router.put('/', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await ensureAppConfigCollection()
    const body = req.body || {}
    const errs = validatePayload(body)
    if (errs.length) return res.status(400).json({ error: 'validation_error', detail: errs.join('; ') })

    // If admin is setting the intake team, verify it exists and is active.
    if (Object.prototype.hasOwnProperty.call(body, 'receipt_intake_team_id') && body.receipt_intake_team_id) {
      const exists = await q(`
        FOR t IN teams FILTER t._key == @k AND t.is_active != false LIMIT 1 RETURN 1
      `, { k: String(body.receipt_intake_team_id) }).catch(() => [])
      if (!exists.length) {
        return res.status(400).json({
          error: 'validation_error',
          detail: 'receipt_intake_team_id must reference an active team'
        })
      }
    }

    // Normalize + whitelist only known keys.
    const patch = {}
    const allowKeys = new Set([
      'lead_stages',
      'lead_stage_probabilities',
      'lead_sources',
      'lead_lost_reasons',
      'lead_tags',
      'lead_stale_threshold_days',
      'lead_won_archive_days',
      'lead_lost_archive_days',
      'review_tier_cadence_months',
      // Tasks redesign
      'task_statuses',
      'task_priorities',
      'task_labels',
      'task_sla_tiers',
      'task_event_rules',
      'task_default_view',
      // Receipt-approval workflow
      'receipt_intake_team_id',
      'receipt_final_status_label',
      'feature_flags'
    ])
    // Keys whose array values are arrays of objects — preserve shape instead of string-coercing.
    const objectArrayKeys = new Set(['task_statuses', 'task_priorities', 'task_labels', 'task_sla_tiers', 'task_event_rules'])
    // String-scalar keys: keep as trimmed strings (never cast to Number).
    const stringKeys = new Set(['task_default_view', 'receipt_intake_team_id', 'receipt_final_status_label'])
    // Object keys whose values must be preserved verbatim (not coerced to Number).
    const rawObjectKeys = new Set(['feature_flags'])
    for (const [k, v] of Object.entries(body)) {
      if (!allowKeys.has(k)) continue
      if (stringKeys.has(k)) {
        if (v === null) patch[k] = null
        else if (typeof v === 'string') patch[k] = v.trim() || null
        continue
      }
      if (rawObjectKeys.has(k)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) patch[k] = { ...v }
        continue
      }
      if (objectArrayKeys.has(k)) {
        if (Array.isArray(v)) patch[k] = v.filter(x => x && typeof x === 'object').map(x => ({ ...x }))
      } else if (Array.isArray(v)) {
        patch[k] = v.map(s => String(s).trim()).filter(Boolean)
      } else if (v && typeof v === 'object') {
        const o = {}
        for (const [kk, vv] of Object.entries(v)) o[kk] = typeof vv === 'number' ? vv : Number(vv)
        patch[k] = o
      } else if (typeof v === 'number') patch[k] = v
      else if (typeof v === 'string' && v.trim() !== '') {
        patch[k] = Number(v)
      }
    }

    patch.updated_at = new Date().toISOString()
    patch.updated_by = req.user?.sub || null
    patch.updated_by_emp_code = req.user?.emp_code || null

    const col = getCollection('app_config')
    // Upsert: try update; if missing, create.
    const existing = await q(`FOR c IN app_config FILTER c._key == @key LIMIT 1 RETURN c`, { key: CONFIG_KEY })
    if (existing.length) {
      await col.update(CONFIG_KEY, patch)
    } else {
      await col.save({ _key: CONFIG_KEY, ...patch })
    }
    const merged = await getAppConfig()
    res.json(merged)
  } catch (error) {
    console.error('Error updating app config:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
