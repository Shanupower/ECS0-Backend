import { q } from '../../config/database.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  BRANCH_NAME_AQL,
  CATEGORY_AQL,
  FD_DEPOSIT_DATE_AQL,
  FD_TENURE_DISPLAY_AQL,
  ISSUER_NAME_AQL,
  MIS_PERIOD_AQL,
  SIP_END_DATE_AQL,
  SIP_IS_PERPETUAL_AQL,
  SIP_START_DATE_AQL
} from '../../utils/report-aql-fragments.js'
import { MATURITY_DATE_AQL } from './operational-reports.js'
import { buildReceiptReportFilters, parsePagination, canViewServiceIncome } from './report-query-builders.js'
import { RECEIPT_STATUS_BUCKET_AQL } from './receipt-scope-filter.js'
import { computeMisMonthsFromRow } from './report-date-helpers.js'
import { maskServiceIncomeTotals, sumNumericFields } from './report-totals.js'

const TXN_TYPE_AQL = `(
  (receipt.transaction != null && receipt.transaction.type != null && receipt.transaction.type != "")
    ? receipt.transaction.type
    : ((receipt.txn_type != null && receipt.txn_type != "") ? receipt.txn_type
    : ((receipt.transaction_type != null && receipt.transaction_type != "") ? receipt.transaction_type : receipt.mode))
)`

const INVESTOR_NAME_AQL = `((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name)`
const SCHEME_AQL = `((receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name)`
const APP_NO_AQL = `(
  (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.application != null && receipt.product_details.fd.application.number != null)
    ? receipt.product_details.fd.application.number
    : (receipt.fd_application_number != null ? receipt.fd_application_number
    : (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.application != null && receipt.product_details.bond.application.number != null)
    ? receipt.product_details.bond.application.number
    : (receipt.bond_application_number != null ? receipt.bond_application_number
    : receipt.folio_policy_no)))
`

function groupCollectKey(groupBy) {
  switch (groupBy) {
    case 'product':
      return CATEGORY_AQL
    case 'amc':
      return ISSUER_NAME_AQL
    case 'branch':
      return 'receipt.branch'
    case 'rm':
      return 'receipt.emp_code'
    default:
      return null
  }
}

/**
 * Detailed Transaction MIS — paginated rows and optional grouping.
 * Column set aligns with export transaction shape (routes/export.js) and
 * typical MIS detail PDFs: Date, Branch, Receipt #, Investor, Scheme, Period,
 * Months, SIP dates, FD maturity/tenure, Transaction type, amounts, Application #, RM, Product.
 * @returns {Promise<{ rows: object[], total: number, page: number, page_size: number, group_by?: string }>}
 */
