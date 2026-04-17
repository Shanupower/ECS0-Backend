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
  // Prefer nested payment transaction_date, then legacy flattened fields, then instrument/cheque date,
  // then receipt date, then created_at date.
  return `(
    (receipt.payment != null && receipt.payment.transaction_date != null && receipt.payment.transaction_date != "") ? receipt.payment.transaction_date
    : (receipt.txn_date != null && receipt.txn_date != "") ? receipt.txn_date
    : (receipt.transaction_date != null && receipt.transaction_date != "") ? receipt.transaction_date
    : (receipt.instrument_date != null && receipt.instrument_date != "") ? receipt.instrument_date
    : (receipt.payment != null && receipt.payment.instrument != null && receipt.payment.instrument.date != null && receipt.payment.instrument.date != "") ? receipt.payment.instrument.date
    : (receipt.date != null && receipt.date != "") ? receipt.date
    : SUBSTRING(receipt.created_at, 0, 10)
  )`
}

export function effectiveDateExprAql(dateBasis) {
  return normalizeDateBasis(dateBasis) === 'transaction'
    ? transactionDateExprAql()
    : receiptDateExprAql()
}

