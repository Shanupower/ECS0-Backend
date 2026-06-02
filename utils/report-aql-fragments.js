/**
 * Shared AQL fragments for reporting (MIS, exports-style aggregations).
 * Keep aligned with routes/stats.js category logic.
 */

export const CATEGORY_BASE_AQL = `(receipt.product != null && receipt.product.category != null && receipt.product.category != "") ? receipt.product.category : (receipt.product_category != null && receipt.product_category != "" ? receipt.product_category : "Other")`

export const FD_ISSUER_TYPE_AQL = `((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.type != null) ? receipt.product_details.fd.issuer.type : receipt.fd_issuer_type)`

export const CATEGORY_AQL = `(
  (UPPER(TO_STRING(${CATEGORY_BASE_AQL})) == "FD" && (
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "govt") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "government") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "post office") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "post-office") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "postoffice")
  )) ? "GOVT_FD" : ${CATEGORY_BASE_AQL}
)`

/** MF scheme category (ELSS, Liquid, etc.) */
export const MF_SCHEME_CATEGORY_AQL = `(
  (receipt.product_details != null && receipt.product_details.mf != null && receipt.product_details.mf.scheme != null && receipt.product_details.mf.scheme.category != null && receipt.product_details.mf.scheme.category != "")
    ? receipt.product_details.mf.scheme.category
    : (receipt.scheme_category != null && receipt.scheme_category != "" ? receipt.scheme_category : "Unclassified")
)`

/** Display scheme / product name */
export const SCHEME_NAME_AQL = `((receipt.product != null && receipt.product.name != null && receipt.product.name != "") ? receipt.product.name : (receipt.scheme_name != null ? receipt.scheme_name : ""))`

/** Issuer / AMC / company name for grouping */
export const ISSUER_NAME_AQL = `(
  UPPER(TO_STRING(${CATEGORY_AQL})) IN ["MF","SIF","PMS","AIF","GIFT_CITY_FUNDS"]
    ? ((receipt.product_details != null && receipt.product_details.mf != null && receipt.product_details.mf.amc != null && receipt.product_details.mf.amc.name != null) ? receipt.product_details.mf.amc.name : receipt.amc_name)
  : (UPPER(TO_STRING(${CATEGORY_AQL})) == "FD" || UPPER(TO_STRING(${CATEGORY_AQL})) == "GOVT_FD")
    ? ((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.name != null) ? receipt.product_details.fd.issuer.name : receipt.fd_issuer_name)
  : (UPPER(TO_STRING(${CATEGORY_AQL})) == "BOND" || UPPER(TO_STRING(${CATEGORY_AQL})) == "NCD")
    ? ((receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.name != null) ? receipt.product_details.bond.issuer.name : receipt.bond_issuer_name)
  : (UPPER(TO_STRING(${CATEGORY_AQL})) == "INS")
    ? ((receipt.product_details != null && receipt.product_details.insurance != null && receipt.product_details.insurance.issuer != null && receipt.product_details.insurance.issuer.name != null) ? receipt.product_details.insurance.issuer.name : receipt.issuer_company)
  : ((receipt.product_details != null && receipt.product_details.mf != null && receipt.product_details.mf.amc != null && receipt.product_details.mf.amc.name != null) ? receipt.product_details.mf.amc.name : receipt.amc_name)
)`

/** SIP/STP/SWP period label or FD deposit period (aligned with receiptNormalizer fallbacks). */
export const MIS_PERIOD_AQL = `(
  (receipt.transaction != null && receipt.transaction.period_installments != null && TO_STRING(receipt.transaction.period_installments) != "")
    ? receipt.transaction.period_installments
    : ((receipt.period_installments != null && TO_STRING(receipt.period_installments) != "") ? receipt.period_installments
    : ((receipt.sip_stp_swp_period != null && TO_STRING(receipt.sip_stp_swp_period) != "") ? receipt.sip_stp_swp_period
    : ((receipt.deposit_period_ym != null && TO_STRING(receipt.deposit_period_ym) != "") ? receipt.deposit_period_ym
    : ((receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.frequency != null && TO_STRING(receipt.transaction.sip.frequency) != "")
      ? receipt.transaction.sip.frequency
      : ((receipt.sip_frequency != null && TO_STRING(receipt.sip_frequency) != "") ? receipt.sip_frequency
      : ((receipt.transaction != null && receipt.transaction.swp != null && receipt.transaction.swp.frequency != null && TO_STRING(receipt.transaction.swp.frequency) != "")
        ? receipt.transaction.swp.frequency
        : ((receipt.swp_frequency != null && TO_STRING(receipt.swp_frequency) != "") ? receipt.swp_frequency
        : ((receipt.transaction != null && receipt.transaction.stp != null && receipt.transaction.stp.frequency != null && TO_STRING(receipt.transaction.stp.frequency) != "")
          ? receipt.transaction.stp.frequency
          : receipt.stp_frequency))))))))
)`

export const SIP_START_DATE_AQL = `(
  (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.start_date != null && TO_STRING(receipt.transaction.sip.start_date) != "")
    ? receipt.transaction.sip.start_date
    : receipt.sip_start_date
)`

export const SIP_END_DATE_AQL = `(
  (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.end_date != null && TO_STRING(receipt.transaction.sip.end_date) != "")
    ? receipt.transaction.sip.end_date
    : receipt.sip_end_date
)`

export const SIP_IS_PERPETUAL_AQL = `(
  (receipt.transaction != null && receipt.transaction.sip != null && receipt.transaction.sip.is_perpetual == true)
    ? true
    : receipt.sip_is_perpetual == true
)`

export const FD_DEPOSIT_DATE_AQL = `(
  (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.deposit_date != null && TO_STRING(receipt.product_details.fd.deposit.deposit_date) != "")
    ? receipt.product_details.fd.deposit.deposit_date
    : ((receipt.fd_deposit_date != null && TO_STRING(receipt.fd_deposit_date) != "") ? receipt.fd_deposit_date
    : ((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.booking_date != null && TO_STRING(receipt.product_details.fd.deposit.booking_date) != "")
      ? receipt.product_details.fd.deposit.booking_date
      : receipt.fd_booking_date))
)`

/** Human-readable FD tenure from nested deposit or flat legacy fields. */
export const FD_TENURE_DISPLAY_AQL = `(
  LET tenure_unit = (
    (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.tenure_unit != null && TO_STRING(receipt.product_details.fd.deposit.tenure_unit) != "")
      ? LOWER(TO_STRING(receipt.product_details.fd.deposit.tenure_unit))
      : ((receipt.fd_tenure_unit != null && TO_STRING(receipt.fd_tenure_unit) != "") ? LOWER(TO_STRING(receipt.fd_tenure_unit)) : "months")
  )
  LET tenure_val = (
    (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.tenure_value != null)
      ? receipt.product_details.fd.deposit.tenure_value
      : (receipt.fd_tenure_value != null ? receipt.fd_tenure_value
        : ((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.tenure_months != null)
          ? receipt.product_details.fd.deposit.tenure_months
          : receipt.fd_tenure_months))
  )
  RETURN tenure_val != null && TO_STRING(tenure_val) != ""
    ? (tenure_unit == "days"
      ? CONCAT(TO_STRING(tenure_val), " days")
      : CONCAT(TO_STRING(tenure_val), " months"))
    : null
)[0]`
