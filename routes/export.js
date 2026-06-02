import express from 'express'
import { q, getCollection, getBranchIdentifiersForFilter, normalizeBranchName, getUserBranch } from '../config/database.js'
import { requireAuth, requireRole, requireMasterKey } from '../middleware/auth.js'
import { uploadCsv } from '../middleware/upload.js'
import { normalizeReceiptCategory } from '../utils/receipt-category.js'
import { appendExportCategoryQuery, appendMfTxnTypeToExportQuery } from '../utils/receipt-filters.js'
import { effectiveDateExprAql } from '../utils/date-basis.js'
import { buildExportMeta, sendCsvReport, sendXlsxReport } from '../services/reports/report-export.js'

const router = express.Router()

async function buildBranchNameResolver() {
  const branches = await q(`
    FOR branch IN branches
    RETURN {
      key: branch._key,
      code: branch.branch_code,
      name: branch.branch_name
    }
  `)

  const index = new Map()
  const put = (k, name) => {
    const key = String(k || '').trim().toLowerCase()
    if (!key || !name) return
    if (!index.has(key)) index.set(key, String(name))
  }

  branches.forEach((b) => {
    put(b.key, b.name)
    put(b.code, b.name)
    put(b.name, b.name)
  })

  return (rawBranch) => {
    const raw = String(rawBranch || '').trim()
    if (!raw) return ''
    const mapped = index.get(raw.toLowerCase())
    if (mapped) return mapped
    return normalizeBranchName(raw) || raw
  }
}

// Export receipts to CSV
router.get('/receipts', requireAuth, async (req, res) => {
  try {
    const { from, to, branch_code, date_basis } = req.query
    const dateExpr = effectiveDateExprAql(date_basis)
    let query = `
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
    `
    let bindVars = {}
    
    if (from) {
      query += ` AND ${dateExpr} >= @from`
      bindVars.from = from
    }
    if (to) {
      query += ` AND ${dateExpr} <= @to`
      bindVars.to = to
    }
    if (branch_code) {
      query += ` AND receipt.branch == @branch_code`
      bindVars.branch_code = branch_code
    }
    
    query += `
      SORT ${dateExpr} DESC
      RETURN {
        receipt_id: receipt._key,
        receipt_date: ${dateExpr},
        investor_id: (receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id,
        investor_name: (receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name,
        investor_pan: (receipt.investor != null && receipt.investor.pan != null) ? receipt.investor.pan : receipt.pan,
        investor_phone: (receipt.investor != null && receipt.investor.mobile != null) ? receipt.investor.mobile : receipt.phone || '',
        investor_email: (receipt.investor != null && receipt.investor.email != null) ? receipt.investor.email : receipt.email,
        amount: (receipt.transaction != null && receipt.transaction.amount != null) ? receipt.transaction.amount : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? receipt.product_details.fd.deposit.amount : receipt.investment_amount,
        category: (receipt.product != null && receipt.product.category != null) ? receipt.product.category : receipt.product_category,
        fd_issuer_type: (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.type != null) ? receipt.product_details.fd.issuer.type : receipt.fd_issuer_type,
        payment_method: receipt.txn_type || receipt.mode,
        branch_code: receipt.branch,
        branch_name: receipt.branch,
        created_by: receipt.user_id,
        created_at: receipt.created_at,
        status: receipt.is_deleted ? 'deleted' : 'active',
        notes: receipt.notes || '',
        cc: receipt.collection_credit || receipt.cc || 0,
        si: receipt.service_income || receipt.si || 0
      }
    `
    
    const receiptsRaw = await q(query, bindVars)
    const receipts = receiptsRaw.map((r) => {
      const receiptLike = {
        product: { category: r.category },
        product_category: r.category,
        fd_issuer_type: r.fd_issuer_type
      }
      const normalized = normalizeReceiptCategory(receiptLike)
      const normalizedCategory = normalized?.product?.category ?? normalized?.product_category ?? r.category
      return { ...r, category: normalizedCategory }
    })
    const resolveBranchName = await buildBranchNameResolver()
    
    const headers = [
      'Receipt ID', 'Receipt Date', 'Investor ID', 'Investor Name', 'PAN', 'Phone', 'Email',
      'Amount', 'Category', 'Payment Method', 'Branch Code', 'Branch Name',
      'Created By', 'Created At', 'Status', 'Notes', 'CC', 'SI'
    ]

    const normalizeTxnTypeToModeDisplay = (raw) => {
      const v = String(raw || '').trim()
      if (!v) return ''
      const upper = v.toUpperCase()
      if (v === 'Lump Sum' || v === 'Lumpsum' || v === 'LumpSum' || upper === 'LUMPSUM') return 'Lump Sum'
      if (v === 'Switch Over' || upper === 'SWITCH_OVER' || v === 'SwitchOver' || upper === 'SWITCHOVER') return 'Switch Over'
      return v
    }

    const rows = receipts.map((receipt) => [
      receipt.receipt_id,
      receipt.receipt_date || '',
      receipt.investor_id,
      receipt.investor_name,
      receipt.investor_pan,
      receipt.investor_phone,
      receipt.investor_email,
      receipt.amount,
      receipt.category,
      normalizeTxnTypeToModeDisplay(receipt.payment_method),
      receipt.branch_code,
      resolveBranchName(receipt.branch_name || receipt.branch_code),
      receipt.created_by,
      receipt.created_at,
      receipt.status,
      receipt.notes || '',
      receipt.cc || 0,
      req.user.role === 'admin' ? (receipt.si || 0) : ''
    ])

    const meta = buildExportMeta({
      reportTitle: 'Receipts Export',
      from,
      to
    })
    sendCsvReport(res, 'receipts', headers, rows, meta)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export receipts' })
  }
})

