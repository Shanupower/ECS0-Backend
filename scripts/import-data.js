import 'dotenv/config'
import { Database } from 'arangojs'
import fs from 'fs'
import path from 'path'
import bcrypt from 'bcryptjs'

console.log('📥 Importing data for deployment...\n')

// Database connection
const db = new Database({
  url: process.env.ARANGO_URL,
  auth: { username: process.env.ARANGO_USERNAME, password: process.env.ARANGO_PASSWORD },
  databaseName: process.env.ARANGO_DATABASE
})

const dataDir = path.join(process.cwd(), 'data')

try {
  // Import users data
  console.log('👥 Importing users data...')
  const usersData = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'))
  
  // Hash default password for all users
  const defaultPasswordHash = await bcrypt.hash('password123', 10)
  
  const usersWithPasswords = usersData.map(user => ({
    ...user,
    password_hash: defaultPasswordHash,
    updated_at: new Date().toISOString()
  }))
  
  const usersCollection = db.collection('users')
  await usersCollection.truncate() // Clear existing users
  
  const usersResult = await usersCollection.import(usersWithPasswords)
  console.log(`✅ Users imported: ${usersResult.imported} records`)

  // Import customers data
  console.log('👤 Importing customers data...')
  const customersData = JSON.parse(fs.readFileSync(path.join(dataDir, 'customers.json'), 'utf8'))
  
  const customersCollection = db.collection('customers')
  await customersCollection.truncate() // Clear existing customers
  
  const customersResult = await customersCollection.import(customersData)
  console.log(`✅ Customers imported: ${customersResult.imported} records`)

  // Import branches data
  console.log('🏢 Importing branches data...')
  const branchesData = JSON.parse(fs.readFileSync(path.join(dataDir, 'branches.json'), 'utf8'))
  
  const branchesCollection = db.collection('branches')
  await branchesCollection.truncate() // Clear existing branches
  
  const branchesResult = await branchesCollection.import(branchesData)
  console.log(`✅ Branches imported: ${branchesResult.imported} records`)

  console.log('\n📊 Import Summary:')
  console.log(`👥 Users: ${usersResult.imported} records`)
  console.log(`👤 Customers: ${customersResult.imported} records`)
  console.log(`🏢 Branches: ${branchesResult.imported} records`)
  console.log('\n🔐 Default password for all users: password123')
  console.log('✅ All data imported successfully!')

} catch (error) {
  console.error('❌ Error importing data:', error.message)
  process.exit(1)
} finally {
  process.exit(0)
}
