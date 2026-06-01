import { q } from '../../config/database.js'

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
      FILTER receipt.scheme_category != null && TO_STRING(receipt.scheme_category) != ""
      COLLECT cat = receipt.scheme_category
      RETURN cat
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

  return { scheme_categories }
}
