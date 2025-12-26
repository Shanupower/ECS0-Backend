import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

// ===================================
// UTILITY FUNCTIONS
// ===================================

// Helper function to automatically expire NFOs that have passed their validity date
async function expireNFOs() {
  try {
    const today = new Date().toISOString().split('T')[0]
    
    // Find and update expired NFOs
    const expiredSchemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.is_nfo == true
      FILTER scheme.nfo_validity != null
      FILTER scheme.nfo_validity < @today
      UPDATE scheme WITH { is_nfo: false, nfo_validity: null } IN mf_schemes
      RETURN scheme.scheme_code
    `, { today })
    
    if (expiredSchemes.length > 0) {
      console.log(`[NFO Expiry] Automatically expired ${expiredSchemes.length} NFO scheme(s)`)
    }
    
    return expiredSchemes.length
  } catch (error) {
    console.error('Error expiring NFOs:', error)
    // Don't throw - allow the request to continue even if expiry check fails
    return 0
  }
}

// Helper function to generate display name
function generateDisplayName(baseName, plan, option) {
  const planTitle = plan === 'REGULAR' ? 'Regular' : 'Direct'
  const optionTitle = 
    option === 'GROWTH' ? 'Growth' :
    option === 'IDCW_PAYOUT' ? 'IDCW – Payout' :
    'IDCW – Reinvestment'
  return `${baseName} – ${planTitle} – ${optionTitle}`
}

// Helper function to check ETF + IDCW warning
function checkETFIDCWWarning(category, subCategory, option) {
  const isETF = /ETF|Index/i.test(category || '') || /ETF|Index/i.test(subCategory || '')
  const isIDCW = option === 'IDCW_PAYOUT' || option === 'IDCW_REINVEST'
  return isETF && isIDCW ? ['IDCW not typical for ETF/Index schemes'] : []
}

// ===================================
// GET ROUTES (Everyone can access)
// ===================================

// List all AMCs
router.get('/amcs', async (req, res) => {
  try {
    const amcs = await q(`
      FOR amc IN amcs
      SORT amc.amc_name
      RETURN amc
    `)
    
    res.json(amcs)
  } catch (error) {
    console.error('Error fetching AMCs:', error)
    res.status(500).json({ error: 'Failed to fetch AMCs' })
  }
})

// Get schemes by AMC code (filter out expired NFOs)
router.get('/amc/:amc_code', async (req, res) => {
  try {
    const { amc_code } = req.params
    const today = new Date().toISOString().split('T')[0] // Get date in YYYY-MM-DD format
    
    // Automatically expire NFOs that have passed their validity date
    await expireNFOs()
    
    const schemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.amc_code == @amc_code
      FILTER (scheme.is_nfo == false OR scheme.is_nfo == true AND scheme.nfo_validity >= @today)
      SORT scheme.scheme_name
      RETURN scheme
    `, { amc_code, today })
    
    res.json(schemes)
  } catch (error) {
    console.error('Error fetching schemes:', error)
    res.status(500).json({ error: 'Failed to fetch schemes' })
  }
})

