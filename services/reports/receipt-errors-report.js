import { q } from '../../config/database.js'
import { INV_AMOUNT_AQL } from '../../utils/receipt-aggregates.js'
import {
  BRANCH_CODE_AQL,
  CATEGORY_AQL,
  CLIENT_PHONE_AQL,
  INVESTOR_ID_AQL,
  INVESTOR_NAME_AQL,
  PAN_AQL,
  REFERENCE_NO_AQL
} from '../../utils/report-aql-fragments.js'
import { RECEIPT_STATUS_BUCKET_AQL } from './receipt-scope-filter.js'
import { buildReceiptReportFilters, parsePagination } from './report-query-builders.js'

export const RECEIPT_ERROR_TYPES = [
  'duplicate_transaction',
  'duplicate_receipt_number',
  'missing_pan',
  'missing_mobile',
  'blank_reference',
  'invalid_amount'
]

const OTHER_INVESTOR_ID_AQL = `((other.investor != null && other.investor.id != null) ? other.investor.id : other.investor_id)`
const OTHER_CATEGORY_AQL = CATEGORY_AQL.replace(/receipt/g, 'other')
const OTHER_INV_AMOUNT_AQL = INV_AMOUNT_AQL.replace(/receipt/g, 'other')
const STATUS_AQL = RECEIPT_STATUS_BUCKET_AQL

const DATE_EXPR_AQL = `((receipt.date != null && TO_STRING(receipt.date) != "") ? receipt.date : "")`

const AMOUNT_RAW_TXN_AQL = `(receipt.transaction != null ? receipt.transaction.amount : null)`
const AMOUNT_RAW_INV_AQL = `receipt.investment_amount`

const INVALID_AMOUNT_AQL = `(
  (${INV_AMOUNT_AQL}) <= 0
  OR (
    ${AMOUNT_RAW_TXN_AQL} != null
    && TO_STRING(${AMOUNT_RAW_TXN_AQL}) != ""
    && TO_NUMBER(${AMOUNT_RAW_TXN_AQL}) == null
  )
  OR (
    ${AMOUNT_RAW_INV_AQL} != null
    && TO_STRING(${AMOUNT_RAW_INV_AQL}) != ""
    && TO_NUMBER(${AMOUNT_RAW_INV_AQL}) == null
  )
)`

const BLANK_PAN_AQL = `(
  ${PAN_AQL} == null
  || TO_STRING(${PAN_AQL}) == ""
  || TRIM(TO_STRING(${PAN_AQL})) == ""
)`

const BLANK_MOBILE_AQL = `(
  ${CLIENT_PHONE_AQL} == null
  || TO_STRING(${CLIENT_PHONE_AQL}) == ""
  || TRIM(TO_STRING(${CLIENT_PHONE_AQL})) == ""
)`

const BLANK_REFERENCE_AQL = `(
  ${REFERENCE_NO_AQL} == null
  || TO_STRING(${REFERENCE_NO_AQL}) == ""
  || TRIM(TO_STRING(${REFERENCE_NO_AQL})) == ""
)`

const ERROR_TYPES_AQL = `UNION_DISTINCT(
  (POSITION(@dup_txn_keys, dup_txn_key) != false ? ["duplicate_transaction"] : []),
  (POSITION(@dup_receipt_nos, receipt.receipt_no) != false ? ["duplicate_receipt_number"] : []),
  (${BLANK_PAN_AQL} ? ["missing_pan"] : []),
  (${BLANK_MOBILE_AQL} ? ["missing_mobile"] : []),
  (${BLANK_REFERENCE_AQL} ? ["blank_reference"] : []),
  (${INVALID_AMOUNT_AQL} ? ["invalid_amount"] : [])
)`

export function buildDupTxnKey(investorId, productCategory, date) {
  return [String(investorId ?? ''), String(productCategory ?? ''), String(date ?? '')].join('|')
}

export function amountsWithinTolerance(a, b, tolerance = 1) {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false
  return Math.abs(na - nb) <= tolerance
}

