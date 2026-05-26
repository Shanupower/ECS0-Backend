import express from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { runMisSummary } from '../services/reports/mis-summary.js'
import {
  runMisTransactions,
  misTransactionExportHeaders,
  misTransactionRowToArray
} from '../services/reports/mis-transactions.js'
import {
  runProductWiseSales,
  runCategoryWiseMf,
  runFundWiseMf,
  runSipReport,
  runCashFlowReport,
  runPendingReceiptsReport
} from '../services/reports/operational-reports.js'
import { sendCsvReport, sendXlsxReport } from '../services/reports/report-export.js'

const router = express.Router()

const REPORT_REGISTRY = [
  {
    id: 'mis-summary',
    title: 'MIS Summary',
    description: 'Product, MF category, and issuer-level totals with previous-month footer.',
    path: '/api/reports/mis-summary',
    icon: 'LayoutDashboard'
  },
  {
    id: 'mis-transactions',
    title: 'Detailed Transaction MIS',
    description: 'Line-level receipts with grouping by product, AMC, branch, or RM.',
    path: '/api/reports/mis-transactions',
    icon: 'Table'
  },
  {
    id: 'product-sales',
    title: 'Product-wise Sales',
    description: 'Applications and amounts by product category.',
    path: '/api/reports/product-sales',
    icon: 'PieChart'
  },
  {
    id: 'mf-category',
    title: 'Category-wise Mutual Fund',
    description: 'MF totals grouped by scheme category.',
    path: '/api/reports/mf-category',
    icon: 'Layers'
  },
  {
    id: 'mf-fund',
    title: 'Fund-wise Mutual Fund',
    description: 'MF totals grouped by scheme / fund name.',
    path: '/api/reports/mf-fund',
    icon: 'TrendingUp'
  },
  {
    id: 'sip-report',
    title: 'SIP / Systematic',
    description: 'SIP registrations with schedule fields.',
    path: '/api/reports/sip-report',
    icon: 'Calendar'
  },
  {
    id: 'cashflow',
    title: 'Cash Flow',
    description: 'Inflows and outflows by product with net flow.',
    path: '/api/reports/cashflow',
    icon: 'ArrowLeftRight'
  },
  {
    id: 'pending-receipts',
    title: 'Pending Receipts',
    description: 'Non-completed receipts with days pending.',
    path: '/api/reports/pending-receipts',
    icon: 'Clock'
  }
]

// All report endpoints are admin-only (MIS / operational analytics).
router.use(requireAuth, requireRole('admin'))

router.get('/registry', (req, res) => {
  res.json({ reports: REPORT_REGISTRY })
})

router.get('/mis-summary', async (req, res) => {
  try {
    const data = await runMisSummary(req.user, req.query)
    res.json(data)
  } catch (e) {
    console.error('[reports] mis-summary', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mis-transactions', async (req, res) => {
  try {
    const fmt = String(req.query.format || '').toLowerCase()
    if (fmt === 'csv' || fmt === 'xlsx') {
      const query = { ...req.query, page: '1', page_size: '50000' }
      const { rows, group_by } = await runMisTransactions(req.user, query)
      if (group_by) {
        const headers = ['Group', 'Applications', 'Amount', 'Incentive']
        const arr = rows.map((r) => [
          r.group_key ?? '',
          r.applications ?? 0,
          r.amount ?? 0,
          r.incentive_amount ?? ''
        ])
        if (fmt === 'xlsx') await sendXlsxReport(res, 'mis_transactions_grouped', headers, arr)
        else sendCsvReport(res, 'mis_transactions_grouped', headers, arr)
        return
      }
      const headers = misTransactionExportHeaders()
      const arr = rows.map(misTransactionRowToArray)
      if (fmt === 'xlsx') await sendXlsxReport(res, 'mis_transactions', headers, arr)
      else sendCsvReport(res, 'mis_transactions', headers, arr)
      return
    }
    const data = await runMisTransactions(req.user, req.query)
    res.json(data)
  } catch (e) {
    console.error('[reports] mis-transactions', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/product-sales', async (req, res) => {
  try {
    const rows = await runProductWiseSales(req.user, req.query)
    res.json({ rows })
  } catch (e) {
    console.error('[reports] product-sales', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mf-category', async (req, res) => {
  try {
    const rows = await runCategoryWiseMf(req.user, req.query)
    res.json({ rows })
  } catch (e) {
    console.error('[reports] mf-category', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mf-fund', async (req, res) => {
  try {
    const rows = await runFundWiseMf(req.user, req.query)
    res.json({ rows })
  } catch (e) {
    console.error('[reports] mf-fund', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/sip-report', async (req, res) => {
  try {
    const data = await runSipReport(req.user, req.query)
    res.json(data)
  } catch (e) {
    console.error('[reports] sip-report', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/cashflow', async (req, res) => {
  try {
    const rows = await runCashFlowReport(req.user, req.query)
    res.json({ rows })
  } catch (e) {
    console.error('[reports] cashflow', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/pending-receipts', async (req, res) => {
  try {
    const data = await runPendingReceiptsReport(req.user, req.query)
    res.json(data)
  } catch (e) {
    console.error('[reports] pending-receipts', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

export default router
