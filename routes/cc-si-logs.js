import express from 'express'
import { q } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

// Get employee CC/SI logs
// GET /api/cc-si-logs/employee/:userId?year=2024&month=1
router.get('/employee/:userId', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params
    const { year, month } = req.query
    
    // Check permissions - users can only see their own logs unless admin
    if (req.user.role !== 'admin' && req.user.sub !== userId) {
      return res.status(403).json({ error: 'forbidden', detail: 'You can only view your own CC/SI logs' })
    }
    
    let filterClause = 'FILTER log.user_id == @userId'
    const bindVars = { userId }
    
    if (year) {
      filterClause += ' AND log.year == @year'
      bindVars.year = parseInt(year, 10)
    }
    
    if (month) {
      filterClause += ' AND log.month == @month'
      bindVars.month = parseInt(month, 10)
    }
    
    const logsQuery = `
      FOR log IN employee_cc_si_logs
      ${filterClause}
      SORT log.year DESC, log.month DESC
      RETURN log
    `
    
    const logs = await q(logsQuery, bindVars)
    
    res.json({ logs })
  } catch (error) {
    console.error('Error fetching employee CC/SI logs:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get branch CC/SI logs
// GET /api/cc-si-logs/branch/:branchCode?year=2024&month=1
router.get('/branch/:branchCode', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { branchCode } = req.params
    const { year, month } = req.query
    
    // Decode branch code
    let decodedBranchCode = branchCode
    try {
      decodedBranchCode = decodeURIComponent(branchCode)
    } catch (e) {
      // Already decoded or invalid
    }
    
    let filterClause = 'FILTER log.branch_code == @branchCode'
    const bindVars = { branchCode: decodedBranchCode }
    
    if (year) {
      filterClause += ' AND log.year == @year'
      bindVars.year = parseInt(year, 10)
    }
    
    if (month) {
      filterClause += ' AND log.month == @month'
      bindVars.month = parseInt(month, 10)
    }
    
    const logsQuery = `
      FOR log IN branch_cc_si_logs
      ${filterClause}
      SORT log.year DESC, log.month DESC
      RETURN log
    `
    
    const logs = await q(logsQuery, bindVars)
    
    res.json({ logs })
  } catch (error) {
    console.error('Error fetching branch CC/SI logs:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get all employees' CC/SI logs (admin only)
// GET /api/cc-si-logs/employees?year=2024&month=1
router.get('/employees', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { year, month } = req.query
    
    let filterClause = ''
    const bindVars = {}
    
    if (year) {
      filterClause += 'FILTER log.year == @year'
      bindVars.year = parseInt(year, 10)
    }
    
    if (month) {
      if (!filterClause) filterClause = 'FILTER'
      else filterClause += ' AND'
      filterClause += ' log.month == @month'
      bindVars.month = parseInt(month, 10)
    }
    
    const logsQuery = `
      FOR log IN employee_cc_si_logs
      ${filterClause}
      SORT log.year DESC, log.month DESC, log.total_collection_credit DESC
      RETURN log
    `
    
    const logs = await q(logsQuery, bindVars)
    
    res.json({ logs })
  } catch (error) {
    console.error('Error fetching all employee CC/SI logs:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get all branches' CC/SI logs (admin only)
// GET /api/cc-si-logs/branches?year=2024&month=1
router.get('/branches', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { year, month } = req.query
    
    let filterClause = ''
    const bindVars = {}
    
    if (year) {
      filterClause += 'FILTER log.year == @year'
      bindVars.year = parseInt(year, 10)
    }
    
    if (month) {
      if (!filterClause) filterClause = 'FILTER'
      else filterClause += ' AND'
      filterClause += ' log.month == @month'
      bindVars.month = parseInt(month, 10)
    }
    
    const logsQuery = `
      FOR log IN branch_cc_si_logs
      ${filterClause}
      SORT log.year DESC, log.month DESC, log.total_collection_credit DESC
      RETURN log
    `
    
    const logs = await q(logsQuery, bindVars)
    
    res.json({ logs })
  } catch (error) {
    console.error('Error fetching all branch CC/SI logs:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router


