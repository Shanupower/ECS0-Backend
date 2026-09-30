import { q } from '../../config/database.js'
import { buildReceiptScopeFilter } from './receipt-scope-filter.js'
import { applyReceiptCategoryFilters } from '../../utils/receipt-filters.js'
import {
  parseProductCategories,
  parseSchemeCategories,
  parseIssuerNames,
  parseSchemeNames
} from '../../utils/query-list.js'
import { ISSUER_NAME_AQL, MF_SCHEME_CATEGORY_AQL, SCHEME_NAME_AQL } from '../../utils/report-aql-fragments.js'

/**
 * Receipt scope for filter-option dropdowns.
 * @param {object} query
 * @param {{ narrowSchemesByIssuer?: boolean, narrowIssuersByScheme?: boolean, scopeConditions?: string[], scopeBindVars?: Record<string, unknown> }} scope
 */
function buildReceiptOptionsFilter(query = {}, { narrowSchemesByIssuer = false, narrowIssuersByScheme = false, scopeConditions = [], scopeBindVars = {} } = {}) {
  const filterConditions = ['receipt.is_deleted == false', ...scopeConditions]
  const bindVars = { ...scopeBindVars }

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
  if (narrowSchemesByIssuer && issuerNames.length > 0) {
    filterConditions.push(`(LOWER(TRIM(TO_STRING(${ISSUER_NAME_AQL}))) IN @issuer_names)`)
    bindVars.issuer_names = issuerNames
  }

  const schemeNames = parseSchemeNames(query).map((s) => String(s).trim().toLowerCase())
  if (narrowIssuersByScheme && schemeNames.length > 0) {
    filterConditions.push(`(LOWER(TRIM(TO_STRING(${SCHEME_NAME_AQL}))) IN @scheme_names)`)
    bindVars.scheme_names = schemeNames
  }

  return {
    filterClause: `FILTER ${filterConditions.join(' AND ')}\n`,
    bindVars
  }
}

/**
 * Distinct MF scheme categories for analytics filter dropdowns.
 * Optional query params narrow lists:
 * - product_categories: limit issuers/schemes to selected products
 * - issuer_names: when set, scheme_names only includes schemes for those issuers
 * - scheme_names: when set, issuer_names only includes issuers for those schemes
 * @param {object} [user] - JWT user for role-based receipt scoping
 * @param {object} [query]
 */
