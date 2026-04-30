import express from 'express'
import { q, getUserBranch, normalizeBranchName, getBranchIdentifiersForFilter, getBranchMonthlyTargetForIdentifiers } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { effectiveDateExprAql } from '../utils/date-basis.js'
import { stateFromPincode } from '../utils/pincode-state.js'
import { INV_AMOUNT_AQL, CC_AQL, SI_AQL } from '../utils/receipt-aggregates.js'

const router = express.Router()

// Category: nested product.category first, then legacy product_category, else "Other"
const CATEGORY_BASE_AQL = `(receipt.product != null && receipt.product.category != null && receipt.product.category != "") ? receipt.product.category : (receipt.product_category != null && receipt.product_category != "" ? receipt.product_category : "Other")`

// Issuer type signal for FD normalization: nested fd issuer type first, then legacy flat `fd_issuer_type`
const FD_ISSUER_TYPE_AQL = `((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.type != null) ? receipt.product_details.fd.issuer.type : receipt.fd_issuer_type)`

// Category normalization in stats grouping: FD + Govt/Post Office issuer → GOVT_FD
const CATEGORY_AQL = `(
  (UPPER(TO_STRING(${CATEGORY_BASE_AQL})) == "FD" && (
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "govt") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "government") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "post office") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "post-office") ||
    CONTAINS(LOWER(TO_STRING(${FD_ISSUER_TYPE_AQL})), "postoffice")
  )) ? "GOVT_FD" : ${CATEGORY_BASE_AQL}
)`

