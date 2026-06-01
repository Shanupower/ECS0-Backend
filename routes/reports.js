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
  runProductDetailReport,
  runCategoryWiseAllProducts,
  runSipReport,
  runFdMaturityReport,
  runCashFlowReport,
  runPendingReceiptsReport
} from '../services/reports/operational-reports.js'
import { sendCsvReport, sendXlsxReport } from '../services/reports/report-export.js'
import { runReportFilterOptions } from '../services/reports/filter-options.js'
import {
  runCustomerDetailReport,
  buildCustomerDetailCsvRows,
  customerDetailCsvHeaders,
  sendCustomerDetailXlsx,
  CustomerDetailReportError
} from '../services/reports/customer-detail-report.js'

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
    id: 'product-detail',
    title: 'Product-wise Detail',
    description: 'Product, scheme, client, date, branch, RM, CC, and amount detail.',
    path: '/api/reports/product-detail',
    icon: 'ListFilter'
  },
  {
    id: 'category-summary',
    title: 'Category-wise Summary',
    description: 'All product categories grouped by scheme and type, including FD cumulative type.',
    path: '/api/reports/category-summary',
    icon: 'Boxes'
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
    id: 'fd-maturity',
    title: 'Maturity Report',
    description: 'All product maturity report with product category, scheme, client, and due dates.',
    path: '/api/reports/fd-maturity',
    icon: 'CalendarClock'
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
  },
  {
    id: 'customer-detail',
    title: 'Customer Detail Report',
    description: 'Selected customers with product, category, fund, and transaction breakdowns.',
    path: '/api/reports/customer-detail',
    icon: 'Users',
    group: 'Customers Report'
  }
]

function exportFormat(query) {
  const fmt = String(query.format || '').toLowerCase()
  return fmt === 'csv' || fmt === 'xlsx' ? fmt : ''
}

function queryFlag(query, key) {
  const value = query?.[key]
  return value === true || value === '1' || value === 'true'
}

export function filterReportExportColumns(headers, rows, query = {}) {
  const hideCc = queryFlag(query, 'hide_cc') || queryFlag(query, 'hideCc')
  const hideSi = queryFlag(query, 'hide_si') || queryFlag(query, 'hideSi')
  if (!hideCc && !hideSi) return { headers, rows }

  const shouldKeep = (header) => {
    const h = String(header || '').trim().toLowerCase()
    if (hideCc && h === 'cc') return false
    if (hideSi && (h === 'si' || h === 'incentive' || h === 'incentive paid')) return false
    return true
  }
  const indexes = headers.map((header, index) => (shouldKeep(header) ? index : -1)).filter((index) => index >= 0)
  return {
    headers: indexes.map((index) => headers[index]),
    rows: (rows || []).map((row) => indexes.map((index) => row[index]))
  }
}

async function sendReportRows(res, filenameBase, headers, rows, fmt, query = {}) {
  const filtered = filterReportExportColumns(headers, rows, query)
  if (fmt === 'xlsx') await sendXlsxReport(res, filenameBase, filtered.headers, filtered.rows)
  else sendCsvReport(res, filenameBase, filtered.headers, filtered.rows)
}

