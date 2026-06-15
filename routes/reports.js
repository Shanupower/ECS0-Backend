import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  canAccessAnalytics,
  buildRegistryScope,
  sanitizeReportQuery
} from '../constants/report-access.js'
import { runMisSummary } from '../services/reports/mis-summary.js'
import {
  runMisTransactions,
  misTransactionExportHeaders,
  misTransactionRowToArray
} from '../services/reports/mis-transactions.js'
import {
  runFundWiseMf,
  runProductDetailReport,
  runCategoryWiseAllProducts,
  runSipReport,
  runFdMaturityReport,
  runPendingReceiptsReport
} from '../services/reports/operational-reports.js'
import {
  buildExportMeta,
  sendCsvReport,
  sendXlsxReport,
  sendPdfReport,
  sendMisSummaryCsvReport,
  sendMisSummaryXlsxReport,
  sendMisSummaryPdfReport
} from '../services/reports/report-export.js'
import { runReportFilterOptions } from '../services/reports/filter-options.js'
import {
  runCustomerDetailReport,
  runCustomerDetailCustomerList,
  runCustomerDetailCustomerListIds,
  buildCustomerDetailCsvRows,
  customerDetailCsvHeaders,
  sendCustomerDetailXlsx,
  CustomerDetailReportError
} from '../services/reports/customer-detail-report.js'
import { runReceiptErrorsReport } from '../services/reports/receipt-errors-report.js'

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
    id: 'pending-receipts',
    title: 'Pending Receipts',
    description: 'Non-completed receipts with days pending.',
    path: '/api/reports/pending-receipts',
    icon: 'Clock'
  },
  {
    id: 'receipt-errors',
    title: 'Duplicate / Error Report',
    description: 'Duplicate transactions, receipt numbers, and data-quality issues (missing PAN, mobile, reference, invalid amount).',
    path: '/api/reports/receipt-errors',
    icon: 'AlertTriangle',
    group: 'Data Quality'
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
  return fmt === 'csv' || fmt === 'xlsx' || fmt === 'pdf' ? fmt : ''
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

const EXPORT_PAGE_SIZE = '50000'

function exportQuery(query) {
  return { ...query, page: '1', page_size: EXPORT_PAGE_SIZE }
}

function reportExportTitle(reportId) {
  const entry = REPORT_REGISTRY.find((r) => r.id === reportId)
  return entry?.title || reportId
}

function exportMetaFromQuery(reportId, query = {}) {
  return buildExportMeta({
    reportTitle: reportExportTitle(reportId),
    from: query.from,
    to: query.to
  })
}

async function sendReportRows(res, filenameBase, headers, rows, fmt, query = {}, reportId = filenameBase) {
  const filtered = filterReportExportColumns(headers, rows, query)
  const meta = exportMetaFromQuery(reportId, query)
  if (fmt === 'xlsx') await sendXlsxReport(res, filenameBase, filtered.headers, filtered.rows, meta)
  else if (fmt === 'pdf') await sendPdfReport(res, filenameBase, filtered.headers, filtered.rows, meta)
  else sendCsvReport(res, filenameBase, filtered.headers, filtered.rows, meta)
}

const aggregateHeaders = ['Name', 'Applications', 'Amount', 'CC', 'Incentive']
const aggregateRow = (nameKey) => (r) => [
  r[nameKey] ?? '',
  r.applications ?? 0,
  r.amount ?? 0,
  r.collection_credit ?? 0,
  r.incentive_amount ?? ''
]

const productDetailHeaders = ['Date', 'Receipt Number', 'Client ID', 'Client Name', 'PAN', 'Phone Number', 'Email Address', 'Product Category', 'Issuer', 'Scheme', 'Period', 'Month', 'Amount', 'CC', 'SI', 'Branch Code', 'RM Code', 'Status']
const productDetailRow = (r) => [r.date ?? '', r.receipt_number ?? '', r.client_id ?? '', r.client_name ?? '', r.pan ?? '', r.client_phone ?? '', r.client_email ?? '', r.product_category ?? '', r.issuer ?? '', r.scheme_name ?? '', r.period ?? '', r.months ?? '', r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', r.branch_code ?? '', r.emp_code ?? '', r.status ?? '']

const categorySummaryHeaders = ['Product Category', 'Issuer', 'Scheme', 'FD Payout Frequency', 'Applications', 'Amount', 'CC', 'SI']
const categorySummaryRow = (r) => [r.product_category ?? '', r.issuer_name ?? '', r.scheme_name ?? '', r.fd_payout_frequency ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '']

const sipHeaders = ['Date', 'Product', 'Issuer', 'Client ID', 'Client Name', 'Folio', 'Scheme', 'SIP Amount', 'CC', 'SI', 'Frequency', 'Period', 'Month', 'Start Date', 'End Date', 'Last Installment Date', 'Branch Code', 'RM Code', 'Receipt Number', 'Status']
const sipRow = (r) => [r.date ?? '', r.product_category ?? '', r.issuer ?? '', r.client_id ?? '', r.client_name ?? '', r.folio ?? '', r.scheme ?? '', r.sip_amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '', r.frequency ?? '', r.period ?? '', r.months ?? '', r.start_date ?? '', r.end_date ?? '', r.last_installment_date ?? '', r.branch_code ?? '', r.emp_code ?? '', r.receipt_number ?? '', r.status ?? '']

const fdMaturityHeaders = ['Receipt Date', 'Maturity Date', 'Product Category', 'Issuer', 'Scheme', 'Tenure/Period', 'Month', 'Type', 'FD Payout Frequency', 'Client ID', 'Client Name', 'Address', 'Amount', 'Maturity Amount', 'CC', 'SI', 'Branch Code', 'RM Code', 'Receipt Number', 'Status']
const fdMaturityRow = (r) => [r.receipt_date ?? '', r.maturity_date ?? '', r.product_category ?? '', r.issuer ?? '', r.scheme_name ?? '', r.period ?? '', r.months ?? '', r.type ?? '', r.fd_payout_frequency ?? '', r.client_id ?? '', r.client_name ?? '', r.client_address ?? '', r.amount ?? 0, r.maturity_amount ?? '', r.collection_credit ?? 0, r.incentive_amount ?? '', r.branch_code ?? '', r.emp_code ?? '', r.receipt_number ?? '', r.status ?? '']

const pendingHeaders = ['Receipt Number', 'Client', 'Product', 'Amount', 'Stage', 'Assigned', 'Created At', 'Days Pending', 'As Of']
const pendingRow = (r) => [r.receipt_number ?? '', r.client_name ?? '', r.product_type ?? '', r.amount ?? 0, r.current_stage ?? '', r.assigned_to ?? '', r.created_at ?? '', r.days_pending ?? '', r.as_of ?? '']

const receiptErrorsHeaders = ['Date', 'Receipt Number', 'Client ID', 'Client Name', 'PAN', 'Phone', 'Product', 'Amount', 'Reference', 'Branch', 'RM', 'Status', 'Error Types', 'Related Receipts']
const receiptErrorsRow = (r) => [
  r.date ?? '',
  r.receipt_number ?? '',
  r.client_id ?? '',
  r.client_name ?? '',
  r.pan ?? '',
  r.client_phone ?? '',
  r.product_category ?? '',
  r.amount ?? 0,
  r.reference_no ?? '',
  r.branch_code ?? '',
  r.emp_code ?? '',
  r.status ?? '',
  Array.isArray(r.error_types) ? r.error_types.join('; ') : '',
  Array.isArray(r.related_receipt_numbers) ? r.related_receipt_numbers.join('; ') : ''
]

function requireAnalyticsAccess(req, res, next) {
  if (!canAccessAnalytics(req.user?.role)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  next()
}

function prepareReportRequest(req, res, next) {
  req.reportQuery = sanitizeReportQuery(req.user.role, req.query)
  next()
}

router.use(requireAuth, requireAnalyticsAccess)

router.get('/registry', (req, res) => {
  res.json({
    reports: REPORT_REGISTRY,
    scope: buildRegistryScope(req.user.role)
  })
})

router.use(prepareReportRequest)

router.get('/filter-options', async (req, res) => {
  try {
    const data = await runReportFilterOptions(req.user, req.reportQuery)
    res.json(data)
  } catch (e) {
    console.error('[reports] filter-options', e)
    res.status(500).json({ error: 'Failed to load filter options' })
  }
})

router.get('/mis-summary', async (req, res) => {
  try {
    const fmt = exportFormat(req.reportQuery)
    const data = await runMisSummary(req.user, req.reportQuery)
    if (fmt) {
      const meta = exportMetaFromQuery('mis-summary', req.reportQuery)
      if (fmt === 'xlsx') await sendMisSummaryXlsxReport(res, 'mis_summary', data, meta)
      else if (fmt === 'pdf') await sendMisSummaryPdfReport(res, 'mis_summary', data, meta)
      else sendMisSummaryCsvReport(res, 'mis_summary', data, meta)
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
    const fmt = exportFormat(req.reportQuery)
    if (fmt) {
      const query = { ...req.reportQuery, page: '1', page_size: '50000' }
      const { rows, group_by } = await runMisTransactions(req.user, query)
      if (group_by) {
        const headers = group_by === 'rm'
          ? ['RM Code', 'Employee Name', 'Applications', 'Amount', 'CC', 'Incentive']
          : [group_by === 'branch' ? 'Branch Code' : 'Group', 'Applications', 'Amount', 'CC', 'Incentive']
        const arr = rows.map((r) => group_by === 'rm'
          ? [r.group_key ?? '', r.employee_name ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? '']
          : [r.group_key ?? '', r.applications ?? 0, r.amount ?? 0, r.collection_credit ?? 0, r.incentive_amount ?? ''])
        await sendReportRows(res, 'mis_transactions_grouped', headers, arr, fmt, req.reportQuery, 'mis-transactions')
        return
      }
      const headers = misTransactionExportHeaders()
      const arr = rows.map(misTransactionRowToArray)
      await sendReportRows(res, 'mis_transactions', headers, arr, fmt, req.reportQuery, 'mis-transactions')
      return
    }
    const data = await runMisTransactions(req.user, req.reportQuery)
    res.json(data)
  } catch (e) {
    console.error('[reports] mis-transactions', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/product-detail', async (req, res) => {
  try {
    const fmt = exportFormat(req.reportQuery)
    const query = fmt ? exportQuery(req.reportQuery) : req.reportQuery
    const data = await runProductDetailReport(req.user, query)
    if (fmt) {
      await sendReportRows(res, 'product_detail', productDetailHeaders, data.rows.map(productDetailRow), fmt, req.reportQuery, 'product-detail')
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
    const fmt = exportFormat(req.reportQuery)
    const rows = await runCategoryWiseAllProducts(req.user, req.reportQuery)
    if (fmt) {
      await sendReportRows(res, 'category_summary', categorySummaryHeaders, rows.map(categorySummaryRow), fmt, req.reportQuery, 'category-summary')
      return
    }
    res.json({ rows })
  } catch (e) {
    console.error('[reports] category-summary', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/mf-fund', async (req, res) => {
  try {
    const fmt = exportFormat(req.reportQuery)
    const rows = await runFundWiseMf(req.user, req.reportQuery)
    if (fmt) {
      await sendReportRows(res, 'mf_fund', aggregateHeaders, rows.map(aggregateRow('fund_name')), fmt, req.reportQuery, 'mf-fund')
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
    const fmt = exportFormat(req.reportQuery)
    const query = fmt ? exportQuery(req.reportQuery) : req.reportQuery
    const data = await runSipReport(req.user, query)
    if (fmt) {
      await sendReportRows(res, 'sip_due_end', sipHeaders, data.rows.map(sipRow), fmt, req.reportQuery, 'sip-report')
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
    const fmt = exportFormat(req.reportQuery)
    const query = fmt ? exportQuery(req.reportQuery) : req.reportQuery
    const data = await runFdMaturityReport(req.user, query)
    if (fmt) {
      await sendReportRows(res, 'fd_maturity', fdMaturityHeaders, data.rows.map(fdMaturityRow), fmt, req.reportQuery, 'fd-maturity')
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] fd-maturity', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/pending-receipts', async (req, res) => {
  try {
    const fmt = exportFormat(req.reportQuery)
    const query = fmt ? exportQuery(req.reportQuery) : req.reportQuery
    const data = await runPendingReceiptsReport(req.user, query)
    if (fmt) {
      await sendReportRows(res, 'pending_receipts', pendingHeaders, data.rows.map(pendingRow), fmt, req.reportQuery, 'pending-receipts')
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] pending-receipts', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/receipt-errors', async (req, res) => {
  try {
    const fmt = exportFormat(req.reportQuery)
    const query = fmt ? exportQuery(req.reportQuery) : req.reportQuery
    const data = await runReceiptErrorsReport(req.user, query)
    if (fmt) {
      await sendReportRows(res, 'receipt_errors', receiptErrorsHeaders, data.rows.map(receiptErrorsRow), fmt, req.reportQuery, 'receipt-errors')
      return
    }
    res.json(data)
  } catch (e) {
    console.error('[reports] receipt-errors', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/customer-detail/customers', async (req, res) => {
  try {
    if (queryFlag(req.reportQuery, 'ids_only')) {
      const data = await runCustomerDetailCustomerListIds(req.user, req.reportQuery)
      res.json(data)
      return
    }
    const data = await runCustomerDetailCustomerList(req.user, req.reportQuery)
    res.json(data)
  } catch (e) {
    if (e instanceof CustomerDetailReportError) {
      res.status(e.status || 400).json({ error: e.message })
      return
    }
    console.error('[reports] customer-detail/customers', e)
    res.status(500).json({ error: 'server_error', detail: String(e.message || e) })
  }
})

router.get('/customer-detail', async (req, res) => {
  try {
    const fmt = exportFormat(req.reportQuery)
    const query =
      fmt != null
        ? { ...req.reportQuery, page: '1', page_size: '50000' }
        : req.reportQuery
    const data = await runCustomerDetailReport(req.user, query)
    if (fmt === 'csv') {
      const meta = exportMetaFromQuery('customer-detail', req.reportQuery)
      sendCsvReport(res, 'customer_detail', customerDetailCsvHeaders, buildCustomerDetailCsvRows(data), meta)
      return
    }
    if (fmt === 'xlsx') {
      await sendCustomerDetailXlsx(res, 'customer_detail', data, exportMetaFromQuery('customer-detail', req.reportQuery))
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
