import { q, getCollection } from '../config/database.js'

/**
 * Aggregate CC and SI for a specific employee for a specific month
 * This should be called when a receipt status changes to Completed
 */
export async function aggregateEmployeeCCSI(userId, year, month) {
  try {
    // Calculate date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endDate = month === 12 
      ? `${year + 1}-01-01` 
      : `${year}-${String(month + 1).padStart(2, '0')}-01`
    
    // Get all completed receipts for this user in this month
    const receiptsQuery = await q(`
      FOR receipt IN receipts
      FILTER receipt.user_id == @userId
      FILTER receipt.status == "Completed"
      FILTER receipt.date >= @startDate
      FILTER receipt.date < @endDate
      FILTER receipt.is_deleted == false
      RETURN {
        cc_amount: receipt.cc_amount || 0,
        si_amount: receipt.si_amount || 0
      }
    `, { userId, startDate, endDate })
    
    // Calculate totals
    const totals = receiptsQuery.reduce((acc, receipt) => {
      return {
        total_cc: acc.total_cc + (Number(receipt.cc_amount) || 0),
        total_si: acc.total_si + (Number(receipt.si_amount) || 0),
        transaction_count: acc.transaction_count + 1
      }
    }, { total_cc: 0, total_si: 0, transaction_count: 0 })
    
    // Get or create log entry
    const logsCollection = getCollection('employee_cc_si_logs')
    const existingLog = await q(`
      FOR log IN employee_cc_si_logs
      FILTER log.user_id == @userId
      FILTER log.year == @year
      FILTER log.month == @month
      LIMIT 1
      RETURN log
    `, { userId, year, month })
    
    const logData = {
      user_id: userId,
      year,
      month,
      total_cc: totals.total_cc,
      total_si: totals.total_si,
      total_collection_credit: totals.total_cc + totals.total_si,
      transaction_count: totals.transaction_count,
      updated_at: new Date().toISOString()
    }
    
    if (existingLog.length > 0) {
      // Update existing log
      await logsCollection.update(existingLog[0]._key, logData)
      return { ...logData, _key: existingLog[0]._key }
    } else {
      // Create new log
      logData.created_at = new Date().toISOString()
      const result = await logsCollection.save(logData)
      return { ...logData, _key: result._key }
    }
  } catch (error) {
    console.error(`Error aggregating employee CC/SI for user ${userId}, ${year}-${month}:`, error)
    throw error
  }
}

/**
 * Aggregate CC and SI for a specific branch for a specific month
 * This aggregates all employees' CC/SI in that branch
 */
export async function aggregateBranchCCSI(branchCode, year, month) {
  try {
    // Get all users in this branch
    const branchUsers = await q(`
      FOR user IN users
      FILTER user.branch_code == @branchCode
      FILTER user.is_active == true
      RETURN user._key
    `, { branchCode })
    
    if (branchUsers.length === 0) {
      // No users in branch, create/update log with zeros
      const logsCollection = getCollection('branch_cc_si_logs')
      const existingLog = await q(`
        FOR log IN branch_cc_si_logs
        FILTER log.branch_code == @branchCode
        FILTER log.year == @year
        FILTER log.month == @month
        LIMIT 1
        RETURN log
      `, { branchCode, year, month })
      
      const logData = {
        branch_code: branchCode,
        year,
        month,
        total_cc: 0,
        total_si: 0,
        total_collection_credit: 0,
        transaction_count: 0,
        employee_count: 0,
        updated_at: new Date().toISOString()
      }
      
      if (existingLog.length > 0) {
        await logsCollection.update(existingLog[0]._key, logData)
        return { ...logData, _key: existingLog[0]._key }
      } else {
        logData.created_at = new Date().toISOString()
        const result = await logsCollection.save(logData)
        return { ...logData, _key: result._key }
      }
    }
    
    // Calculate date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endDate = month === 12 
      ? `${year + 1}-01-01` 
      : `${year}-${String(month + 1).padStart(2, '0')}-01`
    
    // Get all completed receipts for users in this branch for this month
    const receiptsQuery = await q(`
      FOR receipt IN receipts
      FILTER receipt.status == "Completed"
      FILTER receipt.date >= @startDate
      FILTER receipt.date < @endDate
      FILTER receipt.is_deleted == false
      FOR user IN users
        FILTER user._key == receipt.user_id
        FILTER user.branch_code == @branchCode
        RETURN {
          cc_amount: receipt.cc_amount || 0,
          si_amount: receipt.si_amount || 0
        }
    `, { branchCode, startDate, endDate })
    
    // Calculate totals
    const totals = receiptsQuery.reduce((acc, receipt) => {
      return {
        total_cc: acc.total_cc + (Number(receipt.cc_amount) || 0),
        total_si: acc.total_si + (Number(receipt.si_amount) || 0),
        transaction_count: acc.transaction_count + 1
      }
    }, { total_cc: 0, total_si: 0, transaction_count: 0 })
    
    // Get or create log entry
    const logsCollection = getCollection('branch_cc_si_logs')
    const existingLog = await q(`
      FOR log IN branch_cc_si_logs
      FILTER log.branch_code == @branchCode
      FILTER log.year == @year
      FILTER log.month == @month
      LIMIT 1
      RETURN log
    `, { branchCode, year, month })
    
    const logData = {
      branch_code: branchCode,
      year,
      month,
      total_cc: totals.total_cc,
      total_si: totals.total_si,
      total_collection_credit: totals.total_cc + totals.total_si,
      transaction_count: totals.transaction_count,
      employee_count: branchUsers.length,
      updated_at: new Date().toISOString()
    }
    
    if (existingLog.length > 0) {
      // Update existing log
      await logsCollection.update(existingLog[0]._key, logData)
      return { ...logData, _key: existingLog[0]._key }
    } else {
      // Create new log
      logData.created_at = new Date().toISOString()
      const result = await logsCollection.save(logData)
      return { ...logData, _key: result._key }
    }
  } catch (error) {
    console.error(`Error aggregating branch CC/SI for branch ${branchCode}, ${year}-${month}:`, error)
    throw error
  }
}

/**
 * Trigger aggregation when a receipt status changes to Completed
 * This should be called after updating receipt status
 */
export async function triggerAggregation(receipt) {
  try {
    if (!receipt.date || !receipt.user_id) {
      return
    }
    
    const receiptDate = new Date(receipt.date)
    const year = receiptDate.getFullYear()
    const month = receiptDate.getMonth() + 1 // JavaScript months are 0-indexed
    
    // Aggregate for employee
    await aggregateEmployeeCCSI(receipt.user_id, year, month)
    
    // Get user's branch_code and aggregate for branch
    const userQuery = await q(`
      FOR user IN users
      FILTER user._key == @userId
      LIMIT 1
      RETURN user.branch_code
    `, { userId: receipt.user_id })
    
    if (userQuery.length > 0 && userQuery[0]) {
      await aggregateBranchCCSI(userQuery[0], year, month)
    }
  } catch (error) {
    console.error('Error triggering CC/SI aggregation:', error)
    // Don't throw - aggregation failure shouldn't block receipt update
  }
}

