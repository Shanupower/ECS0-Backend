import { q } from '../../config/database.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  BRANCH_NAME_AQL,
  CATEGORY_AQL,
  ISSUER_NAME_AQL,
  SCHEME_NAME_AQL
} from '../../utils/report-aql-fragments.js'
import {
  buildReceiptReportFilters,
  parsePagination,
  canViewServiceIncome
} from './report-query-builders.js'
import { RECEIPT_STATUS_BUCKET_AQL } from './receipt-scope-filter.js'
import { maskServiceIncomeTotals } from './report-totals.js'

const TXN_TYPE_AQL = `(
  (receipt.transaction != null && receipt.transaction.type != null && receipt.transaction.type != "")
    ? receipt.transaction.type
    : ((receipt.txn_type != null && receipt.txn_type != "") ? receipt.txn_type
    : ((receipt.transaction_type != null && receipt.transaction_type != "") ? receipt.transaction_type : receipt.mode))
)`

const INVESTOR_NAME_AQL = `((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name)`
const PAN_AQL = `((receipt.investor != null && receipt.investor.pan != null) ? receipt.investor.pan : receipt.pan)`
const MOBILE_AQL = `((receipt.investor != null && receipt.investor.mobile != null && TO_STRING(receipt.investor.mobile) != "") ? receipt.investor.mobile : receipt.phone)`
const SCHEME_AQL = `((receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name)`
const PAYMENT_MODE_AQL = `(
  (receipt.payment != null && receipt.payment.mode != null && receipt.payment.mode != "")
    ? receipt.payment.mode
    : ((receipt.payment_mode != null && receipt.payment_mode != "") ? receipt.payment_mode : "Other")
)`

/**
 * Common NFO filter condition:
 * Checks receipt.scheme_is_nfo, product_details.mf.scheme.is_nfo, receipt.is_nfo,
 * or whether the receipt's scheme_code matches an active NFO in mf_schemes.
 */
const NFO_FILTER_CLAUSE = `
  LET nfoSchemeCodes = (
    FOR s IN mf_schemes
    FILTER s.is_nfo == true
    RETURN TO_STRING(s.scheme_code)
  )
  FILTER (
    receipt.scheme_is_nfo == true
    OR (receipt.product_details != null && receipt.product_details.mf != null && receipt.product_details.mf.scheme != null && receipt.product_details.mf.scheme.is_nfo == true)
    OR receipt.is_nfo == true
    OR (receipt.scheme_code != null && TO_STRING(receipt.scheme_code) IN nfoSchemeCodes)
    OR (receipt.scheme_name != null && LIKE(TO_STRING(receipt.scheme_name), "%[NFO]%"))
    OR (receipt.scheme_name != null && LIKE(TO_STRING(receipt.scheme_name), "% NFO %"))
  )
`

/**
 * Runs the NFO Report supporting 3 views:
 * 1. 'summary' / 'fund_summary' (Default): Fund-wise NFO aggregation with scheme master join
 * 2. 'transactions' / 'detail': Paginated line-level detailed receipts
 * 3. 'rm_leaderboard': Mobilization by RM / Employee
 * 4. 'branch_leaderboard': Mobilization by Branch
 */
