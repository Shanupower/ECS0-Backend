import { q } from '../../config/database.js'
import { INV_AMOUNT_AQL } from '../../utils/receipt-aggregates.js'
import {
  BRANCH_CODE_AQL,
  CATEGORY_AQL,
  CHANNEL_AQL,
  CLIENT_PHONE_AQL,
  INSTRUMENT_NO_AQL,
  INVESTOR_ID_AQL,
  INVESTOR_NAME_AQL,
  PAN_AQL,
  REFERENCE_NO_AQL,
  SCHEME_NAME_AQL
} from '../../utils/report-aql-fragments.js'
import { receiptDateExprAql, transactionDateExprAql } from '../../utils/date-basis.js'
import { RECEIPT_STATUS_BUCKET_AQL } from './receipt-scope-filter.js'
import { buildReceiptReportFilters, parsePagination } from './report-query-builders.js'

export const RECEIPT_ERROR_TYPES = [
  'duplicate_transaction',
  'duplicate_receipt_number',
  'invalid_amount',
  'verified_non_duplicate'
]

const OTHER_INVESTOR_ID_AQL = `((other.investor != null && other.investor.id != null) ? other.investor.id : other.investor_id)`
const OTHER_CATEGORY_AQL = CATEGORY_AQL.replace(/receipt/g, 'other')
const OTHER_INV_AMOUNT_AQL = INV_AMOUNT_AQL.replace(/receipt/g, 'other')
const STATUS_AQL = RECEIPT_STATUS_BUCKET_AQL

const RECEIPT_DATE_AQL = receiptDateExprAql()
const TXN_DATE_AQL = transactionDateExprAql('receipt')
const OTHER_TXN_DATE_AQL = transactionDateExprAql('other')

const OTHER_REFERENCE_NO_AQL = REFERENCE_NO_AQL.replace(/receipt/g, 'other')
const OTHER_INSTRUMENT_NO_AQL = INSTRUMENT_NO_AQL.replace(/receipt/g, 'other')
const OTHER_CHANNEL_AQL = CHANNEL_AQL.replace(/receipt/g, 'other')
const OTHER_SCHEME_AQL = SCHEME_NAME_AQL.replace(/receipt/g, 'other')

const PMT_REF_AQL = `(
  (${REFERENCE_NO_AQL} != null && TRIM(TO_STRING(${REFERENCE_NO_AQL})) != "") ? TRIM(TO_STRING(${REFERENCE_NO_AQL}))
  : (${INSTRUMENT_NO_AQL} != null && TRIM(TO_STRING(${INSTRUMENT_NO_AQL})) != "") ? TRIM(TO_STRING(${INSTRUMENT_NO_AQL}))
  : (${CHANNEL_AQL} != null && TRIM(TO_STRING(${CHANNEL_AQL})) != "") ? TRIM(TO_STRING(${CHANNEL_AQL}))
  : ""
)`

const OTHER_PMT_REF_AQL = `(
  (${OTHER_REFERENCE_NO_AQL} != null && TRIM(TO_STRING(${OTHER_REFERENCE_NO_AQL})) != "") ? TRIM(TO_STRING(${OTHER_REFERENCE_NO_AQL}))
  : (${OTHER_INSTRUMENT_NO_AQL} != null && TRIM(TO_STRING(${OTHER_INSTRUMENT_NO_AQL})) != "") ? TRIM(TO_STRING(${OTHER_INSTRUMENT_NO_AQL}))
  : (${OTHER_CHANNEL_AQL} != null && TRIM(TO_STRING(${OTHER_CHANNEL_AQL})) != "") ? TRIM(TO_STRING(${OTHER_CHANNEL_AQL}))
  : ""
)`

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

const ERROR_TYPES_AQL = `UNION_DISTINCT(
  (POSITION(@dup_txn_receipt_ids, receipt._key) != false ? ["duplicate_transaction"] : []),
  (POSITION(@dup_receipt_nos, receipt.receipt_no) != false ? ["duplicate_receipt_number"] : []),
  (${INVALID_AMOUNT_AQL} ? ["invalid_amount"] : []),
  (receipt.is_verified_non_duplicate == true ? ["verified_non_duplicate"] : [])
)`

