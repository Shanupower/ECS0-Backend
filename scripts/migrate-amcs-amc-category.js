/**
 * One-time migration: set amc_category and min_investment on all existing AMCs.
 * - amc_category defaults to 'MF' if missing or invalid
 * - min_investment defaults to null if missing
 * Run from backend root: node scripts/migrate-amcs-amc-category.js
 */
import 'dotenv/config'
import { q } from '../config/database.js'

const VALID_AMC_CATEGORIES = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']

console.log('Migrating AMCs: setting amc_category and min_investment where missing...\n')

try {
  const updated = await q(`
    FOR amc IN amcs
    LET category = (amc.amc_category != null && amc.amc_category IN @validCategories)
      ? amc.amc_category
      : 'MF'
    LET minInv = amc.min_investment != null ? amc.min_investment : null
    UPDATE amc WITH { amc_category: category, min_investment: minInv } IN amcs
    RETURN amc._key
  `, { validCategories: VALID_AMC_CATEGORIES })

  console.log(`Updated ${updated.length} AMC(s).`)
  if (updated.length > 0) {
    updated.forEach(key => console.log(`  - ${key}`))
  }
  console.log('\nDone.')
} catch (error) {
  console.error('Error:', error)
  process.exit(1)
}

process.exit(0)
