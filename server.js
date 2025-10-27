import 'dotenv/config'
import express from 'express'
import cors from 'cors'

// Import configuration
import { PORT, CORS_ORIGIN, uploadsDir } from './config/environment.js'

// Import routes
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import customerRoutes from './routes/customers.js'
import receiptRoutes from './routes/receipts.js'
import receiptMediaRoutes from './routes/receipt-media.js'
import receiptPdfRoutes from './routes/receipt-pdf.js'
import branchRoutes from './routes/branches.js'
import statsRoutes from './routes/stats.js'
import exportRoutes from './routes/export.js'
import issueRoutes from './routes/issues.js'
import schemeRoutes from './routes/schemes.js'
import fdSchemeRoutes from './routes/fd-schemes.js'

const app = express()

// Trust proxy for rate limiting behind Nginx
app.set('trust proxy', 1)

// Middleware
app.use(express.json({ limit: '1mb' }))
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, credentials: true }))

// Serve uploaded files statically
app.use('/uploads', express.static(uploadsDir))

// Root route
app.get('/', (req, res) => {
  res.json({ 
    message: 'ECS Backend API Server', 
    status: 'online',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  })
})

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  })
})

// API Routes
app.use('/api/auth', authRoutes)
app.use('/api/users', userRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/receipts', receiptRoutes)
app.use('/api/receipts', receiptMediaRoutes) // Receipt media routes
app.use('/api/receipts', receiptPdfRoutes) // Receipt PDF routes
app.use('/api/branches', branchRoutes)
app.use('/api/stats', statsRoutes)
app.use('/api/export', exportRoutes)
app.use('/api/issues', issueRoutes)
app.use('/api/schemes', schemeRoutes) // MF Schemes routes
app.use('/api/fd-schemes', fdSchemeRoutes) // FD Schemes routes

// Health endpoint for database connection
app.get('/health', async (req, res) => {
  try { 
    const { q } = await import('./config/database.js')
    await q('RETURN 1')
    res.json({ ok: true }) 
  }
  catch { 
    res.status(500).json({ ok: false }) 
  }
})

app.listen(PORT, () => {
  console.log('API listening on', PORT)
})
