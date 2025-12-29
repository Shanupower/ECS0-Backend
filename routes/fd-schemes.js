import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadExcel, uploadsDir } from '../middleware/upload.js'
import ExcelJS from 'exceljs'

const router = express.Router()

// ===================================
// HELPER FUNCTIONS
// ===================================

function validateBusinessRules(data) {
  const errors = []
  
  // Validate schemes
  if (data.schemes && Array.isArray(data.schemes)) {
    data.schemes.forEach((scheme, idx) => {
      // Min tenure <= max tenure
      if (scheme.min_tenure_months > scheme.max_tenure_months) {
        errors.push(`Scheme ${idx + 1}: min_tenure_months (${scheme.min_tenure_months}) must be <= max_tenure_months (${scheme.max_tenure_months})`)
      }
      
      // Cumulative schemes only allow "On Maturity"
      if (scheme.is_cumulative && !scheme.payout_frequency_type.every(f => f === 'On Maturity')) {
        errors.push(`Scheme ${idx + 1}: Cumulative schemes must only have "On Maturity" payout frequency`)
      }
      
      // Non-cumulative schemes exclude "On Maturity"
      if (!scheme.is_cumulative && scheme.payout_frequency_type.includes('On Maturity')) {
        errors.push(`Scheme ${idx + 1}: Non-cumulative schemes cannot have "On Maturity" payout frequency`)
      }
      
      // Premature terms required if allowed
      if (scheme.premature_allowed && (!scheme.premature_terms || scheme.premature_terms.trim() === '')) {
        errors.push(`Scheme ${idx + 1}: premature_terms is required when premature_allowed is true`)
      }
      
      // Validate rate slabs
      if (scheme.rate_slabs && Array.isArray(scheme.rate_slabs)) {
        scheme.rate_slabs.forEach((slab, slabIdx) => {
          // Slab tenure validation
          if (slab.tenure_min_months > slab.tenure_max_months) {
            errors.push(`Scheme ${idx + 1}, Slab ${slabIdx + 1}: tenure_min_months must be <= tenure_max_months`)
          }
          
          // Slab payout frequency must be in scheme's allowed list
          if (!scheme.payout_frequency_type.includes(slab.payout_frequency_type)) {
            errors.push(`Scheme ${idx + 1}, Slab ${slabIdx + 1}: payout_frequency_type "${slab.payout_frequency_type}" not allowed in scheme`)
          }
        })
      }
    })
  }
  
  return errors
}

// ===================================
// READ OPERATIONS (Everyone can access)
// ===================================

