// Shared AQL expressions for receipt aggregation so all endpoints
// (stats.js, branches.js, and anywhere else totals are computed) agree on
// how investments, collection credit (CC), and service income (SI) are
// derived from a receipt document.

// Investment amount per receipt: nested tree first (transaction.amount, product_details.fd), then legacy flat
export const INV_AMOUNT_AQL = `(
  (TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0)
  : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0)
  : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0)
  : (TO_NUMBER(receipt.fd_deposit_amount) || 0) != 0 ? (TO_NUMBER(receipt.fd_deposit_amount) || 0)
  : (TO_NUMBER(receipt.service_price) || 0) != 0 ? (TO_NUMBER(receipt.service_price) || 0)
  : 0
)`

// CC per receipt: tree total (total_cc) when set, else cc_amount+additional_cc,
// else legacy collection_credit/cc, else calculations.collection_credit/cc
export const CC_AQL = `(TO_NUMBER(receipt.total_cc) || 0) != 0 ? (TO_NUMBER(receipt.total_cc) || 0) : ((TO_NUMBER(receipt.cc_amount) || 0) + (TO_NUMBER(receipt.additional_cc) || 0)) != 0 ? ((TO_NUMBER(receipt.cc_amount) || 0) + (TO_NUMBER(receipt.additional_cc) || 0)) : (TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0) != 0 ? (TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0) : (receipt.calculations != null && (receipt.calculations.collection_credit != null || receipt.calculations.cc != null)) ? (TO_NUMBER(receipt.calculations.collection_credit || receipt.calculations.cc || 0) || 0) : 0`

// SI per receipt: tree total (total_si) when set, else si_amount+additional_si,
// else legacy service_income/si, else calculations.service_income/si
export const SI_AQL = `(TO_NUMBER(receipt.total_si) || 0) != 0 ? (TO_NUMBER(receipt.total_si) || 0) : ((TO_NUMBER(receipt.si_amount) || 0) + (TO_NUMBER(receipt.additional_si) || 0)) != 0 ? ((TO_NUMBER(receipt.si_amount) || 0) + (TO_NUMBER(receipt.additional_si) || 0)) : (TO_NUMBER(receipt.service_income || receipt.si || 0) || 0) != 0 ? (TO_NUMBER(receipt.service_income || receipt.si || 0) || 0) : (receipt.calculations != null && (receipt.calculations.service_income != null || receipt.calculations.si != null)) ? (TO_NUMBER(receipt.calculations.service_income || receipt.calculations.si || 0) || 0) : 0`
