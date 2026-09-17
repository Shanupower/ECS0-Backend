import { q, ensureCollection } from '../config/database.js'
import { getEffectiveCategory } from '../utils/receipt-category.js'

/**
 * Normalizes transaction type string to standard uppercase format (e.g. 'SIP', 'LUMPSUM', 'STP', 'SWP', 'FRESH', 'RENEWAL')
 */
export function normalizeTxnType(rawType, receipt) {
  let type = String(rawType || '').trim().toUpperCase()
  if (!type && receipt) {
    if (receipt.sip_frequency || receipt.sip_start_date || receipt.sip_amount) {
      type = 'SIP'
    } else if (receipt.transaction_type) {
      type = String(receipt.transaction_type).trim().toUpperCase()
    } else if (receipt.investment_type) {
      type = String(receipt.investment_type).trim().toUpperCase()
    }
  }
  return type || 'LUMPSUM'
}

/**
 * Extract numerical investment amount from receipt object
 */
export function extractInvestmentAmount(receipt) {
  if (receipt == null) return 0
  const candidate = 
    receipt.amount ?? 
    receipt.investment_amount ?? 
    receipt.total_amount ?? 
    receipt.sip_amount ??
    receipt.financial_details?.investment_amount ??
    receipt.product_details?.fd?.deposit_amount ??
    0
  return Math.max(0, Number(candidate) || 0)
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
  const targetTxnType = String(txnType || '').trim().toUpperCase()
  const reqAmount = Number(amount) || 0
  const reqDate = date ? new Date(date) : new Date()

  let bestRule = null
  let highestScore = -1

  for (const rule of rules) {
    if (rule.is_active === false) continue

    const ruleCategory = String(rule.category || '*').trim().toUpperCase()
    const ruleTxnType = String(rule.txn_type || '*').trim().toUpperCase()

    // 1. Check Category Match
    const mfSubCats = ['SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']
    const isExactCatMatch = ruleCategory === targetCategory
    const isMfFallbackMatch = ruleCategory === 'MF' && mfSubCats.includes(targetCategory)
    const isWildcardCatMatch = ruleCategory === '*'

    const isCategoryMatch = isExactCatMatch || isMfFallbackMatch || isWildcardCatMatch
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
    else if (isMfFallbackMatch) score += 150
    else if (isWildcardCatMatch) score += 100

    if (ruleTxnType === targetTxnType && targetTxnType !== '') score += 40
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
export function calculateFromRule(amount, rule) {
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
  if (rule.cc_type === 'flat') {
    cc_amount = Number(rule.cc_value) || 0
  } else {
    // default percentage
    cc_amount = (invAmount * (Number(rule.cc_value) || 0)) / 100
  }

  let si_amount = 0
  if (rule.si_type === 'flat') {
    si_amount = Number(rule.si_value) || 0
  } else {
    // default percentage
    si_amount = (invAmount * (Number(rule.si_value) || 0)) / 100
  }

  // Round to 2 decimal places
  cc_amount = Math.round(cc_amount * 100) / 100
  si_amount = Math.round(si_amount * 100) / 100

  const ruleLabel = `${rule.category || 'All'} / ${rule.txn_type || 'All'} (${rule.cc_type === 'flat' ? '₹' : ''}${rule.cc_value}${rule.cc_type === 'flat' ? '' : '%'} CC, ${rule.si_type === 'flat' ? '₹' : ''}${rule.si_value}${rule.si_type === 'flat' ? '' : '%'} SI)`

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
  const amount = extractInvestmentAmount(receipt)
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

  let matchedRule = matchRule(rules, { category, txnType, amount, date })

  const result = calculateFromRule(amount, matchedRule)

  return {
    ...result,
    category_used: category,
    txn_type_used: txnType,
    amount_used: amount
  }
}

