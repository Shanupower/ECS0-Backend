import { q, ensureCollection } from '../config/database.js'
import { getEffectiveCategory } from '../utils/receipt-category.js'

/**
 * Canonical transaction type mapper
 */
export function canonicalizeTxnType(raw) {
  if (!raw) return ''
  const s = String(raw).trim()
  const lower = s.toLowerCase()
  const upper = s.toUpperCase()

  if (lower === 'switch over' || lower === 'switchover' || lower === 'switch_over' || lower === 'switch-over' || upper === 'SWITCH_OVER' || upper === 'SWITCH OVER') {
    return 'SWITCH_OVER'
  }
  if (lower === 'stp' || lower === 'systematic transfer plan' || upper === 'STP') {
    return 'STP'
  }
  if (lower === 'swp' || lower === 'systematic withdrawal plan' || upper === 'SWP') {
    return 'SWP'
  }
  if (lower === 'sip' || lower === 'systematic investment plan' || upper === 'SIP') {
    return 'SIP'
  }
  if (lower === 'lumpsum' || lower === 'lump sum' || lower === 'lump_sum' || upper === 'LUMPSUM' || upper === 'LUMP SUM') {
    return 'LUMPSUM'
  }
  if (lower === 'fresh' || upper === 'FRESH') {
    return 'FRESH'
  }
  if (lower === 'renewal' || upper === 'RENEWAL') {
    return 'RENEWAL'
  }
  if (lower === 'secondary' || lower === 'secondary market' || upper === 'SECONDARY') {
    return 'SECONDARY'
  }
  if (lower === 'one_time' || lower === 'one-time' || lower === 'one time' || upper === 'ONE_TIME') {
    return 'ONE_TIME'
  }
  if (s === '*') return '*'

  return upper.replace(/\s+/g, '_')
}

/**
 * Normalizes transaction type string to standard uppercase format (e.g. 'SIP', 'LUMPSUM', 'STP', 'SWP', 'SWITCH_OVER', 'FRESH', 'RENEWAL')
 */
export function normalizeTxnType(rawType, receipt) {
  let canonical = canonicalizeTxnType(rawType)
  if (canonical && canonical !== '*') {
    return canonical
  }

  // Auto-detect from receipt metadata if not explicitly provided or wildcard
  if (receipt) {
    // Check Switch Over
    if (
      receipt.transaction?.switch_over ||
      receipt.transaction?.type === 'Switch Over' ||
      receipt.transaction_type === 'Switch Over' ||
      receipt.txn_type === 'Switch Over' ||
      receipt.mode === 'Switch Over' ||
      receipt.switch_from_scheme_code ||
      receipt.switch_from_scheme_name ||
      receipt.switch_to_scheme_code ||
      receipt.switch_to_scheme_name
    ) {
      return 'SWITCH_OVER'
    }

    // Check STP
    if (
      receipt.transaction?.stp ||
      receipt.stp_frequency ||
      receipt.stp_start_date ||
      receipt.stp_amount ||
      receipt.stp_original_amount ||
      receipt.stp_target_scheme_code ||
      receipt.stp_target_scheme_name
    ) {
      return 'STP'
    }

    // Check SWP
    if (
      receipt.transaction?.swp ||
      receipt.swp_frequency ||
      receipt.swp_start_date ||
      receipt.swp_amount
    ) {
      return 'SWP'
    }

    // Check SIP
    if (
      receipt.sip_frequency ||
      receipt.sip_start_date ||
      receipt.sip_amount ||
      receipt.transaction?.sip
    ) {
      return 'SIP'
    }

    if (receipt.transaction_type) {
      return canonicalizeTxnType(receipt.transaction_type) || 'LUMPSUM'
    }
    if (receipt.investment_type) {
      return canonicalizeTxnType(receipt.investment_type) || 'LUMPSUM'
    }
    if (receipt.mode) {
      return canonicalizeTxnType(receipt.mode) || 'LUMPSUM'
    }
  }

  return canonical || 'LUMPSUM'
}

/**
 * Extract numerical investment amount from receipt object
 * Appropriately supports STP corpus / installment amounts, STP base rules, and Switch values
 */
