// Map an Indian PIN code to its state/UT using the first 2 digits (and a few
// 3-digit overrides). The India Post circle-to-state mapping is well-known and
// stable; see https://en.wikipedia.org/wiki/Postal_Index_Number.
//
// We accept numeric or string inputs, strip non-digits, and require exactly 6
// digits after normalization. Anything unknown / out of range returns null so
// callers can decide how to bucket it (e.g. "Unknown").

// 3-digit prefix overrides take precedence over 2-digit ranges. These handle
// border regions that don't follow the broader circle mapping (e.g. parts of
// Uttarakhand sit inside UP's 24x/26x ranges).
const THREE_DIGIT_OVERRIDES = {
  // Uttarakhand (Dehradun region etc.)
  244: 'Uttarakhand',
  246: 'Uttarakhand',
  247: 'Uttarakhand',
  248: 'Uttarakhand',
  249: 'Uttarakhand',
  // Chhattisgarh sits inside MP's old 49x block
  490: 'Chhattisgarh',
  491: 'Chhattisgarh',
  492: 'Chhattisgarh',
  493: 'Chhattisgarh',
  494: 'Chhattisgarh',
  495: 'Chhattisgarh',
  496: 'Chhattisgarh',
  497: 'Chhattisgarh',
  // Daman, Diu, DNH
  362: 'Gujarat',
  396: 'Dadra and Nagar Haveli',
  // Puducherry pockets inside Tamil Nadu
  533: 'Andhra Pradesh',
  605: 'Puducherry',
  609: 'Puducherry',
  673: 'Kerala',
  // Jharkhand sits inside Bihar's 8xx block
  813: 'Jharkhand',
  814: 'Jharkhand',
  815: 'Jharkhand',
  825: 'Jharkhand',
  826: 'Jharkhand',
  827: 'Jharkhand',
  828: 'Jharkhand',
  829: 'Jharkhand',
  831: 'Jharkhand',
  832: 'Jharkhand',
  833: 'Jharkhand',
  834: 'Jharkhand',
  835: 'Jharkhand',
}

const TWO_DIGIT_MAP = {
  11: 'Delhi',
  12: 'Haryana',
  13: 'Haryana',
  14: 'Punjab',
  15: 'Punjab',
  16: 'Punjab',
  17: 'Himachal Pradesh',
  18: 'Jammu and Kashmir',
  19: 'Jammu and Kashmir',
  20: 'Uttar Pradesh',
  21: 'Uttar Pradesh',
  22: 'Uttar Pradesh',
  23: 'Uttar Pradesh',
  24: 'Uttar Pradesh',
  25: 'Uttar Pradesh',
  26: 'Uttar Pradesh',
  27: 'Uttar Pradesh',
  28: 'Uttar Pradesh',
  30: 'Rajasthan',
  31: 'Rajasthan',
  32: 'Rajasthan',
  33: 'Rajasthan',
  34: 'Rajasthan',
  36: 'Gujarat',
  37: 'Gujarat',
  38: 'Gujarat',
  39: 'Gujarat',
  40: 'Maharashtra',
  41: 'Maharashtra',
  42: 'Maharashtra',
  43: 'Maharashtra',
  44: 'Maharashtra',
  45: 'Madhya Pradesh',
  46: 'Madhya Pradesh',
  47: 'Madhya Pradesh',
  48: 'Madhya Pradesh',
  49: 'Madhya Pradesh',
  50: 'Telangana',
  51: 'Andhra Pradesh',
  52: 'Andhra Pradesh',
  53: 'Andhra Pradesh',
  56: 'Karnataka',
  57: 'Karnataka',
  58: 'Karnataka',
  59: 'Karnataka',
  60: 'Tamil Nadu',
  61: 'Tamil Nadu',
  62: 'Tamil Nadu',
  63: 'Tamil Nadu',
  64: 'Tamil Nadu',
  67: 'Kerala',
  68: 'Kerala',
  69: 'Kerala',
  70: 'West Bengal',
  71: 'West Bengal',
  72: 'West Bengal',
  73: 'West Bengal',
  74: 'West Bengal',
  75: 'Odisha',
  76: 'Odisha',
  77: 'Odisha',
  78: 'Assam',
  79: 'North East',
  80: 'Bihar',
  81: 'Bihar',
  82: 'Bihar',
  83: 'Jharkhand',
  84: 'Bihar',
  85: 'Bihar',
}

export function stateFromPincode(pin) {
  if (pin == null) return null
  const digits = String(pin).replace(/\D/g, '')
  if (digits.length !== 6) return null
  const first = digits[0]
  if (first === '0' || first === '9') return null // invalid or APO
  const three = digits.slice(0, 3)
  if (THREE_DIGIT_OVERRIDES[three]) return THREE_DIGIT_OVERRIDES[three]
  const two = Number(digits.slice(0, 2))
  return TWO_DIGIT_MAP[two] || null
}

export default stateFromPincode
