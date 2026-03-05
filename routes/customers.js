import express from 'express'
import { q, getCollection, getUserBranch, normalizeBranchName, canAccessCustomer } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { uploadMultiple } from '../middleware/upload.js'
import { validatePAN, validateEmail, validateMobile, validateAadhar, validatePIN, validateRequired, validateMinorsArray } from '../utils/validators.js'

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
      searchQuery: `%${searchQuery}%`
    }

    // Branch-based filtering (unless admin)
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER (
        (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
        (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
      )`
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

    // Search query for major customers (with minors included in response)
    const customerQuery = `
      FOR customer IN customers
      ${filterClause}
      LET customerResult = {
        investor_id: customer.investor_id,
        name: customer.name,
        pan: customer.pan,
        mobile: customer.mobile,
        email: customer.email,
        address1: customer.address1,
        city: customer.city,
        state: customer.state,
        relationship_manager: customer.relationship_manager,
        relationship_manager_display: customer.relationship_manager_display,
        created_at: customer.created_at,
        minors: customer.minors || []
      }
      LIMIT ${searchOffset}, ${searchLimit}
      RETURN customerResult
    `
    
    // Search query for minors (flat format); use (customer.minors || []) so FOR never iterates over null
    const minorSearchFilter = !isAdmin && normalizedUserBranch ? `
      FILTER (
        (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
        (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
      ) AND (
        customer.minors != null && LENGTH(customer.minors) > 0
      ) AND (
        FOR minor IN (customer.minors != null ? customer.minors : [])
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        RETURN true
      )[0] == true
    ` : `
      FILTER (
        customer.minors != null && LENGTH(customer.minors) > 0
      ) AND (
        FOR minor IN (customer.minors != null ? customer.minors : [])
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        RETURN true
      )[0] == true
    `
    
    const minorQuery = `
      FOR customer IN customers
      ${minorSearchFilter}
      FOR minor IN (customer.minors != null ? customer.minors : [])
      FILTER (
        LOWER(minor.name) LIKE LOWER(@searchQuery)
        OR minor.investor_id == @exactId
        OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
      )
      LIMIT ${searchOffset}, ${searchLimit}
      RETURN {
        investor_id: minor.investor_id,
        name: minor.name,
        pan: minor.pan,
        mobile: null,
        email: null,
        address1: minor.address1,
        city: minor.city,
        state: minor.state,
        relationship_manager: customer.relationship_manager,
        relationship_manager_display: customer.relationship_manager_display,
        created_at: minor.created_at,
        is_minor: true,
        parent_investor_id: customer.investor_id,
        parent_name: customer.name,
        use_same_address: minor.use_same_address || false,
        relationship_type: minor.relationship_type
      }
    `

    const countQuery = `
      LET customerCount = (
        FOR customer IN customers
        ${filterClause}
        COLLECT WITH COUNT INTO total
        RETURN total
      )[0] || 0
      
      LET minorCount = (
        FOR customer IN customers
        ${minorSearchFilter}
        FOR minor IN (customer.minors != null ? customer.minors : [])
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        COLLECT WITH COUNT INTO total
        RETURN total
      )[0] || 0
      
      RETURN customerCount + minorCount
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.pageSkip

    const [customersResult, minorsResult, totalResult] = await Promise.all([
      q(customerQuery, bindVars),
      q(minorQuery, bindVars),
      q(countQuery, countBindVars)
    ])
    
    // Combine results: customers with their minors, plus flat minor entries
    const customers = customersResult
    const minors = minorsResult
    
    const total = totalResult[0] || 0
    const totalPages = Math.ceil(total / searchLimit)
    
    res.json({
      customers, // Major customers (with minors nested)
      minors, // Minors as separate flat entries
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
        ${!isAdmin && normalizedUserBranch ? 'FILTER ((IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) || (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch))' : ''}
        SORT customer.${orderBy} ${sortDir}
        LIMIT ${searchOffset}, ${searchLimit}
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
          relationship_manager_display: customer.relationship_manager_display,
          created_at: customer.created_at
        }
      `

      bindVars = {
        searchQuery: searchQuery.trim()
      }

      if (!isAdmin && normalizedUserBranch) {
        bindVars.userBranch = normalizedUserBranch
      }
    } else {
      // Fallback to regular search
      let filterClause = ''
      bindVars = { 
        searchQuery: `%${searchQuery}%`
      }

      // Branch-based filtering (unless admin)
      // Support both single branch (string) and multiple branches (array)
      if (!isAdmin && normalizedUserBranch) {
        filterClause = `FILTER (
          (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
          (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
        )`
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
        LET customerResult = {
          investor_id: customer.investor_id,
          name: customer.name,
          pan: customer.pan,
          mobile: customer.mobile,
          email: customer.email,
          address1: customer.address1,
          city: customer.city,
          state: customer.state,
          relationship_manager: customer.relationship_manager,
          relationship_manager_display: customer.relationship_manager_display,
          created_at: customer.created_at,
          minors: customer.minors || []
        }
        RETURN customerResult
      `
    }
    
    // Minor search query (same for both fulltext and regular)
    const exactId = parseInt(searchQuery.trim())
    const exactIdForMinors = !isNaN(exactId) ? exactId : -1
    
    const minorSearchFilter = !isAdmin && normalizedUserBranch ? `
      FILTER (
        (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
        (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
      ) AND (
        customer.minors != null && LENGTH(customer.minors) > 0
      ) AND (
        FOR minor IN customer.minors
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        RETURN true
      )[0] == true
    ` : `
      FILTER (
        customer.minors != null && LENGTH(customer.minors) > 0
      ) AND (
        FOR minor IN customer.minors
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        RETURN true
      )[0] == true
    `
    
    const minorQuery = `
      FOR customer IN customers
      ${minorSearchFilter}
      FOR minor IN customer.minors
      FILTER (
        LOWER(minor.name) LIKE LOWER(@searchQuery)
        OR minor.investor_id == @exactId
        OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
      )
      RETURN {
        investor_id: minor.investor_id,
        name: minor.name,
        pan: minor.pan,
        mobile: null,
        email: null,
        address1: minor.address1,
        city: minor.city,
        state: minor.state,
        relationship_manager: customer.relationship_manager,
        relationship_manager_display: customer.relationship_manager_display,
        created_at: minor.created_at,
        is_minor: true,
        parent_investor_id: customer.investor_id,
        parent_name: customer.name,
        use_same_address: minor.use_same_address || false,
        relationship_type: minor.relationship_type
      }
    `
    
    // Add exactId to bindVars for minor search
    const minorBindVars = { ...bindVars }
    if (!minorBindVars.exactId) {
      minorBindVars.exactId = exactIdForMinors
    }
    if (typeof minorBindVars.searchQuery === 'string' && !minorBindVars.searchQuery.includes('%')) {
      minorBindVars.searchQuery = `%${minorBindVars.searchQuery}%`
    }

    const countQuery = useFulltext === 'true' ? `
      LET customerCount = (
        FOR customer IN FULLTEXT(customers, 'name', @searchQuery)
        ${!isAdmin && normalizedUserBranch ? 'FILTER ((IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) || (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch))' : ''}
        COLLECT WITH COUNT INTO total
        RETURN total
      )[0] || 0
      
      LET minorCount = (
        FOR customer IN customers
        ${minorSearchFilter}
        FOR minor IN customer.minors
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        COLLECT WITH COUNT INTO total
        RETURN total
      )[0] || 0
      
      RETURN customerCount + minorCount
    ` : `
      LET customerCount = (
        FOR customer IN customers
        ${!isAdmin && normalizedUserBranch ? 'FILTER ((IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) || (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch))' : ''}
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
      )[0] || 0
      
      LET minorCount = (
        FOR customer IN customers
        ${minorSearchFilter}
        FOR minor IN customer.minors
        FILTER (
          LOWER(minor.name) LIKE LOWER(@searchQuery)
          OR minor.investor_id == @exactId
          OR (minor.pan != null && LOWER(minor.pan) LIKE LOWER(@searchQuery))
        )
        COLLECT WITH COUNT INTO total
        RETURN total
      )[0] || 0
      
      RETURN customerCount + minorCount
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.pageSkip
    if (!countBindVars.exactId) {
      countBindVars.exactId = exactIdForMinors
    }
    if (typeof countBindVars.searchQuery === 'string' && !countBindVars.searchQuery.includes('%')) {
      countBindVars.searchQuery = `%${countBindVars.searchQuery}%`
    }

    const [customersResult, minorsResult, totalResult] = await Promise.all([
      q(query, bindVars),
      q(minorQuery, minorBindVars),
      q(countQuery, countBindVars)
    ])
    
    const customers = customersResult
    const minors = minorsResult
    
    const total = totalResult[0] || 0
    const totalPages = Math.ceil(total / searchLimit)
    
    res.json({
      customers, // Major customers (with minors nested)
      minors, // Minors as separate flat entries
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
    let bindVars = { }

    // Branch-based filtering (unless admin)
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER (
        (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
        (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
      )`
      bindVars.userBranch = normalizedUserBranch
    }

    // Search functionality (case-insensitive)
    if (search) {
      const searchFilter = `
        FILTER LOWER(customer.name) LIKE LOWER(@search)
           OR LOWER(customer.investor_id) LIKE LOWER(@search)
           OR LOWER(customer.pan) LIKE LOWER(@search)
           OR LOWER(customer.email) LIKE LOWER(@search)
           OR LOWER(customer.mobile) LIKE LOWER(@search)
      `
      
      if (filterClause) {
        filterClause += ` AND (LOWER(customer.name) LIKE LOWER(@search)
           OR LOWER(customer.investor_id) LIKE LOWER(@search)
           OR LOWER(customer.pan) LIKE LOWER(@search)
           OR LOWER(customer.email) LIKE LOWER(@search)
           OR LOWER(customer.mobile) LIKE LOWER(@search))`
      } else {
        filterClause = searchFilter
      }
      bindVars.search = `%${search}%`
    }

    const query = `
      FOR customer IN customers
      ${filterClause}
      SORT customer.${orderBy} ${sortDir}
      LIMIT ${numOffset}, ${numLimit}
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
    delete countBindVars.pageSkip

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

// Portfolio review: list customers with last_reviewed_at / next_review_due and optional filter
router.get('/portfolio-review', requireAuth, async (req, res) => {
  try {
    const { review_filter = 'all', page = '1', size = '50', search } = req.query
    const userBranch = await getUserBranch(req.user.sub)
    const normalizedUserBranch = normalizeBranchName(userBranch)
    const userRole = await q(`
      FOR user IN users FILTER user._key == @id LIMIT 1 RETURN user.role
    `, { id: req.user.sub })
    const isAdmin = userRole.length > 0 && userRole[0] === 'admin'

    let filterClause = ''
    const bindVars = {}
    if (!isAdmin && normalizedUserBranch) {
      filterClause = `FILTER (
        (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
        (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
      )`
      bindVars.userBranch = normalizedUserBranch
    }

    const searchTerm = typeof search === 'string' ? search.trim() : ''
    if (searchTerm.length > 0) {
      const searchLower = searchTerm.toLowerCase()
      bindVars.searchLower = searchLower
      const searchFilter = `(
        (customer.name != null && CONTAINS(LOWER(TO_STRING(customer.name)), @searchLower)) ||
        (customer.mobile != null && CONTAINS(LOWER(TO_STRING(customer.mobile)), @searchLower)) ||
        (customer.email != null && CONTAINS(LOWER(TO_STRING(customer.email)), @searchLower))
      )`
      filterClause += (filterClause ? ' AND ' : 'FILTER ') + searchFilter
    }

    const today = new Date().toISOString().slice(0, 10)
    if (review_filter === 'overdue') {
      bindVars.today = today
      filterClause += (filterClause ? ' AND ' : 'FILTER ') + 'customer.next_review_due != null && customer.next_review_due < @today'
    } else if (review_filter === 'due_today') {
      bindVars.today = today
      filterClause += (filterClause ? ' AND ' : 'FILTER ') + 'customer.next_review_due == @today'
    } else if (review_filter === 'due_this_week') {
      const d = new Date()
      const endOfWeek = new Date(d)
      endOfWeek.setDate(d.getDate() + (7 - d.getDay()))
      bindVars.today = today
      bindVars.endWeek = endOfWeek.toISOString().slice(0, 10)
      filterClause += (filterClause ? ' AND ' : 'FILTER ') + 'customer.next_review_due != null && customer.next_review_due >= @today && customer.next_review_due <= @endWeek'
    }

    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 50))
    const skipNum = (p - 1) * s

    const query = `
      FOR customer IN customers
      ${filterClause}
      SORT (customer.next_review_due == null ? 1 : 0), customer.next_review_due ASC, customer.name ASC
      LIMIT ${skipNum}, ${s}
      RETURN {
        _key: customer._key,
        investor_id: customer.investor_id,
        name: customer.name,
        mobile: customer.mobile,
        email: customer.email,
        relationship_manager: customer.relationship_manager,
        relationship_manager_display: customer.relationship_manager_display,
        last_reviewed_at: customer.last_reviewed_at || null,
        last_reviewed_by_id: customer.last_reviewed_by_id || null,
        last_reviewed_by_emp_code: customer.last_reviewed_by_emp_code || null,
        next_review_due: customer.next_review_due || null
      }
    `
    const countQuery = `
      FOR customer IN customers
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    const countBindVars = { ...bindVars }

    const [items, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])
    const total = totalResult[0] || 0
    res.json({ items, total, page: p, size: s })
  } catch (error) {
    console.error('Error fetching portfolio review:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get single customer
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    
    // Validate and convert ID to number
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'invalid_customer_id', detail: 'Customer ID must be a valid number' })
    }
    
    const customerId = Number(id)
    
    // Check if customer exists
    const customers = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id: customerId })
    
    if (!customers.length) {
      return res.status(404).json({ error: 'not_found', detail: `Customer with ID ${customerId} not found` })
    }
    
    const customer = customers[0]
    
    // Check if user can access this customer (branch-based filtering)
    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
      
      if (!canAccess) {
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

    // Validate required fields
    const nameValidation = validateRequired(name, 'Customer name')
    if (!nameValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: nameValidation.error })
    }

    // Validate email (required)
    const emailValidation = validateEmail(email, true)
    if (!emailValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
    }

    // Validate mobile (required)
    const mobileValidation = validateMobile(mobile, true)
    if (!mobileValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: mobileValidation.error })
    }

    // Validate PAN (required)
    const panValidation = validatePAN(pan, true)
    if (!panValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: panValidation.error })
    }

    // Validate Aadhar (optional)
    if (aadhar_number) {
      const aadharValidation = validateAadhar(aadhar_number, false)
      if (!aadharValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: aadharValidation.error })
      }
    }

    // Validate PIN code (optional)
    if (pin) {
      const pinValidation = validatePIN(pin, false)
      if (!pinValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: pinValidation.error })
      }
    }

    // Handle branches - accept either 'branches' array or single 'relationship_manager' for backward compatibility
    // FormData with multer may send arrays in different formats, so handle all cases
    let branches = []
    
    // Check for branches array (could be from JSON or FormData)
    // Multer may parse FormData arrays as req.body['branches[]'] or req.body.branches
    const branchesInput = req.body.branches || req.body['branches[]']
    
    if (branchesInput) {
      if (Array.isArray(branchesInput)) {
        // Already an array (from FormData with brackets or JSON)
        branches = branchesInput.map(b => normalizeBranchName(b)).filter(Boolean)
      } else if (typeof branchesInput === 'string') {
        // Single string or JSON string - try to parse
        try {
          const parsed = JSON.parse(branchesInput)
          if (Array.isArray(parsed)) {
            branches = parsed.map(b => normalizeBranchName(b)).filter(Boolean)
          } else {
            branches = [normalizeBranchName(branchesInput)].filter(Boolean)
          }
        } catch {
          // Not JSON, treat as single branch string
          branches = [normalizeBranchName(branchesInput)].filter(Boolean)
        }
      }
      
      if (branches.length === 0) {
        return res.status(400).json({ error: 'validation_error', detail: 'At least one valid branch must be provided' })
      }
    } else if (req.body.relationship_manager) {
      // Single branch provided (backward compatibility)
      const normalizedBranch = normalizeBranchName(req.body.relationship_manager)
      if (!normalizedBranch) {
        return res.status(400).json({ error: 'validation_error', detail: 'Invalid branch name' })
      }
      branches = [normalizedBranch]
    } else {
      // Auto-assign user's branch if no branches specified
      const userBranch = await getUserBranch(req.user.sub)
      const normalizedUserBranch = normalizeBranchName(userBranch)
      if (!normalizedUserBranch) {
        return res.status(400).json({ error: 'invalid_user', detail: 'User branch not found' })
      }
      branches = [normalizedUserBranch]
    }
    
    // Store as array (even if single branch for consistency)
    const relationshipManager = branches.length === 1 ? branches[0] : branches

    // Optional display names for branch dropdown (so "TINDIVANAM" doesn't show as "CHENNAI RO")
    let relationshipManagerDisplay = null
    const branchesDisplayInput = req.body.branches_display || req.body['branches_display[]']
    if (branchesDisplayInput) {
      const arr = Array.isArray(branchesDisplayInput)
        ? branchesDisplayInput.map(b => (b && String(b).trim()) || '').filter(Boolean)
        : typeof branchesDisplayInput === 'string'
          ? [branchesDisplayInput.trim()].filter(Boolean)
          : []
      if (arr.length) relationshipManagerDisplay = arr.length === 1 ? arr[0] : arr
    }

    // Check if PAN already exists (after validation)
    const existingPan = await q(`
      FOR customer IN customers 
      FILTER customer.pan == @pan
      LIMIT 1
      RETURN customer.investor_id
    `, { pan: panValidation.value })
    if (existingPan.length) {
      return res.status(400).json({ error: 'duplicate_pan', detail: 'PAN number already exists' })
    }

    // Get the next investor_id (check both customers and minors)
    const maxIdResult = await q(`
      LET customerMax = (
        FOR customer IN customers
        COLLECT AGGREGATE maxId = MAX(customer.investor_id)
        RETURN maxId
      )[0] || 0
      
      LET minorMax = (
        FOR customer IN customers
        FILTER customer.minors != null && LENGTH(customer.minors) > 0
        FOR minor IN customer.minors
        COLLECT AGGREGATE maxMinorId = MAX(minor.investor_id)
        RETURN maxMinorId
      )[0] || 0
      
      RETURN MAX([customerMax, minorMax])
    `)
    let nextId = (maxIdResult[0] || 0) + 1

    // Validate and process minors if provided
    let minors = []
    if (req.body.minors !== undefined && req.body.minors !== null && req.body.minors !== '') {
      // Handle minors array (could be JSON string or array)
      let minorsInput = req.body.minors
      if (typeof minorsInput === 'string') {
        const trimmed = minorsInput.trim()
        if (trimmed === '') {
          minorsInput = []
        } else {
          try {
            minorsInput = JSON.parse(minorsInput)
          } catch (e) {
            return res.status(400).json({ error: 'validation_error', detail: 'Invalid minors array format' })
          }
        }
      }
      if (minorsInput === null) minorsInput = []
      
      const minorsValidation = validateMinorsArray(minorsInput)
      if (!minorsValidation.valid) {
        return res.status(400).json({ 
          error: 'validation_error', 
          detail: Array.isArray(minorsValidation.errors) 
            ? minorsValidation.errors.join('; ') 
            : minorsValidation.error 
        })
      }
      
      minors = minorsValidation.value
      
      // Assign unique investor_id to each minor and check PAN uniqueness
      for (let i = 0; i < minors.length; i++) {
        minors[i].investor_id = nextId++
        minors[i].created_at = new Date().toISOString()
        
        // Check PAN uniqueness for minors (if PAN provided)
        if (minors[i].pan) {
          // Check in major customers
          const existingPanMajor = await q(`
            FOR customer IN customers 
            FILTER customer.pan == @pan
            LIMIT 1
            RETURN customer.investor_id
          `, { pan: minors[i].pan })
          
          if (existingPanMajor.length) {
            return res.status(400).json({ 
              error: 'duplicate_pan', 
              detail: `PAN ${minors[i].pan} already exists for customer ID ${existingPanMajor[0]}` 
            })
          }
          
          // Check in other minors
          const existingPanMinor = await q(`
            FOR customer IN customers
            FILTER customer.minors != null && LENGTH(customer.minors) > 0
            FOR minor IN customer.minors
            FILTER minor.pan == @pan
            LIMIT 1
            RETURN minor.investor_id
          `, { pan: minors[i].pan })
          
          if (existingPanMinor.length) {
            return res.status(400).json({ 
              error: 'duplicate_pan', 
              detail: `PAN ${minors[i].pan} already exists for minor with ID ${existingPanMinor[0]}` 
            })
          }
        }
      }
    }

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
      name: nameValidation.value,
      pan: panValidation.value,
      email: emailValidation.value,
      mobile: mobileValidation.value,
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
      relationship_manager: relationshipManager, // Can be single branch (string) or multiple branches (array)
      relationship_manager_display: relationshipManagerDisplay,
      minors: minors, // Array of minors
      created_at: new Date().toISOString(),
      is_active: true,
      source_type: 'manual_entry'
    }

    const result = await getCollection('customers').save(customerDoc)
    res.status(201).json({ 
      investor_id: nextId,
      relationship_manager: relationshipManager,
      branches: branches,
      media_files: mediaDocuments.length,
      minors_count: minors.length,
      message: branches.length === 1 
        ? 'Customer created and assigned to your branch'
        : `Customer created and assigned to ${branches.length} branch(es)`
    })
  } catch (error) {
    console.error('Error creating customer:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Update customer (supports optional document uploads)
router.patch('/:id', requireAuth, uploadMultiple, async (req, res) => {
  try {
    const id = req.params.id
    
    // Validate input
    if (!id || isNaN(Number(id))) {
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
      aadhar_number,
      branches, // New: array of branches
      relationship_manager, // Backward compatibility: single branch
      minors, // Array of minors (for update)
      last_reviewed_at,
      next_review_due
    } = req.body || {}

    // Check if customer exists and get full customer data
    const existing = await q(`
      FOR customer IN customers 
      FILTER customer.investor_id == @id
      LIMIT 1
      RETURN customer
    `, { id: Number(id) })
    
    if (!existing.length) {
      return res.status(404).json({ error: 'not_found', detail: `Customer with ID ${id} not found` })
    }

    const customer = existing[0]
    
    // Check if user can access this customer (branch-based filtering)
    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.relationship_manager)
      
      if (!canAccess) {
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

    // Validate fields if provided
    if (email !== undefined && email !== null && email !== '') {
      const emailValidation = validateEmail(email, false)
      if (!emailValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: emailValidation.error })
      }
    }

    if (mobile !== undefined && mobile !== null && mobile !== '') {
      const mobileValidation = validateMobile(mobile, false)
      if (!mobileValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: mobileValidation.error })
      }
    }

    if (pan !== undefined && pan !== null && pan !== '') {
      const panValidation = validatePAN(pan, false)
      if (!panValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: panValidation.error })
      }

      // Check if PAN already exists for another customer (including minors)
      try {
        const existingPan = await q(`
          FOR customer IN customers 
          FILTER customer.pan == @pan AND customer.investor_id != @id
          LIMIT 1
          RETURN customer.investor_id
        `, { pan: panValidation.value, id: Number(id) })
        
        if (existingPan.length) {
          return res.status(400).json({ 
            error: 'duplicate_pan', 
            detail: `PAN number already exists for customer ID ${existingPan[0]}` 
          })
        }
        
        // Also check in minors
        const existingPanMinor = await q(`
          FOR customer IN customers
          FILTER customer.minors != null && LENGTH(customer.minors) > 0
          FOR minor IN customer.minors
          FILTER minor.pan == @pan
          LIMIT 1
          RETURN minor.investor_id
        `, { pan: panValidation.value })
        
        if (existingPanMinor.length) {
          return res.status(400).json({ 
            error: 'duplicate_pan', 
            detail: `PAN number already exists for minor with ID ${existingPanMinor[0]}` 
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

    if (aadhar_number !== undefined && aadhar_number !== null && aadhar_number !== '') {
      const aadharValidation = validateAadhar(aadhar_number, false)
      if (!aadharValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: aadharValidation.error })
      }
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      const pinValidation = validatePIN(pin, false)
      if (!pinValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: pinValidation.error })
      }
    }

    // Build updates object with validated values
    const updates = {}
    if (name !== undefined) updates.name = name
    if (pan !== undefined && pan !== null && pan !== '') {
      const panValidation = validatePAN(pan, false)
      updates.pan = panValidation.value
    } else if (pan === null || pan === '') {
      updates.pan = null
    }
    if (email !== undefined && email !== null && email !== '') {
      const emailValidation = validateEmail(email, false)
      updates.email = emailValidation.value
    } else if (email === null || email === '') {
      updates.email = null
    }
    if (mobile !== undefined && mobile !== null && mobile !== '') {
      const mobileValidation = validateMobile(mobile, false)
      updates.mobile = mobileValidation.value
    } else if (mobile === null || mobile === '') {
      updates.mobile = null
    }
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

    if (last_reviewed_at !== undefined) {
      updates.last_reviewed_at = last_reviewed_at || null
      // Record who marked the portfolio review as done
      updates.last_reviewed_by_id = req.user.sub || null
      updates.last_reviewed_by_emp_code = req.user.emp_code || null
    }
    if (next_review_due !== undefined) updates.next_review_due = next_review_due || null

    // Handle branch updates - support both 'branches' array and 'relationship_manager' for backward compatibility
    if (branches !== undefined || relationship_manager !== undefined) {
      let newBranches = []
      
      if (branches !== undefined && Array.isArray(branches)) {
        // Multiple branches provided
        newBranches = branches.map(b => normalizeBranchName(b)).filter(Boolean)
        if (newBranches.length === 0) {
          return res.status(400).json({ error: 'validation_error', detail: 'At least one valid branch must be provided' })
        }
      } else if (relationship_manager !== undefined) {
        // Single branch provided (backward compatibility)
        const normalizedBranch = normalizeBranchName(relationship_manager)
        if (!normalizedBranch) {
          return res.status(400).json({ error: 'validation_error', detail: 'Invalid branch name' })
        }
        newBranches = [normalizedBranch]
      }
      
      // Store as array if multiple branches, or single string if one branch (for backward compatibility)
      updates.relationship_manager = newBranches.length === 1 ? newBranches[0] : newBranches
      const branchesDisplay = req.body.branches_display || req.body['branches_display[]']
      if (branchesDisplay !== undefined) {
        const arr = Array.isArray(branchesDisplay)
          ? branchesDisplay.map(b => (b && String(b).trim()) || '').filter(Boolean)
          : typeof branchesDisplay === 'string'
            ? [branchesDisplay.trim()].filter(Boolean)
            : []
        updates.relationship_manager_display = arr.length === 0 ? null : arr.length === 1 ? arr[0] : arr
      }
    }

    // Handle minors update
    if (minors !== undefined) {
      // Handle minors array (could be JSON string or array)
      let minorsInput = minors
      if (typeof minorsInput === 'string') {
        try {
          minorsInput = JSON.parse(minorsInput)
        } catch (e) {
          return res.status(400).json({ error: 'validation_error', detail: 'Invalid minors array format' })
        }
      }
      
      const minorsValidation = validateMinorsArray(minorsInput)
      if (!minorsValidation.valid) {
        return res.status(400).json({ 
          error: 'validation_error', 
          detail: Array.isArray(minorsValidation.errors) 
            ? minorsValidation.errors.join('; ') 
            : minorsValidation.error 
        })
      }
      
      // Get existing minors to preserve investor_ids for existing ones
      const existingMinors = customer.minors || []
      const existingMinorIds = new Set(existingMinors.map(m => m.investor_id))
      
      // Get max investor_id for new minors
      const maxIdResult = await q(`
        LET customerMax = (
          FOR customer IN customers
          COLLECT AGGREGATE maxId = MAX(customer.investor_id)
          RETURN maxId
        )[0] || 0
        
        LET minorMax = (
          FOR customer IN customers
          FILTER customer.minors != null && LENGTH(customer.minors) > 0
          FOR minor IN customer.minors
          COLLECT AGGREGATE maxMinorId = MAX(minor.investor_id)
          RETURN maxMinorId
        )[0] || 0
        
        RETURN MAX([customerMax, minorMax])
      `)
      let nextMinorId = (maxIdResult[0] || 0) + 1
      
      // Process minors: update existing ones or create new ones
      const processedMinors = minorsValidation.value.map((minor, index) => {
        // If minor has investor_id and it exists in current customer's minors, it's an update
        if (minor.investor_id && existingMinorIds.has(minor.investor_id)) {
          // Update existing minor - preserve investor_id and created_at
          const existingMinor = existingMinors.find(m => m.investor_id === minor.investor_id)
          return {
            ...minor,
            investor_id: minor.investor_id,
            created_at: existingMinor?.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        } else {
          // New minor - assign investor_id
          return {
            ...minor,
            investor_id: nextMinorId++,
            created_at: new Date().toISOString()
          }
        }
      })
      
      // Check for receipts associated with minors that are being removed
      const removedMinorIds = existingMinors
        .filter(m => !processedMinors.some(pm => pm.investor_id === m.investor_id))
        .map(m => m.investor_id)
      
      if (removedMinorIds.length > 0) {
        const receiptsCheck = await q(`
          FOR receipt IN receipts
          FILTER receipt.investor_id IN @minorIds AND receipt.is_deleted == false
          COLLECT WITH COUNT INTO count
          RETURN count
        `, { minorIds: removedMinorIds })
        
        if (receiptsCheck[0] > 0) {
          return res.status(400).json({ 
            error: 'cannot_remove_minor', 
            detail: `Cannot remove minor(s) with associated receipts. ${receiptsCheck[0]} receipt(s) found.` 
          })
        }
      }
      
      // Validate PAN uniqueness for all minors (including updates)
      for (const minor of processedMinors) {
        if (minor.pan) {
          // Check in major customers
          const existingPanMajor = await q(`
            FOR customer IN customers 
            FILTER customer.pan == @pan
            LIMIT 1
            RETURN customer.investor_id
          `, { pan: minor.pan })
          
          if (existingPanMajor.length) {
            return res.status(400).json({ 
              error: 'duplicate_pan', 
              detail: `PAN ${minor.pan} already exists for customer ID ${existingPanMajor[0]}` 
            })
          }
          
          // Check in other minors (excluding this minor's own ID)
          const existingPanMinor = await q(`
            FOR customer IN customers
            FILTER customer.minors != null && LENGTH(customer.minors) > 0
            FOR minor IN customer.minors
            FILTER minor.pan == @pan AND minor.investor_id != @minorId
            LIMIT 1
            RETURN minor.investor_id
          `, { pan: minor.pan, minorId: minor.investor_id })
          
          if (existingPanMinor.length) {
            return res.status(400).json({ 
              error: 'duplicate_pan', 
              detail: `PAN ${minor.pan} already exists for minor with ID ${existingPanMinor[0]}` 
            })
          }
        }
      }
      
      updates.minors = processedMinors
    }

    // Handle newly uploaded media files (append to existing media_documents)
    if (req.files && req.files.length > 0) {
      const newMediaDocuments = req.files.map(file => ({
        id: Date.now() + Math.random(),
        original_name: file.originalname,
        filename: file.filename,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: req.user.sub,
        uploaded_at: new Date().toISOString()
      }))
      const existingMedia = Array.isArray(customer.media_documents) ? customer.media_documents : []
      updates.media_documents = [...existingMedia, ...newMediaDocuments]
    }

    // Add update timestamp
    updates.updated_at = new Date().toISOString()

    if (Object.keys(updates).length === 1) { // Only updated_at
      return res.status(400).json({ error: 'no_updates', detail: 'No valid fields provided for update' })
    }

    // Perform the update
    const updateResult = await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      UPDATE customer WITH @updates IN customers
      RETURN NEW
    `, { id: Number(id), updates })

    if (!updateResult || updateResult.length === 0) {
      return res.status(500).json({ 
        error: 'update_failed', 
        detail: 'Customer update query did not affect any records' 
      })
    }

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
    const idParam = req.params.id
    const id = parseInt(idParam, 10)
    if (isNaN(id)) {
      return res.status(400).json({ error: 'invalid_id', detail: 'Invalid customer ID' })
    }

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