export function extractInvestmentAmount(receipt, rule = null) {
  if (receipt == null) return 0

  const stpBase = rule?.stp_base || receipt.stp_base || 'corpus'

  if (stpBase === 'installment') {
    const inst = Number(receipt.stp_amount ?? receipt.transaction?.stp?.amount ?? 0)
    if (inst > 0) return inst
  } else if (stpBase === 'tenure_total') {
    const inst = Number(receipt.stp_amount ?? receipt.transaction?.stp?.amount ?? 0)
    const count = Number(receipt.period_installments ?? receipt.sip_stp_swp_period ?? receipt.period ?? 1) || 1
    if (inst > 0) return inst * count
  }

  // Check candidates in order of priority based on positive numeric value
  const candidates = [
    receipt.stp_original_amount,
    receipt.transaction?.stp?.original_amount,
    receipt.switch_value,
    receipt.transaction?.switch_over?.value,
    receipt.switch_amount,
    receipt.amount,
    receipt.investment_amount,
    receipt.investmentAmount,
    receipt.total_amount,
    receipt.stp_amount,
    receipt.transaction?.stp?.amount,
    receipt.sip_amount,
    receipt.service_price,
    receipt.servicePrice,
    receipt.financial_details?.investment_amount,
    receipt.product_details?.fd?.deposit_amount,
    receipt.fd_deposit_amount,
    receipt.bond_investment_amount,
    receipt.bondInvestmentAmount,
    receipt.product_details?.bond?.transaction?.amount,
    receipt.product_details?.bond?.investment_amount
  ]

  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') {
      const num = Number(c)
      if (!isNaN(num) && num > 0) return num
    }
  }

  return 0
}

/**
 * Fetch all active CC/SI rules from database
 */
export async function getAllActiveRules() {
  try {
    await ensureCollection('cc_si_rules')
    const rules = await q(`
      FOR rule IN cc_si_rules
      FILTER rule.is_active != false
      RETURN rule
    `)
    return rules || []
  } catch (err) {
    console.warn('Could not fetch cc_si_rules:', err.message)
    return []
  }
}

/**
 * Find highest specificity matching rule for given criteria
 */
export function matchRule(rules, { category, txnType, amount = 0, date = null }) {
  if (!Array.isArray(rules) || rules.length === 0) return null

  const targetCategory = String(category || '').trim().toUpperCase()
  const targetTxnType = canonicalizeTxnType(txnType)
  const reqAmount = Number(amount) || 0
  const reqDate = date ? new Date(date) : new Date()

  let bestRule = null
  let highestScore = -1

  for (const rule of rules) {
    if (rule.is_active === false) continue

    const ruleCategory = String(rule.category || '*').trim().toUpperCase()
    const ruleTxnType = canonicalizeTxnType(rule.txn_type || '*')

    // 1. Check Category Match
    const mfSubCats = ['SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']
    const insSubCats = ['INS_LIFE', 'INS_HEALTH', 'INS_GENERAL', 'LIFE', 'HEALTH', 'GENERAL']
    const isExactCatMatch = ruleCategory === targetCategory
    const isMfFallbackMatch = ruleCategory === 'MF' && mfSubCats.includes(targetCategory)
    const isInsFallbackMatch = (ruleCategory === 'INS' || ruleCategory === 'INSURANCE') && insSubCats.includes(targetCategory)
    const isWildcardCatMatch = ruleCategory === '*'

    const isCategoryMatch = isExactCatMatch || isMfFallbackMatch || isInsFallbackMatch || isWildcardCatMatch
    if (!isCategoryMatch) continue

    // 2. Check TxnType Match
    const isTxnTypeMatch = ruleTxnType === '*' || ruleTxnType === '' || ruleTxnType === targetTxnType
    if (!isTxnTypeMatch) continue

    // 3. Check Amount Range Match
    const minAmt = rule.min_amount != null ? Number(rule.min_amount) : 0
    const maxAmt = rule.max_amount != null && rule.max_amount !== '' ? Number(rule.max_amount) : Infinity
    if (reqAmount < minAmt || reqAmount > maxAmt) continue

    // 4. Check Date Range Match
    if (rule.effective_from) {
      const fromDate = new Date(rule.effective_from)
      if (reqDate < fromDate) continue
    }
    if (rule.effective_to) {
      const toDate = new Date(rule.effective_to)
      if (reqDate > toDate) continue
    }

    // 5. Calculate Match Score (Specificity)
    let score = 0
    if (isExactCatMatch && targetCategory !== '') score += 200
    else if (isMfFallbackMatch || isInsFallbackMatch) score += 150
    else if (isWildcardCatMatch) score += 100

    if (ruleTxnType === targetTxnType && targetTxnType !== '*' && targetTxnType !== '') score += 40
    else if (ruleTxnType === '*' || ruleTxnType === '') score += 10

    // Tie-breaker: higher min_amount indicates a more specific slab
    score += Math.min(minAmt / 100000, 5)

    if (score > highestScore) {
      highestScore = score
      bestRule = rule
    }
  }

  return bestRule
}