export function buildDupTxnKey(investorId, productCategory, scheme, date, paymentRef = '') {
  return [
    String(investorId ?? '').trim(),
    String(productCategory ?? '').trim().toLowerCase(),
    String(scheme ?? '').trim().toLowerCase(),
    String(date ?? '').trim(),
    String(paymentRef ?? '').trim().toLowerCase()
  ].join('|')
}

export function amountsWithinTolerance(a, b, tolerance = 1) {
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return false
  return Math.abs(na - nb) <= tolerance
}

export function resolvePaymentInstrument(receipt) {
  const ref = (
    receipt?.payment?.reference_no ??
    receipt?.reference_no ??
    receipt?.transaction_reference_no ??
    receipt?.transaction_details?.reference_no ??
    receipt?.payment?.channel ??
    receipt?.channel ??
    receipt?.transaction_channel ??
    receipt?.othersTransactionType ??
    null
  )
  if (ref && String(ref).trim() !== '') return String(ref).trim()

  const inst = (
    receipt?.payment?.instrument?.number ??
    receipt?.instrument_no ??
    receipt?.chequeNumber ??
    receipt?.cheque_number ??
    receipt?.instrumentNo ??
    null
  )
  if (inst && String(inst).trim() !== '') return String(inst).trim()

  return ''
}

export function resolveSchemeName(receipt) {
  const val = (
    receipt?.transaction?.switch_over?.to_scheme_name ??
    receipt?.switch_to_scheme_name ??
    receipt?.transaction?.stp?.to_scheme_name ??
    receipt?.stp_target_scheme_name ??
    receipt?.product?.name ??
    receipt?.scheme_name ??
    receipt?.product_details?.mf?.scheme?.name ??
    receipt?.product_details?.fd?.scheme_name ??
    receipt?.product_details?.bond?.product?.name ??
    ''
  )
  return String(val || '').trim()
}

export function resolveTxnDate(receipt) {
  const val = (
    receipt?.payment?.transaction_date ??
    receipt?.onlineTransactionDate ??
    receipt?.othersTransactionDate ??
    receipt?.chequeDate ??
    receipt?.cheque_date ??
    receipt?.instrumentDate ??
    receipt?.instrument_date ??
    receipt?.payment?.instrument?.date ??
    receipt?.transaction_details?.txn_date ??
    receipt?.transaction_details?.date ??
    receipt?.transaction?.date ??
    receipt?.transaction?.txn_date ??
    receipt?.transactionDate ??
    receipt?.txn_date ??
    receipt?.transaction_date ??
    receipt?.bond_transaction_date ??
    receipt?.sip_start_date ??
    receipt?.transaction?.sip?.start_date ??
    receipt?.fd_deposit_date ??
    receipt?.date ??
    ''
  )
  return String(val || '').trim()
}

