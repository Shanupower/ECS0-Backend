// Black box testing - API testing without internal knowledge
import { createAuthenticatedClient, generateTestId, formatTestResult, validateResponse } from '../utils/test-helpers.js'
import { cleanupSpecificTestData } from '../utils/cleanup.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Test authentication endpoints
 */
export async function testAuthentication() {
  console.log('[Black Box] Testing authentication...')
  const results = []
  
  try {
    const client = await createAuthenticatedClient()
    
    // Test login with valid credentials
    try {
      const loginResponse = await client.post('/api/auth/login', TEST_CONFIG.TEST_ADMIN)
      const loginValid = validateResponse(loginResponse.data, ['token', 'user'])
      results.push({
        test: 'Valid login',
        passed: loginValid.valid && loginResponse.status === 200,
        details: loginValid
      })
    } catch (error) {
      results.push({
        test: 'Valid login',
        passed: false,
        error: error.message
      })
    }
    
    // Test login with invalid credentials
    try {
      await client.post('/api/auth/login', {
        emp_code: 'INVALID',
        password: 'INVALID'
      })
      results.push({
        test: 'Invalid login',
        passed: false,
        error: 'Should have failed'
      })
    } catch (error) {
      results.push({
        test: 'Invalid login',
        passed: error.response?.status === 401,
        status: error.response?.status
      })
    }
    
    // Test login with missing fields
    try {
      await client.post('/api/auth/login', { emp_code: 'TEST' })
      results.push({
        test: 'Login missing password',
        passed: false,
        error: 'Should have failed'
      })
    } catch (error) {
      results.push({
        test: 'Login missing password',
        passed: error.response?.status === 400,
        status: error.response?.status
      })
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Black Box - Authentication',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Black Box - Authentication',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test customer CRUD operations
 */
export async function testCustomerCRUD() {
  console.log('[Black Box] Testing customer CRUD operations...')
  const testId = generateTestId('BB_CUSTOMER')
  const createdIds = []
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // CREATE
    const customerData = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `bbtest@example.com`,
      mobile: '9876543210',
      address1: 'Black Box Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    try {
      const createResponse = await client.post('/api/customers', customerData)
      const createValid = validateResponse(createResponse.data, ['id'])
      results.push({
        test: 'Create customer',
        passed: createValid.valid && createResponse.status === 201,
        customerId: createResponse.data?.id
      })
      
      if (createResponse.data?.id) {
        createdIds.push({ type: 'customer', id: createResponse.data.id })
        const customerId = createResponse.data.id
        
        // READ
        try {
          const readResponse = await client.get(`/api/customers/${customerId}`)
          const readValid = validateResponse(readResponse.data, ['id', 'name', 'investor_id'])
          results.push({
            test: 'Read customer',
            passed: readValid.valid && readResponse.status === 200,
            details: readValid
          })
        } catch (error) {
          results.push({
            test: 'Read customer',
            passed: false,
            error: error.message
          })
        }
        
        // UPDATE
        try {
          const updateData = { address1: 'Updated Address' }
          const updateResponse = await client.patch(`/api/customers/${customerId}`, updateData)
          results.push({
            test: 'Update customer',
            passed: updateResponse.status === 204 || updateResponse.status === 200
          })
          
          // Verify update
          const verifyResponse = await client.get(`/api/customers/${customerId}`)
          results.push({
            test: 'Verify update',
            passed: verifyResponse.data.address1 === 'Updated Address'
          })
        } catch (error) {
          results.push({
            test: 'Update customer',
            passed: false,
            error: error.message
          })
        }
        
        // DELETE
        try {
          const deleteResponse = await client.delete(`/api/customers/${customerId}`)
          results.push({
            test: 'Delete customer',
            passed: deleteResponse.status === 204 || deleteResponse.status === 200
          })
          
          // Verify deletion
          try {
            await client.get(`/api/customers/${customerId}`)
            results.push({
              test: 'Verify deletion',
              passed: false,
              error: 'Customer still exists'
            })
          } catch (error) {
            results.push({
              test: 'Verify deletion',
              passed: error.response?.status === 404
            })
          }
        } catch (error) {
          results.push({
            test: 'Delete customer',
            passed: false,
            error: error.message
          })
        }
      }
    } catch (error) {
      results.push({
        test: 'Create customer',
        passed: false,
        error: error.message
      })
    }
    
    // Cleanup (in case delete failed)
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      for (const item of createdIds) {
        await cleanupSpecificTestData(item.type, item.id)
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Black Box - Customer CRUD',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Black Box - Customer CRUD',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test receipt creation and retrieval
 */
export async function testReceiptOperations() {
  console.log('[Black Box] Testing receipt operations...')
  const testId = generateTestId('BB_RECEIPT')
  const createdIds = []
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create a test customer first
    const customerData = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `receipttest@example.com`,
      mobile: '9876543210',
      address1: 'Receipt Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    const customerResponse = await client.post('/api/customers', customerData)
    const customerId = customerResponse.data.id
    createdIds.push({ type: 'customer', id: customerId })
    
    // CREATE receipt
    const receiptData = {
      receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}`,
      date: new Date().toISOString().split('T')[0],
      investorId: customerData.investor_id,
      investorName: customerData.name,
      product_category: 'MF',
      schemeName: 'Test Scheme',
      investmentAmount: 10000,
      mode: 'Lump Sum'
    }
    
    try {
      const createResponse = await client.post('/api/receipts', receiptData)
      const createValid = validateResponse(createResponse.data, ['id'])
      results.push({
        test: 'Create receipt',
        passed: createValid.valid && createResponse.status === 201,
        receiptId: createResponse.data?.id
      })
      
      if (createResponse.data?.id) {
        createdIds.push({ type: 'receipt', id: createResponse.data.id })
        const receiptId = createResponse.data.id
        
        // READ receipt
        try {
          const readResponse = await client.get(`/api/receipts/${receiptId}`)
          const readValid = validateResponse(readResponse.data, ['receipt_no', 'investor_id'])
          results.push({
            test: 'Read receipt',
            passed: readValid.valid && readResponse.status === 200
          })
        } catch (error) {
          results.push({
            test: 'Read receipt',
            passed: false,
            error: error.message
          })
        }
        
        // LIST receipts
        try {
          const listResponse = await client.get('/api/receipts?page=1&size=10')
          const listValid = validateResponse(listResponse.data, ['items', 'total', 'page'])
          results.push({
            test: 'List receipts',
            passed: listValid.valid && listResponse.status === 200
          })
        } catch (error) {
          results.push({
            test: 'List receipts',
            passed: false,
            error: error.message
          })
        }
      }
    } catch (error) {
      results.push({
        test: 'Create receipt',
        passed: false,
        error: error.message
      })
    }
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      for (const item of createdIds) {
        await cleanupSpecificTestData(item.type, item.id)
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Black Box - Receipt Operations',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Black Box - Receipt Operations',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test pagination
 */
export async function testPagination() {
  console.log('[Black Box] Testing pagination...')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Test page 1
    try {
      const page1Response = await client.get('/api/customers?page=1&size=10')
      const page1Valid = validateResponse(page1Response.data, ['items', 'page', 'total'])
      results.push({
        test: 'Page 1',
        passed: page1Valid.valid && page1Response.data.page === 1
      })
    } catch (error) {
      results.push({
        test: 'Page 1',
        passed: false,
        error: error.message
      })
    }
    
    // Test page 2
    try {
      const page2Response = await client.get('/api/customers?page=2&size=10')
      const page2Valid = validateResponse(page2Response.data, ['items', 'page', 'total'])
      results.push({
        test: 'Page 2',
        passed: page2Valid.valid && page2Response.data.page === 2
      })
    } catch (error) {
      results.push({
        test: 'Page 2',
        passed: false,
        error: error.message
      })
    }
    
    // Test invalid page
    try {
      await client.get('/api/customers?page=0&size=10')
      results.push({
        test: 'Invalid page (0)',
        passed: false,
        error: 'Should have failed'
      })
    } catch (error) {
      results.push({
        test: 'Invalid page (0)',
        passed: error.response?.status === 400 || error.response?.status >= 400
      })
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Black Box - Pagination',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Black Box - Pagination',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test authorization (role-based access)
 */
export async function testAuthorization() {
  console.log('[Black Box] Testing authorization...')
  const results = []
  
  try {
    // Test as employee (should have limited access)
    const employeeClient = await createAuthenticatedClient(TEST_CONFIG.TEST_EMPLOYEE)
    
    // Try to access admin-only endpoint
    try {
      await employeeClient.get('/api/users')
      results.push({
        test: 'Employee accessing admin endpoint',
        passed: false,
        error: 'Should have failed'
      })
    } catch (error) {
      results.push({
        test: 'Employee accessing admin endpoint',
        passed: error.response?.status === 403,
        status: error.response?.status
      })
    }
    
    // Test as admin (should have full access)
    const adminClient = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    try {
      const adminResponse = await adminClient.get('/api/users')
      results.push({
        test: 'Admin accessing admin endpoint',
        passed: adminResponse.status === 200
      })
    } catch (error) {
      results.push({
        test: 'Admin accessing admin endpoint',
        passed: false,
        error: error.message
      })
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Black Box - Authorization',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Black Box - Authorization',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Run all black box tests
 */
export async function runAllBlackBoxTests() {
  console.log('='.repeat(60))
  console.log('BLACK BOX TESTING')
  console.log('='.repeat(60))
  
  const results = []
  
  results.push(await testAuthentication())
  results.push(await testCustomerCRUD())
  results.push(await testReceiptOperations())
  results.push(await testPagination())
  results.push(await testAuthorization())
  
  return results
}





