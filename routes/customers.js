import express from 'express'
import { q, getCollection, getUserBranch, normalizeBranchName, canAccessCustomer } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { uploadMultiple } from '../middleware/upload.js'

const router = express.Router()

// Customer search endpoint for receipt creation (branch-filtered)
router.get('/search', requireAuth, async (req, res) => {
  try {
    const { 
      q: searchQuery, 
      limit = '20', 
      page = '1',
      sort = 'name:asc'
    } = req.query
    
    if (!searchQuery || searchQuery.trim().length < 2) {
      return res.status(400).json({ error: 'invalid_query', detail: 'Search query must be at least 2 characters' })
    }

    // Get user's branch for filtering
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    const userRole = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: req.user.sub })

    const isAdmin = userRole.length > 0 && userRole[0] === 'admin'
    
    // Enhanced pagination with larger limits for search
    const searchLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 20))
    const searchPage = Math.max(1, parseInt(page, 10) || 1)
    const searchOffset = (searchPage - 1) * searchLimit

    // Enhanced sort options
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const allowedSort = new Set(['name', 'investor_id', 'created_at'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'name'

    let filterClause = ''
    let bindVars = { 
      searchQuery: `%${searchQuery}%`, 
      limit: searchLimit, 
      offset: searchOffset 
    }

    // Branch-based filtering (unless admin)
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER customer.relationship_manager == @userBranch`
      bindVars.userBranch = normalizedUserBranch
    }

    // Enhanced search filter with more fields and better performance
    const searchFilter = `
      FILTER (
        LOWER(customer.name) LIKE LOWER(@searchQuery) 
        OR customer.investor_id == @exactId
        OR LOWER(customer.pan) LIKE LOWER(@searchQuery) 
        OR LOWER(customer.email) LIKE LOWER(@searchQuery)
        OR LOWER(customer.mobile) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address1) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address2) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address3) LIKE LOWER(@searchQuery)
        OR LOWER(customer.city) LIKE LOWER(@searchQuery)
        OR LOWER(customer.state) LIKE LOWER(@searchQuery)
      )
    `
    
    // Add exact ID search for better performance when searching by ID
    const exactId = parseInt(searchQuery.trim())
    if (!isNaN(exactId)) {
      bindVars.exactId = exactId
    } else {
      bindVars.exactId = -1 // Invalid ID to ensure no matches
    }
    
    if (filterClause) {
      filterClause += ` AND (
        LOWER(customer.name) LIKE LOWER(@searchQuery) 
        OR customer.investor_id == @exactId
        OR LOWER(customer.pan) LIKE LOWER(@searchQuery) 
        OR LOWER(customer.email) LIKE LOWER(@searchQuery)
        OR LOWER(customer.mobile) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address1) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address2) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address3) LIKE LOWER(@searchQuery)
        OR LOWER(customer.city) LIKE LOWER(@searchQuery)
        OR LOWER(customer.state) LIKE LOWER(@searchQuery)
      )`
    } else {
      filterClause = searchFilter
    }

    const query = `
      FOR customer IN customers
      ${filterClause}
      SORT customer.${orderBy} ${sortDir}
      LIMIT @offset, @limit
      RETURN {
        investor_id: customer.investor_id,
        name: customer.name,
        pan: customer.pan,
        mobile: customer.mobile,
        email: customer.email,
        address1: customer.address1,
        city: customer.city,
        state: customer.state,
        relationship_manager: customer.relationship_manager,
        created_at: customer.created_at
      }
    `

    const countQuery = `
      FOR customer IN customers
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.offset

    const [customers, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])
    
    const total = totalResult[0] || 0
    const totalPages = Math.ceil(total / searchLimit)
    
    res.json({
      customers,
      pagination: {
        page: searchPage,
        limit: searchLimit,
        total,
        totalPages,
        hasNext: searchPage < totalPages,
        hasPrev: searchPage > 1
      },
      branch_filter: !isAdmin ? normalizedUserBranch : 'all',
      user_role: isAdmin ? 'admin' : 'branch_user'
    })
  } catch (error) {
    console.error('Error searching customers:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Advanced search endpoint with fulltext search capabilities
router.get('/search/advanced', requireAuth, async (req, res) => {
  try {
    const { 
      q: searchQuery, 
      limit = '20', 
      page = '1',
      sort = 'name:asc',
      useFulltext = 'true'
    } = req.query
    
    if (!searchQuery || searchQuery.trim().length < 2) {
      return res.status(400).json({ error: 'invalid_query', detail: 'Search query must be at least 2 characters' })
    }

    // Get user's branch for filtering
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    const userRole = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: req.user.sub })

    const isAdmin = userRole.length > 0 && userRole[0] === 'admin'
    
    // Enhanced pagination with larger limits for search
    const searchLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 20))
    const searchPage = Math.max(1, parseInt(page, 10) || 1)
    const searchOffset = (searchPage - 1) * searchLimit

    // Enhanced sort options
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const allowedSort = new Set(['name', 'investor_id', 'created_at'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'name'

    let query, bindVars

    if (useFulltext === 'true') {
      // Use fulltext search for better performance
      query = `
        FOR customer IN FULLTEXT(customers, 'name', @searchQuery)
        ${!isAdmin && normalizedUserBranch ? 'FILTER customer.relationship_manager == @userBranch' : ''}
        SORT customer.${orderBy} ${sortDir}
        LIMIT @offset, @limit
        RETURN {
          investor_id: customer.investor_id,
          name: customer.name,
          pan: customer.pan,
          mobile: customer.mobile,
          email: customer.email,
          address1: customer.address1,
          city: customer.city,
          state: customer.state,
          relationship_manager: customer.relationship_manager,
          created_at: customer.created_at
        }
      `

      bindVars = {
        searchQuery: searchQuery.trim(),
        limit: searchLimit,
        offset: searchOffset
      }

      if (!isAdmin && normalizedUserBranch) {
        bindVars.userBranch = normalizedUserBranch
      }
    } else {
      // Fallback to regular search
      let filterClause = ''
      bindVars = { 
        searchQuery: `%${searchQuery}%`, 
        limit: searchLimit, 
        offset: searchOffset 
      }

      // Branch-based filtering (unless admin)
      if (!isAdmin && normalizedUserBranch) {
        filterClause = `FILTER customer.relationship_manager == @userBranch`
        bindVars.userBranch = normalizedUserBranch
      }

      // Enhanced search filter
      const searchFilter = `
        FILTER (
          LOWER(customer.name) LIKE LOWER(@searchQuery) 
          OR customer.investor_id == @exactId
          OR LOWER(customer.pan) LIKE LOWER(@searchQuery) 
          OR LOWER(customer.email) LIKE LOWER(@searchQuery)
          OR LOWER(customer.mobile) LIKE LOWER(@searchQuery)
          OR LOWER(customer.address1) LIKE LOWER(@searchQuery)
          OR LOWER(customer.address2) LIKE LOWER(@searchQuery)
          OR LOWER(customer.address3) LIKE LOWER(@searchQuery)
          OR LOWER(customer.city) LIKE LOWER(@searchQuery)
          OR LOWER(customer.state) LIKE LOWER(@searchQuery)
        )
      `
      
      // Add exact ID search for better performance when searching by ID
      const exactId = parseInt(searchQuery.trim())
      if (!isNaN(exactId)) {
        bindVars.exactId = exactId
      } else {
        bindVars.exactId = -1 // Invalid ID to ensure no matches
      }
      
      if (filterClause) {
        filterClause += ` AND (
          LOWER(customer.name) LIKE LOWER(@searchQuery) 
          OR customer.investor_id == @exactId
          OR LOWER(customer.pan) LIKE LOWER(@searchQuery) 
          OR LOWER(customer.email) LIKE LOWER(@searchQuery)
          OR LOWER(customer.mobile) LIKE LOWER(@searchQuery)
          OR LOWER(customer.address1) LIKE LOWER(@searchQuery)
          OR LOWER(customer.address2) LIKE LOWER(@searchQuery)
          OR LOWER(customer.address3) LIKE LOWER(@searchQuery)
          OR LOWER(customer.city) LIKE LOWER(@searchQuery)
          OR LOWER(customer.state) LIKE LOWER(@searchQuery)
        )`
      } else {
        filterClause = searchFilter
      }

      query = `
        FOR customer IN customers
        ${filterClause}
        SORT customer.${orderBy} ${sortDir}
        LIMIT @offset, @limit
        RETURN {
          investor_id: customer.investor_id,
          name: customer.name,
          pan: customer.pan,
          mobile: customer.mobile,
          email: customer.email,
          address1: customer.address1,
          city: customer.city,
          state: customer.state,
          relationship_manager: customer.relationship_manager,
          created_at: customer.created_at
        }
      `
    }

    const countQuery = useFulltext === 'true' ? `
      FOR customer IN FULLTEXT(customers, 'name', @searchQuery)
      ${!isAdmin && normalizedUserBranch ? 'FILTER customer.relationship_manager == @userBranch' : ''}
      COLLECT WITH COUNT INTO total
      RETURN total
    ` : `
      FOR customer IN customers
      ${!isAdmin && normalizedUserBranch ? 'FILTER customer.relationship_manager == @userBranch' : ''}
      FILTER (
        LOWER(customer.name) LIKE LOWER(@searchQuery) 
        OR customer.investor_id == @exactId
        OR LOWER(customer.pan) LIKE LOWER(@searchQuery) 
        OR LOWER(customer.email) LIKE LOWER(@searchQuery)
        OR LOWER(customer.mobile) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address1) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address2) LIKE LOWER(@searchQuery)
        OR LOWER(customer.address3) LIKE LOWER(@searchQuery)
        OR LOWER(customer.city) LIKE LOWER(@searchQuery)
        OR LOWER(customer.state) LIKE LOWER(@searchQuery)
      )
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.offset

    const [customers, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])
    
    const total = totalResult[0] || 0
    const totalPages = Math.ceil(total / searchLimit)
    
    res.json({
      customers,
      pagination: {
        page: searchPage,
        limit: searchLimit,
        total,
        totalPages,
        hasNext: searchPage < totalPages,
        hasPrev: searchPage > 1
      },
      branch_filter: !isAdmin ? normalizedUserBranch : 'all',
      user_role: isAdmin ? 'admin' : 'branch_user',
      search_method: useFulltext === 'true' ? 'fulltext' : 'regular'
    })
  } catch (error) {
    console.error('Error in advanced customer search:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get all customers with filtering
router.get('/', requireAuth, async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      search,
      includeDeleted = '0'
    } = req.query

    // Get user's branch for filtering
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    const userRole = await q(`
      FOR user IN users 
      FILTER user._key == @id
      LIMIT 1
      RETURN user.role
    `, { id: req.user.sub })

    const isAdmin = userRole.length > 0 && userRole[0] === 'admin'

    // Sanitize pagination
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))

    // Sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'name', 'investor_id'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }

    // Branch-based filtering (unless admin)
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER customer.relationship_manager == @userBranch`
      bindVars.userBranch = normalizedUserBranch
    }

    // Search functionality
    if (search) {
      const searchFilter = `
        FILTER customer.name LIKE @search 
           OR customer.investor_id LIKE @search 
           OR customer.pan LIKE @search 
           OR customer.email LIKE @search 
           OR customer.mobile LIKE @search
      `
      
      if (filterClause) {
        filterClause += ` AND (customer.name LIKE @search 
           OR customer.investor_id LIKE @search 
           OR customer.pan LIKE @search 
           OR customer.email LIKE @search 
           OR customer.mobile LIKE @search)`
      } else {
        filterClause = searchFilter
      }
      bindVars.search = `%${search}%`
    }

    const query = `
      FOR customer IN customers
      ${filterClause}
      SORT customer.${orderBy} ${sortDir}
      LIMIT @offset, @limit
      RETURN customer
    `

    const countQuery = `
      FOR customer IN customers
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.offset

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ 
      page: numPage, 
      size: numLimit, 
      total, 
      items: rows,
      branch_filter: !isAdmin ? normalizedUserBranch : 'all',
      user_role: isAdmin ? 'admin' : 'branch_user'
    })
  } catch (error) {
    console.error('Error fetching customers:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get single customer
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    console.log(`[Customer Get] Fetching customer ID: ${id}, User: ${req.user.sub}`)
    
    // Validate and convert ID to number
    if (!id || isNaN(Number(id))) {
      console.log(`[Customer Get] Invalid customer ID: ${id}`)
      return res.status(400).json({ error: 'invalid_customer_id', detail: 'Customer ID must be a valid number' })
    }
    
    const customerId = Number(id)
    console.log(`[Customer Get] Converted ID to number: ${customerId}`)
    
    // Check if customer exists
    console.log(`[Customer Get] Searching for customer...`)
    const customers = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id: customerId })
    
    if (!customers.length) {
      console.log(`[Customer Get] Customer not found: ${customerId}`)
      return res.status(404).json({ error: 'not_found', detail: `Customer with ID ${customerId} not found` })
    }
    
    const customer = customers[0]
    console.log(`[Customer Get] Found customer: ${customer.investor_id} - ${customer.name || customer.investor_name}`)
    
    // Check if user can access this customer (branch-based filtering)
    console.log(`[Customer Get] Checking access permissions...`)
    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
      console.log(`[Customer Get] Access check result: ${canAccess}`)
      
      if (!canAccess) {
        console.log(`[Customer Get] Access denied for user ${req.user.sub} to customer ${customerId}`)
        return res.status(403).json({ 
          error: 'forbidden', 
          detail: 'Access denied - customer belongs to different branch',
          customer_branch: customer.relationship_manager,
          user_id: req.user.sub
        })
      }
    } catch (accessError) {
      console.error(`[Customer Get] Access check failed:`, accessError)
      return res.status(500).json({ 
        error: 'access_check_failed', 
        detail: 'Failed to verify access permissions',
        error_message: accessError.message
      })
    }
    
    console.log(`[Customer Get] Successfully returning customer ${customerId}`)
    res.json(customer)
    
  } catch (error) {
    console.error(`[Customer Get] Error fetching customer ${req.params.id}:`, {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errorNum: error.errorNum
    })
    
    // Provide more specific error messages
    let errorMessage = error.message
    let statusCode = 500
    
    if (error.code === 1203) {
      errorMessage = 'Database connection failed'
      statusCode = 503
    } else if (error.code === 400) {
      errorMessage = 'Invalid query syntax'
      statusCode = 500
    } else if (error.message && error.message.includes('not found')) {
      statusCode = 404
    }
    
    res.status(statusCode).json({ 
      error: 'server_error', 
      detail: errorMessage,
      error_code: error.code,
      error_num: error.errorNum,
      customer_id: req.params.id
    })
  }
})

// Create new customer
router.post('/', requireAuth, uploadMultiple, async (req, res) => {
  try {
    const {
      name,
      pan,
      email,
      mobile,
      address1,
      address2,
      address3,
      city,
      state,
      pin,
      date_of_birth,
      father_name,
      mother_name,
      occupation,
      annual_income,
      aadhar_number,
      title,
      country
    } = req.body || {}

    if (!name) {
      return res.status(400).json({ error: 'missing_fields', detail: 'Customer name is required' })
    }

    // Get user's branch to assign as relationship manager
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    if (!normalizedUserBranch) {
      return res.status(400).json({ error: 'invalid_user', detail: 'User branch not found' })
    }

    // Check if PAN already exists (if provided)
    if (pan && pan.trim() !== '') {
      const existingPan = await q(`
        FOR customer IN customers 
        FILTER customer.pan == @pan
        LIMIT 1
        RETURN customer.investor_id
      `, { pan })
      if (existingPan.length) {
        return res.status(400).json({ error: 'duplicate_pan', detail: 'PAN number already exists' })
      }
    }

    // Get the next investor_id
    const maxIdResult = await q(`
      FOR customer IN customers
      COLLECT AGGREGATE maxId = MAX(customer.investor_id)
      RETURN maxId
    `)
    const nextId = (maxIdResult[0] || 0) + 1

    // Handle uploaded media files
    let mediaDocuments = []
    if (req.files && req.files.length > 0) {
      mediaDocuments = req.files.map(file => ({
        id: Date.now() + Math.random(),
        original_name: file.originalname,
        filename: file.filename,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: req.user.sub,
        uploaded_at: new Date().toISOString(),
        file_path: file.path
      }))
    }

    const customerDoc = {
      investor_id: nextId,
      title: title || null,
      name,
      pan: pan && pan.trim() !== '' ? pan : null,
      email: email || null,
      mobile: mobile || null,
      address1: address1 || null,
      address2: address2 || null,
      address3: address3 || null,
      city: city || null,
      state: state || null,
      pin: pin || null,
      country: country || 'India',
      date_of_birth: date_of_birth || null,
      father_name: father_name || null,
      mother_name: mother_name || null,
      occupation: occupation || null,
      annual_income: annual_income ? Number(annual_income) : null,
      aadhar_number: aadhar_number || null,
      media_documents: mediaDocuments,
      relationship_manager: normalizedUserBranch, // Auto-assign user's branch
      created_at: new Date().toISOString(),
      is_active: true,
      source_type: 'manual_entry'
    }

    const result = await getCollection('customers').save(customerDoc)
    res.status(201).json({ 
      investor_id: nextId,
      relationship_manager: normalizedUserBranch,
      media_files: mediaDocuments.length,
      message: 'Customer created and assigned to your branch'
    })
  } catch (error) {
    console.error('Error creating customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Update customer
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    console.log(`[Customer Update] Starting update for customer ID: ${id}, User: ${req.user.sub}`)
    
    // Validate input
    if (!id || isNaN(Number(id))) {
      console.log(`[Customer Update] Invalid customer ID: ${id}`)
      return res.status(400).json({ error: 'invalid_customer_id', detail: 'Customer ID must be a valid number' })
    }

    const {
      name,
      pan,
      email,
      mobile,
      address1,
      address2,
      address3,
      city,
      state,
      pin,
      date_of_birth,
      father_name,
      mother_name,
      occupation,
      annual_income,
      aadhar_number
    } = req.body || {}

    console.log(`[Customer Update] Request body fields:`, Object.keys(req.body || {}))

    // Check if customer exists and get full customer data
    console.log(`[Customer Update] Checking if customer exists...`)
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id: Number(id) })
    
    if (!existing.length) {
      console.log(`[Customer Update] Customer not found: ${id}`)
      return res.status(404).json({ error: 'not_found', detail: `Customer with ID ${id} not found` })
    }

    const customer = existing[0]
    console.log(`[Customer Update] Found customer: ${customer.investor_id} - ${customer.name || customer.investor_name}`)
    
    // Check if user can access this customer (branch-based filtering)
    console.log(`[Customer Update] Checking access permissions...`)
    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
      console.log(`[Customer Update] Access check result: ${canAccess}`)
      
      if (!canAccess) {
        console.log(`[Customer Update] Access denied for user ${req.user.sub} to customer ${id}`)
        return res.status(403).json({ 
          error: 'forbidden', 
          detail: 'Access denied - customer belongs to different branch',
          customer_branch: customer.relationship_manager,
          user_id: req.user.sub
        })
      }
    } catch (accessError) {
      console.error(`[Customer Update] Access check failed:`, accessError)
      return res.status(500).json({ 
        error: 'access_check_failed', 
        detail: 'Failed to verify access permissions',
        error_message: accessError.message
      })
    }

    // Check if PAN already exists for another customer (if provided)
    if (pan && pan.trim() !== '') {
      console.log(`[Customer Update] Checking PAN uniqueness: ${pan}`)
      try {
        const existingPan = await q(`
          FOR customer IN customers 
          FILTER customer.pan == @pan AND customer.investor_id != @id
          LIMIT 1
          RETURN customer.investor_id
        `, { pan: pan.trim().toUpperCase(), id: Number(id) })
        
        if (existingPan.length) {
          console.log(`[Customer Update] PAN already exists for customer: ${existingPan[0]}`)
          return res.status(400).json({ 
            error: 'duplicate_pan', 
            detail: `PAN number already exists for customer ID ${existingPan[0]}` 
          })
        }
      } catch (panError) {
        console.error(`[Customer Update] PAN check failed:`, panError)
        return res.status(500).json({ 
          error: 'pan_check_failed', 
          detail: 'Failed to verify PAN uniqueness',
          error_message: panError.message
        })
      }
    }

    // Build updates object
    const updates = {}
    if (name !== undefined) updates.name = name
    if (pan !== undefined) updates.pan = pan && pan.trim() !== '' ? pan.trim().toUpperCase() : null
    if (email !== undefined) updates.email = email
    if (mobile !== undefined) updates.mobile = mobile
    if (address1 !== undefined) updates.address1 = address1
    if (address2 !== undefined) updates.address2 = address2
    if (address3 !== undefined) updates.address3 = address3
    if (city !== undefined) updates.city = city
    if (state !== undefined) updates.state = state
    if (pin !== undefined) updates.pin = pin
    if (date_of_birth !== undefined) updates.date_of_birth = date_of_birth
    if (father_name !== undefined) updates.father_name = father_name
    if (mother_name !== undefined) updates.mother_name = mother_name
    if (occupation !== undefined) updates.occupation = occupation
    if (annual_income !== undefined) updates.annual_income = annual_income ? Number(annual_income) : null
    if (aadhar_number !== undefined) updates.aadhar_number = aadhar_number

    // Add update timestamp
    updates.updated_at = new Date().toISOString()

    console.log(`[Customer Update] Update fields:`, Object.keys(updates))

    if (Object.keys(updates).length === 1) { // Only updated_at
      console.log(`[Customer Update] No fields to update`)
      return res.status(400).json({ error: 'no_updates', detail: 'No valid fields provided for update' })
    }

    // Perform the update
    console.log(`[Customer Update] Executing update query...`)
    const updateResult = await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      UPDATE customer WITH @updates IN customers
      RETURN NEW
    `, { id: Number(id), updates })

    if (!updateResult || updateResult.length === 0) {
      console.log(`[Customer Update] Update query returned no results`)
      return res.status(500).json({ 
        error: 'update_failed', 
        detail: 'Customer update query did not affect any records' 
      })
    }

    console.log(`[Customer Update] Successfully updated customer ${id}`)
    res.status(204).end()
    
  } catch (error) {
    console.error(`[Customer Update] Error updating customer ${req.params.id}:`, {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errorNum: error.errorNum
    })
    
    // Provide more specific error messages
    let errorMessage = error.message
    let statusCode = 500
    
    if (error.code === 1203) {
      errorMessage = 'Database connection failed'
      statusCode = 503
    } else if (error.code === 400) {
      errorMessage = 'Invalid query syntax'
      statusCode = 500
    } else if (error.message && error.message.includes('not found')) {
      statusCode = 404
    }
    
    res.status(statusCode).json({ 
      error: 'server_error', 
      detail: errorMessage,
      error_code: error.code,
      error_num: error.errorNum,
      customer_id: req.params.id
    })
  }
})

// Delete customer
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id

    // Check if customer exists and get full customer data
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id })
    if (!existing.length) {
      return res.status(404).json({ error: 'not_found' })
    }

    const customer = existing[0]
    
    // Check if user can access this customer (branch-based filtering)
    const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
    if (!canAccess) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied - customer belongs to different branch' })
    }

    // Check if customer has any receipts
    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.investor_id == @id AND receipt.is_deleted == false
      COLLECT WITH COUNT INTO count
      RETURN count
    `, { id })
    if (receipts[0] > 0) {
      return res.status(400).json({ 
        error: 'cannot_delete', 
        detail: `Cannot delete customer with ${receipts[0]} associated receipts` 
      })
    }

    // Hard delete since customers table doesn't have soft delete columns
    await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      REMOVE customer IN customers
    `, { id })

    res.status(204).end()
  } catch (error) {
    console.error('Error deleting customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
