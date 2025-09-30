import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const {
  PORT = 8080,
  ARANGO_URL = 'http://localhost:8529',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend',
  JWT_SECRET = 'change-me',
  CORS_ORIGIN = '*'
} = process.env

// File upload configuration
export const uploadsDir = path.join(__dirname, '..', 'uploads', 'receipts')

// Ensure uploads directory exists
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true })
}
