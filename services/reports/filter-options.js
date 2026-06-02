import { q } from '../../config/database.js'
import { ISSUER_NAME_AQL, MF_SCHEME_CATEGORY_AQL, SCHEME_NAME_AQL } from '../../utils/report-aql-fragments.js'

/**
 * Distinct MF scheme categories for analytics filter dropdowns.
 */
export async function runReportFilterOptions() {
  const fromSchemes = await q(`
    FOR scheme IN mf_schemes
      FILTER scheme.category != null && TO_STRING(scheme.category) != ""
      COLLECT cat = scheme.category
      RETURN cat
  `)

  const fromReceipts = await q(`
    FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      LET cat = ${MF_SCHEME_CATEGORY_AQL}
      FILTER cat != null && TO_STRING(cat) != "" && TO_STRING(cat) != "Unclassified"
      COLLECT category = cat
      RETURN category
  `)

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
      FILTER receipt.is_deleted == false
      LET issuer = ${ISSUER_NAME_AQL}
      FILTER issuer != null && TO_STRING(issuer) != ""
      COLLECT name = TRIM(TO_STRING(issuer))
      RETURN name
  `)

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
      FILTER receipt.is_deleted == false
      LET scheme = ${SCHEME_NAME_AQL}
      FILTER scheme != null && TO_STRING(scheme) != ""
      COLLECT name = TRIM(TO_STRING(scheme))
      RETURN name
  `)

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
