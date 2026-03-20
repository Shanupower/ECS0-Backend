/**
 * One-time migration: add categories array to all AMCs (multi-category support).
 * - If AMC has no categories, set categories: [amc_category || 'MF']
 * - If AMC has min_investment set, optionally set category_settings[category].min_investment
 * Run from backend root: node scripts/migrate-amcs-multi-category.js
 */
import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

const VALID_AMC_CATEGORIES = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']

console.log('Migrating AMCs: adding categories array (multi-category support)...\n')

try {
  const amcs = await q(`
    FOR amc IN amcs
    RETURN amc
  `)

  const amcsCollection = getCollection('amcs')
  let updated = 0

  for (const amc of amcs) {
    const hasCategories = amc.categories && Array.isArray(amc.categories) && amc.categories.length > 0
    if (hasCategories) {
      continue
    }

    const singleCategory = amc.amc_category && VALID_AMC_CATEGORIES.includes(amc.amc_category)
      ? amc.amc_category
      : 'MF'
    const categories = [singleCategory]

    const update = {
      categories,
      updated_at: new Date().toISOString()
    }
    if (amc.amc_category !== singleCategory) {
      update.amc_category = singleCategory
    }
    if (amc.min_investment != null && typeof amc.min_investment === 'number') {
      update.category_settings = {
        [singleCategory]: { min_investment: amc.min_investment }
      }
    }

    await amcsCollection.update(amc._key, update)
    updated++
    console.log(`  - ${amc.amc_code}: categories = [${categories.join(', ')}]`)
  }

  console.log(`\nUpdated ${updated} AMC(s). Done.`)
} catch (error) {
  console.error('Error:', error)
  process.exit(1)
}

process.exit(0)
