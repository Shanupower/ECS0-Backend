import { q, getUserBranch, normalizeBranchName, getBranchIdentifiersForFilter } from '../../config/database.js'

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
  const empCodeParam = query.emp_code
  const branchCodeParam = query.branch_code

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
    if (branchCodeParam) {
      const branchIdentifiers = await getBranchIdentifiersForFilter(branchCodeParam)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else {
        filterConditions.push('receipt.branch == @admin_branch')
        bindVars.admin_branch = normalizeBranchName(branchCodeParam) || branchCodeParam
      }
    }
    if (empCodeParam) {
      if (user.emp_code === empCodeParam) {
        filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
        bindVars.user_id = String(user.sub)
        bindVars.emp_code = user.emp_code || ''
      } else {
        const userResult = await q(`
          FOR u IN users
            FILTER u.emp_code == @emp_code
            LIMIT 1
            RETURN u._key
        `, { emp_code: empCodeParam })
        if (userResult.length > 0) {
          filterConditions.push('receipt.user_id == @filter_user_id')
          bindVars.filter_user_id = String(userResult[0])
        } else {
          filterConditions.push('1 == 0')
        }
      }
    }
    if (viewMode === 'branch' && !branchCodeParam) {
      let userBranch = null
      if (empCodeParam) {
        const empBranchRows = await q(`
          FOR u IN users
            FILTER u.emp_code == @emp_code
            LIMIT 1
            RETURN u.branch
        `, { emp_code: empCodeParam })
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

/** Dashboard status-breakdown bucket (maps workflow statuses into Pending). */
export const RECEIPT_STATUS_BUCKET_AQL = `(
  receipt.status == "Completed" ? "Completed"
  : receipt.status == "Pending" ? "Pending"
  : receipt.status == "Draft" ? "Pending"
  : receipt.status == "Needs Changes" ? "Pending"
  : receipt.status == "Failed" ? "Failed"
  : receipt.status == "Rejected" ? "Rejected"
  : receipt.status == "Cancelled" ? "Cancelled"
  : (receipt.status == null ? "Pending" : "Other")
)`

export function parseIncludePending(query = {}) {
  return query.includePending === '1' || query.include_pending === '1'
}
