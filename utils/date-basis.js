/**
 * Date-basis helpers for AQL queries.
 *
 * We treat dates as ISO `YYYY-MM-DD` strings and compare lexicographically in AQL.
 * `transaction` basis is derived from payment/cheque fields, then falls back to receipt date.
 */

export function normalizeDateBasis(raw) {
  const v = String(raw || '').trim().toLowerCase()
  if (v === 'transaction' || v === 'txn' || v === 'txndate' || v === 'transaction_date') return 'transaction'
  return 'receipt'
}

export function receiptDateExprAql() {
  // Prefer explicit receipt.date; fall back to created_at date for legacy docs.
  return '(receipt.date != null && receipt.date != "" ? receipt.date : SUBSTRING(receipt.created_at, 0, 10))'
}

export function transactionDateExprAql() {
  // Prefer payment.transaction_date, onlineTransactionDate, cheque/instrument dates, product booking dates, then receipt date.
  return `(
    (receipt.payment != null && receipt.payment.transaction_date != null && receipt.payment.transaction_date != "") ? receipt.payment.transaction_date
    : (receipt.onlineTransactionDate != null && receipt.onlineTransactionDate != "") ? receipt.onlineTransactionDate
    : (receipt.othersTransactionDate != null && receipt.othersTransactionDate != "") ? receipt.othersTransactionDate
    : (receipt.chequeDate != null && receipt.chequeDate != "") ? receipt.chequeDate
    : (receipt.cheque_date != null && receipt.cheque_date != "") ? receipt.cheque_date
    : (receipt.instrumentDate != null && receipt.instrumentDate != "") ? receipt.instrumentDate
    : (receipt.instrument_date != null && receipt.instrument_date != "") ? receipt.instrument_date
    : (receipt.payment != null && receipt.payment.instrument != null && receipt.payment.instrument.date != null && receipt.payment.instrument.date != "") ? receipt.payment.instrument.date
    : (receipt.transaction_details != null && receipt.transaction_details.txn_date != null && receipt.transaction_details.txn_date != "") ? receipt.transaction_details.txn_date
    : (receipt.transaction_details != null && receipt.transaction_details.date != null && receipt.transaction_details.date != "") ? receipt.transaction_details.date
    : (receipt.transaction != null && receipt.transaction.date != null && receipt.transaction.date != "") ? receipt.transaction.date
    : (receipt.transaction != null && receipt.transaction.txn_date != null && receipt.transaction.txn_date != "") ? receipt.transaction.txn_date
    : (receipt.transactionDate != null && receipt.transactionDate != "") ? receipt.transactionDate
    : (receipt.txn_date != null && receipt.txn_date != "") ? receipt.txn_date
    : (receipt.transaction_date != null && receipt.transaction_date != "") ? receipt.transaction_date
    : (receipt.bond_transaction_date != null && receipt.bond_transaction_date != "") ? receipt.bond_transaction_date
    : (receipt.sip_start_date != null && receipt.sip_start_date != "") ? receipt.sip_start_date
    : (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.start_date != null && receipt.transaction.sip.start_date != "") ? receipt.transaction.sip.start_date
    : (receipt.fd_deposit_date != null && receipt.fd_deposit_date != "") ? receipt.fd_deposit_date
    : (receipt.fd_booking_date != null && receipt.fd_booking_date != "") ? receipt.fd_booking_date
    : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.deposit_date != null && receipt.product_details.fd.deposit.deposit_date != "") ? receipt.product_details.fd.deposit.deposit_date
    : (receipt.bond_issue_date != null && receipt.bond_issue_date != "") ? receipt.bond_issue_date
    : (receipt.insurance_date_of_issue != null && receipt.insurance_date_of_issue != "") ? receipt.insurance_date_of_issue
    : (receipt.date != null && receipt.date != "") ? receipt.date
    : SUBSTRING(receipt.created_at, 0, 10)
  )`
}

/** Compare/filter on YYYY-MM-DD regardless of ISO datetime storage. */
export function normalizeDateForCompareAql(dateExpr) {
  return `SUBSTRING(TO_STRING(${dateExpr}), 0, 10)`
}

export function normalizeQueryDate(value) {
  const s = String(value ?? '').trim().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

export function effectiveDateExprAql(dateBasis) {
  return normalizeDateBasis(dateBasis) === 'transaction'
    ? transactionDateExprAql()
    : receiptDateExprAql()
}

