/**
 * One-time script: Copy scheme-level CC/SI to every rate slab in fd_issuers.
 * After this, CC/SI are driven by rate slabs; receipt calculation already prefers
 * slab cc/si when present (see routes/receipts.js).
 *
 * Run once: node scripts/sync-fd-slab-cc-si.js
 */

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

async function main() {
  console.log('Fetching FD issuers...')
  const issuers = await q(`
    FOR issuer IN fd_issuers
    RETURN issuer
  `)

  if (!issuers.length) {
    console.log('No FD issuers found.')
    return
  }

  let issuersUpdated = 0
  let slabsUpdated = 0

  for (const issuer of issuers) {
    const schemes = issuer.schemes || []
    const newSchemes = schemes.map((scheme) => {
      const schemeCc = scheme.cc != null ? Number(scheme.cc) : 0
      const schemeSi = scheme.si != null ? Number(scheme.si) : 0
      const slabs = scheme.rate_slabs || []
      const newSlabs = slabs.map((slab) => {
        const cc = slab.cc !== undefined && slab.cc !== null ? Number(slab.cc) : schemeCc
        const si = slab.si !== undefined && slab.si !== null ? Number(slab.si) : schemeSi
        slabsUpdated += 1
        return { ...slab, cc, si }
      })
      return { ...scheme, rate_slabs: newSlabs }
    })

    if (newSchemes.length === 0) continue

    const collection = getCollection('fd_issuers')
    await collection.update(issuer._key, { schemes: newSchemes })
    issuersUpdated += 1
    const totalSlabs = newSchemes.reduce((n, s) => n + (s.rate_slabs || []).length, 0)
    console.log(`  Updated issuer: ${issuer._key} (${schemes.length} schemes, ${totalSlabs} slabs)`)
  }

  console.log(`\nDone. Issuers updated: ${issuersUpdated}, rate slabs with CC/SI set: ${slabsUpdated}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
