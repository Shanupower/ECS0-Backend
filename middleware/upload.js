import multer from 'multer'
import path from 'path'
import { uploadsDir } from '../config/environment.js'

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir)
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, `receipt-${uniqueSuffix}${ext}`)
  }
})

const fileFilter = (req, file, cb) => {
  // Allow images, PDFs, and common document formats
  const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt/
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase())
  const mimetype = allowedTypes.test(file.mimetype)
  
  if (mimetype && extname) {
    return cb(null, true)
  } else {
    cb(new Error('Only images, PDFs, and documents are allowed'))
  }
}

export const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: fileFilter
})

export const uploadSingle = upload.single('screenshot')
export const uploadMultiple = upload.array('files', 10)
export { uploadsDir }