router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const {
      from,
      to,
      branch_code,
      emp_code,
      status,
      category,
      mode,
      txn_type,
      search,
      date_basis,
      format = 'csv'
    } = req.query
    const dateExpr = effectiveDateExprAql(date_basis)

    let query = `
      FOR receipt IN receipts
      FILTER receipt.is_deleted == false
    `
    const bindVars = {}

    // Enforce server-side scoping for non-admin exports.
    // This prevents employees from downloading exports for receipts they don't own,
    // and prevents branch users from exporting receipts outside their branch.
    if (req.user.role === 'employee') {
      query += ` AND (
        receipt.user_id == @user_id
        OR (receipt.emp_code != null AND receipt.emp_code == @emp_code)
        OR (receipt.employee != null && receipt.employee.code == @emp_code)
      )`
      bindVars.user_id = String(req.user.sub)
      bindVars.emp_code = req.user.emp_code || ''
    } else if (req.user.role === 'branch' || req.user.role === 'manager') {
      const userBranch = req.user.role === 'branch'
        ? (req.user.branch_code || req.user.branch)
        : await getUserBranch(req.user.sub)

      if (userBranch) {
        const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
        if (branchIdentifiers.length > 0) {
          query += ` AND receipt.branch IN @branchIdentifiers`
          bindVars.branchIdentifiers = branchIdentifiers
        } else {
          query += ` AND receipt.branch == @branch`
          bindVars.branch = normalizeBranchName(userBranch) || userBranch
        }
      } else {
        // No branch assigned: show no receipts (do not leak data)
        query += ` AND 1 == 0`
      }
    }

    if (from) {
      query += ` AND ${dateExpr} >= @from`
      bindVars.from = from
    }
    if (to) {
      query += ` AND ${dateExpr} <= @to`
      bindVars.to = to
    }
    if (branch_code) {
      const branchIdentifiers = await getBranchIdentifiersForFilter(branch_code)
      if (branchIdentifiers.length > 0) {
        query += ` AND receipt.branch IN @branchIdentifiers`
        bindVars.branchIdentifiers = branchIdentifiers
      } else {
        query += ` AND receipt.branch == @branch_code`
        bindVars.branch_code = branch_code
      }
    }
    if (emp_code) {
      query += ` AND receipt.emp_code == @emp_code`
      bindVars.emp_code = emp_code
    }
    if (status) {
      if (status === 'Pending') {
        query += ` AND (receipt.status == null OR receipt.status == @status)`
      } else {
        query += ` AND receipt.status == @status`
      }
      bindVars.status = status
    }
    if (category) {
      query = appendExportCategoryQuery(query, bindVars, category)
    }
    query = appendMfTxnTypeToExportQuery(query, bindVars, txn_type, mode)
    if (search && String(search).trim()) {
      const s = String(search).trim()
      query += ` AND (
        LIKE(receipt.receipt_no, CONCAT("%", @search, "%"), true)
        OR (receipt.investor != null && (
          LIKE(receipt.investor.name, CONCAT("%", @search, "%"), true)
          OR LIKE(receipt.investor.id, CONCAT("%", @search, "%"), true)
          OR LIKE(receipt.investor.pan, CONCAT("%", @search, "%"), true)
        ))
        OR LIKE(receipt.investor_name, CONCAT("%", @search, "%"), true)
        OR LIKE(receipt.investor_id, CONCAT("%", @search, "%"), true)
        OR LIKE(receipt.pan, CONCAT("%", @search, "%"), true)
      )`
      bindVars.search = s
    }

    query += `
      SORT ${dateExpr} DESC
      RETURN {
        receipt_id: receipt._key,
        receipt_no: receipt.receipt_no,
        date: ${dateExpr},
        branch: receipt.branch,
        emp_code: receipt.emp_code,
        investor_id: (receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id,
        investor_name: (receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name,
        pan: (receipt.investor != null && receipt.investor.pan != null) ? receipt.investor.pan : receipt.pan,
        product_category: (receipt.product != null && receipt.product.category != null) ? receipt.product.category : receipt.product_category,
        fd_issuer_type: (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.type != null) ? receipt.product_details.fd.issuer.type : receipt.fd_issuer_type,
        scheme_name: (receipt.product != null && receipt.product.name != null) ? receipt.product.name : receipt.scheme_name,
        folio_policy_no: receipt.folio_policy_no,
        fd_application_number: (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.application != null && receipt.product_details.fd.application.number != null) ? receipt.product_details.fd.application.number : receipt.fd_application_number,
        bond_application_number: (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.application != null && receipt.product_details.bond.application.number != null) ? receipt.product_details.bond.application.number : receipt.bond_application_number,
        insurance_policy_number_raw: (receipt.product_details != null && receipt.product_details.insurance != null && receipt.product_details.insurance.policy != null && receipt.product_details.insurance.policy.number != null) ? receipt.product_details.insurance.policy.number : receipt.insurance_policy_number,
        amc_name_raw: (receipt.product_details != null && receipt.product_details.mf != null && receipt.product_details.mf.amc != null && receipt.product_details.mf.amc.name != null) ? receipt.product_details.mf.amc.name : receipt.amc_name,
        fd_issuer_name_raw: (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.name != null) ? receipt.product_details.fd.issuer.name : receipt.fd_issuer_name,
        bond_issuer_name_raw: (receipt.product_details != null && receipt.product_details.bond != null && receipt.product_details.bond.issuer != null && receipt.product_details.bond.issuer.name != null) ? receipt.product_details.bond.issuer.name : receipt.bond_issuer_name,
        insurance_issuer_raw: (receipt.product_details != null && receipt.product_details.insurance != null && receipt.product_details.insurance.issuer != null && receipt.product_details.insurance.issuer.name != null) ? receipt.product_details.insurance.issuer.name : receipt.issuer_company,
        investment_amount: (receipt.transaction != null && receipt.transaction.amount != null) ? receipt.transaction.amount : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? receipt.product_details.fd.deposit.amount : receipt.investment_amount,
        cc: receipt.collection_credit || receipt.cc || 0,
        si: receipt.service_income || receipt.si || 0,
        status: receipt.status || 'Pending',
        transaction_type: receipt.transaction_type || receipt.txn_type || null,
        transaction_type_canonical: (receipt.transaction != null && receipt.transaction.type != null && receipt.transaction.type != "") ? receipt.transaction.type : ((receipt.txn_type != null && receipt.txn_type != "") ? receipt.txn_type : ((receipt.transaction_type != null && receipt.transaction_type != "") ? receipt.transaction_type : receipt.mode)),
        // Prefer txn_type for MF mode display; fallback to legacy receipt.mode
        mode: receipt.txn_type || receipt.mode || null,
        switch_from: (receipt.transaction != null && receipt.transaction.switch_over != null) ? receipt.transaction.switch_over.from_scheme_name : null,
        switch_to: (receipt.transaction != null && receipt.transaction.switch_over != null) ? receipt.transaction.switch_over.to_scheme_name : null,
        payment: receipt.payment || null,
        transaction_details: receipt.transaction_details || null
      }
    `

    const rawRows = await q(query, bindVars)
    const rows = rawRows.map((r) => {
      const receiptLike = {
        product: { category: r.product_category },
        product_category: r.product_category,
        fd_issuer_type: r.fd_issuer_type
      }
      const normalized = normalizeReceiptCategory(receiptLike)
      const normalizedCategory = normalized?.product?.category ?? normalized?.product_category ?? r.product_category
      return { ...r, product_category: normalizedCategory }
    })
    const resolveBranchName = await buildBranchNameResolver()

    const resolveExportIssuer = (r) => {
      const c = String(r.product_category || '').toUpperCase()
      if (['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS'].includes(c)) return r.amc_name_raw || ''
      if (c === 'FD' || c === 'GOVT_FD') return r.fd_issuer_name_raw || ''
      if (c === 'BOND' || c === 'NCD') return r.bond_issuer_name_raw || ''
      if (c === 'INS') return r.insurance_issuer_raw || ''
      return r.insurance_issuer_raw || r.bond_issuer_name_raw || r.fd_issuer_name_raw || r.amc_name_raw || ''
    }

    const resolveExportFolioApp = (r) =>
      r.folio_policy_no || r.insurance_policy_number_raw || r.fd_application_number || r.bond_application_number || ''

    const headers = [
      'Receipt Number', 'Receipt Date', 'Branch', 'Employee Code',
      'Investor ID', 'Investor Name', 'PAN', 'Product Category', 'Issuer',
      'Scheme / Product', 'Folio / Policy / App No',
      'Investment Amount', 'CC', 'SI', 'Status',
      'Transaction Type', 'Mode', 'Switch From', 'Switch To',
      'Entry Mode', 'Channel', 'Reference No', 'Txn Date',
      'Instrument Type', 'Instrument No', 'Instrument Date',
      'Bank Name', 'Bank Branch', 'Txn Account Last4', 'Txn Notes'
    ]

    const buildRowArray = (r) => {
      const payment = r.payment || {}
      const legacy = r.transaction_details || {}
      const entryMode = payment.entry_mode ?? legacy.entry_mode ?? ''
      const channel = payment.channel ?? legacy.channel ?? ''
      const referenceNo = payment.reference_no ?? legacy.reference_no ?? ''
      const txnDate = payment.transaction_date ?? legacy.txn_date ?? ''
      const instrumentType = payment.instrument?.type ?? ''
      const instrumentNo = payment.instrument?.number ?? ''
      const instrumentDate = payment.instrument?.date ?? ''
      const bankName = payment.instrument?.bank?.name ?? legacy.bank_name ?? ''
      const bankBranch = payment.instrument?.bank?.branch ?? legacy.bank_branch ?? ''
      const accountLast4 = payment.account_last4 ?? legacy.account_last4 ?? ''
      const notes = payment.notes ?? legacy.notes ?? ''
      const siVal = req.user.role === 'admin' ? (r.si || 0) : ''

      const rawMode = String(r.mode || '').trim()
      const modeDisplay =
        rawMode === 'Lumpsum' || rawMode === 'LumpSum' || rawMode === 'Lump Sum' ? 'Lump Sum' :
        (rawMode === 'Switch Over' || rawMode === 'SwitchOver' || rawMode === 'SWITCH_OVER' || rawMode === 'switch_over' ? 'Switch Over' : rawMode)

      const txnTypeOut = r.transaction_type_canonical || r.transaction_type || r.txn_type || ''

      return [
        r.receipt_no || '',
        r.date || '',
        resolveBranchName(r.branch || ''),
        r.emp_code || '',
        r.investor_id || '',
        r.investor_name || '',
        r.pan || '',
        r.product_category || '',
        resolveExportIssuer(r),
        r.scheme_name || '',
        resolveExportFolioApp(r),
        r.investment_amount || 0,
        r.cc || 0,
        siVal,
        r.status || 'Pending',
        txnTypeOut,
        modeDisplay || '',
        r.switch_from || '',
        r.switch_to || '',
        entryMode,
        channel,
        referenceNo,
        txnDate,
        instrumentType,
        instrumentNo,
        instrumentDate,
        bankName,
        bankBranch,
        accountLast4,
        notes
      ]
    }

    const fmt = String(format || '').toLowerCase()
    const outFmt = fmt === 'xlsx' ? 'xlsx' : (fmt === 'json' ? 'json' : 'csv')

    if (outFmt === 'json') {
      const data = rows.map(r => {
        const payment = r.payment || {}
        const legacy = r.transaction_details || {}
        const rawMode = String(r.mode || '').trim()
        const modeDisplay =
          rawMode === 'Lumpsum' || rawMode === 'LumpSum' || rawMode === 'Lump Sum' ? 'Lump Sum' :
          (rawMode === 'Switch Over' || rawMode === 'SwitchOver' || rawMode === 'SWITCH_OVER' || rawMode === 'switch_over' ? 'Switch Over' : rawMode)
        return {
          receipt_id: r.receipt_id || '',
          receipt_number: r.receipt_no || '',
          date: r.date || '',
          branch: resolveBranchName(r.branch || ''),
          emp_code: r.emp_code || '',
          investor_id: r.investor_id || '',
          investor_name: r.investor_name || '',
          pan: r.pan || '',
          product_category: r.product_category || '',
          issuer: resolveExportIssuer(r),
          scheme_name: r.scheme_name || '',
          folio_policy_no: r.folio_policy_no || '',
          folio_policy_app_no: resolveExportFolioApp(r),
          investment_amount: r.investment_amount || 0,
          cc: r.cc || 0,
          si: req.user.role === 'admin' ? (r.si || 0) : null,
          status: r.status || 'Pending',
          transaction_type: r.transaction_type_canonical || r.transaction_type || '',
          mode: modeDisplay || '',
          switch_from: r.switch_from || '',
          switch_to: r.switch_to || '',
          entry_mode: payment.entry_mode ?? legacy.entry_mode ?? '',
          channel: payment.channel ?? legacy.channel ?? '',
          reference_no: payment.reference_no ?? legacy.reference_no ?? '',
          txn_date: payment.transaction_date ?? legacy.txn_date ?? '',
          instrument_type: payment.instrument?.type ?? '',
          instrument_no: payment.instrument?.number ?? '',
          instrument_date: payment.instrument?.date ?? '',
          bank_name: payment.instrument?.bank?.name ?? legacy.bank_name ?? '',
          bank_branch: payment.instrument?.bank?.branch ?? legacy.bank_branch ?? '',
          account_last4: payment.account_last4 ?? legacy.account_last4 ?? '',
          notes: payment.notes ?? legacy.notes ?? ''
        }
      })
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.json({ items: data, total: data.length })
      return
    }

    const meta = buildExportMeta({
      reportTitle: 'Transaction History',
      from,
      to
    })

    if (outFmt === 'xlsx') {
      const dataRows = rows.map((r) => buildRowArray(r))
      await sendXlsxReport(res, 'transactions', headers, dataRows, meta)
      return
    }

    const dataRows = rows.map((r) => buildRowArray(r))
    sendCsvReport(res, 'transactions', headers, dataRows, meta)
  } catch (error) {
    console.error('CSV transaction export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export transactions' })
  }
})

