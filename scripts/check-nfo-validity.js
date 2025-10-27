import 'dotenv/config'
import { q } from '../config/database.js'

console.log('🔍 Checking NFO validity...\n')

const today = new Date().toISOString().split('T')[0]

try {
  // Query for expired NFOs
  const expiredSchemes = await q(`
    FOR scheme IN mf_schemes
    FILTER scheme.is_nfo == true
    FILTER scheme.nfo_validity < @today
    RETURN scheme
  `, { today })
  
  if (expiredSchemes.length === 0) {
    console.log('✅ No expired NFOs found')
    process.exit(0)
  }
  
  console.log(`⚠️  Found ${expiredSchemes.length} expired NFO(s):`)
  expiredSchemes.forEach(scheme => {
    console.log(`   - ${scheme.scheme_name} (Code: ${scheme.scheme_code}, Validity: ${scheme.nfo_validity})`)
  })
  
  // Update expired NFOs
  const updatedSchemes = await q(`
    FOR scheme IN mf_schemes
    FILTER scheme.is_nfo == true
    FILTER scheme.nfo_validity < @today
    UPDATE scheme WITH { is_nfo: false, nfo_validity: null } IN mf_schemes
    RETURN scheme.scheme_name
  `, { today })
  
  console.log(`\n✅ Updated ${updatedSchemes.length} scheme(s):`)
  updatedSchemes.forEach(name => {
    console.log(`   - ${name}`)
  })
  
  console.log(`\n🎉 NFO validity check completed successfully!`)
  
} catch (error) {
  console.error('❌ Error checking NFO validity:', error)
  process.exit(1)
}

process.exit(0)

