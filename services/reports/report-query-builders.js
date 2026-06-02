import {
  effectiveDateExprAql,
  normalizeDateForCompareAql,
  normalizeQueryDate
} from '../../utils/date-basis.js'
import { applyReceiptCategoryFilters } from '../../utils/receipt-filters.js'
import { MF_SCHEME_CATEGORY_AQL, ISSUER_NAME_AQL, SCHEME_NAME_AQL } from '../../utils/report-aql-fragments.js'
import {
  parseInvestorIds,
  parseProductCategories,
  parseSchemeCategories,
  parseIssuerNames,
  parseSchemeNames
} from '../../utils/query-list.js'
import { buildReceiptScopeFilter, appendReceiptStatusFilter } from './receipt-scope-filter.js'

/** Investor text search + category / scheme category filters (shared by standard and pending reports). */
export function appendReceiptContentFilters(filterConditions, bindVars, query) {
  const investorIds = parseInvestorIds(query)
  if (investorIds.length > 0) {
    filterConditions.push(`(
      receipt.investor_id IN @investor_ids
      OR (receipt.investor != null && receipt.investor.id IN @investor_ids)
      OR (receipt.investor != null && TO_STRING(receipt.investor.id) IN @investor_ids)
    )`)
    bindVars.investor_ids = investorIds
  } else if (query.search && String(query.search).trim()) {
    const s = String(query.search).trim()
    filterConditions.push(`(
      (receipt.receipt_no != null && LIKE(TO_STRING(receipt.receipt_no), CONCAT("%", @search, "%"), true))
      OR (receipt.investor != null && (
        (receipt.investor.name != null && LIKE(TO_STRING(receipt.investor.name), CONCAT("%", @search, "%"), true))
        OR (receipt.investor.id != null && LIKE(TO_STRING(receipt.investor.id), CONCAT("%", @search, "%"), true))
        OR (receipt.investor.pan != null && LIKE(TO_STRING(receipt.investor.pan), CONCAT("%", @search, "%"), true))
      ))
      OR (receipt.investor_name != null && LIKE(TO_STRING(receipt.investor_name), CONCAT("%", @search, "%"), true))
      OR (receipt.investor_id != null && LIKE(TO_STRING(receipt.investor_id), CONCAT("%", @search, "%"), true))
      OR (receipt.pan != null && LIKE(TO_STRING(receipt.pan), CONCAT("%", @search, "%"), true))
    )`)
    bindVars.search = s
  }

  const productCategories = parseProductCategories(query)
  if (productCategories.length > 0) {
    applyReceiptCategoryFilters(filterConditions, bindVars, productCategories)
  }

  const schemeCategories = parseSchemeCategories(query)
  if (schemeCategories.length > 0) {
    filterConditions.push(`(${MF_SCHEME_CATEGORY_AQL} IN @scheme_categories)`)
    bindVars.scheme_categories = schemeCategories
  }

  const issuerNames = parseIssuerNames(query).map((s) => String(s).trim().toLowerCase())
  if (issuerNames.length > 0) {
    // Normalise to lower-case for consistent matching across receipt sources.
    filterConditions.push(`(LOWER(TRIM(TO_STRING(${ISSUER_NAME_AQL}))) IN @issuer_names)`)
    bindVars.issuer_names = issuerNames
  }

  const schemeNames = parseSchemeNames(query).map((s) => String(s).trim().toLowerCase())
  if (schemeNames.length > 0) {
    filterConditions.push(`(LOWER(TRIM(TO_STRING(${SCHEME_NAME_AQL}))) IN @scheme_names)`)
    bindVars.scheme_names = schemeNames
  }
}

/**
 * Standard receipt report filters: RBAC scope, date range, optional search/category, status.
 */
export async function buildReceiptReportFilters(user, query, options = {}) {
  const {
    // Match receipt list + export when no status is passed: include null / Pending / Completed.
    // Set include_pending=0 or completed_only=1 for stats-style "Completed only" totals.
    includePendingDefault = true,
    skipStatusFilter = false,
    dateExprOverride = null
  } = options

  const { filterConditions: scopeConditions, bindVars } = await buildReceiptScopeFilter(user, query)
  const filterConditions = [...scopeConditions]
  const dateExpr = dateExprOverride || effectiveDateExprAql(query.date_basis || query.dateBasis)
  const dateKey = normalizeDateForCompareAql(dateExpr)

  const from = normalizeQueryDate(query.from)
  if (from) {
    filterConditions.push(`${dateKey} >= @from`)
    bindVars.from = from
  }
  const to = normalizeQueryDate(query.to)
  if (to) {
    filterConditions.push(`${dateKey} <= @to`)
    bindVars.to = to
  }

  if (!skipStatusFilter) {
    const completedOnly =
      query.include_pending === '0' ||
      query.includePending === '0' ||
      query.completed_only === '1' ||
      query.completedOnly === '1'
    const includePendingExplicit =
      query.include_pending === '1' || query.includePending === '1'
    const includePending = completedOnly
      ? false
      : (includePendingExplicit || includePendingDefault)
    appendReceiptStatusFilter(filterConditions, includePending)
  }

  appendReceiptContentFilters(filterConditions, bindVars, query)

  const filterClause =
    filterConditions.length > 0 ? `FILTER ${filterConditions.join(' AND ')}\n` : ''

  return { filterClause, bindVars, dateExpr }
}

export function parsePagination(query, { maxPageSize = 200, defaultPageSize = 25 } = {}) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1)
  const rawSize = parseInt(String(query.page_size || query.pageSize || String(defaultPageSize)), 10)
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.isFinite(rawSize) ? rawSize : defaultPageSize))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function canViewServiceIncome(user) {
  return user?.role === 'admin'
}
