import { q } from '../../config/database.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  CATEGORY_AQL,
  MF_SCHEME_CATEGORY_AQL,
  ISSUER_NAME_AQL
} from '../../utils/report-aql-fragments.js'
import { buildReceiptReportFilters } from './report-query-builders.js'

function previousMonthWindow(toIsoDate) {
  const base = toIsoDate && String(toIsoDate).length >= 10
    ? new Date(`${String(toIsoDate).slice(0, 10)}T12:00:00Z`)
    : new Date()
  const y = base.getUTCFullYear()
  const m = base.getUTCMonth()
  const prevLast = new Date(Date.UTC(y, m, 0))
  const prevFirst = new Date(Date.UTC(prevLast.getUTCFullYear(), prevLast.getUTCMonth(), 1))
  return {
    from: prevFirst.toISOString().slice(0, 10),
    to: prevLast.toISOString().slice(0, 10)
  }
}

/**
 * MIS Summary — multi-section aggregates for dashboard MIS PDFs:
 * product summary, MF category summary, issuer/fund sales, previous calendar month totals.
 * @param {object} user
 * @param {object} query - req.query
 */
export async function runMisSummary(user, query) {
  const { filterClause, bindVars } = await buildReceiptReportFilters(user, query, {})

  const productSummaryQuery = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    COLLECT product_type = cat
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    RETURN { product_type, applications, amount, collection_credit, incentive_amount }
  `

  const mfCatQuery = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    FILTER UPPER(TO_STRING(cat)) IN ["MF","SIF","PMS","AIF","GIFT_CITY_FUNDS"]
    LET mf_cat = ${MF_SCHEME_CATEGORY_AQL}
    COLLECT category = mf_cat
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    RETURN { category, applications, amount, collection_credit, incentive_amount }
  `

  const issuerQuery = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    LET issuer_raw = ${ISSUER_NAME_AQL}
    LET issuer = (issuer_raw != null && TO_STRING(issuer_raw) != "") ? TRIM(TO_STRING(issuer_raw)) : "Unknown"
    COLLECT product_type = cat, company_fund_name = issuer
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT product_type ASC, amount DESC
    LIMIT 500
    RETURN { product_type, company_fund_name, applications, amount, collection_credit, incentive_amount }
  `

  const { from: pmFrom, to: pmTo } = previousMonthWindow(query.to)
  const { filterClause: prevFilterClause, bindVars: prevBind } = await buildReceiptReportFilters(
    user,
    { ...query, from: pmFrom, to: pmTo },
    {}
  )

  const prevTotalsQuery = `
    FOR receipt IN receipts
    ${prevFilterClause}
    COLLECT AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    RETURN { applications, amount, collection_credit, incentive_amount, period_from: @from, period_to: @to }
  `

  const [product_summary, mf_category_summary, issuer_sales, prevArr] = await Promise.all([
    q(productSummaryQuery, bindVars),
    q(mfCatQuery, bindVars),
    q(issuerQuery, bindVars),
    q(prevTotalsQuery, prevBind)
  ])

  const previous_month_totals = prevArr[0] || {
    applications: 0,
    amount: 0,
    collection_credit: 0,
    incentive_amount: 0,
    period_from: pmFrom,
    period_to: pmTo
  }

  const maskSi = user?.role !== 'admin'
  const stripSi = (rows) =>
    rows.map((r) => ({
      ...r,
      incentive_amount: maskSi ? null : r.incentive_amount
    }))
  const pm = { ...previous_month_totals }
  if (maskSi) pm.incentive_amount = null

  return {
    product_summary: stripSi(product_summary),
    mf_category_summary: stripSi(mf_category_summary),
    issuer_sales: stripSi(issuer_sales),
    previous_month_totals: pm
  }
}