export async function runReportFilterOptions(user = null, query = {}) {
  const isNfo = query.is_nfo === 'true' || query.is_nfo === true || query.report_slug === 'nfo-report'

  let scopeConditions = []
  let scopeBindVars = {}
  if (user) {
    const scoped = await buildReceiptScopeFilter(user, query)
    scopeConditions = scoped.filterConditions
    scopeBindVars = scoped.bindVars
  }

  const scopeOpts = { scopeConditions, scopeBindVars }
  const issuerScope = buildReceiptOptionsFilter(query, { narrowIssuersByScheme: true, ...scopeOpts })
  const schemeScope = buildReceiptOptionsFilter(query, { narrowSchemesByIssuer: true, ...scopeOpts })
  const categoryScope = buildReceiptOptionsFilter(query, scopeOpts)

  const issuerNames = parseIssuerNames(query).map((s) => String(s).trim().toLowerCase())

  if (isNfo) {
    const nfoFilterAql = `
      LET nfoSchemeCodes = (
        FOR s IN mf_schemes
        FILTER s.is_nfo == true
        RETURN TO_STRING(s.scheme_code)
      )
      FILTER (
        receipt.scheme_is_nfo == true
        OR (receipt.product_details != null && receipt.product_details.mf != null && receipt.product_details.mf.scheme != null && receipt.product_details.mf.scheme.is_nfo == true)
        OR receipt.is_nfo == true
        OR (receipt.scheme_code != null && TO_STRING(receipt.scheme_code) IN nfoSchemeCodes)
        OR (receipt.scheme_name != null && LIKE(TO_STRING(receipt.scheme_name), "%[NFO]%"))
        OR (receipt.scheme_name != null && LIKE(TO_STRING(receipt.scheme_name), "% NFO %"))
      )
    `

    const [schemeAmcs, receiptAmcs, mfNfoSchemes, receiptNfoSchemes] = await Promise.all([
      q(`
        FOR s IN mf_schemes
        FILTER s.is_nfo == true && s.amc_name != null && TO_STRING(s.amc_name) != ""
        COLLECT amc = TRIM(TO_STRING(s.amc_name))
        RETURN amc
      `),
      q(`
        FOR receipt IN receipts
        ${issuerScope.filterClause}
        ${nfoFilterAql}
        LET issuer = ${ISSUER_NAME_AQL}
        FILTER issuer != null && TO_STRING(issuer) != ""
        COLLECT name = TRIM(TO_STRING(issuer))
        RETURN name
      `, issuerScope.bindVars),
      q(`
        FOR s IN mf_schemes
        FILTER s.is_nfo == true
        ${issuerNames.length > 0 ? 'FILTER LOWER(TRIM(TO_STRING(s.amc_name))) IN @issuer_names' : ''}
        LET name = s.display_name != null && s.display_name != "" ? s.display_name : s.scheme_name
        FILTER name != null && TO_STRING(name) != ""
        COLLECT sname = TRIM(TO_STRING(name))
        RETURN sname
      `, issuerNames.length > 0 ? { issuer_names: issuerNames } : {}),
      q(`
        FOR receipt IN receipts
        ${schemeScope.filterClause}
        ${nfoFilterAql}
        LET scheme = ${SCHEME_NAME_AQL}
        FILTER scheme != null && TO_STRING(scheme) != ""
        COLLECT name = TRIM(TO_STRING(scheme))
        RETURN name
      `, schemeScope.bindVars)
    ])

    const seenIssuers = new Set()
    const issuers = []
    for (const raw of [...(schemeAmcs || []), ...(receiptAmcs || [])]) {
      const name = String(raw ?? '').trim()
      if (!name || seenIssuers.has(name)) continue
      seenIssuers.add(name)
      issuers.push(name)
    }
    issuers.sort((a, b) => a.localeCompare(b))

    const seenSchemes = new Set()
    const scheme_names = []
    for (const raw of [...(mfNfoSchemes || []), ...(receiptNfoSchemes || [])]) {
      const name = String(raw ?? '').trim()
      if (!name || seenSchemes.has(name)) continue
      seenSchemes.add(name)
      scheme_names.push(name)
    }
    scheme_names.sort((a, b) => a.localeCompare(b))

    return { scheme_categories: ['Mutual Fund'], issuer_names: issuers, scheme_names }
  }

  const fromSchemes = await q(`
    FOR scheme IN mf_schemes
      FILTER scheme.category != null && TO_STRING(scheme.category) != ""
      COLLECT cat = scheme.category
      RETURN cat
  `)

  const fromReceipts = await q(`
    FOR receipt IN receipts
    ${categoryScope.filterClause}
    LET cat = ${MF_SCHEME_CATEGORY_AQL}
    FILTER cat != null && TO_STRING(cat) != "" && TO_STRING(cat) != "Unclassified"
    COLLECT category = cat
    RETURN category
  `, categoryScope.bindVars)

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
    ${issuerScope.filterClause}
    LET issuer = ${ISSUER_NAME_AQL}
    FILTER issuer != null && TO_STRING(issuer) != ""
    COLLECT name = TRIM(TO_STRING(issuer))
    RETURN name
  `, issuerScope.bindVars)

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
    ${schemeScope.filterClause}
    LET scheme = ${SCHEME_NAME_AQL}
    FILTER scheme != null && TO_STRING(scheme) != ""
    COLLECT name = TRIM(TO_STRING(scheme))
    RETURN name
  `, schemeScope.bindVars)

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
