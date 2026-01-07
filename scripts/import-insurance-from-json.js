import { Database } from 'arangojs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log('📥 Importing Insurance Data from JSON File...\n')

// Database connection
const ARANGO_URL = process.env.ARANGO_URL || 'https://db.ecsfinancial.tech'
const ARANGO_USERNAME = process.env.ARANGO_USERNAME || 'root'
const ARANGO_PASSWORD = process.env.ARANGO_PASSWORD || ''
const ARANGO_DATABASE = process.env.ARANGO_DATABASE || 'ecs_backend'

const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
})

const q = db.query.bind(db)

// Batch size for importing
const BATCH_SIZE = 50

/**
 * Convert external JSON data to our insurance product structure
 */
function convertToOurStructure(externalData) {
  if (!Array.isArray(externalData)) {
    console.error('❌ Input data must be an array')
    return []
  }
  
  const issuers = new Map()
  
  externalData.forEach((item, index) => {
    try {
      const issuerKey = item.issuer_key || item.company_key || item.insurer_id || 
                       item.issuer?.key || item.company?.key || `issuer_${index}`
      
      if (!issuers.has(issuerKey)) {
        const issuerData = item.issuer || item.company || item.insurer || {}
        issuers.set(issuerKey, {
          _key: issuerKey,
          legal_name: issuerData.legal_name || issuerData.name || item.legal_name || item.company_name || 'Unknown',
          short_name: issuerData.short_name || issuerData.shortName || item.short_name || item.company_short_name || 'Unknown',
          type: issuerData.type || item.type || item.insurance_type || 'Life',
          license_number: issuerData.license_number || issuerData.license || item.license_number || `LIC${issuerKey}`,
          is_active: issuerData.is_active !== undefined ? issuerData.is_active : (item.is_active !== undefined ? item.is_active : true),
          products: []
        })
      }
      
      const issuer = issuers.get(issuerKey)
      
      // Handle product data (can be nested or flat)
      const productData = item.product || item
      
      const product = {
        product_id: productData.product_id || productData.id || `${issuerKey}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        product_name: productData.product_name || productData.name || productData.title || 'Unnamed Product',
        category: productData.category || productData.product_category || 'Life',
        sub_category: productData.sub_category || productData.subcategory || productData.product_subcategory || 'General',
        description: productData.description || productData.summary || '',
        policy_types: Array.isArray(productData.policy_types) ? productData.policy_types : 
                     productData.policy_type ? [productData.policy_type] : 
                     productData.type ? [productData.type] : ['Term'],
        min_sum_assured: productData.min_sum_assured || productData.min_sum_insured || productData.min_coverage || 100000,
        max_sum_assured: productData.max_sum_assured || productData.max_sum_insured || productData.max_coverage || null,
        min_premium: productData.min_premium || productData.min_premium_amount || 1000,
        max_premium: productData.max_premium || productData.max_premium_amount || null,
        min_entry_age: productData.min_entry_age || productData.min_age || 18,
        max_entry_age: productData.max_entry_age || productData.max_age || 65,
        policy_term_years_min: productData.policy_term_years_min || productData.min_term || 5,
        policy_term_years_max: productData.policy_term_years_max || productData.max_term || 40,
        premium_payment_frequency: Array.isArray(productData.premium_payment_frequency) ? productData.premium_payment_frequency :
                                  productData.payment_frequency ? [productData.payment_frequency] :
                                  ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: productData.premium_payment_term_min || productData.premium_term_min || 5,
        premium_payment_term_max: productData.premium_payment_term_max || productData.premium_term_max || 35,
        premium_payment_term_type: productData.premium_payment_term_type || 'Years',
        coverage_details: {
          base_coverage: productData.base_coverage || productData.coverage || 'Life Cover',
          additional_coverage: productData.additional_coverage || null,
          exclusions: Array.isArray(productData.exclusions) ? productData.exclusions : 
                     productData.exclusion ? [productData.exclusion] : [],
          waiting_period_days: productData.waiting_period_days || productData.waiting_period || 0,
          renewability: productData.renewability || 'Term',
          claim_settlement_ratio: productData.claim_settlement_ratio || productData.settlement_ratio || 95.0
        },
        riders: Array.isArray(productData.riders) ? productData.riders.map(rider => ({
          rider_id: rider.rider_id || rider.id || `${product.product_id}_rider_${Math.random().toString(36).substr(2, 9)}`,
          rider_name: rider.rider_name || rider.name || 'Rider',
          description: rider.description || '',
          rider_type: rider.rider_type || rider.type || 'General',
          min_sum_assured: rider.min_sum_assured || null,
          max_sum_assured: rider.max_sum_assured || null,
          rider_premium_percentage: rider.rider_premium_percentage || rider.premium_percentage || null,
          rider_premium_fixed: rider.rider_premium_fixed || rider.premium_fixed || null,
          eligibility_criteria: rider.eligibility_criteria || '',
          is_active: rider.is_active !== undefined ? rider.is_active : true
        })) : [],
        beneficiary_required: productData.beneficiary_required !== undefined ? productData.beneficiary_required : true,
        nomination_allowed: productData.nomination_allowed !== undefined ? productData.nomination_allowed : true,
        tax_benefits: Array.isArray(productData.tax_benefits) ? productData.tax_benefits :
                     productData.tax_benefit ? [productData.tax_benefit] : ['Section 80C'],
        cc: productData.cc || productData.commission || 2.5,
        si: productData.si || productData.service_income || 1.5,
        money_back: productData.money_back !== undefined ? productData.money_back : 
                    (productData.product_name && productData.product_name.toLowerCase().includes('money back')) ||
                    (productData.sub_category && productData.sub_category.toLowerCase().includes('money back')) ||
                    false,
        is_active: productData.is_active !== undefined ? productData.is_active : true,
        launch_date: productData.launch_date || new Date().toISOString().split('T')[0],
        withdrawal_date: productData.withdrawal_date || null
      }
      
      issuer.products.push(product)
    } catch (error) {
      console.error(`⚠️  Error processing item ${index}:`, error.message)
    }
  })
  
  return Array.from(issuers.values())
}

/**
 * Import issuers in batches
 */
async function importIssuersInBatches(issuers) {
  const collection = db.collection('insurance_issuers')
  
  try {
    await collection.load()
    console.log('✅ Collection exists')
  } catch (err) {
    if (err.errorNum === 1203) { // Collection not found
      console.log('📦 Creating insurance_issuers collection...')
      await collection.create()
      console.log('✅ Collection created')
    } else if (err.errorNum === 1207) { // Duplicate name
      console.log('✅ Collection already exists')
    } else {
      throw err
    }
  }
  
  console.log(`\n📥 Importing ${issuers.length} issuers in batches...`)
  
  let imported = 0
  let updated = 0
  let errors = 0
  
  for (const issuer of issuers) {
    try {
      // Check if issuer exists
      const existing = await q(`
        FOR issuer IN insurance_issuers
        FILTER issuer._key == @key
        LIMIT 1
        RETURN issuer
      `, { key: issuer._key })
      
      if (existing.length > 0) {
        // Merge products (avoid duplicates)
        const existingProducts = existing[0].products || []
        const existingProductIds = new Set(existingProducts.map(p => p.product_id))
        
        const newProducts = issuer.products.filter(p => !existingProductIds.has(p.product_id))
        
        if (newProducts.length > 0) {
          await collection.update(issuer._key, {
            products: [...existingProducts, ...newProducts]
          })
          console.log(`  ↻ Updated issuer: ${issuer.short_name} (added ${newProducts.length} products)`)
          updated++
        } else {
          console.log(`  ⊙ Skipped issuer: ${issuer.short_name} (no new products)`)
        }
      } else {
        // Insert new issuer
        await collection.save(issuer)
        console.log(`  ✓ Added issuer: ${issuer.short_name} (${issuer.products.length} products)`)
        imported++
      }
    } catch (err) {
      console.error(`  ✗ Error with issuer ${issuer.short_name}:`, err.message)
      errors++
    }
  }
  
  console.log(`\n✅ Import completed!`)
  console.log(`   - New issuers: ${imported}`)
  console.log(`   - Updated issuers: ${updated}`)
  console.log(`   - Errors: ${errors}`)
}

/**
 * Main function
 */
async function importFromJSON() {
  console.log(`Connecting to: ${ARANGO_URL}/${ARANGO_DATABASE}\n`)
  
  // Get JSON file path from command line argument or use default
  const jsonFile = process.argv[2] || path.join(__dirname, 'insurance-data.json')
  
  if (!fs.existsSync(jsonFile)) {
    console.error(`❌ File not found: ${jsonFile}`)
    console.log('\n💡 Usage:')
    console.log('   node scripts/import-insurance-from-json.js [path/to/file.json]')
    console.log('\n📋 Expected JSON format:')
    console.log('   [')
    console.log('     {')
    console.log('       "issuer_key": "lic_of_india",')
    console.log('       "legal_name": "Life Insurance Corporation of India",')
    console.log('       "short_name": "LIC",')
    console.log('       "type": "Life",')
    console.log('       "product_name": "Jeevan Amar",')
    console.log('       "category": "Life",')
    console.log('       ... (other product fields)')
    console.log('     }')
    console.log('   ]')
    process.exit(1)
  }
  
  console.log(`📄 Reading file: ${jsonFile}`)
  
  try {
    const fileContent = fs.readFileSync(jsonFile, 'utf8')
    const externalData = JSON.parse(fileContent)
    
    console.log(`✅ Parsed ${externalData.length} items from JSON\n`)
    
    const issuers = convertToOurStructure(externalData)
    
    if (issuers.length === 0) {
      console.log('⚠️  No issuers converted from data')
      return
    }
    
    await importIssuersInBatches(issuers)
    
    // Calculate totals
    let totalProducts = 0
    let totalRiders = 0
    for (const issuer of issuers) {
      totalProducts += issuer.products.length
      for (const product of issuer.products) {
        totalRiders += (product.riders || []).length
      }
    }
    
    console.log(`\n📊 Summary:`)
    console.log(`   - Total Issuers: ${issuers.length}`)
    console.log(`   - Total Products: ${totalProducts}`)
    console.log(`   - Total Riders: ${totalRiders}`)
  } catch (error) {
    console.error('❌ Error:', error.message)
    if (error instanceof SyntaxError) {
      console.error('   Invalid JSON format')
    }
    process.exit(1)
  }
}

// Run the script
importFromJSON().catch(error => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})


