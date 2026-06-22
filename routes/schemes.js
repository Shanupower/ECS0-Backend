import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadExcel, uploadsDir } from '../middleware/upload.js'
import ExcelJS from 'exceljs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  buildExportMeta,
  insertExportHeaderRows,
  styleWorksheetTableHeaderRow
} from '../services/reports/report-export.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

// Valid MF AMC category values (MF, SIF, PMS, AIF, GIFT_CITY_FUNDS). Default for existing schemes: MF.
const VALID_AMC_CATEGORIES = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']
function normalizeAmcCategory(val) {
  if (val == null || val === '') return 'MF'
  const v = String(val).trim()
  return VALID_AMC_CATEGORIES.includes(v) ? v : 'MF'
}

// Derive categories array from AMC doc (supports legacy amc_category or new categories array).
function getAmcCategories(amc) {
  if (amc?.categories && Array.isArray(amc.categories) && amc.categories.length > 0) {
    return amc.categories.filter(c => VALID_AMC_CATEGORIES.includes(c))
  }
  const single = amc?.amc_category && VALID_AMC_CATEGORIES.includes(amc.amc_category) ? amc.amc_category : 'MF'
  return [single]
}

// Fallback when DB has no row yet (aligned with ECS0 mf_amc_categories.js)
/** @type {Record<string, number|null>} */
const FALLBACK_CATEGORY_MINIMUMS = Object.freeze({
  MF: null,
  SIF: 10_00_000,
  PMS: 50_00_000,
  AIF: 1_00_00_000,
  GIFT_CITY_FUNDS: 10_00_00_000
})

const CATEGORY_DEFAULTS_KEY = 'singleton'

/** Merge stored minimums (per category id) with fallback for missing keys */
function buildMergedMinimums(stored) {
  const out = {}
  for (const id of VALID_AMC_CATEGORIES) {
    if (stored && Object.prototype.hasOwnProperty.call(stored, id)) {
      const v = stored[id]
      if (v === null || v === '') out[id] = null
      else {
        const n = Number(v)
        out[id] = Number.isFinite(n) ? n : FALLBACK_CATEGORY_MINIMUMS[id]
      }
    } else {
      out[id] = FALLBACK_CATEGORY_MINIMUMS[id]
    }
  }
  return out
}

async function loadCategoryMinimums() {
  try {
    const coll = getCollection('mf_amc_category_defaults')
    await coll.load()
    const doc = await coll.document(CATEGORY_DEFAULTS_KEY)
    return buildMergedMinimums(doc.minimums && typeof doc.minimums === 'object' ? doc.minimums : {})
  } catch {
    return buildMergedMinimums({})
  }
}

async function loadRawMinimumsStored() {
  try {
    const coll = getCollection('mf_amc_category_defaults')
    await coll.load()
    const doc = await coll.document(CATEGORY_DEFAULTS_KEY)
    return doc.minimums && typeof doc.minimums === 'object' ? { ...doc.minimums } : {}
  } catch {
    return {}
  }
}

/**
 * Persist category minimums (partial updates merge with existing stored values, then fallbacks for never-set keys).
 * Returns merged map for response or { error: string }.
 */
async function persistCategoryMinimums(bodyMinimums) {
  if (!bodyMinimums || typeof bodyMinimums !== 'object') {
    return { error: 'minimums object is required' }
  }
  const prev = await loadRawMinimumsStored()
  const minimums = {}
  for (const id of VALID_AMC_CATEGORIES) {
    if (Object.prototype.hasOwnProperty.call(bodyMinimums, id)) {
      const v = bodyMinimums[id]
      if (v === null || v === '') minimums[id] = null
      else {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) {
          return { error: `minimums.${id} must be a non-negative number or null` }
        }
        minimums[id] = n
      }
    } else if (Object.prototype.hasOwnProperty.call(prev, id)) {
      const v = prev[id]
      minimums[id] = v === null || v === '' ? null : Number(v)
      if (minimums[id] !== null && !Number.isFinite(minimums[id])) minimums[id] = FALLBACK_CATEGORY_MINIMUMS[id]
    } else {
      minimums[id] = FALLBACK_CATEGORY_MINIMUMS[id]
    }
  }
  const coll = getCollection('mf_amc_category_defaults')
  try {
    await coll.load()
  } catch {
    await coll.create()
  }
  const payload = { minimums, updated_at: new Date().toISOString() }
  try {
    await coll.document(CATEGORY_DEFAULTS_KEY)
    await coll.update(CATEGORY_DEFAULTS_KEY, payload)
  } catch {
    await coll.save({ _key: CATEGORY_DEFAULTS_KEY, ...payload })
  }
  return { minimums }
}

