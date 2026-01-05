// Test helper utilities
import axios from 'axios'
import { TEST_CONFIG } from '../config.js'

/**
 * Create an axios instance with authentication
 */
export async function createAuthenticatedClient(credentials = null) {
  const client = axios.create({
    baseURL: TEST_CONFIG.API_BASE_URL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json'
    }
  })
  
  if (credentials) {
    try {
      const response = await client.post('/api/auth/login', credentials)
      if (response.data.token) {
        client.defaults.headers.common['Authorization'] = `Bearer ${response.data.token}`
      }
    } catch (error) {
      console.error('Failed to authenticate:', error.message)
    }
  }
  
  return client
}

/**
 * Generate unique test identifier
 */
export function generateTestId(prefix = 'TEST') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Sleep utility for delays
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Measure execution time
 */
export async function measureTime(fn) {
  const start = Date.now()
  const result = await fn()
  const end = Date.now()
  return { result, duration: end - start }
}

/**
 * Run multiple requests concurrently
 */
export async function runConcurrentRequests(requests, concurrency = 10) {
  const results = []
  const errors = []
  
  for (let i = 0; i < requests.length; i += concurrency) {
    const batch = requests.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(batch.map(req => req()))
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        errors.push({
          index: i + index,
          error: result.reason
        })
      }
    })
  }
  
  return { results, errors }
}

/**
 * Validate response structure
 */
export function validateResponse(response, expectedFields = []) {
  const errors = []
  
  if (!response) {
    errors.push('Response is null or undefined')
    return { valid: false, errors }
  }
  
  if (expectedFields.length > 0) {
    expectedFields.forEach(field => {
      if (!(field in response)) {
        errors.push(`Missing field: ${field}`)
      }
    })
  }
  
  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Generate random test data
 */
export function generateTestData(type) {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substr(2, 9)
  
  switch (type) {
    case 'customer':
      return {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${timestamp}`,
        investor_id: parseInt(`999${timestamp.toString().slice(-6)}`),
        pan: `ABCDE${Math.floor(Math.random() * 10000)}F`,
        email: `test${timestamp}@example.com`,
        mobile: `9${Math.floor(100000000 + Math.random() * 900000000)}`,
        address1: `Test Address ${random}`,
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
    
    case 'receipt':
      return {
        receiptNo: `${TEST_CONFIG.TEST_PREFIX.RECEIPT}${timestamp}`,
        date: new Date().toISOString().split('T')[0],
        investorId: parseInt(`999${timestamp.toString().slice(-6)}`),
        investorName: `Test Investor ${timestamp}`,
        product_category: 'MF',
        schemeName: 'Test Scheme',
        investmentAmount: Math.floor(Math.random() * 100000) + 1000,
        mode: 'Lump Sum'
      }
    
    case 'user':
      return {
        emp_code: `${TEST_CONFIG.TEST_PREFIX.USER}${timestamp}`,
        name: `Test User ${timestamp}`,
        email: `testuser${timestamp}@example.com`,
        password: 'TestPassword123',
        role: 'employee',
        branch: 'HO'
      }
    
    default:
      return {}
  }
}

/**
 * Assert utility
 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

/**
 * Test result formatter
 */
export function formatTestResult(testName, passed, duration, details = {}) {
  return {
    test: testName,
    passed,
    duration,
    timestamp: new Date().toISOString(),
    ...details
  }
}





