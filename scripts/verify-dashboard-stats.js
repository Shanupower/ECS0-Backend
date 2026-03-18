/**
 * Verify that dashboard stats (total_receipts, total_investments, etc.) match
 * the receipt list for the same user, date range, and includePending.
 *
 * Uses the same filter logic as routes/stats.js and routes/receipts.js.
 * Run: node scripts/verify-dashboard-stats.js
 *
 * Optional env: VERIFY_DATE_FROM=2025-01-01 VERIFY_DATE_TO=2025-12-31
 */

import 'dotenv/config'
import {
  q,
  getUserBranch,
  getBranchIdentifiersForFilter,
  normalizeBranchName
} from '../config/database.js'

const INV_AMOUNT_AQL = `(TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0)`

const from = process.env.VERIFY_DATE_FROM || `${new Date().getFullYear()}-01-01`
const to = process.env.VERIFY_DATE_TO || `${new Date().getFullYear()}-12-31`

async function getTestUsers() {
  const byRole = await q(`
    FOR u IN users
      FILTER u.role IN ["employee", "manager", "admin"]
      FILTER u.is_active != false
      COLLECT role = u.role INTO users
      LET pick = users[0].u
      RETURN { role, _key: pick._key, emp_code: pick.emp_code, branch: pick.branch }
  `)
  const users = byRole.map(({ role, _key, emp_code, branch }) => ({
    role,
    sub: _key,
    emp_code: emp_code || null,
    branch
  }))

  const branchLogins = await q(`
    FOR b IN branches
      FILTER b.branch_code != null
      LIMIT 2
      RETURN { role: "branch", branch_code: b.branch_code, branch: b.branch_name }
  `)
  branchLogins.forEach(b => users.push({ ...b, sub: `branch_${b.branch_code}` }))

  return users
}

async function countReceiptsListStyle(user, opts = {}) {
  const { includeStatus = true } = opts
  let filterConditions = [
    'receipt.date >= @from',
    'receipt.date <= @to',
    'receipt.is_deleted == false'
  ]
  const bindVars = { from, to }

  if (user.role === 'employee') {
    filterConditions.push('(receipt.user_id == @user_id OR receipt.emp_code == @emp_code)')
    bindVars.user_id = String(user.sub)
    bindVars.emp_code = user.emp_code || ''
  } else if (user.role === 'manager') {
    const userBranch = await getUserBranch(user.sub)
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    if (branchIdentifiers.length > 0) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIdentifiers
    } else if (userBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizeBranchName(userBranch) || userBranch
    } else {
      filterConditions.push('1 == 0')
    }
  } else if (user.role === 'branch') {
    const userBranch = user.branch_code || user.branch
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    if (branchIdentifiers.length > 0) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIdentifiers
    } else if (userBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizeBranchName(userBranch) || userBranch
    } else {
      filterConditions.push('1 == 0')
    }
  } else if (user.role === 'admin') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = String(user.sub)
  }

  if (includeStatus) {
    filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
  }

  const filterClause = `FILTER ${filterConditions.join(' AND ')}`
  const result = await q(`
    FOR receipt IN receipts
    ${filterClause}
    COLLECT WITH COUNT INTO total
    RETURN total
  `, bindVars)
  return result[0] ?? 0
}

