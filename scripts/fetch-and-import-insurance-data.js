import { Database } from 'arangojs'
import axios from 'axios'

console.log('📥 Fetching and Importing Insurance Data from Multiple Sources...\n')

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
 * Convert external API data to our insurance product structure
 */
function convertToOurStructure(externalData) {
  const issuers = new Map()
  
  externalData.forEach(item => {
    const issuerKey = item.issuer_key || item.company_key || item.insurer_id || 'unknown'
    
    if (!issuers.has(issuerKey)) {
      issuers.set(issuerKey, {
        _key: issuerKey,
        legal_name: item.legal_name || item.company_name || item.insurer_name || 'Unknown',
        short_name: item.short_name || item.company_short_name || item.insurer_short || 'Unknown',
        type: item.type || item.insurance_type || 'Life',
        license_number: item.license_number || item.license || `LIC${issuerKey}`,
        is_active: item.is_active !== undefined ? item.is_active : true,
        products: []
      })
    }
    
    const issuer = issuers.get(issuerKey)
    
    const product = {
      product_id: item.product_id || item.id || `${issuerKey}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      product_name: item.product_name || item.name || item.title || 'Unnamed Product',
      category: item.category || item.product_category || 'Life',
      sub_category: item.sub_category || item.subcategory || item.product_subcategory || 'General',
      description: item.description || item.summary || '',
      policy_types: Array.isArray(item.policy_types) ? item.policy_types : 
                   item.policy_type ? [item.policy_type] : ['Term'],
      min_sum_assured: item.min_sum_assured || item.min_sum_insured || item.min_coverage || 100000,
      max_sum_assured: item.max_sum_assured || item.max_sum_insured || item.max_coverage || null,
      min_premium: item.min_premium || item.min_premium_amount || 1000,
      max_premium: item.max_premium || item.max_premium_amount || null,
      min_entry_age: item.min_entry_age || item.min_age || 18,
      max_entry_age: item.max_entry_age || item.max_age || 65,
      policy_term_years_min: item.policy_term_years_min || item.min_term || 5,
      policy_term_years_max: item.policy_term_years_max || item.max_term || 40,
      premium_payment_frequency: Array.isArray(item.premium_payment_frequency) ? item.premium_payment_frequency :
                                item.payment_frequency ? [item.payment_frequency] :
                                ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
      premium_payment_term_min: item.premium_payment_term_min || item.premium_term_min || 5,
      premium_payment_term_max: item.premium_payment_term_max || item.premium_term_max || 35,
      premium_payment_term_type: item.premium_payment_term_type || 'Years',
      coverage_details: {
        base_coverage: item.base_coverage || item.coverage || 'Life Cover',
        additional_coverage: item.additional_coverage || null,
        exclusions: Array.isArray(item.exclusions) ? item.exclusions : 
                   item.exclusion ? [item.exclusion] : [],
        waiting_period_days: item.waiting_period_days || item.waiting_period || 0,
        renewability: item.renewability || 'Term',
        claim_settlement_ratio: item.claim_settlement_ratio || item.settlement_ratio || 95.0
      },
      riders: Array.isArray(item.riders) ? item.riders.map(rider => ({
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
      beneficiary_required: item.beneficiary_required !== undefined ? item.beneficiary_required : true,
      nomination_allowed: item.nomination_allowed !== undefined ? item.nomination_allowed : true,
      tax_benefits: Array.isArray(item.tax_benefits) ? item.tax_benefits :
                   item.tax_benefit ? [item.tax_benefit] : ['Section 80C'],
      cc: item.cc || item.commission || 2.5,
      si: item.si || item.service_income || 1.5,
      money_back: item.money_back !== undefined ? item.money_back : 
                  (item.product_name && item.product_name.toLowerCase().includes('money back')) ||
                  (item.sub_category && item.sub_category.toLowerCase().includes('money back')),
      is_active: item.is_active !== undefined ? item.is_active : true,
      launch_date: item.launch_date || new Date().toISOString().split('T')[0],
      withdrawal_date: item.withdrawal_date || null
    }
    
    issuer.products.push(product)
  })
  
  return Array.from(issuers.values())
}

/**
 * Fetch data from a generic API endpoint
 */
async function fetchFromAPI(url, headers = {}, transformFn = null) {
  try {
    console.log(`📡 Fetching from: ${url}`)
    const response = await axios.get(url, { headers })
    
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const data = response.data
    
    if (transformFn) {
      return transformFn(data)
    }
    
    // If data is an array, return as is
    if (Array.isArray(data)) {
      return data
    }
    
    // If data has a results/products/items field, extract it
    if (data.results && Array.isArray(data.results)) {
      return data.results
    }
    if (data.products && Array.isArray(data.products)) {
      return data.products
    }
    if (data.items && Array.isArray(data.items)) {
      return data.items
    }
    if (data.data && Array.isArray(data.data)) {
      return data.data
    }
    
    return []
  } catch (error) {
    console.error(`❌ Error fetching from ${url}:`, error.message)
    return []
  }
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
  
  console.log(`\n📥 Importing ${issuers.length} issuers in batches of ${BATCH_SIZE}...`)
  
  let imported = 0
  let errors = 0
  
  for (let i = 0; i < issuers.length; i += BATCH_SIZE) {
    const batch = issuers.slice(i, i + BATCH_SIZE)
    
    try {
      // Use upsert to avoid duplicates
      for (const issuer of batch) {
        try {
          // Check if issuer exists
          const existing = await q(`
            FOR issuer IN insurance_issuers
            FILTER issuer._key == @key
            LIMIT 1
            RETURN issuer
          `, { key: issuer._key })
          
          if (existing.length > 0) {
            // Update existing issuer
            await collection.update(issuer._key, {
              ...issuer,
              products: [...(existing[0].products || []), ...issuer.products]
            })
            console.log(`  ↻ Updated issuer: ${issuer.short_name}`)
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
    } catch (err) {
      console.error(`  ✗ Error processing batch ${Math.floor(i / BATCH_SIZE) + 1}:`, err.message)
      errors++
    }
  }
  
  console.log(`\n✅ Import completed!`)
  console.log(`   - Imported/Updated: ${imported} issuers`)
  console.log(`   - Errors: ${errors}`)
}

/**
 * Main function to fetch and import data
 */
async function fetchAndImport() {
  console.log(`Connecting to: ${ARANGO_URL}/${ARANGO_DATABASE}\n`)
  
  const allIssuers = []
  
  // Note: Since most insurance APIs require authentication or are not publicly available,
  // we'll create a structure that can work with multiple data sources
  // You can add API endpoints here as they become available
  
  console.log('📋 Available data sources:')
  console.log('   1. Manual data (from populate-insurance-schemes.js)')
  console.log('   2. External APIs (add endpoints below)')
  console.log('   3. CSV/JSON file imports\n')
  
  // Example: If you have an API endpoint, uncomment and configure:
  /*
  const apiEndpoints = [
    {
      url: 'https://api.example.com/insurance/products',
      headers: {
        'Authorization': 'Bearer YOUR_API_KEY',
        'Content-Type': 'application/json'
      },
      transform: (data) => data.products // Transform function if needed
    }
  ]
  
  for (const endpoint of apiEndpoints) {
    const data = await fetchFromAPI(endpoint.url, endpoint.headers, endpoint.transform)
    if (data.length > 0) {
      const converted = convertToOurStructure(data)
      allIssuers.push(...converted)
      console.log(`✅ Fetched ${data.length} products from ${endpoint.url}\n`)
    }
  }
  */
  
  // For now, we'll create a script that can be extended with real API endpoints
  console.log('💡 To use this script with real APIs:')
  console.log('   1. Add API endpoints to the apiEndpoints array')
  console.log('   2. Configure authentication headers')
  console.log('   3. Add transform functions if data structure differs')
  console.log('   4. Run: node scripts/fetch-and-import-insurance-data.js\n')
  
  if (allIssuers.length === 0) {
    console.log('⚠️  No data fetched. Add API endpoints or use populate-insurance-schemes.js for manual data.')
    return
  }
  
  // Merge issuers with same key
  const mergedIssuers = new Map()
  allIssuers.forEach(issuer => {
    if (mergedIssuers.has(issuer._key)) {
      const existing = mergedIssuers.get(issuer._key)
      existing.products.push(...issuer.products)
    } else {
      mergedIssuers.set(issuer._key, issuer)
    }
  })
  
  await importIssuersInBatches(Array.from(mergedIssuers.values()))
  
  // Calculate totals
  let totalProducts = 0
  let totalRiders = 0
  for (const issuer of mergedIssuers.values()) {
    totalProducts += issuer.products.length
    for (const product of issuer.products) {
      totalRiders += (product.riders || []).length
    }
  }
  
  console.log(`\n📊 Summary:`)
  console.log(`   - Total Issuers: ${mergedIssuers.size}`)
  console.log(`   - Total Products: ${totalProducts}`)
  console.log(`   - Total Riders: ${totalRiders}`)
}

// Run the script
fetchAndImport().catch(error => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})

