/**
 * Verify dashboard total_investments: for a scope with N receipts, sum of
 * per-receipt amounts should equal the stats total. Lists each receipt's
 * raw fields and computed amount to find why some contribute 0.
 *
 * Run: node scripts/verify-dashboard-totals.js
 * Optional: VERIFY_SCOPE=ecs005 (emp_code or branch code), VERIFY_DATE_FROM=2026-01-01 VERIFY_DATE_TO=2026-12-31
 */

import 'dotenv/config'
import { q, getUserBranch, getBranchIdentifiersForFilter, normalizeBranchName } from '../config/database.js'

// Must match routes/stats.js exactly (flat + nested transaction.amount, product_details.fd.deposit.amount)
const INV_AMOUNT_AQL = `(
  (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0)
  : (TO_NUMBER(receipt.fd_deposit_amount) || 0) != 0 ? (TO_NUMBER(receipt.fd_deposit_amount) || 0)
  : (TO_NUMBER(receipt.service_price) || 0) != 0 ? (TO_NUMBER(receipt.service_price) || 0)
  : (TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0)
  : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0)
  : 0
)`

const from = process.env.VERIFY_DATE_FROM || `${new Date().getFullYear()}-01-01`
const to = process.env.VERIFY_DATE_TO || `${new Date().getFullYear()}-12-31`
const scope = (process.env.VERIFY_SCOPE || 'ecs005').toUpperCase()

function computeAmount(r) {
  const inv = Number(r.investment_amount) || 0
  if (inv !== 0) return inv
  const fd = Number(r.fd_deposit_amount) || 0
  if (fd !== 0) return fd
  const svc = Number(r.service_price) || 0
  if (svc !== 0) return svc
  const txn = r.transaction && r.transaction.amount != null ? Number(r.transaction.amount) || 0 : 0
  if (txn !== 0) return txn
  const fdDep = r.product_details?.fd?.deposit?.amount
  if (fdDep != null) return Number(fdDep) || 0
  return 0
}

async function main() {
  console.log('Dashboard totals check')
  console.log('Date range:', from, 'to', to)
  console.log('Scope:', scope)
  console.log('')

  // Resolve scope to branch identifiers (e.g. ECS005 user -> branch 2 -> identifiers ['2','AMEERPET'])
  let filterConditions = [
    'receipt.date >= @from',
    'receipt.date <= @to',
    'receipt.is_deleted == false',
    '(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)'
  ]
  const bindVars = { from, to }

  const userByEmp = await q(`FOR u IN users FILTER u.emp_code == @ec RETURN { _key: u._key, role: u.role, branch: u.branch }`, { ec: scope })
  if (userByEmp.length) {
    const u = userByEmp[0]
    if (u.role === 'manager' || u.role === 'branch') {
      const userBranch = u.role === 'branch' ? scope : await getUserBranch(u._key)
      const branchIds = await getBranchIdentifiersForFilter(userBranch || u.branch)
      if (branchIds.length) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIds
      } else if (userBranch || u.branch) {
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizeBranchName(userBranch || u.branch) || userBranch || u.branch
      }
    } else {
      filterConditions.push('(receipt.user_id == @user_id OR receipt.emp_code == @emp_code)')
      bindVars.user_id = String(u._key)
      bindVars.emp_code = scope
    }
  } else {
    const branchIds = await getBranchIdentifiersForFilter(scope)
    if (branchIds.length) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIds
    } else {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = scope
    }
  }

  const filterClause = `FILTER ${filterConditions.join(' AND ')}`

  // 1) List each receipt with raw amount fields and computed amount (include nested)
  const receipts = await q(`
    FOR receipt IN receipts
    ${filterClause}
    SORT receipt.date, receipt._key
    RETURN {
      _key: receipt._key,
      date: receipt.date,
      receipt_no: receipt.receipt_no,
      product_category: receipt.product_category,
      investment_amount: receipt.investment_amount,
      fd_deposit_amount: receipt.fd_deposit_amount,
      service_price: receipt.service_price,
      transaction: receipt.transaction,
      product_details: receipt.product_details
    }
  `, bindVars)

  console.log('Receipts in scope:', receipts.length)
  if (receipts.length === 0) {
    console.log('No receipts found for this scope/date.')
    return
  }

  let manualSum = 0
  const rows = []
  for (const r of receipts) {
    const amt = computeAmount(r)
    manualSum += amt
    const txnAmt = r.transaction && r.transaction.amount != null ? r.transaction.amount : null
    const fdDepAmt = r.product_details?.fd?.deposit?.amount ?? null
    rows.push({
      _key: r._key,
      date: r.date,
      category: r.product_category,
      inv_amt: r.investment_amount,
      fd_amt: r.fd_deposit_amount,
      svc_price: r.service_price,
      txn_amount: txnAmt,
      fd_deposit_amt: fdDepAmt,
      computed: amt
    })
  }

  // 2) Run same SUM as stats (using INV_AMOUNT_AQL)
  const [statsResult] = await q(`
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE total = SUM(${INV_AMOUNT_AQL})
    RETURN total
  `, bindVars)

  const statsTotal = statsResult != null ? Number(statsResult) : 0

  // 3) Report
  console.log('')
  console.log('Per-receipt amounts (first 25):')
  console.log('_key\tdate\tcategory\tinv\tfd\tsvc\ttxn_amt\tfd_dep\tcomputed')
  rows.slice(0, 25).forEach(r => {
    console.log(`${r._key}\t${r.date}\t${r.category || ''}\t${r.inv_amt ?? ''}\t${r.fd_amt ?? ''}\t${r.svc_price ?? ''}\t${r.txn_amount ?? ''}\t${r.fd_deposit_amt ?? ''}\t${r.computed}`)
  })
  if (rows.length > 25) console.log('...')

  const zeroCount = rows.filter(r => r.computed === 0).length
  if (zeroCount > 0) {
    console.log('')
    console.log('Receipts with computed amount 0:', zeroCount)
    rows.filter(r => r.computed === 0).slice(0, 5).forEach(r => {
      console.log(`  ${r._key} inv=${r.inv_amt} fd=${r.fd_amt} txn=${r.txn_amount} fd_dep=${r.fd_deposit_amt}`)
    })
  }

  console.log('')
  console.log('Manual sum (sum of computed per receipt):', manualSum)
  console.log('Stats AQL SUM(total_investments):         ', statsTotal)
  const ok = Math.abs(manualSum - statsTotal) < 0.01
  if (!ok) {
    console.log('MISMATCH: totals do not agree.')
    process.exit(1)
  }
  console.log('OK: totals match.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
