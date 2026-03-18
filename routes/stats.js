import express from 'express'
import { q, getUserBranch, normalizeBranchName, getBranchIdentifiersForFilter } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

// Investment amount per receipt: nested tree first (transaction.amount, product_details.fd), then legacy flat
const INV_AMOUNT_AQL = `(
  (TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0)
  : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0)
  : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0)
  : (TO_NUMBER(receipt.fd_deposit_amount) || 0) != 0 ? (TO_NUMBER(receipt.fd_deposit_amount) || 0)
  : (TO_NUMBER(receipt.service_price) || 0) != 0 ? (TO_NUMBER(receipt.service_price) || 0)
  : 0
)`

// Category: nested product.category first, then legacy product_category, else "Other"
const CATEGORY_AQL = `(receipt.product != null && receipt.product.category != null && receipt.product.category != "") ? receipt.product.category : (receipt.product_category != null && receipt.product_category != "" ? receipt.product_category : "Other")`

// CC per receipt: tree total (total_cc) when set, else cc_amount+additional_cc, else legacy collection_credit/cc, else calculations.collection_credit/cc
const CC_AQL = `(TO_NUMBER(receipt.total_cc) || 0) != 0 ? (TO_NUMBER(receipt.total_cc) || 0) : ((TO_NUMBER(receipt.cc_amount) || 0) + (TO_NUMBER(receipt.additional_cc) || 0)) != 0 ? ((TO_NUMBER(receipt.cc_amount) || 0) + (TO_NUMBER(receipt.additional_cc) || 0)) : (TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0) != 0 ? (TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0) : (receipt.calculations != null && (receipt.calculations.collection_credit != null || receipt.calculations.cc != null)) ? (TO_NUMBER(receipt.calculations.collection_credit || receipt.calculations.cc || 0) || 0) : 0`

// SI per receipt: tree total (total_si) when set, else si_amount+additional_si, else legacy service_income/si, else calculations.service_income/si
const SI_AQL = `(TO_NUMBER(receipt.total_si) || 0) != 0 ? (TO_NUMBER(receipt.total_si) || 0) : ((TO_NUMBER(receipt.si_amount) || 0) + (TO_NUMBER(receipt.additional_si) || 0)) != 0 ? ((TO_NUMBER(receipt.si_amount) || 0) + (TO_NUMBER(receipt.additional_si) || 0)) : (TO_NUMBER(receipt.service_income || receipt.si || 0) || 0) != 0 ? (TO_NUMBER(receipt.service_income || receipt.si || 0) || 0) : (receipt.calculations != null && (receipt.calculations.service_income != null || receipt.calculations.si != null)) ? (TO_NUMBER(receipt.calculations.service_income || receipt.calculations.si || 0) || 0) : 0`