// AMC override wins; then global default for scheme/amc category. Legacy category_settings mins are ignored.
function resolveMinInvestment(amc, schemeCategory, globalMins) {
  const cat = schemeCategory && VALID_AMC_CATEGORIES.includes(schemeCategory) ? schemeCategory : 'MF'
  if (amc?.min_investment != null) return amc.min_investment
  const g = globalMins?.[cat]
  if (g != null) return g
  return null
}

// ===================================
// GET ROUTES (Everyone can access)
// ===================================

// List all AMCs. Returns categories (array), category_settings; legacy amc_category derived for backward compat.
router.get('/amcs', async (req, res) => {
  try {
    const amcs = await q(`
      FOR amc IN amcs
      SORT amc.amc_name
      RETURN amc
    `)
    const normalized = amcs.map(a => {
      const categories = getAmcCategories(a)
      const legacyCategory = a.amc_category && VALID_AMC_CATEGORIES.includes(a.amc_category) ? a.amc_category : 'MF'
      return {
        ...a,
        categories,
        category_settings: a.category_settings || null,
        amc_category: legacyCategory,
        min_investment: a.min_investment != null ? a.min_investment : null
      }
    })
    res.json(normalized)
  } catch (error) {
    console.error('Error fetching AMCs:', error)
    res.status(500).json({ error: 'Failed to fetch AMCs' })
  }
})

