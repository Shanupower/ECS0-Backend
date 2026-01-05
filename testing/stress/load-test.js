// Stress testing - Load testing suite
import { createAuthenticatedClient, generateTestId, runConcurrentRequests, measureTime, formatTestResult } from '../utils/test-helpers.js'
import { cleanupTestData, cleanupSpecificTestData } from '../utils/cleanup.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Load test - Create multiple customers concurrently
 */
export async function loadTestCustomers() {
  console.log('[Load Test] Starting customer creation load test...')
  const testId = generateTestId('LOAD_CUSTOMER')
  const results = []
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create requests
    const requests = Array.from({ length: TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS }, (_, i) => {
      return async () => {
        const customerData = {
          name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${i}`,
          investor_id: parseInt(`999${Date.now()}${i}`),
          pan: `ABCDE${String(i).padStart(4, '0')}F`,
          email: `loadtest${i}@example.com`,
          mobile: `9${String(i).padStart(9, '0')}`,
          address1: `Load Test Address ${i}`,
          city: 'Test City',
          state: 'Test State',
          pin_code: '123456',
          relationship_manager: 'HO'
        }
        
        const start = Date.now()
        try {
          const response = await client.post('/api/customers', customerData)
          const duration = Date.now() - start
          
          if (response.data && response.data.id) {
            createdIds.push({ type: 'customer', id: response.data.id })
          }
          
          return {
            success: true,
            status: response.status,
            duration,
            data: response.data
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
    const { results: requestResults, errors } = await runConcurrentRequests(
      requests,
      TEST_CONFIG.STRESS_TEST.CONCURRENT_REQUESTS
    )
    const totalDuration = Date.now() - startTime
    
    // Analyze results
    const successful = requestResults.filter(r => r.success).length
    const failed = requestResults.filter(r => !r.success).length
    const avgDuration = requestResults.reduce((sum, r) => sum + r.duration, 0) / requestResults.length
    const minDuration = Math.min(...requestResults.map(r => r.duration))
    const maxDuration = Math.max(...requestResults.map(r => r.duration))
    
    // Cleanup immediately
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      console.log('[Load Test] Cleaning up test data...')
      for (const item of createdIds) {
        await cleanupSpecificTestData(item.type, item.id)
      }
    }
    
    return formatTestResult(
      'Load Test - Customers',
      failed === 0,
      totalDuration,
      {
        total: TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS,
        successful,
        failed,
        concurrency: TEST_CONFIG.STRESS_TEST.CONCURRENT_REQUESTS,
        avgDuration,
        minDuration,
        maxDuration,
        errors: errors.length,
        requestsPerSecond: (TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS / (totalDuration / 1000)).toFixed(2)
      }
    )
  } catch (error) {
    return formatTestResult(
      'Load Test - Customers',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Load test - Create multiple receipts concurrently
 */
export async function loadTestReceipts() {
  console.log('[Load Test] Starting receipt creation load test...')
  const testId = generateTestId('LOAD_RECEIPT')
  const results = []
  const createdIds = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // First create a test customer
    const customerData = {
      name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
      investor_id: parseInt(`999${Date.now()}`),
      pan: 'ABCDE1234F',
      email: `loadtest@example.com`,
      mobile: '9876543210',
      address1: 'Load Test Address',
      city: 'Test City',
      state: 'Test State',
      pin_code: '123456',
      relationship_manager: 'HO'
    }
    
    const customerResponse = await client.post('/api/customers', customerData)
    const customerId = customerResponse.data.id
    createdIds.push({ type: 'customer', id: customerId })
    
    // Create receipt requests
    const requests = Array.from({ length: TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS }, (_, i) => {
      return async () => {
        const receiptData = {
          receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${testId}_${i}`,
          date: new Date().toISOString().split('T')[0],
          investorId: customerData.investor_id,
          investorName: customerData.name,
          product_category: 'MF',
          schemeName: `Test Scheme ${i}`,
          investmentAmount: Math.floor(Math.random() * 100000) + 1000,
          mode: 'Lump Sum'
        }
        
        const start = Date.now()
        try {
          const response = await client.post('/api/receipts', receiptData)
          const duration = Date.now() - start
          
          if (response.data && response.data.id) {
            createdIds.push({ type: 'receipt', id: response.data.id })
          }
          
          return {
            success: true,
            status: response.status,
            duration,
            data: response.data
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
    const { results: requestResults, errors } = await runConcurrentRequests(
      requests,
      TEST_CONFIG.STRESS_TEST.CONCURRENT_REQUESTS
    )
    const totalDuration = Date.now() - startTime
    
    // Analyze results
    const successful = requestResults.filter(r => r.success).length
    const failed = requestResults.filter(r => !r.success).length
    const avgDuration = requestResults.reduce((sum, r) => sum + r.duration, 0) / requestResults.length
    
    // Cleanup immediately
    if (TEST_CONFIG.CLEANUP.DELETE_IMMEDIATELY) {
      console.log('[Load Test] Cleaning up test data...')
      for (const item of createdIds) {
        await cleanupSpecificTestData(item.type, item.id)
      }
    }
    
    return formatTestResult(
      'Load Test - Receipts',
      failed === 0,
      totalDuration,
      {
        total: TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS,
        successful,
        failed,
        concurrency: TEST_CONFIG.STRESS_TEST.CONCURRENT_REQUESTS,
        avgDuration,
        requestsPerSecond: (TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS / (totalDuration / 1000)).toFixed(2)
      }
    )
  } catch (error) {
    return formatTestResult(
      'Load Test - Receipts',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Load test - Concurrent GET requests
 */
export async function loadTestReads() {
  console.log('[Load Test] Starting read operations load test...')
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    // Create requests for reading customers
    const requests = Array.from({ length: TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS }, () => {
      return async () => {
        const start = Date.now()
        try {
          const response = await client.get('/api/customers?page=1&size=10')
          const duration = Date.now() - start
          return {
            success: true,
            status: response.status,
            duration,
            dataSize: response.data?.items?.length || 0
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
    const { results: requestResults, errors } = await runConcurrentRequests(
      requests,
      TEST_CONFIG.STRESS_TEST.CONCURRENT_REQUESTS
    )
    const totalDuration = Date.now() - startTime
    
    // Analyze results
    const successful = requestResults.filter(r => r.success).length
    const failed = requestResults.filter(r => !r.success).length
    const avgDuration = requestResults.reduce((sum, r) => sum + r.duration, 0) / requestResults.length
    
    return formatTestResult(
      'Load Test - Read Operations',
      failed === 0,
      totalDuration,
      {
        total: TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS,
        successful,
        failed,
        concurrency: TEST_CONFIG.STRESS_TEST.CONCURRENT_REQUESTS,
        avgDuration,
        requestsPerSecond: (TEST_CONFIG.STRESS_TEST.TOTAL_REQUESTS / (totalDuration / 1000)).toFixed(2)
      }
    )
  } catch (error) {
    return formatTestResult(
      'Load Test - Read Operations',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Run all load tests
 */
export async function runAllLoadTests() {
  console.log('='.repeat(60))
  console.log('STRESS TESTING - LOAD TESTS')
  console.log('='.repeat(60))
  
  const results = []
  
  results.push(await loadTestReads())
  results.push(await loadTestCustomers())
  results.push(await loadTestReceipts())
  
  return results
}





