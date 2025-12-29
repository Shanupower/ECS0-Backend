// Test configuration
import 'dotenv/config'

export const TEST_CONFIG = {
  // API base URL
  API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:8080',
  
  // Test credentials (should be test users, not production)
  TEST_ADMIN: {
    emp_code: process.env.TEST_ADMIN_EMP_CODE || 'ECS0000',
    password: process.env.TEST_ADMIN_PASSWORD || 'Password@123'
  },
  TEST_EMPLOYEE: {
    emp_code: process.env.TEST_EMPLOYEE_EMP_CODE || 'ECS488',
    password: process.env.TEST_EMPLOYEE_PASSWORD || 'password123'
  },
  
  // Test data markers - all test data will have these prefixes
  TEST_PREFIX: {
    CUSTOMER: 'TEST_CUSTOMER_',
    RECEIPT: 'TEST_RECEIPT_',
    USER: 'TEST_USER_',
    BRANCH: 'TEST_BRANCH_',
    ISSUE: 'TEST_ISSUE_'
  },
  
  // Stress test configuration
  STRESS_TEST: {
    CONCURRENT_REQUESTS: 50,
    TOTAL_REQUESTS: 500,
    RAMP_UP_TIME: 5000, // milliseconds
    TIMEOUT: 30000 // milliseconds
  },
  
  // Cleanup configuration
  CLEANUP: {
    DELETE_IMMEDIATELY: true, // Delete test data immediately after each test
    BATCH_SIZE: 100 // Number of records to delete per batch
  }
}

