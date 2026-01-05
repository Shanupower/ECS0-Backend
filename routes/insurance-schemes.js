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
  
  // Validate products
  if (data.products && Array.isArray(data.products)) {
    data.products.forEach((product, idx) => {
      // Min sum assured <= max sum assured
      if (product.min_sum_assured && product.max_sum_assured && product.min_sum_assured > product.max_sum_assured) {
        errors.push(`Product ${idx + 1}: min_sum_assured (${product.min_sum_assured}) must be <= max_sum_assured (${product.max_sum_assured})`)
      }
      
      // Min premium <= max premium
      if (product.min_premium && product.max_premium && product.min_premium > product.max_premium) {
        errors.push(`Product ${idx + 1}: min_premium (${product.min_premium}) must be <= max_premium (${product.max_premium})`)
      }
      
      // Min entry age <= max entry age
      if (product.min_entry_age && product.max_entry_age && product.min_entry_age > product.max_entry_age) {
        errors.push(`Product ${idx + 1}: min_entry_age (${product.min_entry_age}) must be <= max_entry_age (${product.max_entry_age})`)
      }
      
      // Min policy term <= max policy term
      if (product.policy_term_years_min && product.policy_term_years_max && product.policy_term_years_min > product.policy_term_years_max) {
        errors.push(`Product ${idx + 1}: policy_term_years_min (${product.policy_term_years_min}) must be <= policy_term_years_max (${product.policy_term_years_max})`)
      }
      
      // Min premium payment term <= max premium payment term
      if (product.premium_payment_term_min && product.premium_payment_term_max && product.premium_payment_term_min > product.premium_payment_term_max) {
        errors.push(`Product ${idx + 1}: premium_payment_term_min (${product.premium_payment_term_min}) must be <= premium_payment_term_max (${product.premium_payment_term_max})`)
      }
      
      // Validate riders
      if (product.riders && Array.isArray(product.riders)) {
        product.riders.forEach((rider, riderIdx) => {
          // Min sum assured <= max sum assured for rider
          if (rider.min_sum_assured && rider.max_sum_assured && rider.min_sum_assured > rider.max_sum_assured) {
            errors.push(`Product ${idx + 1}, Rider ${riderIdx + 1}: min_sum_assured must be <= max_sum_assured`)
          }
        })
      }
      
      // Date validations
      if (product.launch_date && product.withdrawal_date) {
        const launchDate = new Date(product.launch_date)
        const withdrawalDate = new Date(product.withdrawal_date)
        if (withdrawalDate <= launchDate) {
          errors.push(`Product ${idx + 1}: withdrawal_date must be after launch_date`)
        }
      }
    })
  }
  
  return errors
}

// ===================================
// READ OPERATIONS (Everyone can access)
// ===================================