/**
 * Calculate CC & SI monetary values from a matched rule and investment amount
 */
export function calculateFromRule(amount, rule, schemeOverrides = {}) {
  const invAmount = Math.max(0, Number(amount) || 0)
  if (!rule) {
    return {
      cc_amount: 0,
      si_amount: 0,
      rule_id: null,
      rule_label: 'No matching rule'
    }
  }

  let cc_amount = 0
  let ccDisplay = ''
  if (rule.cc_type === 'flat') {
    cc_amount = Number(rule.cc_value) || 0
    ccDisplay = `₹${rule.cc_value}`
  } else if (rule.cc_type === 'scheme_differential' || rule.cc_type === 'differential_subtraction') {
    const netPct = schemeOverrides.netCcPct != null ? Math.round(schemeOverrides.netCcPct * 10000) / 10000 : 0
    cc_amount = (invAmount * netPct) / 100
    const tgtDisplay = schemeOverrides.targetCcPct != null ? `${Math.round(schemeOverrides.targetCcPct * 10000) / 10000}%` : '0%'
    const srcDisplay = schemeOverrides.sourceCcPct != null ? `${Math.round(schemeOverrides.sourceCcPct * 10000) / 10000}%` : '0%'
    ccDisplay = `Diff: ${tgtDisplay} - ${srcDisplay} = ${netPct}% (Floor 0)`
  } else if (rule.cc_type === 'scheme') {
    const pct = schemeOverrides.schemeCcPct != null ? schemeOverrides.schemeCcPct : Number(rule.cc_value) || 0
    cc_amount = (invAmount * pct) / 100
    ccDisplay = `${pct}% (Target Scheme)`
  } else {
    // default percentage
    cc_amount = (invAmount * (Number(rule.cc_value) || 0)) / 100
    ccDisplay = `${rule.cc_value}%`
  }

  let si_amount = 0
  let siDisplay = ''
  if (rule.si_type === 'flat') {
    si_amount = Number(rule.si_value) || 0
    siDisplay = `₹${rule.si_value}`
  } else if (rule.si_type === 'scheme_differential' || rule.si_type === 'differential_subtraction') {
    const netPct = schemeOverrides.netSiPct != null ? Math.round(schemeOverrides.netSiPct * 10000) / 10000 : 0
    si_amount = (invAmount * netPct) / 100
    const tgtDisplay = schemeOverrides.targetSiPct != null ? `${Math.round(schemeOverrides.targetSiPct * 10000) / 10000}%` : '0%'
    const srcDisplay = schemeOverrides.sourceSiPct != null ? `${Math.round(schemeOverrides.sourceSiPct * 10000) / 10000}%` : '0%'
    siDisplay = `Diff: ${tgtDisplay} - ${srcDisplay} = ${netPct}% (Floor 0)`
  } else if (rule.si_type === 'scheme') {
    const pct = schemeOverrides.schemeSiPct != null ? schemeOverrides.schemeSiPct : Number(rule.si_value) || 0
    si_amount = (invAmount * pct) / 100
    siDisplay = `${pct}% (Target Scheme)`
  } else {
    // default percentage
    si_amount = (invAmount * (Number(rule.si_value) || 0)) / 100
    siDisplay = `${rule.si_value}%`
  }

  // Round to 2 decimal places
  cc_amount = Math.round(cc_amount * 100) / 100
  si_amount = Math.round(si_amount * 100) / 100

  const ruleLabel = `${rule.category || 'All'} / ${rule.txn_type || 'All'} (${ccDisplay} CC, ${siDisplay} SI)`

  return {
    cc_amount,
    si_amount,
    rule_id: rule._key || rule._id || null,
    rule_label: ruleLabel,
    rule
  }
}

/**
 * Convenience function: Given a receipt object or payload, load rules and compute CC & SI
 */
