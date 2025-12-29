// Cleanup utility to delete all test data immediately
import { q } from '../../config/database.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Delete all test data with TEST_ prefix markers
 */
export async function cleanupTestData() {
  const cleanupResults = {
    customers: 0,
    receipts: 0,
    users: 0,
    branches: 0,
    issues: 0,
    files: [],
    errors: []
  }
  
  try {
    console.log('[Cleanup] Starting test data cleanup...')
    
    // Cleanup customers
    try {
      const customerPrefix = TEST_CONFIG.TEST_PREFIX.CUSTOMER
      const customers = await q(`
        FOR customer IN customers
        FILTER customer.name LIKE @prefix
        RETURN customer._key
      `, { prefix: `${customerPrefix}%` })
      
      if (customers.length > 0) {
        await q(`
          FOR customer IN customers
          FILTER customer.name LIKE @prefix
          REMOVE customer IN customers
        `, { prefix: `${customerPrefix}%` })
        cleanupResults.customers = customers.length
        console.log(`[Cleanup] Deleted ${customers.length} test customers`)
      }
    } catch (error) {
      cleanupResults.errors.push(`Customers cleanup error: ${error.message}`)
    }
    
    // Cleanup receipts
    try {
      const receiptPrefix = TEST_CONFIG.TEST_PREFIX.RECEIPT
      const receipts = await q(`
        FOR receipt IN receipts
        FILTER receipt.receipt_no LIKE @prefix OR receipt.investor_name LIKE @customerPrefix
        RETURN { _key: receipt._key, files: receipt.files || [] }
      `, { 
        prefix: `${receiptPrefix}%`,
        customerPrefix: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}%`
      })
      
      if (receipts.length > 0) {
        // Collect file paths for deletion
        receipts.forEach(receipt => {
          if (receipt.files && Array.isArray(receipt.files)) {
            receipt.files.forEach(file => {
              if (file.filename) {
                cleanupResults.files.push(file.filename)
              }
            })
          }
        })
        
        await q(`
          FOR receipt IN receipts
          FILTER receipt.receipt_no LIKE @prefix OR receipt.investor_name LIKE @customerPrefix
          REMOVE receipt IN receipts
        `, { 
          prefix: `${receiptPrefix}%`,
          customerPrefix: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}%`
        })
        cleanupResults.receipts = receipts.length
        console.log(`[Cleanup] Deleted ${receipts.length} test receipts`)
      }
    } catch (error) {
      cleanupResults.errors.push(`Receipts cleanup error: ${error.message}`)
    }
    
    // Cleanup users
    try {
      const userPrefix = TEST_CONFIG.TEST_PREFIX.USER
      const users = await q(`
        FOR user IN users
        FILTER user.emp_code LIKE @prefix
        RETURN user._key
      `, { prefix: `${userPrefix}%` })
      
      if (users.length > 0) {
        await q(`
          FOR user IN users
          FILTER user.emp_code LIKE @prefix
          REMOVE user IN users
        `, { prefix: `${userPrefix}%` })
        cleanupResults.users = users.length
        console.log(`[Cleanup] Deleted ${users.length} test users`)
      }
    } catch (error) {
      cleanupResults.errors.push(`Users cleanup error: ${error.message}`)
    }
    
    // Cleanup branches
    try {
      const branchPrefix = TEST_CONFIG.TEST_PREFIX.BRANCH
      const branches = await q(`
        FOR branch IN branches
        FILTER branch.branch_name LIKE @prefix OR branch.branch_code LIKE @prefix
        RETURN branch._key
      `, { prefix: `${branchPrefix}%` })
      
      if (branches.length > 0) {
        await q(`
          FOR branch IN branches
          FILTER branch.branch_name LIKE @prefix OR branch.branch_code LIKE @prefix
          REMOVE branch IN branches
        `, { prefix: `${branchPrefix}%` })
        cleanupResults.branches = branches.length
        console.log(`[Cleanup] Deleted ${branches.length} test branches`)
      }
    } catch (error) {
      cleanupResults.errors.push(`Branches cleanup error: ${error.message}`)
    }
    
    // Cleanup issues
    try {
      const issuePrefix = TEST_CONFIG.TEST_PREFIX.ISSUE
      const issues = await q(`
        FOR issue IN issues
        FILTER issue.title LIKE @prefix OR issue.description LIKE @prefix
        RETURN issue._key
      `, { prefix: `${issuePrefix}%` })
      
      if (issues.length > 0) {
        await q(`
          FOR issue IN issues
          FILTER issue.title LIKE @prefix OR issue.description LIKE @prefix
          REMOVE issue IN issues
        `, { prefix: `${issuePrefix}%` })
        cleanupResults.issues = issues.length
        console.log(`[Cleanup] Deleted ${issues.length} test issues`)
      }
    } catch (error) {
      cleanupResults.errors.push(`Issues cleanup error: ${error.message}`)
    }
    
    // Cleanup uploaded files
    if (cleanupResults.files.length > 0) {
      const fs = await import('fs')
      const path = await import('path')
      const { uploadsDir } = await import('../../config/environment.js')
      
      cleanupResults.files.forEach(filename => {
        try {
          const filePath = path.join(uploadsDir, filename)
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
          }
        } catch (error) {
          cleanupResults.errors.push(`File deletion error (${filename}): ${error.message}`)
        }
      })
      
      console.log(`[Cleanup] Deleted ${cleanupResults.files.length} test files`)
    }
    
    console.log('[Cleanup] Test data cleanup completed')
    
  } catch (error) {
    cleanupResults.errors.push(`General cleanup error: ${error.message}`)
    console.error('[Cleanup] Error during cleanup:', error)
  }
  
  return cleanupResults
}

/**
 * Cleanup specific test data by ID
 */
export async function cleanupSpecificTestData(type, id) {
  try {
    switch (type) {
      case 'customer':
        await q(`
          FOR customer IN customers
          FILTER customer._key == @id
          REMOVE customer IN customers
        `, { id })
        break
      
      case 'receipt':
        const receipt = await q(`
          FOR receipt IN receipts
          FILTER receipt._key == @id
          RETURN receipt
        `, { id })
        
        if (receipt.length > 0 && receipt[0].files) {
          const fs = await import('fs')
          const path = await import('path')
          const { uploadsDir } = await import('../../config/environment.js')
          
          receipt[0].files.forEach(file => {
            if (file.filename) {
              try {
                const filePath = path.join(uploadsDir, file.filename)
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath)
                }
              } catch (error) {
                console.error(`Failed to delete file ${file.filename}:`, error)
              }
            }
          })
        }
        
        await q(`
          FOR receipt IN receipts
          FILTER receipt._key == @id
          REMOVE receipt IN receipts
        `, { id })
        break
      
      case 'user':
        await q(`
          FOR user IN users
          FILTER user._key == @id
          REMOVE user IN users
        `, { id })
        break
      
      default:
        throw new Error(`Unknown cleanup type: ${type}`)
    }
    
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

