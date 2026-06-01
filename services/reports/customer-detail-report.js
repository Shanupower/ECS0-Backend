import ExcelJS from 'exceljs'
import { q } from '../../config/database.js'
import { CC_AQL, INV_AMOUNT_AQL, SI_AQL } from '../../utils/receipt-aggregates.js'
import {
  CATEGORY_AQL,
  MF_SCHEME_CATEGORY_AQL,
  ISSUER_NAME_AQL,
  SCHEME_NAME_AQL
} from '../../utils/report-aql-fragments.js'
import { parseInvestorIds } from '../../utils/query-list.js'
import {
  buildReceiptReportFilters,
  parsePagination,
  canViewServiceIncome
} from './report-query-builders.js'
import { maskServiceIncomeTotals } from './report-totals.js'

export const MAX_CUSTOMER_DETAIL_INVESTOR_IDS = 20

const INVESTOR_ID_AQL = `((receipt.investor != null && receipt.investor.id != null) ? receipt.investor.id : receipt.investor_id)`
const INVESTOR_ID_STR_AQL = `TO_STRING(${INVESTOR_ID_AQL})`
const INVESTOR_NAME_AQL = `((receipt.investor != null && receipt.investor.name != null) ? receipt.investor.name : receipt.investor_name)`
const PAN_AQL = `((receipt.investor != null && receipt.investor.pan != null) ? receipt.investor.pan : receipt.pan)`
const STATUS_AQL = `(receipt.status != null && receipt.status != "" ? receipt.status : "Pending")`
const TXN_TYPE_AQL = `(
  (receipt.transaction != null && receipt.transaction.type != null && receipt.transaction.type != "")
    ? receipt.transaction.type
    : ((receipt.txn_type != null && receipt.txn_type != "") ? receipt.txn_type
    : ((receipt.transaction_type != null && receipt.transaction_type != "") ? receipt.transaction_type : receipt.mode))
)`
const BRANCH_CODE_AQL = `(
  LET raw_branch = receipt.branch
  LET branch_doc = FIRST(
    FOR branch IN branches
      FILTER branch._key == raw_branch
        OR (branch.branch_code != null && LOWER(TRIM(TO_STRING(branch.branch_code))) == LOWER(TRIM(TO_STRING(raw_branch))))
        OR (branch.branch_name != null && LOWER(TRIM(TO_STRING(branch.branch_name))) == LOWER(TRIM(TO_STRING(raw_branch))))
      LIMIT 1
      RETURN branch
  )
  RETURN branch_doc != null && branch_doc.branch_code != null && TO_STRING(branch_doc.branch_code) != ""
    ? TO_STRING(branch_doc.branch_code)
    : TO_STRING(raw_branch)
)[0]`

const MF_FAMILY = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']

export class CustomerDetailReportError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export function parseCustomerDetailInvestorIds(query = {}) {
  const ids = parseInvestorIds(query)
  if (!ids.length) {
    throw new CustomerDetailReportError('investor_ids is required — select at least one customer')
  }
  if (ids.length > MAX_CUSTOMER_DETAIL_INVESTOR_IDS) {
    throw new CustomerDetailReportError(
      `At most ${MAX_CUSTOMER_DETAIL_INVESTOR_IDS} customers per report`,
      400
    )
  }
  return ids
}

function maskRow(user, row) {
  if (canViewServiceIncome(user)) return row
  return { ...row, incentive_amount: null }
}

