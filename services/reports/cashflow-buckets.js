/**
 * Map receipt txn display to cash-flow buckets (v1).
 * @param {string} modeOrTxn
 * @param {object} receipt
 * @returns {'Purchase'|'SIP'|'SwitchIn'|'Redemption'|'SwitchOut'|'Unknown'}
 */
export function cashFlowBucketForReceipt(receipt, modeOrTxn) {
  const raw = String(
    modeOrTxn ||
      receipt?.transaction?.type ||
      receipt?.txn_type ||
      receipt?.transaction_type ||
      receipt?.mode ||
      ''
  ).trim()
  const u = raw.toLowerCase()

  if (u === 'sip' || u === 'systematic') return 'SIP'
  if (u === 'lumpsum' || u === 'lump sum' || u === 'purchase' || u === 'fresh') return 'Purchase'
  if (u.includes('switch') && (u.includes('in') || u.includes('to'))) return 'SwitchIn'
  if (u.includes('switch') && (u.includes('out') || u.includes('from'))) return 'SwitchOut'
  if (u === 'switch over' || u === 'switchover' || u === 'switch_over') {
    if (receipt?.transaction?.switch_over != null) return 'SwitchIn'
    return 'SwitchOut'
  }
  if (u === 'redemption' || u === 'swp' || u === 'stp out') return 'Redemption'
  if (u === 'dividend' || u === 'idcw') return 'Redemption'
  return 'Unknown'
}