// Export customers to CSV (admin only, master key required)
router.get('/customers', requireAuth, requireRole('admin'), requireMasterKey, async (req, res) => {
  try {
    const customers = await q(`
      FOR customer IN customers
      FILTER customer.is_active != false
      RETURN {
        investor_id: customer.investor_id,
        name: customer.name,
        pan: customer.pan,
        email: customer.email,
        mobile: customer.mobile,
        address1: customer.address1,
        address2: customer.address2,
        address3: customer.address3,
        city: customer.city,
        state: customer.state,
        pin: customer.pin,
        relationship_manager: customer.relationship_manager,
        relationship_manager_display: customer.relationship_manager_display,
        created_at: customer.created_at
      }
    `)
    
    const headers = [
      'Investor ID', 'Name', 'PAN', 'Email', 'Mobile', 'Address1', 'Address2', 'Address3',
      'City', 'State', 'Pin', 'Branch(es)', 'Created At'
    ]

    const dataRows = customers.map((customer) => {
      const branchVal = customer.relationship_manager_display != null
        ? (Array.isArray(customer.relationship_manager_display)
            ? customer.relationship_manager_display.join('; ')
            : customer.relationship_manager_display)
        : (Array.isArray(customer.relationship_manager)
            ? customer.relationship_manager.join('; ')
            : customer.relationship_manager || '')
      return [
        customer.investor_id,
        customer.name || '',
        customer.pan || '',
        customer.email || '',
        customer.mobile || '',
        customer.address1 || '',
        customer.address2 || '',
        customer.address3 || '',
        customer.city || '',
        customer.state || '',
        customer.pin || '',
        String(branchVal),
        customer.created_at || ''
      ]
    })

    const meta = buildExportMeta({ reportTitle: 'Customer Master' })
    sendCsvReport(res, 'customers', headers, dataRows, meta)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export customers' })
  }
})

