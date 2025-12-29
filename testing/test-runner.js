// Main test runner - Orchestrates all test suites
import { cleanupTestData } from './utils/cleanup.js'
import { runAllLoadTests } from './stress/load-test.js'
import { runAllConcurrencyTests } from './stress/concurrency-test.js'
import { runAllBoundaryTests } from './edge-cases/boundary-test.js'
import { runAllInvalidInputTests } from './edge-cases/invalid-input-test.js'
import { runAllBlackBoxTests } from './black-box/api-test.js'
import { runAllWhiteBoxTests } from './white-box/internal-test.js'

/**
 * Run all test suites
 */
async function runAllTests() {
  console.log('\n' + '='.repeat(80))
  console.log('ECS BACKEND - COMPREHENSIVE TEST SUITE')
  console.log('='.repeat(80))
  console.log(`Start Time: ${new Date().toISOString()}\n`)
  
  const allResults = {
    stress: [],
    edgeCases: [],
    blackBox: [],
    whiteBox: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      duration: 0
    }
  }
  
  const startTime = Date.now()
  
  try {
    // Initial cleanup
    console.log('[Setup] Performing initial cleanup...')
    await cleanupTestData()
    console.log('[Setup] Initial cleanup completed\n')
    
    // Run stress tests
    console.log('\n' + '-'.repeat(80))
    console.log('PHASE 1: STRESS TESTING')
    console.log('-'.repeat(80) + '\n')
    
    try {
      const loadResults = await runAllLoadTests()
      allResults.stress.push(...loadResults)
    } catch (error) {
      console.error('[Stress Tests] Error:', error.message)
    }
    
    try {
      const concurrencyResults = await runAllConcurrencyTests()
      allResults.stress.push(...concurrencyResults)
    } catch (error) {
      console.error('[Concurrency Tests] Error:', error.message)
    }
    
    // Run edge case tests
    console.log('\n' + '-'.repeat(80))
    console.log('PHASE 2: EDGE CASE TESTING')
    console.log('-'.repeat(80) + '\n')
    
    try {
      const boundaryResults = await runAllBoundaryTests()
      allResults.edgeCases.push(...boundaryResults)
    } catch (error) {
      console.error('[Boundary Tests] Error:', error.message)
    }
    
    try {
      const invalidInputResults = await runAllInvalidInputTests()
      allResults.edgeCases.push(...invalidInputResults)
    } catch (error) {
      console.error('[Invalid Input Tests] Error:', error.message)
    }
    
    // Run black box tests
    console.log('\n' + '-'.repeat(80))
    console.log('PHASE 3: BLACK BOX TESTING')
    console.log('-'.repeat(80) + '\n')
    
    try {
      const blackBoxResults = await runAllBlackBoxTests()
      allResults.blackBox.push(...blackBoxResults)
    } catch (error) {
      console.error('[Black Box Tests] Error:', error.message)
    }
    
    // Run white box tests
    console.log('\n' + '-'.repeat(80))
    console.log('PHASE 4: WHITE BOX TESTING')
    console.log('-'.repeat(80) + '\n')
    
    try {
      const whiteBoxResults = await runAllWhiteBoxTests()
      allResults.whiteBox.push(...whiteBoxResults)
    } catch (error) {
      console.error('[White Box Tests] Error:', error.message)
    }
    
    // Final cleanup
    console.log('\n' + '-'.repeat(80))
    console.log('[Cleanup] Performing final cleanup...')
    const cleanupResult = await cleanupTestData()
    console.log('[Cleanup] Final cleanup completed')
    console.log(`  - Customers deleted: ${cleanupResult.customers}`)
    console.log(`  - Receipts deleted: ${cleanupResult.receipts}`)
    console.log(`  - Users deleted: ${cleanupResult.users}`)
    console.log(`  - Files deleted: ${cleanupResult.files.length}`)
    if (cleanupResult.errors.length > 0) {
      console.log(`  - Errors: ${cleanupResult.errors.length}`)
    }
    
  } catch (error) {
    console.error('\n[Fatal Error] Test suite failed:', error)
  } finally {
    const endTime = Date.now()
    allResults.summary.duration = endTime - startTime
    
    // Calculate summary
    const allTestResults = [
      ...allResults.stress,
      ...allResults.edgeCases,
      ...allResults.blackBox,
      ...allResults.whiteBox
    ]
    
    allResults.summary.total = allTestResults.length
    allResults.summary.passed = allTestResults.filter(r => r.passed).length
    allResults.summary.failed = allTestResults.filter(r => !r.passed).length
    
    // Print summary
    console.log('\n' + '='.repeat(80))
    console.log('TEST SUMMARY')
    console.log('='.repeat(80))
    console.log(`Total Tests: ${allResults.summary.total}`)
    console.log(`Passed: ${allResults.summary.passed} (${((allResults.summary.passed / allResults.summary.total) * 100).toFixed(1)}%)`)
    console.log(`Failed: ${allResults.summary.failed} (${((allResults.summary.failed / allResults.summary.total) * 100).toFixed(1)}%)`)
    console.log(`Total Duration: ${(allResults.summary.duration / 1000).toFixed(2)}s`)
    console.log(`End Time: ${new Date().toISOString()}`)
    console.log('='.repeat(80) + '\n')
    
    // Print failed tests
    if (allResults.summary.failed > 0) {
      console.log('FAILED TESTS:')
      console.log('-'.repeat(80))
      allTestResults.filter(r => !r.passed).forEach(result => {
        console.log(`✗ ${result.test}`)
        if (result.error) console.log(`  Error: ${result.error}`)
        if (result.details) console.log(`  Details: ${JSON.stringify(result.details, null, 2)}`)
      })
      console.log('-'.repeat(80) + '\n')
    }
  }
  
  return allResults
}

// Run tests if executed directly
if (process.argv[1]?.endsWith('test-runner.js') || import.meta.url.endsWith('test-runner.js')) {
  runAllTests()
    .then(results => {
      process.exit(results.summary.failed > 0 ? 1 : 0)
    })
    .catch(error => {
      console.error('Fatal error:', error)
      process.exit(1)
    })
}

export { runAllTests }

