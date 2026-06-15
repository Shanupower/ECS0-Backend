import { q } from '../../config/database.js'
import { effectiveDateExprAql } from '../../utils/date-basis.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  BRANCH_CODE_AQL,
  CATEGORY_AQL,
  CLIENT_ADDRESS_AQL,
  FD_DEPOSIT_DATE_AQL,
  MF_SCHEME_CATEGORY_AQL,
  ISSUER_NAME_AQL,
  MIS_PERIOD_AQL,
  SCHEME_NAME_AQL,
  SIP_END_DATE_AQL,
  SIP_IS_PERPETUAL_AQL,
  SIP_START_DATE_AQL
} from '../../utils/report-aql-fragments.js'
import {
  buildReceiptScopeFilter,
  PENDING_RECEIPT_FILTER_AQL,
  RECEIPT_STATUS_BUCKET_AQL
} from './receipt-scope-filter.js'
import {
  appendReceiptContentFilters,
  buildReceiptReportFilters,
  parsePagination,
  canViewServiceIncome
} from './report-query-builders.js'
import { cashFlowBucketForReceipt } from './cashflow-buckets.js'
import { maskServiceIncomeTotals, sumNumericFields } from './report-totals.js'
import {
  computeMisMonthsFromRow,
  computeNextSipDueDateInWindow,
  computeNextSipDueDate,
  dateWindowContains,
  normalizeReportDateBasis,
  resolveSipDisplayEndDate
} from './report-date-helpers.js'