export function isDuplicateTxnPair(r1, r2, tolerance = 1) {
  const inv1 = r1?.investor?.id ?? r1?.investor_id ?? null
  const inv2 = r2?.investor?.id ?? r2?.investor_id ?? null
  if (!inv1 || !inv2 || String(inv1) !== String(inv2)) return false

  const cat1 = r1?.product?.category ?? r1?.product_category ?? null
  const cat2 = r2?.product?.category ?? r2?.product_category ?? null
  if (!cat1 || !cat2 || String(cat1).toLowerCase() !== String(cat2).toLowerCase()) return false

  const s1 = resolveSchemeName(r1).toLowerCase()
  const s2 = resolveSchemeName(r2).toLowerCase()
  if (s1 !== s2) return false

  const d1 = resolveTxnDate(r1)
  const d2 = resolveTxnDate(r2)
  if (!d1 || !d2 || d1 !== d2) return false

  const a1 = resolveEffectiveAmount(r1)
  const a2 = resolveEffectiveAmount(r2)
  if (!amountsWithinTolerance(a1, a2, tolerance)) return false

  const ref1 = resolvePaymentInstrument(r1).toLowerCase()
  const ref2 = resolvePaymentInstrument(r2).toLowerCase()
  if (ref1 !== '' && ref2 !== '') {
    return ref1 === ref2
  }
  // Option B: if one or both are blank, fallback to true!
  return true
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
    dupTxnReceiptIds = [],
    dupReceiptNos = [],
    peers = [],
    tolerance = 1
  } = context

  const receiptId = receipt?._key ?? receipt?.receipt_id ?? receipt?.id ?? null
  const receiptNo = receipt?.receipt_no ?? null
  const amount = resolveEffectiveAmount(receipt)

  const errorTypes = []

  if (receipt?.is_verified_non_duplicate === true) {
    errorTypes.push('verified_non_duplicate')
  } else {
    if (receiptId && dupTxnReceiptIds.includes(receiptId)) {
      errorTypes.push('duplicate_transaction')
    }
    if (receiptNo && dupReceiptNos.includes(receiptNo)) {
      errorTypes.push('duplicate_receipt_number')
    }
  }

  const rawTxn = receipt?.transaction?.amount
  const rawInv = receipt?.investment_amount
  const invalidAmount =
    !Number.isFinite(amount) ||
    amount <= 0 ||
    (rawTxn != null && String(rawTxn).trim() !== '' && !Number.isFinite(Number(rawTxn))) ||
    (rawInv != null && String(rawInv).trim() !== '' && !Number.isFinite(Number(rawInv)))
  if (invalidAmount) errorTypes.push('invalid_amount')

  // Offline / unit test duplicate check against peers
  if (!errorTypes.includes('duplicate_transaction') && receipt?.is_verified_non_duplicate !== true && Array.isArray(peers) && peers.length > 0) {
    for (const other of peers) {
      const otherId = other?._key ?? other?.receipt_id ?? other?.id ?? null
      if (otherId !== receiptId && isDuplicateTxnPair(receipt, other, tolerance)) {
        errorTypes.push('duplicate_transaction')
        break
      }
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
    receipt?.payment?.channel ??
    receipt?.channel ??
    receipt?.transaction_channel ??
    receipt?.othersTransactionType ??
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
    invalid_amount: 0,
    verified_non_duplicate: 0,
    total_receipts_with_issues: rows.length
  }
  for (const row of rows) {
    for (const type of row.error_types || []) {
      if (Object.prototype.hasOwnProperty.call(summary, type)) summary[type] += 1
    }
  }
  return summary
}

async function loadDuplicateTxnReceiptIds(filterClause, bindVars) {
  const rows = await q(
    `
    FOR receipt IN receipts
    ${filterClause}
    FILTER receipt.is_verified_non_duplicate != true
    LET inv = ${INVESTOR_ID_AQL}
    LET cat = ${CATEGORY_AQL}
    LET scheme = LOWER(TRIM(${SCHEME_NAME_AQL}))
    LET dt = ${TXN_DATE_AQL}
    LET amt = ${INV_AMOUNT_AQL}
    LET pmt_ref = LOWER(TRIM(${PMT_REF_AQL}))
    FILTER inv != null && TO_STRING(inv) != "" && cat != null && TO_STRING(cat) != "" && dt != null && TO_STRING(dt) != ""
    COLLECT investor_id = inv, product_category = cat, scheme_name = scheme, date = dt INTO group
    FILTER LENGTH(group) > 1
    LET dup_ids = UNIQUE(
      FOR i IN 0..(LENGTH(group) - 2)
        FOR j IN (i + 1)..(LENGTH(group) - 1)
          LET r1 = group[i].receipt
          LET r2 = group[j].receipt
          LET a1 = group[i].amt
          LET a2 = group[j].amt
          LET ref1 = group[i].pmt_ref
          LET ref2 = group[j].pmt_ref
          FILTER ABS(a1 - a2) <= 1
          FILTER (ref1 != "" && ref2 != "") ? (ref1 == ref2) : true
          RETURN [r1._key, r2._key]
    )
    FILTER LENGTH(dup_ids) > 0
    RETURN FLATTEN(dup_ids)
  `,
    bindVars
  )
  const flattened = rows.flat().filter(Boolean)
  return Array.from(new Set(flattened))
}