// List all active FD issuers
router.get('/issuers', async (req, res) => {
  try {
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer.is_active == true
      RETURN issuer
    `)
    
    res.json(issuers)
  } catch (error) {
    console.error('Error fetching FD issuers:', error)
    res.status(500).json({ error: 'Failed to fetch FD issuers' })
  }
})

// Get single issuer with all nested schemes and slabs
router.get('/issuer/:issuer_key', async (req, res) => {
  try {
    const { issuer_key } = req.params
    
    const issuer = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuer || issuer.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    res.json(issuer[0])
  } catch (error) {
    console.error('Error fetching FD issuer:', error)
    res.status(500).json({ error: 'Failed to fetch FD issuer' })
  }
})

// Get schemes for an issuer (filter active by default)
router.get('/issuer/:issuer_key/schemes', async (req, res) => {
  try {
    const { issuer_key } = req.params
    const { active_only = 'true' } = req.query
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    let schemes = issuers[0].schemes || []
    
    if (active_only === 'true') {
      schemes = schemes.filter(s => s.is_active === true)
    }
    
    res.json(schemes)
  } catch (error) {
    console.error('Error fetching FD schemes:', error)
    res.status(500).json({ error: 'Failed to fetch FD schemes' })
  }
})

// Get single scheme with rate slabs
router.get('/issuer/:issuer_key/scheme/:scheme_id', async (req, res) => {
  try {
    const { issuer_key, scheme_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const scheme = issuers[0].schemes?.find(s => s.scheme_id === scheme_id)
    
    if (!scheme) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    res.json(scheme)
  } catch (error) {
    console.error('Error fetching FD scheme:', error)
    res.status(500).json({ error: 'Failed to fetch FD scheme' })
  }
})

// Get rate slabs for a scheme
router.get('/issuer/:issuer_key/scheme/:scheme_id/slabs', async (req, res) => {
  try {
    const { issuer_key, scheme_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const scheme = issuers[0].schemes?.find(s => s.scheme_id === scheme_id)
    
    if (!scheme) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const slabs = scheme.rate_slabs || []
    res.json(slabs)
  } catch (error) {
    console.error('Error fetching rate slabs:', error)
    res.status(500).json({ error: 'Failed to fetch rate slabs' })
  }
})

// Calculate FD interest rate
router.post('/calculate-rate', async (req, res) => {
  try {
    const { issuer_key, scheme_id, tenure_months, payout_frequency, senior_citizen, women, renewal } = req.body
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const scheme = issuer.schemes?.find(s => s.scheme_id === scheme_id)
    
    if (!scheme) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    // Find matching rate slab
    const slabs = scheme.rate_slabs || []
    const slab = slabs.find(s => 
      s.payout_frequency_type === payout_frequency &&
      s.tenure_min_months <= tenure_months &&
      s.tenure_max_months >= tenure_months &&
      s.is_active === true
    )
    
    if (!slab) {
      return res.status(404).json({ error: 'No matching rate slab found' })
    }
    
    const baseRate = slab.base_interest_rate_pa
    let totalRate = baseRate
    
    // Calculate bonuses
    const bonuses = {
      senior_citizen: senior_citizen ? scheme.senior_citizen_bonus_bps / 100 : 0,
      women: women ? scheme.women_bonus_bps / 100 : 0,
      renewal: renewal ? scheme.renewal_bonus_bps / 100 : 0
    }
    
    totalRate += bonuses.senior_citizen + bonuses.women + bonuses.renewal
    
    // Calculate effective yield for cumulative schemes
    let effective_yield_pa = null
    if (scheme.is_cumulative && slab.compounding_frequency && slab.effective_yield_pa) {
      effective_yield_pa = Math.round(slab.effective_yield_pa * 100) / 100
    } else if (scheme.is_cumulative && slab.compounding_frequency) {
      // Calculate effective yield based on compounding frequency
      const r = totalRate / 100
      const n = slab.compounding_frequency === 'Monthly' ? 12 :
                slab.compounding_frequency === 'Quarterly' ? 4 :
                slab.compounding_frequency === 'Half-Yearly' ? 2 : 1
      effective_yield_pa = Math.round(((Math.pow(1 + r / n, n) - 1) * 100) * 100) / 100
    }
    
    res.json({
      base_rate_pa: baseRate,
      total_rate_pa: totalRate,
      effective_yield_pa: effective_yield_pa,
      bonuses,
      slab: slab.slab_id,
      compounding_frequency: slab.compounding_frequency
    })
  } catch (error) {
    console.error('Error calculating rate:', error)
    res.status(500).json({ error: 'Failed to calculate rate' })
  }
})

// ===================================
// WRITE OPERATIONS (Admin only)
// ===================================

// Create issuer
router.post('/issuer', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const issuerData = req.body
    
    // Generate unique issuer key if not provided
    let issuer_key = issuerData._key
    if (!issuer_key) {
      // Create base key from short name
      const baseKey = issuerData.short_name.toLowerCase().replace(/\s+/g, '_')
      issuer_key = baseKey
      
      // Check if exists and generate unique key
      let counter = 1
      while (true) {
        const existing = await q(`
          FOR issuer IN fd_issuers
          FILTER issuer._key == @issuer_key
          RETURN issuer
        `, { issuer_key })
        
        if (!existing || existing.length === 0) {
          break // Key is available
        }
        
        // Key exists, try with suffix
        issuer_key = `${baseKey}_${counter}`
        counter++
        
        // Safety check to prevent infinite loop
        if (counter > 100) {
          return res.status(400).json({ error: 'Unable to generate unique issuer key' })
        }
      }
    } else {
      // Provided key, check if exists
      const existing = await q(`
        FOR issuer IN fd_issuers
        FILTER issuer._key == @issuer_key
        RETURN issuer
      `, { issuer_key })
      
      if (existing && existing.length > 0) {
        return res.status(400).json({ error: 'Issuer with this key already exists' })
      }
    }
    
    // Validate business rules
    const validationErrors = validateBusinessRules(issuerData)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const newIssuer = {
      _key: issuer_key,
      ...issuerData,
      is_active: issuerData.is_active !== undefined ? issuerData.is_active : true,
      schemes: issuerData.schemes || []
    }
    
    const collection = getCollection('fd_issuers')
    await collection.save(newIssuer)
    
    res.status(201).json(newIssuer)
  } catch (error) {
    console.error('Error creating issuer:', error)
    res.status(500).json({ error: 'Failed to create issuer' })
  }
})

// Update issuer (top-level fields only)
router.put('/issuer/:issuer_key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key } = req.params
    const updateData = req.body
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const updatedIssuer = {
      ...issuers[0],
      ...updateData,
      _key: issuer_key // Prevent key change
    }
    
    // Validate if schemes are being updated
    if (updateData.schemes) {
      const validationErrors = validateBusinessRules(updatedIssuer)
      if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: validationErrors })
      }
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(updatedIssuer)
  } catch (error) {
    console.error('Error updating issuer:', error)
    res.status(500).json({ error: 'Failed to update issuer' })
  }
})

// Delete issuer
router.delete('/issuer/:issuer_key', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key } = req.params
    
    const result = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      REMOVE issuer IN fd_issuers
      RETURN OLD
    `, { issuer_key })
    
    if (!result || result.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    res.json({ message: 'Issuer deleted successfully' })
  } catch (error) {
    console.error('Error deleting issuer:', error)
    res.status(500).json({ error: 'Failed to delete issuer' })
  }
})

