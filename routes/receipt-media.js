import express from 'express'
import fs from 'fs'
import path from 'path'
import { q } from '../config/database.js'
import { requireAuth } from '../middleware/auth.js'
import { uploadMultiple, uploadsDir } from '../middleware/upload.js'

const router = express.Router()

// Upload media for receipt
router.post('/:id/media', requireAuth, uploadMultiple, async (req, res) => {
  try {
    const receiptId = req.params.id
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'no_files_uploaded' })
    }
    
    // Parse existing files or initialize empty array
    let existingFiles = receipt.files || []
    
    const uploadedFiles = []
    
    for (const file of req.files) {
      const fileData = {
        id: Date.now() + Math.random(), // Generate unique ID
        original_name: file.originalname,
        filename: file.filename,
        file_size: file.size,
        mime_type: file.mimetype,
        uploaded_by: req.user.sub,
        uploaded_at: new Date().toISOString()
      }
      
      existingFiles.push(fileData)
      uploadedFiles.push(fileData)
    }
    
    // Update the receipt with new files array
    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH { files: @files } IN receipts
    `, { id: receiptId, files: existingFiles })
    
    res.status(201).json({
      message: 'Files uploaded successfully',
      files: uploadedFiles
    })
    
  } catch (error) {
    console.error('Media upload error:', error)
    
    // Clean up uploaded files if database update fails
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path)
        } catch (unlinkError) {
          console.error('Failed to clean up file:', unlinkError)
        }
      })
    }
    
    res.status(500).json({ error: 'upload_failed', detail: error.message })
  }
})

// List media for receipt
router.get('/:id/media', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    // Parse files from JSON column
    let mediaFiles = []
    try {
      if (receipt.files) {
        const filesData = receipt.files
        // Get user names for uploaded_by fields
        const userIds = [...new Set(filesData.map(f => f.uploaded_by))]
        const users = await q(`
          FOR user IN users
          FILTER user._key IN @userIds
          RETURN { id: user._key, name: user.name }
        `, { userIds })
        const userMap = users.reduce((acc, user) => {
          acc[user.id] = user.name
          return acc
        }, {})
        
        mediaFiles = filesData.map(file => ({
          ...file,
          uploaded_by_name: userMap[file.uploaded_by] || 'Unknown'
        }))
      }
    } catch (parseError) {
      console.warn('Failed to parse files JSON:', parseError)
      mediaFiles = []
    }
    
    res.json(mediaFiles)
    
  } catch (error) {
    console.error('Media list error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Download media file
router.get('/:id/media/:mediaId', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    const mediaId = req.params.mediaId // Keep as string since it's generated as timestamp + random
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    // Parse files from JSON column and find the specific media
    let mediaFile = null
    try {
      if (receipt.files) {
        const filesData = receipt.files
        mediaFile = filesData.find(file => String(file.id) === String(mediaId))
      }
    } catch (parseError) {
      console.warn('Failed to parse files JSON:', parseError)
    }
    
    if (!mediaFile) {
      return res.status(404).json({ error: 'media_not_found' })
    }
    
    // Construct file path
    const filePath = path.join(uploadsDir, mediaFile.filename)
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'file_not_found' })
    }
    
    // Set appropriate headers
    res.setHeader('Content-Type', mediaFile.mime_type)
    res.setHeader('Content-Disposition', `attachment; filename="${mediaFile.original_name}"`)
    res.setHeader('Content-Length', mediaFile.file_size)
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath)
    fileStream.pipe(res)
    
  } catch (error) {
    console.error('Media download error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Delete media file
router.delete('/:id/media/:mediaId', requireAuth, async (req, res) => {
  try {
    const receiptId = req.params.id
    const mediaId = req.params.mediaId // Keep as string since it's generated as timestamp + random
    
    // Verify receipt exists and user has access
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, files: receipt.files }
    `, { id: receiptId })
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'receipt_not_found' })
    }
    
    const receipt = receiptRows[0]
    if (!(req.user.role === 'admin' || String(receipt.user_id) === String(req.user.sub))) {
      return res.status(403).json({ error: 'forbidden' })
    }
    
    // Parse files from JSON column and find the specific media
    let filesData = receipt.files || []
    let mediaFile = null
    try {
      mediaFile = filesData.find(file => String(file.id) === String(mediaId))
    } catch (parseError) {
      console.warn('Failed to parse files JSON:', parseError)
    }
    
    if (!mediaFile) {
      return res.status(404).json({ error: 'media_not_found' })
    }
    
    // Remove the file from the array
    const updatedFiles = filesData.filter(file => String(file.id) !== String(mediaId))
    
    // Update the receipt with the new files array
    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH { files: @files } IN receipts
    `, { id: receiptId, files: updatedFiles })
    
    // Optionally delete the physical file (uncomment if you want to delete files permanently)
    // try {
    //   const filePath = path.join(uploadsDir, mediaFile.filename)
    //   fs.unlinkSync(filePath)
    // } catch (unlinkError) {
    //   console.error('Failed to delete physical file:', unlinkError)
    // }
    
    res.status(204).end()
    
  } catch (error) {
    console.error('Media delete error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

export default router
