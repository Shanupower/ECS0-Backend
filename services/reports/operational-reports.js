import { q } from '../../config/database.js'
import { effectiveDateExprAql } from '../../utils/date-basis.js'
import { INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  CATEGORY_AQL,
  MF_SCHEME_CATEGORY_AQL,
  ISSUER_NAME_AQL
} from '../../utils/report-aql-fragments.js'
import { applyReceiptCategoryFilter } from '../../utils/receipt-filters.js'
import { buildReceiptScopeFilter } from './receipt-scope-filter.js'
import { buildReceiptReportFilters, parsePagination, canViewServiceIncome } from './report-query-builders.js'
import { cashFlowBucketForReceipt } from './cashflow-buckets.js'

/** Product-wise sales */
export async function runProductWiseSales(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const aql = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    COLLECT product_type = cat
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    RETURN { product_type, applications, amount, incentive_amount }
  `
  const rows = await q(aql, bindVars)
  return rows.map((r) => ({
    ...r,
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  }))
}

export async function runCategoryWiseMf(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const aql = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    FILTER UPPER(TO_STRING(cat)) IN ["MF","SIF","PMS","AIF","GIFT_CITY_FUNDS"]
    LET mf_cat = ${MF_SCHEME_CATEGORY_AQL}
    COLLECT category = mf_cat
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    RETURN { category, applications, amount, incentive_amount }
  `
  const rows = await q(aql, bindVars)
  return rows.map((r) => ({
    ...r,
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  }))
}

