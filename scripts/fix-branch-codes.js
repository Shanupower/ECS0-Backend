import 'dotenv/config'
import { q, getCollection, normalizeBranchName } from '../config/database.js'

/**
 * Script to fix missing branch_code values for users
 * This script finds all users with null or missing branch_code
 * and updates them based on their branch name
 */
async function fixBranchCodes() {
  try {
    console.log('Starting branch_code fix script...\n')
    
    // Get all users with branch but no branch_code
    const usersWithoutBranchCode = await q(`
      FOR user IN users
      FILTER user.branch != null AND (user.branch_code == null OR user.branch_code == '')
      RETURN user
    `)
    
    console.log(`Found ${usersWithoutBranchCode.length} users without branch_code\n`)
    
    if (usersWithoutBranchCode.length === 0) {
      console.log('No users need updating. Exiting.')
      return
    }
    
    // Get all branches for lookup
    const allBranches = await q(`FOR b IN branches RETURN b`)
    console.log(`Loaded ${allBranches.length} branches from database\n`)
    
    let updated = 0
    let failed = 0
    const results = []
    
    for (const user of usersWithoutBranchCode) {
      try {
        const userBranch = user.branch
        const normalizedBranch = normalizeBranchName(userBranch)
        
        console.log(`Processing user ${user.emp_code} (${user.name})`)
        console.log(`  Branch: ${userBranch}`)
        console.log(`  Normalized: ${normalizedBranch || 'N/A'}`)
        
        // Try multiple matching strategies
        let matchedBranch = null
        
        // Strategy 1: Exact match (case-insensitive)
        matchedBranch = allBranches.find(b => 
          b.branch_name?.toLowerCase() === userBranch.toLowerCase() ||
          b.branch_code?.toLowerCase() === userBranch.toLowerCase()
        )
        
        // Strategy 2: Match by normalized name
        if (!matchedBranch && normalizedBranch) {
          matchedBranch = allBranches.find(b => {
            const normalizedBranchName = normalizeBranchName(b.branch_name)
            return normalizedBranchName === normalizedBranch
          })
        }
        
        // Strategy 3: Partial match (e.g., "CHENNAI - MADIPAKKAM" matches "MADIPAKKAM")
        if (!matchedBranch) {
          const branchLower = userBranch.toLowerCase()
          matchedBranch = allBranches.find(b => {
            const nameLower = (b.branch_name || '').toLowerCase()
            const codeLower = (b.branch_code || '').toLowerCase()
            // Check if branch name contains the search term or vice versa
            return nameLower.includes(branchLower) || 
                   branchLower.includes(nameLower) ||
                   codeLower.includes(branchLower) ||
                   branchLower.includes(codeLower)
          })
        }
        
        // Strategy 4: Match by removing common prefixes/suffixes
        if (!matchedBranch) {
          // Remove common prefixes like "CHENNAI - " from "CHENNAI - MADIPAKKAM"
          const cleanedBranch = userBranch.replace(/^[^-]+-\s*/i, '').trim()
          matchedBranch = allBranches.find(b => 
            b.branch_name?.toLowerCase() === cleanedBranch.toLowerCase() ||
            b.branch_code?.toLowerCase() === cleanedBranch.toLowerCase()
          )
        }
        
        if (matchedBranch) {
          const branchCode = matchedBranch.branch_code
          console.log(`  ✓ Matched to branch: ${matchedBranch.branch_name} (code: ${branchCode})`)
          
          // Update user
          await getCollection('users').update(user._key, { branch_code: branchCode })
          console.log(`  ✓ Updated user ${user.emp_code} with branch_code: ${branchCode}\n`)
          
          updated++
          results.push({
            user: user.emp_code,
            name: user.name,
            old_branch: userBranch,
            new_branch_code: branchCode,
            matched_branch: matchedBranch.branch_name,
            status: 'success'
          })
        } else {
          console.log(`  ✗ No matching branch found\n`)
          failed++
          results.push({
            user: user.emp_code,
            name: user.name,
            old_branch: userBranch,
            new_branch_code: null,
            matched_branch: null,
            status: 'failed - no match'
          })
        }
      } catch (error) {
        console.error(`  ✗ Error processing user ${user.emp_code}:`, error.message)
        failed++
        results.push({
          user: user.emp_code,
          name: user.name,
          old_branch: user.branch,
          new_branch_code: null,
          matched_branch: null,
          status: `failed - ${error.message}`
        })
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(60))
    console.log('SUMMARY')
    console.log('='.repeat(60))
    console.log(`Total users processed: ${usersWithoutBranchCode.length}`)
    console.log(`Successfully updated: ${updated}`)
    console.log(`Failed: ${failed}`)
    console.log('\nDetailed results:')
    console.log(JSON.stringify(results, null, 2))
    
    // Show failed cases
    if (failed > 0) {
      console.log('\n⚠ Failed cases (need manual review):')
      results.filter(r => r.status.startsWith('failed')).forEach(r => {
        console.log(`  - ${r.user} (${r.name}): Branch "${r.old_branch}" - ${r.status}`)
      })
    }
    
  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

// Run the script
fixBranchCodes()
  .then(() => {
    console.log('\nScript completed successfully.')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Script failed:', error)
    process.exit(1)
  })


