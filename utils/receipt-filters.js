/**
 * Shared AQL filter fragments for receipt listing (category, MF txn_type / Switch Over).
 * Keep in sync across GET /receipts, summary, emp, branch receipts, export.
 */

export const EXCLUDE_SWITCH_TYPES = ['Switch Over', 'SwitchOver', 'SWITCH_OVER', 'switch_over']

export function normalizeTxnTypeFromMode(m) {
  const v = String(m || '').trim()
  if (!v) return ''
  if (v === 'Lump Sum') return 'Lumpsum'
  if (v === 'Switch Over') return 'Switch Over'
  return v
}

export function normalizeModeFallbackFromTxnType(t) {
  const v = String(t || '').trim()
  if (!v) return ''
  if (v === 'Lumpsum') return 'Lump Sum'
  if (v === 'Switch Over') return 'Switch Over'
  return v
}

export function isSwitchOverValue(v) {
  const s = String(v || '').trim().toLowerCase()
  return s === 'switch over' || s === 'switchover' || s === 'switch_over' || s === 'switch-over'
}

/** GOVT_FD issuer expression (same as legacy receipts list) */
export function govtFdIssuerExpr() {
  return `LOWER(TO_STRING((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.type != null)
    ? receipt.product_details.fd.issuer.type
    : (receipt.fd_issuer_type != null ? receipt.fd_issuer_type : "")))`
}

export function govtFdCategoryMatchAql() {
  const issuerExpr = govtFdIssuerExpr()
  const issuerMatch = `(CONTAINS(${issuerExpr}, "govt") OR CONTAINS(${issuerExpr}, "government") OR CONTAINS(${issuerExpr}, "post office") OR CONTAINS(${issuerExpr}, "post-office") OR CONTAINS(${issuerExpr}, "postoffice"))`
  const categoryExpr = `UPPER(TO_STRING((receipt.product != null && receipt.product.category != null && receipt.product.category != "") ? receipt.product.category : receipt.product_category))`
  return `(
    ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
    OR (
      ${categoryExpr} == "FD"
      AND ${issuerMatch}
    )
  )`
}

export function bindSwitchOverModes(bindVars, legacySwitchOverMode = 'Switch Over') {
  bindVars.switch_over_mode = 'Switch Over'
  bindVars.switch_over_mode_alt1 = 'SwitchOver'
  bindVars.switch_over_mode_alt2 = 'SWITCH_OVER'
  bindVars.switch_over_mode_alt3 = 'switch_over'
  bindVars.legacy_switch_over_mode = legacySwitchOverMode
}

/**
 * Match Switch Over receipts including nested transaction.switch_over / transaction.type
 */
export function aqlSwitchOverPositiveMatch() {
  return `(
    receipt.txn_type IN [@switch_over_mode, @switch_over_mode_alt1, @switch_over_mode_alt2, @switch_over_mode_alt3]
    OR receipt.transaction_type IN [@switch_over_mode, @switch_over_mode_alt1, @switch_over_mode_alt2, @switch_over_mode_alt3]
    OR receipt.mode == @legacy_switch_over_mode
    OR (receipt.transaction != null AND receipt.transaction.switch_over != null)
    OR (receipt.transaction != null AND receipt.transaction.type IN [@switch_over_mode, @switch_over_mode_alt1, @switch_over_mode_alt2, @switch_over_mode_alt3])
  )`
}

/**
 * Exclude Switch Over when filtering a specific non-switch MF txn type
 */
export function aqlExcludeSwitchOverClause() {
  return `((receipt.txn_type == null OR receipt.txn_type NOT IN @exclude_switch_types) AND (receipt.transaction_type == null OR receipt.transaction_type NOT IN @exclude_switch_types) AND (receipt.transaction == null OR receipt.transaction.type == null OR receipt.transaction.type NOT IN @exclude_switch_types) AND (receipt.switch_to_scheme_name == null OR receipt.switch_to_scheme_name == "") AND (receipt.transaction == null OR receipt.transaction.switch_over == null))`
}

/**
 * Apply category filter to filterConditions / bindVars (array + object pattern)
 */
