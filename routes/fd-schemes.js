import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

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
    
    res.json({
      base_rate_pa: baseRate,
      total_rate_pa: totalRate,
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
    
    // Generate issuer key if not provided
    const issuer_key = issuerData._key || issuerData.short_name.toLowerCase().replace(/\s+/g, '_')
    
    // Check if exists
    const existing = await q(`
      FOR issuer IN fd_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: 'Issuer with this key already exists' })
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
    
    const updatedScheme = {
      ...scheme,
      rate_slabs: [...(scheme.rate_slabs || []), slabData]
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
    
    const updatedSlab = { ...scheme.rate_slabs[slabIndex], ...updateData }
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

export default router