export async function runFundWiseMf(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const exportMode = query.format != null
  const scheme = `((receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name)`
  const aql = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    FILTER UPPER(TO_STRING(cat)) IN ["MF","SIF","PMS","AIF","GIFT_CITY_FUNDS"]
    LET fund = (${scheme})
    COLLECT fund_name = (fund != null && fund != "" ? fund : "Unknown")
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    ${exportMode ? '' : 'LIMIT 500'}
    RETURN { fund_name, applications, amount, collection_credit, incentive_amount }
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

const INVESTOR_ID_AQL = `((receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id)`
const INVESTOR_NAME_AQL = `((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name)`
const PAN_AQL = `((receipt.investor != null && receipt.investor.pan != null) ? receipt.investor.pan : receipt.pan)`
const CLIENT_PHONE_AQL = `((receipt.investor != null && receipt.investor.mobile != null && TO_STRING(receipt.investor.mobile) != "") ? receipt.investor.mobile : receipt.phone)`
const CLIENT_EMAIL_AQL = `((receipt.investor != null && receipt.investor.email != null && TO_STRING(receipt.investor.email) != "") ? receipt.investor.email : receipt.email)`
const STATUS_AQL = RECEIPT_STATUS_BUCKET_AQL
export const MATURITY_DATE_AQL = `(
  (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.maturity != null && receipt.product_details.fd.maturity.date != null)
    ? receipt.product_details.fd.maturity.date
    : (receipt.fd_maturity_date != null && TO_STRING(receipt.fd_maturity_date) != "")
      ? receipt.fd_maturity_date
      : (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.instrument != null && receipt.product_details.bond.instrument.maturity_date != null)
        ? receipt.product_details.bond.instrument.maturity_date
        : (receipt.bond_maturity_date != null && TO_STRING(receipt.bond_maturity_date) != "")
          ? receipt.bond_maturity_date
          : (receipt.product_details != null && receipt.product_details.insurance != null && receipt.product_details.insurance.coverage != null && receipt.product_details.insurance.coverage.maturity_date != null && TO_STRING(receipt.product_details.insurance.coverage.maturity_date) != "")
            ? receipt.product_details.insurance.coverage.maturity_date
            : (receipt.insurance_maturity_date != null && TO_STRING(receipt.insurance_maturity_date) != "")
              ? receipt.insurance_maturity_date
              : (receipt.insurance_renewal_date != null && TO_STRING(receipt.insurance_renewal_date) != "")
                ? receipt.insurance_renewal_date
                : (receipt.product_details != null && receipt.product_details.insurance != null && receipt.product_details.insurance.policy != null && receipt.product_details.insurance.policy.renewal_date != null && TO_STRING(receipt.product_details.insurance.policy.renewal_date) != "")
                  ? receipt.product_details.insurance.policy.renewal_date
                  : (receipt.renewal_due_date != null && TO_STRING(receipt.renewal_due_date) != "")
                    ? receipt.renewal_due_date
                    : null
)`
export const MATURITY_AMOUNT_AQL = `(
  (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.maturity != null && receipt.product_details.fd.maturity.amount != null)
    ? receipt.product_details.fd.maturity.amount
    : receipt.fd_maturity_amount
)`
const FD_IS_CUMULATIVE_AQL = `(
  (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.scheme != null && receipt.product_details.fd.scheme.is_cumulative != null)
    ? receipt.product_details.fd.scheme.is_cumulative
    : receipt.fd_is_cumulative
)`
const FD_PAYOUT_AQL = `(
  (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.payout_frequency != null)
    ? receipt.product_details.fd.deposit.payout_frequency
    : receipt.fd_payout_frequency
)`
const SCHEME_TYPE_AQL = `(
  UPPER(TO_STRING(${CATEGORY_AQL})) IN ["FD","GOVT_FD"]
    ? (${FD_IS_CUMULATIVE_AQL} == true ? "Cumulative" : "Non Cumulative")
    : (UPPER(TO_STRING(${CATEGORY_AQL})) IN ["MF","SIF","PMS","AIF","GIFT_CITY_FUNDS"] ? ${MF_SCHEME_CATEGORY_AQL} : "")
)`

export async function runProductDetailReport(user, query) {
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, query, {})
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })
  const countQ = `RETURN LENGTH(FOR receipt IN receipts ${filterClause} RETURN 1)`
  const dataQ = `
    FOR receipt IN receipts
    ${filterClause}
    SORT ${dateExpr} DESC, receipt._key DESC
    LIMIT @offset, @limit
    RETURN {
      date: ${dateExpr},
      receipt_number: receipt.receipt_no,
      client_id: ${INVESTOR_ID_AQL},
      client_name: ${INVESTOR_NAME_AQL},
      pan: ${PAN_AQL},
      client_phone: ${CLIENT_PHONE_AQL},
      client_email: ${CLIENT_EMAIL_AQL},
      product_category: ${CATEGORY_AQL},
      issuer: ${ISSUER_NAME_AQL},
      scheme_name: ${SCHEME_NAME_AQL},
      period: ${MIS_PERIOD_AQL},
      sip_start_date: ${SIP_START_DATE_AQL},
      sip_end_date: ${SIP_END_DATE_AQL},
      sip_is_perpetual: ${SIP_IS_PERPETUAL_AQL},
      fd_deposit_date: ${FD_DEPOSIT_DATE_AQL},
      fd_maturity_date: ${MATURITY_DATE_AQL},
      amount: ${INV_AMOUNT_AQL},
      collection_credit: ${CC_AQL},
      incentive_amount: ${SI_AQL},
      branch_code: ${BRANCH_CODE_AQL},
      emp_code: receipt.emp_code,
      status: ${STATUS_AQL}
    }
  `
  const totalsQ = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    RETURN { amount, collection_credit, incentive_amount }
  `
  const bind = { ...bindVars, offset, limit: pageSize }
  const [countArr, rows, totalsArr] = await Promise.all([q(countQ, bindVars), q(dataQ, bind), q(totalsQ, bindVars)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  return {
    rows: rows.map((r) => ({
      ...r,
      months: computeMisMonthsFromRow(r),
      incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
    })),
    total: total || 0,
    totals: maskServiceIncomeTotals(user, totalsArr[0] || { amount: 0, collection_credit: 0, incentive_amount: 0 }),
    page,
    page_size: pageSize
  }
}

export async function runCategoryWiseAllProducts(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})
  const aql = `
    FOR receipt IN receipts
    ${filterClause}
    LET category = ${CATEGORY_AQL}
    LET issuer = ${ISSUER_NAME_AQL}
    LET scheme = ${SCHEME_NAME_AQL}
    LET scheme_type = ${SCHEME_TYPE_AQL}
    LET payout_frequency = UPPER(TO_STRING(category)) IN ["FD","GOVT_FD"] ? ${FD_PAYOUT_AQL} : ""
    COLLECT product_category = category,
      issuer_name = (issuer != null && issuer != "" ? issuer : "Unknown"),
      scheme_name = (scheme != null && scheme != "" ? scheme : "Unknown"),
      type = (scheme_type != null ? scheme_type : ""),
      fd_payout_frequency = (payout_frequency != null ? payout_frequency : "")
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT product_category ASC, amount DESC
    RETURN { product_category, issuer_name, scheme_name, type, fd_payout_frequency, applications, amount, collection_credit, incentive_amount }
  `
  const rows = await q(aql, bindVars)
  return rows.map((r) => ({
    ...r,
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  }))
}

export async function runFdMaturityReport(user, query) {
  const dateBasis = normalizeReportDateBasis(query.date_basis || query.dateBasis)
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {
    dateExprOverride: dateBasis === 'fd_maturity' ? MATURITY_DATE_AQL : null
  })
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })
  const maturityFilter = `FILTER mat_date != null && TO_STRING(mat_date) != ""`
  const countQ = `
    RETURN LENGTH(
      FOR receipt IN receipts
      ${filterClause}
      LET mat_date = ${MATURITY_DATE_AQL}
      ${maturityFilter}
      RETURN 1
    )
  `
  const dataQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET mat_date = ${MATURITY_DATE_AQL}
    ${maturityFilter}
    SORT mat_date ASC, receipt._key DESC
    LIMIT @offset, @limit
    RETURN {
      receipt_date: ${effectiveDateExprAql('receipt')},
      maturity_date: mat_date,
      product_category: ${CATEGORY_AQL},
      issuer: ${ISSUER_NAME_AQL},
      scheme_name: ${SCHEME_NAME_AQL},
      period: ${MIS_PERIOD_AQL},
      sip_start_date: ${SIP_START_DATE_AQL},
      sip_end_date: ${SIP_END_DATE_AQL},
      sip_is_perpetual: ${SIP_IS_PERPETUAL_AQL},
      fd_deposit_date: ${FD_DEPOSIT_DATE_AQL},
      maturity_date: mat_date,
      type: ${SCHEME_TYPE_AQL},
      fd_payout_frequency: ${FD_PAYOUT_AQL},
      client_id: ${INVESTOR_ID_AQL},
      client_name: ${INVESTOR_NAME_AQL},
      client_address: ${CLIENT_ADDRESS_AQL},
      amount: ${INV_AMOUNT_AQL},
      maturity_amount: ${MATURITY_AMOUNT_AQL},
      collection_credit: ${CC_AQL},
      incentive_amount: ${SI_AQL},
      branch_code: ${BRANCH_CODE_AQL},
      emp_code: receipt.emp_code,
      receipt_number: receipt.receipt_no,
      status: ${STATUS_AQL}
    }
  `
  const totalsQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET mat_date = ${MATURITY_DATE_AQL}
    ${maturityFilter}
    COLLECT AGGREGATE amount = SUM(${INV_AMOUNT_AQL}),
      maturity_amount = SUM(TO_NUMBER(${MATURITY_AMOUNT_AQL})),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    RETURN { amount, maturity_amount, collection_credit, incentive_amount }
  `
  const bind = { ...bindVars, offset, limit: pageSize }
  const [countArr, rows, totalsArr] = await Promise.all([q(countQ, bindVars), q(dataQ, bind), q(totalsQ, bindVars)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  return {
    rows: rows.map((r) => ({
      ...r,
      months: computeMisMonthsFromRow({ ...r, fd_maturity_date: r.maturity_date }),
      incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
    })),
    total: total || 0,
    totals: maskServiceIncomeTotals(user, totalsArr[0] || {
      amount: 0,
      maturity_amount: 0,
      collection_credit: 0,
      incentive_amount: 0
    }),
    page,
    page_size: pageSize
  }
}

export async function runSipReport(user, query) {
  const dateBasis = normalizeReportDateBasis(query.date_basis || query.dateBasis)
  const usesComputedDate = dateBasis === 'sip_due' || dateBasis === 'sip_end'
  const filterQuery = usesComputedDate ? { ...query, from: '', to: '' } : query
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, filterQuery, {})
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })

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
    SORT ${dateExpr} DESC, receipt._key DESC
    ${usesComputedDate ? '' : 'LIMIT @offset, @limit'}
    RETURN {
      date: ${dateExpr},
      product_category: ${CATEGORY_AQL},
      issuer: ${ISSUER_NAME_AQL},
      client_name: ((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name),
      client_id: ((receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id),
      folio: receipt.folio_policy_no,
      scheme: ((receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name),
      sip_amount: ${INV_AMOUNT_AQL},
      collection_credit: ${CC_AQL},
      incentive_amount: ${SI_AQL},
      frequency: ${SIP_FREQ_AQL},
      period: ${MIS_PERIOD_AQL},
      start_date: ${SIP_START_AQL},
      end_date: ${SIP_END_AQL},
      sip_is_perpetual: ${SIP_IS_PERPETUAL_AQL},
      last_installment_date: (receipt.payment != null && receipt.payment.transaction_date != null ? receipt.payment.transaction_date : receipt.txn_date),
      next_due_date: null,
      status: "Running",
      receipt_id: receipt._key,
      receipt_number: receipt.receipt_no,
      emp_code: receipt.emp_code,
      branch_code: ${BRANCH_CODE_AQL}
    }
  `
  const totalsQ = `
    FOR receipt IN receipts
    ${inner}
    COLLECT AGGREGATE sip_amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    RETURN { sip_amount, collection_credit, incentive_amount }
  `
  const bind = usesComputedDate ? bindVars : { ...bindVars, offset, limit: pageSize }
  const [countArr, rows, totalsArr] = await Promise.all([
    usesComputedDate ? Promise.resolve([0]) : q(countQ, bindVars),
    q(dataQ, bind),
    usesComputedDate ? Promise.resolve([]) : q(totalsQ, bindVars)
  ])
  const asOf = new Date().toISOString().slice(0, 10)
  const enriched = rows.map((r) => {
    const endDate = resolveSipDisplayEndDate(r)
    return {
    ...r,
    end_date: endDate || r.end_date,
    months: computeMisMonthsFromRow({ ...r, end_date: endDate || r.end_date }),
    next_due_date: dateBasis === 'sip_due'
      ? computeNextSipDueDateInWindow(r.start_date, r.frequency, query.from, query.to, asOf, r.end_date)
      : computeNextSipDueDate(r.start_date, r.frequency, asOf, endDate || r.end_date),
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  }
  })
  if (usesComputedDate) {
    const filtered = enriched.filter((r) => {
      const targetDate = dateBasis === 'sip_end' ? r.end_date : r.next_due_date
      return dateWindowContains(targetDate, query.from, query.to)
    })
    const totals = maskServiceIncomeTotals(
      user,
      sumNumericFields(filtered, ['sip_amount', 'collection_credit', 'incentive_amount'])
    )
    return {
      rows: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      totals,
      page,
      page_size: pageSize
    }
  }
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  return {
    rows: enriched,
    total: total || 0,
    totals: maskServiceIncomeTotals(user, totalsArr[0] || {
      sip_amount: 0,
      collection_credit: 0,
      incentive_amount: 0
    }),
    page,
    page_size: pageSize
  }
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
  filterConditions.push(PENDING_RECEIPT_FILTER_AQL)
  appendReceiptContentFilters(filterConditions, bindVars, query)

  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })
  const filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  const countQ = `RETURN LENGTH(FOR receipt IN receipts ${filterClause} RETURN 1)`
  const dataQ = `
    FOR receipt IN receipts
    ${filterClause}
    SORT receipt.created_at DESC
    LIMIT @offset, @limit
    RETURN {
      receipt_id: receipt._key,
      receipt_number: receipt.receipt_no,
      client_name: ((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name),
      product_type: ${CATEGORY_AQL},
      amount: ${INV_AMOUNT_AQL},
      current_stage: receipt.status,
      assigned_to: receipt.emp_code,
      created_at: receipt.created_at,
      status: ${STATUS_AQL}
    }
  `
  const totalsQ = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE amount = SUM(${INV_AMOUNT_AQL})
    RETURN { amount }
  `
  const bind = { ...bindVars, offset, limit: pageSize }
  const today = new Date().toISOString().slice(0, 10)
  const [countArr, rows, totalsArr] = await Promise.all([q(countQ, bindVars), q(dataQ, bind), q(totalsQ, bindVars)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  const withDays = rows.map((r) => {
    const c = r.created_at ? new Date(r.created_at).getTime() : 0
    const days = c ? Math.max(0, Math.floor((Date.now() - c) / 86400000)) : null
    return { ...r, days_pending: days, as_of: today }
  })
  return { rows: withDays, total: total || 0, totals: totalsArr[0] || { amount: 0 }, page, page_size: pageSize }
}