export async function runFundWiseMf(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const scheme = `((receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name)`
  const aql = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    FILTER UPPER(TO_STRING(cat)) IN ["MF","SIF","PMS","AIF","GIFT_CITY_FUNDS"]
    LET fund = (${scheme})
    COLLECT fund_name = (fund != null && fund != "" ? fund : "Unknown")
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    LIMIT 500
    RETURN { fund_name, applications, amount, incentive_amount }
  `
  const rows = await q(aql, bindVars)
  return rows.map((r) => ({
    ...r,
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  }))
}

const SIP_FREQ_AQL = `(
  (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.frequency != null)
    ? receipt.transaction.sip.frequency
    : receipt.sip_frequency
)`
const SIP_START_AQL = `(
  (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.start_date != null)
    ? receipt.transaction.sip.start_date
    : receipt.sip_start_date
)`
const SIP_END_AQL = `(
  (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.end_date != null)
    ? receipt.transaction.sip.end_date
    : receipt.sip_end_date
)`

const SIP_MATCH_AQL = `(
  LIKE(LOWER(TO_STRING(receipt.txn_type)), "sip")
  OR LIKE(LOWER(TO_STRING(receipt.mode)), "sip")
  OR (receipt.transaction != null && receipt.transaction.type != null && LIKE(LOWER(TO_STRING(receipt.transaction.type)), "sip"))
)`

export async function runSipReport(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const { page, pageSize, offset } = parsePagination(query)

  const inner = filterClause.includes('FILTER')
    ? filterClause.replace(/\n$/, '') + ` AND ${SIP_MATCH_AQL}\n`
    : `FILTER ${SIP_MATCH_AQL}\n`

  const countQ = `
    RETURN LENGTH(
      FOR receipt IN receipts
      ${inner}
      RETURN 1
    )
  `
  const dataQ = `
    FOR receipt IN receipts
    ${inner}
    SORT receipt.date DESC
    LIMIT @offset, @limit
    RETURN {
      client_name: ((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name),
      folio: receipt.folio_policy_no,
      scheme: ((receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name),
      sip_amount: ${INV_AMOUNT_AQL},
      frequency: ${SIP_FREQ_AQL},
      start_date: ${SIP_START_AQL},
      end_date: ${SIP_END_AQL},
      last_installment_date: (receipt.payment != null && receipt.payment.transaction_date != null ? receipt.payment.transaction_date : receipt.txn_date),
      next_due_date: null,
      status: "Running",
      receipt_id: receipt._key,
      emp_code: receipt.emp_code
    }
  `
  const bind = { ...bindVars, offset, limit: pageSize }
  const [countArr, rows] = await Promise.all([q(countQ, bindVars), q(dataQ, bind)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  return { rows, total: total || 0, page, page_size: pageSize }
}

export async function runCashFlowReport(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const liteQ = `
    FOR receipt IN receipts
    ${filterClause}
    RETURN {
      product_fund: ${ISSUER_NAME_AQL},
      amount: ${INV_AMOUNT_AQL},
      txn_type: (receipt.transaction != null && receipt.transaction.type != null ? receipt.transaction.type : receipt.txn_type),
      mode: receipt.mode,
      switch_over: (receipt.transaction != null ? receipt.transaction.switch_over : null)
    }
  `
  const raw = await q(liteQ, bindVars)
  const byKey = new Map()
  for (const row of raw) {
    const key = String(row.product_fund || 'Unknown').trim() || 'Unknown'
    const receiptLike = {
      transaction: row.switch_over != null ? { switch_over: row.switch_over } : null
    }
    const bucket = cashFlowBucketForReceipt(receiptLike, row.txn_type || row.mode)
    if (!byKey.has(key)) {
      byKey.set(key, {
        product_fund: key,
        Purchase: 0,
        SIP: 0,
        SwitchIn: 0,
        Redemption: 0,
        SwitchOut: 0,
        Unknown: 0
      })
    }
    const agg = byKey.get(key)
    const amt = Number(row.amount) || 0
    if (Object.prototype.hasOwnProperty.call(agg, bucket)) agg[bucket] += amt
    else agg.Unknown += amt
  }
  const rows = [...byKey.values()].map((r) => {
    const inflow = r.Purchase + r.SIP + r.SwitchIn
    const outflow = r.Redemption + r.SwitchOut
    return {
      product_fund: r.product_fund,
      purchase: r.Purchase,
      sip: r.SIP,
      switch_in: r.SwitchIn,
      redemption: r.Redemption,
      switch_out: r.SwitchOut,
      unknown: r.Unknown,
      net_flow: inflow - outflow
    }
  })
  rows.sort((a, b) => Math.abs(b.net_flow) - Math.abs(a.net_flow))
  return rows
}

export async function runPendingReceiptsReport(user, query) {
  const { filterConditions, bindVars } = await buildReceiptScopeFilter(user, query)
  const dateExpr = effectiveDateExprAql(query.date_basis || query.dateBasis)
  if (query.from) {
    filterConditions.push(`${dateExpr} >= @from`)
    bindVars.from = query.from
  }
  if (query.to) {
    filterConditions.push(`${dateExpr} <= @to`)
    bindVars.to = query.to
  }
  filterConditions.push(
    '(receipt.status == null OR receipt.status == "Pending" OR receipt.status == "Needs Changes" OR receipt.status == "Draft")'
  )
  if (query.search && String(query.search).trim()) {
    const s = String(query.search).trim()
    filterConditions.push(`(
      LIKE(receipt.receipt_no, CONCAT("%", @search, "%"), true)
      OR LIKE(receipt.investor_name, CONCAT("%", @search, "%"), true)
    )`)
    bindVars.search = s
  }
  const cat = query.product_type || query.category || query.product_category
  if (cat) applyReceiptCategoryFilter(filterConditions, bindVars, cat)

  const { page, pageSize, offset } = parsePagination(query)
  const filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  const countQ = `RETURN LENGTH(FOR receipt IN receipts ${filterClause} RETURN 1)`
  const dataQ = `
    FOR receipt IN receipts
    ${filterClause}
    SORT receipt.created_at DESC
    LIMIT @offset, @limit
    RETURN {
      receipt_id: receipt._key,
      client_name: ((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name),
      product_type: ${CATEGORY_AQL},
      amount: ${INV_AMOUNT_AQL},
      current_stage: receipt.status,
      assigned_to: receipt.emp_code,
      created_at: receipt.created_at,
      status: receipt.status
    }
  `
  const bind = { ...bindVars, offset, limit: pageSize }
  const today = new Date().toISOString().slice(0, 10)
  const [countArr, rows] = await Promise.all([q(countQ, bindVars), q(dataQ, bind)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  const withDays = rows.map((r) => {
    const c = r.created_at ? new Date(r.created_at).getTime() : 0
    const days = c ? Math.max(0, Math.floor((Date.now() - c) / 86400000)) : null
    return { ...r, days_pending: days, as_of: today }
  })
  return { rows: withDays, total: total || 0, page, page_size: pageSize }
}

