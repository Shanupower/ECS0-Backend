import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadExcel, uploadsDir } from '../middleware/upload.js'
import ExcelJS from 'exceljs'
import {
  buildExportMeta,
  insertExportHeaderRows,
  styleWorksheetTableHeaderRow
} from '../services/reports/report-export.js'

const router = express.Router()

// ===================================
// HELPER FUNCTIONS
// ===================================

function normalizeTenureUnit(u) {
  const v = String(u || '').trim().toLowerCase()
  if (v === 'day' || v === 'days') return 'days'
  return 'months'
}

/** Per-slab optional BPS override; falls back to scheme-level values. */
const SLAB_BONUS_BPS_KEYS = ['senior_citizen_bonus_bps', 'women_bonus_bps', 'renewal_bonus_bps']

function effectiveBonusBps(slab, scheme, fieldName) {
  const fromSlab = slab?.[fieldName]
  if (Number.isFinite(fromSlab)) return fromSlab
  const fromScheme = scheme?.[fieldName]
  return Number.isFinite(fromScheme) ? fromScheme : 0
}

/** Excel cell → optional non-negative integer bps; undefined means omit from import patch. */
function parseOptionalSlabBonusCell(cell) {
  const v = cell?.value
  if (v === null || v === undefined || v === '') return undefined
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  const n = parseInt(String(v).trim(), 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

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
          const unit = normalizeTenureUnit(slab.tenure_unit)

          // Slab tenure validation (unit-aware; months is default)
          if (unit === 'days') {
            const min = slab.tenure_min_days
            const max = slab.tenure_max_days
            if (min == null || max == null) {
              errors.push(`Scheme ${idx + 1}, Slab ${slabIdx + 1}: tenure_min_days and tenure_max_days are required when tenure_unit is days`)
            } else if (min > max) {
              errors.push(`Scheme ${idx + 1}, Slab ${slabIdx + 1}: tenure_min_days must be <= tenure_max_days`)
            }
          } else {
            const min = slab.tenure_min_months
            const max = slab.tenure_max_months
            if (min == null || max == null) {
              errors.push(`Scheme ${idx + 1}, Slab ${slabIdx + 1}: tenure_min_months and tenure_max_months are required when tenure_unit is months`)
            } else if (min > max) {
              errors.push(`Scheme ${idx + 1}, Slab ${slabIdx + 1}: tenure_min_months must be <= tenure_max_months`)
            }
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
    const {
      issuer_key,
      scheme_id,
      tenure_months,
      tenure_unit,
      tenure_value,
      payout_frequency,
      senior_citizen,
      women,
      renewal
    } = req.body

    const normalizedUnit = normalizeTenureUnit(tenure_unit)
    // Backward compatibility: if only tenure_months is sent, treat as months.
    const resolvedUnit = tenure_value != null ? normalizedUnit : 'months'
    const resolvedValue = tenure_value != null ? Number(tenure_value) : Number(tenure_months)
    if (!Number.isFinite(resolvedValue) || resolvedValue <= 0) {
      return res.status(400).json({ error: 'Invalid tenure value' })
    }
    
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
    
    const normFreq = (x) => String(x ?? '').trim()
    const payoutMatches = (slabFreq, reqFreq) => {
      const a = normFreq(slabFreq)
      const b = normFreq(reqFreq)
      if (!a || !b) return false
      return a === b || a.toLowerCase() === b.toLowerCase()
    }

    // Find matching rate slab (is_active: treat missing as active, same as frontend)
    const slabs = scheme.rate_slabs || []
    const slab = slabs.find(s => {
      if (s.is_active === false) return false
      if (!payoutMatches(s.payout_frequency_type, payout_frequency)) return false
      const slabUnit = normalizeTenureUnit(s.tenure_unit)
      if (slabUnit !== resolvedUnit) return false
      if (resolvedUnit === 'days') {
        const min = Number(s.tenure_min_days)
        const max = Number(s.tenure_max_days)
        if (!Number.isFinite(min) || !Number.isFinite(max)) return false
        return min <= resolvedValue && max >= resolvedValue
      }
      const min = Number(s.tenure_min_months)
      const max = Number(s.tenure_max_months)
      if (!Number.isFinite(min) || !Number.isFinite(max)) return false
      return min <= resolvedValue && max >= resolvedValue
    })
    
    if (!slab) {
      return res.status(404).json({ error: 'No matching rate slab found' })
    }
    
    const baseRate = slab.base_interest_rate_pa
    let totalRate = baseRate

    const seniorBps = effectiveBonusBps(slab, scheme, 'senior_citizen_bonus_bps')
    const womenBps = effectiveBonusBps(slab, scheme, 'women_bonus_bps')
    const renewalBps = effectiveBonusBps(slab, scheme, 'renewal_bonus_bps')

    // Calculate bonuses (% points from bps)
    const bonuses = {
      senior_citizen: senior_citizen ? seniorBps / 100 : 0,
      women: women ? womenBps / 100 : 0,
      renewal: renewal ? renewalBps / 100 : 0
    }

    const bonuses_bps = {
      senior_citizen: seniorBps,
      women: womenBps,
      renewal: renewalBps
    }

    const bonus_bps_source = {
      senior_citizen: Number.isFinite(slab?.senior_citizen_bonus_bps) ? 'slab' : 'scheme',
      women: Number.isFinite(slab?.women_bonus_bps) ? 'slab' : 'scheme',
      renewal: Number.isFinite(slab?.renewal_bonus_bps) ? 'slab' : 'scheme'
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
      bonuses_bps,
      bonus_bps_source,
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

    for (const k of SLAB_BONUS_BPS_KEYS) {
      const v = processedSlabData[k]
      if (v === null || v === undefined || v === '') {
        delete processedSlabData[k]
      } else {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 0) processedSlabData[k] = Math.round(n)
        else delete processedSlabData[k]
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
    
    res.json(processedSlabData)
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

    for (const k of SLAB_BONUS_BPS_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(processedUpdateData, k)) continue
      const v = processedUpdateData[k]
      if (v === null || v === '') {
        delete processedUpdateData[k]
      } else {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 0) processedUpdateData[k] = Math.round(n)
        else delete processedUpdateData[k]
      }
    }

    const updatedSlab = { ...scheme.rate_slabs[slabIndex], ...processedUpdateData }
    for (const k of SLAB_BONUS_BPS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(updateData, k) && (updateData[k] === null || updateData[k] === '')) {
        delete updatedSlab[k]
      }
    }
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
    
    // Flatten rate slabs for export (one row per slab; CC/SI are at slab level)
    const flattenedSlabs = []
    issuers.forEach(issuer => {
      if (issuer.schemes && Array.isArray(issuer.schemes)) {
        issuer.schemes.forEach(scheme => {
          const slabs = scheme.rate_slabs || []
          slabs.forEach(slab => {
            const unit = normalizeTenureUnit(slab.tenure_unit)
            flattenedSlabs.push({
              issuer_key: issuer._key,
              issuer_legal_name: issuer.legal_name || '',
              issuer_short_name: issuer.short_name || '',
              scheme_id: scheme.scheme_id || '',
              scheme_name: scheme.scheme_name || '',
              slab_id: slab.slab_id || '',
              tenure_unit: unit,
              tenure_min_months: unit === 'months' ? (slab.tenure_min_months ?? '') : '',
              tenure_max_months: unit === 'months' ? (slab.tenure_max_months ?? '') : '',
              tenure_min_days: unit === 'days' ? (slab.tenure_min_days ?? '') : '',
              tenure_max_days: unit === 'days' ? (slab.tenure_max_days ?? '') : '',
              payout_frequency_type: slab.payout_frequency_type || '',
              base_interest_rate_pa: slab.base_interest_rate_pa ?? '',
              compounding_frequency: slab.compounding_frequency || '',
              effective_yield_pa: slab.effective_yield_pa ?? '',
              notes_public_display: slab.notes_public_display || '',
              is_active: slab.is_active !== false ? 'Yes' : 'No',
              cc: slab.cc ?? 0,
              si: slab.si ?? 0,
              senior_citizen_bonus_bps: slab.senior_citizen_bonus_bps ?? '',
              women_bonus_bps: slab.women_bonus_bps ?? '',
              renewal_bonus_bps: slab.renewal_bonus_bps ?? ''
            })
          })
        })
      }
    })
    
    // Create workbook
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('FD Rate Slabs')
    
    // Define columns (one row per rate slab; CC/SI at slab level)
    worksheet.columns = [
      { header: 'Issuer Key', key: 'issuer_key', width: 20, protection: { locked: true } },
      { header: 'Issuer Legal Name', key: 'issuer_legal_name', width: 30, protection: { locked: true } },
      { header: 'Issuer Short Name', key: 'issuer_short_name', width: 25, protection: { locked: true } },
      { header: 'Scheme ID', key: 'scheme_id', width: 25, protection: { locked: true } },
      { header: 'Scheme Name', key: 'scheme_name', width: 40, protection: { locked: true } },
      { header: 'Slab ID', key: 'slab_id', width: 20, protection: { locked: true } },
      { header: 'Tenure Unit', key: 'tenure_unit', width: 12, protection: { locked: false } },
      { header: 'Tenure Min (months)', key: 'tenure_min_months', width: 18, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'Tenure Max (months)', key: 'tenure_max_months', width: 18, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'Tenure Min (days)', key: 'tenure_min_days', width: 16, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'Tenure Max (days)', key: 'tenure_max_days', width: 16, protection: { locked: false }, style: { numFmt: '0' } },
      { header: 'Payout Frequency', key: 'payout_frequency_type', width: 22, protection: { locked: false } },
      { header: 'Base Interest Rate (% p.a.)', key: 'base_interest_rate_pa', width: 22, protection: { locked: false }, style: { numFmt: '0.00' } },
      { header: 'Compounding Frequency', key: 'compounding_frequency', width: 22, protection: { locked: false } },
      { header: 'Effective Yield (% p.a.)', key: 'effective_yield_pa', width: 20, protection: { locked: false }, style: { numFmt: '0.00' } },
      { header: 'Notes (public)', key: 'notes_public_display', width: 35, protection: { locked: false } },
      { header: 'Is Active', key: 'is_active', width: 12, protection: { locked: false } },
      { header: 'CC %', key: 'cc', width: 12, protection: { locked: false }, style: { numFmt: '0.00000' } },
      { header: 'SI %', key: 'si', width: 12, protection: { locked: false }, style: { numFmt: '0.00000' } },
      { header: 'Senior bonus BPS (slab override)', key: 'senior_citizen_bonus_bps', width: 32, protection: { locked: false } },
      { header: 'Women bonus BPS (slab override)', key: 'women_bonus_bps', width: 32, protection: { locked: false } },
      { header: 'Renewal bonus BPS (slab override)', key: 'renewal_bonus_bps', width: 32, protection: { locked: false } }
    ]
    
    styleWorksheetTableHeaderRow(worksheet, 1)
    
    // Add data rows
    flattenedSlabs.forEach((slabRow) => {
      const row = worksheet.addRow(slabRow)
      for (let col = 1; col <= 6; col++) {
        row.getCell(col).protection = { locked: true }
        row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } }
      }
      for (let col = 7; col <= 22; col++) {
        row.getCell(col).protection = { locked: false }
      }
      row.getCell(18).numFmt = '0.00000'
      row.getCell(19).numFmt = '0.00000'
    })
    
    const exportMeta = buildExportMeta({ reportTitle: 'FD Schemes Export' })
    const inserted = insertExportHeaderRows(worksheet, exportMeta)
    if (inserted) {
      styleWorksheetTableHeaderRow(worksheet, inserted + 1)
    }

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
    
    // Freeze table header row
    worksheet.views = [
      { state: 'frozen', ySplit: (inserted || 0) + 1 }
    ]
    
    // Set response headers
    const filename = `fd-rate-slabs-export-${issuer_key || 'all'}-${new Date().toISOString().split('T')[0]}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    
    await workbook.xlsx.write(res)
    res.end()
  } catch (error) {
    console.error('Error exporting FD schemes to Excel:', error)
    res.status(500).json({ error: 'Failed to export FD schemes', detail: error.message })
  }
})

// Import FD rate slabs from Excel (one row per slab; updates slab-level CC/SI and slab fields)
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
    
    // Columns:
    // 1=issuer_key, 2=issuer_legal_name, 3=issuer_short_name, 4=scheme_id, 5=scheme_name, 6=slab_id,
    // 7=tenure_unit, 8=tenure_min_months, 9=tenure_max_months, 10=tenure_min_days, 11=tenure_max_days,
    // 12=payout_frequency_type, 13=base_interest_rate_pa, 14=compounding_frequency, 15=effective_yield_pa,
    // 16=notes_public_display, 17=is_active, 18=cc, 19=si,
    // 20=senior_citizen_bonus_bps, 21=women_bonus_bps, 22=renewal_bonus_bps (optional slab overrides)
    worksheet.eachRow((row, rowNum) => {
      rowNumber = rowNum
      if (rowNum === 1) return
      
      try {
        const issuer_key = row.getCell(1).value?.toString()?.trim()
        const scheme_id = row.getCell(4).value?.toString()?.trim()
        const slab_id = row.getCell(6).value?.toString()?.trim()
        
        if (!issuer_key || !scheme_id || !slab_id) {
          errors.push({ row: rowNum, error: 'Missing issuer_key, scheme_id or slab_id' })
          return
        }
        
        const tenure_unit_raw = row.getCell(7).value?.toString()?.trim()
        const tenure_unit = normalizeTenureUnit(tenure_unit_raw)
        const tenure_min_months = row.getCell(8).value != null ? parseInt(row.getCell(8).value) : undefined
        const tenure_max_months = row.getCell(9).value != null ? parseInt(row.getCell(9).value) : undefined
        const tenure_min_days = row.getCell(10).value != null ? parseInt(row.getCell(10).value) : undefined
        const tenure_max_days = row.getCell(11).value != null ? parseInt(row.getCell(11).value) : undefined
        const payout_frequency_type = row.getCell(12).value?.toString()?.trim()
        const base_interest_rate_pa = row.getCell(13).value != null ? parseFloat(row.getCell(13).value) : undefined
        const compounding_frequency = row.getCell(14).value?.toString()?.trim() || null
        const effective_yield_pa = row.getCell(15).value != null ? parseFloat(row.getCell(15).value) : undefined
        const notes_public_display = row.getCell(16).value?.toString()?.trim()
        const is_active = row.getCell(17).value?.toString()?.toLowerCase()?.trim() === 'yes'
        
        let cc = 0
        const ccValue = row.getCell(18).value
        if (typeof ccValue === 'number') cc = ccValue
        else if (typeof ccValue === 'string') cc = parseFloat(ccValue) || 0
        
        let si = 0
        const siValue = row.getCell(19).value
        if (typeof siValue === 'number') si = siValue
        else if (typeof siValue === 'string') si = parseFloat(siValue) || 0
        
        const updateData = {}
        updateData.tenure_unit = tenure_unit
        if (tenure_unit === 'days') {
          if (tenure_min_days !== undefined) updateData.tenure_min_days = tenure_min_days
          if (tenure_max_days !== undefined) updateData.tenure_max_days = tenure_max_days
        } else {
          if (tenure_min_months !== undefined) updateData.tenure_min_months = tenure_min_months
          if (tenure_max_months !== undefined) updateData.tenure_max_months = tenure_max_months
        }
        if (payout_frequency_type !== undefined && payout_frequency_type !== '') updateData.payout_frequency_type = payout_frequency_type
        if (base_interest_rate_pa !== undefined) updateData.base_interest_rate_pa = base_interest_rate_pa
        if (compounding_frequency !== undefined) updateData.compounding_frequency = compounding_frequency || null
        if (effective_yield_pa !== undefined) updateData.effective_yield_pa = effective_yield_pa
        if (notes_public_display !== undefined) updateData.notes_public_display = notes_public_display || ''
        if (is_active !== undefined) updateData.is_active = is_active
        updateData.cc = cc
        updateData.si = si

        const seniorOv = parseOptionalSlabBonusCell(row.getCell(20))
        const womenOv = parseOptionalSlabBonusCell(row.getCell(21))
        const renewalOv = parseOptionalSlabBonusCell(row.getCell(22))
        if (seniorOv !== undefined) updateData.senior_citizen_bonus_bps = seniorOv
        if (womenOv !== undefined) updateData.women_bonus_bps = womenOv
        if (renewalOv !== undefined) updateData.renewal_bonus_bps = renewalOv

        updates.push({ issuer_key, scheme_id, slab_id, updateData, row: rowNum })
      } catch (err) {
        errors.push({ row: rowNum, error: `Parsing error: ${err.message}` })
      }
    })
    
    let updated = 0
    let failed = 0
    
    for (const { issuer_key, scheme_id, slab_id, updateData, row } of updates) {
      try {
        const issuers = await q(`
          FOR issuer IN fd_issuers
          FILTER issuer._key == @issuer_key
          RETURN issuer
        `, { issuer_key })
        
        if (issuers.length === 0) {
          errors.push({ row, issuer_key, scheme_id, slab_id, error: 'Issuer not found' })
          failed++
          continue
        }
        
        const issuer = issuers[0]
        const schemeIndex = issuer.schemes?.findIndex(s => s.scheme_id === scheme_id)
        if (schemeIndex === -1 || schemeIndex === undefined) {
          errors.push({ row, issuer_key, scheme_id, slab_id, error: 'Scheme not found' })
          failed++
          continue
        }
        
        const scheme = issuer.schemes[schemeIndex]
        const slabIndex = scheme.rate_slabs?.findIndex(s => s.slab_id === slab_id)
        if (slabIndex === -1 || slabIndex === undefined) {
          errors.push({ row, issuer_key, scheme_id, slab_id, error: 'Rate slab not found' })
          failed++
          continue
        }
        
        const updatedSlabs = [...(scheme.rate_slabs || [])]
        updatedSlabs[slabIndex] = { ...updatedSlabs[slabIndex], ...updateData }
        const updatedSchemes = [...issuer.schemes]
        updatedSchemes[schemeIndex] = { ...scheme, rate_slabs: updatedSlabs }
        
        const collection = getCollection('fd_issuers')
        await collection.update(issuer_key, {
          schemes: updatedSchemes,
          updated_at: new Date().toISOString()
        })
        
        updated++
      } catch (err) {
        errors.push({ row, issuer_key, scheme_id, slab_id, error: err.message })
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