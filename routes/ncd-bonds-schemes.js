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
      // ISIN format validation (12 characters)
      if (scheme.isin && scheme.isin.length !== 12) {
        errors.push(`Scheme ${idx + 1}: ISIN must be exactly 12 characters`)
      }
      
      // Date validations
      if (scheme.issue_date && scheme.maturity_date) {
        const issueDate = new Date(scheme.issue_date)
        const maturityDate = new Date(scheme.maturity_date)
        if (maturityDate <= issueDate) {
          errors.push(`Scheme ${idx + 1}: maturity_date must be after issue_date`)
        }
      }
      
      // Coupon rate validation (0-100)
      if (scheme.coupon_rate !== undefined && (scheme.coupon_rate < 0 || scheme.coupon_rate > 100)) {
        errors.push(`Scheme ${idx + 1}: coupon_rate must be between 0 and 100`)
      }
      
      // Face value validation
      if (scheme.face_value !== undefined && scheme.face_value <= 0) {
        errors.push(`Scheme ${idx + 1}: face_value must be greater than 0`)
      }
      
      // Interest payment frequency validation
      if (scheme.interest_payment_frequency && !['Monthly', 'Quarterly', 'Half-Yearly', 'Annual', 'Cumulative', 'At Maturity'].includes(scheme.interest_payment_frequency)) {
        errors.push(`Scheme ${idx + 1}: interest_payment_frequency must be one of: Monthly, Quarterly, Half-Yearly, Annual, Cumulative, At Maturity`)
      }
      
      // Note: NCDs/Bonds don't use rate slabs like FDs - they have fixed coupon rates
      // Variable rate bonds change rates based on benchmark rates, not tenure slabs
    })
  }
  
  return errors
}

// ===================================
// READ OPERATIONS (Everyone can access)
// ===================================

// List all active NCD/Bond issuers
router.get('/issuers', async (req, res) => {
  try {
    const issuers = await q(`
      FOR issuer IN ncd_bond_issuers
      FILTER issuer.is_active == true
      RETURN issuer
    `)
    
    res.json(issuers)
  } catch (error) {
    console.error('Error fetching NCD/Bond issuers:', error)
    // If collection doesn't exist, return empty array instead of error
    if (error.errorNum === 1203 || error.message?.includes('not found') || error.message?.includes('does not exist')) {
      console.warn('Collection ncd_bond_issuers does not exist. Returning empty array.')
      return res.json([])
    }
    res.status(500).json({ error: 'Failed to fetch NCD/Bond issuers', details: error.message })
  }
})