export function applyReceiptCategoryFilter(filterConditions, bindVars, category) {
  if (!category) return
  const catUpper = String(category).trim().toUpperCase()
  if (catUpper === 'GOVT_FD') {
    filterConditions.push(govtFdCategoryMatchAql())
    bindVars.category = 'GOVT_FD'
  } else if (catUpper === 'NCD') {
    // Option A: keep `product.category` as BOND, but allow filtering NCD via issuer.type.
    // Match:
    // - legacy/edge receipts that truly store category as NCD
    // - or BOND receipts whose issuer type is NCD
    filterConditions.push(`(
      ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
      OR (
        ((receipt.product != null && receipt.product.category == @bond_category) OR receipt.product_category == @bond_category)
        AND UPPER(TO_STRING(
          (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.type != null)
            ? receipt.product_details.bond.issuer.type
            : ""
        )) == @bond_issuer_type
      )
    )`)
    bindVars.category = 'NCD'
    bindVars.bond_category = 'BOND'
    bindVars.bond_issuer_type = 'NCD'
  } else if (catUpper === 'BOND') {
    // Bonds only: exclude BOND receipts whose issuer.type is NCD (those belong to NCD category)
    filterConditions.push(`(
      ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
      AND UPPER(TO_STRING(
        (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.type != null)
          ? receipt.product_details.bond.issuer.type
          : ""
      )) != @bond_issuer_ncd
    )`)
    bindVars.category = 'BOND'
    bindVars.bond_issuer_ncd = 'NCD'
  } else {
    filterConditions.push('((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)')
    bindVars.category = category
  }
}

/**
 * Append GOVT_FD category clause to a string filterClause (branch route style: starts with "FILTER ...")
 */
export function appendCategoryToFilterString(filterClause, bindVars, category) {
  if (!category) return filterClause
  const catUpper = String(category).trim().toUpperCase()
  if (catUpper === 'GOVT_FD') {
    bindVars.category = 'GOVT_FD'
    return `${filterClause} AND ${govtFdCategoryMatchAql()}`
  }
  if (catUpper === 'NCD') {
    bindVars.category = 'NCD'
    bindVars.bond_category = 'BOND'
    bindVars.bond_issuer_type = 'NCD'
    return `${filterClause} AND (
      ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
      OR (
        ((receipt.product != null && receipt.product.category == @bond_category) OR receipt.product_category == @bond_category)
        AND UPPER(TO_STRING(
          (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.type != null)
            ? receipt.product_details.bond.issuer.type
            : ""
        )) == @bond_issuer_type
      )
    )`
  }
  if (catUpper === 'BOND') {
    bindVars.category = 'BOND'
    bindVars.bond_issuer_ncd = 'NCD'
    return `${filterClause} AND (
      ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
      AND UPPER(TO_STRING(
        (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.type != null)
          ? receipt.product_details.bond.issuer.type
          : ""
      )) != @bond_issuer_ncd
    )`
  }
  bindVars.category = category
  return `${filterClause} AND ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)`
}

/**
 * MF txn_type or legacy mode filter (array style)
 */
export function applyMfTxnTypeOrModeFilter(filterConditions, bindVars, txn_type, mode) {
  if (txn_type) {
    const normalizedTxnType = normalizeTxnTypeFromMode(txn_type) || txn_type
    if (isSwitchOverValue(normalizedTxnType)) {
      filterConditions.push(aqlSwitchOverPositiveMatch())
      bindSwitchOverModes(bindVars, 'Switch Over')
    } else {
      filterConditions.push('(receipt.txn_type == @txn_type OR receipt.mode == @mode_fallback OR (receipt.transaction != null AND receipt.transaction.type == @txn_type) OR (receipt.transaction != null AND receipt.transaction.mode == @mode_fallback))')
      bindVars.txn_type = normalizedTxnType
      bindVars.mode_fallback = normalizeModeFallbackFromTxnType(normalizedTxnType)
      filterConditions.push(aqlExcludeSwitchOverClause())
      bindVars.exclude_switch_types = [...EXCLUDE_SWITCH_TYPES]
    }
  } else if (mode) {
    const mappedTxnType = normalizeTxnTypeFromMode(mode)
    if (isSwitchOverValue(mode) || isSwitchOverValue(mappedTxnType)) {
      filterConditions.push(aqlSwitchOverPositiveMatch())
      bindSwitchOverModes(bindVars, mode)
    } else {
      filterConditions.push('(receipt.txn_type == @mapped_txn_type OR receipt.mode == @mode_legacy OR (receipt.transaction != null AND receipt.transaction.type == @mapped_txn_type) OR (receipt.transaction != null AND receipt.transaction.mode == @mode_legacy))')
      bindVars.mapped_txn_type = mappedTxnType
      bindVars.mode_legacy = mode
      filterConditions.push(aqlExcludeSwitchOverClause())
      bindVars.exclude_switch_types = [...EXCLUDE_SWITCH_TYPES]
    }
  }
}

/**
 * Branch-style: append MF filter to filterClause string
 */
