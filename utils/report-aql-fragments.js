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
