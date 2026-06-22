const REPORT_DATE_BASES = new Set(['receipt', 'transaction', 'fd_maturity', 'sip_due', 'sip_end'])

export function normalizeReportDateBasis(raw) {
  const v = String(raw || '').trim().toLowerCase()
  return REPORT_DATE_BASES.has(v) ? v : 'receipt'
}

function ymdToUtcDate(value) {
  const s = String(value || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function toYmd(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(date, days) {
  const d = new Date(date.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function addMonths(date, months) {
  const d = new Date(date.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).getUTCDate()
  d.setUTCDate(Math.min(day, lastDay))
  return d
}

function sipStep(frequency) {
  const f = String(frequency || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (f.includes('daily')) return { unit: 'days', value: 1 }
  if (f.includes('week')) return { unit: 'days', value: 7 }
  if (f.includes('fortnight')) return { unit: 'days', value: 14 }
  if (f.includes('quarter')) return { unit: 'months', value: 3 }
  if (f.includes('half') || f.includes('semi')) return { unit: 'months', value: 6 }
  if (f.includes('year') || f.includes('annual')) return { unit: 'months', value: 12 }
  return { unit: 'months', value: 1 }
}

export function computeNextSipDueDate(startDate, frequency, asOfDate = new Date().toISOString().slice(0, 10), endDate = '') {
  const start = ymdToUtcDate(startDate)
  const asOf = ymdToUtcDate(asOfDate)
  if (!start || !asOf) return ''

  const end = ymdToUtcDate(endDate)
  const step = sipStep(frequency)
  let due = start
  if (step.unit === 'days' && due < asOf) {
    const diffDays = Math.floor((asOf.getTime() - due.getTime()) / 86400000)
    const intervals = Math.ceil(diffDays / step.value)
    due = addDays(due, intervals * step.value)
  } else {
    let guard = 0
    while (due < asOf && guard < 1200) {
      due = addMonths(due, step.value)
      guard += 1
    }
  }
  if (end && due > end) return ''
  return toYmd(due)
}

export function computeNextSipDueDateInWindow(
  startDate,
  frequency,
  from = '',
  to = '',
  fallbackAsOfDate = new Date().toISOString().slice(0, 10),
  endDate = ''
) {
  const windowStart = ymdToUtcDate(from)
    ? String(from).slice(0, 10)
    : (ymdToUtcDate(to) ? String(startDate || '').slice(0, 10) : fallbackAsOfDate)
  const due = computeNextSipDueDate(startDate, frequency, windowStart, endDate)
  return dateWindowContains(due, from, to) ? due : ''
}

export function dateWindowContains(value, from = '', to = '') {
  const s = String(value || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  if (from && s < String(from).slice(0, 10)) return false
  if (to && s > String(to).slice(0, 10)) return false
  return true
}

function firstYmd(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim().slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  }
  return ''
}

/** Calendar months between two YYYY-MM-DD dates (end inclusive span length). */
export function computeMonthsBetweenDates(startDate, endDate) {
  const start = ymdToUtcDate(startDate)
  const end = ymdToUtcDate(endDate)
  if (!start || !end || end < start) return null
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth())
  if (end.getUTCDate() < start.getUTCDate()) months -= 1
  return months
}

/** Perpetual SIP end date — start + 40 years (480 months). */
export function computePerpetualSipEndDate(startDate) {
  const start = ymdToUtcDate(startDate)
  if (!start) return ''
  return toYmd(addMonths(start, 40 * 12))
}

function resolveSipEndDate(row = {}) {
  const end = firstYmd(row.sip_end_date, row.end_date, row.fd_maturity_date, row.maturity_date)
  if (end) return end
  const start = firstYmd(row.sip_start_date, row.start_date, row.swp_start_date, row.stp_start_date)
  if (start && row.sip_is_perpetual) return computePerpetualSipEndDate(start)
  return ''
}

/** MIS "Months" — derived from start/end dates on the row, not stored installment counts. */
export function computeMisMonthsFromRow(row = {}) {
  const start = firstYmd(
    row.sip_start_date,
    row.start_date,
    row.swp_start_date,
    row.stp_start_date,
    row.fd_deposit_date,
    row.fd_booking_date
  )
  const end = resolveSipEndDate(row)
  return computeMonthsBetweenDates(start, end)
}

/** Display end date for SIP rows, including computed perpetual end dates. */
export function resolveSipDisplayEndDate(row = {}) {
  return resolveSipEndDate(row)
}
