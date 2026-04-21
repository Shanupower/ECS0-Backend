// Task AI layer (behind feature flag).
//
// All endpoints gracefully return deterministic/heuristic fallbacks when
// `AI_ENABLED` is not set. LLM wiring is pluggable: if a process has
// `AI_PROVIDER === 'openai'` and `OPENAI_API_KEY`, callers can swap in real
// LLM calls via a future adapter without changing the frontend contract.

import express from 'express'
import { q } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

function aiEnabled() {
  return process.env.AI_ENABLED === '1' || process.env.AI_ENABLED === 'true'
}

function addBusinessDays(startISO, days) {
  const d = new Date(startISO)
  let added = 0
  while (added < days) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Summarise: thread summary + next-action suggestion
// ---------------------------------------------------------------------------
router.post('/summarize', requireAuth, async (req, res) => {
  try {
    const { task_id } = req.body || {}
    if (!task_id) return res.status(400).json({ error: 'validation_error', detail: 'task_id required' })

    const task = (await q('FOR t IN tasks FILTER t._key == @k LIMIT 1 RETURN t', { k: task_id }))[0]
    if (!task) return res.status(404).json({ error: 'not_found' })

    const [comments, activities] = await Promise.all([
      q('FOR c IN task_comments FILTER c.task_id == @k SORT c.created_at ASC RETURN c', { k: task_id }).catch(() => []),
      q('FOR a IN task_activities FILTER a.task_id == @k SORT a.created_at ASC LIMIT 50 RETURN a', { k: task_id }).catch(() => [])
    ])

    const summaryLines = []
    summaryLines.push(`${task.title} — ${task.status}/${task.priority}${task.sla_breached_at ? ' (SLA breached)' : ''}`)
    if (task.due_date) summaryLines.push(`Due ${task.due_date}`)
    if (comments.length) {
      summaryLines.push(`${comments.length} comment(s). Last: "${(comments[comments.length - 1].body || '').slice(0, 200)}"`)
    }
    if (activities.length) {
      const recent = activities.slice(-5).map(a => a.type).filter(Boolean)
      if (recent.length) summaryLines.push(`Recent activity: ${recent.join(', ')}`)
    }

    // Next-action heuristic
    const nextActions = []
    if (task.status === 'blocked') nextActions.push('Unblock: capture the blocker in a comment, then re-route.')
    if (task.status !== 'done' && task.due_date && task.due_date < new Date().toISOString().slice(0, 10)) nextActions.push('Set a realistic due date — this task is overdue.')
    if ((comments?.length || 0) === 0 && (activities?.length || 0) < 2) nextActions.push('Add a short status note so watchers have context.')
    if (!task.assignee_id) nextActions.push('Assign an owner — unassigned tasks rarely get finished.')
    if (!nextActions.length) nextActions.push('Break this task into 2–3 checklist items and push the first to done today.')

    res.json({
      ai_enabled: aiEnabled(),
      summary: summaryLines.join('\n'),
      next_actions: nextActions
    })
  } catch (error) {
    console.error('ai summarize error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ---------------------------------------------------------------------------
// Suggest assignee based on who typically closes similar tasks.
// ---------------------------------------------------------------------------
router.post('/suggest-assignee', requireAuth, async (req, res) => {
  try {
    const { title = '', customer_id = null, lead_id = null, branch = null } = req.body || {}
    const keyword = String(title).toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 3)
    const branchFilter = branch ? 'FILTER t.branch == @branch' : ''
    const customerFilter = customer_id ? 'FILTER t.customer_id == @cid' : ''
    const leadFilter = lead_id ? 'FILTER t.lead_id == @lid' : ''

    // Prefer recent, completed tasks with a shared keyword or related entity.
    const rows = await q(`
      FOR t IN tasks
        FILTER t.status == 'done' AND t.assignee_id != null
        ${branchFilter}
        ${customerFilter}
        ${leadFilter}
        SORT t.completed_at DESC
        LIMIT 200
        RETURN { assignee_id: t.assignee_id, assignee_emp_code: t.assignee_emp_code, title: t.title }
    `, { branch: branch || null, cid: customer_id || null, lid: lead_id || null })

    const scores = new Map()
    for (const r of rows) {
      const titleLower = String(r.title || '').toLowerCase()
      let score = 1
      for (const kw of keyword) if (titleLower.includes(kw)) score += 3
      const prev = scores.get(r.assignee_id) || { assignee_id: r.assignee_id, assignee_emp_code: r.assignee_emp_code, score: 0, completed_count: 0 }
      prev.score += score
      prev.completed_count += 1
      scores.set(r.assignee_id, prev)
    }
    const ranked = Array.from(scores.values()).sort((a, b) => b.score - a.score).slice(0, 5)
    res.json({ ai_enabled: aiEnabled(), suggestions: ranked })
  } catch (error) {
    console.error('ai suggest-assignee error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ---------------------------------------------------------------------------
// Natural-language rule builder -> rule template.
// ---------------------------------------------------------------------------
router.post('/suggest-rule', requireAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').toLowerCase()
    if (!prompt) return res.status(400).json({ error: 'validation_error', detail: 'prompt required' })

    const rule = {
      key: `nl_${Date.now()}`,
      event: 'lead.created',
      enabled: false,
      label: prompt.slice(0, 80),
      assignee_strategy: 'event.assignee_id',
      priority: 'p2',
      sla_tier: null,
      conditions: [],
      template: { title: prompt, due_in_hours: 24 }
    }

    // Heuristic mapping
    if (/new lead|new customer|signup/.test(prompt))         rule.event = 'lead.created'
    if (/won|converted/.test(prompt))                         rule.event = 'lead.won'
    if (/lost/.test(prompt))                                  rule.event = 'lead.lost'
    if (/receipt|payment/.test(prompt))                       rule.event = 'receipt.created'
    if (/review/.test(prompt))                                rule.event = 'portfolio_review.completed'

    if (/urgent|asap|immediately/.test(prompt))   rule.priority = 'p0'
    else if (/important|high/.test(prompt))       rule.priority = 'p1'
    else if (/low|later/.test(prompt))            rule.priority = 'p3'

    if (/same day|today|4 hour/.test(prompt))        rule.sla_tier = 'sla_same_day'
    else if (/24 hour|next day/.test(prompt))        rule.sla_tier = 'sla_next_day'
    else if (/72|3 day/.test(prompt))                rule.sla_tier = 'sla_72h'
    else if (/week/.test(prompt))                    rule.sla_tier = 'sla_week'

    if (/branch manager/.test(prompt)) rule.assignee_strategy = 'branch_manager'
    else if (/round robin|rotate/.test(prompt)) rule.assignee_strategy = 'round_robin'

    const hoursMatch = prompt.match(/(\d+)\s*hour/)
    const daysMatch = prompt.match(/(\d+)\s*day/)
    if (hoursMatch) rule.template.due_in_hours = Number(hoursMatch[1])
    else if (daysMatch) { rule.template.due_in_days = Number(daysMatch[1]); delete rule.template.due_in_hours }

    res.json({ ai_enabled: aiEnabled(), rule })
  } catch (error) {
    console.error('ai suggest-rule error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ---------------------------------------------------------------------------
// Motion-style scheduling: pick a scheduled_date that avoids weekends.
// ---------------------------------------------------------------------------
router.post('/schedule', requireAuth, async (req, res) => {
  try {
    const { task_id, user_id } = req.body || {}
    if (!task_id) return res.status(400).json({ error: 'validation_error', detail: 'task_id required' })

    const task = (await q('FOR t IN tasks FILTER t._key == @k LIMIT 1 RETURN t', { k: task_id }))[0]
    if (!task) return res.status(404).json({ error: 'not_found' })

    // Count open tasks for candidate user to avoid piling onto the busiest person.
    const uid = user_id || task.assignee_id || null
    let existingToday = 0
    if (uid) {
      const today = new Date().toISOString().slice(0, 10)
      const rows = await q(`
        FOR t IN tasks FILTER t.assignee_id == @u AND t.scheduled_date == @d AND t.status NOT IN ['done', 'cancelled']
        COLLECT WITH COUNT INTO c RETURN c
      `, { u: uid, d: today }).catch(() => [0])
      existingToday = rows[0] || 0
    }
    const today = new Date().toISOString().slice(0, 10)
    const scheduled_date = existingToday >= 5 ? addBusinessDays(today, 1) : today
    res.json({ ai_enabled: aiEnabled(), scheduled_date, reason: existingToday >= 5 ? 'Day already full, pushed 1 business day.' : 'Open slot today.' })
  } catch (error) {
    console.error('ai schedule error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// ---------------------------------------------------------------------------
// Natural-language -> filter object.
// ---------------------------------------------------------------------------
router.post('/nl-filter', requireAuth, async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').toLowerCase()
    if (!prompt) return res.status(400).json({ error: 'validation_error', detail: 'prompt required' })

    const filters = {}
    if (/overdue/.test(prompt))                filters.due = 'overdue'
    else if (/today/.test(prompt))             filters.due = 'today'
    else if (/this week/.test(prompt))         filters.due = 'this_week'
    else if (/upcoming/.test(prompt))          filters.due = 'upcoming'

    if (/my tasks|mine|assigned to me/.test(prompt)) filters.assignee = 'me'
    if (/unassigned|no owner/.test(prompt))         filters.assignee = '__unassigned'

    if (/urgent|p0/.test(prompt))     filters.priority = 'p0'
    else if (/high|p1/.test(prompt))  filters.priority = 'p1'
    else if (/low|p3/.test(prompt))   filters.priority = 'p3'

    if (/blocked/.test(prompt))      filters.status = 'blocked'
    else if (/in progress|doing/.test(prompt)) filters.status = 'in_progress'
    else if (/review/.test(prompt))  filters.status = 'in_review'
    else if (/done|completed/.test(prompt)) filters.status = 'done'
    else if (/cancell/.test(prompt)) filters.status = 'cancelled'

    if (/sla|breached/.test(prompt)) filters.sla_breached = '1'
    if (/archived/.test(prompt)) filters.archived = 'all'

    res.json({ ai_enabled: aiEnabled(), filters })
  } catch (error) {
    console.error('ai nl-filter error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