// Import customers from CSV (admin only, master key required)
router.post('/customers/import', requireAuth, requireRole('admin'), requireMasterKey, uploadCsv, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'validation_error', detail: 'CSV file required (field: file)' })
    }
    const text = req.file.buffer.toString('utf-8')
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) {
      return res.status(400).json({ error: 'validation_error', detail: 'CSV must have header row and at least one data row' })
    }
    const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
    const nameIdx = header.findIndex(h => /name/i.test(h))
    const panIdx = header.findIndex(h => /pan/i.test(h))
    const investorIdIdx = header.findIndex(h => /investor\s*id/i.test(h))
    const emailIdx = header.findIndex(h => /email/i.test(h))
    const mobileIdx = header.findIndex(h => /mobile/i.test(h))
    const addr1Idx = header.findIndex(h => /address1|address\s*1/i.test(h))
    const cityIdx = header.findIndex(h => /city/i.test(h))
    const stateIdx = header.findIndex(h => /state/i.test(h))
    const pinIdx = header.findIndex(h => /pin/i.test(h))
    const branchIdx = header.findIndex(h => /branch/i.test(h))
    if (nameIdx === -1 || panIdx === -1) {
      return res.status(400).json({ error: 'validation_error', detail: 'CSV must include Name and PAN columns' })
    }
    function parseCsvField(str) {
      if (!str) return ''
      const s = str.trim()
      if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"').trim()
      return s
    }
    const maxIdResult = await q(`
      LET customerMax = (FOR c IN customers COLLECT AGGREGATE maxId = MAX(c.investor_id) RETURN maxId)[0] || 0
      LET minorMax = (FOR c IN customers FILTER c.minors != null AND LENGTH(c.minors) > 0
        FOR m IN c.minors COLLECT AGGREGATE maxId = MAX(m.investor_id) RETURN maxId)[0] || 0
      RETURN MAX([customerMax, minorMax])
    `)
    let nextId = (maxIdResult[0] || 0) + 1
    const col = getCollection('customers')
    let imported = 0
    let updated = 0
    const errors = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const parts = []
      let cur = ''
      let inQuotes = false
      for (let j = 0; j < line.length; j++) {
        const ch = line[j]
        if (ch === '"') {
          inQuotes = !inQuotes
        } else if ((ch === ',' && !inQuotes) || (ch === '\n' && !inQuotes)) {
          parts.push(cur)
          cur = ''
        } else {
          cur += ch
        }
      }
      parts.push(cur)
      const name = parseCsvField(parts[nameIdx])
      const pan = parseCsvField(parts[panIdx])
      if (!name || !pan) {
        errors.push(`Row ${i + 1}: Name and PAN required`)
        continue
      }
      const investorId = investorIdIdx >= 0 && parts[investorIdIdx] ? parseInt(parts[investorIdIdx], 10) : null
      const branchRaw = branchIdx >= 0 ? parseCsvField(parts[branchIdx]) : ''
      const branchParts = branchRaw ? branchRaw.split(/[;,]/).map(b => b.trim()).filter(Boolean) : []
      const relationshipManager = branchParts.length === 0 ? 'UNASSIGNED' : branchParts.length === 1 ? normalizeBranchName(branchParts[0]) : branchParts.map(b => normalizeBranchName(b))
      const relationshipManagerDisplay = branchParts.length === 0 ? null : branchParts.length === 1 ? branchParts[0] : branchParts
      const doc = {
        investor_id: investorId != null && !isNaN(investorId) ? investorId : nextId++,
        name,
        pan: pan.toUpperCase(),
        email: emailIdx >= 0 ? parseCsvField(parts[emailIdx]) || null : null,
        mobile: mobileIdx >= 0 ? parseCsvField(parts[mobileIdx]) || null : null,
        address1: addr1Idx >= 0 ? parseCsvField(parts[addr1Idx]) || null : null,
        address2: null,
        address3: null,
        city: cityIdx >= 0 ? parseCsvField(parts[cityIdx]) || null : null,
        state: stateIdx >= 0 ? parseCsvField(parts[stateIdx]) || null : null,
        pin: pinIdx >= 0 ? parseCsvField(parts[pinIdx]) || null : null,
        country: 'India',
        relationship_manager: Array.isArray(relationshipManager) ? relationshipManager : relationshipManager,
        relationship_manager_display: relationshipManagerDisplay,
        minors: [],
        created_at: new Date().toISOString(),
        is_active: true,
        source_type: 'csv_import'
      }
      try {
        let existing = null
        if (investorId != null && !isNaN(investorId)) {
          const byId = await q(`FOR c IN customers FILTER c.investor_id == @id LIMIT 1 RETURN c`, { id: investorId })
          existing = byId[0] || null
        }
        if (!existing && pan) {
          const byPan = await q(`FOR c IN customers FILTER c.pan == @pan LIMIT 1 RETURN c`, { pan: pan.toUpperCase() })
          existing = byPan[0] || null
        }
        if (existing) {
          await col.update(existing._key, {
            name: doc.name,
            pan: doc.pan,
            email: doc.email,
            mobile: doc.mobile,
            address1: doc.address1,
            address2: doc.address2,
            address3: doc.address3,
            city: doc.city,
            state: doc.state,
            pin: doc.pin,
            country: doc.country,
            relationship_manager: doc.relationship_manager,
            relationship_manager_display: doc.relationship_manager_display,
            is_active: doc.is_active,
            source_type: doc.source_type
          })
          updated++
        } else {
          await col.save(doc)
          imported++
        }
      } catch (e) {
        errors.push(`Row ${i + 1}: ${e.message || 'Save failed'}`)
      }
    }
    res.status(200).json({
      imported,
      updated,
      total_rows: lines.length - 1,
      errors: errors.length ? errors : undefined
    })
  } catch (error) {
    console.error('Customer import error:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Export users to CSV (admin only)
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const users = await q(`
      FOR user IN users
      RETURN {
        emp_code: user.emp_code,
        name: user.name,
        email: user.email,
        role: user.role,
        branch: user.branch,
        is_active: user.is_active,
        created_at: user.created_at,
        last_login_at: user.last_login_at
      }
    `)
    
    const headers = [
      'Employee Code', 'Name', 'Email', 'Role', 'Branch', 'Active', 'Created At', 'Last Login'
    ]

    const dataRows = users.map((user) => [
      user.emp_code,
      user.name,
      user.email,
      user.role,
      user.branch || '',
      user.is_active,
      user.created_at,
      user.last_login_at || ''
    ])

    const meta = buildExportMeta({ reportTitle: 'Users Export' })
    sendCsvReport(res, 'users', headers, dataRows, meta)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export users' })
  }
})

// Export branches to CSV (admin only)
router.get('/branches', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const branches = await q(`
      FOR branch IN branches
      RETURN {
        branch_code: branch.branch_code,
        branch_name: branch.branch_name,
        branch_type: branch.branch_type,
        address: branch.address,
        phone: branch.phone,
        email: branch.email,
        created_at: branch.created_at
      }
    `)
    
    const headers = [
      'Branch Code', 'Branch Name', 'Type', 'Address', 'Phone', 'Email', 'Created At'
    ]

    const dataRows = branches.map((branch) => [
      branch.branch_code,
      branch.branch_name,
      branch.branch_type,
      branch.address || '',
      branch.phone,
      branch.email,
      branch.created_at
    ])

    const meta = buildExportMeta({ reportTitle: 'Branches Export' })
    sendCsvReport(res, 'branches', headers, dataRows, meta)
  } catch (error) {
    console.error('CSV export error:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to export branches' })
  }
})

export default router