export function groupHasNearDuplicateAmounts(amounts, tolerance = 1) {
  const nums = (Array.isArray(amounts) ? amounts : [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
  if (nums.length < 2) return false
  for (let i = 0; i < nums.length - 1; i += 1) {
    for (let j = i + 1; j < nums.length; j += 1) {
      if (amountsWithinTolerance(nums[i], nums[j], tolerance)) return true
    }
  }
  return false
}

export function classifyReceiptErrors(receipt, context = {}) {
  const {
    dupTxnKeys = [],
    dupReceiptNos = [],
    tolerance = 1
  } = context

  const investorId = receipt?.investor?.id ?? receipt?.investor_id ?? null
  const productCategory = receipt?.product?.category ?? receipt?.product_category ?? null
  const date = receipt?.date ?? null
  const amount = resolveEffectiveAmount(receipt)
  const pan = receipt?.investor?.pan ?? receipt?.pan ?? null
  const mobile = receipt?.investor?.mobile ?? receipt?.phone ?? null
  const reference = resolveReferenceNo(receipt)
  const receiptNo = receipt?.receipt_no ?? null

  const errorTypes = []

  const dupTxnKey = buildDupTxnKey(investorId, productCategory, date)
  if (dupTxnKeys.includes(dupTxnKey)) errorTypes.push('duplicate_transaction')

  if (receiptNo && dupReceiptNos.includes(receiptNo)) errorTypes.push('duplicate_receipt_number')
  if (!pan || String(pan).trim() === '') errorTypes.push('missing_pan')
  if (!mobile || String(mobile).trim() === '') errorTypes.push('missing_mobile')
  if (!reference || String(reference).trim() === '') errorTypes.push('blank_reference')

  const rawTxn = receipt?.transaction?.amount
  const rawInv = receipt?.investment_amount
  const invalidAmount =
    !Number.isFinite(amount) ||
    amount <= 0 ||
    (rawTxn != null && String(rawTxn).trim() !== '' && !Number.isFinite(Number(rawTxn))) ||
    (rawInv != null && String(rawInv).trim() !== '' && !Number.isFinite(Number(rawInv)))
  if (invalidAmount) errorTypes.push('invalid_amount')

  // ±₹1 duplicate check for unit tests / offline classification
  if (!errorTypes.includes('duplicate_transaction') && investorId && productCategory && date) {
    const peers = context.peerAmountsByKey?.[dupTxnKey] || []
    if (groupHasNearDuplicateAmounts([amount, ...peers], tolerance)) {
      errorTypes.push('duplicate_transaction')
    }
  }

  return errorTypes
}

export function resolveEffectiveAmount(receipt) {
  const txn = Number(receipt?.transaction?.amount)
  if (Number.isFinite(txn) && txn !== 0) return txn
  const fd = Number(receipt?.product_details?.fd?.deposit?.amount)
  if (Number.isFinite(fd) && fd !== 0) return fd
  const inv = Number(receipt?.investment_amount)
  if (Number.isFinite(inv) && inv !== 0) return inv
  const fdFlat = Number(receipt?.fd_deposit_amount)
  if (Number.isFinite(fdFlat) && fdFlat !== 0) return fdFlat
  const service = Number(receipt?.service_price)
  if (Number.isFinite(service) && service !== 0) return service
  return Number.isFinite(txn) ? txn : 0
}

export function resolveReferenceNo(receipt) {
  return (
    receipt?.payment?.reference_no ??
    receipt?.reference_no ??
    receipt?.transaction_reference_no ??
    receipt?.transaction_details?.reference_no ??
    null
  )
}

export function parseErrorTypeFilter(query = {}) {
  const raw = query.error_type ?? query.errorType ?? query.error_types ?? query.errorTypes
  if (!raw) return []
  const values = Array.isArray(raw) ? raw : String(raw).split(',')
  return values
    .map((v) => String(v).trim())
    .filter((v) => RECEIPT_ERROR_TYPES.includes(v))
}

export function buildSummaryFromRows(rows) {
  const summary = {
    duplicate_transaction: 0,
    duplicate_receipt_number: 0,
    missing_pan: 0,
    missing_mobile: 0,
    blank_reference: 0,
    invalid_amount: 0,
    total_receipts_with_issues: rows.length
  }
  for (const row of rows) {
    for (const type of row.error_types || []) {
      if (Object.prototype.hasOwnProperty.call(summary, type)) summary[type] += 1
    }
  }
  return summary
}

async function loadDuplicateTxnKeys(filterClause, bindVars) {
  const rows = await q(
    `
    FOR receipt IN receipts
    ${filterClause}
    LET inv = ${INVESTOR_ID_AQL}
    LET cat = ${CATEGORY_AQL}
    FILTER inv != null && TO_STRING(inv) != "" && cat != null && TO_STRING(cat) != "" && receipt.date != null
    COLLECT investor_id = inv, product_category = cat, date = receipt.date INTO group
    FILTER LENGTH(group) > 1
    LET amounts = UNIQUE(
      FOR item IN group
        LET r = item.receipt
        LET amt = (
          (TO_NUMBER(r.transaction.amount) || 0) != 0 ? (TO_NUMBER(r.transaction.amount) || 0)
          : (r.product_details != null && r.product_details.fd != null && r.product_details.fd.deposit != null && r.product_details.fd.deposit.amount != null) ? (TO_NUMBER(r.product_details.fd.deposit.amount) || 0)
          : (TO_NUMBER(r.investment_amount) || 0) != 0 ? (TO_NUMBER(r.investment_amount) || 0)
          : (TO_NUMBER(r.fd_deposit_amount) || 0) != 0 ? (TO_NUMBER(r.fd_deposit_amount) || 0)
          : (TO_NUMBER(r.service_price) || 0) != 0 ? (TO_NUMBER(r.service_price) || 0)
          : 0
        )
        RETURN amt
    )
    LET has_near_dup = LENGTH(
      FOR i IN 0..(LENGTH(amounts) - 2)
        FOR j IN (i + 1)..(LENGTH(amounts) - 1)
          FILTER ABS(amounts[i] - amounts[j]) <= 1
          RETURN 1
    ) > 0
    FILTER has_near_dup
    RETURN CONCAT_SEPARATOR("|", TO_STRING(investor_id), TO_STRING(product_category), TO_STRING(date))
  `,
    bindVars
  )
  return rows.filter(Boolean)
}

async function loadDuplicateReceiptNos(filterClause, bindVars) {
  const rows = await q(
    `
    FOR receipt IN receipts
    ${filterClause}
    FILTER receipt.receipt_no != null && TO_STRING(receipt.receipt_no) != ""
    COLLECT receipt_no = receipt.receipt_no WITH COUNT INTO cnt
    FILTER cnt > 1
    RETURN receipt_no
  `,
    bindVars
  )
  return rows.filter(Boolean)
}

function buildErrorTypeFilterClause(errorTypes) {
  if (!errorTypes.length) return { clause: '', bindVars: {} }
  return {
    clause: 'FILTER LENGTH(INTERSECTION(error_types, @error_types_filter)) > 0\n',
    bindVars: { error_types_filter: errorTypes }
  }
}

export async function runReceiptErrorsReport(user, query) {
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, query)
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })

  const [dupTxnKeys, dupReceiptNos] = await Promise.all([
    loadDuplicateTxnKeys(filterClause, bindVars),
    loadDuplicateReceiptNos(filterClause, bindVars)
  ])

  const errorTypesFilter = parseErrorTypeFilter(query)
  const { clause: errorTypeClause, bindVars: errorTypeBind } = buildErrorTypeFilterClause(errorTypesFilter)

  const baseBind = {
    ...bindVars,
    ...errorTypeBind,
    dup_txn_keys: dupTxnKeys,
    dup_receipt_nos: dupReceiptNos
  }
  const dataBind = { ...baseBind, offset, limit: pageSize }

  const classifyBlock = `
    LET inv = ${INVESTOR_ID_AQL}
    LET cat = ${CATEGORY_AQL}
    LET dup_txn_key = CONCAT_SEPARATOR("|", TO_STRING(inv), TO_STRING(cat), TO_STRING(receipt.date))
    LET error_types = ${ERROR_TYPES_AQL}
    FILTER LENGTH(error_types) > 0
  `

  const countQ = `
    FOR receipt IN receipts
    ${filterClause}
    ${classifyBlock}
    ${errorTypeClause}
    RETURN 1
  `

  const dataQ = `
    FOR receipt IN receipts
    ${filterClause}
    ${classifyBlock}
    ${errorTypeClause}
    SORT ${dateExpr} DESC, receipt.receipt_no ASC
    LIMIT @offset, @limit
    LET related_receipt_numbers = UNION_DISTINCT(
      (POSITION(@dup_txn_keys, dup_txn_key) != false ? (
        FOR other IN receipts
          FILTER other.is_deleted == false
            && other._key != receipt._key
            && ${OTHER_INVESTOR_ID_AQL} == inv
            && ${OTHER_CATEGORY_AQL} == cat
            && other.date == receipt.date
            && ABS(${OTHER_INV_AMOUNT_AQL} - (${INV_AMOUNT_AQL})) <= 1
          RETURN other.receipt_no
      ) : []),
      (POSITION(@dup_receipt_nos, receipt.receipt_no) != false ? (
        FOR other IN receipts
          FILTER other.is_deleted == false
            && other._key != receipt._key
            && other.receipt_no == receipt.receipt_no
          RETURN other.receipt_no
      ) : [])
    )
    RETURN {
      receipt_id: receipt._key,
      receipt_number: receipt.receipt_no,
      date: ${DATE_EXPR_AQL},
      client_id: inv,
      client_name: ${INVESTOR_NAME_AQL},
      pan: ${PAN_AQL},
      client_phone: ${CLIENT_PHONE_AQL},
      product_category: cat,
      amount: ${INV_AMOUNT_AQL},
      reference_no: ${REFERENCE_NO_AQL},
      branch_code: ${BRANCH_CODE_AQL},
      emp_code: receipt.emp_code,
      status: ${STATUS_AQL},
      error_types,
      related_receipt_numbers
    }
  `

  const summaryQ = `
    FOR receipt IN receipts
    ${filterClause}
    ${classifyBlock}
    ${errorTypeClause}
    RETURN error_types
  `

  const [countArr, rows, allErrorTypes] = await Promise.all([
    q(`RETURN LENGTH((${countQ}))`, baseBind),
    q(dataQ, dataBind),
    q(summaryQ, baseBind)
  ])

  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  const summaryRows = allErrorTypes.map((types) => ({ error_types: types }))
  const summary = buildSummaryFromRows(summaryRows)

  return {
    summary,
    rows,
    total,
    page,
    page_size: pageSize
  }
}