// Get summary statistics
router.get('/summary', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0', date_basis } = req.query
  
  console.log(`[Stats Summary] Request from user: role=${req.user.role}, emp_code=${req.user.emp_code}, sub=${req.user.sub}, query emp_code=${emp_code}`)
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  const dateExpr = effectiveDateExprAql(date_basis)
  if (from) { 
    filterConditions.push(`${dateExpr} >= @from`)
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push(`${dateExpr} <= @to`)
    bindVars.to = to
  }
  // Filter by user_id for employees (personal), by branch for managers/branch users (branch),
  // or by the selected viewMode for supported roles.
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    if (viewMode === 'branch') {
      // Employees in "Branch" view: restrict to their branch receipts.
      const userBranch = await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch || userBranch
      } else {
        // No branch assigned: show zero receipts (do not leak all receipts)
        filterConditions.push('1 == 0')
      }
    } else {
      // Employees: match list scope (receipts by user_id OR emp_code so list and dashboard agree)
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
      console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, emp_code=${bindVars.emp_code}, role=${req.user.role}`)
    }
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
    if (viewMode === 'personal') {
      // Managers in "Personal" view: restrict to their own receipts.
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      // Managers and branch users see only their branch's receipts
      const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch || userBranch
      } else {
        // No branch assigned: show zero receipts (do not leak all receipts)
        filterConditions.push('1 == 0')
      }
    }
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    // For admins viewing personal data
    // Check if viewing own data first (optimization)
    if (req.user.emp_code === emp_code) {
      // Admin viewing their own data - same scope as employee (user_id or emp_code)
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      // Admin viewing another user's data - lookup user_id by emp_code
      const userResult = await q(`
        FOR user IN users
        FILTER user.emp_code == @emp_code
        LIMIT 1
        RETURN user._key
      `, { emp_code })
      
      if (userResult.length > 0) {
        // user_id in receipts is stored as the user's _key
        filterConditions.push('receipt.user_id == @user_id')
        bindVars.user_id = String(userResult[0]) // Ensure it's a string
      } else {
        // If emp_code doesn't match any user, return empty results (security)
        filterConditions.push('1 == 0') // Always false condition
      }
    }
  } else if (viewMode === 'branch') {
    // Branch view:
    // - If admin provides `emp_code`, resolve that employee's branch (so it matches
    //   Admin "Personal" target scope).
    // - Otherwise fall back to the admin's own branch.
    let userBranch = null
    if (emp_code) {
      const empBranchRows = await q(`
        FOR user IN users
        FILTER user.emp_code == @emp_code
        LIMIT 1
        RETURN user.branch
      `, { emp_code })
      userBranch = empBranchRows?.[0] ?? null
    }
    if (!userBranch) userBranch = await getUserBranch(req.user.sub)
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
  } else if (req.user.role !== 'admin') {
    // Non-admin with no matching scope (e.g. unknown role): show zero
    filterConditions.push('1 == 0')
  }
  // For viewMode === 'all' and role === 'admin', no user/branch filter is applied (shows all branches)
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Build base filter (without status)
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  // Include pending transactions if requested
  const includePending = req.query.includePending === '1'

  // Build status filter - applies to totals (counts/amounts) to keep KPIs consistent.
  // Important: Status breakdown should remain visible for failed/rejected records even
  // when includePending is false, so status breakdown will use a different filter below.
  let statusFilterConditions = []
  if (!includePending) {
    // Only include completed receipts when includePending is false
    statusFilterConditions.push('receipt.status == "Completed"')
  } else {
    // When includePending is true, include both "Completed" and "Pending" statuses
    // Also include null for legacy receipts that may not have status set
    statusFilterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
  }
  
  // Combine base filter with status filter for all queries (total_receipts and investment amounts)
  let allFilterConditions = [...filterConditions, ...statusFilterConditions]
  let allFilterClause = ''
  if (allFilterConditions.length > 0) {
    allFilterClause = `FILTER ${allFilterConditions.join(' AND ')}\n`
  }
  
  // Query for total receipts count - now respects includePending toggle
  // By default (includePending=false): only counts "Completed" receipts
  // When includePending=true: counts both "Completed" and "Pending" receipts
  const receiptsCountQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT AGGREGATE total_receipts = LENGTH(1)
    RETURN { total_receipts }
  `
  
  // Debug logging
  console.log(`[Stats Summary] User: ${req.user.emp_code || req.user.sub}, Role: ${req.user.role}, ViewMode: ${viewMode || 'none'}`)
  console.log(`[Stats Summary] Filter conditions (${filterConditions.length}):`, filterConditions)
  console.log(`[Stats Summary] Bind vars:`, JSON.stringify(bindVars))
  console.log(`[Stats Summary] Filter clause:`, filterClause.trim() || '(no filter)')
  
  // For managers, also check what branch values exist in receipts (debug only)
  if (req.user.role === 'manager' && bindVars.branch) {
    const branchCheckQuery = `
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      COLLECT branch = receipt.branch WITH COUNT INTO count
      FILTER branch != null
      SORT count DESC
      LIMIT 10
      RETURN { branch, count }
    `
    try {
      const branchStats = await q(branchCheckQuery)
      console.log(`[Stats Summary] Available branch values in receipts:`, branchStats)
      console.log(`[Stats Summary] Manager is looking for branch:`, bindVars.branch || bindVars)
    } catch (err) {
      console.error(`[Stats Summary] Error checking branch stats:`, err.message)
    }
  }
  
  // Query for investment amounts (with status filter) - same amount formula as by-category/by-day
  const totalsQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT AGGREGATE 
      total_collections = SUM(${INV_AMOUNT_AQL}),
      total_cc = SUM(${CC_AQL}),
      total_si = SUM(${SI_AQL})
    RETURN { total_collections, total_cc, total_si }
  `
  
  const byCatQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    LET cat = ${CATEGORY_AQL}
    COLLECT category = cat
    AGGREGATE n = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL})
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const byDayQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT date = ${dateExpr}
    AGGREGATE n = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL})
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  // Status counts: include failed/rejected/cancelled categories even when includePending=false.
  // When includePending=false we exclude only Pending/null, but still include all other statuses.
  // This keeps the "Status breakdown" widget informative.
  const statusCountsFilterConditions = [...filterConditions]
  if (!includePending) {
    statusCountsFilterConditions.push('receipt.status != "Pending" AND receipt.status != null')
  }
  const statusCountsFilterClause = statusCountsFilterConditions.length > 0
    ? `FILTER ${statusCountsFilterConditions.join(' AND ')}\n`
    : ''

  const statusCountsQuery = `
    FOR receipt IN receipts
    ${statusCountsFilterClause}
    COLLECT status = (
      receipt.status == "Completed" ? "Completed"
      : receipt.status == "Pending" ? "Pending"
      : receipt.status == "Failed" ? "Failed"
      : receipt.status == "Rejected" ? "Rejected"
      : receipt.status == "Cancelled" ? "Cancelled"
      : (receipt.status == null ? "Pending" : "Other")
    )
    WITH COUNT INTO count
    RETURN { status, count }
  `
  
  const [receiptsCount, totals, byCat, byDay, statusCountsResult] = await Promise.all([
    q(receiptsCountQuery, bindVars),
    q(totalsQuery, bindVars),
    q(byCatQuery, bindVars),
    q(byDayQuery, bindVars),
    q(statusCountsQuery, bindVars)
  ])
  
  const totalReceipts = receiptsCount[0]?.total_receipts || 0
  const totalCollections = totals[0]?.total_collections || 0
  const totalCC = totals[0]?.total_cc || 0
  const totalSI = totals[0]?.total_si || 0
  
  const status_counts = { Pending: 0, Completed: 0, Failed: 0, Rejected: 0, Cancelled: 0, Other: 0 }
  for (const row of statusCountsResult) {
    status_counts[row.status] = row.count
  }
  
  // Get total customers count - show ALL customers in the branch, not just those with receipts
  let customersQuery = ''
  let customersBindVars = {}
  
  // Determine viewMode for customer filtering (default to 'personal' if emp_code provided, 'all' otherwise)
  const customerViewMode = viewMode || (emp_code ? 'personal' : 'all')
  
  if (req.user.role === 'admin') {
    if (emp_code) {
      // Personal view: Get the employee's branch and show all customers in that branch
      const empUser = await q(`
        FOR user IN users
        FILTER user.emp_code == @emp_code
        LIMIT 1
        RETURN user.branch
      `, { emp_code })
      
      if (empUser.length > 0 && empUser[0]) {
        const empBranch = empUser[0]
        const branchIdentifiers = await getBranchIdentifiersForFilter(empBranch)
        if (branchIdentifiers.length > 0) {
          customersQuery = `
            FOR customer IN customers
            FILTER (IS_ARRAY(customer.branches) && LENGTH(INTERSECTION(customer.branches, @branchIdentifiers)) > 0)
               OR (customer.relationship_manager != null AND (
                 (IS_ARRAY(customer.relationship_manager) && LENGTH(INTERSECTION(customer.relationship_manager, @branchIdentifiers)) > 0)
                 OR (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager IN @branchIdentifiers)
               ))
            RETURN LENGTH(1)
          `
          customersBindVars.branchIdentifiers = branchIdentifiers
        } else {
          const normalizedEmpBranch = normalizeBranchName(empBranch)
          if (normalizedEmpBranch || empBranch) {
            const ub = normalizedEmpBranch || empBranch
            customersQuery = `
              FOR customer IN customers
              FILTER customer.relationship_manager == @userBranch
                 OR (customer.relationship_manager != null AND IS_ARRAY(customer.relationship_manager) AND @userBranch IN customer.relationship_manager)
              RETURN LENGTH(1)
            `
            customersBindVars.userBranch = ub
          } else {
            customersQuery = `
              FOR customer IN customers
              RETURN LENGTH(1)
            `
          }
        }
      } else {
        // Employee not found, show all customers
        customersQuery = `
          FOR customer IN customers
          RETURN LENGTH(1)
        `
      }
    } else if (customerViewMode === 'branch') {
      // Branch view: same scope as managers — customers linked via branches[] or relationship_manager (codes/keys/names).
      const userBranch = await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        customersQuery = `
          FOR customer IN customers
          FILTER (IS_ARRAY(customer.branches) && LENGTH(INTERSECTION(customer.branches, @branchIdentifiers)) > 0)
             OR (customer.relationship_manager != null AND (
               (IS_ARRAY(customer.relationship_manager) && LENGTH(INTERSECTION(customer.relationship_manager, @branchIdentifiers)) > 0)
               OR (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager IN @branchIdentifiers)
             ))
          RETURN LENGTH(1)
        `
        customersBindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        customersQuery = `
          FOR customer IN customers
          FILTER customer.relationship_manager == @userBranch
             OR (customer.relationship_manager != null AND IS_ARRAY(customer.relationship_manager) AND @userBranch IN customer.relationship_manager)
          RETURN LENGTH(1)
        `
        customersBindVars.userBranch = normalizedUserBranch || userBranch
      } else {
        customersQuery = `
          FOR customer IN customers
          FILTER customer.relationship_manager == null
          RETURN LENGTH(1)
        `
      }
    } else {
      // All branches view: Show all customers
      customersQuery = `
        FOR customer IN customers
        RETURN LENGTH(1)
      `
    }
  } else {
    // Non-admin users see only their branch customers (branch role uses token branch; manager uses getUserBranch)
    const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    
    if (branchIdentifiers.length > 0) {
      // Match customer.branches (keys) or relationship_manager (key/code/name) to branch identifiers
      customersQuery = `
        FOR customer IN customers
        FILTER (IS_ARRAY(customer.branches) && LENGTH(INTERSECTION(customer.branches, @branchIdentifiers)) > 0)
           OR (customer.relationship_manager != null AND (
             (IS_ARRAY(customer.relationship_manager) && LENGTH(INTERSECTION(customer.relationship_manager, @branchIdentifiers)) > 0)
             OR (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager IN @branchIdentifiers)
           ))
        RETURN LENGTH(1)
      `
      customersBindVars.branchIdentifiers = branchIdentifiers
    } else if (normalizedUserBranch || userBranch) {
      customersQuery = `
        FOR customer IN customers
        FILTER customer.relationship_manager == @userBranch
           OR (customer.relationship_manager != null AND IS_ARRAY(customer.relationship_manager) AND @userBranch IN customer.relationship_manager)
        RETURN LENGTH(1)
      `
      customersBindVars.userBranch = normalizedUserBranch || userBranch
    } else {
      customersQuery = `
        FOR customer IN customers
        FILTER customer.relationship_manager == null
        RETURN LENGTH(1)
      `
    }
  }
  
  const customersResult = await q(customersQuery, customersBindVars)
  const totalCustomers = customersResult.length

  const response = {
    total_receipts: Number(totalReceipts),
    total_investments: Number(totalCollections),
    total_customers: totalCustomers,
    collection_credit_earned: Number(totalCC),
    commissions_total: Number(totalCC), // Alias so widgets show same value
    by_category: byCat,
    by_day: byDay,
    status_counts
  }
  
  // Only include service_income_earned for admins
  if (req.user.role === 'admin') {
    response.service_income_earned = Number(totalSI)
  }
  
  // Branch monthly target (single value on branches collection) for the viewer's branch context
  if (!(req.user.role === 'admin' && viewMode === 'all')) {
    let branchRef = null
    if (req.user.role === 'branch') {
      branchRef = req.user.branch_code || req.user.branch || null
    } else if (req.user.role === 'employee' || req.user.role === 'manager') {
      const me = await q(`
        FOR user IN users FILTER user._key == @id LIMIT 1 RETURN { branch_code: user.branch_code, branch: user.branch }
      `, { id: req.user.sub })
      branchRef = me[0] ? (me[0].branch_code || me[0].branch) : null
      if (!branchRef && req.user.role === 'manager') branchRef = await getUserBranch(req.user.sub)
    } else if (req.user.role === 'admin') {
      if (viewMode === 'branch') {
        branchRef = await getUserBranch(req.user.sub)
      } else {
        const qEmp = emp_code
        if (qEmp) {
          if (req.user.emp_code === qEmp) {
            branchRef = await getUserBranch(req.user.sub)
          } else {
            const rows = await q(`
              FOR user IN users FILTER user.emp_code == @e LIMIT 1
              RETURN { branch_code: user.branch_code, branch: user.branch }
            `, { e: qEmp })
            branchRef = rows[0] ? (rows[0].branch_code || rows[0].branch) : null
          }
        } else {
          branchRef = await getUserBranch(req.user.sub)
        }
      }
    }

    if (branchRef) {
      const branchIdentifiers = await getBranchIdentifiersForFilter(branchRef)
      if (branchIdentifiers.length > 0) {
        const t = await getBranchMonthlyTargetForIdentifiers(branchIdentifiers)
        response.branch_target = t != null ? t : null
      }
    }
  }

  // Personal target (optional, stored on users) for personal dashboards/reports.
  // Pool split allocation:
  // - If personal target is set, use it.
  // - Else allocate the remaining branch target equally among active branch users without a personal target.
  const isPersonalScope =
    viewMode === 'personal' ||
    (req.user.role === 'employee' && viewMode !== 'branch') ||
    ((req.user.role === 'manager' || req.user.role === 'branch') && viewMode === 'personal') ||
    (req.user.role === 'admin' && emp_code && (viewMode === 'personal' || !viewMode))

  if (isPersonalScope) {
    let personalTarget = null
    let personalUserId = null
    if (req.user.role === 'admin') {
      // Admin personal view: resolve by emp_code when provided; otherwise current user (e.g. admin without emp_code).
      const rows = emp_code
        ? await q(`
            FOR user IN users
              FILTER user.emp_code == @e
              LIMIT 1
              RETURN { id: user._key, personal_monthly_target: user.personal_monthly_target }
          `, { e: emp_code })
        : await q(`
            FOR user IN users
              FILTER user._key == @id
              LIMIT 1
              RETURN { id: user._key, personal_monthly_target: user.personal_monthly_target }
          `, { id: req.user.sub })
      if (rows.length > 0) {
        personalUserId = rows[0]?.id ?? null
        personalTarget = rows[0]?.personal_monthly_target != null ? Number(rows[0].personal_monthly_target) : null
      }
    } else {
      // Non-admin personal view: resolve current user by _key.
      const rows = await q(`
        FOR user IN users
          FILTER user._key == @id
          LIMIT 1
          RETURN { id: user._key, personal_monthly_target: user.personal_monthly_target }
      `, { id: req.user.sub })
      if (rows.length > 0) {
        personalUserId = rows[0]?.id ?? null
        personalTarget = rows[0]?.personal_monthly_target != null ? Number(rows[0].personal_monthly_target) : null
      }
    }
    response.personal_target = personalTarget

    if (personalTarget != null) {
      response.effective_target = personalTarget
    } else {
      // Compute allocated target from remaining pool for this branch.
      // We rely on the branchRef logic above which scoped branch_target.
      // If branch_target is missing, allocation is not possible.
      const branchTarget = response.branch_target != null ? Number(response.branch_target) : null
      if (branchTarget != null && Number.isFinite(branchTarget) && branchTarget > 0) {
        // Resolve this user's branch ref for allocation.
        let branchRef = null
        if (req.user.role === 'admin') {
          // For admin personal view, prefer the selected user's branch.
          if (personalUserId) {
            const rows = await q(`
              FOR u IN users
                FILTER u._key == @id
                LIMIT 1
                RETURN { branch_code: u.branch_code, branch: u.branch }
            `, { id: personalUserId })
            branchRef = rows[0] ? (rows[0].branch_code || rows[0].branch) : null
          }
        } else if (req.user.role === 'employee' || req.user.role === 'manager' || req.user.role === 'branch') {
          const rows = await q(`
            FOR u IN users
              FILTER u._key == @id
              LIMIT 1
              RETURN { branch_code: u.branch_code, branch: u.branch }
          `, { id: req.user.sub })
          branchRef = rows[0] ? (rows[0].branch_code || rows[0].branch) : null
        }

        if (branchRef) {
          const branchIdentifiers = await getBranchIdentifiersForFilter(branchRef)
          const ids = (branchIdentifiers?.length ? branchIdentifiers : [branchRef]).map((x) => String(x))

          const allocRows = await q(
            `
            LET sumPersonal = FIRST(
              FOR u IN users
                FILTER u.is_active == true
                  AND u.personal_monthly_target != null
                  AND u.personal_monthly_target != ""
                  AND (
                    (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
                    OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
                  )
                COLLECT AGGREGATE total = SUM(TO_NUMBER(u.personal_monthly_target))
                RETURN total
            )
            LET unsetCount = FIRST(
              FOR u IN users
                FILTER u.is_active == true
                  AND (u.personal_monthly_target == null OR u.personal_monthly_target == "")
                  AND (
                    (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
                    OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
                  )
                COLLECT AGGREGATE c = LENGTH(1)
                RETURN c
            )
            RETURN { sumPersonal: sumPersonal || 0, unsetCount: unsetCount || 0 }
          `,
            { ids }
          )

          const sumPersonal = Number(allocRows?.[0]?.sumPersonal || 0)
          const unsetCount = Number(allocRows?.[0]?.unsetCount || 0)
          const remainingPool = branchTarget - sumPersonal
          const allocatedTarget = unsetCount > 0 ? remainingPool / unsetCount : null

          response.sum_personal_targets = sumPersonal
          response.unset_count = unsetCount
          response.remaining_pool = remainingPool
          response.allocated_target = allocatedTarget
          response.effective_target = allocatedTarget
        } else {
          response.effective_target = null
        }
      } else {
        response.effective_target = null
      }
    }
  }
  
  res.json(response)
})

// Get statistics by category
router.get('/by-category', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0', date_basis } = req.query
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  const dateExpr = effectiveDateExprAql(date_basis)
  if (from) { 
    filterConditions.push(`${dateExpr} >= @from`)
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push(`${dateExpr} <= @to`)
    bindVars.to = to
  }
  // Filter by user_id for employees (personal), by branch for managers/branch users (branch),
  // or by the selected viewMode for supported roles.
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    if (viewMode === 'branch') {
      // Employees in "Branch" view: restrict to their branch receipts.
      const userBranch = await getUserBranch(req.user.sub)
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
      // Employees: match list scope (receipts by user_id OR emp_code so list and dashboard agree)
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
      console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, emp_code=${bindVars.emp_code}, role=${req.user.role}`)
    }
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
    if (viewMode === 'personal') {
      // Managers in "Personal" view: restrict to their own receipts.
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
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
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    // For admins viewing personal data
    // Check if viewing own data first (optimization)
    if (req.user.emp_code === emp_code) {
      // Admin viewing their own data - same scope as employee (user_id or emp_code)
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      // Admin viewing another user's data - lookup user_id by emp_code
      const userResult = await q(`
        FOR user IN users
        FILTER user.emp_code == @emp_code
        LIMIT 1
        RETURN user._key
      `, { emp_code })
      
      if (userResult.length > 0) {
        // user_id in receipts is stored as the user's _key
        filterConditions.push('receipt.user_id == @user_id')
        bindVars.user_id = String(userResult[0]) // Ensure it's a string
      } else {
        // If emp_code doesn't match any user, return empty results (security)
        filterConditions.push('1 == 0') // Always false condition
      }
    }
  } else if (viewMode === 'branch') {
    // Branch view: filter by the admin's branch (match key, code, or name)
    const userBranch = await getUserBranch(req.user.sub)
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
  } else if (req.user.role !== 'admin') {
    filterConditions.push('1 == 0')
  }
  // For viewMode === 'all', no user/branch filter is applied (shows all branches)
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Include pending transactions if requested
  const includePending = req.query.includePending === '1'
  if (!includePending) {
    // Only include completed receipts when includePending is false
    filterConditions.push('receipt.status == "Completed"')
  } else {
    // When includePending is true, include both "Completed" and "Pending" statuses
    // Also include null for legacy receipts that may not have status set
    filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
  }
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const amountExpr = INV_AMOUNT_AQL
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    COLLECT category = cat
    AGGREGATE n = LENGTH(1), amount = SUM(${amountExpr})
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
})