// Get schemes by AMC code (filter out expired NFOs). Enrich with AMC categories and resolved min_investment.
// Optional query: ?amc_category=MF|SIF|PMS|AIF|GIFT_CITY_FUNDS to filter by category.
// Response includes amc summary (categories, category_settings) when Accept or query asks for it; for backward compat returns array of schemes only by default.
router.get('/amc/:amc_code', async (req, res) => {
  try {
    const { amc_code } = req.params
    const amc_category_filter = req.query.amc_category ? normalizeAmcCategory(req.query.amc_category) : null
    const today = new Date().toISOString().split('T')[0]

    await expireNFOs()

    const amcList = await q(`
      FOR amc IN amcs
      FILTER amc.amc_code == @amc_code
      LIMIT 1
      RETURN amc
    `, { amc_code })
    const amc = amcList[0] || null
    const categories = getAmcCategories(amc)
    const legacyCategory = amc?.amc_category && VALID_AMC_CATEGORIES.includes(amc.amc_category) ? amc.amc_category : 'MF'

    let schemes = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.amc_code == @amc_code
      FILTER (scheme.is_nfo == false OR scheme.is_nfo == true AND scheme.nfo_validity >= @today)
      SORT scheme.scheme_name
      RETURN scheme
    `, { amc_code, today })

    const globalMins = await loadCategoryMinimums()
    schemes = schemes.map(s => {
      const schemeCat = s.amc_category && VALID_AMC_CATEGORIES.includes(s.amc_category) ? s.amc_category : legacyCategory
      const minInv = s.min_investment != null ? s.min_investment : resolveMinInvestment(amc, schemeCat, globalMins)
      return {
        ...s,
        amc_category: schemeCat,
        min_investment: minInv
      }
    })
    if (amc_category_filter) {
      schemes = schemes.filter(s => s.amc_category === amc_category_filter)
    }

    const includeAmcSummary = req.query.include_amc === 'true' || req.query.include_amc === '1'
    if (includeAmcSummary && amc) {
      return res.json({
        amc: {
          amc_code: amc.amc_code,
          amc_name: amc.amc_name,
          categories,
          category_settings: amc.category_settings || null,
          min_investment: amc.min_investment != null ? amc.min_investment : null
        },
        schemes
      })
    }
    res.json(schemes)
  } catch (error) {
    console.error('Error fetching schemes:', error)
    res.status(500).json({ error: 'Failed to fetch schemes' })
  }
})

// Global MF AMC category minimums (defaults until an AMC sets min_investment)
router.get('/category-minimums', async (req, res) => {
  try {
    const minimums = await loadCategoryMinimums()
    res.json({ minimums })
  } catch (error) {
    console.error('Error fetching category minimums:', error)
    res.status(500).json({ error: 'Failed to fetch category minimums' })
  }
})

router.put('/category-minimums', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body?.minimums != null ? req.body.minimums : req.body
    const result = await persistCategoryMinimums(body)
    if (result.error) {
      return res.status(400).json({ error: result.error })
    }
    res.json({ minimums: result.minimums, message: 'Category minimums updated' })
  } catch (error) {
    console.error('Error saving category minimums:', error)
    res.status(500).json({ error: 'Failed to save category minimums' })
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
    
    const scheme = schemes[0]
    const amc_code = scheme.amc_code
    const globalMins = await loadCategoryMinimums()
    const amcRows = amc_code
      ? await q(`FOR amc IN amcs FILTER amc.amc_code == @amc_code LIMIT 1 RETURN amc`, { amc_code })
      : []
    const amc = amcRows[0] || null
    const legacyCategory = amc?.amc_category && VALID_AMC_CATEGORIES.includes(amc.amc_category) ? amc.amc_category : 'MF'
    const schemeCat = scheme.amc_category && VALID_AMC_CATEGORIES.includes(scheme.amc_category) ? scheme.amc_category : legacyCategory
    const minInv = scheme.min_investment != null ? scheme.min_investment : resolveMinInvestment(amc, schemeCat, globalMins)

    const out = {
      ...scheme,
      amc_category: schemeCat,
      min_investment: minInv
    }
    res.json(out)
  } catch (error) {
    console.error('Error fetching scheme:', error)
    res.status(500).json({ error: 'Failed to fetch scheme' })
  }
})

// ===================================
// CREATE ROUTES (Admin only)
// ===================================

// Create AMC. Accepts categories (array) or legacy amc_category; optional category_settings.
router.post('/amc', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_name, amc_code, categories: categoriesRaw, amc_category: amcCategoryRaw, min_investment, category_settings: categorySettingsRaw } = req.body

    if (!amc_name || !amc_code) {
      return res.status(400).json({ error: 'amc_name and amc_code are required' })
    }

    let categories
    if (Array.isArray(categoriesRaw) && categoriesRaw.length > 0) {
      categories = categoriesRaw.filter(c => VALID_AMC_CATEGORIES.includes(String(c).trim()))
      if (categories.length === 0) {
        return res.status(400).json({ error: 'categories must contain at least one of: ' + VALID_AMC_CATEGORIES.join(', ') })
      }
      if (categories.length > 1) {
        return res.status(400).json({ error: 'Only one AMC category is allowed per AMC' })
      }
    } else {
      const single = normalizeAmcCategory(amcCategoryRaw)
      categories = [single]
    }

    const existing = await q(`
      FOR amc IN amcs
      FILTER amc.amc_code == @amc_code
      LIMIT 1
      RETURN amc
    `, { amc_code })

    if (existing.length > 0) {
      return res.status(400).json({ error: 'AMC code already exists' })
    }

    const category_settings = categorySettingsRaw && typeof categorySettingsRaw === 'object' ? categorySettingsRaw : null
    const amcsCollection = getCollection('amcs')
    const payload = {
      _key: amc_code,
      amc_name,
      amc_code,
      categories,
      amc_category: categories[0],
      min_investment: min_investment != null && min_investment !== '' ? Number(min_investment) : null,
      created_at: new Date().toISOString()
    }
    if (category_settings) payload.category_settings = category_settings
    const result = await amcsCollection.save(payload)

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
      amc_category: amcCategoryRaw,
      plan,
      option,
      base_name,
      type,
      nav_latest,
      nav_date,
      is_nfo,
      nfo_validity,
      cc,
      si
    } = req.body

    if (!scheme_name || !amc_code || !amc_name) {
      return res.status(400).json({ error: 'scheme_name, amc_code, and amc_name are required' })
    }

    const amc_category = normalizeAmcCategory(amcCategoryRaw)

    const needsGeneratedCode = !scheme_code || String(scheme_code).trim() === ''
    const generatedCode = `${amc_code}_${(option || 'GROWTH')}_${Date.now()}`
    const finalSchemeCode = needsGeneratedCode ? generatedCode : String(scheme_code).trim()

    // Check if scheme code already exists
    const existing = await q(`
      FOR scheme IN mf_schemes
      FILTER scheme.scheme_code == @scheme_code
      LIMIT 1
      RETURN scheme
    `, { scheme_code: finalSchemeCode })

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Scheme code already exists' })
    }
    
    // Calculate display name if option is provided
    const displayName = (option && base_name) 
      ? generateDisplayName(base_name, plan || 'REGULAR', option)
      : scheme_name

    const ccVal = cc !== undefined && cc !== null ? Number(cc) : null
    const siVal = si !== undefined && si !== null ? Number(si) : null

    const schemesCollection = getCollection('mf_schemes')
    const result = await schemesCollection.save({
      scheme_code: finalSchemeCode,
      scheme_name,
      display_name: displayName,
      base_name: base_name || scheme_name,
      amc_code,
      amc_name,
      category,
      sub_category,
      amc_category,
      plan: plan || 'REGULAR',
      option: option || 'GROWTH',
      type,
      nav_latest: nav_latest || 0,
      nav_date: nav_date || null,
      is_nfo: is_nfo || false,
      nfo_validity: is_nfo ? nfo_validity : null,
      cc: Number.isFinite(ccVal) ? ccVal : null,
      si: Number.isFinite(siVal) ? siVal : null,
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
      amc_category: amcCategoryRaw,
      type,
      is_nfo,
      nfo_validity,
      variants
    } = req.body
    
    const amc_category = normalizeAmcCategory(amcCategoryRaw)
    
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
        const { plan, option, amfi_code, updateIfExists, cc: ccRaw, si: siRaw } = variant
        const ccVal = ccRaw !== undefined && ccRaw !== null ? Number(ccRaw) : null
        const siVal = siRaw !== undefined && siRaw !== null ? Number(siRaw) : null

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
          amc_category: normalizeAmcCategory(amc_category),
          plan,
          option,
          type: type || 'OPEN_ENDED',
          nav_latest: 0,
          nav_date: null,
          cc: ccVal,
          si: siVal,
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

// Update AMC. Accepts categories (array), category_settings, min_investment.
router.put('/amc/:amc_code', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_code } = req.params
    const { amc_name, categories: categoriesRaw, amc_category: amcCategoryRaw, min_investment, category_settings: categorySettingsRaw } = req.body

    if (!amc_name) {
      return res.status(400).json({ error: 'amc_name is required' })
    }

    const updatePayload = {
      amc_name,
      updated_at: new Date().toISOString()
    }

    if (Array.isArray(categoriesRaw) && categoriesRaw.length > 0) {
      const categories = categoriesRaw.filter(c => VALID_AMC_CATEGORIES.includes(String(c).trim()))
      if (categories.length === 0) {
        return res.status(400).json({ error: 'categories must contain at least one of: ' + VALID_AMC_CATEGORIES.join(', ') })
      }
      if (categories.length > 1) {
        return res.status(400).json({ error: 'Only one AMC category is allowed per AMC' })
      }
      updatePayload.categories = categories
      updatePayload.amc_category = categories[0]
    } else if (amcCategoryRaw != null) {
      const single = normalizeAmcCategory(amcCategoryRaw)
      updatePayload.amc_category = single
      updatePayload.categories = [single]
    }

    if (categorySettingsRaw !== undefined) {
      updatePayload.category_settings = categorySettingsRaw && typeof categorySettingsRaw === 'object' ? categorySettingsRaw : null
    }
    if (min_investment !== undefined) updatePayload.min_investment = min_investment != null && min_investment !== '' ? Number(min_investment) : null

    const amcsCollection = getCollection('amcs')
    const result = await amcsCollection.update(amc_code, updatePayload)

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
      amc_category: amcCategoryRaw,
      plan,
      option,
      type,
      nav_latest,
      nav_date,
      is_nfo,
      nfo_validity,
      is_active,
      cc,
      si
    } = req.body
    
    // Build update object with only provided fields
    const updateData = {
      updated_at: new Date().toISOString()
    }
    
    if (scheme_name !== undefined) updateData.scheme_name = scheme_name
    if (base_name !== undefined) updateData.base_name = base_name
    if (category !== undefined) updateData.category = category
    if (sub_category !== undefined) updateData.sub_category = sub_category
    if (amcCategoryRaw !== undefined) updateData.amc_category = normalizeAmcCategory(amcCategoryRaw)
    if (plan !== undefined) updateData.plan = plan
    if (option !== undefined) updateData.option = option
    if (type !== undefined) updateData.type = type
    if (nav_latest !== undefined) updateData.nav_latest = nav_latest
    if (nav_date !== undefined) updateData.nav_date = nav_date
    if (is_nfo !== undefined) updateData.is_nfo = is_nfo
    if (nfo_validity !== undefined) updateData.nfo_validity = is_nfo ? nfo_validity : null
    if (is_active !== undefined) updateData.is_active = is_active
    if (cc !== undefined) updateData.cc = cc !== null && cc !== '' ? Number(cc) : null
    if (si !== undefined) updateData.si = si !== null && si !== '' ? Number(si) : null
    
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

// ===================================
// EXCEL IMPORT/EXPORT (Admin only)
// ===================================

// Export schemes to Excel
router.get('/export/excel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { amc_code } = req.query // Optional: filter by AMC
    
    // Fetch schemes
    let schemes = []
    if (amc_code) {
      schemes = await q(`
        FOR scheme IN mf_schemes
        FILTER scheme.amc_code == @amc_code
        SORT scheme.scheme_name
        RETURN scheme
      `, { amc_code })
    } else {
      schemes = await q(`
        FOR scheme IN mf_schemes
        SORT scheme.amc_name, scheme.scheme_name
        RETURN scheme
      `)
    }
    
    // Create workbook
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Schemes')
    
    // Define columns with protection
    worksheet.columns = [
      { header: 'Scheme Code', key: 'scheme_code', width: 25, protection: { locked: true } },
      { header: 'AMC Code', key: 'amc_code', width: 15, protection: { locked: true } },
      { header: 'AMC Name', key: 'amc_name', width: 30, protection: { locked: true } },
      { header: 'Scheme Name', key: 'scheme_name', width: 45, protection: { locked: true } },
      { header: 'Base Name', key: 'base_name', width: 40, protection: { locked: true } },
      { header: 'Plan', key: 'plan', width: 12, protection: { locked: true } },
      { header: 'Option', key: 'option', width: 20, protection: { locked: true } },
      { header: 'Category', key: 'category', width: 20, protection: { locked: false } },
      { header: 'Sub Category', key: 'sub_category', width: 25, protection: { locked: false } },
      { header: 'AMC Category', key: 'amc_category', width: 18, protection: { locked: false } },
      { header: 'Type', key: 'type', width: 15, protection: { locked: false } },
      { header: 'NAV Latest', key: 'nav_latest', width: 15, protection: { locked: false }, style: { numFmt: '#,##0.0000' } },
      { header: 'NAV Date', key: 'nav_date', width: 15, protection: { locked: false } },
      { header: 'CC %', key: 'cc', width: 12, protection: { locked: false }, style: { numFmt: '0.00000' } },
      { header: 'SI %', key: 'si', width: 12, protection: { locked: false }, style: { numFmt: '0.00000' } },
      { header: 'Is Active', key: 'is_active', width: 12, protection: { locked: false } },
      { header: 'Is NFO', key: 'is_nfo', width: 12, protection: { locked: false } },
      { header: 'NFO Validity', key: 'nfo_validity', width: 15, protection: { locked: false } }
    ]
    
    // Style table header row (shifted after export metadata rows are inserted below)
    styleWorksheetTableHeaderRow(worksheet, 1)
    
    // Add data rows
    schemes.forEach((scheme, index) => {
      const row = worksheet.addRow({
        scheme_code: scheme.scheme_code || '',
        amc_code: scheme.amc_code || '',
        amc_name: scheme.amc_name || '',
        scheme_name: scheme.scheme_name || '',
        base_name: scheme.base_name || scheme.scheme_name || '',
        plan: scheme.plan || 'REGULAR',
        option: scheme.option || 'GROWTH',
        category: scheme.category || '',
        sub_category: scheme.sub_category || '',
        amc_category: scheme.amc_category && VALID_AMC_CATEGORIES.includes(scheme.amc_category) ? scheme.amc_category : 'MF',
        type: scheme.type || 'OPEN_ENDED',
        nav_latest: scheme.nav_latest || 0,
        nav_date: scheme.nav_date ? new Date(scheme.nav_date).toLocaleDateString('en-IN') : '',
        cc: scheme.cc || 0,
        si: scheme.si || 0,
        is_active: scheme.is_active !== false ? 'Yes' : 'No',
        is_nfo: scheme.is_nfo ? 'Yes' : 'No',
        nfo_validity: scheme.nfo_validity ? new Date(scheme.nfo_validity).toLocaleDateString('en-IN') : ''
      })
      
      // Explicitly set protection for each cell
      // Locked cells (protected)
      row.getCell(1).protection = { locked: true } // scheme_code
      row.getCell(2).protection = { locked: true } // amc_code
      row.getCell(3).protection = { locked: true } // amc_name
      row.getCell(4).protection = { locked: true } // scheme_name
      row.getCell(5).protection = { locked: true } // base_name
      row.getCell(6).protection = { locked: true } // plan
      row.getCell(7).protection = { locked: true } // option
      
      // Unlocked cells (editable) - explicitly set
      row.getCell(8).protection = { locked: false } // category
      row.getCell(9).protection = { locked: false } // sub_category
      row.getCell(10).protection = { locked: false } // amc_category
      row.getCell(11).protection = { locked: false } // type
      row.getCell(12).protection = { locked: false } // nav_latest
      row.getCell(13).protection = { locked: false } // nav_date
      row.getCell(14).protection = { locked: false } // cc
      row.getCell(14).numFmt = '0.00000' // CC with 5 decimal places
      row.getCell(15).protection = { locked: false } // si
      row.getCell(15).numFmt = '0.00000' // SI with 5 decimal places
      row.getCell(16).protection = { locked: false } // is_active
      row.getCell(17).protection = { locked: false } // is_nfo
      row.getCell(18).protection = { locked: false } // nfo_validity
      
      // Add light gray background to locked cells
      for (let col = 1; col <= 7; col++) {
        row.getCell(col).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF5F5F5' }
        }
      }
    })
    
    const exportMeta = buildExportMeta({ reportTitle: 'MF Schemes Export' })
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
    const filename = `schemes-export-${amc_code || 'all'}-${new Date().toISOString().split('T')[0]}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    
    await workbook.xlsx.write(res)
    res.end()
  } catch (error) {
    console.error('Error exporting schemes to Excel:', error)
    res.status(500).json({ error: 'Failed to export schemes', detail: error.message })
  }
})

