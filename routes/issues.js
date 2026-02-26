import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadSingle } from '../middleware/upload.js'

const router = express.Router()

// Create new issue report
router.post('/', requireAuth, uploadSingle, async (req, res) => {
  try {
    const { title, description, priority = 'medium', receipt_draft_id = null } = req.body || {}
    
    if (!title || !description) {
      return res.status(400).json({ error: 'missing_fields', detail: 'Issue title and description are required' })
    }

    // Validate priority
    const validPriorities = ['low', 'medium', 'high', 'urgent']
    const issuePriority = validPriorities.includes(priority) ? priority : 'medium'

    // Handle photo upload if provided
    let photoFile = null
    if (req.file) {
      photoFile = {
        id: Date.now() + Math.random(),
        original_name: req.file.originalname,
        filename: req.file.filename,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        uploaded_at: new Date().toISOString(),
        file_path: req.file.path
      }
    }

    // Get the next issue ID
    const maxIdResult = await q(`
      FOR issue IN issues
      COLLECT AGGREGATE maxId = MAX(issue.id)
      RETURN maxId
    `)
    const nextId = (maxIdResult[0] || 0) + 1

    const issueDoc = {
      id: nextId,
      title,
      description,
      priority: issuePriority,
      receipt_draft_id,
      photo: photoFile,
      created_by: req.user.sub,
      created_at: new Date().toISOString(),
      status: 'open',
      fixes: [],
      ip_address: req.ip,
      user_agent: req.get('User-Agent')
    }

    const result = await getCollection('issues').save(issueDoc)
    
    res.status(201).json({ 
      id: nextId,
      message: 'Issue reported successfully',
      issue: {
        id: nextId,
        title,
        description,
        priority: issuePriority,
        receipt_draft_id,
        photo: photoFile,
        created_by: req.user.sub,
        created_at: issueDoc.created_at,
        status: 'open',
        fixes: []
      }
    })
  } catch (error) {
    console.error('Error creating issue report:', error)
    
    // Clean up uploaded file if database insert fails
    if (req.file) {
      try {
        const fs = await import('fs')
        fs.unlinkSync(req.file.path)
      } catch (unlinkError) {
        console.error('Failed to clean up file:', unlinkError)
      }
    }
    
    res.status(500).json({ error: 'server_error', detail: 'Failed to create issue report' })
  }
})