function groupRowsByInvestor(rows, keyField = 'investor_id') {
  const map = new Map()
  for (const row of rows || []) {
    const key = String(row[keyField] ?? '')
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  return map
}

function customerProfileFromDoc(customer) {
  if (!customer) {
    return {
      name: '',
      pan: '',
      mobile: '',
      city: '',
      state: '',
      pin: '',
      branch: '',
      relationship_manager: ''
    }
  }
  const rm = customer.relationship_manager
  return {
    name: customer.name ?? '',
    pan: customer.pan ?? '',
    mobile: customer.mobile ?? '',
    city: customer.city ?? '',
    state: customer.state ?? '',
    pin: customer.pin ?? customer.pin_code ?? '',
    branch: customer.branch ?? '',
    relationship_manager: Array.isArray(rm) ? rm.join(', ') : (rm ?? '')
  }
}

function numericIds(investorIds) {
  return investorIds
    .map((id) => {
      const n = Number(id)
      return Number.isFinite(n) ? n : null
    })
    .filter((n) => n != null)
}

async function loadCustomerDocs(investorIds) {
  const numeric = numericIds(investorIds)
  const rows = await q(
    `
    FOR c IN customers
      FILTER TO_STRING(c.investor_id) IN @investor_id_strings
        OR (LENGTH(@investor_id_nums) > 0 && c.investor_id IN @investor_id_nums)
      RETURN c
  `,
    { investor_id_strings: investorIds, investor_id_nums: numeric }
  )
  const map = new Map()
  for (const c of rows) {
    map.set(String(c.investor_id), c)
  }
  return map
}

export async function runCustomerDetailReport(user, query) {
  const investorIds = parseCustomerDetailInvestorIds(query)
  const { filterClause, bindVars, dateExpr } = await buildReceiptReportFilters(user, query, {})
  const exportMode = query.format != null
  const { page, pageSize, offset } = parsePagination(query, { maxPageSize: exportMode ? 50000 : 200 })

  const customerDocs = await loadCustomerDocs(investorIds)

  const summaryQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET inv_id = ${INVESTOR_ID_STR_AQL}
    COLLECT investor_id = inv_id
    AGGREGATE applications = LENGTH(1),
      total_investment = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    RETURN { investor_id, applications, total_investment, collection_credit, incentive_amount }
  `

  const byProductQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET inv_id = ${INVESTOR_ID_STR_AQL}
    LET cat = ${CATEGORY_AQL}
    COLLECT investor_id = inv_id, product_category = cat
    AGGREGATE applications = LENGTH(1),
      amount = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    SORT investor_id ASC, amount DESC
    RETURN { investor_id, product_category, applications, amount, collection_credit, incentive_amount }
  `

  const bySchemeCategoryQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET cat = ${CATEGORY_AQL}
    FILTER UPPER(TO_STRING(cat)) IN @mf_family
    LET inv_id = ${INVESTOR_ID_STR_AQL}
    LET mf_cat = ${MF_SCHEME_CATEGORY_AQL}
    COLLECT investor_id = inv_id, scheme_category = mf_cat
    AGGREGATE applications = LENGTH(1),
      amount = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    SORT investor_id ASC, amount DESC
    RETURN { investor_id, scheme_category, applications, amount, collection_credit, incentive_amount }
  `

  const byFundQ = `
    FOR receipt IN receipts
    ${filterClause}
    LET inv_id = ${INVESTOR_ID_STR_AQL}
    LET issuer_name = ${ISSUER_NAME_AQL}
    LET fund_scheme = ${SCHEME_NAME_AQL}
    COLLECT investor_id = inv_id,
      issuer = (issuer_name != null && issuer_name != "" ? issuer_name : "Unknown"),
      scheme_name = (fund_scheme != null && fund_scheme != "" ? fund_scheme : "Unknown")
    AGGREGATE applications = LENGTH(1),
      amount = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    SORT investor_id ASC, amount DESC
    RETURN { investor_id, issuer, scheme_name, applications, amount, collection_credit, incentive_amount }
  `

  const txnCountQ = `RETURN LENGTH(FOR receipt IN receipts ${filterClause} RETURN 1)`
  const txnDataQ = `
    FOR receipt IN receipts
    ${filterClause}
    SORT ${dateExpr} DESC, receipt._key DESC
    LIMIT @offset, @limit
    RETURN {
      customer_id: ${INVESTOR_ID_AQL},
      customer_name: ${INVESTOR_NAME_AQL},
      date: ${dateExpr},
      receipt_number: receipt.receipt_no,
      product_category: ${CATEGORY_AQL},
      issuer: ${ISSUER_NAME_AQL},
      scheme_name: ${SCHEME_NAME_AQL},
      transaction_type: ${TXN_TYPE_AQL},
      amount: ${INV_AMOUNT_AQL},
      collection_credit: ${CC_AQL},
      incentive_amount: ${SI_AQL},
      branch_code: ${BRANCH_CODE_AQL},
      emp_code: receipt.emp_code,
      status: ${STATUS_AQL}
    }
  `
  const txnTotalsQ = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE amount = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    RETURN { amount, collection_credit, incentive_amount }
  `

  const grandTotalsQ = `
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE applications = LENGTH(1),
      total_investment = SUM(${INV_AMOUNT_AQL}),
      collection_credit = SUM(${CC_AQL}),
      incentive_amount = SUM(${SI_AQL})
    RETURN { applications, total_investment, collection_credit, incentive_amount }
  `

  const schemeBind = { ...bindVars, mf_family: MF_FAMILY }
  const txnBind = { ...bindVars, offset, limit: pageSize }

  const [
    summaryRows,
    byProductRows,
    bySchemeCategoryRows,
    byFundRows,
    txnCountArr,
    txnRows,
    txnTotalsArr,
    grandTotalsArr
  ] = await Promise.all([
    q(summaryQ, bindVars),
    q(byProductQ, bindVars),
    q(bySchemeCategoryQ, schemeBind),
    q(byFundQ, bindVars),
    q(txnCountQ, bindVars),
    q(txnDataQ, txnBind),
    q(txnTotalsQ, bindVars),
    q(grandTotalsQ, bindVars)
  ])

  const summaryByInv = new Map((summaryRows || []).map((r) => [String(r.investor_id), r]))
  const productByInv = groupRowsByInvestor(byProductRows)
  const schemeCatByInv = groupRowsByInvestor(bySchemeCategoryRows)
  const fundByInv = groupRowsByInvestor(byFundRows)

  const customers = investorIds.map((id) => {
    const key = String(id)
    const doc = customerDocs.get(key)
    const summaryRaw = summaryByInv.get(key) || {
      applications: 0,
      total_investment: 0,
      collection_credit: 0,
      incentive_amount: 0
    }
    const summary = maskRow(user, {
      applications: summaryRaw.applications ?? 0,
      total_investment: summaryRaw.total_investment ?? 0,
      collection_credit: summaryRaw.collection_credit ?? 0,
      incentive_amount: summaryRaw.incentive_amount ?? 0
    })
    return {
      customer_id: doc?.investor_id ?? (Number.isFinite(Number(id)) ? Number(id) : id),
      profile: customerProfileFromDoc(doc),
      summary,
      by_product: (productByInv.get(key) || []).map((r) =>
        maskRow(user, {
          product_category: r.product_category,
          applications: r.applications,
          amount: r.amount,
          collection_credit: r.collection_credit,
          incentive_amount: r.incentive_amount
        })
      ),
      by_scheme_category: (schemeCatByInv.get(key) || []).map((r) =>
        maskRow(user, {
          scheme_category: r.scheme_category,
          applications: r.applications,
          amount: r.amount,
          collection_credit: r.collection_credit,
          incentive_amount: r.incentive_amount
        })
      ),
      by_fund: (fundByInv.get(key) || []).map((r) =>
        maskRow(user, {
          issuer: r.issuer,
          scheme_name: r.scheme_name,
          applications: r.applications,
          amount: r.amount,
          collection_credit: r.collection_credit,
          incentive_amount: r.incentive_amount
        })
      )
    }
  })

  const txnTotal = typeof txnCountArr[0] === 'number' ? txnCountArr[0] : 0
  const grandRaw = grandTotalsArr[0] || {
    applications: 0,
    total_investment: 0,
    collection_credit: 0,
    incentive_amount: 0
  }

  return {
    investor_ids: investorIds,
    period: {
      from: query.from ?? null,
      to: query.to ?? null,
      date_basis: query.date_basis || query.dateBasis || 'receipt'
    },
    customers,
    transactions: {
      rows: (txnRows || []).map((r) =>
        maskRow(user, {
          customer_id: r.customer_id,
          customer_name: r.customer_name,
          date: r.date,
          receipt_number: r.receipt_number,
          product_category: r.product_category,
          issuer: r.issuer,
          scheme_name: r.scheme_name,
          transaction_type: r.transaction_type,
          amount: r.amount,
          collection_credit: r.collection_credit,
          incentive_amount: r.incentive_amount,
          branch_code: r.branch_code,
          emp_code: r.emp_code,
          status: r.status
        })
      ),
      total: txnTotal,
      page,
      page_size: pageSize,
      totals: maskServiceIncomeTotals(user, txnTotalsArr[0] || { amount: 0, collection_credit: 0, incentive_amount: 0 })
    },
    grand_totals: maskServiceIncomeTotals(user, {
      applications: grandRaw.applications ?? 0,
      total_investment: grandRaw.total_investment ?? 0,
      collection_credit: grandRaw.collection_credit ?? 0,
      incentive_amount: grandRaw.incentive_amount ?? 0
    })
  }
}

function breakdownHeaders() {
  return ['Applications', 'Amount', 'CC', 'SI']
}

function breakdownValues(row) {
  return [
    row.applications ?? 0,
    row.amount ?? 0,
    row.collection_credit ?? 0,
    row.incentive_amount ?? ''
  ]
}

export function buildCustomerDetailCsvRows(data) {
  const rows = []
  const push = (section, customerId, cols) => {
    rows.push([section, customerId, ...cols])
  }

  for (const c of data.customers || []) {
    const id = c.customer_id ?? ''
    const p = c.profile || {}
    push('Profile', id, [
      p.name,
      p.pan,
      p.mobile,
      p.city,
      p.state,
      p.pin,
      p.branch,
      p.relationship_manager,
      '',
      '',
      '',
      ''
    ])
    push('Summary', id, [
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      c.summary?.applications ?? 0,
      c.summary?.total_investment ?? 0,
      c.summary?.collection_credit ?? 0,
      c.summary?.incentive_amount ?? ''
    ])
    for (const r of c.by_product || []) {
      push('By Product', id, [r.product_category, '', '', '', '', '', '', ...breakdownValues(r)])
    }
    for (const r of c.by_scheme_category || []) {
      push('By MF Category', id, [r.scheme_category, '', '', '', '', '', '', ...breakdownValues(r)])
    }
    for (const r of c.by_fund || []) {
      push('By Fund', id, [r.issuer, r.scheme_name, '', '', '', '', '', ...breakdownValues(r)])
    }
  }

  for (const t of data.transactions?.rows || []) {
    push('Transaction', t.customer_id, [
      t.customer_name,
      t.date,
      t.receipt_number,
      t.product_category,
      t.issuer,
      t.scheme_name,
      t.transaction_type,
      t.amount,
      t.collection_credit,
      t.incentive_amount,
      t.branch_code,
      t.emp_code,
      t.status
    ])
  }

  return rows
}

export const customerDetailCsvHeaders = [
  'Section',
  'Customer ID',
  'Col1',
  'Col2',
  'Col3',
  'Col4',
  'Col5',
  'Col6',
  'Col7',
  'Applications / Amount',
  'Amount / CC',
  'CC / SI',
  'SI / Branch',
  'RM / Status'
]

function sheetName(customer, index) {
  const base = String(customer.profile?.name || customer.customer_id || `Customer ${index + 1}`)
    .replace(/[\\/*?:\[\]]/g, '')
    .slice(0, 28)
  return base || `Customer ${index + 1}`
}

export async function buildCustomerDetailXlsxBuffer(data) {
  const workbook = new ExcelJS.Workbook()

  for (let i = 0; i < (data.customers || []).length; i++) {
    const c = data.customers[i]
    const ws = workbook.addWorksheet(sheetName(c, i))
    const p = c.profile || {}

    ws.addRow(['Customer Detail'])
    ws.addRow(['Customer ID', c.customer_id])
    ws.addRow(['Name', p.name])
    ws.addRow(['PAN', p.pan])
    ws.addRow(['Mobile', p.mobile])
    ws.addRow(['City', p.city])
    ws.addRow(['State', p.state])
    ws.addRow(['Zip / PIN', p.pin])
    ws.addRow(['Branch', p.branch])
    ws.addRow(['RM', p.relationship_manager])
    ws.addRow([])
    ws.addRow(['Summary', 'Applications', 'Total Investment', 'CC', 'SI'])
    ws.addRow([
      '',
      c.summary?.applications ?? 0,
      c.summary?.total_investment ?? 0,
      c.summary?.collection_credit ?? 0,
      c.summary?.incentive_amount ?? ''
    ])
    ws.addRow([])

    ws.addRow(['By Product', ...breakdownHeaders()])
    for (const r of c.by_product || []) {
      ws.addRow([r.product_category, ...breakdownValues(r)])
    }
    ws.addRow([])

    ws.addRow(['By MF Scheme Category', ...breakdownHeaders()])
    for (const r of c.by_scheme_category || []) {
      ws.addRow([r.scheme_category, ...breakdownValues(r)])
    }
    ws.addRow([])

    ws.addRow(['By Fund / Scheme', 'Issuer', 'Scheme', ...breakdownHeaders().slice(1)])
    for (const r of c.by_fund || []) {
      ws.addRow([`${r.issuer} — ${r.scheme_name}`, r.issuer, r.scheme_name, ...breakdownValues(r).slice(1)])
    }
    ws.addRow([])

    ws.addRow([
      'Transactions',
      'Date',
      'Receipt #',
      'Product',
      'Issuer',
      'Scheme',
      'Txn Type',
      'Amount',
      'CC',
      'SI',
      'Branch',
      'RM',
      'Status'
    ])
    const txns = (data.transactions?.rows || []).filter(
      (t) => String(t.customer_id) === String(c.customer_id)
    )
    for (const t of txns) {
      ws.addRow([
        '',
        t.date,
        t.receipt_number,
        t.product_category,
        t.issuer,
        t.scheme_name,
        t.transaction_type,
        t.amount,
        t.collection_credit,
        t.incentive_amount,
        t.branch_code,
        t.emp_code,
        t.status
      ])
    }
  }

  if ((data.customers || []).length === 0) {
    const ws = workbook.addWorksheet('Report')
    ws.addRow(['No customers'])
  }

  return workbook.xlsx.writeBuffer()
}

export async function sendCustomerDetailXlsx(res, filenameBase, data) {
  const stamp = new Date().toISOString().split('T')[0]
  const buf = await buildCustomerDetailXlsxBuffer(data)
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}_${stamp}.xlsx"`)
  res.send(Buffer.from(buf))
}
