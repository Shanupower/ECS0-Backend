import { effectiveDateExprAql } from '../../utils/date-basis.js'
import { applyReceiptCategoryFilter } from '../../utils/receipt-filters.js'
import { buildReceiptScopeFilter, appendReceiptStatusFilter } from './receipt-scope-filter.js'

/**
 * Standard receipt report filters: RBAC scope, date range, optional search/category, status.
 */
export async function buildReceiptReportFilters(user, query, options = {}) {
  const {
    // Match receipt list + export when no status is passed: include null / Pending / Completed.
    // Set include_pending=0 or completed_only=1 for stats-style "Completed only" totals.
    includePendingDefault = true,
    skipStatusFilter = false
  } = options

  const { filterConditions: scopeConditions, bindVars } = await buildReceiptScopeFilter(user, query)
  const filterConditions = [...scopeConditions]
  const dateExpr = effectiveDateExprAql(query.date_basis || query.dateBasis)

  if (query.from) {
    filterConditions.push(`${dateExpr} >= @from`)
    bindVars.from = query.from
  }
  if (query.to) {
    filterConditions.push(`${dateExpr} <= @to`)
    bindVars.to = query.to
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

  if (query.search && String(query.search).trim()) {
    const s = String(query.search).trim()
    filterConditions.push(`(
      LIKE(receipt.receipt_no, CONCAT("%", @search, "%"), true)
      OR (receipt.investor != null && (
        LIKE(receipt.investor.name, CONCAT("%", @search, "%"), true)
        OR LIKE(receipt.investor.id, CONCAT("%", @search, "%"), true)
        OR LIKE(receipt.investor.pan, CONCAT("%", @search, "%"), true)
      ))
      OR LIKE(receipt.investor_name, CONCAT("%", @search, "%"), true)
      OR LIKE(receipt.investor_id, CONCAT("%", @search, "%"), true)
      OR LIKE(receipt.pan, CONCAT("%", @search, "%"), true)
    )`)
    bindVars.search = s
  }

  const cat = query.product_type || query.category || query.product_category
  if (cat) applyReceiptCategoryFilter(filterConditions, bindVars, cat)

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
