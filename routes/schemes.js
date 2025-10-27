import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = express.Router()

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

// Create Scheme
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
    
    const schemesCollection = getCollection('mf_schemes')
    const result = await schemesCollection.save({
      scheme_code,
      scheme_name,
      amc_code,
      amc_name,
      category,
      sub_category,
      plan,
      type,
      nav_latest: nav_latest || 0,
      nav_date: nav_date || null,
      is_nfo: is_nfo || false,
      nfo_validity: is_nfo ? nfo_validity : null,
      created_at: new Date().toISOString()
    })
    
    res.status(201).json({ id: result._key, message: 'Scheme created successfully' })
  } catch (error) {
    console.error('Error creating scheme:', error)
    res.status(500).json({ error: 'Failed to create scheme' })
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
      category,
      sub_category,
      plan,
      type,
      nav_latest,
      nav_date,
      is_nfo,
      nfo_validity
    } = req.body
    
    // Build update object with only provided fields
    const updateData = {
      updated_at: new Date().toISOString()
    }
    
    if (scheme_name !== undefined) updateData.scheme_name = scheme_name
    if (category !== undefined) updateData.category = category
    if (sub_category !== undefined) updateData.sub_category = sub_category
    if (plan !== undefined) updateData.plan = plan
    if (type !== undefined) updateData.type = type
    if (nav_latest !== undefined) updateData.nav_latest = nav_latest
    if (nav_date !== undefined) updateData.nav_date = nav_date
    if (is_nfo !== undefined) updateData.is_nfo = is_nfo
    if (nfo_validity !== undefined) updateData.nfo_validity = is_nfo ? nfo_validity : null
    
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

// Check and expire NFOs
router.post('/check-nfo-validity', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0]
    
    const expiredSchemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.is_nfo == true
      FILTER scheme.nfo_validity < @today
      UPDATE scheme WITH { is_nfo: false, nfo_validity: null } IN mf_schemes
      RETURN scheme.scheme_name
    `, { today })
    
    res.json({ 
      message: 'NFO validity check completed',
      expired_count: expiredSchemes.length,
      expired_schemes: expiredSchemes
    })
  } catch (error) {
    console.error('Error checking NFO validity:', error)
    res.status(500).json({ error: 'Failed to check NFO validity' })
  }
})

export default router

