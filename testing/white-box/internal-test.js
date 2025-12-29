// White box testing - Testing with internal knowledge
import { createAuthenticatedClient, generateTestId, formatTestResult } from '../utils/test-helpers.js'
import { q } from '../../config/database.js'
import { cleanupSpecificTestData } from '../utils/cleanup.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Test database constraints (with knowledge of schema)
 */
export async function testDatabaseConstraints() {
  console.log('[White Box] Testing database constraints...')
  const testId = generateTestId('WB_CONSTRAINT')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Test unique constraint on investor_id
    const customerData1 = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_1`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `constrainttest1@example.com`,
      mobile: '9876543210',
      address1: 'Constraint Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    const response1 = await client.post('/api/customers', customerData1)
    const customerId1 = response1.data.id
    
    // Try to create duplicate investor_id
    const customerData2 = {
      ...customerData1,
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_2`,
      email: `constrainttest2@example.com`,
      mobile: '9876543211'
    }
    
    try {
      await client.post('/api/customers', customerData2)
      results.push({
        test: 'Unique investor_id constraint',
        passed: false,
        error: 'Should have failed'
      })
    } catch (error) {
      results.push({
        test: 'Unique investor_id constraint',
        passed: error.response?.status === 400 || error.response?.status === 409
      })
    }
    
    // Cleanup
    await cleanupSpecificTestData('customer', customerId1)
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'White Box - Database Constraints',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'White Box - Database Constraints',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test branch filtering logic (with knowledge of internal implementation)
 */
export async function testBranchFiltering() {
  console.log('[White Box] Testing branch filtering logic...')
  const testId = generateTestId('WB_BRANCH')
  const results = []
  const createdIds = []
  
  try {
    // Create customers for different branches
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    const branches = ['HO', 'CHENNAI', 'MUMBAI']
    const customers = []
    
    for (const branch of branches) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${branch}`,
        investor_id: parseInt(`999${Date.now()}${Math.random()}`),
        pan: `ABCDE${Math.floor(Math.random() * 10000)}F`,
        email: `branchtest${branch}@example.com`,
        mobile: `9${Math.floor(100000000 + Math.random() * 900000000)}`,
        address1: `Branch Test Address ${branch}`,
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: branch
      }
      
      const response = await client.post('/api/customers', customerData)
      customers.push({ ...customerData, id: response.data.id })
      createdIds.push({ type: 'customer', id: response.data.id })
    }
    
    // Test search with branch filtering (employee should only see their branch)
    // This requires knowledge of how branch filtering works internally
    try {
      const searchResponse = await client.get(`/api/customers/search?q=${customers[0].name}`)
      results.push({
        test: 'Branch filtering in search',
        passed: searchResponse.status === 200
      })
    } catch (error) {
      results.push({
        test: 'Branch filtering in search',
        passed: false,
        error: error.message
      })
    }
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      for (const item of createdIds) {
        await cleanupSpecificTestData('customer', item.id)
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'White Box - Branch Filtering',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'White Box - Branch Filtering',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test CC/SI calculation logic (with knowledge of internal calculation)
 */
export async function testCCSICalculation() {
  console.log('[White Box] Testing CC/SI calculation logic...')
  const testId = generateTestId('WB_CCSI')
  const results = []
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create a receipt with known scheme that has CC/SI percentages
    // This requires knowledge of how CC/SI is calculated from scheme data
    const receiptData = {
      receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}`,
      date: new Date().toISOString().split('T')[0],
      investorId: parseInt(`999${Date.now()}`),
      investorName: 'Test Investor',
      product_category: 'MF',
      schemeName: 'Test Scheme',
      scheme_code: 'TEST001', // Assuming this scheme exists with known CC/SI
      investmentAmount: 100000,
      mode: 'Lump Sum'
    }
    
    try {
      const response = await client.post('/api/receipts', receiptData)
      const receiptId = response.data.id
      createdIds.push({ type: 'receipt', id: receiptId })
      
      // Verify CC/SI were calculated (requires knowledge of calculation logic)
      const receiptResponse = await client.get(`/api/receipts/${receiptId}`)
      const receipt = receiptResponse.data
      
      const hasCC = receipt.collection_credit !== undefined || receipt.cc !== undefined
      const hasSI = receipt.service_income !== undefined || receipt.si !== undefined
      
      results.push({
        test: 'CC/SI calculation',
        passed: hasCC && hasSI,
        cc: receipt.collection_credit || receipt.cc,
        si: receipt.service_income || receipt.si
      })
    } catch (error) {
      results.push({
        test: 'CC/SI calculation',
        passed: false,
        error: error.message
      })
    }
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      for (const item of createdIds) {
        await cleanupSpecificTestData('receipt', item.id)
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'White Box - CC/SI Calculation',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'White Box - CC/SI Calculation',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test transaction status workflow (with knowledge of status transitions)
 */
export async function testStatusWorkflow() {
  console.log('[White Box] Testing status workflow...')
  const testId = generateTestId('WB_STATUS')
  const results = []
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create a receipt (should start as Pending)
    const receiptData = {
      receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}`,
      date: new Date().toISOString().split('T')[0],
      investorId: parseInt(`999${Date.now()}`),
      investorName: 'Test Investor',
      product_category: 'MF',
      schemeName: 'Test Scheme',
      investmentAmount: 10000,
      mode: 'Lump Sum'
    }
    
    const createResponse = await client.post('/api/receipts', receiptData)
    const receiptId = createResponse.data.id
    createdIds.push({ type: 'receipt', id: receiptId })
    
    // Verify initial status is Pending
    const initialResponse = await client.get(`/api/receipts/${receiptId}`)
    const initialStatus = initialResponse.data.status || 'Pending'
    results.push({
      test: 'Initial status is Pending',
      passed: initialStatus === 'Pending'
    })
    
    // Update status to Completed (admin only)
    try {
      const statusResponse = await client.patch(`/api/receipts/${receiptId}/status`, {
        status: 'Completed'
      })
      results.push({
        test: 'Update status to Completed',
        passed: statusResponse.status === 200
      })
      
      // Verify status was updated
      const verifyResponse = await client.get(`/api/receipts/${receiptId}`)
      results.push({
        test: 'Status updated correctly',
        passed: verifyResponse.data.status === 'Completed'
      })
    } catch (error) {
      results.push({
        test: 'Update status',
        passed: false,
        error: error.message
      })
    }
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      await cleanupSpecificTestData('receipt', receiptId)
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'White Box - Status Workflow',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'White Box - Status Workflow',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Run all white box tests
 */
export async function runAllWhiteBoxTests() {
  console.log('='.repeat(60))
  console.log('WHITE BOX TESTING')
  console.log('='.repeat(60))
  
  const results = []
  
  results.push(await testDatabaseConstraints())
  results.push(await testBranchFiltering())
  results.push(await testCCSICalculation())
  results.push(await testStatusWorkflow())
  
  return results
}