export async function evaluateReceiptCCSI(receipt, preloadedRules = null) {
  const rules = preloadedRules || await getAllActiveRules()
  const category = getEffectiveCategory(receipt) || receipt.product_category || receipt.category || 'MF'
  const txnType = normalizeTxnType(receipt.txn_type || receipt.transaction_type || receipt.investment_type, receipt)
  const initialAmount = extractInvestmentAmount(receipt)
  const date = 
    receipt.payment?.transaction_date || 
    receipt.onlineTransactionDate || 
    receipt.othersTransactionDate || 
    receipt.chequeDate || 
    receipt.instrumentDate || 
    receipt.txn_date || 
    receipt.transaction_date || 
    receipt.sip_start_date || 
    receipt.fd_deposit_date || 
    receipt.date || 
    receipt.created_at || 
    new Date().toISOString()

  let matchedRule = matchRule(rules, { category, txnType, amount: initialAmount, date })
  const finalAmount = extractInvestmentAmount(receipt, matchedRule)

  let schemeOverrides = {}
  if (matchedRule) {
    const isDifferential = matchedRule.cc_type === 'scheme_differential' || 
                           matchedRule.cc_type === 'differential_subtraction' ||
                           matchedRule.si_type === 'scheme_differential' ||
                           matchedRule.si_type === 'differential_subtraction'

    if (isDifferential) {
      const targetSchemeCode = receipt.stp_target_scheme_code || 
                               receipt.switch_to_scheme_code || 
                               receipt.transaction?.switch_over?.to_scheme_code ||
                               receipt.transaction?.stp?.to_scheme_code ||
                               receipt.target_scheme_code || 
                               null
      const targetSchemeName = receipt.stp_target_scheme_name || 
                               receipt.switch_to_scheme_name || 
                               receipt.transaction?.switch_over?.to_scheme_name ||
                               receipt.transaction?.stp?.to_scheme_name ||
                               receipt.target_scheme_name || 
                               null

      const sourceSchemeCode = receipt.switch_from_scheme_code || 
                               receipt.transaction?.switch_over?.from_scheme_code ||
                               receipt.source_scheme_code || 
                               receipt.scheme_code || 
                               null
      const sourceSchemeName = receipt.switch_from_scheme_name || 
                               receipt.transaction?.switch_over?.from_scheme_name ||
                               receipt.source_scheme_name || 
                               receipt.scheme_name || 
                               null

      const codes = [targetSchemeCode, sourceSchemeCode].filter(Boolean).map(String)
      const names = [targetSchemeName, sourceSchemeName].filter(Boolean).map(String)
      const lowerNames = names.map(n => n.toLowerCase())

      let schemeMap = {}
      if (codes.length > 0 || names.length > 0) {
        try {
          const rows = await q(`
            FOR s IN mf_schemes
            FILTER s.scheme_code IN @codes 
               OR s.scheme_name IN @names 
               OR LOWER(s.scheme_name) IN @lowerNames
            RETURN { 
              scheme_code: s.scheme_code, 
              cc: s.cc, 
              si: s.si, 
              name: s.scheme_name 
            }
          `, { codes, names, lowerNames })

          for (const row of rows) {
            if (row.scheme_code) {
              schemeMap[String(row.scheme_code)] = row
              schemeMap[String(row.scheme_code).toLowerCase()] = row
            }
            if (row.name) {
              schemeMap[String(row.name)] = row
              schemeMap[String(row.name).toLowerCase()] = row
            }
          }
        } catch (err) {
          console.warn('Could not fetch scheme CC/SI for differential rule:', err.message)
        }
      }

      const findScheme = (code, name) => {
        if (code && schemeMap[String(code)]) return schemeMap[String(code)]
        if (code && schemeMap[String(code).toLowerCase()]) return schemeMap[String(code).toLowerCase()]
        if (name && schemeMap[String(name)]) return schemeMap[String(name)]
        if (name && schemeMap[String(name).toLowerCase()]) return schemeMap[String(name).toLowerCase()]
        return null
      }

      // Target Scheme: if missing in DB, consider 0% CC (not 100%)
      const targetRow = findScheme(targetSchemeCode, targetSchemeName)
      const targetCcPct = targetRow && targetRow.cc != null ? parseFloat(targetRow.cc) : 0
      const targetSiPct = targetRow && targetRow.si != null ? parseFloat(targetRow.si) : 0

      // Source Scheme: if missing in DB, consider 0% CC
      const sourceRow = findScheme(sourceSchemeCode, sourceSchemeName)
      const sourceCcPct = sourceRow && sourceRow.cc != null ? parseFloat(sourceRow.cc) : 0
      const sourceSiPct = sourceRow && sourceRow.si != null ? parseFloat(sourceRow.si) : 0

      // Strict Floor at 0% (never negative)
      const netCcPct = Math.max(0, targetCcPct - sourceCcPct)
      const netSiPct = Math.max(0, targetSiPct - sourceSiPct)

      schemeOverrides.targetCcPct = targetCcPct
      schemeOverrides.sourceCcPct = sourceCcPct
      schemeOverrides.netCcPct = netCcPct
      schemeOverrides.targetSiPct = targetSiPct
      schemeOverrides.sourceSiPct = sourceSiPct
      schemeOverrides.netSiPct = netSiPct
    } else if (matchedRule.cc_type === 'scheme' || matchedRule.si_type === 'scheme') {
      const targetSchemeCode = receipt.stp_target_scheme_code || 
                               receipt.switch_to_scheme_code || 
                               receipt.transaction?.switch_over?.to_scheme_code ||
                               receipt.scheme_code || 
                               null
      const targetSchemeName = receipt.stp_target_scheme_name || 
                               receipt.switch_to_scheme_name || 
                               receipt.transaction?.switch_over?.to_scheme_name ||
                               receipt.scheme_name || 
                               null
      const codes = [targetSchemeCode].filter(Boolean).map(String)
      const names = [targetSchemeName].filter(Boolean).map(String)
      const lowerNames = names.map(n => n.toLowerCase())

      if (category === 'BOND' || category === 'NCD') {
        const bondSchemeId = receipt.bond_scheme_id || receipt.scheme_id || receipt.product_details?.bond?.product?.id || null
        const bondSchemeName = receipt.bond_scheme_name || receipt.scheme_name || receipt.product_details?.bond?.product?.name || null
        const bondIssuerKey = receipt.bond_issuer_key || receipt.issuer_key || receipt.product_details?.bond?.issuer?.key || null
        try {
          let issuers = []
          if (bondIssuerKey) {
            issuers = await q(`FOR issuer IN ncd_bond_issuers FILTER issuer._key == @k LIMIT 1 RETURN issuer`, { k: bondIssuerKey })
          } else {
            issuers = await q(`FOR issuer IN ncd_bond_issuers FILTER (issuer.schemes != null AND (issuer.schemes[*].scheme_id ANY == @id OR issuer.schemes[*].scheme_name ANY == @name)) LIMIT 1 RETURN issuer`, { id: bondSchemeId || '', name: bondSchemeName || '' })
          }
          if (issuers.length > 0) {
            const scheme = (issuers[0].schemes || []).find(s => (bondSchemeId && String(s.scheme_id) === String(bondSchemeId)) || (bondSchemeName && (s.scheme_name === bondSchemeName || s.description_short === bondSchemeName)))
            if (scheme) {
              schemeOverrides.schemeCcPct = parseFloat(scheme.cc || 0)
              schemeOverrides.schemeSiPct = parseFloat(scheme.si || 0)
            }
          }
        } catch (err) {
          console.warn('Could not fetch NCD/Bond scheme CC/SI for rule:', err.message)
        }
      } else if (codes.length > 0 || names.length > 0) {
        try {
          const rows = await q(`
            FOR s IN mf_schemes
            FILTER s.scheme_code IN @codes 
               OR s.scheme_name IN @names 
               OR LOWER(s.scheme_name) IN @lowerNames
            LIMIT 1
            RETURN { cc: s.cc, si: s.si, name: s.scheme_name }
          `, { codes, names, lowerNames })
          if (rows.length > 0) {
            schemeOverrides.schemeCcPct = parseFloat(rows[0].cc || 0)
            schemeOverrides.schemeSiPct = parseFloat(rows[0].si || 0)
          } else {
            // Missing in DB: treat as 0%
            schemeOverrides.schemeCcPct = 0
            schemeOverrides.schemeSiPct = 0
          }
        } catch (err) {
          console.warn('Could not fetch scheme CC/SI for rule:', err.message)
        }
      }
    }
  }

  const result = calculateFromRule(finalAmount, matchedRule, schemeOverrides)

  return {
    ...result,
    category_used: category,
    txn_type_used: txnType,
    amount_used: finalAmount
  }
}

