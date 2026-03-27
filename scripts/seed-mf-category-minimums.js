/**
 * Seeds mf_amc_category_defaults singleton with defaults aligned to ECS0 mf_amc_categories.js.
 * Safe to re-run: only creates the document if missing.
 *
 * Usage: node scripts/seed-mf-category-minimums.js
 */
import 'dotenv/config'
import { Database } from 'arangojs'

const KEY = 'singleton'
const minimums = {
  MF: null,
  SIF: 10_00_000,
  PMS: 50_00_000,
  AIF: 1_00_00_000,
  GIFT_CITY_FUNDS: 10_00_00_000
}

const db = new Database({
  url: process.env.ARANGO_URL,
  auth: { username: process.env.ARANGO_USERNAME, password: process.env.ARANGO_PASSWORD },
  databaseName: process.env.ARANGO_DATABASE
})

const coll = db.collection('mf_amc_category_defaults')

try {
  await coll.load()
} catch {
  console.log('Creating collection mf_amc_category_defaults…')
  await db.createCollection('mf_amc_category_defaults')
}

try {
  await coll.document(KEY)
  console.log('mf_amc_category_defaults document already exists; skip seed.')
} catch {
  await coll.save({
    _key: KEY,
    minimums,
    updated_at: new Date().toISOString()
  })
  console.log('Seeded mf_amc_category_defaults with default minimums.')
}

process.exit(0)
