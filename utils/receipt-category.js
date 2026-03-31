// Keep this intentionally conservative to avoid false positives.
// We only normalize FD → GOVT_FD when issuer type clearly indicates Govt/Post Office.
const GOVT_ISSUER_KEYWORDS = ['govt', 'government', 'post office', 'post-office', 'postoffice']

function toTrimmedString(value) {
  if (value == null) return ''
  return String(value).trim()
}

function isGovtOrPostOfficeIssuer(issuerType) {
  const s = toTrimmedString(issuerType).toLowerCase()
  if (!s) return false
  return GOVT_ISSUER_KEYWORDS.some((kw) => s.includes(kw))
}

function getIssuerTypeSignal(receipt) {
  return receipt?.product_details?.fd?.issuer?.type ?? receipt?.fd_issuer_type
}

function getRawCategory(receipt) {
  return receipt?.product?.category ?? receipt?.product_category ?? receipt?.productCategory
}

/**
 * Returns the effective (normalized) receipt category.
 * Normalization rule: if category is FD and issuer indicates Government/Post Office → GOVT_FD.
 */
export function getEffectiveCategory(receipt) {
  const raw = toTrimmedString(getRawCategory(receipt))
  if (!raw) return ''

  const upper = raw.toUpperCase()
  if (upper === 'FD' && isGovtOrPostOfficeIssuer(getIssuerTypeSignal(receipt))) {
    return 'GOVT_FD'
  }

  return raw
}

/**
 * Returns a shallow-cloned receipt with normalized category fields applied.
 * - Updates `receipt.product.category` if `receipt.product` exists (cloning `product` as well)
 * - Updates legacy `receipt.product_category`
 * - No side effects (does not mutate input receipt)
 */
export function normalizeReceiptCategory(receipt) {
  const normalizedCategory = getEffectiveCategory(receipt)
  const cloned = { ...(receipt ?? {}) }

  if (receipt?.product && typeof receipt.product === 'object') {
    cloned.product = { ...receipt.product }
    if (normalizedCategory) cloned.product.category = normalizedCategory
  }

  if (normalizedCategory) cloned.product_category = normalizedCategory

  return cloned
}

