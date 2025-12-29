# ECS Backend Testing Suite

Comprehensive testing suite for the ECS Backend application, including stress testing, edge case testing, black box testing, and white box testing.

## Overview

This testing suite ensures the application is production-ready by testing:
- **Stress Testing**: Load testing and concurrency testing
- **Edge Case Testing**: Boundary conditions and invalid inputs
- **Black Box Testing**: API testing without internal knowledge
- **White Box Testing**: Testing with knowledge of internal implementation

## Features

- ✅ Automatic cleanup of all test data immediately after tests
- ✅ Comprehensive test coverage
- ✅ Detailed test reports
- ✅ Configurable test parameters

## Structure

```
testing/
├── config.js                 # Test configuration
├── test-runner.js            # Main test runner
├── utils/
│   ├── test-helpers.js      # Test utility functions
│   └── cleanup.js           # Test data cleanup utilities
├── stress/
│   ├── load-test.js         # Load testing suite
│   └── concurrency-test.js  # Concurrency testing suite
├── edge-cases/
│   ├── boundary-test.js     # Boundary condition tests
│   └── invalid-input-test.js # Invalid input tests
├── black-box/
│   └── api-test.js          # Black box API tests
└── white-box/
    └── internal-test.js     # White box internal tests
```

## Configuration

Edit `config.js` to configure:
- API base URL
- Test credentials
- Stress test parameters (concurrent requests, total requests)
- Cleanup settings

## Usage

### Run All Tests

```bash
node testing/test-runner.js
```

### Run Specific Test Suites

```javascript
import { runAllLoadTests } from './testing/stress/load-test.js'
import { runAllBlackBoxTests } from './testing/black-box/api-test.js'

// Run specific suite
await runAllLoadTests()
await runAllBlackBoxTests()
```

### Manual Cleanup

```javascript
import { cleanupTestData } from './testing/utils/cleanup.js'

// Cleanup all test data
await cleanupTestData()
```

## Test Data Markers

All test data is marked with prefixes to enable automatic cleanup:
- Customers: `TEST_CUSTOMER_`
- Receipts: `TEST_RECEIPT_`
- Users: `TEST_USER_`
- Branches: `TEST_BRANCH_`
- Issues: `TEST_ISSUE_`

## Test Results

The test runner provides:
- Total tests run
- Pass/fail counts
- Duration
- Detailed error messages for failed tests
- Cleanup summary

## Important Notes

1. **Test Credentials**: Ensure test users exist in the database before running tests
2. **Database**: Tests use the same database as the application - ensure you're not running against production
3. **Cleanup**: All test data is automatically deleted immediately after each test
4. **Isolation**: Each test is designed to be independent and clean up after itself

## Adding New Tests

1. Create test file in appropriate directory (`stress/`, `edge-cases/`, `black-box/`, or `white-box/`)
2. Export test functions following the pattern:
   ```javascript
   export async function testSomething() {
     // Test implementation
     return formatTestResult('Test Name', passed, duration, details)
   }
   ```
3. Add to the appropriate `runAll*Tests()` function
4. Ensure cleanup is performed (use `cleanupSpecificTestData()` or `cleanupTestData()`)

## Environment Variables

Set these in your `.env` file:
- `API_BASE_URL`: Base URL for API (default: http://localhost:8080)
- `TEST_ADMIN_EMP_CODE`: Admin employee code for testing
- `TEST_ADMIN_PASSWORD`: Admin password for testing
- `TEST_EMPLOYEE_EMP_CODE`: Employee code for testing
- `TEST_EMPLOYEE_PASSWORD`: Employee password for testing

