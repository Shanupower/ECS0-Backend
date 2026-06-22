import { q } from '../../config/database.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  BRANCH_CODE_AQL,
  CATEGORY_AQL,
  CHANNEL_AQL,
  ENTRY_MODE_AQL,
  INSTRUMENT_NO_AQL,
  INSTRUMENT_TYPE_AQL,
  INVESTOR_ID_AQL,
  INVESTOR_NAME_AQL,
  ISSUER_NAME_AQL,
  REFERENCE_NO_AQL,
  SCHEME_NAME_AQL
} from '../../utils/report-aql-fragments.js'
import { RECEIPT_STATUS_BUCKET_AQL } from './receipt-scope-filter.js'
import {
  buildReceiptReportFilters,
  parsePagination,
  canViewServiceIncome
} from './report-query-builders.js'
import { maskServiceIncomeTotals } from './report-totals.js'

const STATUS_AQL = RECEIPT_STATUS_BUCKET_AQL

export async function runPaymentModeReport(user, query) {
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, query, {})
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })

  const summaryQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET payment_mode = ${ENTRY_MODE_AQL}
    COLLECT mode = payment_mode
    AGGREGATE applications = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL}), collection_credit = SUM(${CC_AQL}), incentive_amount = SUM(${SI_AQL})
    SORT amount DESC
    RETURN { payment_mode: mode, applications, amount, collection_credit, incentive_amount }
  `

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
      product_category: ${CATEGORY_AQL},
      issuer: ${ISSUER_NAME_AQL},
      scheme_name: ${SCHEME_NAME_AQL},
      amount: ${INV_AMOUNT_AQL},
      payment_mode: ${ENTRY_MODE_AQL},
      channel: ${CHANNEL_AQL},
      instrument_type: ${INSTRUMENT_TYPE_AQL},
      instrument_no: ${INSTRUMENT_NO_AQL},
      reference_no: ${REFERENCE_NO_AQL},
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
  const [summary, countArr, rows, totalsArr] = await Promise.all([
    q(summaryQ, bindVars),
    q(countQ, bindVars),
    q(dataQ, bind),
    q(totalsQ, bindVars)
  ])

  const maskSi = (r) => ({
    ...r,
    incentive_amount: canViewServiceIncome(user) ? r.incentive_amount : null
  })

  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  return {
    summary: summary.map(maskSi),
    rows: rows.map(maskSi),
    total: total || 0,
    totals: maskServiceIncomeTotals(user, totalsArr[0] || { amount: 0, collection_credit: 0, incentive_amount: 0 }),
    page,
    page_size: pageSize
  }
}