// Get single issuer with all nested schemes
router.get('/issuer/:issuer_key', async (req, res) => {
  try {
    const { issuer_key } = req.params
    
    const issuer = await q(`
      FOR issuer IN ncd_bond_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuer || issuer.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    res.json(issuer[0])
  } catch (error) {
    console.error('Error fetching NCD/Bond issuer:', error)
    res.status(500).json({ error: 'Failed to fetch NCD/Bond issuer' })
  }
})

// Get schemes for an issuer (filter active by default)
router.get('/issuer/:issuer_key/schemes', async (req, res) => {
  try {
    const { issuer_key } = req.params
    const { active_only = 'true' } = req.query
    
    const issuers = await q(`
      FOR issuer IN ncd_bond_issuers
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
    console.error('Error fetching NCD/Bond schemes:', error)
    res.status(500).json({ error: 'Failed to fetch NCD/Bond schemes' })
  }
})

// Get single scheme
router.get('/issuer/:issuer_key/scheme/:scheme_id', async (req, res) => {
  try {
    const { issuer_key, scheme_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN ncd_bond_issuers
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
    console.error('Error fetching NCD/Bond scheme:', error)
    res.status(500).json({ error: 'Failed to fetch NCD/Bond scheme' })
  }
})

// Note: NCDs/Bonds don't use rate slabs - they have fixed coupon rates

// ===================================
// WRITE OPERATIONS (Admin only)
// ===================================

// Create issuer
router.post('/issuer', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const issuerData = req.body
    
    // Remove issuer_code if present (NCD/Bond issuers use _key, not issuer_code)
    const { issuer_code, ...cleanIssuerData } = issuerData
    
    // Generate unique issuer key if not provided
    let issuer_key = cleanIssuerData._key
    if (!issuer_key) {
      // Create base key from short name
      const baseKey = cleanIssuerData.short_name.toLowerCase().replace(/\s+/g, '_')
      issuer_key = baseKey
      
      // Check if exists and generate unique key
      let counter = 1
      while (true) {
        const existing = await q(`
          FOR issuer IN ncd_bond_issuers
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
        FOR issuer IN ncd_bond_issuers
        FILTER issuer._key == @issuer_key
        RETURN issuer
      `, { issuer_key })
      
      if (existing && existing.length > 0) {
        return res.status(400).json({ error: 'Issuer with this key already exists' })
      }
    }
    
    // Validate business rules
    const validationErrors = validateBusinessRules(cleanIssuerData)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const newIssuer = {
      _key: issuer_key,
      ...cleanIssuerData,
      is_active: cleanIssuerData.is_active !== undefined ? cleanIssuerData.is_active : true,
      schemes: cleanIssuerData.schemes || []
    }
    
    const collection = getCollection('ncd_bond_issuers')
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
      FOR issuer IN ncd_bond_issuers
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
    
    const collection = getCollection('ncd_bond_issuers')
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
      FOR issuer IN ncd_bond_issuers
      FILTER issuer._key == @issuer_key
      REMOVE issuer IN ncd_bond_issuers
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
      FOR issuer IN ncd_bond_issuers
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
      console.error('NCD/Bond Scheme validation errors:', validationErrors)
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('ncd_bond_issuers')
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
      FOR issuer IN ncd_bond_issuers
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
    
    const collection = getCollection('ncd_bond_issuers')
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
      FOR issuer IN ncd_bond_issuers
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
    
    const collection = getCollection('ncd_bond_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json({ message: 'Scheme deleted successfully' })
  } catch (error) {
    console.error('Error deleting scheme:', error)
    res.status(500).json({ error: 'Failed to delete scheme' })
  }
})

// Note: NCDs/Bonds don't use rate slabs - they have fixed coupon rates
// Variable rate bonds change rates based on benchmark rates (like RBI repo rate), not tenure-based slabs

// ===================================
// EXCEL IMPORT/EXPORT (Admin only)
// ===================================

// Export NCD/Bond schemes to Excel
router.get('/export/excel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    let { issuer_key } = req.query // Optional: filter by issuer
    // Treat empty or sentinel values as "export all"
    if (issuer_key === '' || issuer_key === 'null' || issuer_key === 'undefined') {
      issuer_key = null
    }
    
    // Fetch issuers (handle missing collection like list endpoint)
    let issuers = []
    try {
      if (issuer_key) {
        const result = await q(`
          FOR issuer IN ncd_bond_issuers
          FILTER issuer._key == @issuer_key
          RETURN issuer
        `, { issuer_key })
        issuers = result || []
      } else {
        issuers = await q(`FOR issuer IN ncd_bond_issuers RETURN issuer`)
      }
    } catch (dbError) {
      if (dbError.errorNum === 1203 || dbError.message?.includes('not found') || dbError.message?.includes('does not exist')) {
        console.warn('Collection ncd_bond_issuers missing or inaccessible for export. Returning empty export.')
        issuers = []
      } else {
        throw dbError
      }
    }
    
    if (!Array.isArray(issuers)) {
      issuers = []
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
            issuer_type: issuer.type || '',
            scheme_id: scheme.scheme_id || '',
            scheme_name: scheme.scheme_name || '',
            isin: scheme.isin || '',
            description: scheme.description || '',
            coupon_rate: scheme.coupon_rate || 0,
            face_value: scheme.face_value || 0,
            issue_date: scheme.issue_date || '',
            maturity_date: scheme.maturity_date || '',
            is_variable_rate: scheme.is_variable_rate ? 'Yes' : 'No',
            listing_status: scheme.listing_status || '',
            credit_rating: scheme.credit_rating || '',
            min_investment: scheme.min_investment || '',
            interest_payment_frequency: scheme.interest_payment_frequency || '',
            is_secured: scheme.is_secured !== undefined ? (scheme.is_secured ? 'Yes' : 'No') : '',
            early_redemption_allowed: scheme.early_redemption_allowed !== undefined ? (scheme.early_redemption_allowed ? 'Yes' : 'No') : '',
            early_redemption_terms: scheme.early_redemption_terms || '',
            put_option_available: scheme.put_option_available !== undefined ? (scheme.put_option_available ? 'Yes' : 'No') : '',
            call_option_available: scheme.call_option_available !== undefined ? (scheme.call_option_available ? 'Yes' : 'No') : '',
            currency: scheme.currency || 'INR',
            issue_size: scheme.issue_size || '',
            is_active: scheme.is_active !== false ? 'Yes' : 'No',
            cc: scheme.cc || 0,
            si: scheme.si || 0
          })
        })
      }
    })
    
    // Create workbook
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('NCD/Bond Schemes')
    
    // Define columns
    worksheet.columns = [
      { header: 'Issuer Key', key: 'issuer_key', width: 20 },
      { header: 'Issuer Legal Name', key: 'issuer_legal_name', width: 30 },
      { header: 'Issuer Short Name', key: 'issuer_short_name', width: 25 },
      { header: 'Issuer Type', key: 'issuer_type', width: 15 },
      { header: 'Scheme ID', key: 'scheme_id', width: 25 },
      { header: 'Scheme Name', key: 'scheme_name', width: 40 },
      { header: 'ISIN', key: 'isin', width: 15 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Coupon Rate (%)', key: 'coupon_rate', width: 15 },
      { header: 'Face Value', key: 'face_value', width: 15 },
      { header: 'Issue Date', key: 'issue_date', width: 15 },
      { header: 'Maturity Date', key: 'maturity_date', width: 15 },
      { header: 'Variable Rate', key: 'is_variable_rate', width: 15 },
      { header: 'Listing Status', key: 'listing_status', width: 15 },
      { header: 'Credit Rating', key: 'credit_rating', width: 15 },
      { header: 'Min Investment', key: 'min_investment', width: 15 },
      { header: 'Interest Payment Frequency', key: 'interest_payment_frequency', width: 25 },
      { header: 'Secured', key: 'is_secured', width: 12 },
      { header: 'Early Redemption Allowed', key: 'early_redemption_allowed', width: 22 },
      { header: 'Early Redemption Terms', key: 'early_redemption_terms', width: 30 },
      { header: 'Put Option', key: 'put_option_available', width: 12 },
      { header: 'Call Option', key: 'call_option_available', width: 12 },
      { header: 'Currency', key: 'currency', width: 12 },
      { header: 'Issue Size', key: 'issue_size', width: 15 },
      { header: 'Is Active', key: 'is_active', width: 12 },
      { header: 'CC %', key: 'cc', width: 12 },
      { header: 'SI %', key: 'si', width: 12 }
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
    flattenedSchemes.forEach(scheme => {
      worksheet.addRow(scheme)
    })
    
    // Set response headers
    const filename = `ncd-bonds-schemes-export-${issuer_key ?? 'all'}-${new Date().toISOString().split('T')[0]}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    
    await workbook.xlsx.write(res)
    if (!res.writableEnded) {
      res.end()
    }
  } catch (error) {
    console.error('Error exporting NCD/Bond schemes to Excel:', error)
    res.status(500).json({ error: 'Failed to export NCD/Bond schemes', detail: error.message })
  }
})

// Import NCD/Bond schemes from Excel
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
        const scheme_id = row.getCell(5).value?.toString()?.trim()
        
        if (!issuer_key || !scheme_id) {
          errors.push({ row: rowNum, error: 'Missing issuer_key or scheme_id' })
          return
        }
        
        // Extract updatable fields
        const description = row.getCell(8).value?.toString()?.trim()
        const coupon_rate = row.getCell(9).value ? parseFloat(row.getCell(9).value) : null
        const face_value = row.getCell(10).value ? parseFloat(row.getCell(10).value) : null
        const issue_date = row.getCell(11).value?.toString()?.trim()
        const maturity_date = row.getCell(12).value?.toString()?.trim()
        const is_variable_rate = row.getCell(13).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const listing_status = row.getCell(14).value?.toString()?.trim()
        const credit_rating = row.getCell(15).value?.toString()?.trim()
        const min_investment = row.getCell(16).value ? parseFloat(row.getCell(16).value) : null
        const interest_payment_frequency = row.getCell(17).value?.toString()?.trim()
        const is_secured = row.getCell(18).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const early_redemption_allowed = row.getCell(19).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const early_redemption_terms = row.getCell(20).value?.toString()?.trim()
        const put_option_available = row.getCell(21).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const call_option_available = row.getCell(22).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const currency = row.getCell(23).value?.toString()?.trim() || 'INR'
        const issue_size = row.getCell(24).value?.toString()?.trim()
        const is_active = row.getCell(25).value?.toString()?.toLowerCase()?.trim() === 'yes'
        
        let cc = 0
        const ccValue = row.getCell(26).value
        if (typeof ccValue === 'number') {
          cc = ccValue
        } else if (typeof ccValue === 'string') {
          cc = parseFloat(ccValue) || 0
        }
        
        let si = 0
        const siValue = row.getCell(27).value
        if (typeof siValue === 'number') {
          si = siValue
        } else if (typeof siValue === 'string') {
          si = parseFloat(siValue) || 0
        }
        
        // Build update object
        const updateData = {}
        if (description !== undefined && description !== '') updateData.description = description
        if (coupon_rate !== undefined && coupon_rate !== null) updateData.coupon_rate = coupon_rate
        if (face_value !== undefined && face_value !== null) updateData.face_value = face_value
        if (issue_date !== undefined && issue_date !== '') updateData.issue_date = issue_date
        if (maturity_date !== undefined && maturity_date !== '') updateData.maturity_date = maturity_date
        if (is_variable_rate !== undefined) updateData.is_variable_rate = is_variable_rate
        if (listing_status !== undefined && listing_status !== '') updateData.listing_status = listing_status
        if (credit_rating !== undefined && credit_rating !== '') updateData.credit_rating = credit_rating
        if (min_investment !== undefined && min_investment !== null) updateData.min_investment = min_investment
        if (interest_payment_frequency !== undefined && interest_payment_frequency !== '') updateData.interest_payment_frequency = interest_payment_frequency
        if (is_secured !== undefined) updateData.is_secured = is_secured
        if (early_redemption_allowed !== undefined) updateData.early_redemption_allowed = early_redemption_allowed
        if (early_redemption_terms !== undefined) updateData.early_redemption_terms = early_redemption_terms || ''
        if (put_option_available !== undefined) updateData.put_option_available = put_option_available
        if (call_option_available !== undefined) updateData.call_option_available = call_option_available
        if (currency !== undefined && currency !== '') updateData.currency = currency
        if (issue_size !== undefined && issue_size !== '') updateData.issue_size = issue_size
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
          FOR issuer IN ncd_bond_issuers
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
        const collection = getCollection('ncd_bond_issuers')
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
    console.error('Error importing NCD/Bond schemes from Excel:', error)
    
    // Cleanup uploaded file on error
    if (req.file) {
      try {
        const fs = await import('fs')
        fs.unlinkSync(req.file.path)
      } catch (unlinkErr) {
        console.error('Error deleting uploaded file:', unlinkErr)
      }
    }
    
    res.status(500).json({ error: 'Failed to import NCD/Bond schemes', detail: error.message })
  }
})

export default router

