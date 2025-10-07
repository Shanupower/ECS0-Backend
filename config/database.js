import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'http://localhost:8529',
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

// Helper function to normalize branch names for customer filtering
export const normalizeBranchName = (userBranch) => {
  if (!userBranch) return null
  
  // Map user branch names to customer relationship_manager names
  const branchMapping = {
    // Head Office mappings
    'H.O': 'HO',
    'HO': 'HO',
    'HEAD OFFICE': 'HO',
    'HEADOFFICE': 'HO',
    
    // Chennai branch mappings
    'CHENNAI RO': 'CHENNAI T NAGAR',
    'CHENNAI - MADIPAKKAM': 'MADIPAKKAM CHENNAI',
    
    // Mumbai branch mappings
    'CHEMBUR - MUMBAI': 'CHEMBUR',
    
    // Other branch mappings
    'JAYANAGAR': 'JAYANAGAR',
    'VIZAG': 'VIZAG',
    'MALLESWARAM': 'MALLESWARAM',
    'BAGH AMBERPET': 'BAGH AMBERPET',
    'KUKAT PALLY': 'KUKATPALLY',
    'AMEER PET': 'AMEERPET',
    'RAJAHMUNDRY': 'RAJAHMUNDRY',
    'DILSUKHNAGAR': 'DILSUKHNAGAR',
    'MADHAPUR': 'MADHAPUR',
    'MALKAJGIRI': 'MALKAJGIRI',
    'SUCHITRA': 'SUCHITRA',
    'TRIMULGHERRY': 'TRIMULGHERRY',
    'WARANGAL': 'WARANGAL',
    'GAJUWAKA': 'GAJUWAKA',
    'VIJAYAWADA': 'VIJAYAWADA',
    'BASHEERBAGH': 'BASHEERBAGH',
    'HABSIGUDA': 'HABSIGUDA',
    'COIMBATORE': 'COIMBATORE'
  }
  
  return branchMapping[userBranch] || userBranch
}

// Helper function to check if user can access customer (branch-based filtering)
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
    
    const hasAccess = normalizedUserBranch && normalizedUserBranch === customerRelationshipManager
    console.log(`[Access Check] Access result: ${hasAccess}`)
    
    return hasAccess
  } catch (error) {
    console.error(`[Access Check] Error checking access for user ${userId}:`, error)
    throw error
  }
}

export default db