export function appendMfTxnTypeToFilterString(filterClause, bindVars, txn_type, mode) {
  if (txn_type) {
    const normalizedTxnType = normalizeTxnTypeFromMode(txn_type) || txn_type
    if (isSwitchOverValue(normalizedTxnType)) {
      bindSwitchOverModes(bindVars, 'Switch Over')
      return `${filterClause} AND ${aqlSwitchOverPositiveMatch()}`
    }
    bindVars.txn_type = normalizedTxnType
    bindVars.mode_fallback = normalizeModeFallbackFromTxnType(normalizedTxnType)
    bindVars.exclude_switch_types = [...EXCLUDE_SWITCH_TYPES]
    return `${filterClause} AND (receipt.txn_type == @txn_type OR receipt.mode == @mode_fallback OR (receipt.transaction != null AND receipt.transaction.type == @txn_type) OR (receipt.transaction != null AND receipt.transaction.mode == @mode_fallback)) AND ${aqlExcludeSwitchOverClause()}`
  }
  if (mode) {
    const mappedTxnType = normalizeTxnTypeFromMode(mode)
    if (isSwitchOverValue(mode) || isSwitchOverValue(mappedTxnType)) {
      bindSwitchOverModes(bindVars, mode)
      return `${filterClause} AND ${aqlSwitchOverPositiveMatch()}`
    }
    bindVars.mapped_txn_type = mappedTxnType
    bindVars.mode_legacy = mode
    bindVars.exclude_switch_types = [...EXCLUDE_SWITCH_TYPES]
    return `${filterClause} AND (receipt.txn_type == @mapped_txn_type OR receipt.mode == @mode_legacy OR (receipt.transaction != null AND receipt.transaction.type == @mapped_txn_type) OR (receipt.transaction != null AND receipt.transaction.mode == @mode_legacy)) AND ${aqlExcludeSwitchOverClause()}`
  }
  return filterClause
}

/**
 * Export route style: append to query string
 */
export function appendExportCategoryQuery(query, bindVars, category) {
  if (!category) return query
  const catUpper = String(category).trim().toUpperCase()
  if (catUpper === 'GOVT_FD') {
    bindVars.category = 'GOVT_FD'
    return `${query} AND ${govtFdCategoryMatchAql()}`
  }
  if (catUpper === 'NCD') {
    bindVars.category = 'NCD'
    bindVars.bond_category = 'BOND'
    bindVars.bond_issuer_type = 'NCD'
    return `${query} AND (
      ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
      OR (
        ((receipt.product != null && receipt.product.category == @bond_category) OR receipt.product_category == @bond_category)
        AND UPPER(TO_STRING(
          (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.type != null)
            ? receipt.product_details.bond.issuer.type
            : ""
        )) == @bond_issuer_type
      )
    )`
  }
  if (catUpper === 'BOND') {
    bindVars.category = 'BOND'
    bindVars.bond_issuer_ncd = 'NCD'
    return `${query} AND (
      ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)
      AND UPPER(TO_STRING(
        (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.type != null)
          ? receipt.product_details.bond.issuer.type
          : ""
      )) != @bond_issuer_ncd
    )`
  }
  bindVars.category = category
  return `${query} AND ((receipt.product != null && receipt.product.category == @category) OR receipt.product_category == @category)`
}

export function appendMfTxnTypeToExportQuery(query, bindVars, txn_type, mode) {
  if (txn_type) {
    const normalizedTxnType = normalizeTxnTypeFromMode(txn_type) || txn_type
    if (isSwitchOverValue(normalizedTxnType)) {
      bindSwitchOverModes(bindVars, 'Switch Over')
      return `${query} AND ${aqlSwitchOverPositiveMatch()}`
    }
    bindVars.txn_type = normalizedTxnType
    bindVars.mode_fallback = normalizeModeFallbackFromTxnType(normalizedTxnType)
    bindVars.exclude_switch_types = [...EXCLUDE_SWITCH_TYPES]
    return `${query} AND (receipt.txn_type == @txn_type OR receipt.mode == @mode_fallback OR (receipt.transaction != null AND receipt.transaction.type == @txn_type) OR (receipt.transaction != null AND receipt.transaction.mode == @mode_fallback)) AND ${aqlExcludeSwitchOverClause()}`
  }
  if (mode) {
    const mappedTxnType = normalizeTxnTypeFromMode(mode)
    if (mode === 'Switch Over' || mode === 'SwitchOver' || mode === 'SWITCH_OVER' || mode === 'switch_over') {
      bindSwitchOverModes(bindVars, mode)
      return `${query} AND ${aqlSwitchOverPositiveMatch()}`
    }
    bindVars.mapped_txn_type = mappedTxnType
    bindVars.mode_legacy = mode
    bindVars.exclude_switch_types = [...EXCLUDE_SWITCH_TYPES]
    return `${query} AND (receipt.txn_type == @mapped_txn_type OR receipt.mode == @mode_legacy OR (receipt.transaction != null AND receipt.transaction.type == @mapped_txn_type) OR (receipt.transaction != null AND receipt.transaction.mode == @mode_legacy)) AND ${aqlExcludeSwitchOverClause()}`
  }
  return query
}
