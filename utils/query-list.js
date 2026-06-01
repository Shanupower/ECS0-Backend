/**
 * Parse comma-separated or repeated query params into a deduped string list.
 * @param {object} query - req.query
 * @param {...string} keys - query keys to read (first non-empty wins per key, then merged)
 */
export function parseQueryList(query = {}, ...keys) {
  const seen = new Set()
  const out = []
  for (const key of keys) {
    const raw = query[key]
    if (raw == null || raw === '') continue
    const parts = Array.isArray(raw)
      ? raw.flatMap((v) => String(v).split(','))
      : String(raw).split(',')
    for (const part of parts) {
      const s = part.trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

export function parseBranchCodes(query = {}) {
  return parseQueryList(query, 'branch_codes', 'branch_code')
}

export function parseEmpCodes(query = {}) {
  return parseQueryList(query, 'emp_codes', 'emp_code')
}

export function parseProductCategories(query = {}) {
  return parseQueryList(
    query,
    'product_categories',
    'product_category',
    'product_type',
    'category'
  )
}

export function parseSchemeCategories(query = {}) {
  return parseQueryList(query, 'scheme_categories', 'scheme_category')
}

export function parseInvestorIds(query = {}) {
  return parseQueryList(query, 'investor_ids', 'investor_id')
}
