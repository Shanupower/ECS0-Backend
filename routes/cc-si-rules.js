import express from 'express'
import { q, getCollection, ensureCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { 
  getAllActiveRules, 
  matchRule, 
  calculateFromRule, 
  evaluateReceiptCCSI,
  normalizeTxnType,
  extractInvestmentAmount
} from '../services/cc-si-engine.js'

const router = express.Router()

/**
 * GET /api/cc-si-rules
 * Fetch all rules (optionally filter by category or active status)
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureCollection('cc_si_rules')
    const { category, include_inactive = 'true' } = req.query

    let filters = []
    let bindVars = {}

    if (include_inactive !== 'true' && include_inactive !== '1') {
      filters.push('rule.is_active != false')
    }

    if (category) {
      const catUpper = String(category).trim().toUpperCase()
      if (catUpper === 'MF') {
        filters.push('UPPER(rule.category) IN ["MF", "SIF", "PMS", "AIF", "GIFT_CITY_FUNDS"] OR rule.category == "*"')
      } else {
        filters.push('UPPER(rule.category) == @category OR rule.category == "*"')
        bindVars.category = catUpper
      }
    }

    const filterClause = filters.length > 0 ? `FILTER ${filters.join(' AND ')}` : ''

    const query = `
      FOR rule IN cc_si_rules
      ${filterClause}
      SORT rule.created_at ASC, rule.min_amount ASC
      RETURN rule
    `

    const rules = await q(query, bindVars)
    res.json({ rules })
  } catch (error) {
    console.error('Error fetching CC/SI rules:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/**
 * POST /api/cc-si-rules/clear-auto-seeded
 * Deletes all auto-seeded/system-created default rules from database
 */
router.post('/clear-auto-seeded', requireAuth, async (req, res) => {
  try {
    await ensureCollection('cc_si_rules')
    const deleted = await q(`
      FOR rule IN cc_si_rules
      FILTER rule.created_by == "system" OR rule.created_by == null
      REMOVE rule IN cc_si_rules
      RETURN OLD._key
    `)
    res.json({
      message: `Successfully purged ${deleted.length} auto-seeded system rules.`,
      purged_count: deleted.length
    })
  } catch (error) {
    console.error('Error clearing auto-seeded rules:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

router.post('/evaluate', requireAuth, async (req, res) => {
  try {
    const { category, txn_type, amount, date } = req.body
    const result = await evaluateReceiptCCSI({
      category: category || 'MF',
      txn_type: txn_type || 'SIP',
      amount: amount || 0,
      date: date || new Date().toISOString()
    })
    res.json(result)
  } catch (error) {
    console.error('Error evaluating CC/SI rule:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/**
 * POST /api/cc-si-rules
 * Create a new rule
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureCollection('cc_si_rules')
    const {
      category = '*',
      txn_type = '*',
      cc_type = 'percentage',
      cc_value = 0,
      si_type = 'percentage',
      si_value = 0,
      min_amount = 0,
      max_amount = null,
      effective_from = null,
      effective_to = null,
      is_active = true,
      description = ''
    } = req.body

    const rulesColl = getCollection('cc_si_rules')
    
    const ruleDoc = {
      category: String(category || '*').trim().toUpperCase(),
      txn_type: String(txn_type || '*').trim().toUpperCase(),
      cc_type: cc_type === 'flat' ? 'flat' : 'percentage',
      cc_value: Number(cc_value) || 0,
      si_type: si_type === 'flat' ? 'flat' : 'percentage',
      si_value: Number(si_value) || 0,
      min_amount: Number(min_amount) || 0,
      max_amount: max_amount != null && max_amount !== '' ? Number(max_amount) : null,
      effective_from: effective_from || null,
      effective_to: effective_to || null,
      is_active: is_active !== false,
      description: String(description || '').trim(),
      created_by: req.user?._key || req.user?.id || 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const meta = await rulesColl.save(ruleDoc)
    res.status(201).json({
      message: 'Rule created successfully',
      rule: { ...ruleDoc, _key: meta._key, _id: meta._id }
    })
  } catch (error) {
    console.error('Error creating CC/SI rule:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/**
 * PUT /api/cc-si-rules/:id
 * Update an existing rule
 */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const rulesColl = getCollection('cc_si_rules')

    const existing = await q(`
      FOR r IN cc_si_rules
      FILTER r._key == @id
      LIMIT 1
      RETURN r
    `, { id })

    if (!existing.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Rule not found' })
    }

    const updates = { ...req.body }
    delete updates._key
    delete updates._id
    delete updates._rev
    delete updates.created_at
    delete updates.created_by

    if (updates.category !== undefined) updates.category = String(updates.category || '*').trim().toUpperCase()
    if (updates.txn_type !== undefined) updates.txn_type = String(updates.txn_type || '*').trim().toUpperCase()
    if (updates.cc_type !== undefined) updates.cc_type = updates.cc_type === 'flat' ? 'flat' : 'percentage'
    if (updates.si_type !== undefined) updates.si_type = updates.si_type === 'flat' ? 'flat' : 'percentage'
    if (updates.cc_value !== undefined) updates.cc_value = Number(updates.cc_value) || 0
    if (updates.si_value !== undefined) updates.si_value = Number(updates.si_value) || 0
    if (updates.min_amount !== undefined) updates.min_amount = Number(updates.min_amount) || 0
    if (updates.max_amount !== undefined) updates.max_amount = updates.max_amount != null && updates.max_amount !== '' ? Number(updates.max_amount) : null

    updates.updated_at = new Date().toISOString()
    updates.updated_by = req.user?._key || req.user?.id || 'system'

    await rulesColl.update(id, updates)
    const updatedDoc = { ...existing[0], ...updates }

    res.json({
      message: 'Rule updated successfully',
      rule: updatedDoc
    })
  } catch (error) {
    console.error('Error updating CC/SI rule:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/**
 * DELETE /api/cc-si-rules/:id
 * Delete a rule
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    const rulesColl = getCollection('cc_si_rules')

    const existing = await q(`
      FOR r IN cc_si_rules
      FILTER r._key == @id
      LIMIT 1
      RETURN r
    `, { id })

    if (!existing.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Rule not found' })
    }

    await rulesColl.remove(id)
    res.json({ message: 'Rule deleted successfully', id })
  } catch (error) {
    console.error('Error deleting CC/SI rule:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

/**
 * POST /api/cc-si-rules/recalculate-receipts
 * Recalculate CC & SI for receipts matching category / filters
 */
router.post('/recalculate-receipts', requireAuth, async (req, res) => {
  try {
    const { category, dry_run = false } = req.body
    const rules = await getAllActiveRules()

    let filterClauses = ['receipt.is_deleted != true']
    let bindVars = {}

    if (category && category !== '*') {
      filterClauses.push('UPPER(receipt.product.category) == @category OR UPPER(receipt.product_category) == @category')
      bindVars.category = String(category).trim().toUpperCase()
    }

    const receipts = await q(`
      FOR receipt IN receipts
      FILTER ${filterClauses.join(' AND ')}
      RETURN receipt
    `, bindVars)

    let updatedCount = 0
    const sampleResults = []

    const receiptsColl = getCollection('receipts')

    for (const receipt of receipts) {
      const evaluation = await evaluateReceiptCCSI(receipt, rules)
      const baseCC = evaluation.cc_amount
      const baseSI = evaluation.si_amount
      const additionalCC = Number(receipt.additional_cc) || 0
      const additionalSI = Number(receipt.additional_si) || 0

      const updates = {
        cc_amount: baseCC,
        si_amount: baseSI,
        total_cc: baseCC + additionalCC,
        total_si: baseSI + additionalSI,
        cc_si_rule_id: evaluation.rule_id,
        cc_si_rule_label: evaluation.rule_label,
        cc_si_evaluated_at: new Date().toISOString()
      }

      if (!dry_run) {
        await receiptsColl.update(receipt._key, updates)
      }

      updatedCount++
      if (sampleResults.length < 5) {
        sampleResults.push({
          receipt_id: receipt._key,
          receipt_no: receipt.receipt_no,
          category: evaluation.category_used,
          txn_type: evaluation.txn_type_used,
          amount: evaluation.amount_used,
          calculated_cc: baseCC,
          calculated_si: baseSI,
          rule_label: evaluation.rule_label
        })
      }
    }

    res.json({
      message: dry_run ? `Dry run complete. Evaluated ${updatedCount} receipts.` : `Successfully recalculated CC & SI for ${updatedCount} receipts.`,
      updated_count: updatedCount,
      dry_run: Boolean(dry_run),
      samples: sampleResults
    })
  } catch (error) {
    console.error('Error recalculating receipts CC/SI:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