// List all active insurance issuers
router.get('/issuers', async (req, res) => {
  try {
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer.is_active == true
      RETURN issuer
    `)
    
    res.json(issuers)
  } catch (error) {
    console.error('Error fetching insurance issuers:', error)
    // If collection doesn't exist, return empty array instead of error
    if (error.errorNum === 1203 || error.message?.includes('not found') || error.message?.includes('does not exist')) {
      console.warn('Collection insurance_issuers does not exist. Returning empty array.')
      return res.json([])
    }
    res.status(500).json({ error: 'Failed to fetch insurance issuers', details: error.message })
  }
})

// Get single issuer with all nested products and riders
router.get('/issuer/:issuer_key', async (req, res) => {
  try {
    const { issuer_key } = req.params
    
    const issuer = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuer || issuer.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    res.json(issuer[0])
  } catch (error) {
    console.error('Error fetching insurance issuer:', error)
    res.status(500).json({ error: 'Failed to fetch insurance issuer' })
  }
})

// Get products for an issuer (filter active by default)
router.get('/issuer/:issuer_key/products', async (req, res) => {
  try {
    const { issuer_key } = req.params
    const { active_only = 'true' } = req.query
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    let products = issuers[0].products || []
    
    if (active_only === 'true') {
      products = products.filter(p => p.is_active === true)
    }
    
    res.json(products)
  } catch (error) {
    console.error('Error fetching insurance products:', error)
    res.status(500).json({ error: 'Failed to fetch insurance products' })
  }
})

// Get single product with riders
router.get('/issuer/:issuer_key/product/:product_id', async (req, res) => {
  try {
    const { issuer_key, product_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const product = issuers[0].products?.find(p => p.product_id === product_id)
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    res.json(product)
  } catch (error) {
    console.error('Error fetching insurance product:', error)
    res.status(500).json({ error: 'Failed to fetch insurance product' })
  }
})

// Get riders for a product
router.get('/issuer/:issuer_key/product/:product_id/riders', async (req, res) => {
  try {
    const { issuer_key, product_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const product = issuers[0].products?.find(p => p.product_id === product_id)
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    const riders = product.riders || []
    res.json(riders)
  } catch (error) {
    console.error('Error fetching riders:', error)
    res.status(500).json({ error: 'Failed to fetch riders' })
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
          FOR issuer IN insurance_issuers
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
        FOR issuer IN insurance_issuers
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
      products: issuerData.products || []
    }
    
    const collection = getCollection('insurance_issuers')
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
      FOR issuer IN insurance_issuers
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
    
    // Validate if products are being updated
    if (updateData.products) {
      const validationErrors = validateBusinessRules(updatedIssuer)
      if (validationErrors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', details: validationErrors })
      }
    }
    
    const collection = getCollection('insurance_issuers')
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
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      REMOVE issuer IN insurance_issuers
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

// Add product to issuer
router.post('/issuer/:issuer_key/product', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key } = req.params
    const productData = req.body
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    
    // Check if product_id already exists
    if (issuer.products?.some(p => p.product_id === productData.product_id)) {
      return res.status(400).json({ error: 'Product with this ID already exists' })
    }
    
    const updatedIssuer = {
      ...issuer,
      products: [...(issuer.products || []), productData]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      console.error('Insurance Product validation errors:', validationErrors)
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('insurance_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(productData)
  } catch (error) {
    console.error('Error adding product:', error)
    res.status(500).json({ error: 'Failed to add product' })
  }
})

// Update product
router.put('/issuer/:issuer_key/product/:product_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, product_id } = req.params
    const updateData = req.body
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const productIndex = issuer.products?.findIndex(p => p.product_id === product_id)
    
    if (productIndex === -1 || productIndex === undefined) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    const updatedProduct = { ...issuer.products[productIndex], ...updateData }
    const updatedIssuer = {
      ...issuer,
      products: [
        ...issuer.products.slice(0, productIndex),
        updatedProduct,
        ...issuer.products.slice(productIndex + 1)
      ]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('insurance_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(updatedProduct)
  } catch (error) {
    console.error('Error updating product:', error)
    res.status(500).json({ error: 'Failed to update product' })
  }
})

// Delete product from issuer
router.delete('/issuer/:issuer_key/product/:product_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, product_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const productIndex = issuer.products?.findIndex(p => p.product_id === product_id)
    
    if (productIndex === -1 || productIndex === undefined) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    const updatedIssuer = {
      ...issuer,
      products: issuer.products.filter(p => p.product_id !== product_id)
    }
    
    const collection = getCollection('insurance_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json({ message: 'Product deleted successfully' })
  } catch (error) {
    console.error('Error deleting product:', error)
    res.status(500).json({ error: 'Failed to delete product' })
  }
})

// Add rider to product
router.post('/issuer/:issuer_key/product/:product_id/rider', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, product_id } = req.params
    const riderData = req.body
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const productIndex = issuer.products?.findIndex(p => p.product_id === product_id)
    
    if (productIndex === -1 || productIndex === undefined) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    const product = issuer.products[productIndex]
    
    // Check if rider_id already exists
    if (product.riders?.some(r => r.rider_id === riderData.rider_id)) {
      return res.status(400).json({ error: 'Rider with this ID already exists' })
    }
    
    const updatedProduct = {
      ...product,
      riders: [...(product.riders || []), riderData]
    }
    
    const updatedIssuer = {
      ...issuer,
      products: [
        ...issuer.products.slice(0, productIndex),
        updatedProduct,
        ...issuer.products.slice(productIndex + 1)
      ]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('insurance_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(riderData)
  } catch (error) {
    console.error('Error adding rider:', error)
    res.status(500).json({ error: 'Failed to add rider' })
  }
})

// Update rider
router.put('/issuer/:issuer_key/product/:product_id/rider/:rider_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, product_id, rider_id } = req.params
    const updateData = req.body
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const productIndex = issuer.products?.findIndex(p => p.product_id === product_id)
    
    if (productIndex === -1 || productIndex === undefined) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    const product = issuer.products[productIndex]
    const riderIndex = product.riders?.findIndex(r => r.rider_id === rider_id)
    
    if (riderIndex === -1 || riderIndex === undefined) {
      return res.status(404).json({ error: 'Rider not found' })
    }
    
    const updatedRider = { ...product.riders[riderIndex], ...updateData }
    const updatedProduct = {
      ...product,
      riders: [
        ...product.riders.slice(0, riderIndex),
        updatedRider,
        ...product.riders.slice(riderIndex + 1)
      ]
    }
    
    const updatedIssuer = {
      ...issuer,
      products: [
        ...issuer.products.slice(0, productIndex),
        updatedProduct,
        ...issuer.products.slice(productIndex + 1)
      ]
    }
    
    // Validate
    const validationErrors = validateBusinessRules(updatedIssuer)
    if (validationErrors.length > 0) {
      console.error('Validation errors when updating rider:', validationErrors)
      return res.status(400).json({ error: 'Validation failed', details: validationErrors })
    }
    
    const collection = getCollection('insurance_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json(updatedRider)
  } catch (error) {
    console.error('Error updating rider:', error)
    res.status(500).json({ error: 'Failed to update rider' })
  }
})

// Delete rider
router.delete('/issuer/:issuer_key/product/:product_id/rider/:rider_id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key, product_id, rider_id } = req.params
    
    const issuers = await q(`
      FOR issuer IN insurance_issuers
      FILTER issuer._key == @issuer_key
      RETURN issuer
    `, { issuer_key })
    
    if (!issuers || issuers.length === 0) {
      return res.status(404).json({ error: 'Issuer not found' })
    }
    
    const issuer = issuers[0]
    const productIndex = issuer.products?.findIndex(p => p.product_id === product_id)
    
    if (productIndex === -1 || productIndex === undefined) {
      return res.status(404).json({ error: 'Product not found' })
    }
    
    const product = issuer.products[productIndex]
    const updatedProduct = {
      ...product,
      riders: product.riders?.filter(r => r.rider_id !== rider_id) || []
    }
    
    const updatedIssuer = {
      ...issuer,
      products: [
        ...issuer.products.slice(0, productIndex),
        updatedProduct,
        ...issuer.products.slice(productIndex + 1)
      ]
    }
    
    const collection = getCollection('insurance_issuers')
    await collection.update(issuer_key, updatedIssuer)
    
    res.json({ message: 'Rider deleted successfully' })
  } catch (error) {
    console.error('Error deleting rider:', error)
    res.status(500).json({ error: 'Failed to delete rider' })
  }
})

// ===================================
// EXCEL IMPORT/EXPORT (Admin only)
// ===================================

// Export insurance schemes to Excel
router.get('/export/excel', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { issuer_key } = req.query // Optional: filter by issuer
    
    // Fetch issuers
    let issuers = []
    if (issuer_key) {
      const result = await q(`
        FOR issuer IN insurance_issuers
        FILTER issuer._key == @issuer_key
        RETURN issuer
      `, { issuer_key })
      issuers = result || []
    } else {
      issuers = await q(`FOR issuer IN insurance_issuers RETURN issuer`)
    }
    
    // Flatten products for export (one row per product)
    const flattenedProducts = []
    issuers.forEach(issuer => {
      if (issuer.products && Array.isArray(issuer.products)) {
        issuer.products.forEach(product => {
          flattenedProducts.push({
            issuer_key: issuer._key,
            issuer_legal_name: issuer.legal_name || '',
            issuer_short_name: issuer.short_name || '',
            issuer_type: issuer.type || '',
            product_id: product.product_id || '',
            product_name: product.product_name || '',
            category: product.category || '',
            sub_category: product.sub_category || '',
            description: product.description || '',
            policy_types: Array.isArray(product.policy_types) ? product.policy_types.join(', ') : '',
            min_sum_assured: product.min_sum_assured || '',
            max_sum_assured: product.max_sum_assured || '',
            min_premium: product.min_premium || '',
            max_premium: product.max_premium || '',
            min_entry_age: product.min_entry_age || '',
            max_entry_age: product.max_entry_age || '',
            policy_term_years_min: product.policy_term_years_min || '',
            policy_term_years_max: product.policy_term_years_max || '',
            premium_payment_frequency: Array.isArray(product.premium_payment_frequency) ? product.premium_payment_frequency.join(', ') : '',
            premium_payment_term_min: product.premium_payment_term_min || '',
            premium_payment_term_max: product.premium_payment_term_max || '',
            premium_payment_term_type: product.premium_payment_term_type || '',
            beneficiary_required: product.beneficiary_required ? 'Yes' : 'No',
            nomination_allowed: product.nomination_allowed ? 'Yes' : 'No',
            tax_benefits: Array.isArray(product.tax_benefits) ? product.tax_benefits.join(', ') : '',
            is_active: product.is_active !== false ? 'Yes' : 'No',
            launch_date: product.launch_date || '',
            withdrawal_date: product.withdrawal_date || '',
            cc: product.cc || 0,
            si: product.si || 0
          })
        })
      }
    })
    
    // Create workbook
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Insurance Products')
    
    // Define columns
    worksheet.columns = [
      { header: 'Issuer Key', key: 'issuer_key', width: 20 },
      { header: 'Issuer Legal Name', key: 'issuer_legal_name', width: 30 },
      { header: 'Issuer Short Name', key: 'issuer_short_name', width: 25 },
      { header: 'Issuer Type', key: 'issuer_type', width: 15 },
      { header: 'Product ID', key: 'product_id', width: 25 },
      { header: 'Product Name', key: 'product_name', width: 40 },
      { header: 'Category', key: 'category', width: 15 },
      { header: 'Sub Category', key: 'sub_category', width: 20 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Policy Types', key: 'policy_types', width: 30 },
      { header: 'Min Sum Assured', key: 'min_sum_assured', width: 18 },
      { header: 'Max Sum Assured', key: 'max_sum_assured', width: 18 },
      { header: 'Min Premium', key: 'min_premium', width: 15 },
      { header: 'Max Premium', key: 'max_premium', width: 15 },
      { header: 'Min Entry Age', key: 'min_entry_age', width: 15 },
      { header: 'Max Entry Age', key: 'max_entry_age', width: 15 },
      { header: 'Policy Term Min (Years)', key: 'policy_term_years_min', width: 20 },
      { header: 'Policy Term Max (Years)', key: 'policy_term_years_max', width: 20 },
      { header: 'Premium Payment Frequency', key: 'premium_payment_frequency', width: 25 },
      { header: 'Premium Payment Term Min', key: 'premium_payment_term_min', width: 22 },
      { header: 'Premium Payment Term Max', key: 'premium_payment_term_max', width: 22 },
      { header: 'Premium Payment Term Type', key: 'premium_payment_term_type', width: 25 },
      { header: 'Beneficiary Required', key: 'beneficiary_required', width: 20 },
      { header: 'Nomination Allowed', key: 'nomination_allowed', width: 20 },
      { header: 'Tax Benefits', key: 'tax_benefits', width: 25 },
      { header: 'Is Active', key: 'is_active', width: 12 },
      { header: 'Launch Date', key: 'launch_date', width: 15 },
      { header: 'Withdrawal Date', key: 'withdrawal_date', width: 15 },
      { header: 'CC %', key: 'cc', width: 12, style: { numFmt: '0.00000' } },
      { header: 'SI %', key: 'si', width: 12, style: { numFmt: '0.00000' } }
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
    flattenedProducts.forEach(product => {
      worksheet.addRow(product)
    })
    
    // Set response headers
    const filename = `insurance-schemes-export-${issuer_key || 'all'}-${new Date().toISOString().split('T')[0]}.xlsx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    
    await workbook.xlsx.write(res)
    res.end()
  } catch (error) {
    console.error('Error exporting insurance schemes to Excel:', error)
    res.status(500).json({ error: 'Failed to export insurance schemes', detail: error.message })
  }
})

