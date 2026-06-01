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