export async function runNfoReport(user, query) {
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, query, {})
  const viewMode = String(query.view_mode || query.viewMode || query.tab || 'summary').toLowerCase().trim()
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })

  // 1. Overall Executive KPI Totals across all filtered NFO receipts
  const kpiAql = `
    FOR receipt IN receipts
    ${filterClause}
    ${NFO_FILTER_CLAUSE}
    LET scheme = ${SCHEME_AQL}
    LET pan = ${PAN_AQL}
    COLLECT AGGREGATE 
      total_applications = LENGTH(1),
      total_amount = SUM(${INV_AMOUNT_AQL}),
      total_cc = SUM(${CC_AQL}),
      total_si = SUM(${SI_AQL})
    RETURN {
      total_applications: total_applications || 0,
      total_amount: total_amount || 0,
      total_cc: total_cc || 0,
      total_si: total_si || 0
    }
  `

  const uniqueInvestorsAql = `
    FOR receipt IN receipts
    ${filterClause}
    ${NFO_FILTER_CLAUSE}
    LET pan = ${PAN_AQL}
    FILTER pan != null && pan != ""
    COLLECT p = pan
    COLLECT WITH COUNT INTO total_unique_investors
    RETURN total_unique_investors
  `

  const activeNfoCountAql = `
    FOR s IN mf_schemes
    FILTER s.is_nfo == true
    COLLECT WITH COUNT INTO total_active_nfo
    RETURN total_active_nfo
  `

  const [kpiRows, uniqueInvRows, activeNfoRows] = await Promise.all([
    q(kpiAql, bindVars),
    q(uniqueInvestorsAql, bindVars),
    q(activeNfoCountAql, {})
  ])

  const kpis = kpiRows[0] || { total_applications: 0, total_amount: 0, total_cc: 0, total_si: 0 }
  const uniqueInvestors = uniqueInvRows[0] || 0
  const activeNfoCount = activeNfoRows[0] || 0

  const summaryCards = {
    active_nfo_count: activeNfoCount,
    total_applications: kpis.total_applications,
    total_amount: kpis.total_amount,
    unique_investors: uniqueInvestors,
    total_collection_credit: kpis.total_cc,
    total_service_income: canViewServiceIncome(user) ? kpis.total_si : null,
    avg_ticket_size: kpis.total_applications > 0 ? Math.round(kpis.total_amount / kpis.total_applications) : 0
  }

  // 2. View Mode 1: Detailed Line-Level Transactions
  if (viewMode === 'transactions' || viewMode === 'detail') {
    const countAql = `
      FOR receipt IN receipts
      ${filterClause}
      ${NFO_FILTER_CLAUSE}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    const dataAql = `
      FOR receipt IN receipts
      ${filterClause}
      ${NFO_FILTER_CLAUSE}
      SORT ${dateExpr} DESC, receipt._key DESC
      ${exportMode ? '' : 'LIMIT @offset, @limit'}
      RETURN {
        receipt_id: receipt._key,
        receipt_number: receipt.receipt_no || receipt._key,
        date: ${dateExpr},
        investor_name: ${INVESTOR_NAME_AQL},
        pan: ${PAN_AQL},
        mobile: ${MOBILE_AQL},
        issuer: ${ISSUER_NAME_AQL},
        scheme_name: ${SCHEME_AQL},
        transaction_type: ${TXN_TYPE_AQL},
        investment_amount: ${INV_AMOUNT_AQL},
        collection_credit: ${CC_AQL},
        incentive_paid: ${SI_AQL},
        payment_mode: ${PAYMENT_MODE_AQL},
        branch: ${BRANCH_NAME_AQL},
        emp_code: receipt.emp_code,
        rm_name: receipt.rm_name || receipt.created_by || receipt.emp_code || "",
        status: ${RECEIPT_STATUS_BUCKET_AQL}
      }
    `

    const bind = exportMode ? bindVars : { ...bindVars, offset, limit: pageSize }
    const [countArr, rows] = await Promise.all([q(countAql, bindVars), q(dataAql, bind)])
    const total = typeof countArr[0] === 'number' ? countArr[0] : countArr[0]?.total ?? 0

    const maskedRows = rows.map(r => ({
      ...r,
      incentive_paid: canViewServiceIncome(user) ? r.incentive_paid : null
    }))

    return {
      view_mode: 'transactions',
      rows: maskedRows,
      total: total || 0,
      page,
      page_size: pageSize,
      summaryCards,
      totals: {
        investment_amount: kpis.total_amount,
        collection_credit: kpis.total_cc,
        incentive_paid: canViewServiceIncome(user) ? kpis.total_si : null
      }
    }
  }

  // 3. View Mode 2: RM Leaderboard
  if (viewMode === 'rm_leaderboard' || viewMode === 'rm') {
    const rmAql = `
      FOR receipt IN receipts
      ${filterClause}
      ${NFO_FILTER_CLAUSE}
      LET emp = receipt.emp_code || receipt.rm_name || "Unassigned"
      COLLECT rm = emp
      AGGREGATE 
        applications = LENGTH(1),
        amount = SUM(${INV_AMOUNT_AQL}),
        collection_credit = SUM(${CC_AQL}),
        incentive_amount = SUM(${SI_AQL}),
        schemes = UNIQUE(${SCHEME_AQL})
      LET user_doc = FIRST(
        FOR u IN users
        FILTER u.emp_code == rm OR u.username == rm
        LIMIT 1
        RETURN u
      )
      SORT amount DESC
      ${exportMode ? '' : 'LIMIT 500'}
      RETURN {
        rm_code: rm,
        rm_name: user_doc != null && user_doc.name != null ? user_doc.name : (rm != "Unassigned" ? rm : "Unassigned"),
        branch: user_doc != null && user_doc.branch != null ? user_doc.branch : "",
        schemes_count: LENGTH(schemes),
        applications,
        amount,
        collection_credit,
        incentive_amount,
        avg_ticket: applications > 0 ? ROUND(amount / applications) : 0
      }
    `
    const rows = await q(rmAql, bindVars)
    return {
      view_mode: 'rm_leaderboard',
      rows: rows.map(r => ({
        ...r,
        incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
      })),
      total: rows.length,
      totals: {
        applications: kpis.total_applications,
        amount: kpis.total_amount,
        collection_credit: kpis.total_cc,
        incentive_amount: canViewServiceIncome(user) ? kpis.total_si : null
      },
      summaryCards
    }
  }

  // 4. View Mode 3: Branch Leaderboard
  if (viewMode === 'branch_leaderboard' || viewMode === 'branch') {
    const branchAql = `
      FOR receipt IN receipts
      ${filterClause}
      ${NFO_FILTER_CLAUSE}
      LET branch = ${BRANCH_NAME_AQL}
      COLLECT branch_name = (branch != null && branch != "" ? branch : "Unassigned")
      AGGREGATE 
        applications = LENGTH(1),
        amount = SUM(${INV_AMOUNT_AQL}),
        collection_credit = SUM(${CC_AQL}),
        incentive_amount = SUM(${SI_AQL}),
        schemes = UNIQUE(${SCHEME_AQL})
      SORT amount DESC
      ${exportMode ? '' : 'LIMIT 500'}
      RETURN {
        branch_name,
        schemes_count: LENGTH(schemes),
        applications,
        amount,
        collection_credit,
        incentive_amount,
        avg_ticket: applications > 0 ? ROUND(amount / applications) : 0
      }
    `
    const rows = await q(branchAql, bindVars)
    return {
      view_mode: 'branch_leaderboard',
      rows: rows.map(r => ({
        ...r,
        incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
      })),
      total: rows.length,
      totals: {
        applications: kpis.total_applications,
        amount: kpis.total_amount,
        collection_credit: kpis.total_cc,
        incentive_amount: canViewServiceIncome(user) ? kpis.total_si : null
      },
      summaryCards
    }
  }

  // 5. View Mode 4 (Default): Fund-Wise NFO Mobilization Summary
  const fundSummaryAql = `
    FOR receipt IN receipts
    ${filterClause}
    ${NFO_FILTER_CLAUSE}
    LET scheme = ${SCHEME_AQL}
    LET issuer = ${ISSUER_NAME_AQL}
    LET pan = ${PAN_AQL}
    COLLECT 
      fund_name = (scheme != null && scheme != "" ? scheme : "Unknown NFO Scheme"),
      issuer_name = (issuer != null && issuer != "" ? issuer : "Unknown AMC")
    AGGREGATE 
      applications = LENGTH(1),
      amount = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL}),
      unique_investors = UNIQUE(pan)
    
    LET scheme_doc = FIRST(
      FOR s IN mf_schemes
      FILTER s.scheme_name == fund_name OR s.display_name == fund_name
      LIMIT 1
      RETURN { 
        category: s.category, 
        sub_category: s.sub_category,
        nfo_validity: s.nfo_validity, 
        is_nfo: s.is_nfo,
        cc_pct: s.cc,
        si_pct: s.si
      }
    )

    SORT amount DESC
    ${exportMode ? '' : 'LIMIT 500'}
    RETURN {
      fund_name,
      issuer_name,
      category: scheme_doc != null && scheme_doc.category != null ? scheme_doc.category : "Mutual Fund",
      sub_category: scheme_doc != null && scheme_doc.sub_category != null ? scheme_doc.sub_category : "",
      nfo_validity: scheme_doc != null && scheme_doc.nfo_validity != null ? scheme_doc.nfo_validity : null,
      is_active_nfo: scheme_doc != null && scheme_doc.is_nfo == true,
      applications,
      amount,
      unique_investors_count: LENGTH(unique_investors),
      avg_ticket_size: applications > 0 ? ROUND(amount / applications) : 0,
      collection_credit,
      incentive_amount
    }
  `

  const rows = await q(fundSummaryAql, bindVars)
  const maskedRows = rows.map(r => ({
    ...r,
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  }))

  return {
    view_mode: 'summary',
    rows: maskedRows,
    total: maskedRows.length,
    totals: {
      applications: kpis.total_applications,
      amount: kpis.total_amount,
      collection_credit: kpis.total_cc,
      incentive_amount: canViewServiceIncome(user) ? kpis.total_si : null
    },
    summaryCards
  }
}

/**
 * Export Headers for NFO Report
 */
export function nfoReportExportHeaders(viewMode = 'summary') {
  if (viewMode === 'transactions' || viewMode === 'detail') {
    return [
      'Date',
      'Receipt ',
      'Investor Name',
      'PAN',
      'Mobile',
      'AMC',
      'NFO Scheme Name',
      'Transaction Type',
      'Amount (₹)',
      'Collection Credit (₹)',
      'Sales Incentive (₹)',
      'Payment Mode',
      'Branch',
      'RM Name',
      'Status'
    ]
  }

  if (viewMode === 'rm_leaderboard' || viewMode === 'rm') {
    return [
      'RM Name',
      'RM Code',
      'Branch',
      'NFO Schemes Count',
      'Applications Count',
      'Amount (₹)',
      'Collection Credit (₹)',
      'Sales Incentive (₹)'
    ]
  }

  if (viewMode === 'branch_leaderboard' || viewMode === 'branch') {
    return [
      'Branch Name',
      'NFO Schemes Count',
      'Applications Count',
      'Amount (₹)',
      'Collection Credit (₹)',
      'Sales Incentive (₹)'
    ]
  }

  // Summary / Fund-wise
  return [
    'AMC',
    'NFO Scheme Name',
    'Applications',
    'Amount (₹)',
    'Collection Credit (₹)',
    'Sales Incentive (₹)'
  ]
}

/**
 * Export Row to Array for NFO Report
 */
export function nfoReportRowToArray(r, viewMode = 'summary') {
  if (viewMode === 'transactions' || viewMode === 'detail') {
    return [
      r.date ?? '',
      r.receipt_number ?? '',
      r.investor_name ?? '',
      r.pan ?? '',
      r.mobile ?? '',
      r.issuer ?? '',
      r.scheme_name ?? '',
      r.transaction_type ?? '',
      r.investment_amount ?? 0,
      r.collection_credit ?? 0,
      r.incentive_paid ?? '',
      r.payment_mode ?? '',
      r.branch ?? '',
      r.rm_name ?? '',
      r.status ?? ''
    ]
  }

  if (viewMode === 'rm_leaderboard' || viewMode === 'rm') {
    return [
      r.rm_name ?? '',
      r.rm_code ?? '',
      r.branch ?? '',
      r.schemes_count ?? 0,
      r.applications ?? 0,
      r.amount ?? 0,
      r.collection_credit ?? 0,
      r.incentive_amount ?? ''
    ]
  }

  if (viewMode === 'branch_leaderboard' || viewMode === 'branch') {
    return [
      r.branch_name ?? '',
      r.schemes_count ?? 0,
      r.applications ?? 0,
      r.amount ?? 0,
      r.collection_credit ?? 0,
      r.incentive_amount ?? ''
    ]
  }

  return [
    r.issuer_name ?? '',
    r.fund_name ?? '',
    r.applications ?? 0,
    r.amount ?? 0,
    r.collection_credit ?? 0,
    r.incentive_amount ?? ''
  ]
}

/**
 * Runs all 4 NFO report views in parallel for complete multi-table/multi-sheet export
 */
export async function runAllNfoViews(user, query = {}) {
  const exportQuery = { ...query, format: 'export', pageSize: 50000 }
  const [summaryData, rmData, branchData, txnData] = await Promise.all([
    runNfoReport(user, { ...exportQuery, view_mode: 'summary' }),
    runNfoReport(user, { ...exportQuery, view_mode: 'rm_leaderboard' }),
    runNfoReport(user, { ...exportQuery, view_mode: 'branch_leaderboard' }),
    runNfoReport(user, { ...exportQuery, view_mode: 'transactions' })
  ])

  return {
    summaryCards: summaryData.summaryCards,
    sections: [
      {
        title: 'Fund Wise Mobilization',
        sheetName: 'Fund Summary',
        headers: nfoReportExportHeaders('summary'),
        rows: (summaryData.rows || []).map((r) => nfoReportRowToArray(r, 'summary'))
      },
      {
        title: 'RM Leaderboard',
        sheetName: 'RM Leaderboard',
        headers: nfoReportExportHeaders('rm_leaderboard'),
        rows: (rmData.rows || []).map((r) => nfoReportRowToArray(r, 'rm_leaderboard'))
      },
      {
        title: 'Branch Leaderboard',
        sheetName: 'Branch Leaderboard',
        headers: nfoReportExportHeaders('branch_leaderboard'),
        rows: (branchData.rows || []).map((r) => nfoReportRowToArray(r, 'branch_leaderboard'))
      },
      {
        title: 'Detailed Transactions',
        sheetName: 'Transactions',
        headers: nfoReportExportHeaders('transactions'),
        rows: (txnData.rows || []).map((r) => nfoReportRowToArray(r, 'transactions'))
      }
    ]
  }
}