// Import schemes from Excel
router.post('/import/excel', requireAuth, requireRole('admin'), uploadExcel, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required' })
    }
    
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(req.file.path)
    
    const worksheet = workbook.getWorksheet(1) // First sheet
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
      if (rowNum === 1) return // Skip header row
      
      try {
        const scheme_code = row.getCell(1).value?.toString()?.trim()
        if (!scheme_code) {
          errors.push({ row: rowNum, error: 'Missing scheme_code' })
          return
        }
        
        // Extract only updatable fields (columns 8-18; 10 = amc_category)
        const category = row.getCell(8).value?.toString()?.trim()
        const sub_category = row.getCell(9).value?.toString()?.trim()
        const amc_category = row.getCell(10).value?.toString()?.trim()
        const type = row.getCell(11).value?.toString()?.trim()
        
        // Parse numeric values
        let nav_latest = 0
        const navLatestValue = row.getCell(12).value
        if (typeof navLatestValue === 'number') {
          nav_latest = navLatestValue
        } else if (typeof navLatestValue === 'string') {
          nav_latest = parseFloat(navLatestValue.replace(/,/g, '')) || 0
        }
        
        // Parse NAV date
        let nav_date = undefined
        const navDateValue = row.getCell(13).value
        if (navDateValue) {
          if (navDateValue instanceof Date) {
            nav_date = navDateValue.toISOString().split('T')[0]
          } else if (typeof navDateValue === 'string') {
            const parsed = new Date(navDateValue)
            if (!isNaN(parsed.getTime())) {
              nav_date = parsed.toISOString().split('T')[0]
            }
          } else if (typeof navDateValue === 'number') {
            // Excel serial date (days since 1900-01-01)
            const excelEpoch = new Date(1899, 11, 30) // Excel epoch
            const date = new Date(excelEpoch.getTime() + navDateValue * 86400000)
            nav_date = date.toISOString().split('T')[0]
          }
        }
        
        // Parse CC and SI
        let cc = 0
        const ccValue = row.getCell(14).value
        if (typeof ccValue === 'number') {
          cc = ccValue
        } else if (typeof ccValue === 'string') {
          cc = parseFloat(ccValue) || 0
        }
        
        let si = 0
        const siValue = row.getCell(15).value
        if (typeof siValue === 'number') {
          si = siValue
        } else if (typeof siValue === 'string') {
          si = parseFloat(siValue) || 0
        }
        
        // Parse boolean values
        const isActiveValue = row.getCell(16).value?.toString()?.toLowerCase()?.trim()
        const is_active = isActiveValue === 'yes' || isActiveValue === 'true' || isActiveValue === '1'
        
        const isNfoValue = row.getCell(17).value?.toString()?.toLowerCase()?.trim()
        const is_nfo = isNfoValue === 'yes' || isNfoValue === 'true' || isNfoValue === '1'
        
        // Parse NFO validity date
        let nfo_validity = undefined
        const nfoValidityValue = row.getCell(18).value
        if (nfoValidityValue && is_nfo) {
          if (nfoValidityValue instanceof Date) {
            nfo_validity = nfoValidityValue.toISOString().split('T')[0]
          } else if (typeof nfoValidityValue === 'string') {
            const parsed = new Date(nfoValidityValue)
            if (!isNaN(parsed.getTime())) {
              nfo_validity = parsed.toISOString().split('T')[0]
            }
          } else if (typeof nfoValidityValue === 'number') {
            // Excel serial date (days since 1900-01-01)
            const excelEpoch = new Date(1899, 11, 30) // Excel epoch
            const date = new Date(excelEpoch.getTime() + nfoValidityValue * 86400000)
            nfo_validity = date.toISOString().split('T')[0]
          }
        } else if (is_nfo === false) {
          nfo_validity = null
        }
        
        // Build update object - only include defined values
        const updateData = {
          updated_at: new Date().toISOString()
        }
        
        if (category !== undefined && category !== null && category !== '') {
          updateData.category = category
        }
        if (sub_category !== undefined && sub_category !== null && sub_category !== '') {
          updateData.sub_category = sub_category
        }
        if (amc_category !== undefined && amc_category !== null && amc_category !== '') {
          updateData.amc_category = normalizeAmcCategory(amc_category)
        }
        if (type !== undefined && type !== null && type !== '') {
          updateData.type = type
        }
        if (nav_latest !== undefined) {
          updateData.nav_latest = nav_latest
        }
        if (nav_date !== undefined) {
          updateData.nav_date = nav_date
        }
        if (cc !== undefined) {
          updateData.cc = cc
        }
        if (si !== undefined) {
          updateData.si = si
        }
        if (is_active !== undefined) {
          updateData.is_active = is_active
        }
        if (is_nfo !== undefined) {
          updateData.is_nfo = is_nfo
          if (!is_nfo) {
            updateData.nfo_validity = null
          }
        }
        if (nfo_validity !== undefined) {
          updateData.nfo_validity = nfo_validity
        }
        
        updates.push({ scheme_code, updateData, row: rowNum })
      } catch (err) {
        errors.push({ row: rowNum, error: `Parsing error: ${err.message}` })
      }
    })
    
    // Batch update schemes
    let updated = 0
    let failed = 0
    
    for (const { scheme_code, updateData, row } of updates) {
      try {
        // Verify scheme exists
        const existing = await q(`
          FOR scheme IN mf_schemes
          FILTER scheme.scheme_code == @scheme_code
          LIMIT 1
          RETURN scheme
        `, { scheme_code })
        
        if (existing.length === 0) {
          errors.push({ row, scheme_code, error: 'Scheme not found' })
          failed++
          continue
        }
        
        // Perform update
        await q(`
          FOR scheme IN mf_schemes
          FILTER scheme.scheme_code == @scheme_code
          UPDATE scheme WITH @data IN mf_schemes
        `, { scheme_code, data: updateData })
        
        updated++
      } catch (err) {
        errors.push({ row, scheme_code, error: err.message })
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
      errors: errors.slice(0, 100) // Limit error response
    })
  } catch (error) {
    console.error('Error importing schemes from Excel:', error)
    
    // Cleanup uploaded file on error
    if (req.file) {
      try {
        const fs = await import('fs')
        fs.unlinkSync(req.file.path)
      } catch (unlinkErr) {
        console.error('Error deleting uploaded file:', unlinkErr)
      }
    }
    
    res.status(500).json({ error: 'Failed to import schemes', detail: error.message })
  }
})

export default router