function misSummaryExport(data) {
  const rows = []
  for (const r of data.product_summary || []) {
    rows.push(['Product Summary', r.product_type ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', '', ''])
  }
  for (const r of data.mf_category_summary || []) {
    rows.push(['MF Category Summary', r.category ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', '', ''])
  }
  for (const r of data.issuer_sales || []) {
    rows.push(['Company / Fund Sales', r.company_fund_name ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', '', ''])
  }
  const pm = data.previous_month_totals || {}
  rows.push(['Previous Month Totals', 'Previous Month', pm.applications ?? 0, pm.amount ?? 0, pm.collection_credit ?? 0, pm.incentive_amount ?? '', pm.period_from ?? '', pm.period_to ?? ''])
  return rows
}

const aggregateHeaders = ['Name', 'Applications', 'Amount', 'CC', 'Incentive']
const aggregateRow = (nameKey) => (r) => [
  r[nameKey] ?? '',
  r.applications ?? 0,
  r.amount ?? 0,
  r.collection_credit ?? 0,
  r.incentive_amount ?? ''
]

const productDetailHeaders = ['Date', 'Receipt Number', 'Client ID', 'Client Name', 'PAN', 'Product Category', 'Issuer', 'Scheme', 'Amount', 'CC', 'SI', 'Branch Code', 'RM Code', 'Status']
const productDetailRow = (r) => [r.date ?? '', r.receipt_number ?? '', r.client_id ?? '', r.client_name ?? '', r.pan ?? '', r.product_category ?? '', r.issuer ?? '', r.scheme_name ?? '', r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', r.branch_code ?? '', r.emp_code ?? '', r.status ?? '']

const categorySummaryHeaders = ['Product Category', 'Issuer', 'Scheme', 'Type', 'FD Payout Frequency', 'Applications', 'Amount', 'CC', 'SI']
const categorySummaryRow = (r) => [r.product_category ?? '', r.issuer_name ?? '', r.scheme_name ?? '', r.type ?? '', r.fd_payout_frequency ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '']

const sipHeaders = ['Date', 'Product', 'Issuer', 'Client ID', 'Client Name', 'Folio', 'Scheme', 'SIP Amount', 'CC', 'SI', 'Frequency', 'Start Date', 'Next Due Date', 'End Date', 'Last Installment Date', 'Branch Code', 'RM Code', 'Receipt Number', 'Status']
const sipRow = (r) => [r.date ?? '', r.product_category ?? '', r.issuer ?? '', r.client_id ?? '', r.client_name ?? '', r.folio ?? '', r.scheme ?? '', r.sip_amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', r.frequency ?? '', r.start_date ?? '', r.next_due_date ?? '', r.end_date ?? '', r.last_installment_date ?? '', r.branch_code ?? '', r.emp_code ?? '', r.receipt_number ?? '', r.status ?? '']

const fdMaturityHeaders = ['Receipt Date', 'Maturity Date', 'Product Category', 'Issuer', 'Scheme', 'Type', 'FD Payout Frequency', 'Client ID', 'Client Name', 'Amount', 'Maturity Amount', 'CC', 'SI', 'Branch Code', 'RM Code', 'Receipt Number', 'Status']
const fdMaturityRow = (r) => [r.receipt_date ?? '', r.maturity_date ?? '', r.product_category ?? '', r.issuer ?? '', r.scheme_name ?? '', r.type ?? '', r.fd_payout_frequency ?? '', r.client_id ?? '', r.client_name ?? '', r.amount ?? 0, r.maturity_amount ?? '', r.collection_credit ?? 0, r.incentive_amount ?? '', r.branch_code ?? '', r.emp_code ?? '', r.receipt_number ?? '', r.status ?? '']

const pendingHeaders = ['Receipt ID', 'Client', 'Product', 'Amount', 'Stage', 'Assigned', 'Created At', 'Days Pending', 'As Of']
const pendingRow = (r) => [r.receipt_id ?? '', r.client_name ?? '', r.product_type ?? '', r.amount ?? 0, r.current_stage ?? '', r.assigned_to ?? '', r.created_at ?? '', r.days_pending ?? '', r.as_of ?? '']

const cashflowHeaders = ['Product / Fund', 'Purchase', 'SIP', 'Switch In', 'Redemption', 'Switch Out', 'Unknown', 'Net Flow']
const cashflowRow = (r) => [r.product_fund ?? '', r.purchase ?? 0, r.sip ?? 0, r.switch_in ?? 0, r.redemption ?? 0, r.switch_out ?? 0, r.unknown ?? 0, r.net_flow ?? 0]

// All report endpoints are admin-only (MIS / operational analytics).
router.use(requireAuth, requireRole('admin'))

router.get('/registry', (req, res) => {
  res.json({ reports: REPORT_REGISTRY })
})

router.get('/filter-options', async (req, res) => {
  try {
    const data = await runReportFilterOptions()
    res.json(data)
  } catch (e) {
    console.error('[reports] filter-options', e)
    res.status(500).json({ error: 'Failed to load filter options' })
  }
})

router.get('/mis-summary', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const data = await runMisSummary(req.user, req.query)
    if (fmt) {
      await sendReportRows(
        res,
        'mis_summary',
        ['Section', 'Name', 'Applications', 'Amount', 'CC', 'Incentive', 'Period From', 'Period To'],
        misSummaryExport(data),
        fmt,
        req.query
      )
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] mis-summary', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mis-transactions', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    if (fmt) {
      const query = { ...req.query, page: '1', page_size: '50000' }
      const { rows, group_by } = await runMisTransactions(req.user, query)
      if (group_by) {
        const headers = group_by === 'rm'
          ? ['RM Code', 'Employee Name', 'Applications', 'Amount', 'CC', 'Incentive']
          : [group_by === 'branch' ? 'Branch Code' : 'Group', 'Applications', 'Amount', 'CC', 'Incentive']
        const arr = rows.map((r) => group_by === 'rm'
          ? [r.group_key ?? '', r.employee_name ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '']
          : [r.group_key ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? ''])
        await sendReportRows(res, 'mis_transactions_grouped', headers, arr, fmt, req.query)
        return
      }
      const headers = misTransactionExportHeaders()
      const arr = rows.map(misTransactionRowToArray)
      await sendReportRows(res, 'mis_transactions', headers, arr, fmt, req.query)
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
    const fmt = exportFormat(req.query)
    const rows = await runProductWiseSales(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'product_sales', aggregateHeaders, rows.map(aggregateRow('product_type')), fmt, req.query)
      return
    }
    res.json({ rows })
  } catch (e) {
    console.error('[reports] product-sales', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/product-detail', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const data = await runProductDetailReport(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'product_detail', productDetailHeaders, data.rows.map(productDetailRow), fmt, req.query)
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] product-detail', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/category-summary', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const rows = await runCategoryWiseAllProducts(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'category_summary', categorySummaryHeaders, rows.map(categorySummaryRow), fmt, req.query)
      return
    }
    res.json({ rows })
  } catch (e) {
    console.error('[reports] category-summary', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mf-category', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const rows = await runCategoryWiseMf(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'mf_category', aggregateHeaders, rows.map(aggregateRow('category')), fmt, req.query)
      return
    }
    res.json({ rows })
  } catch (e) {
    console.error('[reports] mf-category', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mf-fund', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const rows = await runFundWiseMf(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'mf_fund', aggregateHeaders, rows.map(aggregateRow('fund_name')), fmt, req.query)
      return
    }
    res.json({ rows })
  } catch (e) {
    console.error('[reports] mf-fund', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/sip-report', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const data = await runSipReport(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'sip_due_end', sipHeaders, data.rows.map(sipRow), fmt, req.query)
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] sip-report', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/fd-maturity', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const data = await runFdMaturityReport(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'fd_maturity', fdMaturityHeaders, data.rows.map(fdMaturityRow), fmt, req.query)
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] fd-maturity', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/cashflow', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const rows = await runCashFlowReport(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'cashflow', cashflowHeaders, rows.map(cashflowRow), fmt, req.query)
      return
    }
    res.json({ rows })
  } catch (e) {
    console.error('[reports] cashflow', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/pending-receipts', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const data = await runPendingReceiptsReport(req.user, req.query)
    if (fmt) {
      await sendReportRows(res, 'pending_receipts', pendingHeaders, data.rows.map(pendingRow), fmt, req.query)
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] pending-receipts', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/customer-detail', async (req, res) => {
  try {
    const fmt = exportFormat(req.query)
    const query =
      fmt != null
        ? { ...req.query, page: '1', page_size: '50000' }
        : req.query
    const data = await runCustomerDetailReport(req.user, query)
    if (fmt === 'csv') {
      sendCsvReport(res, 'customer_detail', customerDetailCsvHeaders, buildCustomerDetailCsvRows(data))
      return
    }
    if (fmt === 'xlsx') {
      await sendCustomerDetailXlsx(res, 'customer_detail', data)
      return
    }
    res.json(data)
  } catch (e) {
    if (e instanceof CustomerDetailReportError) {
      res.status(e.status || 400).json({ error: e.message })
      return
    }
    console.error('[reports] customer-detail', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

export default router
