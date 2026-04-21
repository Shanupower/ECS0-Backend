import express from 'express'
import fs from 'fs'
import path from 'path'
import { q, getCollection, getUserBranch, normalizeBranchName, getCanonicalBranchKey, canAccessCustomer } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { uploadMultiple, uploadsDir } from '../middleware/upload.js'
import { validatePAN, validateEmail, validateMobile, validateAadhar, validatePIN, validateRequired, validateMinorsArray } from '../utils/validators.js'
import { publishEvent } from '../services/task-events.js'

const router = express.Router()

// Build branch filter for customer queries: prefer customer.branches[] with canonical key; fallback to relationship_manager
async function getBranchFilterForCustomer(userId) {
  const userRole = await q(`
    FOR user IN users FILTER user._key == @id LIMIT 1 RETURN user.role
  `, { id: userId })
  const isAdmin = userRole.length > 0 && userRole[0] === 'admin'
  if (isAdmin) return { filterClause: '', branchCondition: '', bindVars: {}, isAdmin: true, canonicalKey: null, normalizedUserBranch: null }

  const userBranch = await getUserBranch(userId)
  const canonicalKey = await getCanonicalBranchKey(userBranch)
  const normalizedUserBranch = normalizeBranchName(userBranch)
  if (!canonicalKey && !normalizedUserBranch) {
    return { filterClause: '', branchCondition: '', bindVars: {}, isAdmin: false, canonicalKey: null, normalizedUserBranch: null }
  }

  const filterClause = `FILTER (
    (IS_ARRAY(customer.branches) && LENGTH(customer.branches) > 0 && @canonicalKey IN customer.branches)
    OR
    ( (customer.branches == null OR !IS_ARRAY(customer.branches) OR LENGTH(customer.branches) == 0) AND (
      (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
      (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
    ))
  )`
  const branchCondition = `(
    (IS_ARRAY(customer.branches) && LENGTH(customer.branches) > 0 && @canonicalKey IN customer.branches)
    OR
    ( (customer.branches == null OR !IS_ARRAY(customer.branches) OR LENGTH(customer.branches) == 0) AND (
      (IS_ARRAY(customer.relationship_manager) && @userBranch IN customer.relationship_manager) ||
      (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager == @userBranch)
    ))
  )`
  const bindVars = { canonicalKey: canonicalKey || '', userBranch: normalizedUserBranch || '' }
  return { filterClause, branchCondition, bindVars, isAdmin: false, canonicalKey, normalizedUserBranch }
}

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

    const branchFilter = await getBranchFilterForCustomer(req.user.sub)
    const isAdmin = branchFilter.isAdmin
    const normalizedUserBranch = branchFilter.normalizedUserBranch
    
    // Enhanced pagination with larger limits for search
    const searchLimit = Math.min(100, Math.max(4, parseInt(limit, 10) || 20))
    const searchPage = Math.max(1, parseInt(page, 10) || 1)
    const searchOffset = (searchPage - 1) * searchLimit

    // Enhanced sort options
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    const allowedSort = new Set(['name', 'investor_id', 'created_at'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'name'

    const rawSearch = searchQuery.trim().toLowerCase()
    let filterClause = ''
    let bindVars = { 
      searchQuery: `%${rawSearch}%`,
      rawSearch,
      ...branchFilter.bindVars
    }

    // Branch-based filtering (unless admin)
    if (branchFilter.filterClause) {
      filterClause = branchFilter.filterClause
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
      LET qLower = LOWER(@rawSearch)
      LET nameLower = LOWER(customer.name)
      LET panLower = customer.pan != null ? LOWER(customer.pan) : null
      LET exactPanMatch = panLower != null && panLower == qLower ? 1 : 0
      LET exactNameMatch = nameLower == qLower ? 1 : 0
      LET prefixPanMatch = panLower != null && LIKE(panLower, CONCAT(@rawSearch, '%'), true) ? 1 : 0
      LET prefixNameMatch = LIKE(nameLower, CONCAT(@rawSearch, '%'), true) ? 1 : 0
      LET score = exactPanMatch * 100
        + exactNameMatch * 80
        + prefixPanMatch * 60
        + prefixNameMatch * 40
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
        branches: customer.branches,
        created_at: customer.created_at,
        minors: customer.minors || [],
        has_minors: customer.minors != null && LENGTH(customer.minors) > 0,
        minors_count: customer.minors != null ? LENGTH(customer.minors) : 0,
        rank: score
      }
      SORT score DESC, customer.name ASC
      LIMIT ${searchOffset}, ${searchLimit}
      RETURN customerResult
    `
    
    // Search query for minors (flat format); use branch condition when present
    const minorSearchFilter = branchFilter.branchCondition ? `
      FILTER ${branchFilter.branchCondition} AND (
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
        branches: customer.branches,
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
    
    // Count and minor queries do not use @rawSearch; only customerQuery does.
    // ArangoDB rejects bind params that are not declared in the query.
    const countBindVars = {
      searchQuery: bindVars.searchQuery,
      exactId: bindVars.exactId,
      ...branchFilter.bindVars
    }
    const minorBindVars = {
      searchQuery: bindVars.searchQuery,
      exactId: bindVars.exactId,
      ...branchFilter.bindVars
    }

    const [customersResult, minorsResult, totalResult] = await Promise.all([
      q(customerQuery, bindVars),
      q(minorQuery, minorBindVars),
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

    const branchFilter = await getBranchFilterForCustomer(req.user.sub)
    const isAdmin = branchFilter.isAdmin
    const normalizedUserBranch = branchFilter.normalizedUserBranch
    
    // Enhanced pagination with larger limits for search
    const searchLimit = Math.min(100, Math.max(4, parseInt(limit, 10) || 20))
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
        ${branchFilter.filterClause}
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
          branches: customer.branches,
          created_at: customer.created_at
        }
      `

      bindVars = {
        searchQuery: searchQuery.trim().toLowerCase(),
        ...branchFilter.bindVars
      }
    } else {
      // Fallback to regular search
      let filterClause = ''
      const searchLower = searchQuery.trim().toLowerCase()
      bindVars = { 
        searchQuery: `%${searchLower}%`,
        ...branchFilter.bindVars
      }

      // Branch-based filtering (unless admin)
      if (branchFilter.filterClause) {
        filterClause = branchFilter.filterClause
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
          branches: customer.branches,
          created_at: customer.created_at,
          minors: customer.minors || []
        }
        RETURN customerResult
      `
    }
    
    // Minor search query - use branch condition when present (same as main search)
    const minorSearchFilter = branchFilter.branchCondition ? `
      FILTER ${branchFilter.branchCondition} AND (
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
        branches: customer.branches,
        created_at: minor.created_at,
        is_minor: true,
        parent_investor_id: customer.investor_id,
        parent_name: customer.name,
        use_same_address: minor.use_same_address || false,
        relationship_type: minor.relationship_type
      }
    `
    
    // Add exactId to bindVars for minor search
    const exactId = parseInt(searchQuery.trim())
    const exactIdForMinors = !isNaN(exactId) ? exactId : -1
    const minorBindVars = { ...bindVars, exactId: exactIdForMinors }
    if (!minorBindVars.exactId) {
      minorBindVars.exactId = exactIdForMinors
    }
    if (typeof minorBindVars.searchQuery === 'string' && !minorBindVars.searchQuery.includes('%')) {
      minorBindVars.searchQuery = `%${minorBindVars.searchQuery}%`
    }

    const countQuery = useFulltext === 'true' ? `
      LET customerCount = (
        FOR customer IN FULLTEXT(customers, 'name', @searchQuery)
        ${branchFilter.filterClause}
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
        ${branchFilter.filterClause}
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
      branch_key,
      includeDeleted = '0'
    } = req.query

    const branchFilter = await getBranchFilterForCustomer(req.user.sub)
    const isAdmin = branchFilter.isAdmin
    const normalizedUserBranch = branchFilter.normalizedUserBranch

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
    if (branchFilter.filterClause) {
      filterClause = branchFilter.filterClause
      Object.assign(bindVars, branchFilter.bindVars)
    }

    // Search functionality (case-insensitive)
    if (search) {
      const searchFilter = `
        FILTER LOWER(customer.name) LIKE LOWER(@search)
           OR LOWER(customer.investor_id) LIKE LOWER(@search)
           OR LOWER(customer.pan) LIKE LOWER(@search)
           OR LOWER(customer.email) LIKE LOWER(@search)
           OR LOWER(customer.mobile) LIKE LOWER(@search)
           OR (
             FOR minor IN (customer.minors != null ? customer.minors : [])
             FILTER (
               LOWER(minor.name) LIKE LOWER(@search)
               OR LOWER(minor.investor_id) LIKE LOWER(@search)
               OR LOWER(minor.pan) LIKE LOWER(@search)
             )
             RETURN true
           )[0] == true
      `
      
      if (filterClause) {
        filterClause += ` AND (LOWER(customer.name) LIKE LOWER(@search)
           OR LOWER(customer.investor_id) LIKE LOWER(@search)
           OR LOWER(customer.pan) LIKE LOWER(@search)
           OR LOWER(customer.email) LIKE LOWER(@search)
           OR LOWER(customer.mobile) LIKE LOWER(@search)
           OR (
             FOR minor IN (customer.minors != null ? customer.minors : [])
             FILTER (
               LOWER(minor.name) LIKE LOWER(@search)
               OR LOWER(minor.investor_id) LIKE LOWER(@search)
               OR LOWER(minor.pan) LIKE LOWER(@search)
             )
             RETURN true
           )[0] == true
        )`
      } else {
        filterClause = searchFilter
      }
      bindVars.search = `%${String(search).trim().toLowerCase()}%`
    }

    // Admin-only: filter list by branch key (customer.branches or relationship_manager)
    if (isAdmin && branch_key && String(branch_key).trim()) {
      const bk = String(branch_key).trim()
      const branchClause = `(
        (IS_ARRAY(customer.branches) && LENGTH(customer.branches) > 0 && @branch_key IN customer.branches)
        OR customer.relationship_manager == @branch_key
        OR (IS_ARRAY(customer.relationship_manager) && @branch_key IN customer.relationship_manager)
      )`
      if (filterClause) {
        filterClause += ` AND ${branchClause}`
      } else {
        filterClause = `FILTER ${branchClause}`
      }
      bindVars.branch_key = bk
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
    const normalizedSearch = typeof search === 'string' ? search.trim().toLowerCase() : ''
    const items = normalizedSearch
      ? rows.map((customer) => {
          const minors = Array.isArray(customer?.minors) ? customer.minors : []
          const matchedMinorNames = minors
            .filter((minor) => {
              const name = String(minor?.name || '').toLowerCase()
              const investorId = String(minor?.investor_id || '').toLowerCase()
              const pan = String(minor?.pan || '').toLowerCase()
              return (
                name.includes(normalizedSearch) ||
                investorId.includes(normalizedSearch) ||
                pan.includes(normalizedSearch)
              )
            })
            .map((minor) => minor?.name)
            .filter(Boolean)

          return {
            ...customer,
            matched_minor_names: matchedMinorNames
          }
        })
      : rows

    res.json({ 
      page: numPage, 
      size: numLimit, 
      total, 
      items,
      branch_filter: !isAdmin ? normalizedUserBranch : 'all',
      user_role: isAdmin ? 'admin' : 'branch_user'
    })
  } catch (error) {
    console.error('Error fetching customers:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Portfolio review: list customers with last_reviewed_at / next_review_due and optional filter
// Resolve admin branch-code scope against customer.branches[] by mapping branch_code → canonical _key.
async function resolveAdminBranchKeys(branchCodeParam) {
  if (!branchCodeParam) return null
  const str = String(branchCodeParam).trim()
  if (!str) return null
  const rows = await q(`
    FOR b IN branches
      FILTER b._key == @str
         OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@str))
         OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@str))
      LIMIT 1
      RETURN { _key: b._key, code: b.branch_code, name: b.branch_name }
  `, { str })
  if (!rows.length) return { keys: [], names: [] }
  const r = rows[0]
  const keys = [r._key].filter(Boolean).map(String)
  const names = [r.name, r.code, str].filter(Boolean).map(x => String(x))
  return { keys, names }
}

router.get('/portfolio-review', requireAuth, async (req, res) => {
  try {
    const { review_filter = 'all', page = '1', size = '50', search, branch_code } = req.query
    const branchFilter = await getBranchFilterForCustomer(req.user.sub)

    const bindVars = { ...branchFilter.bindVars }
    const baseConditions = []
    if (branchFilter.branchCondition) {
      baseConditions.push(`(${branchFilter.branchCondition})`)
    }

    // Admin may scope by ?branch_code=CHEMBUR against customer.branches[] / relationship_manager.
    if (branchFilter.isAdmin) {
      const adminScope = await resolveAdminBranchKeys(branch_code)
      if (adminScope) {
        bindVars.adminBranchKeys = adminScope.keys
        bindVars.adminBranchNames = adminScope.names
        baseConditions.push(`(
          (IS_ARRAY(customer.branches) && LENGTH(customer.branches) > 0 && LENGTH(INTERSECTION(customer.branches, @adminBranchKeys)) > 0)
          ||
          ( (customer.branches == null OR !IS_ARRAY(customer.branches) OR LENGTH(customer.branches) == 0) &&
            (
              (IS_ARRAY(customer.relationship_manager) && LENGTH(INTERSECTION(customer.relationship_manager, @adminBranchNames)) > 0)
              || (!IS_ARRAY(customer.relationship_manager) && customer.relationship_manager IN @adminBranchNames)
            )
          )
        )`)
      }
    }

    const searchTerm = typeof search === 'string' ? search.trim() : ''
    if (searchTerm.length > 0) {
      const searchLower = searchTerm.toLowerCase()
      bindVars.searchLower = searchLower
      baseConditions.push(`(
        (customer.name != null && CONTAINS(LOWER(TO_STRING(customer.name)), @searchLower)) ||
        (customer.mobile != null && CONTAINS(LOWER(TO_STRING(customer.mobile)), @searchLower)) ||
        (customer.email != null && CONTAINS(LOWER(TO_STRING(customer.email)), @searchLower)) ||
        (customer.pan != null && CONTAINS(LOWER(TO_STRING(customer.pan)), @searchLower))
      )`)
    }

    const today = new Date().toISOString().slice(0, 10)
    const endOfWeekISO = (() => {
      const d = new Date()
      const end = new Date(d)
      end.setDate(d.getDate() + (7 - d.getDay()))
      return end.toISOString().slice(0, 10)
    })()
    const endOfMonthISO = (() => {
      const d = new Date()
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      return end.toISOString().slice(0, 10)
    })()

    const filterConditions = [...baseConditions]
    if (review_filter === 'overdue') {
      bindVars.today = today
      filterConditions.push('customer.next_review_due != null && customer.next_review_due < @today')
    } else if (review_filter === 'due_today') {
      bindVars.today = today
      filterConditions.push('customer.next_review_due == @today')
    } else if (review_filter === 'due_this_week') {
      bindVars.today = today
      bindVars.endWeek = endOfWeekISO
      filterConditions.push('customer.next_review_due != null && customer.next_review_due >= @today && customer.next_review_due <= @endWeek')
    } else if (review_filter === 'due_this_month') {
      bindVars.today = today
      bindVars.endMonth = endOfMonthISO
      filterConditions.push('customer.next_review_due != null && customer.next_review_due >= @today && customer.next_review_due <= @endMonth')
    }

    const filterClause = filterConditions.length > 0 ? `FILTER ${filterConditions.join(' AND ')}` : ''

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
        branches: customer.branches,
        review_tier: customer.review_tier || null,
        review_cadence_months: customer.review_cadence_months != null ? customer.review_cadence_months : null,
        last_reviewed_at: customer.last_reviewed_at || null,
        last_reviewed_by_id: customer.last_reviewed_by_id || null,
        last_reviewed_by_emp_code: customer.last_reviewed_by_emp_code || null,
        last_reviewed_by_name: customer.last_reviewed_by_name || null,
        next_review_due: customer.next_review_due || null
      }
    `
    const countQuery = `
      FOR customer IN customers
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    // Bucket counts (use the shared base scope ignoring the active review_filter).
    const baseClause = baseConditions.length > 0 ? `FILTER ${baseConditions.join(' AND ')}` : ''
    const countsBind = { ...bindVars, today, endWeek: endOfWeekISO, endMonth: endOfMonthISO }
    const countsQuery = `
      LET base = (
        FOR customer IN customers
        ${baseClause}
        RETURN customer.next_review_due
      )
      LET overdue = LENGTH(base[* FILTER CURRENT != null && CURRENT < @today])
      LET due_today = LENGTH(base[* FILTER CURRENT == @today])
      LET due_this_week = LENGTH(base[* FILTER CURRENT != null && CURRENT >= @today && CURRENT <= @endWeek])
      LET due_this_month = LENGTH(base[* FILTER CURRENT != null && CURRENT >= @today && CURRENT <= @endMonth])
      LET all_count = LENGTH(base)
      RETURN { overdue, due_today, due_this_week, due_this_month, "all": all_count }
    `

    const [items, totalResult, countsResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, bindVars),
      q(countsQuery, countsBind)
    ])
    const total = totalResult[0] || 0
    const counts = countsResult[0] || { overdue: 0, due_today: 0, due_this_week: 0, due_this_month: 0, all: 0 }
    res.json({ items, total, page: p, size: s, counts })
  } catch (error) {
    console.error('Error fetching portfolio review:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// GET /api/customers/:id/review-history — chronological review events for a customer
router.get('/:id/review-history', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'invalid_customer_id' })
    const customers = await q(`FOR c IN customers FILTER c.investor_id == @id LIMIT 1 RETURN c`, { id })
    if (!customers.length) return res.status(404).json({ error: 'not_found' })
    const customer = customers[0]
    const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
    if (!canAccess) return res.status(403).json({ error: 'forbidden' })
    const db = (await import('../config/database.js')).default
    const col = db.collection('portfolio_review_events')
    if (!(await col.exists())) {
      return res.json({ items: [] })
    }
    const rows = await q(`
      FOR e IN portfolio_review_events
      FILTER e.investor_id == @id
      SORT e.reviewed_at DESC
      LIMIT 200
      RETURN e
    `, { id })
    res.json({ items: rows })
  } catch (error) {
    console.error('Error fetching review history:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Helper — add N months to a yyyy-mm-dd string.
function addMonthsISO(ymd, months) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  base.setUTCMonth(base.getUTCMonth() + Number(months || 0))
  return base.toISOString().slice(0, 10)
}

async function ensureReviewEventsCollection() {
  const db = (await import('../config/database.js')).default
  const col = db.collection('portfolio_review_events')
  if (!(await col.exists())) await col.create()
  return getCollection('portfolio_review_events')
}

async function writeReviewEvent({ customer, reviewerUser, note, nextReviewDue }) {
  try {
    const col = await ensureReviewEventsCollection()
    const doc = {
      investor_id: customer.investor_id,
      customer_key: customer._key,
      reviewed_at: new Date().toISOString(),
      reviewer_id: reviewerUser.sub || null,
      reviewer_emp_code: reviewerUser.emp_code || null,
      reviewer_name: reviewerUser.name || null,
      note: note || null,
      next_review_due: nextReviewDue || null,
      branch_code: Array.isArray(customer.branches) && customer.branches[0] ? customer.branches[0]
        : (Array.isArray(customer.relationship_manager) ? customer.relationship_manager[0] : customer.relationship_manager) || null
    }
    await col.save(doc)
  } catch (err) {
    console.error('writeReviewEvent failed:', err)
  }
}

// POST /api/customers/portfolio-review/bulk-update
// Actions: 'mark_reviewed' (uses each customer's cadence; falls back to config A=12/B=6/C=3/default=12)
//          'push_next_review' (months required)
//          'reassign' (admin only, to_user_id required)
router.post('/portfolio-review/bulk-update', requireAuth, async (req, res) => {
  try {
    const { investor_ids = [], action, months, to_user_id, note } = req.body || {}
    if (!Array.isArray(investor_ids) || investor_ids.length === 0) {
      return res.status(400).json({ error: 'validation_error', detail: 'investor_ids required' })
    }
    if (!['mark_reviewed', 'push_next_review', 'reassign'].includes(action)) {
      return res.status(400).json({ error: 'validation_error', detail: 'Unknown action' })
    }
    if (action === 'push_next_review' && (!months || Number(months) <= 0)) {
      return res.status(400).json({ error: 'validation_error', detail: 'months > 0 required for push_next_review' })
    }
    if (action === 'reassign' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', detail: 'Only admins can reassign' })
    }

    const ids = investor_ids.map(x => Number(x)).filter(n => Number.isFinite(n))
    const customers = await q(`
      FOR c IN customers FILTER c.investor_id IN @ids RETURN c
    `, { ids })

    // Load app config for default tier cadences.
    let tierCadence = { A: 12, B: 6, C: 3 }
    try {
      const { getAppConfig } = await import('./app-config.js')
      const cfg = await getAppConfig()
      if (cfg && cfg.review_tier_cadence_months) tierCadence = { ...tierCadence, ...cfg.review_tier_cadence_months }
    } catch {}

    const today = new Date().toISOString().slice(0, 10)
    const nowIso = new Date().toISOString()
    const results = []
    const errors = []

    for (const customer of customers) {
      try {
        const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
        if (!canAccess) {
          errors.push({ investor_id: customer.investor_id, reason: 'forbidden' })
          continue
        }

        if (action === 'mark_reviewed') {
          const cadence = Number(customer.review_cadence_months || tierCadence[customer.review_tier] || tierCadence.A || 12)
          const nextDue = addMonthsISO(today, cadence)
          const patch = {
            last_reviewed_at: today,
            last_reviewed_by_id: req.user.sub || null,
            last_reviewed_by_emp_code: req.user.emp_code || null,
            last_reviewed_by_name: req.user.name || null,
            next_review_due: nextDue,
            updated_at: nowIso
          }
          await q(`
            FOR c IN customers FILTER c.investor_id == @id UPDATE c WITH @patch IN customers
          `, { id: customer.investor_id, patch })
          await writeReviewEvent({ customer, reviewerUser: req.user, note, nextReviewDue: nextDue })
          results.push({ investor_id: customer.investor_id, next_review_due: nextDue })
          publishEvent({
            type: 'portfolio_review.completed',
            payload: { customer_id: customer._key, investor_id: customer.investor_id, next_review_due: nextDue, tier: customer.review_tier || null },
            actor: { id: req.user.sub, emp_code: req.user.emp_code },
            branch: Array.isArray(customer.branches) && customer.branches.length ? customer.branches[0] : null
          })
        } else if (action === 'push_next_review') {
          // Push by N months from today OR from existing next_review_due if present.
          const base = customer.next_review_due || today
          const nextDue = addMonthsISO(base, Number(months))
          await q(`
            FOR c IN customers FILTER c.investor_id == @id UPDATE c WITH @patch IN customers
          `, { id: customer.investor_id, patch: { next_review_due: nextDue, updated_at: nowIso } })
          results.push({ investor_id: customer.investor_id, next_review_due: nextDue })
        } else if (action === 'reassign') {
          // Resolve the user and branch assignment, then update customer.branches / relationship_manager.
          const users = await q(`FOR u IN users FILTER u._key == @aid OR u.emp_code == @aid LIMIT 1 RETURN u`, { aid: String(to_user_id).trim() })
          if (!users.length) {
            errors.push({ investor_id: customer.investor_id, reason: 'user_not_found' })
            continue
          }
          const u = users[0]
          const patch = {
            relationship_manager_display: u.name || u.emp_code || null,
            assigned_rm_emp_code: u.emp_code || null,
            assigned_rm_user_id: u._key || null,
            updated_at: nowIso
          }
          await q(`FOR c IN customers FILTER c.investor_id == @id UPDATE c WITH @patch IN customers`, { id: customer.investor_id, patch })
          results.push({ investor_id: customer.investor_id })
        }
      } catch (err) {
        console.error('bulk-update row error:', err)
        errors.push({ investor_id: customer.investor_id, reason: err.message || 'error' })
      }
    }

    res.json({ updated: results.length, results, errors })
  } catch (error) {
    console.error('Error in bulk-update:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Timeline: unified feed of tasks + receipts + review events + lead activities for a customer.
router.get('/:id/timeline', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    if (!id || isNaN(Number(id))) return res.status(400).json({ error: 'invalid_customer_id' })
    const rows = await q('FOR c IN customers FILTER c.investor_id == @id LIMIT 1 RETURN c', { id: Number(id) })
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    const customer = rows[0]

    const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
    if (!canAccess) return res.status(403).json({ error: 'forbidden' })

    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 100))

    const tasks = await q(`
      FOR t IN tasks FILTER t.customer_id == @cid
        SORT t.created_at DESC
        LIMIT @l
        RETURN { _key: t._key, kind: 'task', title: t.title, status: t.status, priority: t.priority, assignee_emp_code: t.assignee_emp_code, due_date: t.due_date, completed_at: t.completed_at, at: t.updated_at || t.created_at }
    `, { cid: customer._key, l: limit }).catch(() => [])

    const receipts = await q(`
      FOR r IN receipts FILTER r.customer_id == @cid
        SORT r.created_at DESC
        LIMIT @l
        RETURN { _key: r._key, kind: 'receipt', category: r.category || r.transaction.category, product: r.product_details, amount: r.calculations.total || r.calculations.amount, receipt_number: r.receipt_number, at: r.created_at }
    `, { cid: customer._key, l: limit }).catch(() => [])

    const reviews = await q(`
      FOR e IN customer_review_events FILTER e.customer_key == @cid
        SORT e.created_at DESC
        LIMIT @l
        RETURN { _key: e._key, kind: 'review', next_review_due: e.next_review_due, note: e.note, reviewer_name: e.reviewer_name, at: e.created_at }
    `, { cid: customer._key, l: limit }).catch(() => [])

    const feed = [...tasks, ...receipts, ...reviews]
      .filter(x => x && x.at)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit)

    res.json({ items: feed, counts: { tasks: tasks.length, receipts: receipts.length, reviews: reviews.length } })
  } catch (error) {
    console.error('customer timeline error:', error)
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
      const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
      
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
        branches = branchesInput.map(b => (b != null ? String(b).trim() : '')).filter(Boolean)
      } else if (typeof branchesInput === 'string') {
        try {
          const parsed = JSON.parse(branchesInput)
          branches = Array.isArray(parsed)
            ? parsed.map(b => (b != null ? String(b).trim() : '')).filter(Boolean)
            : [String(branchesInput).trim()].filter(Boolean)
        } catch {
          branches = [String(branchesInput).trim()].filter(Boolean)
        }
      }
      // Validate that each value is an existing branch key (frontend sends branch id / _key)
      if (branches.length > 0) {
        const found = await q(`
          FOR b IN branches FILTER b._key IN @keys RETURN b._key
        `, { keys: branches })
        const foundSet = new Set(found)
        const invalid = branches.filter(k => !foundSet.has(k))
        if (invalid.length > 0) {
          return res.status(400).json({ error: 'validation_error', detail: `Invalid branch key(s): ${invalid.join(', ')}` })
        }
      }
      
      if (branches.length === 0) {
        return res.status(400).json({ error: 'validation_error', detail: 'At least one valid branch must be provided' })
      }
    } else if (req.body.relationship_manager) {
      // Single branch provided (backward compatibility) - resolve to canonical key
      const userBranch = req.body.relationship_manager
      const canonicalKey = await getCanonicalBranchKey(userBranch) || normalizeBranchName(userBranch)
      if (!canonicalKey) {
        return res.status(400).json({ error: 'validation_error', detail: 'Invalid branch name' })
      }
      branches = [canonicalKey]
    } else {
      // Auto-assign user's branch if no branches specified
      const userBranch = await getUserBranch(req.user.sub)
      const canonicalKey = await getCanonicalBranchKey(userBranch) || normalizeBranchName(userBranch)
      if (!canonicalKey) {
        return res.status(400).json({ error: 'invalid_user', detail: 'User branch not found' })
      }
      branches = [canonicalKey]
    }
    
    // Store as array (canonical keys)
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
      branches: branches, // Canonical branch keys for filtering
      minors: minors, // Array of minors
      created_at: new Date().toISOString(),
      is_active: true,
      source_type: 'manual_entry'
    }

    const result = await getCollection('customers').save(customerDoc)

    publishEvent({
      type: 'customer.created',
      payload: {
        customer_id: result._key,
        investor_id: nextId,
        name: customerDoc.full_name || customerDoc.name || null,
        branches,
        branch: Array.isArray(branches) && branches.length ? branches[0] : null
      },
      actor: { id: req.user.sub, emp_code: req.user.emp_code },
      branch: Array.isArray(branches) && branches.length ? branches[0] : null
    })

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
      next_review_due,
      review_tier,
      review_cadence_months,
      review_note
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
      const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
      
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
      updates.last_reviewed_by_name = req.user.name || null
    }
    if (next_review_due !== undefined) updates.next_review_due = next_review_due || null
    if (review_tier !== undefined) {
      const t = review_tier ? String(review_tier).trim().toUpperCase() : null
      if (t && !['A', 'B', 'C'].includes(t)) {
        return res.status(400).json({ error: 'validation_error', detail: 'review_tier must be A, B, or C' })
      }
      updates.review_tier = t || null
    }
    if (review_cadence_months !== undefined) {
      if (review_cadence_months === null || review_cadence_months === '') {
        updates.review_cadence_months = null
      } else {
        const n = Number(review_cadence_months)
        if (!Number.isFinite(n) || n <= 0 || n > 60) {
          return res.status(400).json({ error: 'validation_error', detail: 'review_cadence_months must be 1–60' })
        }
        updates.review_cadence_months = n
      }
    }

    // Handle branch updates - support both 'branches' array (canonical keys) and 'relationship_manager' for backward compatibility
    if (branches !== undefined || relationship_manager !== undefined) {
      let newBranches = []
      
      if (branches !== undefined && Array.isArray(branches)) {
        newBranches = branches.map(b => (b != null ? String(b).trim() : '')).filter(Boolean)
        if (newBranches.length > 0) {
          const found = await q(`FOR b IN branches FILTER b._key IN @keys RETURN b._key`, { keys: newBranches })
          const foundSet = new Set(found)
          const invalid = newBranches.filter(k => !foundSet.has(k))
          if (invalid.length > 0) {
            return res.status(400).json({ error: 'validation_error', detail: `Invalid branch key(s): ${invalid.join(', ')}` })
          }
        }
        if (newBranches.length === 0) {
          return res.status(400).json({ error: 'validation_error', detail: 'At least one valid branch must be provided' })
        }
      } else if (relationship_manager !== undefined) {
        const canonicalKey = await getCanonicalBranchKey(relationship_manager) || normalizeBranchName(relationship_manager)
        if (!canonicalKey) {
          return res.status(400).json({ error: 'validation_error', detail: 'Invalid branch name' })
        }
        newBranches = [canonicalKey]
      }
      
      updates.branches = newBranches
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
          FILTER receipt.is_deleted == false
          LET inv_id = (receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id
          FILTER inv_id IN @minorIds
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

    // When a single-customer mark-reviewed happens here, log a review event so history stays in sync.
    if (last_reviewed_at !== undefined && last_reviewed_at) {
      const updated = updateResult[0]
      await writeReviewEvent({
        customer: updated,
        reviewerUser: req.user,
        note: review_note || null,
        nextReviewDue: updates.next_review_due || null
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

// Attach documents to existing customer (upload-only endpoint)
router.post('/:id/media', requireAuth, uploadMultiple, async (req, res) => {
  try {
    const id = req.params.id
    
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'invalid_customer_id', detail: 'Customer ID must be a valid number' })
    }

    // Load customer
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

    // Branch-based access check
    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
      if (!canAccess) {
        return res.status(403).json({
          error: 'forbidden',
          detail: 'Access denied - customer belongs to different branch',
          customer_branch: customer.relationship_manager,
          user_id: req.user.sub
        })
      }
    } catch (accessError) {
      console.error('[Customer Media] Access check failed:', accessError)
      return res.status(500).json({
        error: 'access_check_failed',
        detail: 'Failed to verify access permissions',
        error_message: accessError.message
      })
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'no_files', detail: 'No files uploaded' })
    }

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
    const updates = {
      media_documents: [...existingMedia, ...newMediaDocuments],
      updated_at: new Date().toISOString()
    }

    const updateResult = await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      UPDATE customer WITH @updates IN customers
      RETURN NEW
    `, { id: Number(id), updates })

    if (!updateResult || updateResult.length === 0) {
      return res.status(500).json({
        error: 'update_failed',
        detail: 'Customer media update query did not affect any records'
      })
    }

    res.json({
      added: newMediaDocuments.length,
      total_media: updates.media_documents.length
    })
  } catch (error) {
    console.error('[Customer Media] Error attaching documents:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Delete a single media document from a customer
router.delete('/:id/media/:mediaId', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    const mediaId = req.params.mediaId

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ error: 'invalid_customer_id', detail: 'Customer ID must be a valid number' })
    }

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

    try {
      const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
      if (!canAccess) {
        return res.status(403).json({
          error: 'forbidden',
          detail: 'Access denied - customer belongs to different branch'
        })
      }
    } catch (accessError) {
      console.error('[Customer Media Delete] Access check failed:', accessError)
      return res.status(500).json({ error: 'access_check_failed', detail: accessError.message })
    }

    const mediaDocs = Array.isArray(customer.media_documents) ? customer.media_documents : []
    const doc = mediaDocs.find(d => String(d.id) === String(mediaId))
    if (!doc) {
      return res.status(404).json({ error: 'media_not_found', detail: 'Document not found' })
    }

    const updatedMedia = mediaDocs.filter(d => String(d.id) !== String(mediaId))
    const updates = {
      media_documents: updatedMedia,
      updated_at: new Date().toISOString()
    }

    await q(`
      FOR customer IN customers
      FILTER customer.investor_id == @id
      UPDATE customer WITH @updates IN customers
      RETURN NEW
    `, { id: Number(id), updates })

    if (doc.filename) {
      try {
        const filePath = path.join(uploadsDir, doc.filename)
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      } catch (unlinkErr) {
        console.warn('[Customer Media Delete] Could not remove file from disk:', unlinkErr.message)
      }
    }

    res.status(204).end()
  } catch (error) {
    console.error('[Customer Media Delete] Error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
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
    const canAccess = await canAccessCustomer(req.user.sub, customer.branches || customer.relationship_manager)
    if (!canAccess) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied - customer belongs to different branch' })
    }

    // Check if customer has any receipts (investor id from nested or legacy flat)
    const receipts = await q(`
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
      LET inv_id = (receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id
      FILTER inv_id == @id
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
