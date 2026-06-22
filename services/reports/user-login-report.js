import { q } from '../../config/database.js'
import { normalizeQueryDate } from '../../utils/date-basis.js'
import { resolveBranchAliases } from '../../utils/branch-scope.js'
import { parsePagination } from './report-query-builders.js'

const COLLECTION = 'user_login_events'

function parseCsvList(raw) {
  if (!raw) return []
  const s = Array.isArray(raw) ? raw.join(',') : String(raw)
  return s.split(',').map((v) => v.trim()).filter(Boolean)
}

function queryFlag(query, key) {
  const value = query?.[key]
  return value === true || value === '1' || value === 'true'
}

async function buildLoginEventFilters(query) {
  const conditions = []
  const bindVars = {}

  const from = normalizeQueryDate(query.from)
  if (from) {
    conditions.push('event.login_at >= @from')
    bindVars.from = from
  }
  const to = normalizeQueryDate(query.to)
  if (to) {
    conditions.push('event.login_at <= @to')
    bindVars.to = `${to}T23:59:59.999Z`
  }

  const branchCodes = parseCsvList(query.branch_codes || query.branch_code)
  if (branchCodes.length > 0) {
    const aliasSets = await Promise.all(branchCodes.map((c) => resolveBranchAliases(c)))
    const aliases = [...new Set(aliasSets.flat().map((a) => String(a).trim().toUpperCase()).filter(Boolean))]
    if (aliases.length) {
      conditions.push(`(
        (event.branch_code != null && UPPER(TRIM(TO_STRING(event.branch_code))) IN @bAliases)
        OR (event.branch != null && UPPER(TRIM(TO_STRING(event.branch))) IN @bAliases)
      )`)
      bindVars.bAliases = aliases
    } else {
      conditions.push('false')
    }
  }

  const empCodes = parseCsvList(query.emp_codes || query.emp_code)
  if (empCodes.length > 0) {
    conditions.push('event.emp_code IN @emp_codes')
    bindVars.emp_codes = empCodes
  }

  const roles = parseCsvList(query.roles || query.role)
  if (roles.length > 0) {
    conditions.push('event.role IN @roles')
    bindVars.roles = roles
  }

  if (!queryFlag(query, 'include_impersonation') && !queryFlag(query, 'includeImpersonation')) {
    conditions.push(`(event.login_type == null OR event.login_type NOT IN ["impersonation", "backfill"])`)
  }

  if (query.search && String(query.search).trim()) {
    const s = String(query.search).trim()
    conditions.push(`(
      (event.emp_code != null && LIKE(TO_STRING(event.emp_code), CONCAT("%", @search, "%"), true))
      OR (event.user_name != null && LIKE(TO_STRING(event.user_name), CONCAT("%", @search, "%"), true))
    )`)
    bindVars.search = s
  }

  const filterClause = conditions.length > 0 ? `FILTER ${conditions.join(' AND ')}\n` : ''
  return { filterClause, bindVars }
}

export async function runUserLoginReport(_user, query) {
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })
  const { filterClause, bindVars } = await buildLoginEventFilters(query)

  const countQ = `RETURN LENGTH(FOR event IN ${COLLECTION} ${filterClause} RETURN 1)`
  const dataQ = `
    FOR event IN ${COLLECTION}
    ${filterClause}
    SORT event.login_at DESC, event._key DESC
    LIMIT @offset, @limit
    RETURN {
      login_at: event.login_at,
      emp_code: event.emp_code,
      user_name: event.user_name,
      role: event.role,
      branch: event.branch,
      branch_code: event.branch_code,
      login_type: event.login_type,
      ip_address: event.ip_address,
      user_agent: event.user_agent
    }
  `

  const bind = { ...bindVars, offset, limit: pageSize }
  const [countArr, rows] = await Promise.all([q(countQ, bindVars), q(dataQ, bind)])
  const total = typeof countArr[0] === 'number' ? countArr[0] : 0

  return {
    rows,
    total: total || 0,
    totals: { login_count: total || 0 },
    page,
    page_size: pageSize
  }
}
