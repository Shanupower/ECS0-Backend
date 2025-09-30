import express from 'express'
import { q, getUserBranch, normalizeBranchName } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

// Get summary statistics
router.get('/summary', requireAuth, async (req, res) => {
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
  if (req.user.role === 'employee') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
      filterConditions.push('receipt.emp_code == @emp_code')
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Only include completed receipts in investment calculations
  filterConditions.push('receipt.status == "Completed"')
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const totalsQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE 
      total_receipts = LENGTH(1),
      total_collections = SUM(receipt.investment_amount || 0)
    RETURN { total_receipts, total_collections }
  `
  
  const byCatQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT category = receipt.product_category 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
    SORT amount DESC
    RETURN { category, n, amount }
  `
  
  const byDayQuery = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
    SORT date ASC
    RETURN { date, n, amount }
  `
  
  const [totals, byCat, byDay] = await Promise.all([
    q(totalsQuery, bindVars),
    q(byCatQuery, bindVars),
    q(byDayQuery, bindVars)
  ])
  
  const totalCollections = totals[0]?.total_collections || 0
  const commissions_total = Number(totalCollections) * 0.01
  
  // Get total customers count - filter by branch for non-admin users
  let customersQuery = ''
  let customersBindVars = {}
  
  if (req.user.role === 'admin') {
    // Admin sees all customers
    customersQuery = `
      FOR customer IN customers
      RETURN LENGTH(1)
    `
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

  res.json({
    total_receipts: Number(totals[0]?.total_receipts || 0),
    total_investments: Number(totalCollections),
    total_customers: totalCustomers,
    commissions_total,
    by_category: byCat,
    by_day: byDay
  })
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
  if (req.user.role === 'employee') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterConditions.push('receipt.emp_code == @emp_code')
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Only include completed receipts in investment calculations
  filterConditions.push('receipt.status == "Completed"')
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT category = receipt.product_category 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
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
  if (req.user.role === 'employee') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = req.user.sub
  } else if (emp_code) {
    filterConditions.push('receipt.emp_code == @emp_code')
    bindVars.emp_code = emp_code
  }
  if (!(req.user.role === 'admin' && includeDeleted === '1')) {
    filterConditions.push('receipt.is_deleted == false')
  }
  // Only include completed receipts in investment calculations
  filterConditions.push('receipt.status == "Completed"')
  
  if (filterConditions.length > 0) {
    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
  }
  
  const query = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT date = receipt.date 
    AGGREGATE n = LENGTH(1), amount = SUM(receipt.investment_amount || 0)
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
    // Only include completed receipts in investment calculations
    filterConditions.push('receipt.status == "Completed"')
    
    if (filterConditions.length > 0) {
      dateFilter = `FILTER ${filterConditions.join(' AND ')}\n`
    }
    
    // Get branch performance statistics
    const branchStatsQuery = `
      FOR receipt IN receipts
      ${dateFilter}
      COLLECT branch = receipt.branch 
      AGGREGATE receipt_count = LENGTH(1), total_investments = SUM(receipt.investment_amount || 0)
      SORT total_investments DESC
      RETURN {
        branch,
        total_receipts: receipt_count,
        total_investments,
        commissions: total_investments * 0.01
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
        total_employees: employeeData?.employee_count || 0
      }
    })
    
    res.json({
      total_branches: mergedStats.length,
      total_investments: mergedStats.reduce((sum, branch) => sum + branch.total_investments, 0),
      total_receipts: mergedStats.reduce((sum, branch) => sum + branch.total_receipts, 0),
      total_commissions: mergedStats.reduce((sum, branch) => sum + branch.commissions, 0),
      branches: mergedStats
    })
  } catch (error) {
    console.error('Error fetching branch stats:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
