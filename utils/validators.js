// Centralized validation utilities for backend

// Validation regex patterns
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MOBILE_REGEX = /^[6-9][0-9]{9}$/
const AADHAR_REGEX = /^[0-9]{12}$/
const PIN_REGEX = /^[0-9]{6}$/
const EMP_CODE_REGEX = /^[A-Z0-9]{3,20}$/
const BRANCH_CODE_REGEX = /^[A-Z0-9]{2,10}$/

/**
 * Validate PAN card number
 * Format: 5 letters + 4 digits + 1 letter (e.g., ABCDE1234F)
 */
export function validatePAN(pan, required = false) {
  if (!pan || pan.trim() === '') {
    return required 
      ? { valid: false, error: 'PAN is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = pan.trim().toUpperCase()
  
  if (!PAN_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid PAN format. Expected: ABCDE1234F (5 uppercase letters, 4 digits, 1 uppercase letter)' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate email address
 */
export function validateEmail(email, required = false) {
  if (!email || email.trim() === '') {
    return required 
      ? { valid: false, error: 'Email is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = email.trim().toLowerCase()
  
  if (!EMAIL_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid email format. Expected: user@example.com' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate mobile number
 * Format: 10 digits starting with 6-9
 */
export function validateMobile(mobile, required = false) {
  if (!mobile || mobile.trim() === '') {
    return required 
      ? { valid: false, error: 'Mobile number is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = mobile.trim().replace(/\s+/g, '')
  
  if (!MOBILE_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid mobile number. Expected: 10 digits starting with 6-9' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate Aadhar number
 * Format: 12 digits
 */
export function validateAadhar(aadhar, required = false) {
  if (!aadhar || aadhar.trim() === '') {
    return required 
      ? { valid: false, error: 'Aadhar number is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = aadhar.trim().replace(/\s+/g, '')
  
  if (!AADHAR_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid Aadhar number. Expected: 12 digits' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate PIN code
 * Format: 6 digits
 */
export function validatePIN(pin, required = false) {
  if (!pin || pin.trim() === '') {
    return required 
      ? { valid: false, error: 'PIN code is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = pin.trim()
  
  if (!PIN_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid PIN code. Expected: 6 digits' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate employee code
 * Format: 3-20 alphanumeric characters
 */
export function validateEmpCode(empCode, required = true) {
  if (!empCode || empCode.trim() === '') {
    return required 
      ? { valid: false, error: 'Employee code is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = empCode.trim().toUpperCase()
  
  if (!EMP_CODE_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid employee code. Expected: 3-20 alphanumeric characters (e.g., ECS001)' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate branch code
 * Format: 2-10 alphanumeric characters
 */
export function validateBranchCode(branchCode, required = false) {
  if (!branchCode || branchCode.trim() === '') {
    return required 
      ? { valid: false, error: 'Branch code is required' }
      : { valid: true, value: null }
  }
  
  const trimmed = branchCode.trim().toUpperCase()
  
  if (!BRANCH_CODE_REGEX.test(trimmed)) {
    return { 
      valid: false, 
      error: 'Invalid branch code. Expected: 2-10 alphanumeric characters (e.g., BR001, HO)' 
    }
  }
  
  return { valid: true, value: trimmed }
}

/**
 * Validate password strength
 * Minimum 8 characters, at least 1 uppercase letter, 1 lowercase letter, and 1 number
 */
export function validatePassword(password, required = true) {
  if (!password || password.trim() === '') {
    return required 
      ? { valid: false, error: 'Password is required' }
      : { valid: true, value: null }
  }
  
  if (password.length < 8) {
    return { 
      valid: false, 
      error: 'Password must be at least 8 characters long' 
    }
  }
  
  if (!/[A-Z]/.test(password)) {
    return { 
      valid: false, 
      error: 'Password must contain at least one uppercase letter' 
    }
  }
  
  if (!/[a-z]/.test(password)) {
    return { 
      valid: false, 
      error: 'Password must contain at least one lowercase letter' 
    }
  }
  
  if (!/[0-9]/.test(password)) {
    return { 
      valid: false, 
      error: 'Password must contain at least one number' 
    }
  }
  
  return { valid: true, value: password }
}

/**
 * Validate positive number
 */
export function validatePositiveNumber(value, fieldName = 'Value', required = false) {
  if (value === null || value === undefined || value === '') {
    return required 
      ? { valid: false, error: `${fieldName} is required` }
      : { valid: true, value: null }
  }
  
  const num = Number(value)
  
  if (isNaN(num)) {
    return { 
      valid: false, 
      error: `${fieldName} must be a valid number` 
    }
  }
  
  if (num <= 0) {
    return { 
      valid: false, 
      error: `${fieldName} must be a positive number` 
    }
  }
  
  return { valid: true, value: num }
}

/**
 * Validate date format (YYYY-MM-DD)
 */
export function validateDate(date, fieldName = 'Date', required = false) {
  if (!date || date.trim() === '') {
    return required 
      ? { valid: false, error: `${fieldName} is required` }
      : { valid: true, value: null }
  }
  
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  
  if (!dateRegex.test(date)) {
    return { 
      valid: false, 
      error: `${fieldName} must be in YYYY-MM-DD format` 
    }
  }
  
  const parsedDate = new Date(date)
  
  if (isNaN(parsedDate.getTime())) {
    return { 
      valid: false, 
      error: `${fieldName} is not a valid date` 
    }
  }
  
  return { valid: true, value: date }
}

/**
 * Validate required field
 */
export function validateRequired(value, fieldName) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return { 
      valid: false, 
      error: `${fieldName} is required` 
    }
  }
  
  return { valid: true, value: typeof value === 'string' ? value.trim() : value }
}

/**
 * Validate string length
 */
export function validateLength(value, minLength, maxLength, fieldName) {
  if (!value) {
    return { valid: true, value: null }
  }
  
  const str = String(value)
  
  if (minLength && str.length < minLength) {
    return { 
      valid: false, 
      error: `${fieldName} must be at least ${minLength} characters long` 
    }
  }
  
  if (maxLength && str.length > maxLength) {
    return { 
      valid: false, 
      error: `${fieldName} must not exceed ${maxLength} characters` 
    }
  }
  
  return { valid: true, value: str }
}

