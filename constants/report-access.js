/** Roles allowed to access Business Analytics (/api/reports/*). */
export const ANALYTICS_ROLES = ['admin', 'manager', 'branch', 'employee']

export function canAccessAnalytics(role) {
  return ANALYTICS_ROLES.includes(String(role || '').trim())
}

/** Default view_mode injected for analytics report queries. */
export function defaultReportViewMode(role) {
  const r = String(role || '').trim()
  if (r === 'employee') return 'personal'
  if (r === 'manager' || r === 'branch') return 'branch'
  return undefined
}

/** Filter keys the role may send in report API queries. */
export function allowedReportFilters(role) {
  const r = String(role || '').trim()
  if (r === 'admin') return ['branch_codes', 'emp_codes']
  if (r === 'manager' || r === 'branch') return ['emp_codes']
  return []
}

export function scopeLabelForRole(role) {
  const r = String(role || '').trim()
  if (r === 'employee') return 'Showing your receipts'
  if (r === 'manager' || r === 'branch') return 'Showing your branch'
  return 'All branches'
}

export function buildRegistryScope(role) {
  const viewMode = defaultReportViewMode(role)
  return {
    view_mode: viewMode || '',
    label: scopeLabelForRole(role),
    allowed_filters: allowedReportFilters(role)
  }
}

/**
 * Sanitize report query params for role-based analytics scoping.
 * Strips disallowed filters and forces view_mode per role.
 * @param {string} role
 * @param {object} query - raw req.query
 * @returns {object} sanitized query copy
 */
export function sanitizeReportQuery(role, query = {}) {
  const out = { ...query }
  const allowed = new Set(allowedReportFilters(role))
  const viewMode = defaultReportViewMode(role)

  if (!allowed.has('branch_codes')) {
    delete out.branch_codes
    delete out.branch_code
  }
  if (!allowed.has('emp_codes')) {
    delete out.emp_codes
    delete out.emp_code
  }

  if (viewMode) {
    out.view_mode = viewMode
    out.viewMode = viewMode
  } else {
    // Admin may use view_mode freely; strip employee/manager forced modes if sent maliciously
    const vm = out.view_mode || out.viewMode
    if (vm === 'personal' || vm === 'branch') {
      // admin can use branch/personal intentionally
    }
  }

  return out
}

/** Admin-only report IDs. */
export const ADMIN_ONLY_REPORT_IDS = ['user-login', 'user-role-access']

/**
 * Whether the role may see/run a report (registry + route guard).
 * @param {string} role
 * @param {{ id?: string, roles?: string[] }} report
 */
export function canAccessReport(role, report) {
  const r = String(role || '').trim()
  const required = report?.roles
  if (Array.isArray(required) && required.length > 0) {
    return required.includes(r)
  }
  return canAccessAnalytics(r)
}

/** Filter registry entries visible to the caller. */
export function filterReportsForRole(reports, role) {
  return (reports || []).filter((entry) => canAccessReport(role, entry))
}

/** Sanitize query for admin user reports (no receipt view_mode forcing). */
export function sanitizeAdminReportQuery(query = {}) {
  return { ...query }
}
