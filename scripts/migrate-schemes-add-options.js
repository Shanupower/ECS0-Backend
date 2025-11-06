import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'http://localhost:8529',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

// Connect to database
const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
})

// Helper function to generate display name
function generateDisplayName(baseName, plan, option) {
  const planTitle = plan === 'REGULAR' || plan === 'Regular' ? 'Regular' : 'Direct'
  const optionTitle = 
    option === 'GROWTH' ? 'Growth' :
    option === 'IDCW_PAYOUT' ? 'IDCW – Payout' :
    'IDCW – Reinvestment'
  return `${baseName} – ${planTitle} – ${optionTitle}`
}

// Helper function to extract base name from scheme name
function extractBaseName(schemeName) {
  // Remove common suffixes like "- Regular", "- Direct", "- Growth", etc.
  let baseName = schemeName
    .replace(/\s*-\s*(Regular|Direct)\s*$/i, '')
    .replace(/\s*-\s*(Growth|IDCW|Dividend|Payout|Reinvest|Reinvestment)\s*$/i, '')
    .replace(/\s*\((Regular|Direct)\)\s*$/i, '')
    .replace(/\s*\((Growth|IDCW|Dividend|Payout|Reinvest|Reinvestment)\)\s*$/i, '')
    .trim()
  
  return baseName
}

// Normalize plan value
function normalizePlan(plan) {
  if (!plan) return 'REGULAR'
  const normalized = plan.toLowerCase()
  if (normalized === 'direct') return 'DIRECT'
  return 'REGULAR'
}

async function migrateSchemes() {
  try {
    console.log('Starting MF Schemes migration to add option field...')
    
    const schemesCollection = db.collection('mf_schemes')
    
    // Get all existing schemes
    const cursor = await db.query(`
      FOR scheme IN mf_schemes
      RETURN scheme
    `)
    
    const existingSchemes = await cursor.all()
    console.log(`Found ${existingSchemes.length} existing schemes`)
    
    if (existingSchemes.length === 0) {
      console.log('No schemes to migrate')
      return
    }
    
    let created = 0
    let updated = 0
    let errors = []
    
    for (const scheme of existingSchemes) {
      try {
        // Skip if scheme already has option field (already migrated)
        if (scheme.option) {
          console.log(`Scheme ${scheme.scheme_code} already has option field, skipping...`)
          continue
        }
        
        // Extract base name
        const baseName = extractBaseName(scheme.scheme_name)
        const normalizedPlan = normalizePlan(scheme.plan)
        
        console.log(`Processing scheme: ${scheme.scheme_name}`)
        console.log(`  Base name: ${baseName}`)
        console.log(`  Plan: ${normalizedPlan}`)
        
        // Create 3 variants for each option
        const options = ['GROWTH', 'IDCW_PAYOUT', 'IDCW_REINVEST']
        
        for (let i = 0; i < options.length; i++) {
          const option = options[i]
          
          // Generate new scheme code for IDCW variants
          let newSchemeCode = scheme.scheme_code
          if (option === 'IDCW_PAYOUT') {
            newSchemeCode = `${scheme.scheme_code}_IP`
          } else if (option === 'IDCW_REINVEST') {
            newSchemeCode = `${scheme.scheme_code}_IR`
          }
          
          // Generate display name
          const displayName = generateDisplayName(baseName, normalizedPlan, option)
          
          // Check if this variant already exists
          const existingCheck = await db.query(`
            FOR s IN mf_schemes
            FILTER s.scheme_code == @scheme_code
            RETURN s
          `, { scheme_code: newSchemeCode })
          
          const existing = await existingCheck.all()
          
          if (existing.length > 0 && option !== 'GROWTH') {
            console.log(`  Variant ${option} (${newSchemeCode}) already exists, skipping...`)
            continue
          }
          
          if (option === 'GROWTH') {
            // Update the original scheme with Growth option
            await db.query(`
              FOR s IN mf_schemes
              FILTER s._key == @key
              UPDATE s WITH {
                option: @option,
                base_name: @base_name,
                display_name: @display_name,
                plan: @plan
              } IN mf_schemes
            `, {
              key: scheme._key,
              option: option,
              base_name: baseName,
              display_name: displayName,
              plan: normalizedPlan
            })
            
            console.log(`  ✓ Updated original scheme as Growth variant`)
            updated++
          } else {
            // Create new variant for IDCW options
            const newVariant = {
              scheme_code: newSchemeCode,
              scheme_name: scheme.scheme_name, // Keep original for reference
              display_name: displayName,
              base_name: baseName,
              amc_code: scheme.amc_code,
              amc_name: scheme.amc_name,
              category: scheme.category,
              sub_category: scheme.sub_category,
              plan: normalizedPlan,
              option: option,
              type: scheme.type,
              nav_latest: scheme.nav_latest || 0,
              nav_date: scheme.nav_date || null,
              is_nfo: scheme.is_nfo || false,
              nfo_validity: scheme.nfo_validity || null,
              is_active: true,
              created_at: new Date().toISOString()
            }
            
            await schemesCollection.save(newVariant)
            console.log(`  ✓ Created ${option} variant (${newSchemeCode})`)
            created++
          }
        }
        
      } catch (error) {
        console.error(`Error processing scheme ${scheme.scheme_code}:`, error.message)
        errors.push({
          scheme_code: scheme.scheme_code,
          error: error.message
        })
      }
    }
    
    console.log('\nMigration completed!')
    console.log(`Updated: ${updated} schemes`)
    console.log(`Created: ${created} new variants`)
    
    if (errors.length > 0) {
      console.log(`\nErrors: ${errors.length}`)
      errors.forEach(err => {
        console.log(`  - ${err.scheme_code}: ${err.error}`)
      })
    }
    
    // Verify results
    const verifyCount = await db.query(`
      FOR scheme IN mf_schemes
      FILTER scheme.option != null
      COLLECT WITH COUNT INTO count
      RETURN count
    `)
    
    const verifyResult = await verifyCount.all()
    console.log(`\nTotal schemes with option field: ${verifyResult[0]}`)
    
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

// Run migration
migrateSchemes()
  .then(() => {
    console.log('Migration script completed successfully')
    process.exit(0)
  })
  .catch(error => {
    console.error('Migration script failed:', error)
    process.exit(1)
  })