// Get single scheme details
router.get('/:scheme_code', async (req, res) => {
  try {
    const { scheme_code } = req.params
    
    // Automatically expire NFOs that have passed their validity date
    await expireNFOs()
    
    const schemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.scheme_code == @scheme_code
      LIMIT 1
      RETURN scheme
    `, { scheme_code })
    
    if (schemes.length === 0) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    res.json(schemes[0])
  } catch (error) {
    console.error('Error fetching scheme:', error)
    res.status(500).json({ error: 'Failed to fetch scheme' })
  }
})

// ===================================
// CREATE ROUTES (Admin only)
// ===================================

// Create AMC
router.post('/amc', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_name, amc_code } = req.body
    
    if (!amc_name || !amc_code) {
      return res.status(400).json({ error: 'amc_name and amc_code are required' })
    }
    
    // Check if AMC code already exists
    const existing = await q(`
      FOR amc IN amcs
      FILTER amc.amc_code == @amc_code
      LIMIT 1
      RETURN amc
    `, { amc_code })
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'AMC code already exists' })
    }
    
    const amcsCollection = getCollection('amcs')
    const result = await amcsCollection.save({
      _key: amc_code,
      amc_name,
      amc_code,
      created_at: new Date().toISOString()
    })
    
    res.status(201).json({ id: result._key, message: 'AMC created successfully' })
  } catch (error) {
    console.error('Error creating AMC:', error)
    res.status(500).json({ error: 'Failed to create AMC' })
  }
})

// Create Scheme (legacy single scheme creation)
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      scheme_code,
      scheme_name,
      amc_code,
      amc_name,
      category,
      sub_category,
      plan,
      option,
      base_name,
      type,
      nav_latest,
      nav_date,
      is_nfo,
      nfo_validity
    } = req.body
    
    if (!scheme_code || !scheme_name || !amc_code || !amc_name) {
      return res.status(400).json({ error: 'scheme_code, scheme_name, amc_code, and amc_name are required' })
    }
    
    // Check if scheme code already exists
    const existing = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.scheme_code == @scheme_code
      LIMIT 1
      RETURN scheme
    `, { scheme_code })
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Scheme code already exists' })
    }
    
    // Calculate display name if option is provided
    const displayName = (option && base_name) 
      ? generateDisplayName(base_name, plan || 'REGULAR', option)
      : scheme_name
    
    const schemesCollection = getCollection('mf_schemes')
    const result = await schemesCollection.save({
      scheme_code,
      scheme_name,
      display_name: displayName,
      base_name: base_name || scheme_name,
      amc_code,
      amc_name,
      category,
      sub_category,
      plan: plan || 'REGULAR',
      option: option || 'GROWTH',
      type,
      nav_latest: nav_latest || 0,
      nav_date: nav_date || null,
      is_nfo: is_nfo || false,
      nfo_validity: is_nfo ? nfo_validity : null,
      is_active: true,
      created_at: new Date().toISOString()
    })
    
    res.status(201).json({ id: result._key, message: 'Scheme created successfully' })
  } catch (error) {
    console.error('Error creating scheme:', error)
    res.status(500).json({ error: 'Failed to create scheme' })
  }
})

// Expand Preview - Generate plan × option variants
router.post('/expand-preview', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      amc_code,
      amc_name,
      base_name,
      category,
      sub_category,
      type,
      is_nfo,
      plans,
      options,
      proposedAmfiCodes
    } = req.body
    
    // Validation
    if (!amc_code || !base_name) {
      return res.status(400).json({ error: 'amc_code and base_name are required' })
    }
    
    if (!plans || !Array.isArray(plans) || plans.length === 0) {
      return res.status(400).json({ error: 'At least one plan must be selected' })
    }
    
    if (!options || !Array.isArray(options) || options.length === 0) {
      return res.status(400).json({ error: 'At least one option must be selected' })
    }
    
    // Generate cartesian product of plans × options
    const variants = []
    
    for (const plan of plans) {
      for (const option of options) {
        const displayName = generateDisplayName(base_name, plan, option)
        const comboKey = `${plan}|${option}`
        const proposedCode = proposedAmfiCodes?.[comboKey] || ''
        
        // Check if this combination already exists
        const existingCheck = await q(`
          FOR scheme IN mf_schemes
          FILTER scheme.amc_code == @amc_code
          FILTER scheme.base_name == @base_name
          FILTER scheme.plan == @plan
          FILTER scheme.option == @option
          LIMIT 1
          RETURN scheme
        `, { amc_code, base_name, plan, option })
        
        const exists = existingCheck.length > 0
        const missingAmfi = !proposedCode && !is_nfo
        const warnings = checkETFIDCWWarning(category, sub_category, option)
        
        variants.push({
          plan,
          option,
          display_name: displayName,
          amfi_code: proposedCode,
          exists,
          missingAmfi,
          warnings,
          existing_scheme_code: exists ? existingCheck[0].scheme_code : null
        })
      }
    }
    
    res.json({ variants })
  } catch (error) {
    console.error('Error in expand-preview:', error)
    res.status(500).json({ error: 'Failed to generate preview' })
  }
})