// Get summary statistics
router.get('/summary', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  console.log(`[Stats Summary] Request from user: role=${req.user.role}, emp_code=${req.user.emp_code}, sub=${req.user.sub}, query emp_code=${emp_code}`)
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  if (from) { 
    filterConditions.push('receipt.date >= @from')
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push('receipt.date <= @to')
    bindVars.to = to
  }
  // Filter by user_id for employees, by branch for managers/branch users, or by user_id when viewing personal data
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    // Employees: match list scope (receipts by user_id OR emp_code so list and dashboard agree)
    filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
    bindVars.user_id = String(req.user.sub)
    bindVars.emp_code = req.user.emp_code || ''
    console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, emp_code=${bindVars.emp_code}, role=${req.user.role}`)
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
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
  
  // Build status filter - applies to both total_receipts count and investment amounts
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
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL})
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  // Status counts: use same base + status filter so counts match includePending
  const statusCountsQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT status = (receipt.status == "Completed" ? "Completed" : (receipt.status == "Pending" ? "Pending" : "Other"))
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
  
  const status_counts = { Pending: 0, Completed: 0, Other: 0 }
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
        const normalizedEmpBranch = normalizeBranchName(empBranch)
        if (normalizedEmpBranch) {
          customersQuery = `
            FOR customer IN customers
            FILTER (
              (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
              (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
            )
            RETURN LENGTH(1)
          `
          customersBindVars.userBranch = normalizedEmpBranch
        } else {
          // If no branch found, show all customers
          customersQuery = `
            FOR customer IN customers
            RETURN LENGTH(1)
          `
        }
      } else {
        // Employee not found, show all customers
        customersQuery = `
          FOR customer IN customers
          RETURN LENGTH(1)
        `
      }
    } else if (customerViewMode === 'branch') {
      // Branch view: Show all customers in admin's own branch
      const userBranch = await getUserBranch(req.user.sub)
      const normalizedUserBranch = normalizeBranchName(userBranch)
      
      if (normalizedUserBranch) {
        customersQuery = `
          FOR customer IN customers
          FILTER customer.relationship_manager == @userBranch
          RETURN LENGTH(1)
        `
        customersBindVars.userBranch = normalizedUserBranch
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
  
  // Monthly target: personal view = current user's target; branch view = sum of branch users' targets
  const isPersonalView = req.user.role === 'employee' || (req.user.role === 'admin' && emp_code && (viewMode === 'personal' || !viewMode))
  const isBranchView = viewMode === 'branch' || req.user.role === 'manager' || req.user.role === 'branch'
  if (isPersonalView) {
    const userTarget = await q(`
      FOR user IN users FILTER user._key == @id LIMIT 1 RETURN user.monthly_target
    `, { id: req.user.sub })
    response.monthly_target = userTarget[0] != null ? Number(userTarget[0]) : null
  } else if (isBranchView) {
    let branchIdentifiers = []
    if (req.user.role === 'admin' && viewMode === 'branch') {
      const ub = await getUserBranch(req.user.sub)
      branchIdentifiers = await getBranchIdentifiersForFilter(ub)
    } else {
      const me = await q(`
        FOR user IN users FILTER user._key == @id LIMIT 1 RETURN { branch_code: user.branch_code, branch: user.branch }
      `, { id: req.user.sub })
      branchIdentifiers = me[0] ? await getBranchIdentifiersForFilter(me[0].branch_code || me[0].branch) : []
    }
    if (branchIdentifiers.length > 0) {
      const usersInBranch = await q(`
        FOR user IN users
        FILTER user.is_active == true
        FILTER user.branch_code IN @codes OR user.branch IN @codes
        RETURN user.monthly_target
      `, { codes: branchIdentifiers })
      response.branch_target = (usersInBranch || []).reduce((s, t) => s + (t != null ? Number(t) : 0), 0) || null
    } else {
      response.branch_target = null
    }
  }
  
  res.json(response)
})

// Get statistics by category
router.get('/by-category', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  if (from) { 
    filterConditions.push('receipt.date >= @from')
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push('receipt.date <= @to')
    bindVars.to = to
  }
  // Filter by user_id for employees, by branch for managers, or by user_id when viewing personal data
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    // Employees: match list scope (receipts by user_id OR emp_code so list and dashboard agree)
    filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
    bindVars.user_id = String(req.user.sub)
    bindVars.emp_code = req.user.emp_code || ''
    console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, emp_code=${bindVars.emp_code}, role=${req.user.role}`)
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
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
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  
  let filterClause = ''
  let bindVars = {}
  let filterConditions = []
  
  if (from) { 
    filterConditions.push('receipt.date >= @from')
    bindVars.from = from
  }
  if (to) { 
    filterConditions.push('receipt.date <= @to')
    bindVars.to = to
  }
  // Filter by user_id for employees, by branch for managers, or by user_id when viewing personal data
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    // Employees: match list scope (receipts by user_id OR emp_code so list and dashboard agree)
    filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
    bindVars.user_id = String(req.user.sub)
    bindVars.emp_code = req.user.emp_code || ''
    console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, emp_code=${bindVars.emp_code}, role=${req.user.role}`)
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
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
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(${amountExpr})
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
})

// Get monthly CC and SI trend (for dashboard widget)
router.get('/monthly-cc-si', requireAuth, async (req, res) => {
  const { from, to, emp_code, includeDeleted = '0' } = req.query
  const viewMode = req.query.viewMode
  let filterConditions = []
  const bindVars = {}
  if (from) { filterConditions.push('receipt.date >= @from'); bindVars.from = from }
  if (to) { filterConditions.push('receipt.date <= @to'); bindVars.to = to }
  if (req.user.role === 'employee') {
    filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
    bindVars.user_id = String(req.user.sub)
    bindVars.emp_code = req.user.emp_code || ''
  } else if (req.user.role === 'manager' || req.user.role === 'branch') {
    const userBranch = req.user.role === 'branch' ? (req.user.branch_code || req.user.branch) : await getUserBranch(req.user.sub)
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    if (branchIdentifiers.length > 0) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIdentifiers
    } else if (userBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizeBranchName(userBranch) || userBranch
    } else { filterConditions.push('1 == 0') }
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
  const monthExpr = 'SUBSTRING(receipt.date, 0, 7)'
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
    const { from, to, includeDeleted = '0' } = req.query
    
    let dateFilter = ''
    let bindVars = {}
    let filterConditions = []
    
    if (from && to) {
      filterConditions.push('receipt.date >= @from AND receipt.date <= @to')
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
    
    // Get employee count and total_target (sum of monthly_target) per branch
    const employeeStatsQuery = `
      FOR user IN users
      FILTER user.is_active == true AND user.branch != null
      COLLECT branch = user.branch
      AGGREGATE employee_count = LENGTH(1), total_target = SUM(user.monthly_target != null ? user.monthly_target : 0)
      RETURN { branch, employee_count, total_target }
    `
    
    const employeeStats = await q(employeeStatsQuery)
    
    // Merge branch and employee statistics
    const mergedStats = branchStats.map(branch => {
      const employeeData = employeeStats.find(emp => emp.branch === branch.branch)
      return {
        ...branch,
        total_employees: employeeData?.employee_count || 0,
        total_target: employeeData?.total_target != null ? Number(employeeData.total_target) : 0,
        commissions: branch.total_cc, // Alias for backward compatibility
        collection_credit: branch.total_cc
      }
    })
    
    const response = {
      total_branches: mergedStats.length,
      total_investments: mergedStats.reduce((sum, branch) => sum + branch.total_investments, 0),
      total_receipts: mergedStats.reduce((sum, branch) => sum + branch.total_receipts, 0),
      total_collection_credit: mergedStats.reduce((sum, branch) => sum + branch.total_cc, 0),
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
    const { from, to, branch_code, includePending = '0' } = req.query
    
    let filterConditions = []
    let bindVars = {}
    
    if (from && to) {
      filterConditions.push('receipt.date >= @from AND receipt.date <= @to')
      bindVars.from = from
      bindVars.to = to
    }
    
    if (branch_code) {
      filterConditions.push('receipt.branch == @branch_code')
      bindVars.branch_code = branch_code
    }
    
    if (includePending !== '1') {
      filterConditions.push('receipt.status == "Completed"')
    }
    
    filterConditions.push('receipt.is_deleted == false')
    filterConditions.push('receipt.emp_code != null AND receipt.emp_code != ""')
    
    const filterClause = filterConditions.length > 0 ? `FILTER ${filterConditions.join(' AND ')}` : ''
    
    const employeeStats = await q(`
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
      SORT total_investment DESC
      RETURN {
        emp_code,
        employee_name,
        receipt_count,
        total_investment,
        total_cc,
        total_si,
        avg_investment
      }
    `, bindVars)
    
    res.json(employeeStats)
  } catch (error) {
    console.error('Error fetching employee performance:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get investor locations by state (for India heatmap widget)
router.get('/investor-locations', requireAuth, async (req, res) => {
  try {
    const { from, to, branch_code, includePending = '0' } = req.query
    let filterConditions = ['receipt.is_deleted == false']
    const bindVars = {}
    if (from) { filterConditions.push('receipt.date >= @from'); bindVars.from = from }
    if (to) { filterConditions.push('receipt.date <= @to'); bindVars.to = to }
    if (includePending === '1') {
      filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
    } else {
      filterConditions.push('receipt.status == "Completed"')
    }
    if (req.user.role === 'employee') {
      filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else if ((req.user.role === 'manager' || req.user.role === 'branch') && !branch_code) {
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
    const stateExpr = `(receipt.investor != null && receipt.investor.address != null && receipt.investor.address.state != null && receipt.investor.address.state != "") ? TRIM(receipt.investor.address.state) : "Other"`
    const locationsQuery = `
      FOR receipt IN receipts
      ${filterClause}
      LET state = ${stateExpr}
      COLLECT s = state
      AGGREGATE count = LENGTH(1), amount = SUM(${INV_AMOUNT_AQL})
      SORT amount DESC
      RETURN { state: s, count, amount }
    `
    const rows = await q(locationsQuery, bindVars)
    const byState = {}
    for (const row of rows) {
      byState[row.state] = { count: row.count, amount: Number(row.amount) }
    }
    res.json({ byState })
  } catch (error) {
    console.error('Error fetching investor locations:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
