import 'dotenv/config'
import { Database } from 'arangojs'
import fs from 'fs'
import path from 'path'

console.log('📦 Creating data dumps for deployment...\n')

// Database connection
const db = new Database({
  url: process.env.ARANGO_URL,
  auth: { username: process.env.ARANGO_USERNAME, password: process.env.ARANGO_PASSWORD },
  databaseName: process.env.ARANGO_DATABASE
})

const dataDir = path.join(process.cwd(), 'data')

// Create data directory if it doesn't exist
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

try {
  // Dump users data
  console.log('👥 Dumping users data...')
  const usersQuery = `
    FOR user IN users
    RETURN user
  `
  const usersCursor = await db.query(usersQuery)
  const users = await usersCursor.all()
  
  // Remove sensitive data for security
  const usersForDump = users.map(user => ({
    _key: user._key,
    emp_code: user.emp_code,
    name: user.name,
    email: user.email,
    role: user.role,
    branch: user.branch,
    branch_code: user.branch_code,
    is_active: user.is_active,
    created_at: user.created_at,
    source_type: user.source_type
    // Note: password_hash is intentionally excluded for security
  }))
  
  fs.writeFileSync(
    path.join(dataDir, 'users.json'),
    JSON.stringify(usersForDump, null, 2)
  )
  console.log(`✅ Users dumped: ${usersForDump.length} records`)

  // Dump customers data
  console.log('👤 Dumping customers data...')
  const customersQuery = `
    FOR customer IN customers
    RETURN customer
  `
  const customersCursor = await db.query(customersQuery)
  const customers = await customersCursor.all()
  
  fs.writeFileSync(
    path.join(dataDir, 'customers.json'),
    JSON.stringify(customers, null, 2)
  )
  console.log(`✅ Customers dumped: ${customers.length} records`)

  // Dump branches data
  console.log('🏢 Dumping branches data...')
  const branchesQuery = `
    FOR branch IN branches
    RETURN branch
  `
  const branchesCursor = await db.query(branchesQuery)
  const branches = await branchesCursor.all()
  
  fs.writeFileSync(
    path.join(dataDir, 'branches.json'),
    JSON.stringify(branches, null, 2)
  )
  console.log(`✅ Branches dumped: ${branches.length} records`)

  // Create data summary
  const summary = {
    timestamp: new Date().toISOString(),
    collections: {
      users: usersForDump.length,
      customers: customers.length,
      branches: branches.length
    },
    note: "Password hashes excluded from users dump for security. Set default password 'password123' for all users during import."
  }
  
  fs.writeFileSync(
    path.join(dataDir, 'data-summary.json'),
    JSON.stringify(summary, null, 2)
  )

  console.log('\n📊 Data Dump Summary:')
  console.log(`👥 Users: ${usersForDump.length} records`)
  console.log(`👤 Customers: ${customers.length} records`)
  console.log(`🏢 Branches: ${branches.length} records`)
  console.log(`📁 Data directory: ${dataDir}`)
  console.log('\n✅ All data dumps created successfully!')

} catch (error) {
  console.error('❌ Error creating data dumps:', error.message)
  process.exit(1)
} finally {
  process.exit(0)
}
