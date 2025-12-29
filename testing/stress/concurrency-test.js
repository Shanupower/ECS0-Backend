// Stress testing - Concurrency testing suite
import { createAuthenticatedClient, generateTestId, runConcurrentRequests, measureTime, formatTestResult, sleep } from '../utils/test-helpers.js'
import { cleanupTestData, cleanupSpecificTestData } from '../utils/cleanup.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Test concurrent customer updates
 */
export async function testConcurrentUpdates() {
  console.log('[Concurrency Test] Testing concurrent updates...')
  const testId = generateTestId('CONC_UPDATE')
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create a test customer
    const customerData = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `conctest@example.com`,
      mobile: '9876543210',
      address1: 'Concurrency Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    const createResponse = await client.post('/api/customers', customerData)
    const customerId = createResponse.data.id
    createdIds.push({ type: 'customer', id: customerId })
    
    // Create concurrent update requests
    const updateRequests = Array.from({ length: 20 }, (_, i) => {
      return async () => {
        const start = Date.now()
        try {
          const response = await client.patch(`/api/customers/${customerId}`, {
            address1: `Updated Address ${i} - ${Date.now()}`
          })
          const duration = Date.now() - start
          return {
            success: true,
            status: response.status,
            duration,
            iteration: i
          }
        } catch (error) {
          const duration = Date.now() - start
          return {
            success: false,
            status: error.response?.status || 0,
            duration,
            error: error.message,
            iteration: i
          }
        }
      }
    })
    
    // Run concurrent updates
    const startTime = Date.now()
    const { results, errors } = await runConcurrentRequests(updateRequests, 20)
    const totalDuration = Date.now() - startTime
    
    const successful = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length
    
    // Verify final state
    const finalResponse = await client.get(`/api/customers/${customerId}`)
    const finalState = finalResponse.data
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      await cleanupSpecificTestData('customer', customerId)
    }
    
    return formatTestResult(
      'Concurrency Test - Updates',
      failed === 0 && finalState !== null,
      totalDuration,
      {
        total: 20,
        successful,
        failed,
        finalStateExists: finalState !== null,
        errors: errors.length
      }
    )
  } catch (error) {
    return formatTestResult(
      'Concurrency Test - Updates',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test concurrent deletions
 */
export async function testConcurrentDeletions() {
  console.log('[Concurrency Test] Testing concurrent deletions...')
  const testId = generateTestId('CONC_DELETE')
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create multiple test customers
    const customers = []
    for (let i = 0; i < 10; i++) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${i}`,
        investor_id: parseInt(`999${Date.now()}${i}`),
        pan: `ABCDE${String(i).padStart(4, '0')}F`,
        email: `conctest${i}@example.com`,
        mobile: `9${String(i).padStart(9, '0')}`,
        address1: `Concurrency Test Address ${i}`,
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
      
      const response = await client.post('/api/customers', customerData)
      customers.push(response.data.id)
      createdIds.push({ type: 'customer', id: response.data.id })
    }
    
    // Create concurrent delete requests
    const deleteRequests = customers.map((customerId, i) => {
      return async () => {
        const start = Date.now()
        try {
          const response = await client.delete(`/api/customers/${customerId}`)
          const duration = Date.now() - start
          return {
            success: true,
            status: response.status,
            duration,
            customerId
          }
        } catch (error) {
          const duration = Date.now() - start
          return {
            success: false,
            status: error.response?.status || 0,
            duration,
            error: error.message,
            customerId
          }
        }
      }
    })
    
    // Run concurrent deletions
    const startTime = Date.now()
    const { results, errors } = await runConcurrentRequests(deleteRequests, 10)
    const totalDuration = Date.now() - startTime
    
    const successful = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length
    
    // Verify deletions
    let stillExists = 0
    for (const customerId of customers) {
      try {
        await client.get(`/api/customers/${customerId}`)
        stillExists++
      } catch (error) {
        // Expected - customer should be deleted
      }
    }
    
    return formatTestResult(
      'Concurrency Test - Deletions',
      failed === 0 && stillExists === 0,
      totalDuration,
      {
        total: 10,
        successful,
        failed,
        stillExists,
        errors: errors.length
      }
    )
  } catch (error) {
    // Cleanup on error
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      for (const item of createdIds) {
        await cleanupSpecificTestData(item.type, item.id)
      }
    }
    
    return formatTestResult(
      'Concurrency Test - Deletions',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test race conditions in receipt creation
 */
export async function testRaceConditions() {
  console.log('[Concurrency Test] Testing race conditions...')
  const testId = generateTestId('RACE')
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create a test customer
    const customerData = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `racetest@example.com`,
      mobile: '9876543210',
      address1: 'Race Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    const createResponse = await client.post('/api/customers', customerData)
    const customerId = createResponse.data.id
    createdIds.push({ type: 'customer', id: customerId })
    
    // Create multiple receipts with same receipt number (should fail for duplicates)
    const receiptNo = `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}`
    const receiptRequests = Array.from({ length: 5 }, () => {
      return async () => {
        const start = Date.now()
        try {
          const response = await client.post('/api/receipts', {
            receiptNo,
            date: new Date().toISOString().split('T')[0],
            investorId: customerData.investor_id,
            investorName: customerData.name,
            product_category: 'MF',
            schemeName: 'Test Scheme',
            investmentAmount: 10000,
            mode: 'Lump Sum'
          })
          const duration = Date.now() - start
          
          if (response.data && response.data.id) {
            createdIds.push({ type: 'receipt', id: response.data.id })
          }
          
          return {
            success: true,
            status: response.status,
            duration
          }
        } catch (error) {
          const duration = Date.now() - start
          return {
            success: false,
            status: error.response?.status || 0,
            duration,
            error: error.message
          }
        }
      }
    })
    
    // Run concurrent requests
    const startTime = Date.now()
    const { results, errors } = await runConcurrentRequests(receiptRequests, 5)
    const totalDuration = Date.now() - startTime
    
    const successful = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length
    
    // Only one should succeed (duplicate receipt numbers should be rejected)
    const expectedBehavior = successful <= 1
    
    // Cleanup
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      for (const item of createdIds) {
        await cleanupSpecificTestData(item.type, item.id)
      }
    }
    
    return formatTestResult(
      'Concurrency Test - Race Conditions',
      expectedBehavior,
      totalDuration,
      {
        total: 5,
        successful,
        failed,
        expectedBehavior: 'Only one receipt with same receipt number should succeed',
        errors: errors.length
      }
    )
  } catch (error) {
    return formatTestResult(
      'Concurrency Test - Race Conditions',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Run all concurrency tests
 */
export async function runAllConcurrencyTests() {
  console.log('='.repeat(60))
  console.log('STRESS TESTING - CONCURRENCY TESTS')
  console.log('='.repeat(60))
  
  const results = []
  
  results.push(await testConcurrentUpdates())
  results.push(await testConcurrentDeletions())
  results.push(await testRaceConditions())
  
  return results
}

