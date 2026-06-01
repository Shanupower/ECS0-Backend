import { q, getUserBranch, normalizeBranchName, getBranchIdentifiersForFilter } from '../../config/database.js'
import { parseBranchCodes, parseEmpCodes } from '../../utils/query-list.js'

async function resolveBranchIdentifiersUnion(branchCodes) {
  const allIds = new Set()
  for (const code of branchCodes) {
    const ids = await getBranchIdentifiersForFilter(code)
    if (ids.length > 0) {
      ids.forEach((id) => allIds.add(id))
    } else {
      const normalized = normalizeBranchName(code) || code
      if (normalized) allIds.add(String(normalized))
    }
  }
  return [...allIds]
}

async function appendAdminBranchFilter(filterConditions, bindVars, branchCodes) {
  const identifiers = await resolveBranchIdentifiersUnion(branchCodes)
  if (identifiers.length > 0) {
    filterConditions.push('receipt.branch IN @branchIdentifiers')
    bindVars.branchIdentifiers = identifiers
  } else {
    filterConditions.push('1 == 0')
  }
}

async function appendAdminEmpFilter(filterConditions, bindVars, user, empCodes) {
  const codes = [...new Set(empCodes.map((c) => String(c).trim()).filter(Boolean))]
  if (!codes.length) return

  const orParts = []
  if (codes.includes(user.emp_code)) {
    orParts.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
    bindVars.user_id = String(user.sub)
    bindVars.emp_code = user.emp_code || ''
  }

  const otherCodes = codes.filter((c) => c !== user.emp_code)
  if (otherCodes.length > 0) {
    const userKeys = await q(
      `
      FOR u IN users
        FILTER u.emp_code IN @emp_codes
        RETURN u._key
    `,
      { emp_codes: otherCodes }
    )
    if (userKeys.length > 0) {
      orParts.push('receipt.user_id IN @filter_user_ids')
      orParts.push('(receipt.emp_code != null && receipt.emp_code IN @filter_emp_codes)')
      bindVars.filter_user_ids = userKeys.map((k) => String(k))
      bindVars.filter_emp_codes = otherCodes
    } else if (!codes.includes(user.emp_code)) {
      filterConditions.push('1 == 0')
      return
    }
  }

  if (orParts.length === 1) {
    filterConditions.push(orParts[0])
  } else if (orParts.length > 1) {
    filterConditions.push(`(${orParts.join(' OR ')})`)
  }
}

/**
 * Build receipt filter conditions mirroring stats/export scoping (no date/status here).
 * @param {object} user - JWT payload (sub, role, emp_code, branch, branch_code)
 * @param {object} query - req.query (viewMode, emp_code, branch_code, include_deleted)
 * @returns {Promise<{ filterConditions: string[], bindVars: Record<string, unknown> }>}
 */
export async function buildReceiptScopeFilter(user, query = {}) {
  const filterConditions = []
  const bindVars = {}
  const viewMode = query.viewMode || query.view_mode
  const branchCodes = parseBranchCodes(query)
  const empCodes = parseEmpCodes(query)
  const hasBranchFilter = branchCodes.length > 0
  const hasEmpFilter = empCodes.length > 0

  if (user.role === 'employee') {
    if (viewMode === 'branch') {
      const userBranch = await getUserBranch(user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch || userBranch
      } else {
        filterConditions.push('1 == 0')
      }
    } else {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(user.sub)
      bindVars.emp_code = user.emp_code || ''
    }
  } else if (user.role === 'manager' || user.role === 'branch') {
    if (viewMode === 'personal') {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(user.sub)
      bindVars.emp_code = user.emp_code || ''
    } else {
      const userBranch = user.role === 'branch' ? (user.branch_code || user.branch) : await getUserBranch(user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch || userBranch
      } else {
        filterConditions.push('1 == 0')
      }
    }
  } else if (user.role === 'admin') {
    if (hasBranchFilter) {
      await appendAdminBranchFilter(filterConditions, bindVars, branchCodes)
    }
    if (hasEmpFilter) {
      await appendAdminEmpFilter(filterConditions, bindVars, user, empCodes)
    }
    if (viewMode === 'branch' && !hasBranchFilter) {
      let userBranch = null
      if (hasEmpFilter) {
        const empBranchRows = await q(
          `
          FOR u IN users
            FILTER u.emp_code IN @emp_codes
            LIMIT 1
            RETURN u.branch
        `,
          { emp_codes: empCodes }
        )
        userBranch = empBranchRows?.[0] ?? null
      }
      if (!userBranch) userBranch = await getUserBranch(user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch
      } else {
        filterConditions.push('1 == 0')
      }
    }
  } else {
    filterConditions.push('1 == 0')
  }

  const includeDeleted = query.include_deleted === '1' || query.includeDeleted === '1'
  if (!(user.role === 'admin' && includeDeleted)) {
    filterConditions.push('receipt.is_deleted == false')
  }

  return { filterConditions, bindVars }
}

/** Completed-only vs inclusive (active pipeline: pending, draft, needs changes, legacy null; exclude terminal failures). */
export function appendReceiptStatusFilter(filterConditions, includePending) {
  if (!includePending) {
    filterConditions.push('receipt.status == "Completed"')
  } else {
    filterConditions.push(
      '(receipt.status == null OR receipt.status NOT IN ["Failed", "Rejected", "Cancelled"])'
    )
  }
}

/**
 * Dashboard status-breakdown bucket.
 * Approval v2 stores team names in receipt.status while in flight — treat those as Pending
 * when current_team_id is set, not "Other".
 */
export const RECEIPT_STATUS_BUCKET_AQL = `(
  receipt.status == "Completed" ? "Completed"
  : receipt.status == "Failed" ? "Failed"
  : receipt.status == "Rejected" ? "Rejected"
  : receipt.status == "Cancelled" ? "Cancelled"
  : receipt.status == "Pending" ? "Pending"
  : receipt.status == "Draft" ? "Pending"
  : receipt.status == "Needs Changes" ? "Pending"
  : receipt.status == null ? "Pending"
  : receipt.current_team_id != null ? "Pending"
  : "Other"
)`

export function parseIncludePending(query = {}) {
  return query.includePending === '1' || query.include_pending === '1'
}
