import { canViewServiceIncome } from './report-query-builders.js'

export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function sumNumericFields(rows, fields) {
  return fields.reduce((totals, field) => {
    let seen = false
    let sum = 0
    for (const row of rows || []) {
      const value = toFiniteNumber(row?.[field])
      if (value === null) continue
      seen = true
      sum += value
    }
    totals[field] = seen ? sum : null
    return totals
  }, {})
}

export function maskServiceIncomeTotals(user, totals) {
  if (canViewServiceIncome(user)) return totals
  const masked = { ...totals }
  if (Object.prototype.hasOwnProperty.call(masked, 'incentive_amount')) masked.incentive_amount = null
  if (Object.prototype.hasOwnProperty.call(masked, 'incentive_paid')) masked.incentive_paid = null
  return masked
}