// Get user's own issues
router.get('/my', requireAuth, async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      status = 'all'
    } = req.query

    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numLimit = s
    const numOffset = (p - 1) * s

    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'status', 'title', 'id', 'priority'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    let filterClause = 'FILTER issue.created_by == @user_id'
    let bindVars = { user_id: req.user.sub }

    if (status !== 'all') {
      filterClause += ' && issue.status == @status'
      bindVars.status = status
    }

    const query = `
      FOR issue IN issues
      ${filterClause}
      LET created_by_user = (
        FOR user IN users
        FILTER user._key == issue.created_by
        LIMIT 1
        RETURN {
          id: user._key,
          emp_code: user.emp_code,
          name: user.name,
          email: user.email,
          branch: user.branch,
          role: user.role
        }
      )[0]
      SORT issue.${orderBy} ${sortDir}
      LIMIT ${numOffset}, ${numLimit}
      RETURN MERGE(issue, { created_by_user })
    `

    const countQuery = `
      FOR issue IN issues
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.pageSkip

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ 
      page: p, 
      size: s, 
      total, 
      items: rows 
    })
  } catch (error) {
    console.error('Error fetching user issues:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get all issues (admin only)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      status = 'all'
    } = req.query

    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numLimit = s
    const numOffset = (p - 1) * s

    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'status', 'title', 'id', 'priority'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    let filterClause = ''
    let bindVars = {}

    if (status !== 'all') {
      filterClause = 'FILTER issue.status == @status'
      bindVars.status = status
    }

    const query = `
      FOR issue IN issues
      ${filterClause}
      LET created_by_user = (
        FOR user IN users
        FILTER user._key == issue.created_by
        LIMIT 1
        RETURN {
          id: user._key,
          emp_code: user.emp_code,
          name: user.name,
          email: user.email,
          branch: user.branch,
          role: user.role
        }
      )[0]
      LET updated_by_user = issue.updated_by ? (
        FOR user IN users
        FILTER user._key == issue.updated_by
        LIMIT 1
        RETURN {
          id: user._key,
          emp_code: user.emp_code,
          name: user.name,
          email: user.email,
          branch: user.branch,
          role: user.role
        }
      )[0] : null
      SORT issue.${orderBy} ${sortDir}
      LIMIT ${numOffset}, ${numLimit}
      RETURN MERGE(issue, { 
        created_by_user,
        updated_by_user
      })
    `

    const countQuery = `
      FOR issue IN issues
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.pageSkip

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])

    const total = totalResult[0] || 0

    res.json({ 
      page: p, 
      size: s, 
      total, 
      items: rows 
    })
  } catch (error) {
    console.error('Error fetching issues:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get issue photo (must come before /:id route)
router.get('/:id/photo', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    console.log(`[Photo Route] Request for issue ${id} photo`)
    
    const issues = await q(`
      FOR issue IN issues
      FILTER issue.id == @id
      LIMIT 1
      RETURN issue
    `, { id: parseInt(id) })
    
    if (!issues.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Issue not found' })
    }
    
    const issue = issues[0]
    
    // Check if user can access this issue (admin or creator)
    if (req.user.role !== 'admin' && issue.created_by !== req.user.sub) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied' })
    }
    
    if (!issue.photo) {
      return res.status(404).json({ error: 'not_found', detail: 'Photo not found in issue' })
    }
    
    const fs = await import('fs')
    const path = await import('path')
    const { uploadsDir } = await import('../config/environment.js')
    
    // Get filename from photo object, or extract from file_path
    let filename = issue.photo.filename
    if (!filename && issue.photo.file_path) {
      const pathParts = issue.photo.file_path.split(/[/\\]/)
      filename = pathParts[pathParts.length - 1]
    }
    
    if (!filename) {
      return res.status(404).json({ error: 'not_found', detail: 'Photo filename not available' })
    }
    
    // Try multiple possible paths - prioritize file_path if it's absolute
    let filePath = null
    
    // First, try using file_path if it's an absolute path (most reliable)
    if (issue.photo.file_path && path.isAbsolute(issue.photo.file_path)) {
      filePath = issue.photo.file_path
    } else {
      // Otherwise, resolve from uploadsDir with filename
      filePath = path.resolve(uploadsDir, filename)
    }
    
    // If still not found and file_path exists but isn't absolute, try resolving it
    if (!fs.existsSync(filePath) && issue.photo.file_path && !path.isAbsolute(issue.photo.file_path)) {
      filePath = path.resolve(uploadsDir, issue.photo.file_path)
    }
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`[Photo Route] Photo file not found`)
      console.error(`  - Filename: ${filename}`)
      console.error(`  - Uploads directory: ${uploadsDir}`)
      console.error(`  - Attempted path: ${filePath}`)
      console.error(`  - Photo object:`, JSON.stringify(issue.photo, null, 2))
      
      // List files in uploads directory for debugging
      try {
        const files = fs.readdirSync(uploadsDir)
        console.error(`  - Files in uploads directory:`, files.slice(0, 10))
      } catch (err) {
        console.error(`  - Error reading uploads directory:`, err.message)
      }
      
      return res.status(404).json({ 
        error: 'not_found', 
        detail: 'Photo file not found on server',
        debug: {
          filename,
          uploadsDir,
          filePath,
          fileExists: fs.existsSync(filePath)
        }
      })
    }
    
    // Set appropriate content type
    const mimeType = issue.photo.mime_type || 'image/jpeg'
    res.setHeader('Content-Type', mimeType)
    
    console.log(`[Photo Route] Sending file: ${filePath}`)
    // Send the file with absolute path
    res.sendFile(filePath)
  } catch (error) {
    console.error('Error fetching issue photo:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Get single issue by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    
    const issues = await q(`
      FOR issue IN issues
      FILTER issue.id == @id
      LIMIT 1
      LET created_by_user = (
        FOR user IN users
        FILTER user._key == issue.created_by
        LIMIT 1
        RETURN {
          id: user._key,
          emp_code: user.emp_code,
          name: user.name,
          email: user.email,
          branch: user.branch,
          role: user.role
        }
      )[0]
      LET updated_by_user = issue.updated_by ? (
        FOR user IN users
        FILTER user._key == issue.updated_by
        LIMIT 1
        RETURN {
          id: user._key,
          emp_code: user.emp_code,
          name: user.name,
          email: user.email,
          branch: user.branch,
          role: user.role
        }
      )[0] : null
      LET enriched_fixes = issue.fixes ? (
        FOR fix IN issue.fixes
        LET fix_user = fix.created_by ? (
          FOR user IN users
          FILTER user._key == fix.created_by
          LIMIT 1
          RETURN {
            id: user._key,
            emp_code: user.emp_code,
            name: user.name,
            email: user.email,
            branch: user.branch,
            role: user.role
          }
        )[0] : null
        RETURN MERGE(fix, { created_by_user: fix_user })
      ) : []
      RETURN MERGE(issue, { 
        created_by_user,
        updated_by_user,
        fixes: enriched_fixes
      })
    `, { id: parseInt(id) })
    
    if (!issues.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Issue not found' })
    }
    
    const issue = issues[0]
    
    // Check if user can access this issue (admin or creator)
    if (req.user.role !== 'admin' && issue.created_by !== req.user.sub) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied' })
    }
    
    res.json(issue)
  } catch (error) {
    console.error('Error fetching issue:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Update issue status (admin only)
router.patch('/:id/status', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body || {}
    
    if (!status) {
      return res.status(400).json({ error: 'missing_status', detail: 'Status is required' })
    }
    
    const validStatuses = ['open', 'in_progress', 'resolved', 'closed']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', detail: `Status must be one of: ${validStatuses.join(', ')}` })
    }
    
    const result = await q(`
      FOR issue IN issues
      FILTER issue.id == @id
      UPDATE issue WITH { 
        status: @status,
        updated_at: DATE_NOW(),
        updated_by: @user_id
      } IN issues
      RETURN NEW
    `, { id: parseInt(id), status, user_id: req.user.sub })
    
    if (!result.length) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    res.json({ 
      message: 'Status updated successfully',
      issue: result[0]
    })
  } catch (error) {
    console.error('Error updating issue status:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Post a fix/response to an issue (admin only)
router.post('/:id/fix', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params
    const { fix_text } = req.body || {}
    
    if (!fix_text || !fix_text.trim()) {
      return res.status(400).json({ error: 'missing_fix_text', detail: 'Fix text is required' })
    }
    
    // Get the issue first
    const issues = await q(`
      FOR issue IN issues
      FILTER issue.id == @id
      LIMIT 1
      RETURN issue
    `, { id: parseInt(id) })
    
    if (!issues.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Issue not found' })
    }
    
    const issue = issues[0]
    const fixes = issue.fixes || []
    
    // Add new fix
    const newFix = {
      id: fixes.length + 1,
      text: fix_text.trim(),
      created_by: req.user.sub,
      created_at: new Date().toISOString()
    }
    
    fixes.push(newFix)
    
    // Update the issue with the new fix
    const result = await q(`
      FOR issue IN issues
      FILTER issue.id == @id
      UPDATE issue WITH { 
        fixes: @fixes,
        updated_at: DATE_NOW(),
        updated_by: @user_id
      } IN issues
      RETURN NEW
    `, { id: parseInt(id), fixes, user_id: req.user.sub })
    
    if (!result.length) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    res.json({ 
      message: 'Fix added successfully',
      issue: result[0],
      fix: newFix
    })
  } catch (error) {
    console.error('Error adding fix to issue:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Update issue priority (admin only)
router.patch('/:id/priority', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params
    const { priority } = req.body || {}
    
    if (!priority) {
      return res.status(400).json({ error: 'missing_priority', detail: 'Priority is required' })
    }
    
    const validPriorities = ['low', 'medium', 'high', 'urgent']
    if (!validPriorities.includes(priority)) {
      return res.status(400).json({ error: 'invalid_priority', detail: `Priority must be one of: ${validPriorities.join(', ')}` })
    }
    
    const result = await q(`
      FOR issue IN issues
      FILTER issue.id == @id
      UPDATE issue WITH { 
        priority: @priority,
        updated_at: DATE_NOW(),
        updated_by: @user_id
      } IN issues
      RETURN NEW
    `, { id: parseInt(id), priority, user_id: req.user.sub })
    
    if (!result.length) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    res.json({ 
      message: 'Priority updated successfully',
      issue: result[0]
    })
  } catch (error) {
    console.error('Error updating issue priority:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