// Add scheme to issuer
router.post('/issuer/:issuer_key/scheme', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key } = req.params
    const schemeData = req.body
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    
    // Check if scheme_id already exists
    if (issuer.schemes?.some(s => s.scheme_id === schemeData.scheme_id)) {
      return res.status(400).json({ error: 'Scheme with this ID already exists' })
    }
    
    const updatedIssuer = {
      ...issuer,
      schemes: [...(issuer.schemes || []), schemeData]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      console.error('FD Scheme validation errors:', validationErrors)
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(schemeData)
  } catch (error) {
    console.error('Error adding scheme:', error)
    res.status(500).json({ error: 'Failed to add scheme' })
  }
})

// Update scheme
router.put('/issuer/:issuer_key/scheme/:scheme_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, scheme_id } = req.params
    const updateData = req.body
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
    
    if (schemeIndex === -1 || schemeIndex === undefined) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const updatedScheme = { ...issuer.schemes[schemeIndex], ...updateData }
    const updatedIssuer = {
      ...issuer,
      schemes: [
        ...issuer.schemes.slice(0, schemeIndex),
        updatedScheme,
        ...issuer.schemes.slice(schemeIndex + 1)
      ]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(updatedScheme)
  } catch (error) {
    console.error('Error updating scheme:', error)
    res.status(500).json({ error: 'Failed to update scheme' })
  }
})

// Delete scheme from issuer
router.delete('/issuer/:issuer_key/scheme/:scheme_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, scheme_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
    
    if (schemeIndex === -1 || schemeIndex === undefined) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const updatedIssuer = {
      ...issuer,
      schemes: issuer.schemes.filter(s => s.scheme_id !== scheme_id)
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json({ message: 'Scheme deleted successfully' })
  } catch (error) {
    console.error('Error deleting scheme:', error)
    res.status(500).json({ error: 'Failed to delete scheme' })
  }
})

// Add rate slab to scheme
router.post('/issuer/:issuer_key/scheme/:scheme_id/slab', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, scheme_id } = req.params
    const slabData = req.body
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
    
    if (schemeIndex === -1 || schemeIndex === undefined) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const scheme = issuer.schemes[schemeIndex]
    
    // Check if slab_id already exists
    if (scheme.rate_slabs?.some(s => s.slab_id === slabData.slab_id)) {
      return res.status(400).json({ error: 'Rate slab with this ID already exists' })
    }
    
    // For non-cumulative schemes, set compounding_frequency and effective_yield_pa to null if not provided
    const processedSlabData = { ...slabData }
    if (!scheme.is_cumulative) {
      if (processedSlabData.compounding_frequency !== undefined) {
        processedSlabData.compounding_frequency = null
      }
      if (processedSlabData.effective_yield_pa !== undefined) {
        processedSlabData.effective_yield_pa = null
      }
    }
    
    const updatedScheme = {
      ...scheme,
      rate_slabs: [...(scheme.rate_slabs || []), processedSlabData]
    }
    
    const updatedIssuer = {
      ...issuer,
      schemes: [
        ...issuer.schemes.slice(0, schemeIndex),
        updatedScheme,
        ...issuer.schemes.slice(schemeIndex + 1)
      ]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(slabData)
  } catch (error) {
    console.error('Error adding rate slab:', error)
    res.status(500).json({ error: 'Failed to add rate slab' })
  }
})

