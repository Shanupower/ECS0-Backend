import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import dbDefault from '../config/database.js'

const router = express.Router()

// Helper function to ensure collection exists
async function ensureCollectionExists() {
  try {
    const collection = getCollection('misc_services_schemes')
    await collection.get() // Try to get collection info
  } catch (error) {
    if (error.errorNum === 1203) { // Collection not found
      // Create the collection
      const collection = dbDefault.collection('misc_services_schemes')
      await collection.create({ keyOptions: { type: 'traditional' } })
      console.log('Created misc_services_schemes collection')
    } else {
      throw error
    }
  }
}

// ===================================
// HELPER FUNCTIONS
// ===================================

function validatePriceRanges(priceRanges) {
  const errors = []
  
  if (!Array.isArray(priceRanges) || priceRanges.length === 0) {
    errors.push('At least one price range is required')
    return errors
  }
  
  priceRanges.forEach((range, idx) => {
    const minPrice = parseFloat(range.min_price)
    const maxPrice = parseFloat(range.max_price)
    const cc = parseFloat(range.cc)
    const si = parseFloat(range.si)
    
    // Validate min_price <= max_price
    if (isNaN(minPrice) || isNaN(maxPrice) || minPrice > maxPrice) {
      errors.push(`Range ${idx + 1}: min_price must be <= max_price`)
    }
    
    // Validate CC and SI are non-negative numbers
    if (isNaN(cc) || cc < 0) {
      errors.push(`Range ${idx + 1}: CC must be a non-negative number`)
    }
    if (isNaN(si) || si < 0) {
      errors.push(`Range ${idx + 1}: SI must be a non-negative number`)
    }
    
    // Check for overlapping ranges (optional - can be allowed)
    // For now, we'll allow overlapping ranges and use the first match
  })
  
  return errors
}

// ===================================
// READ OPERATIONS (Everyone can access)
// ===================================

// Get current misc services scheme
router.get('/', async (req, res) => {
  try {
    await ensureCollectionExists()
    const schemes = await q(`
      FOR scheme IN misc_services_schemes
      LIMIT 1
      RETURN scheme
    `)
    
    if (schemes.length === 0) {
      // Return default empty scheme if none exists
      return res.json({
        _key: 'misc_services',
        scheme_name: 'Misc Services',
        price_ranges: [],
        is_active: true,
        updated_at: null
      })
    }
    
    res.json(schemes[0])
  } catch (error) {
    console.error('Error fetching misc services scheme:', error)
    res.status(500).json({ error: 'Failed to fetch misc services scheme' })
  }
})

// Calculate CC/SI for a given price
router.post('/calculate-cc-si', async (req, res) => {
  try {
    const { price } = req.body
    
    if (price === undefined || price === null) {
      return res.status(400).json({ error: 'Price is required' })
    }
    
    const priceValue = parseFloat(price)
    if (isNaN(priceValue) || priceValue < 0) {
      return res.status(400).json({ error: 'Price must be a non-negative number' })
    }
    
    // Ensure collection exists
    await ensureCollectionExists()
    
    // Get the scheme
    const schemes = await q(`
      FOR scheme IN misc_services_schemes
      FILTER scheme.is_active == true
      LIMIT 1
      RETURN scheme
    `)
    
    if (schemes.length === 0 || !schemes[0].price_ranges || schemes[0].price_ranges.length === 0) {
      // No scheme or no ranges - return 0 for both
      return res.json({
        price: priceValue,
        cc: 0,
        si: 0,
        cc_percent: 0,
        si_percent: 0,
        matched_range: null
      })
    }
    
    const scheme = schemes[0]
    
    // Find matching price range (first match where min_price <= price <= max_price)
    const matchingRange = scheme.price_ranges.find(range => {
      const minPrice = parseFloat(range.min_price)
      const maxPrice = parseFloat(range.max_price)
      return priceValue >= minPrice && priceValue <= maxPrice
    })
    
    if (!matchingRange) {
      // No matching range - return 0 for both
      return res.json({
        price: priceValue,
        cc: 0,
        si: 0,
        cc_percent: 0,
        si_percent: 0,
        matched_range: null
      })
    }
    
    // Calculate CC and SI
    const ccPercent = parseFloat(matchingRange.cc || 0)
    const siPercent = parseFloat(matchingRange.si || 0)
    const cc = Math.round(((ccPercent / 100) * priceValue) * 100) / 100
    const si = Math.round(((siPercent / 100) * priceValue) * 100) / 100
    
    res.json({
      price: priceValue,
      cc,
      si,
      cc_percent: ccPercent,
      si_percent: siPercent,
      matched_range: {
        min_price: matchingRange.min_price,
        max_price: matchingRange.max_price
      }
    })
  } catch (error) {
    console.error('Error calculating CC/SI:', error)
    res.status(500).json({ error: 'Failed to calculate CC/SI' })
  }
})

// ===================================
// WRITE OPERATIONS (Admin only)
// ===================================

// Create or update misc services scheme
router.put('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { scheme_name, price_ranges, is_active } = req.body
    
    // Validate price ranges
    const validationErrors = validatePriceRanges(price_ranges)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    // Ensure collection exists
    await ensureCollectionExists()
    
    // Check if scheme exists
    const existing = await q(`
      FOR scheme IN misc_services_schemes
      LIMIT 1
      RETURN scheme
    `)
    
    const schemeData = {
      _key: 'misc_services',
      scheme_name: scheme_name || 'Misc Services',
      price_ranges: price_ranges || [],
      is_active: is_active !== undefined ? is_active : true,
      updated_at: new Date().toISOString()
    }
    
    const collection = getCollection('misc_services_schemes')
    
    if (existing.length === 0) {
      // Create new scheme
      await collection.save(schemeData)
      res.status(201).json(schemeData)
    } else {
      // Update existing scheme
      await collection.update('misc_services', schemeData)
      res.json(schemeData)
    }
  } catch (error) {
    console.error('Error saving misc services scheme:', error)
    res.status(500).json({ error: 'Failed to save misc services scheme' })
  }
})

export default router
