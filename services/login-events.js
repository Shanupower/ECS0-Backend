import { q } from '../config/database.js'

const COLLECTION = 'user_login_events'

function clientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for']
  if (forwarded) return String(forwarded).split(',')[0].trim()
  return req?.ip || req?.socket?.remoteAddress || null
}

/**
 * Append a login event (best-effort; does not throw on failure).
 * @param {{ user: object, req?: object, loginType?: string, impersonatedBy?: string|null }} opts
 */
export async function recordLoginEvent({ user, req, loginType = 'password', impersonatedBy = null }) {
  if (!user?._key) return
  try {
    const doc = {
      user_id: user._key,
      emp_code: user.emp_code ?? null,
      user_name: user.name ?? null,
      role: user.role ?? null,
      branch: user.branch ?? null,
      branch_code: user.branch_code ?? null,
      login_at: new Date().toISOString(),
      login_type: loginType,
      impersonated_by: impersonatedBy || null,
      ip_address: req ? clientIp(req) : null,
      user_agent: req?.headers?.['user-agent'] ? String(req.headers['user-agent']).slice(0, 512) : null
    }
    await q(`INSERT @doc INTO ${COLLECTION}`, { doc })
  } catch (e) {
    console.error('[login-events] recordLoginEvent failed:', e?.message || e)
  }
}