// Commit Variants - Bulk create/update scheme variants
router.post('/commit-variants', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      amc_code,
      amc_name,
      base_name,
      category,
      sub_category,
      type,
      is_nfo,
      nfo_validity,
      variants
    } = req.body
    
    // Validation
    if (!amc_code || !amc_name || !base_name) {
      return res.status(400).json({ error: 'amc_code, amc_name, and base_name are required' })
    }
    
    if (!variants || !Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ error: 'At least one variant must be provided' })
    }
    
    // Filter only selected variants
    const selectedVariants = variants.filter(v => v.selected === true)
    
    if (selectedVariants.length === 0) {
      return res.status(400).json({ error: 'No variants selected' })
    }
    
    let created = 0
    let updated = 0
    let skipped = 0
    const errors = []
    
    const schemesCollection = getCollection('mf_schemes')
    
    for (const variant of selectedVariants) {
      try {
        const { plan, option, amfi_code, updateIfExists } = variant
        
        // Validate AMFI code requirement
        if (!amfi_code && !is_nfo) {
          errors.push({
            variant: `${plan}|${option}`,
            error: 'AMFI code is required for non-NFO schemes'
          })
          skipped++
          continue
        }
        
        const displayName = generateDisplayName(base_name, plan, option)
        
        // Check if scheme with this AMFI code exists
        const existingByCode = amfi_code ? await q(`
          FOR scheme IN mf_schemes
          FILTER scheme.scheme_code == @scheme_code
          LIMIT 1
          RETURN scheme
        `, { scheme_code: amfi_code }) : []
        
        // Check if combination exists
        const existingByCombo = await q(`
          FOR scheme IN mf_schemes
          FILTER scheme.amc_code == @amc_code
          FILTER scheme.base_name == @base_name
          FILTER scheme.plan == @plan
          FILTER scheme.option == @option
          LIMIT 1
          RETURN scheme
        `, { amc_code, base_name, plan, option })
        
        const schemeData = {
          scheme_code: amfi_code || `${amc_code}_${plan}_${option}_${Date.now()}`,
          scheme_name: base_name, // Store base name in scheme_name
          display_name: displayName,
          base_name: base_name,
          amc_code,
          amc_name,
          category: category || '',
          sub_category: sub_category || '',
          plan,
          option,
          type: type || 'OPEN_ENDED',
          nav_latest: 0,
          nav_date: null,
          is_nfo: is_nfo || false,
          nfo_validity: is_nfo ? nfo_validity : null,
          is_active: is_nfo ? false : true, // NFO schemes start as inactive
          updated_at: new Date().toISOString()
        }
        
        if (existingByCode.length > 0) {
          // Update existing scheme by AMFI code
          if (updateIfExists) {
            await q(`
              FOR scheme IN mf_schemes
              FILTER scheme.scheme_code == @scheme_code
              UPDATE scheme WITH @data IN mf_schemes
            `, { scheme_code: amfi_code, data: schemeData })
            updated++
          } else {
            errors.push({
              variant: `${plan}|${option}`,
              error: `Scheme with code ${amfi_code} already exists`
            })
            skipped++
          }
        } else if (existingByCombo.length > 0) {
          // Update existing combination
          if (updateIfExists) {
            await q(`
              FOR scheme IN mf_schemes
              FILTER scheme.amc_code == @amc_code
              FILTER scheme.base_name == @base_name
              FILTER scheme.plan == @plan
              FILTER scheme.option == @option
              UPDATE scheme WITH @data IN mf_schemes
            `, { amc_code, base_name, plan, option, data: schemeData })
            updated++
          } else {
            skipped++
          }
        } else {
          // Create new scheme
          schemeData.created_at = new Date().toISOString()
          await schemesCollection.save(schemeData)
          created++
        }
        
      } catch (variantError) {
        console.error(`Error processing variant:`, variantError)
        errors.push({
          variant: `${variant.plan}|${variant.option}`,
          error: variantError.message
        })
        skipped++
      }
    }
    
    res.json({
      created,
      updated,
      skipped,
      errors
    })
    
  } catch (error) {
    console.error('Error in commit-variants:', error)
    res.status(500).json({ error: 'Failed to commit variants' })
  }
})

