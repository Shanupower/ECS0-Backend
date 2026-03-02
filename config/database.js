import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'https://db.ecsfinancial.tech',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

// ArangoDB connection
const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
})

// Helper function to execute AQL queries
export const q = async (query, bindVars = {}) => {
  try {
    const cursor = await db.query(query, bindVars)
    return await cursor.all()
  } catch (error) {
    console.error('ArangoDB query error:', error)
    throw error
  }
}

// Helper function to get a collection
export const getCollection = (name) => db.collection(name)

// Helper function to get user's branch for filtering
export const getUserBranch = async (userId) => {
  try {
    const users = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.branch
    `, { id: userId })
    return users.length > 0 ? users[0] : null
  } catch (error) {
    console.error('Error getting user branch:', error)
    return null
  }
}

// Use branch names as stored in DB (branches collection). No mapping — store and compare as-is.
export const normalizeBranchName = (userBranch) => {
  if (userBranch == null || userBranch === '') return null
  const s = String(userBranch).trim()
  return s || null
}

// Helper function to check if user can access customer (branch-based filtering)
// Supports both single branch (string) and multiple branches (array) for backward compatibility
export const canAccessCustomer = async (userId, customerRelationshipManager) => {
  try {
    console.log(`[Access Check] Checking access for user ${userId} to customer with RM ${customerRelationshipManager}`)
    
    // Admin users can access all customers
    const users = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: userId })
    
    if (users.length > 0 && users[0] === 'admin') {
      console.log(`[Access Check] User ${userId} is admin - access granted`)
      return true
    }
    
    // Non-admin users can only access their branch customers
    const userBranch = await getUserBranch(userId)
    console.log(`[Access Check] User ${userId} branch: ${userBranch}`)
    
    const normalizedUserBranch = normalizeBranchName(userBranch)
    console.log(`[Access Check] Normalized user branch: ${normalizedUserBranch}`)
    console.log(`[Access Check] Customer RM: ${customerRelationshipManager}`)
    
    // Handle both single branch (string) and multiple branches (array)
    let hasAccess = false
    if (Array.isArray(customerRelationshipManager)) {
      // Check if user's branch is in the customer's branches array
      hasAccess = normalizedUserBranch && customerRelationshipManager.includes(normalizedUserBranch)
    } else {
      // Backward compatibility: single branch string
      hasAccess = normalizedUserBranch && normalizedUserBranch === customerRelationshipManager
    }
    
    console.log(`[Access Check] Access result: ${hasAccess}`)
    
    return hasAccess
  } catch (error) {
    console.error(`[Access Check] Error checking access for user ${userId}:`, error)
    throw error
  }
}

export default db
