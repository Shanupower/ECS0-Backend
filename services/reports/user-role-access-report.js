import { q } from '../../config/database.js'
import {
  canAccessAnalytics,
  allowedReportFilters,
  defaultReportViewMode,
  scopeLabelForRole
} from '../../constants/report-access.js'
import { resolveBranchAliases } from '../../utils/branch-scope.js'
import { parsePagination } from './report-query-builders.js'

function parseCsvList(raw) {
  if (!raw) return []
  const s = Array.isArray(raw) ? raw.join(',') : String(raw)
  return s.split(',').map((v) => v.trim()).filter(Boolean)
}

function queryFlag(query, key) {
  const value = query?.[key]
  return value === true || value === '1' || value === 'true'
}

const ROLE_CAPABILITIES = {
  admin: {
    analytics_access: true,
    default_report_scope: 'All branches',
    allowed_report_filters: 'branch, employee',
    service_income_visible: true,
    user_management: 'Full (all branches)',
    task_reports: true,
    export_users: true
  },
  manager: {
    analytics_access: true,
    default_report_scope: 'Branch',
    allowed_report_filters: 'employee',
    service_income_visible: false,
    user_management: 'Branch users (limited edit)',
    task_reports: true,
    export_users: false
  },
  branch: {
    analytics_access: true,
    default_report_scope: 'Branch',
    allowed_report_filters: 'employee',
    service_income_visible: false,
    user_management: 'None',
    task_reports: false,
    export_users: false
  },
  employee: {
    analytics_access: true,
    default_report_scope: 'Personal',
    allowed_report_filters: 'None',
    service_income_visible: false,
    user_management: 'Self only',
    task_reports: false,
    export_users: false
  }
}

function userManagementLabel(role) {
  return ROLE_CAPABILITIES[role]?.user_management ?? 'Unknown'
}

function accessForRole(role) {
  const r = String(role || '').trim()
  const caps = ROLE_CAPABILITIES[r] || {}
  const filters = allowedReportFilters(r)
  return {
    analytics_access: canAccessAnalytics(r),
    default_report_scope: caps.default_report_scope || scopeLabelForRole(r),
    allowed_report_filters: filters.length ? filters.join(', ') : 'None',
    service_income_visible: r === 'admin',
    user_management: userManagementLabel(r),
    task_reports: caps.task_reports ?? false,
    export_users: caps.export_users ?? false
  }
}

async function buildUserFilters(query) {
  const conditions = []
  const bindVars = {}

  const branchCodes = parseCsvList(query.branch_codes || query.branch_code)
  if (branchCodes.length > 0) {
    const aliasSets = await Promise.all(branchCodes.map((c) => resolveBranchAliases(c)))
    const aliases = [...new Set(aliasSets.flat().map((a) => String(a).trim().toUpperCase()).filter(Boolean))]
    if (aliases.length) {
      conditions.push(`(
        (user.branch_code != null && UPPER(TRIM(TO_STRING(user.branch_code))) IN @bAliases)
        OR (user.branch != null && UPPER(TRIM(TO_STRING(user.branch))) IN @bAliases)
      )`)
      bindVars.bAliases = aliases
    } else {
      conditions.push('false')
    }
  }

  const roles = parseCsvList(query.roles || query.role)
  if (roles.length > 0) {
    conditions.push('user.role IN @roles')
    bindVars.roles = roles
  }

  const empCodes = parseCsvList(query.emp_codes || query.emp_code)
  if (empCodes.length > 0) {
    conditions.push('user.emp_code IN @emp_codes')
    bindVars.emp_codes = empCodes
  }

  if (queryFlag(query, 'active_only') || queryFlag(query, 'activeOnly')) {
    conditions.push('user.is_active == true')
  }

  if (query.search && String(query.search).trim()) {
    const s = String(query.search).trim()
    conditions.push(`(
      (user.emp_code != null && LIKE(TO_STRING(user.emp_code), CONCAT("%", @search, "%"), true))
      OR (user.name != null && LIKE(TO_STRING(user.name), CONCAT("%", @search, "%"), true))
      OR (user.email != null && LIKE(TO_STRING(user.email), CONCAT("%", @search, "%"), true))
    )`)
    bindVars.search = s
  }

  const filterClause = conditions.length > 0 ? `FILTER ${conditions.join(' AND ')}\n` : ''
  return { filterClause, bindVars }
}

export async function runUserRoleAccessReport(_user, query) {
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 500, defaultPageSize: 50 })
  const { filterClause, bindVars } = await buildUserFilters(query)

  const summaryQ = `
    FOR user IN users
    ${filterClause}
    COLLECT role = user.role
    AGGREGATE user_count = LENGTH(1), active_count = SUM(user.is_active == true ? 1 : 0)
    SORT role ASC
    RETURN { role, user_count, active_count }
  `

  const countQ = `RETURN LENGTH(FOR user IN users ${filterClause} RETURN 1)`
  const dataQ = `
    FOR user IN users
    ${filterClause}
    SORT user.name ASC, user._key ASC
    LIMIT @offset, @limit
    RETURN {
      emp_code: user.emp_code,
      name: user.name,
      email: user.email,
      mobile: user.mobile,
      role: user.role,
      branch: user.branch,
      branch_code: user.branch_code,
      is_active: user.is_active,
      created_at: user.created_at,
      last_login_at: user.last_login_at
    }
  `

  const bind = { ...bindVars, offset, limit: pageSize }
  const [roleSummary, countArr, rawRows] = await Promise.all([
    q(summaryQ, bindVars),
    q(countQ, bindVars),
    q(dataQ, bind)
  ])

  const rows = rawRows.map((u) => {
    const access = accessForRole(u.role)
    return {
      ...u,
      ...access,
      default_report_scope: access.default_report_scope || scopeLabelForRole(u.role)
    }
  })

  const total = typeof countArr[0] === 'number' ? countArr[0] : 0
  const role_matrix = Object.entries(ROLE_CAPABILITIES).map(([role, caps]) => ({
    role,
    ...caps,
    allowed_report_filters: allowedReportFilters(role).join(', ') || 'None',
    default_view_mode: defaultReportViewMode(role) || 'all'
  }))

  return {
    role_summary: roleSummary,
    role_matrix,
    rows,
    total: total || 0,
    page,
    page_size: pageSize
  }
}
