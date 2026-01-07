import { Database } from 'arangojs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

console.log('📥 Batch Import Insurance Data from Multiple Sources...\n')

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
 * Convert external data to our insurance product structure
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
 * Fetch from API endpoint
 */
async function fetchFromAPI(url, headers = {}, transformFn = null) {
  try {
    console.log(`📡 Fetching from API: ${url}`)
    const response = await axios.get(url, { headers, timeout: 30000 })
    
    let data = response.data
    
    if (transformFn) {
      data = transformFn(data)
    }
    
    // If data is an array, return as is
    if (Array.isArray(data)) {
      return data
    }
    
    // Extract from common response structures
    if (data.results && Array.isArray(data.results)) return data.results
    if (data.products && Array.isArray(data.products)) return data.products
    if (data.items && Array.isArray(data.items)) return data.items
    if (data.data && Array.isArray(data.data)) return data.data
    
    return []
  } catch (error) {
    console.error(`❌ Error fetching from ${url}:`, error.message)
    return []
  }
}

/**
 * Load data from JSON file
 */
function loadFromJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`)
      return []
    }
    
    console.log(`📄 Reading file: ${filePath}`)
    const fileContent = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(fileContent)
    
    return Array.isArray(data) ? data : []
  } catch (error) {
    console.error(`❌ Error reading file ${filePath}:`, error.message)
    return []
  }
}

/**
 * Import issuers in batches
 */
async function importIssuersInBatches(issuers) {
  const collection = db.collection('insurance_issuers')
  
  try {
    // Check if collection exists by trying to get its info
    const collections = await db.listCollections()
    const exists = collections.some(c => c.name === 'insurance_issuers')
    
    if (!exists) {
      console.log('📦 Creating insurance_issuers collection...')
      await collection.create()
      console.log('✅ Collection created')
    } else {
      console.log('✅ Collection exists')
    }
  } catch (err) {
    if (err.errorNum === 1207 || err.code === 409) {
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
          console.log(`  ↻ Updated: ${issuer.short_name} (+${newProducts.length} products)`)
          updated++
        } else {
          console.log(`  ⊙ Skipped: ${issuer.short_name} (no new products)`)
        }
      } else {
        // Use replace instead of save to handle upsert
        try {
          await collection.replace(issuer._key, issuer, { overwrite: true })
          console.log(`  ✓ Added: ${issuer.short_name} (${issuer.products.length} products)`)
          imported++
        } catch (saveErr) {
          // If replace fails due to key conflict, try update
          if (saveErr.errorNum === 1210 || saveErr.message.includes('unique constraint')) {
            await collection.update(issuer._key, issuer)
            console.log(`  ↻ Updated: ${issuer.short_name} (${issuer.products.length} products)`)
            updated++
          } else {
            throw saveErr
          }
        }
      }
    } catch (err) {
      // If error is just that it already exists, try to update instead
      if (err.errorNum === 1210 || err.message.includes('unique constraint')) {
        try {
          await collection.update(issuer._key, issuer)
          console.log(`  ↻ Updated: ${issuer.short_name} (${issuer.products.length} products)`)
          updated++
        } catch (updateErr) {
          console.error(`  ✗ Error: ${issuer.short_name} - ${updateErr.message}`)
          errors++
        }
      } else {
        console.error(`  ✗ Error: ${issuer.short_name} - ${err.message}`)
        errors++
      }
    }
  }
  
  console.log(`\n✅ Import completed!`)
  console.log(`   - New: ${imported}`)
  console.log(`   - Updated: ${updated}`)
  console.log(`   - Errors: ${errors}`)
}

/**
 * Main function
 */
async function batchImport() {
  console.log(`Connecting to: ${ARANGO_URL}/${ARANGO_DATABASE}\n`)
  
  const allData = []
  
  // ============================================
  // CONFIGURATION: Add your data sources here
  // ============================================
  
  // 1. API Endpoints (add your API endpoints here)
  const apiEndpoints = [
    // Example:
    // {
    //   url: 'https://api.example.com/insurance/products',
    //   headers: {
    //     'Authorization': 'Bearer YOUR_API_KEY',
    //     'Content-Type': 'application/json'
    //   },
    //   transform: (data) => data.products // Optional transform function
    // }
  ]
  
  // 2. JSON Files (add paths to JSON files)
  const jsonFiles = [
    // Example:
    // path.join(__dirname, 'insurance-data-1.json'),
    // path.join(__dirname, 'insurance-data-2.json'),
  ]
  
  // 3. Load existing comprehensive data from populate-insurance-schemes.js
  console.log('📦 Loading existing insurance data from populate script...')
  try {
    const populateScriptPath = path.join(__dirname, 'populate-insurance-schemes.js')
    if (fs.existsSync(populateScriptPath)) {
      const scriptContent = fs.readFileSync(populateScriptPath, 'utf8')
      
      // Extract the insuranceIssuers array - find the const declaration
      const arrayStart = scriptContent.indexOf('const insuranceIssuers = [')
      if (arrayStart !== -1) {
        // Find the matching closing bracket by counting brackets
        let bracketCount = 0
        let inString = false
        let stringChar = null
        let i = arrayStart + 'const insuranceIssuers = '.length
        
        for (; i < scriptContent.length; i++) {
          const char = scriptContent[i]
          
          // Handle string escaping
          if (char === '\\' && inString) {
            i++ // Skip next character
            continue
          }
          
          // Toggle string state
          if ((char === '"' || char === "'" || char === '`') && !inString) {
            inString = true
            stringChar = char
          } else if (char === stringChar && inString) {
            inString = false
            stringChar = null
          }
          
          // Count brackets only when not in string
          if (!inString) {
            if (char === '[') bracketCount++
            if (char === ']') {
              bracketCount--
              if (bracketCount === 0) {
                // Found the end of the array
                const arrayString = scriptContent.substring(arrayStart + 'const insuranceIssuers = '.length, i + 1)
                try {
                  // Use eval to parse the array (safe since it's our own file)
                  const insuranceIssuers = eval(arrayString)
                  
                  if (Array.isArray(insuranceIssuers) && insuranceIssuers.length > 0) {
                    // Convert to our import format
                    const existingData = insuranceIssuers.flatMap(issuer => 
                      (issuer.products || []).map(product => ({
                        issuer_key: issuer._key,
                        legal_name: issuer.legal_name,
                        short_name: issuer.short_name,
                        type: issuer.type,
                        license_number: issuer.license_number,
                        ...product
                      }))
                    )
                    allData.push(...existingData)
                    console.log(`   ✓ Loaded ${existingData.length} products from existing data (${insuranceIssuers.length} issuers)`)
                  }
                } catch (evalErr) {
                  console.log(`   ⊙ Could not parse array: ${evalErr.message}`)
                }
                break
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(`   ⊙ Could not load from populate script: ${err.message}`)
  }
  
  // ============================================
  // Fetch data from APIs
  // ============================================
  console.log('\n📡 Fetching from APIs...')
  for (const endpoint of apiEndpoints) {
    const data = await fetchFromAPI(endpoint.url, endpoint.headers, endpoint.transform)
    allData.push(...data)
    if (data.length > 0) {
      console.log(`   ✓ Fetched ${data.length} items from ${endpoint.url}`)
    }
  }
  
  // ============================================
  // Load data from JSON files
  // ============================================
  console.log('\n📄 Loading from JSON files...')
  for (const jsonFile of jsonFiles) {
    const data = loadFromJSON(jsonFile)
    allData.push(...data)
    if (data.length > 0) {
      console.log(`   ✓ Loaded ${data.length} items from ${path.basename(jsonFile)}`)
    }
  }
  
  if (allData.length === 0) {
    console.log('\n⚠️  No data found. Please configure API endpoints or JSON files in the script.')
    console.log('\n💡 Configuration options:')
    console.log('   1. Add API endpoints to apiEndpoints array')
    console.log('   2. Add JSON file paths to jsonFiles array')
    console.log('   3. Or use: node scripts/import-insurance-from-json.js [file.json]')
    return
  }
  
  console.log(`\n📊 Total items to process: ${allData.length}`)
  
  // Convert to our structure
  console.log('\n🔄 Converting data to our structure...')
  const issuers = convertToOurStructure(allData)
  
  if (issuers.length === 0) {
    console.log('⚠️  No issuers converted from data')
    return
  }
  
  // Merge issuers with same key
  const mergedIssuers = new Map()
  issuers.forEach(issuer => {
    if (mergedIssuers.has(issuer._key)) {
      const existing = mergedIssuers.get(issuer._key)
      existing.products.push(...issuer.products)
    } else {
      mergedIssuers.set(issuer._key, issuer)
    }
  })
  
  // Import to database
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
  
  console.log(`\n📊 Final Summary:`)
  console.log(`   - Issuers: ${mergedIssuers.size}`)
  console.log(`   - Products: ${totalProducts}`)
  console.log(`   - Riders: ${totalRiders}`)
}

// Run the script
batchImport().catch(error => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})