// Import insurance schemes from Excel
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
        const product_id = row.getCell(5).value?.toString()?.trim()
        
        if (!issuer_key || !product_id) {
          errors.push({ row: rowNum, error: 'Missing issuer_key or product_id' })
          return
        }
        
        // Extract updatable fields
        const description = row.getCell(9).value?.toString()?.trim()
        const policy_types = row.getCell(10).value?.toString()?.trim()
        const min_sum_assured = row.getCell(11).value ? parseFloat(row.getCell(11).value) : null
        const max_sum_assured = row.getCell(12).value ? parseFloat(row.getCell(12).value) : null
        const min_premium = row.getCell(13).value ? parseFloat(row.getCell(13).value) : null
        const max_premium = row.getCell(14).value ? parseFloat(row.getCell(14).value) : null
        const min_entry_age = row.getCell(15).value ? parseInt(row.getCell(15).value) : null
        const max_entry_age = row.getCell(16).value ? parseInt(row.getCell(16).value) : null
        const policy_term_years_min = row.getCell(17).value ? parseInt(row.getCell(17).value) : null
        const policy_term_years_max = row.getCell(18).value ? parseInt(row.getCell(18).value) : null
        const premium_payment_frequency = row.getCell(19).value?.toString()?.trim()
        const premium_payment_term_min = row.getCell(20).value ? parseInt(row.getCell(20).value) : null
        const premium_payment_term_max = row.getCell(21).value ? parseInt(row.getCell(21).value) : null
        const premium_payment_term_type = row.getCell(22).value?.toString()?.trim()
        const beneficiary_required = row.getCell(23).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const nomination_allowed = row.getCell(24).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const tax_benefits = row.getCell(25).value?.toString()?.trim()
        const is_active = row.getCell(26).value?.toString()?.toLowerCase()?.trim() === 'yes'
        const launch_date = row.getCell(27).value?.toString()?.trim()
        const withdrawal_date = row.getCell(28).value?.toString()?.trim()
        
        let cc = 0
        const ccValue = row.getCell(29).value
        if (typeof ccValue === 'number') {
          cc = ccValue
        } else if (typeof ccValue === 'string') {
          cc = parseFloat(ccValue) || 0
        }
        
        let si = 0
        const siValue = row.getCell(30).value
        if (typeof siValue === 'number') {
          si = siValue
        } else if (typeof siValue === 'string') {
          si = parseFloat(siValue) || 0
        }
        
        // Build update object
        const updateData = {}
        if (description !== undefined && description !== '') updateData.description = description
        if (policy_types !== undefined && policy_types !== '') updateData.policy_types = policy_types.split(',').map(p => p.trim()).filter(p => p)
        if (min_sum_assured !== undefined && min_sum_assured !== null) updateData.min_sum_assured = min_sum_assured
        if (max_sum_assured !== undefined && max_sum_assured !== null) updateData.max_sum_assured = max_sum_assured
        if (min_premium !== undefined && min_premium !== null) updateData.min_premium = min_premium
        if (max_premium !== undefined && max_premium !== null) updateData.max_premium = max_premium
        if (min_entry_age !== undefined && min_entry_age !== null) updateData.min_entry_age = min_entry_age
        if (max_entry_age !== undefined && max_entry_age !== null) updateData.max_entry_age = max_entry_age
        if (policy_term_years_min !== undefined && policy_term_years_min !== null) updateData.policy_term_years_min = policy_term_years_min
        if (policy_term_years_max !== undefined && policy_term_years_max !== null) updateData.policy_term_years_max = policy_term_years_max
        if (premium_payment_frequency !== undefined && premium_payment_frequency !== '') updateData.premium_payment_frequency = premium_payment_frequency.split(',').map(f => f.trim()).filter(f => f)
        if (premium_payment_term_min !== undefined && premium_payment_term_min !== null) updateData.premium_payment_term_min = premium_payment_term_min
        if (premium_payment_term_max !== undefined && premium_payment_term_max !== null) updateData.premium_payment_term_max = premium_payment_term_max
        if (premium_payment_term_type !== undefined && premium_payment_term_type !== '') updateData.premium_payment_term_type = premium_payment_term_type
        if (beneficiary_required !== undefined) updateData.beneficiary_required = beneficiary_required
        if (nomination_allowed !== undefined) updateData.nomination_allowed = nomination_allowed
        if (tax_benefits !== undefined && tax_benefits !== '') updateData.tax_benefits = tax_benefits.split(',').map(t => t.trim()).filter(t => t)
        if (is_active !== undefined) updateData.is_active = is_active
        if (launch_date !== undefined && launch_date !== '') updateData.launch_date = launch_date
        if (withdrawal_date !== undefined && withdrawal_date !== '') updateData.withdrawal_date = withdrawal_date
        if (cc !== undefined) updateData.cc = cc
        if (si !== undefined) updateData.si = si
        
        updates.push({ issuer_key, product_id, updateData, row: rowNum })
      } catch (err) {
        errors.push({ row: rowNum, error: `Parsing error: ${err.message}` })
      }
    })
    
    // Batch update products
    let updated = 0
    let failed = 0
    
    for (const { issuer_key, product_id, updateData, row } of updates) {
      try {
        // Get issuer
        const issuers = await q(`
          FOR issuer IN insurance_issuers
          FILTER issuer._key == @issuer_key
          RETURN issuer
        `, { issuer_key })
        
        if (issuers.length === 0) {
          errors.push({ row, issuer_key, product_id, error: 'Issuer not found' })
          failed++
          continue
        }
        
        const issuer = issuers[0]
        const productIndex = issuer.products?.findIndex(p => p.product_id === product_id)
        
        if (productIndex === -1 || productIndex === undefined) {
          errors.push({ row, issuer_key, product_id, error: 'Product not found' })
          failed++
          continue
        }
        
        // Update product
        const updatedProducts = [...issuer.products]
        updatedProducts[productIndex] = {
          ...updatedProducts[productIndex],
          ...updateData
        }
        
        // Save updated issuer
        const collection = getCollection('insurance_issuers')
        await collection.update(issuer_key, {
          products: updatedProducts,
          updated_at: new Date().toISOString()
        })
        
        updated++
      } catch (err) {
        errors.push({ row, issuer_key, product_id, error: err.message })
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
    console.error('Error importing insurance schemes from Excel:', error)
    
    // Cleanup uploaded file on error
    if (req.file) {
      try {
        const fs = await import('fs')
        fs.unlinkSync(req.file.path)
      } catch (unlinkErr) {
        console.error('Error deleting uploaded file:', unlinkErr)
      }
    }
    
    res.status(500).json({ error: 'Failed to import insurance schemes', detail: error.message })
  }
})

export default router