// Bulk CC/SI update for MF and FD schemes (admin only)
router.post('/bulk-cc-si-update', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'invalid_payload', detail: 'items array is required' })
    }

    const results = {
      updated: 0,
      failed: 0,
      errors: []
    }

    for (const item of items) {
      const { type, scheme_code, issuer_key, scheme_id, cc, si } = item || {}
      try {
        const ccVal = cc !== undefined && cc !== null ? Number(cc) : null
        const siVal = si !== undefined && si !== null ? Number(si) : null

        if (!type || (type !== 'MF' && type !== 'FD')) {
          throw new Error('type must be MF or FD')
        }

        if (type === 'MF') {
          if (!scheme_code) throw new Error('scheme_code is required for MF')
          await q(`
            FOR scheme IN mf_schemes
            FILTER scheme.scheme_code == @scheme_code
            UPDATE scheme WITH {
              cc: @ccVal,
              si: @siVal
            } IN mf_schemes
          `, { scheme_code, ccVal, siVal })
          results.updated++
        } else if (type === 'FD') {
          if (!issuer_key || !scheme_id) throw new Error('issuer_key and scheme_id are required for FD')

          const issuers = await q(`
            FOR issuer IN fd_issuers
            FILTER issuer._key == @issuer_key
            LIMIT 1
            RETURN issuer
          `, { issuer_key })

          if (!issuers.length) {
            throw new Error(`FD issuer not found for key ${issuer_key}`)
          }

          const issuer = issuers[0]
          const schemes = issuer.schemes || []
          const updatedSchemes = schemes.map(s => {
            if (s.scheme_id === scheme_id) {
              return {
                ...s,
                cc: ccVal,
                si: siVal
              }
            }
            return s
          })

          await q(`
            FOR issuer IN fd_issuers
            FILTER issuer._key == @issuer_key
            UPDATE issuer WITH { schemes: @schemes } IN fd_issuers
          `, { issuer_key, schemes: updatedSchemes })
          results.updated++
        }
      } catch (err) {
        results.failed++
        results.errors.push({
          item,
          detail: err.message || String(err)
        })
      }
    }

    res.json(results)
  } catch (error) {
    console.error('Error in bulk-cc-si-update:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to bulk update CC/SI' })
  }
})

