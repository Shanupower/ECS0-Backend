/**
 * Remove `maturity_date` from every scheme embedded in `ncd_bond_issuers` documents.
 *
 * Usage:
 *   node scripts/strip-ncd-bond-scheme-maturity-date.js           # dry-run (default)
 *   node scripts/strip-ncd-bond-scheme-maturity-date.js --dry-run
 *   node scripts/strip-ncd-bond-scheme-maturity-date.js --apply   # persist changes
 *
 * Requires the same Arango env as the API (ARANGO_URL, ARANGO_USERNAME, ARANGO_PASSWORD, ARANGO_DATABASE).
 */

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

const argv = new Set(process.argv.slice(2))
const APPLY = argv.has('--apply')

function stripMaturityFromScheme(scheme) {
  if (!scheme || typeof scheme !== 'object') return { next: scheme, changed: false }
  if (!Object.prototype.hasOwnProperty.call(scheme, 'maturity_date')) {
    return { next: scheme, changed: false }
  }
  const { maturity_date: _removed, ...rest } = scheme
  return { next: rest, changed: true }
}

async function main() {
  let issuers
  try {
    issuers = await q(`FOR i IN ncd_bond_issuers RETURN i`)
  } catch (e) {
    if (e.errorNum === 1203 || String(e.message || '').includes('not found')) {
      console.error('Collection ncd_bond_issuers not found. Nothing to do.')
      process.exit(0)
    }
    throw e
  }

  if (!Array.isArray(issuers) || issuers.length === 0) {
    console.log('No issuers in ncd_bond_issuers.')
    return
  }

  let issuersTouched = 0
  let schemesStripped = 0
  const preview = []

  const collection = getCollection('ncd_bond_issuers')

  for (const issuer of issuers) {
    const schemes = issuer.schemes
    if (!Array.isArray(schemes) || schemes.length === 0) continue

    let issuerChanged = false
    const newSchemes = schemes.map((s) => {
      const { next, changed } = stripMaturityFromScheme(s)
      if (changed) {
        issuerChanged = true
        schemesStripped += 1
        if (preview.length < 15) {
          preview.push({
            issuer_key: issuer._key,
            scheme_id: s.scheme_id || s.schemeId || '(unknown)',
            had_maturity_date: s.maturity_date
          })
        }
      }
      return next
    })

    if (issuerChanged) {
      issuersTouched += 1
      if (APPLY) {
        await collection.update(issuer._key, { schemes: newSchemes })
      }
    }
  }

  console.log(APPLY ? 'APPLY mode: updates written to ArangoDB.' : 'DRY RUN: no writes performed. Pass --apply to persist.')
  console.log(`Issuers scanned: ${issuers.length}`)
  console.log(`Issuers with ≥1 scheme updated: ${issuersTouched}`)
  console.log(`Schemes stripped of maturity_date: ${schemesStripped}`)
  if (preview.length) {
    console.log('\nSample (up to 15):')
    console.table(preview)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
