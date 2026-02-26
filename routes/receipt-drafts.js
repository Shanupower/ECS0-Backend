import express from 'express'
import db, { q, getCollection } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = express.Router()

async function ensureDraftsCollection() {
  const collection = db.collection('receipt_drafts')
  const exists = await collection.exists()
  if (!exists) {
    await collection.create()
  }
  return collection
}

// Create a failed receipt draft
router.post('/', requireAuth, async (req, res) => {
  try {
    const payload = req.body || {}
    if (!payload.draft_data) {
      return res.status(400).json({ error: 'validation_error', detail: 'draft_data is required' })
    }

    await ensureDraftsCollection()

    const draftDoc = {
      draft_data: payload.draft_data,
      source: payload.source || 'failed_receipt',
      error_message: payload.error_message || null,
      created_by: req.user.sub,
      created_at: new Date().toISOString()
    }

    const result = await getCollection('receipt_drafts').save(draftDoc)
    res.status(201).json({ id: result._key, draft_id: result._key })
  } catch (error) {
    console.error('Error creating receipt draft:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to create receipt draft' })
  }
})

// List receipt drafts for the current user (employee sees own drafts; admin sees own by default)
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureDraftsCollection()
    const createdBy = req.user.sub
    const drafts = await q(`
      FOR draft IN receipt_drafts
      FILTER draft.created_by == @createdBy
      SORT draft.created_at DESC
      RETURN draft
    `, { createdBy })
    res.json(drafts || [])
  } catch (error) {
    console.error('Error listing receipt drafts:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to list receipt drafts' })
  }
})

// Get a receipt draft by id (admin or owner)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    await ensureDraftsCollection()
    const drafts = await q(`
      FOR draft IN receipt_drafts
      FILTER draft._key == @id
      LIMIT 1
      RETURN draft
    `, { id })

    if (!drafts.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Draft not found' })
    }

    const draft = drafts[0]
    if (req.user.role !== 'admin' && draft.created_by !== req.user.sub) {
      return res.status(403).json({ error: 'forbidden', detail: 'Access denied' })
    }

    res.json(draft)
  } catch (error) {
    console.error('Error fetching receipt draft:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to fetch receipt draft' })
  }
})

export default router