// Check Duplicate - Check if a variant already exists
router.get('/check-duplicate', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_code, base_name, plan, option } = req.query
    
    if (!amc_code || !base_name || !plan || !option) {
      return res.status(400).json({ error: 'amc_code, base_name, plan, and option are required' })
    }
    
    const existing = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.amc_code == @amc_code
      FILTER scheme.base_name == @base_name
      FILTER scheme.plan == @plan
      FILTER scheme.option == @option
      LIMIT 1
      RETURN scheme
    `, { amc_code, base_name, plan, option })
    
    if (existing.length > 0) {
      res.json({
        exists: true,
        scheme_code: existing[0].scheme_code
      })
    } else {
      res.json({
        exists: false
      })
    }
    
  } catch (error) {
    console.error('Error checking duplicate:', error)
    res.status(500).json({ error: 'Failed to check duplicate' })
  }
})

// ===================================
// UPDATE ROUTES (Admin only)
// ===================================

// Update AMC
router.put('/amc/:amc_code', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_code } = req.params
    const { amc_name } = req.body
    
    if (!amc_name) {
      return res.status(400).json({ error: 'amc_name is required' })
    }
    
    const amcsCollection = getCollection('amcs')
    const result = await amcsCollection.update(amc_code, {
      amc_name,
      updated_at: new Date().toISOString()
    })
    
    res.json({ message: 'AMC updated successfully', result })
  } catch (error) {
    console.error('Error updating AMC:', error)
    res.status(500).json({ error: 'Failed to update AMC' })
  }
})

// Update Scheme
router.put('/:scheme_code', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { scheme_code } = req.params
    const {
      scheme_name,
      base_name,
      category,
      sub_category,
      plan,
      option,
      type,
      nav_latest,
      nav_date,
      is_nfo,
      nfo_validity,
      is_active
    } = req.body
    
    // Build update object with only provided fields
    const updateData = {
      updated_at: new Date().toISOString()
    }
    
    if (scheme_name !== undefined) updateData.scheme_name = scheme_name
    if (base_name !== undefined) updateData.base_name = base_name
    if (category !== undefined) updateData.category = category
    if (sub_category !== undefined) updateData.sub_category = sub_category
    if (plan !== undefined) updateData.plan = plan
    if (option !== undefined) updateData.option = option
    if (type !== undefined) updateData.type = type
    if (nav_latest !== undefined) updateData.nav_latest = nav_latest
    if (nav_date !== undefined) updateData.nav_date = nav_date
    if (is_nfo !== undefined) updateData.is_nfo = is_nfo
    if (nfo_validity !== undefined) updateData.nfo_validity = is_nfo ? nfo_validity : null
    if (is_active !== undefined) updateData.is_active = is_active
    
    // Regenerate display_name if relevant fields changed
    if ((base_name !== undefined || plan !== undefined || option !== undefined)) {
      // Get current scheme to fetch missing fields
      const currentScheme = await q(`
        FOR scheme IN mf_schemes
        FILTER scheme.scheme_code == @scheme_code
        LIMIT 1
        RETURN scheme
      `, { scheme_code })
      
      if (currentScheme.length > 0) {
        const current = currentScheme[0]
        const finalBaseName = base_name || current.base_name || current.scheme_name
        const finalPlan = plan || current.plan || 'REGULAR'
        const finalOption = option || current.option || 'GROWTH'
        updateData.display_name = generateDisplayName(finalBaseName, finalPlan, finalOption)
      }
    }
    
    const schemesCollection = getCollection('mf_schemes')
    
    // Find the scheme
    const schemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.scheme_code == @scheme_code
      LIMIT 1
      RETURN scheme._key
    `, { scheme_code })
    
    if (schemes.length === 0) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const schemeKey = schemes[0]
    const result = await schemesCollection.update(schemeKey, updateData)
    
    res.json({ message: 'Scheme updated successfully', result })
  } catch (error) {
    console.error('Error updating scheme:', error)
    res.status(500).json({ error: 'Failed to update scheme' })
  }
})

// ===================================
// DELETE ROUTES (Admin only)
// ===================================

// Delete AMC (and all its schemes)
router.delete('/amc/:amc_code', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_code } = req.params
    
    // Delete all schemes for this AMC
    const schemesResult = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.amc_code == @amc_code
      REMOVE scheme IN mf_schemes
      RETURN scheme._key
    `, { amc_code })
    
    // Delete the AMC
    const amcsCollection = getCollection('amcs')
    const result = await amcsCollection.remove(amc_code)
    
    res.json({ 
      message: 'AMC and its schemes deleted successfully',
      deleted_schemes: schemesResult.length
    })
  } catch (error) {
    console.error('Error deleting AMC:', error)
    res.status(500).json({ error: 'Failed to delete AMC' })
  }
})

// Delete Scheme
router.delete('/:scheme_code', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { scheme_code } = req.params
    
    // Find the scheme
    const schemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.scheme_code == @scheme_code
      LIMIT 1
      RETURN scheme._key
    `, { scheme_code })
    
    if (schemes.length === 0) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const schemeKey = schemes[0]
    const schemesCollection = getCollection('mf_schemes')
    const result = await schemesCollection.remove(schemeKey)
    
    res.json({ message: 'Scheme deleted successfully' })
  } catch (error) {
    console.error('Error deleting scheme:', error)
    res.status(500).json({ error: 'Failed to delete scheme' })
  }
})

// ===================================
// NFO VALIDITY CHECK (Admin/System)
// ===================================

// Check and expire NFOs (manual trigger - also runs automatically on scheme fetches)
router.post('/check-nfo-validity', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const expiredCount = await expireNFOs()
    
    res.json({ 
      message: 'NFO validity check completed',
      expired_count: expiredCount,
      note: 'NFOs are automatically expired when schemes are fetched. This endpoint allows manual triggering.'
    })
  } catch (error) {
    console.error('Error checking NFO validity:', error)
    res.status(500).json({ error: 'Failed to check NFO validity' })
  }
})

export default router

