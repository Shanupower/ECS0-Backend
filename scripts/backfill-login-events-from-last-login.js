/**
 * One-time backfill: seed user_login_events from users.last_login_at.
 * Run: node scripts/backfill-login-events-from-last-login.js
 */
import 'dotenv/config'
import { q } from '../config/database.js'

const COLLECTION = 'user_login_events'

async function main() {
  const users = await q(`
    FOR user IN users
      FILTER user.last_login_at != null && TO_STRING(user.last_login_at) != ""
      RETURN {
        key: user._key,
        emp_code: user.emp_code,
        name: user.name,
        role: user.role,
        branch: user.branch,
        branch_code: user.branch_code,
        last_login_at: user.last_login_at
      }
  `)

  let inserted = 0
  let skipped = 0

  for (const user of users) {
    const existing = await q(`
      FOR event IN ${COLLECTION}
        FILTER event.user_id == @user_id && event.login_type == "backfill"
        LIMIT 1
        RETURN event._key
    `, { user_id: user.key })

    if (existing.length) {
      skipped++
      continue
    }

    await q(`INSERT @doc INTO ${COLLECTION}`, {
      doc: {
        user_id: user.key,
        emp_code: user.emp_code ?? null,
        user_name: user.name ?? null,
        role: user.role ?? null,
        branch: user.branch ?? null,
        branch_code: user.branch_code ?? null,
        login_at: user.last_login_at,
        login_type: 'backfill',
        impersonated_by: null,
        ip_address: null,
        user_agent: null
      }
    })
    inserted++
  }

  console.log(`Backfill complete: ${inserted} inserted, ${skipped} skipped (already backfilled).`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
