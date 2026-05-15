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
import receiptDraftRoutes from './routes/receipt-drafts.js'
import branchRoutes from './routes/branches.js'
import statsRoutes from './routes/stats.js'
import exportRoutes from './routes/export.js'
import issueRoutes from './routes/issues.js'
import taskRoutes from './routes/tasks.js'
import leadRoutes, { runLeadArchiveSweep } from './routes/leads.js'
import appConfigRoutes from './routes/app-config.js'
import auditRoutes from './routes/audit.js'
import taskTemplateRoutes, { runDueTemplates } from './routes/task-templates.js'
import taskAiRoutes from './routes/task-ai.js'
import teamRoutes from './routes/teams.js'
import receiptApprovalsRoutes from './routes/receipt-approvals.js'
import notificationRoutes from './routes/notifications.js'
import handoffRoutes from './routes/handoff.js'
import { runRecurrenceSweep } from './services/task-recurrence.js'
import { runSlaBreachSweep } from './services/task-sla.js'
import { startAutomationEngine } from './services/task-automation.js'
import schemeRoutes from './routes/schemes.js'
import fdSchemeRoutes from './routes/fd-schemes.js'
import ncdBondSchemeRoutes from './routes/ncd-bonds-schemes.js'
import insuranceSchemeRoutes from './routes/insurance-schemes.js'
import miscServicesSchemeRoutes from './routes/misc-services-schemes.js'
import reportsRoutes from './routes/reports.js'

const app = express()

// Trust proxy for rate limiting behind Nginx
app.set('trust proxy', 1)

// Middleware
app.use(express.json({ limit: '12mb' }))
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, credentials: true }))

// Serve uploaded files statically
app.use('/uploads', express.static(uploadsDir))

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'ECS Backend API SERVER Setup by github ci cd ',
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
app.use('/api/receipt-drafts', receiptDraftRoutes) // Receipt drafts
app.use('/api/branches', branchRoutes)
app.use('/api/stats', statsRoutes)
app.use('/api/export', exportRoutes)
app.use('/api/issues', issueRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/task-templates', taskTemplateRoutes)
app.use('/api/task-ai', taskAiRoutes)
app.use('/api/teams', teamRoutes)
app.use('/api/receipt-approvals', receiptApprovalsRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/handoffs', handoffRoutes)
app.use('/api/leads', leadRoutes)
app.use('/api/app-config', appConfigRoutes)
app.use('/api/audit', auditRoutes)
app.use('/api/schemes', schemeRoutes) // MF Schemes routes
app.use('/api/fd-schemes', fdSchemeRoutes) // FD Schemes routes
app.use('/api/ncd-bonds-schemes', ncdBondSchemeRoutes) // NCD/Bond Schemes routes
app.use('/api/insurance-schemes', insuranceSchemeRoutes) // Insurance Schemes routes
app.use('/api/misc-services-schemes', miscServicesSchemeRoutes) // Misc Services Schemes routes
app.use('/api/reports', reportsRoutes)

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
  console.log('github ci cd works - backend')
  console.log('API listening on', PORT)

  // Lead archival sweep: run once at startup (after a short delay), then every 24h.
  const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
  setTimeout(() => {
    runLeadArchiveSweep().catch(err => console.error('initial lead archive sweep failed:', err))
  }, 30_000)
  setInterval(() => {
    runLeadArchiveSweep().catch(err => console.error('scheduled lead archive sweep failed:', err))
  }, SWEEP_INTERVAL_MS)

  // Task automation: subscribe rule engine to the event bus.
  try { startAutomationEngine() }
  catch (err) { console.error('failed to start automation engine:', err) }

  // Recurrence materialiser: run hourly with 7d lookahead.
  const HOURLY_MS = 60 * 60 * 1000
  setTimeout(() => {
    runRecurrenceSweep().catch(err => console.error('initial recurrence sweep failed:', err))
  }, 45_000)
  setInterval(() => {
    runRecurrenceSweep().catch(err => console.error('scheduled recurrence sweep failed:', err))
  }, HOURLY_MS)

  // SLA breach sweep: every 15 minutes.
  const SLA_MS = 15 * 60 * 1000
  setTimeout(() => {
    runSlaBreachSweep().catch(err => console.error('initial SLA sweep failed:', err))
  }, 60_000)
  setInterval(() => {
    runSlaBreachSweep().catch(err => console.error('scheduled SLA sweep failed:', err))
  }, SLA_MS)

  // Task templates scheduler: every 10 minutes check which templates are due.
  const TEMPLATES_MS = 10 * 60 * 1000
  setTimeout(() => {
    runDueTemplates().catch(err => console.error('initial templates run failed:', err))
  }, 90_000)
  setInterval(() => {
    runDueTemplates().catch(err => console.error('scheduled templates run failed:', err))
  }, TEMPLATES_MS)
})
