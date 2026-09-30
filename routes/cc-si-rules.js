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
      } else if (catUpper === 'INS' || catUpper === 'INSURANCE') {
        filters.push('UPPER(rule.category) IN ["INS", "INS_LIFE", "INS_HEALTH", "INS_GENERAL", "LIFE", "HEALTH", "GENERAL"] OR rule.category == "*"')
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
 * POST /api/cc-si-rules/seed-defaults
 * Seeds standard default rules for MF (SIP, LUMPSUM, STP, SWITCH_OVER) and other categories
 */
router.post('/seed-defaults', requireAuth, async (req, res) => {
  try {
    await ensureCollection('cc_si_rules')
    const rulesColl = getCollection('cc_si_rules')

    const defaultRules = [
      {
        category: 'MF',
        txn_type: 'SIP',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.5,
        stp_base: 'corpus',
        min_amount: 0,
        max_amount: null,
        description: 'Standard Mutual Fund SIP Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'MF',
        txn_type: 'LUMPSUM',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.5,
        stp_base: 'corpus',
        min_amount: 0,
        max_amount: null,
        description: 'Standard Mutual Fund Lumpsum Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'MF',
        txn_type: 'STP',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.5,
        stp_base: 'corpus',
        min_amount: 0,
        max_amount: null,
        description: 'Mutual Fund STP Default Rule (Based on Original Corpus)',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'MF',
        txn_type: 'SWITCH_OVER',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.5,
        stp_base: 'corpus',
        min_amount: 0,
        max_amount: null,
        description: 'Mutual Fund Switch Over Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'FD',
        txn_type: 'FRESH',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.5,
        min_amount: 0,
        max_amount: null,
        description: 'Fixed Deposit Fresh Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'FD',
        txn_type: 'RENEWAL',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.25,
        min_amount: 0,
        max_amount: null,
        description: 'Fixed Deposit Renewal Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'INS',
        txn_type: 'FRESH',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 2.0,
        min_amount: 0,
        max_amount: null,
        description: 'Insurance Fresh Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'INS',
        txn_type: 'RENEWAL',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 1.0,
        min_amount: 0,
        max_amount: null,
        description: 'Insurance Renewal Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'BOND',
        txn_type: 'FRESH',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0.5,
        min_amount: 0,
        max_amount: null,
        description: 'Bonds Fresh Default Rule',
        is_active: true,
        created_by: 'system'
      },
      {
        category: 'MISC',
        txn_type: '*',
        cc_type: 'percentage',
        cc_value: 100,
        si_type: 'percentage',
        si_value: 0,
        min_amount: 0,
        max_amount: null,
        description: 'Miscellaneous Services Default Rule',
        is_active: true,
        created_by: 'system'
      }
    ]

    let seededCount = 0
    const now = new Date().toISOString()

    for (const rule of defaultRules) {
      // Check if a rule for this category and txn_type already exists
      const existing = await q(`
        FOR r IN cc_si_rules
        FILTER r.category == @category AND r.txn_type == @txn_type
        LIMIT 1
        RETURN r._key
      `, { category: rule.category, txn_type: rule.txn_type })

      if (existing.length === 0) {
        await rulesColl.save({
          ...rule,
          created_at: now,
          updated_at: now
        })
        seededCount++
      }
    }

    res.json({
      message: `Successfully seeded ${seededCount} default CC & SI rules.`,
      seeded_count: seededCount
    })
  } catch (error) {
    console.error('Error seeding default CC/SI rules:', error)
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
    const {
      category,
      txn_type,
      amount,
      date,
      stp_amount,
      stp_original_amount,
      switch_value,
      period_installments,
      stp_base,
      scheme_code,
      source_scheme_code,
      target_scheme_code,
      switch_from_scheme_code,
      switch_to_scheme_code,
      stp_target_scheme_code
    } = req.body

    const result = await evaluateReceiptCCSI({
      category: category || 'MF',
      txn_type: txn_type || 'SIP',
      amount: amount || 0,
      stp_amount: stp_amount || null,
      stp_original_amount: stp_original_amount || null,
      switch_value: switch_value || null,
      period_installments: period_installments || null,
      stp_base: stp_base || null,
      scheme_code: scheme_code || source_scheme_code || null,
      source_scheme_code: source_scheme_code || scheme_code || null,
      target_scheme_code: target_scheme_code || null,
      switch_from_scheme_code: switch_from_scheme_code || source_scheme_code || null,
      switch_to_scheme_code: switch_to_scheme_code || target_scheme_code || null,
      stp_target_scheme_code: stp_target_scheme_code || target_scheme_code || null,
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
      stp_base = 'corpus',
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
      cc_type: ['flat', 'scheme', 'scheme_differential', 'differential_subtraction', 'percentage'].includes(cc_type) ? cc_type : 'percentage',
      cc_value: Number(cc_value) || 0,
      si_type: ['flat', 'scheme', 'scheme_differential', 'differential_subtraction', 'percentage'].includes(si_type) ? si_type : 'percentage',
      si_value: Number(si_value) || 0,
      stp_base: ['corpus', 'installment', 'tenure_total'].includes(stp_base) ? stp_base : 'corpus',
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
    if (updates.cc_type !== undefined) updates.cc_type = ['flat', 'scheme', 'scheme_differential', 'differential_subtraction', 'percentage'].includes(updates.cc_type) ? updates.cc_type : 'percentage'
    if (updates.si_type !== undefined) updates.si_type = ['flat', 'scheme', 'scheme_differential', 'differential_subtraction', 'percentage'].includes(updates.si_type) ? updates.si_type : 'percentage'
    if (updates.cc_value !== undefined) updates.cc_value = Number(updates.cc_value) || 0
    if (updates.si_value !== undefined) updates.si_value = Number(updates.si_value) || 0
    if (updates.stp_base !== undefined) updates.stp_base = ['corpus', 'installment', 'tenure_total'].includes(updates.stp_base) ? updates.stp_base : 'corpus'
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
      let baseCC = evaluation.cc_amount
      let baseSI = evaluation.si_amount
      let ruleId = evaluation.rule_id
      let ruleLabel = evaluation.rule_label

      const cat = String(receipt.product_category || receipt.product?.category || '').toUpperCase()
      const invAmt = evaluation.amount_used || 0
      if (baseCC === 0 && baseSI === 0 && invAmt > 0) {
        if (cat === 'BOND' || cat === 'NCD') {
          const issuerKey = receipt.bond_issuer_key || receipt.product_details?.bond?.issuer?.key
          const schemeId = receipt.bond_scheme_id || receipt.product_details?.bond?.product?.id
          const schemeName = receipt.bond_scheme_name || receipt.product_details?.bond?.product?.name
          try {
            let issuers = []
            if (issuerKey) {
              issuers = await q(`FOR issuer IN ncd_bond_issuers FILTER issuer._key == @k LIMIT 1 RETURN issuer`, { k: issuerKey })
            } else {
              issuers = await q(`FOR issuer IN ncd_bond_issuers FILTER (issuer.schemes != null AND (issuer.schemes[*].scheme_id ANY == @id OR issuer.schemes[*].scheme_name ANY == @name)) LIMIT 1 RETURN issuer`, { id: schemeId || '', name: schemeName || '' })
            }
            if (issuers.length > 0) {
              const scheme = (issuers[0].schemes || []).find(s => (schemeId && String(s.scheme_id) === String(schemeId)) || (schemeName && (s.scheme_name === schemeName || s.description_short === schemeName)))
              if (scheme) {
                const ccPct = parseFloat(scheme.cc || 0)
                const siPct = parseFloat(scheme.si || 0)
                if (!Number.isNaN(ccPct) && ccPct !== 0) baseCC = Math.round(((ccPct / 100) * invAmt) * 100) / 100
                if (!Number.isNaN(siPct) && siPct !== 0) baseSI = Math.round(((siPct / 100) * invAmt) * 100) / 100
                if (ccPct > 0 || siPct > 0) ruleLabel = `Bond Scheme: ${scheme.scheme_name || scheme.scheme_id} (${ccPct}% CC, ${siPct}% SI)`
              }
            }
          } catch (e) {}
        }
      }

      const additionalCC = Number(receipt.additional_cc) || 0
      const additionalSI = Number(receipt.additional_si) || 0

      const updates = {
        cc_amount: baseCC,
        si_amount: baseSI,
        total_cc: baseCC + additionalCC,
        total_si: baseSI + additionalSI,
        cc_si_rule_id: ruleId,
        cc_si_rule_label: ruleLabel,
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

/**
 * POST /api/cc-si-rules/bulk-import
 * Bulk import CC & SI rules with optional replace_all
 */
router.post('/bulk-import', requireAuth, async (req, res) => {
  try {
    await ensureCollection('cc_si_rules')
    const rulesColl = getCollection('cc_si_rules')
    const { rules, replace_all = false } = req.body

    if (!Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({ error: 'invalid_data', detail: 'Rules array is required and cannot be empty' })
    }

    if (replace_all) {
      await q(`
        FOR rule IN cc_si_rules
        REMOVE rule IN cc_si_rules
      `)
    }

    let importedCount = 0
    let updatedCount = 0

    for (const item of rules) {
      const category = String(item.category || 'MF').trim().toUpperCase()
      const txn_type = String(item.txn_type || '*').trim().toUpperCase()
      const cc_type = ['percentage', 'flat', 'scheme', 'scheme_differential', 'differential_subtraction'].includes(item.cc_type) ? item.cc_type : 'percentage'
      const cc_value = Number(item.cc_value) || 0
      const si_type = ['percentage', 'flat', 'scheme', 'scheme_differential', 'differential_subtraction'].includes(item.si_type) ? item.si_type : 'percentage'
      const si_value = Number(item.si_value) || 0
      const stp_base = ['corpus', 'installment', 'tenure_total'].includes(item.stp_base) ? item.stp_base : 'corpus'
      const min_amount = Number(item.min_amount) || 0
      const max_amount = item.max_amount !== undefined && item.max_amount !== null && item.max_amount !== '' ? Number(item.max_amount) : null
      const is_active = item.is_active !== false && item.is_active !== 'false' && item.is_active !== 0
      const description = String(item.description || '').trim()

      const ruleDoc = {
        category,
        txn_type,
        cc_type,
        cc_value,
        si_type,
        si_value,
        stp_base,
        min_amount,
        max_amount,
        is_active,
        description,
        imported_at: new Date().toISOString(),
        imported_by: req.user?.username || 'admin',
        updated_at: new Date().toISOString()
      }

      if (!replace_all && item._key) {
        try {
          await rulesColl.update(item._key, ruleDoc)
          updatedCount++
          continue
        } catch {
          // Fall through to search or insert
        }
      }

      // Check if existing rule with same category, txn_type, and min_amount exists
      const existing = await q(`
        FOR r IN cc_si_rules
        FILTER UPPER(r.category) == @category AND UPPER(r.txn_type) == @txn_type AND r.min_amount == @min_amount
        LIMIT 1
        RETURN r
      `, { category, txn_type, min_amount })

      if (!replace_all && existing.length > 0) {
        await rulesColl.update(existing[0]._key, ruleDoc)
        updatedCount++
      } else {
        ruleDoc.created_at = new Date().toISOString()
        await rulesColl.save(ruleDoc)
        importedCount++
      }
    }

    res.json({
      success: true,
      message: `Bulk import finished: ${importedCount} created, ${updatedCount} updated.`,
      imported_count: importedCount,
      updated_count: updatedCount,
      total_processed: rules.length
    })
  } catch (error) {
    console.error('Error in bulk import CC/SI rules:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
