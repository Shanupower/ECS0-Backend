import express from 'express'
import { q, getUserBranch, normalizeBranchName } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

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
  // Filter by user_id for employees, by branch for managers, or by user_id when viewing personal data
  const viewMode = req.query.viewMode
  if (req.user.role === 'employee') {
    // Employees always see only their own receipts
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = String(req.user.sub) // Ensure it's a string for comparison
    console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, role=${req.user.role}`)
  } else if (req.user.role === 'manager') {
    // Managers see all receipts from their branch
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    console.log(`[Stats] MANAGER: userBranch=${userBranch}, normalized=${normalizedUserBranch}, user_id=${req.user.sub}`)
    
    if (userBranch) {
      // Check both the original branch name and normalized name, as receipts might have either
      // Also check for case-insensitive matches and partial matches
      const branchVariations = [userBranch, normalizedUserBranch].filter(Boolean)
      // Remove duplicates
      const uniqueBranches = [...new Set(branchVariations)]
      
      if (uniqueBranches.length > 1) {
        // Check for multiple branch name variations
        const branchConditions = uniqueBranches.map((branch, idx) => {
          const key = `branch${idx}`
          bindVars[key] = branch
          return `receipt.branch == @${key}`
        })
        filterConditions.push(`(${branchConditions.join(' OR ')})`)
        console.log(`[Stats] MANAGER FILTER APPLIED: checking multiple variations=${uniqueBranches.join(', ')}`)
      } else if (uniqueBranches.length === 1) {
        // Use the branch name as-is
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = uniqueBranches[0]
        console.log(`[Stats] MANAGER FILTER APPLIED: branch=${uniqueBranches[0]}`)
      }
    } else {
      console.log(`[Stats] MANAGER HAS NO BRANCH: user_id=${req.user.sub}`)
    }
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    // For admins viewing personal data, filter by user_id to show only receipts entered by that user
    // Check if viewing own data first (optimization)
    if (req.user.emp_code === emp_code) {
      // Admin viewing their own data - use req.user.sub directly
      filterConditions.push('receipt.user_id == @user_id')
      bindVars.user_id = String(req.user.sub) // Ensure it's a string for comparison
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
    // Branch view: filter by the admin's branch
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    if (normalizedUserBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizedUserBranch
    }
  }
  // For viewMode === 'all', no user/branch filter is applied (shows all branches)
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
  
  // Query for investment amounts (with status filter)
  const totalsQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT AGGREGATE 
      total_collections = SUM(TO_NUMBER(receipt.investment_amount) || 0),
      total_cc = SUM(TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0),
      total_si = SUM(TO_NUMBER(receipt.service_income || receipt.si || 0) || 0)
    RETURN { total_collections, total_cc, total_si }
  `
  
  const byCatQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT category = receipt.product_category 
    AGGREGATE n = LENGTH(1), amount = SUM(TO_NUMBER(receipt.investment_amount) || 0)
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const byDayQuery = `
    FOR receipt IN receipts
    ${allFilterClause}
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(TO_NUMBER(receipt.investment_amount) || 0)
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const [receiptsCount, totals, byCat, byDay] = await Promise.all([
    q(receiptsCountQuery, bindVars),
    q(totalsQuery, bindVars),
    q(byCatQuery, bindVars),
    q(byDayQuery, bindVars)
  ])
  
  const totalReceipts = receiptsCount[0]?.total_receipts || 0
  const totalCollections = totals[0]?.total_collections || 0
  const totalCC = totals[0]?.total_cc || 0
  const totalSI = totals[0]?.total_si || 0
  
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
    // Non-admin users see only their branch customers
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
  }
  
  const customersResult = await q(customersQuery, customersBindVars)
  const totalCustomers = customersResult.length

  const response = {
    total_receipts: Number(totalReceipts),
    total_investments: Number(totalCollections),
    total_customers: totalCustomers,
    collection_credit_earned: Number(totalCC),
    by_category: byCat,
    by_day: byDay
  }
  
  // Only include service_income_earned for admins
  if (req.user.role === 'admin') {
    response.service_income_earned = Number(totalSI)
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
    // Employees always see only their own receipts
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = String(req.user.sub) // Ensure it's a string for comparison
    console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, role=${req.user.role}`)
  } else if (req.user.role === 'manager') {
    // Managers see all receipts from their branch
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    console.log(`[Stats] MANAGER: userBranch=${userBranch}, normalized=${normalizedUserBranch}, user_id=${req.user.sub}`)
    
    if (userBranch) {
      // Check both the original branch name and normalized name, as receipts might have either
      // Also check for case-insensitive matches and partial matches
      const branchVariations = [userBranch, normalizedUserBranch].filter(Boolean)
      // Remove duplicates
      const uniqueBranches = [...new Set(branchVariations)]
      
      if (uniqueBranches.length > 1) {
        // Check for multiple branch name variations
        const branchConditions = uniqueBranches.map((branch, idx) => {
          const key = `branch${idx}`
          bindVars[key] = branch
          return `receipt.branch == @${key}`
        })
        filterConditions.push(`(${branchConditions.join(' OR ')})`)
        console.log(`[Stats] MANAGER FILTER APPLIED: checking multiple variations=${uniqueBranches.join(', ')}`)
      } else if (uniqueBranches.length === 1) {
        // Use the branch name as-is
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = uniqueBranches[0]
        console.log(`[Stats] MANAGER FILTER APPLIED: branch=${uniqueBranches[0]}`)
      }
    } else {
      console.log(`[Stats] MANAGER HAS NO BRANCH: user_id=${req.user.sub}`)
    }
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    // For admins viewing personal data, filter by user_id to show only receipts entered by that user
    // Check if viewing own data first (optimization)
    if (req.user.emp_code === emp_code) {
      // Admin viewing their own data - use req.user.sub directly
      filterConditions.push('receipt.user_id == @user_id')
      bindVars.user_id = String(req.user.sub) // Ensure it's a string for comparison
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
    // Branch view: filter by the admin's branch
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    if (normalizedUserBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizedUserBranch
    }
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
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT category = receipt.product_category 
    AGGREGATE n = LENGTH(1), amount = SUM(TO_NUMBER(receipt.investment_amount) || 0)
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
    // Employees always see only their own receipts
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = String(req.user.sub) // Ensure it's a string for comparison
    console.log(`[Stats] EMPLOYEE FILTER APPLIED: user_id=${bindVars.user_id}, role=${req.user.role}`)
  } else if (req.user.role === 'manager') {
    // Managers see all receipts from their branch
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    console.log(`[Stats] MANAGER: userBranch=${userBranch}, normalized=${normalizedUserBranch}, user_id=${req.user.sub}`)
    
    if (userBranch) {
      // Check both the original branch name and normalized name, as receipts might have either
      // Also check for case-insensitive matches and partial matches
      const branchVariations = [userBranch, normalizedUserBranch].filter(Boolean)
      // Remove duplicates
      const uniqueBranches = [...new Set(branchVariations)]
      
      if (uniqueBranches.length > 1) {
        // Check for multiple branch name variations
        const branchConditions = uniqueBranches.map((branch, idx) => {
          const key = `branch${idx}`
          bindVars[key] = branch
          return `receipt.branch == @${key}`
        })
        filterConditions.push(`(${branchConditions.join(' OR ')})`)
        console.log(`[Stats] MANAGER FILTER APPLIED: checking multiple variations=${uniqueBranches.join(', ')}`)
      } else if (uniqueBranches.length === 1) {
        // Use the branch name as-is
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = uniqueBranches[0]
        console.log(`[Stats] MANAGER FILTER APPLIED: branch=${uniqueBranches[0]}`)
      }
    } else {
      console.log(`[Stats] MANAGER HAS NO BRANCH: user_id=${req.user.sub}`)
    }
  } else if (emp_code && (viewMode === 'personal' || !viewMode)) {
    // For admins viewing personal data, filter by user_id to show only receipts entered by that user
    // Check if viewing own data first (optimization)
    if (req.user.emp_code === emp_code) {
      // Admin viewing their own data - use req.user.sub directly
      filterConditions.push('receipt.user_id == @user_id')
      bindVars.user_id = String(req.user.sub) // Ensure it's a string for comparison
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
    // Branch view: filter by the admin's branch
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    if (normalizedUserBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizedUserBranch
    }
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
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(TO_NUMBER(receipt.investment_amount) || 0)
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const rows = await q(query, bindVars)
  res.json(rows)
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
    // Include pending transactions if requested
    const includePending = req.query.includePending === '1'
    if (!includePending) {
      // Only include completed receipts in investment calculations
      filterConditions.push('receipt.status == "Completed"')
    }
    
    if (filterConditions.length > 0) {
      dateFilter = `FILTER ${filterConditions.join(' AND ')}\n`
    }
    
    // Get branch performance statistics
    const branchStatsQuery = `
      FOR receipt IN receipts
      ${dateFilter}
      COLLECT branch = receipt.branch 
      AGGREGATE 
        receipt_count = LENGTH(1), 
        total_investments = SUM(TO_NUMBER(receipt.investment_amount) || 0),
        total_cc = SUM(TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0),
        total_si = SUM(TO_NUMBER(receipt.service_income || receipt.si || 0) || 0)
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
    
    // Get employee count per branch
    const employeeStatsQuery = `
      FOR user IN users
      FILTER user.is_active == true AND user.branch != null
      COLLECT branch = user.branch WITH COUNT INTO employee_count
      RETURN { branch, employee_count }
    `
    
    const employeeStats = await q(employeeStatsQuery)
    
    // Merge branch and employee statistics
    const mergedStats = branchStats.map(branch => {
      const employeeData = employeeStats.find(emp => emp.branch === branch.branch)
      return {
        ...branch,
        total_employees: employeeData?.employee_count || 0,
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
        total_investment = SUM(TO_NUMBER(receipt.investment_amount || receipt.fd_deposit_amount || 0)),
        total_cc = SUM(TO_NUMBER(receipt.collection_credit || receipt.cc || 0) || 0),
        total_si = SUM(TO_NUMBER(receipt.service_income || receipt.si || 0) || 0),
        avg_investment = AVG(TO_NUMBER(receipt.investment_amount || receipt.fd_deposit_amount || 0))
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

export default router
