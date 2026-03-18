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

// Returns all possible receipt.branch values for a user's branch (key, code, name)
// so stats can match receipts regardless of whether they store branch as "ECS005", "5", or branch name.
export const getBranchIdentifiersForFilter = async (userBranch) => {
  if (!userBranch) return []
  const str = String(userBranch).trim()
  if (!str) return []
  try {
    const rows = await q(`
      FOR b IN branches
        FILTER b._key == @str
           OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@str))
           OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@str))
        LIMIT 1
        RETURN [ b._key, b.branch_code, b.branch_name ]
    `, { str })
    if (!rows.length || !rows[0]) return []
    const arr = rows[0]
    const identifiers = [...new Set([arr[0], arr[1], arr[2]].filter(Boolean).map(x => String(x).trim()))]
    return identifiers
  } catch (e) {
    console.error('getBranchIdentifiersForFilter error:', e)
    return []
  }
}

// Helper function to resolve user's branch (name or code) to canonical branch key (branches._key)
// Used for filtering customers by customer.branches[]
export const getCanonicalBranchKey = async (userBranch) => {
  if (!userBranch) return null
  const str = String(userBranch).trim()
  if (!str) return null
  try {
    const rows = await q(`
      FOR b IN branches
        FILTER b._key == @str
           OR (b.branch_code != null && LOWER(TRIM(b.branch_code)) == LOWER(@str))
           OR (b.branch_name != null && LOWER(TRIM(b.branch_name)) == LOWER(@str))
        LIMIT 1
        RETURN b._key
    `, { str })
    if (rows.length) return String(rows[0])
    // Fallback: try normalized name match (e.g. "CHENNAI RO" -> CHENNAI -> match branch_name)
    const normalized = normalizeBranchName(str)
    if (!normalized) return null
    const byNorm = await q(`
      FOR b IN branches
        FILTER b.branch_name != null
          AND (LOWER(TRIM(b.branch_name)) == LOWER(@norm) OR b._key == @norm)
        LIMIT 1
        RETURN b._key
    `, { norm: normalized })
    return byNorm.length ? String(byNorm[0]) : null
  } catch (e) {
    console.error('getCanonicalBranchKey error:', e)
    return null
  }
}

// Helper function to normalize branch names for customer filtering
export const normalizeBranchName = (userBranch) => {
  if (!userBranch) return null
  
  // Map user branch names (from users.branch) to customer relationship_manager / branches as stored in DB
  const branchMapping = {
    // Head Office mappings
    'H.O': 'HO',
    'HO': 'HO',
    'HEAD OFFICE': 'HO',
    'HEADOFFICE': 'HO',
    
    // Chennai branch mappings
    'CHENNAI RO': 'CHENNAI',
    'CHENNAI - MADIPAKKAM': 'MADIPAKKAM',
    
    // Mumbai branch mappings
    'CHEMBUR - MUMBAI': 'CHEMBUR',
    
    // Other branch mappings (keep in sync with frontend branchMapping/API mappings)
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
    'COIMBATORE': 'COIMBATORE',
    // Aliases (same branch, different spelling/name)
    'Yapral': 'SAINIKPURI',
    'YAPRAL': 'SAINIKPURI',
    'WFH KALPANA': 'Thirumullaivoyal',
    'CHANDA NAGAR': 'CHANDANAGAR'
  }
  
  const key = String(userBranch).trim()
  if (!key) return null
  return branchMapping[key] || key
}

// Helper function to check if user can access customer (branch-based filtering)
// Uses canonical branch key and customer.branches[] when present; falls back to relationship_manager
export const canAccessCustomer = async (userId, customerBranchesOrRm) => {
  try {
    const users = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: userId })
    
    if (users.length > 0 && users[0] === 'admin') return true
    
    const userBranch = await getUserBranch(userId)
    const canonicalKey = await getCanonicalBranchKey(userBranch)
    if (!canonicalKey) return false

    if (Array.isArray(customerBranchesOrRm)) {
      return customerBranchesOrRm.some(b => String(b) === canonicalKey)
    }
    if (customerBranchesOrRm != null && customerBranchesOrRm !== '') {
      return String(customerBranchesOrRm) === canonicalKey
    }
    return false
  } catch (error) {
    console.error(`[Access Check] Error checking access for user ${userId}:`, error)
    throw error
  }
}

export default db