// Get statistics by day
router.get('/by-day', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0', date_basis } = req.query
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  const dateExpr = effectiveDateExprAql(date_basis)
  if (from) { 
    filterConditions.push(`${dateExpr} >= @from`)
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push(`${dateExpr} <= @to`)
    bindVars.to = to
  }
  // Filter by user_id for employees (personal), by branch for managers/branch users (branch),
  // or by the selected viewMode for supported roles.
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    if (viewMode === 'branch') {
      // Employees in "Branch" view: restrict to their branch receipts.
      const userBranch = await getUserBranch(req.user.sub)
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
      // Employees: match list scope (receipts by user_id OR emp_code so list and dashboard agree)
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
      console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, emp_code=${bindVars.emp_code}, role=${req.user.role}`)
    }
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
    if (viewMode === 'personal') {
      // Managers in "Personal" view: restrict to their own receipts.
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
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
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    // For admins viewing personal data
    // Check if viewing own data first (optimization)
    if (req.user.emp_code === emp_code) {
      // Admin viewing their own data - same scope as employee (user_id or emp_code)
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      // Admin viewing another user's data - lookup user_id by emp_code
      const userResult = await q(`
        FOR user IN users
        FILTER user.emp_code == @emp_code
        LIMIT 1
        RETURN user._key
      `, { emp_code })
      
      if (userResult.length > 0) {
        // user_id in receipts is stored as the user's _key
        filterConditions.push('receipt.user_id == @user_id')
        bindVars.user_id = String(userResult[0]) // Ensure it's a string
      } else {
        // If emp_code doesn't match any user, return empty results (security)
        filterConditions.push('1 == 0') // Always false condition
      }
    }
  } else if (viewMode === 'branch') {
    // Branch view: filter by the admin's branch (match key, code, or name)
    const userBranch = await getUserBranch(req.user.sub)
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
  } else if (req.user.role !== 'admin') {
    filterConditions.push('1 == 0')
  }
  // For viewMode === 'all', no user/branch filter is applied (shows all branches)
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Include pending transactions if requested
  const includePending = req.query.includePending === '1'
  if (!includePending) {
    // Only include completed receipts when includePending is false
    filterConditions.push('receipt.status == "Completed"')
  } else {
    // When includePending is true, include both "Completed" and "Pending" statuses
    // Also include null for legacy receipts that may not have status set
    filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
  }
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const amountExpr = INV_AMOUNT_AQL
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = ${dateExpr}
    AGGREGATE n = LENGTH(1), amount = SUM(${amountExpr})
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
})

// Get monthly CC and SI trend (for dashboard widget)
router.get('/monthly-cc-si', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0', date_basis } = req.query
  const viewMode = req.query.viewMode
  let filterConditions = []
  const bindVars = {}
  const dateExpr = effectiveDateExprAql(date_basis)
  if (from) { filterConditions.push(`${dateExpr} >= @from`); bindVars.from = from }
  if (to) { filterConditions.push(`${dateExpr} <= @to`); bindVars.to = to }
  if (req.user.role === 'employee') {
    if (viewMode === 'branch') {
      const userBranch = await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch || userBranch
      } else { filterConditions.push('1 == 0') }
    } else {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    }
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
    if (viewMode === 'personal') {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalizedUserBranch = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizedUserBranch || userBranch
      } else { filterConditions.push('1 == 0') }
    }
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    if (req.user.emp_code === emp_code) {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else {
      const userResult = await q('FOR user IN users FILTER user.emp_code == @emp_code LIMIT 1 RETURN user._key', { emp_code })
      if (userResult.length) {
        filterConditions.push('receipt.user_id == @user_id')
        bindVars.user_id = String(userResult[0])
      } else { filterConditions.push('1 == 0') }
    }
  } else if (viewMode === 'branch') {
    const userBranch = await getUserBranch(req.user.sub)
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    if (branchIdentifiers.length > 0) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIdentifiers
    } else if (userBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizeBranchName(userBranch)
    } else { filterConditions.push('1 == 0') }
  } else if (req.user.role !== 'admin') { filterConditions.push('1 == 0') }
  if (includeDeleted !== '1') filterConditions.push('receipt.is_deleted == false')
  const includePending = req.query.includePending === '1'
  if (includePending) filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
  else filterConditions.push('receipt.status == "Completed"')
  const filterClause = filterConditions.length ? `FILTER ${filterConditions.join(' AND ')}` : ''
  const monthExpr = `SUBSTRING(${dateExpr}, 0, 7)`
  const qry = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT month = ${monthExpr}
    AGGREGATE cc = SUM(${CC_AQL}), si = SUM(${SI_AQL})
    SORT month ASC
    RETURN { month, cc, si }
  `
  const rows = await q(qry, bindVars)
  res.json(rows.map(r => ({ month: r.month, cc: Number(r.cc), si: Number(r.si) })))
})