// Update rate slab
router.put('/issuer/:issuer_key/scheme/:scheme_id/slab/:slab_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, scheme_id, slab_id } = req.params
    const updateData = req.body
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
    
    if (schemeIndex === -1 || schemeIndex === undefined) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const scheme = issuer.schemes[schemeIndex]
    const slabIndex = scheme.rate_slabs?.findIndex(s => s.slab_id === slab_id)
    
    if (slabIndex === -1 || slabIndex === undefined) {
      return res.status(404).json({ error: 'Rate slab not found' })
    }
    
    // For non-cumulative schemes, set compounding_frequency and effective_yield_pa to null if not provided
    const processedUpdateData = { ...updateData }
    if (!scheme.is_cumulative) {
      if (processedUpdateData.compounding_frequency !== undefined) {
        processedUpdateData.compounding_frequency = null
      }
      if (processedUpdateData.effective_yield_pa !== undefined) {
        processedUpdateData.effective_yield_pa = null
      }
    }
    
    const updatedSlab = { ...scheme.rate_slabs[slabIndex], ...processedUpdateData }
    const updatedScheme = {
      ...scheme,
      rate_slabs: [
        ...scheme.rate_slabs.slice(0, slabIndex),
        updatedSlab,
        ...scheme.rate_slabs.slice(slabIndex + 1)
      ]
    }
    
    const updatedIssuer = {
      ...issuer,
      schemes: [
        ...issuer.schemes.slice(0, schemeIndex),
        updatedScheme,
        ...issuer.schemes.slice(schemeIndex + 1)
      ]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      console.error('Validation errors when updating rate slab:', validationErrors)
      console.error('Updated slab data:', updatedSlab)
      console.error('Scheme data:', updatedScheme)
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(updatedSlab)
  } catch (error) {
    console.error('Error updating rate slab:', error)
    res.status(500).json({ error: 'Failed to update rate slab' })
  }
})

// Delete rate slab
router.delete('/issuer/:issuer_key/scheme/:scheme_id/slab/:slab_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, scheme_id, slab_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
    
    if (schemeIndex === -1 || schemeIndex === undefined) {
      return res.status(404).json({ error: 'Scheme not found' })
    }
    
    const scheme = issuer.schemes[schemeIndex]
    const updatedScheme = {
      ...scheme,
      rate_slabs: scheme.rate_slabs?.filter(s => s.slab_id !== slab_id) || []
    }
    
    const updatedIssuer = {
      ...issuer,
      schemes: [
        ...issuer.schemes.slice(0, schemeIndex),
        updatedScheme,
        ...issuer.schemes.slice(schemeIndex + 1)
      ]
    }
    
    const collection = getCollection('fd_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json({ message: 'Rate slab deleted successfully' })
  } catch (error) {
    console.error('Error deleting rate slab:', error)
    res.status(500).json({ error: 'Failed to delete rate slab' })
  }
})

// ===================================
// EXCEL IMPORT/EXPORT (Admin only)
// ===================================

