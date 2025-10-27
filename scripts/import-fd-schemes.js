import 'dotenv/config'
import { Database } from 'arangojs'
import fs from 'fs'
import path from 'path'

console.log('📥 Importing FD Schemes data...\n')

// Database connection
const db = new Database({
  url: process.env.ARANGO_URL,
  auth: { username: process.env.ARANGO_USERNAME, password: process.env.ARANGO_PASSWORD },
  databaseName: process.env.ARANGO_DATABASE
})

const jsonFilePath = path.join(process.cwd(), 'sample-fd-data.json')

try {
  // Read JSON file
  console.log('📖 Reading JSON file...')
  const fdData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'))
  console.log(`✅ Loaded ${fdData.length} issuers from JSON`)

  // Validate structure
  console.log('🔍 Validating data structure...')
  for (const issuer of fdData) {
    if (!issuer._key) {
      throw new Error(`Issuer missing _key: ${JSON.stringify(issuer).substring(0, 50)}`)
    }
    if (!issuer.schemes || !Array.isArray(issuer.schemes) || issuer.schemes.length === 0) {
      throw new Error(`Issuer ${issuer._key} missing or empty schemes array`)
    }
    for (const scheme of issuer.schemes) {
      if (!scheme.rate_slabs || !Array.isArray(scheme.rate_slabs) || scheme.rate_slabs.length === 0) {
        throw new Error(`Issuer ${issuer._key}, Scheme ${scheme.scheme_id} missing or empty rate_slabs array`)
      }
    }
  }
  console.log('✅ Data structure validation passed')

  // Import Issuers (nested structure - everything in one collection)
  console.log('🏢 Importing FD Issuers with nested schemes and rate slabs...')
  const issuersCollection = db.collection('fd_issuers')
  
  try {
    await issuersCollection.load()
  } catch (err) {
    console.log('Creating fd_issuers collection...')
    await db.collection('fd_issuers').create()
  }
  
  // Truncate existing data
  await issuersCollection.truncate()
  
  // Import all issuers with nested data
  const issuersResult = await issuersCollection.import(fdData)
  console.log(`✅ FD Issuers imported: ${issuersResult.imported}/${fdData.length} records`)

  console.log('\n✅ Import completed successfully!')
  console.log(`📊 Summary:`)
  console.log(`   - Total Issuers: ${issuersResult.imported}`)
  
  // Show breakdown
  let totalSchemes = 0
  let totalSlabs = 0
  for (const issuer of fdData) {
    totalSchemes += issuer.schemes.length
    for (const scheme of issuer.schemes) {
      totalSlabs += scheme.rate_slabs.length
    }
  }
  console.log(`   - Total Schemes: ${totalSchemes}`)
  console.log(`   - Total Rate Slabs: ${totalSlabs}`)

} catch (error) {
  console.error('❌ Error during import:', error)
  process.exit(1)
}