export async function runMisTransactions(user, query) {
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, query, {})
  const groupBy = String(query.group_by || query.groupBy || '')
    .toLowerCase()
    .trim()
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })

  const gKey = groupCollectKey(groupBy)
  if (gKey) {
    const groupQuery =
      groupBy === 'rm'
        ? `
          FOR receipt IN receipts
          ${filterClause}
          COLLECT group_key = ${gKey}
          AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
          LET user_doc = FIRST(
            FOR user IN users
              FILTER user.emp_code == group_key
              LIMIT 1
              RETURN user
          )
          SORT amount DESC
          RETURN {
            group_key,
            employee_name: user_doc != null && user_doc.name != null ? user_doc.name : "",
            applications,
            amount,
            collection_credit,
            incentive_amount
          }
        `
        : `
          FOR receipt IN receipts
          ${filterClause}
          COLLECT group_key = ${groupBy === 'branch' ? BRANCH_NAME_AQL : gKey}
          AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
          SORT amount DESC
          RETURN { group_key, applications, amount, collection_credit, incentive_amount }
        `
    const allGroups = await q(groupQuery, bindVars)
    const total = allGroups.length
    const totals = maskServiceIncomeTotals(
      user,
      sumNumericFields(allGroups, ['applications', 'amount', 'collection_credit', 'incentive_amount'])
    )
    const slice = allGroups.slice(offset, offset + pageSize)
    const rows = slice.map((r) => ({
      ...r,
      incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
    }))
    return { rows, total, page, page_size: pageSize, group_by: groupBy, totals }
  }

  const countQuery = `
    RETURN LENGTH(
      FOR receipt IN receipts
      ${filterClause}
      RETURN 1
    )
  `
  const dataQuery = `
    FOR receipt IN receipts
    ${filterClause}
    SORT ${dateExpr} DESC, receipt._key DESC
    LIMIT @offset, @limit
    RETURN {
      date: ${dateExpr},
      branch: ${BRANCH_NAME_AQL},
      receipt_number: receipt.receipt_no,
      receipt_id: receipt._key,
      investor_name: ${INVESTOR_NAME_AQL},
      scheme_name: ${SCHEME_AQL},
      issuer: ${ISSUER_NAME_AQL},
      period: ${MIS_PERIOD_AQL},
      sip_start_date: ${SIP_START_DATE_AQL},
      sip_end_date: ${SIP_END_DATE_AQL},
      sip_is_perpetual: ${SIP_IS_PERPETUAL_AQL},
      fd_deposit_date: ${FD_DEPOSIT_DATE_AQL},
      fd_maturity_date: ${MATURITY_DATE_AQL},
      fd_tenure: ${FD_TENURE_DISPLAY_AQL},
      transaction_type: ${TXN_TYPE_AQL},
      investment_amount: ${INV_AMOUNT_AQL},
      collection_credit: ${CC_AQL},
      incentive_paid: ${SI_AQL},
      application_number: ${APP_NO_AQL},
      emp_code: receipt.emp_code,
      product_category: ${CATEGORY_AQL},
      status: ${RECEIPT_STATUS_BUCKET_AQL}
    }
  `
  const totalsQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE investment_amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_paid = SUM(${SI_AQL})
    RETURN { investment_amount, collection_credit, incentive_paid }
  `
  const bind = { ...bindVars, offset, limit: pageSize }
  const [countArr, rows, totalsArr] = await Promise.all([q(countQuery, bindVars), q(dataQuery, bind), q(totalsQuery, bindVars)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : countArr[0]?.total ?? 0
  const totals = maskServiceIncomeTotals(user, totalsArr[0] || {
    investment_amount: 0,
    collection_credit: 0,
    incentive_paid: 0
  })
  const masked = rows.map((r) => ({
    ...r,
    months: computeMisMonthsFromRow(r),
    incentive_paid: canViewServiceIncome(user) ? r.incentive_paid : null
  }))
  return { rows: masked, total: total || 0, page, page_size: pageSize, totals }
}

export function misTransactionExportHeaders() {
  return [
    'Date',
    'Branch',
    'Receipt Number',
    'Investor Name',
    'Issuer',
    'Scheme Name',
    'Period',
    'Months',
    'SIP Start Date',
    'SIP End Date',
    'FD Maturity Date',
    'FD Tenure',
    'Transaction Type',
    'Investment Amount',
    'CC',
    'Incentive Paid',
    'Application Number',
    'RM Code',
    'Product Category',
    'Status'
  ]
}

export function misTransactionRowToArray(r) {
  return [
    r.date ?? '',
    r.branch ?? '',
    r.receipt_number ?? '',
    r.investor_name ?? '',
    r.issuer ?? '',
    r.scheme_name ?? '',
    r.period ?? '',
    r.months ?? '',
    r.sip_start_date ?? '',
    r.sip_end_date ?? '',
    r.fd_maturity_date ?? '',
    r.fd_tenure ?? '',
    r.transaction_type ?? '',
    r.investment_amount ?? 0,
    r.collection_credit ?? 0,
    r.incentive_paid ?? '',
    r.application_number ?? '',
    r.emp_code ?? '',
    r.product_category ?? '',
    r.status ?? ''
  ]
}
