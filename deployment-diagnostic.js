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
const q = async (query, bindVars = {}) => {
  try {
    const cursor = await db.query(query, bindVars)
    return await cursor.all()
  } catch (error) {
    console.error('ArangoDB query error:', error)
    throw error
  }
}

// Test customer update functionality in deployment environment
async function diagnosticCustomerUpdate() {
  try {
    console.log('🔍 Deployment Diagnostic for Customer Update...')
    console.log('=' .repeat(60))
    
    // 1. Environment Check
    console.log('\n1. 🌍 ENVIRONMENT CHECK')
    console.log(`   ARANGO_URL: ${ARANGO_URL}`)
    console.log(`   ARANGO_DATABASE: ${ARANGO_DATABASE}`)
    console.log(`   ARANGO_USERNAME: ${ARANGO_USERNAME}`)
    console.log(`   ARANGO_PASSWORD: ${ARANGO_PASSWORD ? '***' : 'Empty'}`)
    console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'Not set'}`)
    
    // 2. Database Connection Test
    console.log('\n2. 🔗 DATABASE CONNECTION TEST')
    try {
      await q('RETURN 1')
      console.log('   ✅ Database connection successful')
    } catch (error) {
      console.log('   ❌ Database connection failed:', error.message)
      return
    }
    
    // 3. Collections Check
    console.log('\n3. 📚 COLLECTIONS CHECK')
    try {
      const collections = await q('FOR c IN COLLECTIONS() RETURN c.name')
      console.log(`   Available collections: ${collections.join(', ')}`)
      
      if (collections.includes('customers')) {
        console.log('   ✅ Customers collection exists')
      } else {
        console.log('   ❌ Customers collection missing')
        return
      }
      
      if (collections.includes('users')) {
        console.log('   ✅ Users collection exists')
      } else {
        console.log('   ❌ Users collection missing')
      }
    } catch (error) {
      console.log('   ❌ Collections check failed:', error.message)
    }
    
    // 4. Customer Data Check
    console.log('\n4. 👥 CUSTOMER DATA CHECK')
    try {
      const customerCount = await q('FOR c IN customers COLLECT WITH COUNT INTO total RETURN total')
      console.log(`   Total customers: ${customerCount[0] || 0}`)
      
      const sampleCustomers = await q(`
        FOR customer IN customers 
        LIMIT 3
        RETURN {
          investor_id: customer.investor_id,
          name: customer.name || customer.investor_name,
          relationship_manager: customer.relationship_manager,
          pan: customer.pan,
          created_at: customer.created_at
        }
      `)
      
      console.log('   Sample customers:')
      sampleCustomers.forEach((cust, i) => {
        console.log(`     ${i + 1}. ID: ${cust.investor_id}, Name: ${cust.name}, RM: ${cust.relationship_manager}`)
      })
    } catch (error) {
      console.log('   ❌ Customer data check failed:', error.message)
    }
    
    // 5. User Data Check
    console.log('\n5. 👤 USER DATA CHECK')
    try {
      const userCount = await q('FOR u IN users COLLECT WITH COUNT INTO total RETURN total')
      console.log(`   Total users: ${userCount[0] || 0}`)
      
      const sampleUsers = await q(`
        FOR user IN users 
        LIMIT 3
        RETURN {
          _key: user._key,
          emp_code: user.emp_code,
          name: user.name,
          role: user.role,
          branch: user.branch,
          is_active: user.is_active
        }
      `)
      
      console.log('   Sample users:')
      sampleUsers.forEach((user, i) => {
        console.log(`     ${i + 1}. ${user.emp_code} (${user.name}) - Role: ${user.role}, Branch: ${user.branch}`)
      })
    } catch (error) {
      console.log('   ❌ User data check failed:', error.message)
    }
    
    // 6. Test Customer Update Query
    console.log('\n6. 🔧 CUSTOMER UPDATE QUERY TEST')
    try {
      // Find a customer to test with
      const testCustomer = await q(`
        FOR customer IN customers 
        LIMIT 1
        RETURN customer
      `)
      
      if (testCustomer.length === 0) {
        console.log('   ❌ No customers found for testing')
        return
      }
      
      const customer = testCustomer[0]
      console.log(`   Testing with customer: ${customer.investor_id}`)
      
      // Test the exact update query from the API
      const updateResult = await q(`
        FOR customer IN customers
        FILTER customer.investor_id == @id
        UPDATE customer WITH @updates IN customers
        RETURN NEW
      `, { 
        id: customer.investor_id, 
        updates: { 
          diagnostic_test: new Date().toISOString(),
          updated_at: new Date().toISOString()
        } 
      })
      
      if (updateResult.length > 0) {
        console.log('   ✅ Customer update query successful')
        
        // Clean up test data
        await q(`
          FOR customer IN customers
          FILTER customer.investor_id == @id
          UPDATE customer WITH { diagnostic_test: null } IN customers
        `, { id: customer.investor_id })
        console.log('   ✅ Test data cleaned up')
      } else {
        console.log('   ❌ Customer update query failed - no records affected')
      }
    } catch (error) {
      console.log('   ❌ Customer update test failed:', error.message)
      console.log('   Error details:', error.code, error.errorNum)
    }
    
    // 7. Branch Access Test
    console.log('\n7. 🏢 BRANCH ACCESS TEST')
    try {
      const testUser = await q(`
        FOR user IN users 
        LIMIT 1
        RETURN user
      `)
      
      if (testUser.length > 0) {
        const user = testUser[0]
        console.log(`   Testing with user: ${user.emp_code}`)
        
        // Test getUserBranch function
        const userBranch = await q(`
          FOR user IN users 
          FILTER user._key == @id
          LIMIT 1
          RETURN user.branch
        `, { id: user._key })
        
        console.log(`   User branch: ${userBranch[0] || 'No branch assigned'}`)
        
        // Test branch normalization
        const branchMapping = {
          'H.O': 'HEADOFFICE',
          'HO': 'HEADOFFICE',
          'HEAD OFFICE': 'HEADOFFICE',
          'HEADOFFICE': 'HEADOFFICE',
          'CHENNAI RO': 'CHENNAI T NAGAR',
          'JAYANAGAR': 'JAYA NAGAR',
          'CHEMBUR - MUMBAI': 'CHEMBUR-MUMBAI',
          'VIZAG': 'VISHAKAPATNAM',
          'MALLESWARAM': 'MALLESWARAM-BENGALURU',
          'BAGH AMBERPET': 'BAGHAMBERPET',
          'KUKAT PALLY': 'KUKATPALLY',
          'AMEER PET': 'AMEERPET',
          'CHENNAI - MADIPAKKAM': 'MADIPAKKAM CHENNAI',
          'RAJAHMUNDRY': 'RAJAMUNDRY'
        }
        
        const userBranchName = userBranch[0]
        const normalizedBranch = branchMapping[userBranchName] || userBranchName
        console.log(`   Normalized branch: ${normalizedBranch}`)
        
        // Check customers with this relationship manager
        const customersWithRM = await q(`
          FOR customer IN customers
          FILTER customer.relationship_manager == @rm
          COLLECT WITH COUNT INTO total
          RETURN total
        `, { rm: normalizedBranch })
        
        console.log(`   Customers with this RM: ${customersWithRM[0] || 0}`)
      }
    } catch (error) {
      console.log('   ❌ Branch access test failed:', error.message)
    }
    
    // 8. Common Deployment Issues
    console.log('\n8. 🚨 COMMON DEPLOYMENT ISSUES CHECK')
    
    // Check if running in production
    if (process.env.NODE_ENV === 'production') {
      console.log('   ⚠️  Running in production mode')
    }
    
    // Check memory usage
    const memUsage = process.memoryUsage()
    console.log(`   Memory usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`)
    
    // Check if running as service/daemon
    if (process.env.PM2_USAGE) {
      console.log('   ℹ️  Running under PM2')
    }
    
    console.log('\n' + '=' .repeat(60))
    console.log('✅ Deployment diagnostic completed!')
    console.log('\n📋 NEXT STEPS:')
    console.log('1. Check server logs for [Customer Update] entries')
    console.log('2. Verify database connection in production')
    console.log('3. Ensure all environment variables are set correctly')
    console.log('4. Test the customer update endpoint with the improved logging')
    
  } catch (error) {
    console.error('\n❌ Diagnostic failed:', error.message)
    console.error('Full error:', error)
  }
}

// Run the diagnostic
diagnosticCustomerUpdate().then(() => {
  console.log('\n🏁 Diagnostic completed')
  process.exit(0)
}).catch(error => {
  console.error('Diagnostic runner error:', error)
  process.exit(1)
})