// Export FD schemes to Excel
router.get('/export/excel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key } = req.query // Optional: filter by issuer
    
    // Fetch issuers
    let issuers = []
    if (issuer_key) {
      const result = await q(`
        FOR issuer IN fd_issuers
        FILTER issuer._key == @issuer_key
        RETURN issuer
      `, { issuer_key })
      issuers = result || []
    } else {
      issuers = await q(`FOR issuer IN fd_issuers RETURN issuer`)
    }
    
    // Flatten schemes for export (one row per scheme)
    const flattenedSchemes = []
    issuers.forEach(issuer => {
      if (issuer.schemes && Array.isArray(issuer.schemes)) {
        issuer.schemes.forEach(scheme => {
          flattenedSchemes.push({
            issuer_key: issuer._key,
            issuer_legal_name: issuer.legal_name || '',
            issuer_short_name: issuer.short_name || '',
            scheme_id: scheme.scheme_id || '',
            scheme_name: scheme.scheme_name || '',
            description_short: scheme.description_short || '',
            is_cumulative: scheme.is_cumulative ? 'Yes' : 'No',
            payout_frequency_type: Array.isArray(scheme.payout_frequency_type) ? scheme.payout_frequency_type.join(', ') : '',
            lock_in_months: scheme.lock_in_months || 0,
            premature_allowed: scheme.premature_allowed ? 'Yes' : 'No',
            premature_terms: scheme.premature_terms || '',
            min_tenure_months: scheme.min_tenure_months || 0,
            max_tenure_months: scheme.max_tenure_months || 0,
            min_amount: scheme.min_amount || '',
            max_amount: scheme.max_amount || '',
            senior_citizen_bonus_bps: scheme.senior_citizen_bonus_bps || 0,
            women_bonus_bps: scheme.women_bonus_bps || 0,
            renewal_bonus_bps: scheme.renewal_bonus_bps || 0,
            tds_applicable: scheme.tds_applicable ? 'Yes' : 'No',
            show_form15g15h_option: scheme.show_form15g15h_option ? 'Yes' : 'No',
            is_active: scheme.is_active !== false ? 'Yes' : 'No',
            cc: scheme.cc || 0,
            si: scheme.si || 0
          })
        })
      }
    })
    
    // Create workbook
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('FD Schemes')
    
    // Define columns with protection
    worksheet.columns = [
      { header: 'Issuer Key', key: 'issuer_key', width: 20, protection: { locked: true } },
      { header: 'Issuer Legal Name', key: 'issuer_legal_name', width: 30, protection: { locked: true } },
      { header: 'Issuer Short Name', key: 'issuer_short_name', width: 25, protection: { locked: true } },
      { header: 'Scheme ID', key: 'scheme_id', width: 25, protection: { locked: true } },
      { header: 'Scheme Name', key: 'scheme_name', width: 40, protection: { locked: true } },
      { header: 'Description', key: 'description_short', width: 40, protection: { locked: false } },
      { header: 'Is Cumulative', key: 'is_cumulative', width: 15, protection: { locked: true } },
      { header: 'Payout Frequency', key: 'payout_frequency_type', width: 30, protection: { locked: false } },
      { header: 'Lock In (months)', key: 'lock_in_months', width: 15, protection: { locked: false } },
      { header: 'Premature Allowed', key: 'premature_allowed', width: 18, protection: { locked: false } },
      { header: 'Premature Terms', key: 'premature_terms', width: 40, protection: { locked: false } },
      { header: 'Min Tenure (months)', key: 'min_tenure_months', width: 18, protection: { locked: false } },
      { header: 'Max Tenure (months)', key: 'max_tenure_months', width: 18, protection: { locked: false } },
      { header: 'Min Amount', key: 'min_amount', width: 15, protection: { locked: false } },
      { header: 'Max Amount', key: 'max_amount', width: 15, protection: { locked: false } },
      { header: 'Senior Citizen Bonus (bps)', key: 'senior_citizen_bonus_bps', width: 22, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'Women Bonus (bps)', key: 'women_bonus_bps', width: 18, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'Renewal Bonus (bps)', key: 'renewal_bonus_bps', width: 18, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'TDS Applicable', key: 'tds_applicable', width: 15, protection: { locked: false } },
      { header: 'Form 15G/15H Option', key: 'show_form15g15h_option', width: 20, protection: { locked: false } },
      { header: 'Is Active', key: 'is_active', width: 12, protection: { locked: false } },
      { header: 'CC %', key: 'cc', width: 12, protection: { locked: false }, style: { numFmt: '0.00000' } },
      { header: 'SI %', key: 'si', width: 12, protection: { locked: false }, style: { numFmt: '0.00000' } }
    ]
    
    // Style header row
    worksheet.getRow(1).font = { bold: true, size: 12 }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    }
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' }
    
    // Add data rows
    flattenedSchemes.forEach((scheme, index) => {
      const row = worksheet.addRow(scheme)
      
      // Explicitly set protection for each cell
      // Locked cells (protected)
      for (let col = 1; col <= 5; col++) {
        row.getCell(col).protection = { locked: true }
        row.getCell(col).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF5F5F5' }
        }
      }
      row.getCell(7).protection = { locked: true } // is_cumulative
      row.getCell(7).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF5F5F5' }
      }
      
      // Unlocked cells (editable) - explicitly set to ensure they're editable
      row.getCell(6).protection = { locked: false } // description_short
      row.getCell(8).protection = { locked: false } // payout_frequency_type
      row.getCell(9).protection = { locked: false } // lock_in_months
      row.getCell(10).protection = { locked: false } // premature_allowed
      row.getCell(11).protection = { locked: false } // premature_terms
      row.getCell(12).protection = { locked: false } // min_tenure_months
      row.getCell(13).protection = { locked: false } // max_tenure_months
      row.getCell(14).protection = { locked: false } // min_amount
      row.getCell(15).protection = { locked: false } // max_amount
      row.getCell(16).protection = { locked: false } // senior_citizen_bonus_bps
      row.getCell(17).protection = { locked: false } // women_bonus_bps
      row.getCell(18).protection = { locked: false } // renewal_bonus_bps
      row.getCell(19).protection = { locked: false } // tds_applicable
      row.getCell(20).protection = { locked: false } // show_form15g15h_option
      row.getCell(21).protection = { locked: false } // is_active
      row.getCell(22).protection = { locked: false } // cc
      row.getCell(22).numFmt = '0.00000' // CC with 5 decimal places
      row.getCell(23).protection = { locked: false } // si
      row.getCell(23).numFmt = '0.00000' // SI with 5 decimal places
    })
    
    // Protect worksheet but allow editing unlocked cells
    worksheet.protect('', {
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatCells: true, // Allow formatting
      formatColumns: false,
      formatRows: false,
      insertColumns: false,
      insertRows: false,
      insertHyperlinks: false,
      deleteColumns: false,
      deleteRows: false,
      sort: true,
      autoFilter: true,
      pivotTables: false
    })
    
    // Freeze header row
    worksheet.views = [
      { state: 'frozen', ySplit: 1 }
    ]
    
    // Set response headers
    const filename = `fd-schemes-export-${issuer_key || 'all'}-${new Date().toISOString().split('T')[0]}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    
    await workbook.xlsx.write(res)
    res.end()
  } catch (error) {
    console.error('Error exporting FD schemes to Excel:', error)
    res.status(500).json({ error: 'Failed to export FD schemes', detail: error.message })
  }
})

// Import FD schemes from Excel
router.post('/import/excel', requireAuth, requireRole('admin'), uploadExcel, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required' })
    }
    
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(req.file.path)
    
    const worksheet = workbook.getWorksheet(1)
    if (!worksheet) {
      const fs = await import('fs')
      fs.unlinkSync(req.file.path)
      return res.status(400).json({ error: 'Excel file is empty or invalid' })
    }
    
    const updates = []
    const errors = []
    let rowNumber = 0
    
    // Process each row (skip header)
    worksheet.eachRow((row, rowNum) => {
      rowNumber = rowNum
      if (rowNum === 1) return
      
      try {
        const issuer_key = row.getCell(1).value?.toString()?.trim()
        const scheme_id = row.getCell(4).value?.toString()?.trim()
        
        if (!issuer_key || !scheme_id) {
          errors.push({ row: rowNum, error: 'Missing issuer_key or scheme_id' })
          return
        }
        
        // Extract updatable fields
        const description_short = row.getCell(6).value?.toString()?.trim()
        const payout_frequency_type = row.getCell(8).value?.toString()?.trim()
        const lock_in_months = parseInt(row.getCell(9).value) || 0
        const premature_allowed = row.getCell(10).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const premature_terms = row.getCell(11).value?.toString()?.trim()
        const min_tenure_months = parseInt(row.getCell(12).value) || 0
        const max_tenure_months = parseInt(row.getCell(13).value) || 0
        const min_amount = row.getCell(14).value ? parseFloat(row.getCell(14).value) : null
        const max_amount = row.getCell(15).value ? parseFloat(row.getCell(15).value) : null
        const senior_citizen_bonus_bps = parseInt(row.getCell(16).value) || 0
        const women_bonus_bps = parseInt(row.getCell(17).value) || 0
        const renewal_bonus_bps = parseInt(row.getCell(18).value) || 0
        const tds_applicable = row.getCell(19).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const show_form15g15h_option = row.getCell(20).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const is_active = row.getCell(21).value?.toString()?.toLowerCase()?.trim() === 'yes'
        
        let cc = 0
        const ccValue = row.getCell(22).value
        if (typeof ccValue === 'number') {
          cc = ccValue
        } else if (typeof ccValue === 'string') {
          cc = parseFloat(ccValue) || 0
        }
        
        let si = 0
        const siValue = row.getCell(23).value
        if (typeof siValue === 'number') {
          si = siValue
        } else if (typeof siValue === 'string') {
          si = parseFloat(siValue) || 0
        }
        
        // Build update object
        const updateData = {}
        
        if (description_short !== undefined && description_short !== '') {
          updateData.description_short = description_short
        }
        if (payout_frequency_type !== undefined && payout_frequency_type !== '') {
          updateData.payout_frequency_type = payout_frequency_type.split(',').map(f => f.trim()).filter(f => f)
        }
        if (lock_in_months !== undefined) updateData.lock_in_months = lock_in_months
        if (premature_allowed !== undefined) updateData.premature_allowed = premature_allowed
        if (premature_terms !== undefined) updateData.premature_terms = premature_terms || ''
        if (min_tenure_months !== undefined) updateData.min_tenure_months = min_tenure_months
        if (max_tenure_months !== undefined) updateData.max_tenure_months = max_tenure_months
        if (min_amount !== undefined && min_amount !== null) updateData.min_amount = min_amount
        if (max_amount !== undefined && max_amount !== null) updateData.max_amount = max_amount
        if (senior_citizen_bonus_bps !== undefined) updateData.senior_citizen_bonus_bps = senior_citizen_bonus_bps
        if (women_bonus_bps !== undefined) updateData.women_bonus_bps = women_bonus_bps
        if (renewal_bonus_bps !== undefined) updateData.renewal_bonus_bps = renewal_bonus_bps
        if (tds_applicable !== undefined) updateData.tds_applicable = tds_applicable
        if (show_form15g15h_option !== undefined) updateData.show_form15g15h_option = show_form15g15h_option
        if (is_active !== undefined) updateData.is_active = is_active
        if (cc !== undefined) updateData.cc = cc
        if (si !== undefined) updateData.si = si
        
        updates.push({ issuer_key, scheme_id, updateData, row: rowNum })
      } catch (err) {
        errors.push({ row: rowNum, error: `Parsing error: ${err.message}` })
      }
    })
    
    // Batch update schemes
    let updated = 0
    let failed = 0
    
    for (const { issuer_key, scheme_id, updateData, row } of updates) {
      try {
        // Get issuer
        const issuers = await q(`
          FOR issuer IN fd_issuers
          FILTER issuer._key == @issuer_key
          RETURN issuer
        `, { issuer_key })
        
        if (issuers.length === 0) {
          errors.push({ row, issuer_key, scheme_id, error: 'Issuer not found' })
          failed++
          continue
        }
        
        const issuer = issuers[0]
        const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
        
        if (schemeIndex === -1 || schemeIndex === undefined) {
          errors.push({ row, issuer_key, scheme_id, error: 'Scheme not found' })
          failed++
          continue
        }
        
        // Update scheme
        const updatedSchemes = [...issuer.schemes]
        updatedSchemes[schemeIndex] = {
          ...updatedSchemes[schemeIndex],
          ...updateData
        }
        
        // Save updated issuer
        const collection = getCollection('fd_issuers')
        await collection.update(issuer_key, {
          schemes: updatedSchemes,
          updated_at: new Date().toISOString()
        })
        
        updated++
      } catch (err) {
        errors.push({ row, issuer_key, scheme_id, error: err.message })
        failed++
      }
    }
    
    // Cleanup uploaded file
    const fs = await import('fs')
    try {
      fs.unlinkSync(req.file.path)
    } catch (unlinkErr) {
      console.error('Error deleting uploaded file:', unlinkErr)
    }
    
    res.json({
      total: updates.length,
      updated,
      failed,
      errors: errors.slice(0, 100)
    })
  } catch (error) {
    console.error('Error importing FD schemes from Excel:', error)
    
    // Cleanup uploaded file on error
    if (req.file) {
      try {
        const fs = await import('fs')
        fs.unlinkSync(req.file.path)
      } catch (unlinkErr) {
        console.error('Error deleting uploaded file:', unlinkErr)
      }
    }
    
    res.status(500).json({ error: 'Failed to import FD schemes', detail: error.message })
  }
})

export default router