// Get branch statistics
router.get('/branches', requireAuth, async (req, res) => {
  try {
    const { from, to, includeDeleted = '0', date_basis } = req.query
    
    let dateFilter = ''
    let bindVars = {}
    let filterConditions = []
    
    const receiptDateExpr = effectiveDateExprAql(date_basis)
    if (from && to) {
      filterConditions.push(`${receiptDateExpr} >= @from AND ${receiptDateExpr} <= @to`)
      bindVars.from = from
      bindVars.to = to
    }
    
    if (includeDeleted !== '1') {
      filterConditions.push('receipt.is_deleted == false')
    }
    // Include pending transactions if requested (same logic as summary)
    const includePending = req.query.includePending === '1'
    if (!includePending) {
      filterConditions.push('receipt.status == "Completed"')
    } else {
      filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
    }
    
    if (filterConditions.length > 0) {
      dateFilter = `FILTER ${filterConditions.join(' AND ')}\n`
    }
    
    // Get branch performance statistics - same amount/cc/si formula as summary for consistency
    const amountExpr = INV_AMOUNT_AQL
    const branchStatsQuery = `
      FOR receipt IN receipts
      ${dateFilter}
      COLLECT branch = receipt.branch 
      AGGREGATE 
        receipt_count = LENGTH(1), 
        total_investments = SUM(${amountExpr}),
        total_cc = SUM(${CC_AQL}),
        total_si = SUM(${SI_AQL})
      SORT total_investments DESC
      RETURN {
        branch,
        total_receipts: receipt_count,
        total_investments,
        total_cc,
        total_si
      }
    `
    
    const branchStats = await q(branchStatsQuery, bindVars)

    const employeeStatsQuery = `
      FOR user IN users
        FILTER user.is_active == true AND user.branch != null
        COLLECT branch = user.branch WITH COUNT INTO employee_count
        RETURN { branch, employee_count }
    `
    const employeeStats = await q(employeeStatsQuery)

    // Sum of personal monthly targets per branch (employees/managers/admins with a branch set).
    // Used for admin-only "include personal targets" toggle in Branch Performance Overview.
    const personalTargetByBranchQuery = `
      FOR user IN users
        FILTER user.is_active == true
          AND user.branch != null
          AND user.personal_monthly_target != null
          AND user.personal_monthly_target != ""
        COLLECT branch = user.branch
        AGGREGATE total_personal_target = SUM(TO_NUMBER(user.personal_monthly_target))
        RETURN { branch, total_personal_target }
    `
    const personalTargetByBranch = await q(personalTargetByBranchQuery)

    const branchDocs = await q(`
      FOR b IN branches
        RETURN { key: b._key, code: b.branch_code, name: b.branch_name, monthly_target: b.monthly_target }
    `)

    const numOrNull = (v) => {
      if (v == null || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const monthlyTargetForReceiptBranch = (receiptBranch) => {
      if (receiptBranch == null || receiptBranch === '') return null
      const s = String(receiptBranch).trim()
      const lower = s.toLowerCase()
      for (const b of branchDocs) {
        if (b.key != null && String(b.key).trim() === s) return numOrNull(b.monthly_target)
        if (b.code != null && String(b.code).trim().toLowerCase() === lower) return numOrNull(b.monthly_target)
        if (b.name != null && String(b.name).trim().toLowerCase() === lower) return numOrNull(b.monthly_target)
      }
      return null
    }
    const resolveBranchDoc = (receiptBranch) => {
      if (receiptBranch == null || receiptBranch === '') return null
      const s = String(receiptBranch).trim()
      const lower = s.toLowerCase()
      for (const b of branchDocs) {
        if (b.key != null && String(b.key).trim() === s) return b
        if (b.code != null && String(b.code).trim().toLowerCase() === lower) return b
        if (b.name != null && String(b.name).trim().toLowerCase() === lower) return b
      }
      return null
    }

    const personalTargetForBranchRef = (branchRef) => {
      const branchDoc = resolveBranchDoc(branchRef)
      const s = String(branchRef || '').trim()
      const lower = s.toLowerCase()
      let total = 0
      for (const row of personalTargetByBranch || []) {
        const rb = row?.branch
        if (rb == null || rb === '') continue
        const rDoc = resolveBranchDoc(rb)
        const rs = String(rb).trim()
        const rLower = rs.toLowerCase()
        const matches =
          (branchDoc?.key != null && rDoc?.key != null && String(branchDoc.key).trim() === String(rDoc.key).trim()) ||
          (branchDoc?.code != null && rDoc?.code != null && String(branchDoc.code).trim().toLowerCase() === String(rDoc.code).trim().toLowerCase()) ||
          (branchDoc?.name != null && rDoc?.name != null && String(branchDoc.name).trim().toLowerCase() === String(rDoc.name).trim().toLowerCase()) ||
          (s && (rs === s || rLower === lower))
        if (!matches) continue
        const n = Number(row.total_personal_target)
        if (Number.isFinite(n)) total += n
      }
      return total
    }

    // Merge stats that belong to the same logical branch (raw branch value may be key/code/name).
    const mergedByBranch = new Map()
    branchStats.forEach((branch) => {
      const branchDoc = resolveBranchDoc(branch.branch)
      const aggregateKey = branchDoc?.key || branchDoc?.code || String(branch.branch || '').trim() || 'unknown'
      const key = String(aggregateKey).toLowerCase()
      const existing = mergedByBranch.get(key) || {
        branch: branchDoc?.name || branch.branch || 'Unknown Branch',
        branch_name: branchDoc?.name || branch.branch || 'Unknown Branch',
        branch_code: branchDoc?.code || branch.branch || null,
        total_receipts: 0,
        total_investments: 0,
        total_cc: 0,
        total_si: 0
      }
      existing.total_receipts += Number(branch.total_receipts || 0)
      existing.total_investments += Number(branch.total_investments || 0)
      existing.total_cc += Number(branch.total_cc || 0)
      existing.total_si += Number(branch.total_si || 0)
      mergedByBranch.set(key, existing)
    })

    // Include every configured branch even when there are no receipts in range, so the overview
    // and target totals reflect all branches (not only those with activity this period).
    branchDocs.forEach((b) => {
      if (b == null) return
      const aggregateKey = b.key || b.code || String(b.name || '').trim()
      if (!aggregateKey) return
      const key = String(aggregateKey).toLowerCase()
      if (mergedByBranch.has(key)) return
      mergedByBranch.set(key, {
        branch: b.name || b.code || b.key || 'Unknown Branch',
        branch_name: b.name || b.code || b.key || 'Unknown Branch',
        branch_code: b.code || null,
        total_receipts: 0,
        total_investments: 0,
        total_cc: 0,
        total_si: 0
      })
    })

    const mergedStats = Array.from(mergedByBranch.values()).map((branch) => {
      const employeeData = employeeStats.find((emp) => String(emp.branch || '').trim().toLowerCase() === String(branch.branch_name || '').trim().toLowerCase())
      const tgt = monthlyTargetForReceiptBranch(branch.branch_code || branch.branch_name || branch.branch)
      const personalTgt = personalTargetForBranchRef(branch.branch_code || branch.branch_name || branch.branch)
      return {
        ...branch,
        total_employees: employeeData?.employee_count || 0,
        total_target: tgt != null ? tgt : 0,
        total_personal_target: personalTgt,
        commissions: branch.total_cc,
        collection_credit: branch.total_cc
      }
    }).sort((a, b) => (b.total_investments || 0) - (a.total_investments || 0))
    
    const totalMonthlyTarget = mergedStats.reduce((sum, branch) => sum + (Number(branch.total_target) || 0), 0)
    const totalPersonalMonthlyTarget = mergedStats.reduce((sum, branch) => sum + (Number(branch.total_personal_target) || 0), 0)
    const response = {
      total_branches: mergedStats.length,
      total_investments: mergedStats.reduce((sum, branch) => sum + branch.total_investments, 0),
      total_receipts: mergedStats.reduce((sum, branch) => sum + branch.total_receipts, 0),
      total_collection_credit: mergedStats.reduce((sum, branch) => sum + branch.total_cc, 0),
      total_monthly_target: totalMonthlyTarget,
      total_personal_monthly_target: totalPersonalMonthlyTarget,
      branches: mergedStats
    }
    
    // Only include service income for admins
    if (req.user.role === 'admin') {
      response.total_service_income = mergedStats.reduce((sum, branch) => sum + branch.total_si, 0)
    }
    
    res.json(response)
  } catch (error) {
    console.error('Error fetching branch stats:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get employee performance rankings
router.get('/employees/performance', requireAuth, async (req, res) => {
  try {
    const { from, to, branch_code, includePending = '0', date_basis } = req.query
    
    let filterConditions = []
    let bindVars = {}
    const receiptDateExpr = effectiveDateExprAql(date_basis)
    
    if (from && to) {
      filterConditions.push(`${receiptDateExpr} >= @from AND ${receiptDateExpr} <= @to`)
      bindVars.from = from
      bindVars.to = to
    }
    
    // NOTE: When branch_code is present, we want to return ALL active users in that branch
    // (including users with 0 receipts in the period), so we compute aggregates user-first below.
    // We therefore do NOT add a receipt.branch filter here for the branch_code path.
    
    if (includePending !== '1') {
      filterConditions.push('receipt.status == "Completed"')
    } else {
      filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
    }
    
    filterConditions.push('receipt.is_deleted == false')
    // Keep legacy guard for receipt-driven mode (no branch_code path). For user-driven mode we may
    // include receipts linked by user_id even when emp_code is missing.
    if (!branch_code) filterConditions.push('receipt.emp_code != null AND receipt.emp_code != ""')
    
    const filterClause = filterConditions.length > 0 ? `FILTER ${filterConditions.join(' AND ')}` : ''
    
    if (branch_code) {
      const branchIdentifiers = await getBranchIdentifiersForFilter(branch_code)
      const ids = (branchIdentifiers?.length ? branchIdentifiers : [branch_code]).map((x) => String(x))

      // Resolve branch monthly target once.
      const branchMonthlyTarget = branchIdentifiers.length > 0
        ? await getBranchMonthlyTargetForIdentifiers(branchIdentifiers)
        : null

      // Active users in this branch (all roles).
      const usersInBranch = await q(
        `
        FOR u IN users
          FILTER u.is_active == true
            AND (
              (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
              OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
            )
          SORT u.name
          RETURN {
            id: u._key,
            emp_code: u.emp_code,
            name: u.name,
            role: u.role,
            branch: u.branch,
            branch_code: u.branch_code,
            personal_target: u.personal_monthly_target != null ? TO_NUMBER(u.personal_monthly_target) : null
          }
      `,
        { ids }
      )

      // Pool split numbers (active users only, all roles).
      const poolRows = await q(
        `
        LET sumPersonal = FIRST(
          FOR u IN users
            FILTER u.is_active == true
              AND u.personal_monthly_target != null
              AND u.personal_monthly_target != ""
              AND (
                (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
                OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
              )
            COLLECT AGGREGATE total = SUM(TO_NUMBER(u.personal_monthly_target))
            RETURN total
        )
        LET unsetCount = FIRST(
          FOR u IN users
            FILTER u.is_active == true
              AND (u.personal_monthly_target == null OR u.personal_monthly_target == "")
              AND (
                (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
                OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
              )
            COLLECT AGGREGATE c = LENGTH(1)
            RETURN c
        )
        RETURN { sumPersonal: sumPersonal || 0, unsetCount: unsetCount || 0 }
      `,
        { ids }
      )

      const sumPersonal = Number(poolRows?.[0]?.sumPersonal || 0)
      const unsetCount = Number(poolRows?.[0]?.unsetCount || 0)
      const monthly = branchMonthlyTarget != null && branchMonthlyTarget !== '' ? Number(branchMonthlyTarget) : null
      const remainingPool = monthly != null && Number.isFinite(monthly) ? (monthly - sumPersonal) : null
      const allocated = remainingPool != null && unsetCount > 0 ? remainingPool / unsetCount : null

      // For each user, compute achieved totals by (receipt.user_id OR receipt.emp_code).
      const userRowsWithTotals = await Promise.all(
        (usersInBranch || []).map(async (u) => {
          const totalsRows = await q(
            `
            FOR receipt IN receipts
              ${filterClause}
              FILTER (
                receipt.user_id == @userId
                OR (receipt.emp_code != null AND receipt.emp_code != "" AND receipt.emp_code == @empCode)
              )
              COLLECT AGGREGATE
                receipt_count = LENGTH(1),
                total_investment = SUM(${INV_AMOUNT_AQL}),
                total_cc = SUM(${CC_AQL}),
                total_si = SUM(${SI_AQL}),
                avg_investment = AVG(${INV_AMOUNT_AQL})
              RETURN { receipt_count, total_investment, total_cc, total_si, avg_investment }
          `,
            { ...bindVars, userId: String(u.id), empCode: String(u.emp_code || '') }
          )
          const t = totalsRows?.[0] || {}
          const personalT = u.personal_target != null ? Number(u.personal_target) : null
          const effective = personalT != null ? personalT : (allocated != null ? allocated : null)
          return {
            emp_code: u.emp_code,
            employee_name: u.name,
            role: u.role,
            personal_target: personalT,
            branch_monthly_target: monthly,
            sum_personal_targets: sumPersonal,
            unset_count: unsetCount,
            remaining_pool: remainingPool,
            allocated_target: allocated,
            effective_target: effective,
            receipt_count: Number(t.receipt_count || 0),
            total_investment: Number(t.total_investment || 0),
            total_cc: Number(t.total_cc || 0),
            total_si: Number(t.total_si || 0),
            avg_investment: Number(t.avg_investment || 0)
          }
        })
      )

      // Sort by total_investment desc (like existing behavior).
      userRowsWithTotals.sort((a, b) => (b.total_investment || 0) - (a.total_investment || 0))
      return res.json(userRowsWithTotals)
    }

    const employeeStatsRaw = await q(`
      FOR receipt IN receipts
      ${filterClause}
      COLLECT 
        emp_code = receipt.emp_code,
        employee_name = receipt.employee_name
      AGGREGATE 
        receipt_count = LENGTH(1),
        total_investment = SUM(${INV_AMOUNT_AQL}),
        total_cc = SUM(${CC_AQL}),
        total_si = SUM(${SI_AQL}),
        avg_investment = AVG(${INV_AMOUNT_AQL})
      LET userDoc = FIRST(
        FOR u IN users
          FILTER u.emp_code == emp_code
          LIMIT 1
          RETURN u
      )
      LET resolved_employee_name = (
        employee_name != null && employee_name != ""
          ? employee_name
          : (
              userDoc != null && userDoc.name != null && userDoc.name != ""
                ? userDoc.name
                : (
                    userDoc != null && userDoc.username != null && userDoc.username != ""
                      ? userDoc.username
                      : null
                  )
            )
      )
      SORT total_investment DESC
      RETURN {
        emp_code,
        employee_name: resolved_employee_name,
        user_branch_ref: userDoc != null
          ? (
              userDoc.branch_code != null && TO_STRING(userDoc.branch_code) != ""
                ? TO_STRING(userDoc.branch_code)
                : (userDoc.branch != null ? TO_STRING(userDoc.branch) : null)
            )
          : null,
        personal_target: userDoc != null && userDoc.personal_monthly_target != null ? TO_NUMBER(userDoc.personal_monthly_target) : null,
        receipt_count,
        total_investment,
        total_cc,
        total_si,
        avg_investment
      }
    `, bindVars)

    const employeeStats = Array.isArray(employeeStatsRaw) ? employeeStatsRaw : []
    const branchRefs = Array.from(
      new Set(
        employeeStats
          .map((r) => (r?.user_branch_ref != null ? String(r.user_branch_ref).trim() : ''))
          .filter(Boolean)
      )
    )

    // Precompute allocation per branchRef (active users only; all roles) and attach to rows.
    const perBranch = new Map()
    await Promise.all(
      branchRefs.map(async (branchRef) => {
        const branchRows = await q(
          `
          FOR b IN branches
            FILTER b._key == @branchRef
               OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@branchRef))
               OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@branchRef))
            LIMIT 1
            RETURN { key: b._key, code: b.branch_code, name: b.branch_name, monthly_target: b.monthly_target }
        `,
          { branchRef }
        )
        const b = branchRows?.[0]
        const monthly = b?.monthly_target != null && b?.monthly_target !== '' ? Number(b.monthly_target) : null
        const ids = [b?.key, b?.code, b?.name].filter((x) => x != null && String(x).trim() !== '').map((x) => String(x).trim())
        if (!ids.length) ids.push(String(branchRef))

        const rows = await q(
          `
          LET sumPersonal = FIRST(
            FOR u IN users
              FILTER u.is_active == true
                AND u.personal_monthly_target != null
                AND u.personal_monthly_target != ""
                AND (
                  (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
                  OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
                )
              COLLECT AGGREGATE total = SUM(TO_NUMBER(u.personal_monthly_target))
              RETURN total
          )
          LET unsetCount = FIRST(
            FOR u IN users
              FILTER u.is_active == true
                AND (u.personal_monthly_target == null OR u.personal_monthly_target == "")
                AND (
                  (u.branch_code != null AND TO_STRING(u.branch_code) IN @ids)
                  OR (u.branch != null AND TO_STRING(u.branch) IN @ids)
                )
              COLLECT AGGREGATE c = LENGTH(1)
              RETURN c
          )
          RETURN { sumPersonal: sumPersonal || 0, unsetCount: unsetCount || 0 }
        `,
          { ids }
        )
        const sumPersonal = Number(rows?.[0]?.sumPersonal || 0)
        const unsetCount = Number(rows?.[0]?.unsetCount || 0)
        const remainingPool = monthly != null && Number.isFinite(monthly) ? (monthly - sumPersonal) : null
        const allocated = remainingPool != null && unsetCount > 0 ? remainingPool / unsetCount : null
        perBranch.set(String(branchRef).trim(), {
          branch_monthly_target: monthly,
          sum_personal_targets: sumPersonal,
          unset_count: unsetCount,
          remaining_pool: remainingPool,
          allocated_target: allocated
        })
      })
    )

    const finalRows = employeeStats.map((r) => {
      const ref = r?.user_branch_ref != null ? String(r.user_branch_ref).trim() : ''
      const meta = ref ? perBranch.get(ref) : null
      const personal = r?.personal_target != null ? Number(r.personal_target) : null
      const allocated = meta?.allocated_target != null ? Number(meta.allocated_target) : null
      const effective = personal != null ? personal : allocated
      return {
        ...r,
        ...(meta ? meta : {}),
        allocated_target: allocated,
        effective_target: effective
      }
    })

    res.json(finalRows)
  } catch (error) {
    console.error('Error fetching employee performance:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get investor locations by state (for India heatmap widget)
router.get('/investor-locations', requireAuth, async (req, res) => {
  try {
    const { from, to, branch_code, includePending = '0', date_basis } = req.query
    let filterConditions = ['receipt.is_deleted == false']
    const bindVars = {}
    const dateExpr = effectiveDateExprAql(date_basis)
    if (from) { filterConditions.push(`${dateExpr} >= @from`); bindVars.from = from }
    if (to) { filterConditions.push(`${dateExpr} <= @to`); bindVars.to = to }
    if (includePending === '1') {
      filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
    } else {
      filterConditions.push('receipt.status == "Completed"')
    }
    if (req.user.role === 'employee') {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else if (req.user.role === 'manager' || req.user.role === 'branch') {
      // Managers/branch users are ALWAYS scoped to their own branch, regardless
      // of any branch_code query param (preventing cross-branch data leaks).
      const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        const normalized = normalizeBranchName(userBranch)
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalized || userBranch
      } else {
        filterConditions.push('1 == 0')
      }
    } else if (req.user.role === 'admin' && branch_code) {
      filterConditions.push('receipt.branch == @branch_code')
      bindVars.branch_code = branch_code
    }
    const filterClause = `FILTER ${filterConditions.join(' AND ')}`
    // Collect raw rows; we derive the final state in JS so we can fall back to
    // the investor pincode when the state field is missing/empty.
    const stateExpr = `(receipt.investor != null && receipt.investor.address != null && receipt.investor.address.state != null && TRIM(receipt.investor.address.state) != "") ? TRIM(receipt.investor.address.state) : ""`
    const pinExpr = `(receipt.investor != null && receipt.investor.address != null && receipt.investor.address.pin_code != null && TO_STRING(receipt.investor.address.pin_code) != "") ? TO_STRING(receipt.investor.address.pin_code) : (receipt.pin_code != null ? TO_STRING(receipt.pin_code) : (receipt.pinCode != null ? TO_STRING(receipt.pinCode) : ""))`
    const locationsQuery = `
      FOR receipt IN receipts
      ${filterClause}
      RETURN {
        state: ${stateExpr},
        pin: ${pinExpr},
        amount: ${INV_AMOUNT_AQL}
      }
    `
    const rawRows = await q(locationsQuery, bindVars)
    const byState = {}
    for (const row of rawRows) {
      const resolved = (row.state && String(row.state).trim()) || stateFromPincode(row.pin) || 'Unknown'
      if (!byState[resolved]) byState[resolved] = { count: 0, amount: 0 }
      byState[resolved].count += 1
      byState[resolved].amount += Number(row.amount) || 0
    }
    res.json({ byState })
  } catch (error) {
    console.error('Error fetching investor locations:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Stale open leads + stale customers (for manager hub queue / health widgets)
router.get('/branch-queue-metrics', requireAuth, async (req, res) => {
  try {
    const staleDays = Math.min(90, Math.max(1, parseInt(String(req.query.stale_days || '14'), 10) || 14))
    const branchFromQuery = req.query.branch_code != null ? String(req.query.branch_code).trim() : ''

    const bindVars = { staleDays }
    const parts = [
      'lead.updated_at != null',
      `lead.updated_at < DATE_SUBTRACT(DATE_NOW(), @staleDays, "day")`,
      '(lead.stage == null || LOWER(lead.stage) NOT IN ["won", "lost"])',
    ]

    if (req.user.role === 'employee') {
      return res.json({ stale_leads: 0, stale_customers: 0, stale_days: staleDays })
    }

    if (req.user.role === 'manager' || req.user.role === 'branch') {
      const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
      if (!userBranch) return res.json({ stale_leads: 0, stale_customers: 0, stale_days: staleDays })
      const branchNorm = normalizeBranchName(userBranch) || String(userBranch).trim()
      parts.push('lead.branch != null && UPPER(TRIM(lead.branch)) == UPPER(TRIM(@branchNorm))')
      bindVars.branchNorm = branchNorm
    } else if (req.user.role === 'admin') {
      if (branchFromQuery) {
        parts.push('lead.branch != null && UPPER(TRIM(lead.branch)) == UPPER(TRIM(@branchFilter))')
        bindVars.branchFilter = branchFromQuery
      }
    } else {
      return res.json({ stale_leads: 0, stale_customers: 0, stale_days: staleDays })
    }

    const filterClause = `FILTER ${parts.join(' AND ')}`
    const query = `
      FOR lead IN leads
      ${filterClause}
      COLLECT WITH COUNT INTO n
      RETURN n
    `
    const [rows, staleCustomers] = await Promise.all([
      q(query, bindVars),
      countStaleCustomersForQueue(req, staleDays, branchFromQuery),
    ])
    res.json({
      stale_leads: Number(rows?.[0]) || 0,
      stale_customers: staleCustomers,
      stale_days: staleDays,
    })
  } catch (error) {
    console.error('Error fetching branch queue metrics:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

async function countStaleCustomersForQueue(req, staleDays, branchFromQuery) {
  const custBind = { staleDays }
  const base =
    'customer.updated_at != null && customer.updated_at < DATE_SUBTRACT(DATE_NOW(), @staleDays, "day")'

  if (req.user.role === 'manager' || req.user.role === 'branch') {
    const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
    if (!userBranch) return 0
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    let filter = base
    if (branchIdentifiers.length > 0) {
      filter += ` && (
        (IS_ARRAY(customer.branches) && LENGTH(INTERSECTION(customer.branches, @branchIdentifiers)) > 0)
        || (customer.relationship_manager != null && (
          (IS_ARRAY(customer.relationship_manager) && LENGTH(INTERSECTION(customer.relationship_manager, @branchIdentifiers)) > 0)
          || (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager IN @branchIdentifiers)
        ))
      )`
      custBind.branchIdentifiers = branchIdentifiers
    } else if (normalizedUserBranch || userBranch) {
      filter += ` && (
        customer.relationship_manager == @userBranch
        || (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager)
      )`
      custBind.userBranch = normalizedUserBranch || userBranch
    } else {
      return 0
    }
    const rows = await q(
      `FOR customer IN customers FILTER ${filter} COLLECT WITH COUNT INTO n RETURN n`,
      custBind
    )
    return Number(rows?.[0]) || 0
  }

  if (req.user.role === 'admin') {
    if (!branchFromQuery) return 0
    const branchIdentifiers = await getBranchIdentifiersForFilter(branchFromQuery)
    if (!branchIdentifiers.length) return 0
    const filter =
      base +
      ` && (
      (IS_ARRAY(customer.branches) && LENGTH(INTERSECTION(customer.branches, @branchIdentifiers)) > 0)
      || (customer.relationship_manager != null && (
        (IS_ARRAY(customer.relationship_manager) && LENGTH(INTERSECTION(customer.relationship_manager, @branchIdentifiers)) > 0)
        || (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager IN @branchIdentifiers)
      ))
    )`
    custBind.branchIdentifiers = branchIdentifiers
    const rows = await q(
      `FOR customer IN customers FILTER ${filter} COLLECT WITH COUNT INTO n RETURN n`,
      custBind
    )
    return Number(rows?.[0]) || 0
  }

  return 0
}

export default router