async function loadDuplicateReceiptNos(filterClause, bindVars) {
  const rows = await q(
    `
    FOR receipt IN receipts
    ${filterClause}
    FILTER receipt.is_verified_non_duplicate != true
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

  const isAdmin = user?.role === 'admin'
  const verificationStatus = isAdmin
    ? (query.verification_status || query.verificationStatus || 'non_verified')
    : 'non_verified'

  let verificationFilterClause = ''
  if (verificationStatus === 'verified') {
    verificationFilterClause = 'FILTER receipt.is_verified_non_duplicate == true\n'
  } else if (verificationStatus === 'all') {
    verificationFilterClause = ''
  } else {
    // Default: 'non_verified' - enforced strictly for non-admins
    verificationFilterClause = 'FILTER receipt.is_verified_non_duplicate != true\n'
  }

  const [dupTxnReceiptIds, dupReceiptNos] = await Promise.all([
    loadDuplicateTxnReceiptIds(filterClause, bindVars),
    loadDuplicateReceiptNos(filterClause, bindVars)
  ])

  const errorTypesFilter = parseErrorTypeFilter(query)
  const { clause: errorTypeClause, bindVars: errorTypeBind } = buildErrorTypeFilterClause(errorTypesFilter)

  const baseBind = {
    ...bindVars,
    ...errorTypeBind,
    dup_txn_receipt_ids: dupTxnReceiptIds,
    dup_receipt_nos: dupReceiptNos
  }
  const dataBind = { ...baseBind, offset, limit: pageSize }

  const classifyBlock = `
    LET error_types = ${ERROR_TYPES_AQL}
    FILTER LENGTH(error_types) > 0
  `

  const countQ = `
    FOR receipt IN receipts
    ${filterClause}
    ${verificationFilterClause}
    ${classifyBlock}
    ${errorTypeClause}
    RETURN 1
  `

  const dataQ = `
    FOR receipt IN receipts
    ${filterClause}
    ${verificationFilterClause}
    ${classifyBlock}
    ${errorTypeClause}
    SORT ${dateExpr} DESC, receipt.receipt_no ASC
    LIMIT @offset, @limit
    LET inv = ${INVESTOR_ID_AQL}
    LET cat = ${CATEGORY_AQL}
    LET scheme = LOWER(TRIM(${SCHEME_NAME_AQL}))
    LET dt = ${TXN_DATE_AQL}
    LET amt = ${INV_AMOUNT_AQL}
    LET pmt_ref = LOWER(TRIM(${PMT_REF_AQL}))
    LET related_receipt_numbers = UNION_DISTINCT(
      (POSITION(@dup_txn_receipt_ids, receipt._key) != false ? (
        FOR other IN receipts
          FILTER other.is_deleted == false
            && other._key != receipt._key
            && other.is_verified_non_duplicate != true
            && ${OTHER_INVESTOR_ID_AQL} == inv
            && ${OTHER_CATEGORY_AQL} == cat
            && LOWER(TRIM(${OTHER_SCHEME_AQL})) == scheme
            && ${OTHER_TXN_DATE_AQL} == dt
            && ABS(${OTHER_INV_AMOUNT_AQL} - amt) <= 1
            && ((pmt_ref != "" && LOWER(TRIM(${OTHER_PMT_REF_AQL})) != "") ? (pmt_ref == LOWER(TRIM(${OTHER_PMT_REF_AQL}))) : true)
          RETURN other.receipt_no
      ) : []),
      (POSITION(@dup_receipt_nos, receipt.receipt_no) != false ? (
        FOR other IN receipts
          FILTER other.is_deleted == false
            && other._key != receipt._key
            && other.is_verified_non_duplicate != true
            && other.receipt_no == receipt.receipt_no
          RETURN other.receipt_no
      ) : [])
    )
    RETURN {
      receipt_id: receipt._key,
      receipt_number: receipt.receipt_no,
      date: ${RECEIPT_DATE_AQL},
      receipt_date: ${RECEIPT_DATE_AQL},
      txn_date: dt,
      transaction_date: dt,
      client_id: inv,
      client_name: ${INVESTOR_NAME_AQL},
      pan: ${PAN_AQL},
      client_phone: ${CLIENT_PHONE_AQL},
      product_category: cat,
      scheme_name: ${SCHEME_NAME_AQL},
      amount: amt,
      reference_no: ${REFERENCE_NO_AQL},
      instrument_no: ${INSTRUMENT_NO_AQL},
      channel: ${CHANNEL_AQL},
      payment_ref: ${PMT_REF_AQL},
      branch_code: ${BRANCH_CODE_AQL},
      emp_code: receipt.emp_code,
      status: ${STATUS_AQL},
      error_types,
      related_receipt_numbers,
      is_verified_non_duplicate: receipt.is_verified_non_duplicate == true,
      verified_non_duplicate_by: receipt.verified_non_duplicate_by || null,
      verified_non_duplicate_at: receipt.verified_non_duplicate_at || null
    }
  `

  const summaryQ = `
    FOR receipt IN receipts
    ${filterClause}
    ${verificationFilterClause}
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
