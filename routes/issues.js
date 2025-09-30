import express from 'express'
import { q, getCollection } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadSingle } from '../middleware/upload.js'

const router = express.Router()

// Create new issue report
router.post('/', uploadSingle, async (req, res) => {
  try {
    const { issue, description } = req.body || {}
    
    if (!issue || !description) {
      return res.status(400).json({ error: 'missing_fields', detail: 'Issue title and description are required' })
    }

    // Handle screenshot upload if provided
    let screenshotFile = null
    if (req.file) {
      screenshotFile = {
        id: Date.now() + Math.random(),
        original_name: req.file.originalname,
        filename: req.file.filename,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        uploaded_at: new Date().toISOString()
      }
    }

    const issueDoc = {
      issue,
      description,
      screenshot: screenshotFile,
      status: 'open',
      created_at: new Date().toISOString(),
      ip_address: req.ip,
      user_agent: req.get('User-Agent')
    }

    const result = await getCollection('issues').save(issueDoc)
    
    res.status(201).json({ 
      id: result._key,
      message: 'Issue reported successfully'
    })
  } catch (error) {
    console.error('Error creating issue report:', error)
    
    // Clean up uploaded file if database insert fails
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path)
      } catch (unlinkError) {
        console.error('Failed to clean up file:', unlinkError)
      }
    }
    
    res.status(500).json({ error: 'server_error', detail: 'Failed to create issue report' })
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
    const allowedSort = new Set(['created_at', 'status', 'issue'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'

    let filterClause = ''
    let bindVars = { limit: numLimit, offset: numOffset }

    if (status !== 'all') {
      filterClause = 'FILTER issue.status == @status'
      bindVars.status = status
    }

    const query = `
      FOR issue IN issues
      ${filterClause}
      SORT issue.${orderBy} ${sortDir}
      LIMIT @offset, @limit
      RETURN issue
    `

    const countQuery = `
      FOR issue IN issues
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `

    const countBindVars = { ...bindVars }
    delete countBindVars.limit
    delete countBindVars.offset

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
      FILTER issue._key == @id
      UPDATE issue WITH { 
        status: @status,
        updated_at: DATE_NOW(),
        updated_by: @user_id
      } IN issues
      RETURN NEW
    `, { id, status, user_id: req.user.sub })
    
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

export default router
