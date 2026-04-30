// Shared branch-scoping primitives used by leads, users, and any other route
// that needs to compare a user-supplied branch identifier against the mixed
// bag of values (`_key`, `branch_code`, `branch_name`) we store on records.
//
// Lifted verbatim from routes/leads.js so that leads, users, and future
// consumers behave identically.

import { q } from '../config/database.js'

export function normalizeBranchRef(raw) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim().toUpperCase()
  return s.length ? s : null
}

// Given any branch identifier (key / code / name) returns every upper-cased
// alias we know about. Result always includes the normalized input so that
// callers still filter correctly even if the branches collection is missing
// a row for that value.
export async function resolveBranchAliases(branchRef) {
  if (!branchRef) return []
  const rows = await q(
    `
    FOR b IN branches
      FILTER b._key == @code
         OR (b.branch_code != null && LOWER(TRIM(TO_STRING(b.branch_code))) == LOWER(@code))
         OR (b.branch_name != null && LOWER(TRIM(TO_STRING(b.branch_name))) == LOWER(@code))
      LIMIT 1
      RETURN { code: b.branch_code, name: b.branch_name, key: b._key }
  `,
    { code: String(branchRef).trim() }
  )
  const aliases = new Set()
  const seed = normalizeBranchRef(branchRef)
  if (seed) aliases.add(seed)
  const row = rows[0]
  if (row) {
    const code = normalizeBranchRef(row.code)
    if (code) aliases.add(code)
    const name = normalizeBranchRef(row.name)
    if (name) aliases.add(name)
    const key = normalizeBranchRef(row.key)
    if (key) aliases.add(key)
  }
  return Array.from(aliases).filter(Boolean)
}

// Reads the JWT subject's user row and returns their branch + the full alias
// set we will use for IN comparisons. Returns null if the user is missing.
export async function getCurrentUserBranchRef(userId) {
  if (!userId) return null
  const rows = await q(
    `
    FOR user IN users
      FILTER user._key == @id
      LIMIT 1
      RETURN { branch: user.branch, branch_code: user.branch_code, emp_code: user.emp_code, name: user.name }
    `,
    { id: userId }
  )
  if (!rows.length) return null
  const me = rows[0]
  const ref = (me.branch_code != null && String(me.branch_code).trim())
    ? me.branch_code
    : me.branch
  const aliases = ref ? await resolveBranchAliases(ref) : []
  return {
    branch: me.branch || null,
    branch_code: me.branch_code || null,
    emp_code: me.emp_code || null,
    name: me.name || null,
    aliases
  }
}
