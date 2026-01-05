// Edge case testing - Boundary conditions
import { createAuthenticatedClient, generateTestId, formatTestResult, assert } from '../utils/test-helpers.js'
import { cleanupSpecificTestData } from '../utils/cleanup.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Test minimum field lengths
 */
export async function testMinimumFieldLengths() {
  console.log('[Edge Case] Testing minimum field lengths...')
  const testId = generateTestId('MIN_LEN')
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Test minimum valid values
    const minCustomerData = {
      name: 'A', // Minimum 1 character
      investor_id: 1, // Minimum value
      pan: 'ABCDE1234F', // Valid PAN
      email: 'a@b.c', // Minimum valid email
      mobile: '6000000000', // Valid mobile starting with 6
      address1: 'A',
      city: 'A',
      state: 'A',
      pin_code: '000000', // Minimum PIN
      relationship_manager: 'HO'
    }
    
    const start = Date.now()
    const response = await client.post('/api/customers', minCustomerData)
    const duration = Date.now() - start
    
    if (response.data && response.data.id) {
      createdIds.push({ type: 'customer', id: response.data.id })
    }
    
    const passed = response.status === 201
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY && createdIds.length > 0) {
      await cleanupSpecificTestData('customer', createdIds[0].id)
    }
    
    return formatTestResult(
      'Edge Case - Minimum Field Lengths',
      passed,
      duration,
      { status: response.status, data: response.data }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Minimum Field Lengths',
      false,
      0,
      { error: error.message, status: error.response?.status }
    )
  }
}

/**
 * Test maximum field lengths
 */
export async function testMaximumFieldLengths() {
  console.log('[Edge Case] Testing maximum field lengths...')
  const testId = generateTestId('MAX_LEN')
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Test maximum valid values (assuming reasonable limits)
    const longString = 'A'.repeat(1000) // Very long string
    const maxCustomerData = {
      name: longString.substring(0, 200), // Reasonable max for name
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `${'a'.repeat(50)}@${'b'.repeat(50)}.com`, // Long email
      mobile: '9999999999',
      address1: longString.substring(0, 500),
      address2: longString.substring(0, 500),
      address3: longString.substring(0, 500),
      city: longString.substring(0, 100),
      state: longString.substring(0, 100),
      pin_code: '999999',
      relationship_manager: 'HO'
    }
    
    const start = Date.now()
    const response = await client.post('/api/customers', maxCustomerData)
    const duration = Date.now() - start
    
    if (response.data && response.data.id) {
      createdIds.push({ type: 'customer', id: response.data.id })
    }
    
    const passed = response.status === 201
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY && createdIds.length > 0) {
      await cleanupSpecificTestData('customer', createdIds[0].id)
    }
    
    return formatTestResult(
      'Edge Case - Maximum Field Lengths',
      passed,
      duration,
      { status: response.status }
    )
  } catch (error) {
    // This might fail if there are max length validations - that's expected
    return formatTestResult(
      'Edge Case - Maximum Field Lengths',
      error.response?.status === 400, // Expected to fail with validation error
      0,
      { error: error.message, status: error.response?.status }
    )
  }
}

/**
 * Test boundary numeric values
 */
export async function testBoundaryNumericValues() {
  console.log('[Edge Case] Testing boundary numeric values...')
  const testId = generateTestId('NUM_BOUND')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Test cases: zero, negative, very large numbers, decimal values
    const testCases = [
      { name: 'Zero amount', amount: 0, shouldFail: true },
      { name: 'Negative amount', amount: -100, shouldFail: true },
      { name: 'Very small positive', amount: 0.01, shouldFail: false },
      { name: 'Very large number', amount: 999999999999, shouldFail: false },
      { name: 'Decimal precision', amount: 12345.67, shouldFail: false }
    ]
    
    for (const testCase of testCases) {
      const receiptData = {
        receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}_${testCase.name.replace(/\s/g, '_')}`,
        date: new Date().toISOString().split('T')[0],
        investorId: parseInt(`999${Date.now()}`),
        investorName: 'Test Investor',
        product_category: 'MF',
        schemeName: 'Test Scheme',
        investmentAmount: testCase.amount,
        mode: 'Lump Sum'
      }
      
      try {
        const response = await client.post('/api/receipts', receiptData)
        const passed = testCase.shouldFail ? false : response.status === 201
        results.push({
          testCase: testCase.name,
          passed,
          expectedFailure: testCase.shouldFail,
          actualStatus: response.status
        })
        
        // Cleanup if created
        if (response.data && response.data.id) {
          await cleanupSpecificTestData('receipt', response.data.id)
        }
      } catch (error) {
        const passed = testCase.shouldFail ? true : false
        results.push({
          testCase: testCase.name,
          passed,
          expectedFailure: testCase.shouldFail,
          actualStatus: error.response?.status || 0
        })
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Boundary Numeric Values',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Boundary Numeric Values',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test date boundaries
 */
export async function testDateBoundaries() {
  console.log('[Edge Case] Testing date boundaries...')
  const testId = generateTestId('DATE_BOUND')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create a test customer first
    const customerData = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `datetest@example.com`,
      mobile: '9876543210',
      address1: 'Date Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    const customerResponse = await client.post('/api/customers', customerData)
    const customerId = customerResponse.data.id
    
    // Test date cases
    const dateCases = [
      { name: 'Today', date: new Date().toISOString().split('T')[0], shouldPass: true },
      { name: 'Past date', date: '2000-01-01', shouldPass: true },
      { name: 'Future date', date: '2099-12-31', shouldPass: true },
      { name: 'Invalid format', date: '01-01-2000', shouldPass: false },
      { name: 'Invalid date', date: '2024-13-45', shouldPass: false },
      { name: 'Empty date', date: '', shouldPass: false },
      { name: 'Null date', date: null, shouldPass: false }
    ]
    
    for (const dateCase of dateCases) {
      const receiptData = {
        receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}_${dateCase.name.replace(/\s/g, '_')}`,
        date: dateCase.date,
        investorId: customerData.investor_id,
        investorName: customerData.name,
        product_category: 'MF',
        schemeName: 'Test Scheme',
        investmentAmount: 10000,
        mode: 'Lump Sum'
      }
      
      try {
        const response = await client.post('/api/receipts', receiptData)
        const passed = dateCase.shouldPass ? response.status === 201 : false
        results.push({
          testCase: dateCase.name,
          passed,
          expectedPass: dateCase.shouldPass,
          actualStatus: response.status
        })
        
        // Cleanup if created
        if (response.data && response.data.id) {
          await cleanupSpecificTestData('receipt', response.data.id)
        }
      } catch (error) {
        const passed = dateCase.shouldPass ? false : true
        results.push({
          testCase: dateCase.name,
          passed,
          expectedPass: dateCase.shouldPass,
          actualStatus: error.response?.status || 0
        })
      }
    }
    
    // Cleanup customer
    await cleanupSpecificTestData('customer', customerId)
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Date Boundaries',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Date Boundaries',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Run all boundary tests
 */
export async function runAllBoundaryTests() {
  console.log('='.repeat(60))
  console.log('EDGE CASE TESTING - BOUNDARY CONDITIONS')
  console.log('='.repeat(60))
  
  const results = []
  
  results.push(await testMinimumFieldLengths())
  results.push(await testMaximumFieldLengths())
  results.push(await testBoundaryNumericValues())
  results.push(await testDateBoundaries())
  
  return results
}





