import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'http://localhost:8529',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

// Connect to database
const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
})

async function fixUserBranchCodes() {
  try {
    console.log('Starting user branch_code migration...')
    
    // Get all users with a branch but no branch_code
    const cursor = await db.query(`
      FOR user IN users
      FILTER user.branch != null AND user.branch_code == null
      RETURN user
    `)
    
    const usersToFix = await cursor.all()
    console.log(`Found ${usersToFix.length} users without branch_code`)
    
    if (usersToFix.length === 0) {
      console.log('No users to migrate')
      return
    }
    
    let updated = 0
    let errors = []
    
    for (const user of usersToFix) {
      try {
        // Look up the branch to get the branch_code
        const branchCursor = await db.query(`
          FOR b IN branches
          FILTER b.branch_name == @branchName OR b.branch_code == @branchName
          LIMIT 1
          RETURN b
        `, { branchName: user.branch })
        
        const branches = await branchCursor.all()
        
        if (branches.length === 0) {
          console.log(`  ⚠ User ${user.emp_code}: Branch "${user.branch}" not found`)
          errors.push({
            emp_code: user.emp_code,
            branch: user.branch,
            error: 'Branch not found'
          })
          continue
        }
        
        const branch = branches[0]
        
        // Update user with branch_code
        await db.query(`
          UPDATE @key WITH { 
            branch_code: @branch_code 
          } IN users
        `, { 
          key: user._key,
          branch_code: branch.branch_code
        })
        
        console.log(`  ✓ Updated ${user.emp_code} with branch_code: ${branch.branch_code}`)
        updated++
        
      } catch (error) {
        console.error(`  ✗ Error updating user ${user.emp_code}:`, error.message)
        errors.push({
          emp_code: user.emp_code,
          branch: user.branch,
          error: error.message
        })
      }
    }
    
    console.log('\nMigration completed!')
    console.log(`Updated: ${updated} users`)
    
    if (errors.length > 0) {
      console.log(`\nErrors: ${errors.length}`)
      errors.forEach(err => {
        console.log(`  - ${err.emp_code} (${err.branch}): ${err.error}`)
      })
    }
    
    // Verify results
    const verifyCountCursor = await db.query(`
      FOR user IN users
      FILTER user.branch_code != null
      COLLECT WITH COUNT INTO count
      RETURN count
    `)
    
    const verifyResult = await verifyCountCursor.all()
    console.log(`\nTotal users with branch_code field: ${verifyResult[0]}`)
    
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

// Run migration
fixUserBranchCodes()
  .then(() => {
    console.log('Migration script completed successfully')
    process.exit(0)
  })
  .catch(error => {
    console.error('Migration script failed:', error)
    process.exit(1)
  })