async function countReceiptsStatsStyle(user, includePending = true) {
  let filterConditions = [
    'receipt.date >= @from',
    'receipt.date <= @to',
    'receipt.is_deleted == false'
  ]
  const bindVars = { from, to }

  if (user.role === 'employee') {
    filterConditions.push('(receipt.user_id == @user_id OR (receipt.emp_code != null && receipt.emp_code == @emp_code))')
    bindVars.user_id = String(user.sub)
    bindVars.emp_code = user.emp_code || ''
  } else if (user.role === 'manager') {
    const userBranch = await getUserBranch(user.sub)
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    if (branchIdentifiers.length > 0) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIdentifiers
    } else if (userBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizeBranchName(userBranch) || userBranch
    } else {
      filterConditions.push('1 == 0')
    }
  } else if (user.role === 'branch') {
    const userBranch = user.branch_code || user.branch
    const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
    if (branchIdentifiers.length > 0) {
      filterConditions.push('receipt.branch IN @branchIdentifiers')
      bindVars.branchIdentifiers = branchIdentifiers
    } else if (userBranch) {
      filterConditions.push('receipt.branch == @branch')
      bindVars.branch = normalizeBranchName(userBranch) || userBranch
    } else {
      filterConditions.push('1 == 0')
    }
  } else if (user.role === 'admin') {
    filterConditions.push('receipt.user_id == @user_id')
    bindVars.user_id = String(user.sub)
  }

  if (includePending) {
    filterConditions.push('(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)')
  } else {
    filterConditions.push('receipt.status == "Completed"')
  }

  const filterClause = `FILTER ${filterConditions.join(' AND ')}`
  const result = await q(`
    FOR receipt IN receipts
    ${filterClause}
    COLLECT AGGREGATE total_receipts = LENGTH(1), total_investments = SUM(${INV_AMOUNT_AQL})
    RETURN { total_receipts, total_investments }
  `, bindVars)
  return result[0] || { total_receipts: 0, total_investments: 0 }
}

async function countByUserIdOnly(user) {
  const filterConditions = [
    'receipt.date >= @from',
    'receipt.date <= @to',
    'receipt.is_deleted == false',
    '(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)',
    'receipt.user_id == @user_id'
  ]
  const result = await q(`
    FOR receipt IN receipts
    FILTER ${filterConditions.join(' AND ')}
    COLLECT WITH COUNT INTO total
    RETURN total
  `, { from, to, user_id: String(user.sub) })
  return result[0] ?? 0
}

async function countByEmpCodeOnly(user) {
  if (!user.emp_code) return null
  const filterConditions = [
    'receipt.date >= @from',
    'receipt.date <= @to',
    'receipt.is_deleted == false',
    '(receipt.status == "Completed" OR receipt.status == "Pending" OR receipt.status == null)',
    '(receipt.emp_code == @emp_code OR (receipt.employee != null && receipt.employee.code == @emp_code))'
  ]
  const result = await q(`
    FOR receipt IN receipts
    FILTER ${filterConditions.join(' AND ')}
    COLLECT WITH COUNT INTO total
    RETURN total
  `, { from, to, emp_code: user.emp_code })
  return result[0] ?? 0
}

async function main() {
  console.log('Verify Dashboard vs Receipt List (same date range and includePending=1)\n')
  console.log('Date range:', from, 'to', to)

  const users = await getTestUsers()
  if (!users.length) {
    console.log('No users found.')
    return
  }

  let hasMismatch = false
  for (const user of users) {
    const label = user.role === 'branch'
      ? `branch(${user.branch_code || user.branch})`
      : `${user.role}(${user.emp_code || user.sub})`
    console.log('\n---', label, '---')

    const listCount = await countReceiptsListStyle(user, { includeStatus: true })
    const statsResult = await countReceiptsStatsStyle(user, true)
    const statsCount = statsResult.total_receipts

    if (user.role === 'employee' && user.emp_code) {
      const byUserId = await countByUserIdOnly(user)
      const byEmpCode = await countByEmpCodeOnly(user)
      if (byEmpCode !== null && byUserId !== byEmpCode) {
        console.log(`  By user_id only: ${byUserId}, By emp_code: ${byEmpCode}`)
      }
    }

    console.log(`  List count (same scope+status): ${listCount}`)
    console.log(`  Stats total_receipts:          ${statsCount}`)
    console.log(`  Stats total_investments:       ${statsResult.total_investments}`)

    if (listCount !== statsCount) {
      console.log(`  >>> MISMATCH: list=${listCount} vs stats=${statsCount}`)
      hasMismatch = true
    } else {
      console.log('  OK')
    }
  }

  console.log('\n' + (hasMismatch ? 'Some mismatches found.' : 'All checks passed.'))
  process.exit(hasMismatch ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
