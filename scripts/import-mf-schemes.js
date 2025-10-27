import 'dotenv/config'
import { Database } from 'arangojs'
import fs from 'fs'
import path from 'path'

console.log('📥 Importing MF Schemes data...\n')

// Database connection
const db = new Database({
  url: process.env.ARANGO_URL,
  auth: { username: process.env.ARANGO_USERNAME, password: process.env.ARANGO_PASSWORD },
  databaseName: process.env.ARANGO_DATABASE
})

const jsonFilePath = 'C:\\Users\\Admin\\Downloads\\mf_schemes_formatted.json'

try {
  // Read JSON file
  console.log('📖 Reading JSON file...')
  const mfData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'))
  console.log(`✅ Loaded ${mfData.length} AMCs from JSON`)

  // Extract unique AMCs
  const amcsData = mfData.map(amc => ({
    _key: amc.amc_code,
    amc_name: amc.amc_name,
    amc_code: amc.amc_code
  }))

  console.log(`📦 Extracting ${amcsData.length} unique AMCs...`)

  // Prepare schemes data
  const schemesData = []
  let totalSchemes = 0

  mfData.forEach(amc => {
    amc.schemes.forEach(scheme => {
      schemesData.push({
        scheme_code: scheme.scheme_code,
        scheme_name: scheme.scheme_name,
        amc_code: amc.amc_code,
        amc_name: amc.amc_name,
        category: scheme.category,
        sub_category: scheme.sub_category,
        plan: scheme.plan,
        type: scheme.type,
        nav_latest: scheme.nav?.latest || 0,
        nav_date: scheme.nav?.date || null,
        is_nfo: false, // Default to false
        nfo_validity: null // Default to null
      })
      totalSchemes++
    })
  })

  console.log(`📦 Prepared ${totalSchemes} schemes for import`)

  // Import AMCs
  console.log('🏢 Importing AMCs...')
  const amcsCollection = db.collection('amcs')
  
  // Check if collection exists, create if not
  try {
    await amcsCollection.load()
  } catch (err) {
    console.log('Creating amcs collection...')
    await db.collection('amcs').create()
  }
  
  // Truncate existing data
  await amcsCollection.truncate()
  
  // Import AMCs
  const amcsResult = await amcsCollection.import(amcsData)
  console.log(`✅ AMCs imported: ${amcsResult.imported}/${amcsData.length} records`)

  // Import Schemes
  console.log('📊 Importing MF Schemes...')
  const schemesCollection = db.collection('mf_schemes')
  
  // Check if collection exists, create if not
  try {
    await schemesCollection.load()
  } catch (err) {
    console.log('Creating mf_schemes collection...')
    await db.collection('mf_schemes').create()
  }
  
  // Truncate existing data
  await schemesCollection.truncate()
  
  // Import in batches to avoid memory issues
  const batchSize = 1000
  let imported = 0
  
  for (let i = 0; i < schemesData.length; i += batchSize) {
    const batch = schemesData.slice(i, i + batchSize)
    const result = await schemesCollection.import(batch)
    imported += result.imported
    console.log(`  Imported batch ${Math.floor(i / batchSize) + 1}: ${result.imported} schemes (Total: ${imported}/${totalSchemes})`)
  }

  console.log(`\n✅ Import complete!`)
  console.log(`   - AMCs: ${amcsData.length}`)
  console.log(`   - Schemes: ${imported}`)
  console.log(`\n🎉 MF Schemes data imported successfully!`)

} catch (error) {
  console.error('❌ Error importing data:', error)
  process.exit(1)
}

process.exit(0)

