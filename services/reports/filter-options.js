import { q } from '../../config/database.js'
import { applyReceiptCategoryFilters } from '../../utils/receipt-filters.js'
import { parseProductCategories } from '../../utils/query-list.js'
import { ISSUER_NAME_AQL, MF_SCHEME_CATEGORY_AQL, SCHEME_NAME_AQL } from '../../utils/report-aql-fragments.js'

function buildProductCategoryFilter(query = {}) {
  const productCategories = parseProductCategories(query)
  if (!productCategories.length) return { filterClause: '', bindVars: {} }

  const filterConditions = ['receipt.is_deleted == false']
  const bindVars = {}
  applyReceiptCategoryFilters(filterConditions, bindVars, productCategories)
  return {
    filterClause: `FILTER ${filterConditions.join(' AND ')}\n`,
    bindVars
  }
}

/**
 * Distinct MF scheme categories for analytics filter dropdowns.
 * Optional product_categories narrows issuer/scheme lists to selected products.
 */
export async function runReportFilterOptions(query = {}) {
  const { filterClause: productFilterClause, bindVars: productBindVars } = buildProductCategoryFilter(query)

  const fromSchemes = await q(`
    FOR scheme IN mf_schemes
      FILTER scheme.category != null && TO_STRING(scheme.category) != ""
      COLLECT cat = scheme.category
      RETURN cat
  `)

  const fromReceipts = await q(`
    FOR receipt IN receipts
      ${productFilterClause || 'FILTER receipt.is_deleted == false\n'}
      LET cat = ${MF_SCHEME_CATEGORY_AQL}
      FILTER cat != null && TO_STRING(cat) != "" && TO_STRING(cat) != "Unclassified"
      COLLECT category = cat
      RETURN category
  `, productBindVars)

  const seen = new Set()
  const scheme_categories = []
  for (const raw of [...fromSchemes, ...fromReceipts]) {
    const cat = String(raw ?? '').trim()
    if (!cat || seen.has(cat)) continue
    seen.add(cat)
    scheme_categories.push(cat)
  }
  scheme_categories.sort((a, b) => a.localeCompare(b))

  const fromIssuers = await q(`
    FOR receipt IN receipts
      ${productFilterClause || 'FILTER receipt.is_deleted == false\n'}
      LET issuer = ${ISSUER_NAME_AQL}
      FILTER issuer != null && TO_STRING(issuer) != ""
      COLLECT name = TRIM(TO_STRING(issuer))
      RETURN name
  `, productBindVars)

  const issuers = []
  const seenIssuers = new Set()
  for (const raw of fromIssuers || []) {
    const name = String(raw ?? '').trim()
    if (!name || seenIssuers.has(name)) continue
    seenIssuers.add(name)
    issuers.push(name)
  }
  issuers.sort((a, b) => a.localeCompare(b))

  const fromSchemesNames = await q(`
    FOR receipt IN receipts
      ${productFilterClause || 'FILTER receipt.is_deleted == false\n'}
      LET scheme = ${SCHEME_NAME_AQL}
      FILTER scheme != null && TO_STRING(scheme) != ""
      COLLECT name = TRIM(TO_STRING(scheme))
      RETURN name
  `, productBindVars)

  const scheme_names = []
  const seenSchemes = new Set()
  for (const raw of fromSchemesNames || []) {
    const name = String(raw ?? '').trim()
    if (!name || seenSchemes.has(name)) continue
    seenSchemes.add(name)
    scheme_names.push(name)
  }
  scheme_names.sort((a, b) => a.localeCompare(b))

  return { scheme_categories, issuer_names: issuers, scheme_names }
}
