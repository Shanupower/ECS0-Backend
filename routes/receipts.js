import express from 'express'
import fs from 'fs'
import path from 'path'
import { q, getCollection, getUserBranch, normalizeBranchName, getBranchIdentifiersForFilter } from '../config/database.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { uploadMultiple, uploadsDir } from '../middleware/upload.js'
import { validateRequired, validatePositiveNumber, validateDate } from '../utils/validators.js'
import { normalizeReceiptCategory } from '../utils/receipt-category.js'
import {
  applyReceiptCategoryFilter,
  applyMfTxnTypeOrModeFilter
} from '../utils/receipt-filters.js'
import { effectiveDateExprAql } from '../utils/date-basis.js'
import { publishEvent } from '../services/task-events.js'

function normalizeTenureUnit(u) {
  const v = String(u || '').trim().toLowerCase()
  if (v === 'day' || v === 'days') return 'days'
  return 'months'
}

const router = express.Router()

// Create new receipt
router.post('/', requireAuth, uploadMultiple, async (req, res) => {
  try {
    // When FormData is used (file upload), payload is sent as JSON string; otherwise req.body is the receipt
    const rawBody = req.body || {}
    let d
    if (typeof rawBody.payload === 'string') {
      try {
        d = JSON.parse(rawBody.payload)
      } catch (parseErr) {
        console.warn('Receipt payload parse error:', parseErr.message)
        d = {}
      }
    } else {
      d = rawBody
    }
    // If payload was missing (e.g. multipart body not populated by multer), receipt would lack required fields; ensure we have an object
    if (!d || typeof d !== 'object') {
      d = {}
    }
    const today = new Date().toISOString().slice(0,10)

    // Validate required fields
    const receiptNoValidation = validateRequired(d.receiptNo || d.receipt_no, 'Receipt number')
    if (!receiptNoValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: receiptNoValidation.error })
    }

    // Validate investor ID
    const investorIdValidation = validateRequired(d.investorId || d.investor_id, 'Investor ID')
    if (!investorIdValidation.valid) {
      return res.status(400).json({ error: 'validation_error', detail: investorIdValidation.error })
    }

    // Validate investment amount if provided
    if (d.investmentAmount || d.investment_amount || d.amount) {
      const amountValidation = validatePositiveNumber(
        d.investmentAmount || d.investment_amount || d.amount, 
        'Investment amount', 
        false
      )
      if (!amountValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: amountValidation.error })
      }
    }

    // Validate date if provided
    const dateValue = d.date === '{{today}}' ? today : d.date
    if (dateValue) {
      const dateValidation = validateDate(dateValue, 'Receipt date', false)
      if (!dateValidation.valid) {
        return res.status(400).json({ error: 'validation_error', detail: dateValidation.error })
      }
    }

    // Validate product category specific fields
    const productCategory = d.product_category || d.productCategory
    
    if (productCategory === 'MF') {
      // Mutual Fund validations
      if (!d.schemeName && !d.scheme_name) {
        return res.status(400).json({ error: 'validation_error', detail: 'Scheme name is required for Mutual Funds' })
      }
      if (!d.investmentAmount && !d.investment_amount && !d.amount) {
        return res.status(400).json({ error: 'validation_error', detail: 'Investment amount is required for Mutual Funds' })
      }
      // mode is legacy; prefer txn_type but keep backward compatibility
      const hasLegacyMode = !!(d.mode || d.mode_type || d.investment_mode)
      const hasTxnType =
        !!(d.txn_type || d.txnType || d.transaction_type || d.transactionType) ||
        !!d.type // sometimes provided as generic transaction type
      if (!hasLegacyMode && !hasTxnType) {
        return res.status(400).json({ error: 'validation_error', detail: 'txn_type (or legacy mode) is required for Mutual Funds' })
      }
    } else if (productCategory === 'INS') {
      // Insurance validations
      if (!d.issuerCompany && !d.issuer_company) {
        return res.status(400).json({ error: 'validation_error', detail: 'Issuer company is required for Insurance' })
      }
      if (!d.investmentAmount && !d.investment_amount && !d.amount) {
        return res.status(400).json({ error: 'validation_error', detail: 'Premium amount is required for Insurance' })
      }
    } else if (productCategory === 'FD') {
      // Fixed Deposit validations - support both old and new field names
      const hasIssuer = d.issuerCompany || d.issuer_company || d.fd_issuer_name || d.fd_issuer_key
      if (!hasIssuer) {
        return res.status(400).json({ error: 'validation_error', detail: 'Company name is required for Fixed Deposit' })
      }
      const hasAmount = d.investmentAmount || d.investment_amount || d.amount || d.fd_deposit_amount
      if (!hasAmount) {
        return res.status(400).json({ error: 'validation_error', detail: 'Deposit amount is required for Fixed Deposit' })
      }
      const hasRoi = d.roi || d.roi_percent || d.fd_total_rate_pa || d.fd_locked_interest_rate_pa
      if (!hasRoi) {
        return res.status(400).json({ error: 'validation_error', detail: 'Interest rate is required for Fixed Deposit' })
      }
      const hasPeriod = d.depositPeriodYM || d.deposit_period_ym || d.fd_tenure_months || d.fd_tenure_value
      if (!hasPeriod) {
        return res.status(400).json({ error: 'validation_error', detail: 'Deposit period is required for Fixed Deposit' })
      }
    } else if (productCategory === 'BOND') {
      // Bonds validations
      if (!d.issuerCompany && !d.issuer_company) {
        return res.status(400).json({ error: 'validation_error', detail: 'Issuer company is required for Bonds' })
      }
      if (!d.investmentAmount && !d.investment_amount && !d.amount) {
        return res.status(400).json({ error: 'validation_error', detail: 'Investment amount is required for Bonds' })
      }
    } else if (productCategory === 'MISC') {
      // Misc Services validations
      if (!d.service_name && !d.serviceName) {
        return res.status(400).json({ error: 'validation_error', detail: 'Service name is required for Misc Services' })
      }
      const servicePrice = parseFloat(d.service_price || d.servicePrice || d.investmentAmount || d.investment_amount || d.amount || 0)
      if (!servicePrice || servicePrice <= 0) {
        return res.status(400).json({ error: 'validation_error', detail: 'Service price is required and must be greater than 0 for Misc Services' })
      }
    }

    // Replace placeholders if needed
    const receiptNo = (d.receiptNo || d.receipt_no || '').replace('{{today}}', today)
    const date = d.date === '{{today}}' ? today : d.date || null

    // Calculate CC and SI from scheme percentages at transaction time
    // This ensures we store the CC/SI amount at the moment of transaction creation
    let collectionCredit = 0
    let serviceIncome = 0
    // For MISC, use service_price; for others, use investment_amount or fd_deposit_amount
    const investmentAmount = productCategory === 'MISC' 
      ? parseFloat(d.service_price || d.servicePrice || d.investmentAmount || d.investment_amount || d.amount || 0)
      : parseFloat(d.investmentAmount || d.investment_amount || d.amount || d.fd_deposit_amount || 0)
    
    // Check if CC/SI are already provided (from frontend calculation)
    if (d.collection_credit !== undefined || d.cc !== undefined) {
      collectionCredit = parseFloat(d.collection_credit || d.cc || 0)
    }
    if (d.service_income !== undefined || d.si !== undefined) {
      serviceIncome = parseFloat(d.service_income || d.si || 0)
    }
    
    // If not provided and we have investment amount, calculate from scheme
    if (investmentAmount > 0 && collectionCredit === 0 && serviceIncome === 0) {
      try {
        if (productCategory === 'MF') {
          // Use target scheme for CC/SI when present (e.g. STP target, Switch To scheme); else primary scheme
          const schemeCodeForCcSi = d.stp_target_scheme_code || d.switch_to_scheme_code || d.scheme_code
          if (schemeCodeForCcSi) {
            const mfSchemes = await q(`
              FOR scheme IN mf_schemes
              FILTER scheme.scheme_code == @scheme_code
              LIMIT 1
              RETURN { cc: scheme.cc || 0, si: scheme.si || 0 }
            `, { scheme_code: schemeCodeForCcSi })
            
            if (mfSchemes.length > 0) {
              const scheme = mfSchemes[0]
              const ccPercent = parseFloat(scheme.cc || 0)
              const siPercent = parseFloat(scheme.si || 0)
              collectionCredit = Math.round(((ccPercent / 100) * investmentAmount) * 100) / 100 // Round to 2 decimal places
              serviceIncome = Math.round(((siPercent / 100) * investmentAmount) * 100) / 100 // Round to 2 decimal places

              // Switch Over: earn CC on the switch only when target scheme CC% is higher than source scheme CC%
              const fromCode = d.switch_from_scheme_code
              if (fromCode && schemeCodeForCcSi && String(fromCode) !== String(schemeCodeForCcSi)) {
                const srcRows = await q(`
                  FOR s IN mf_schemes
                    FILTER s.scheme_code == @code
                    LIMIT 1
                    RETURN TO_NUMBER(s.cc || 0)
                `, { code: fromCode })
                const srcCcPct = srcRows.length ? parseFloat(srcRows[0]) : 0
                if (!(ccPercent > srcCcPct)) {
                  collectionCredit = 0
                }
              }
            }
          }
        } else if (productCategory === 'FD' && d.fd_issuer_key && d.fd_scheme_id) {
          // Fetch FD issuer/scheme to get CC and SI percentages.
          // Prefer rate-slab level CC/SI; fall back to scheme-level CC/SI for backward compatibility.
          const fdIssuers = await q(`
            FOR issuer IN fd_issuers
            FILTER issuer._key == @issuer_key
            LIMIT 1
            RETURN issuer
          `, { issuer_key: d.fd_issuer_key })
          
          if (fdIssuers.length > 0) {
            const issuer = fdIssuers[0]
            const scheme = issuer.schemes?.find(s => s.scheme_id === d.fd_scheme_id)
            if (scheme) {
              let ccPercent = 0
              let siPercent = 0

              // Try to locate matching rate slab based on tenure and payout frequency
              const slabs = Array.isArray(scheme.rate_slabs) ? scheme.rate_slabs : []
              const unit = normalizeTenureUnit(d.fd_tenure_unit)
              const tenureValue = d.fd_tenure_value != null ? Number(d.fd_tenure_value) : (d.fd_tenure_months != null ? Number(d.fd_tenure_months) : null)
              const payoutFrequency = d.fd_payout_frequency || null

              let matchedSlab = null
              if (tenureValue && payoutFrequency && slabs.length > 0) {
                matchedSlab = slabs.find((slab) => {
                  if (slab.is_active === false) return false
                  if (slab.payout_frequency_type !== payoutFrequency) return false
                  const slabUnit = normalizeTenureUnit(slab.tenure_unit)
                  if (slabUnit !== unit) return false
                  if (unit === 'days') {
                    const min = Number(slab.tenure_min_days)
                    const max = Number(slab.tenure_max_days)
                    if (!Number.isFinite(min) || !Number.isFinite(max)) return false
                    return min <= tenureValue && max >= tenureValue
                  }
                  const min = Number(slab.tenure_min_months)
                  const max = Number(slab.tenure_max_months)
                  if (!Number.isFinite(min) || !Number.isFinite(max)) return false
                  return min <= tenureValue && max >= tenureValue
                })
              }

              if (matchedSlab && (matchedSlab.cc !== undefined || matchedSlab.si !== undefined)) {
                ccPercent = parseFloat(matchedSlab.cc || 0)
                siPercent = parseFloat(matchedSlab.si || 0)
              } else {
                // Fallback: use scheme-level CC/SI if configured
                ccPercent = parseFloat(scheme.cc || 0)
                siPercent = parseFloat(scheme.si || 0)
              }

              if (!Number.isNaN(ccPercent) && ccPercent !== 0) {
                collectionCredit = Math.round(((ccPercent / 100) * investmentAmount) * 100) / 100 // Round to 2 decimal places
              }
              if (!Number.isNaN(siPercent) && siPercent !== 0) {
                serviceIncome = Math.round(((siPercent / 100) * investmentAmount) * 100) / 100 // Round to 2 decimal places
              }
            }
          }
        } else if (productCategory === 'INS' && d.insurance_issuer_key && d.insurance_product_id) {
          // Fetch insurance product to get CC and SI (optionally by Premium Payment Term / PPT slab)
          const insuranceIssuers = await q(`
            FOR issuer IN insurance_issuers
            FILTER issuer._key == @insurance_issuer_key
            LIMIT 1
            RETURN issuer
          `, { insurance_issuer_key: d.insurance_issuer_key })
          
          if (insuranceIssuers.length > 0) {
            const issuer = insuranceIssuers[0]
            const product = issuer.products?.find(p => p.product_id === d.insurance_product_id)
            if (product) {
              let ccPercent = parseFloat(product.cc || 0)
              let siPercent = parseFloat(product.si || 0)
              const pptSlabs = product.ppt_slabs && Array.isArray(product.ppt_slabs) ? product.ppt_slabs : []
              const pptRaw = d.insurance_premium_payment_term ?? d.insurance_premium_payment_term_years ?? d.insurance_premium_pay_term ?? d.premium_payment_term
              const pptStr = pptRaw != null ? String(pptRaw).trim().toLowerCase() : ''
              const pptYears = typeof pptRaw === 'number' && !Number.isNaN(pptRaw) ? pptRaw : (parseInt(pptRaw, 10) || null)
              if (pptSlabs.length > 0) {
                const singleOrZero = pptStr === 'single premium' || pptStr === 'single' || pptYears === 0 || pptRaw === null || pptRaw === ''
                const limitedPay = pptStr === 'limited pay' || pptStr === 'limited'
                let slab = null
                if (singleOrZero) {
                  slab = pptSlabs.find(s => s.ppt_type === 'Single Premium')
                } else if (limitedPay) {
                  slab = pptSlabs.find(s => s.ppt_type === 'Limited Pay')
                } else if (pptYears != null && !Number.isNaN(pptYears)) {
                  slab = pptSlabs.find(s => {
                    if (s.ppt_type !== 'PPT') return false
                    const min = s.ppt_years_min != null ? Number(s.ppt_years_min) : null
                    const max = s.ppt_years_max != null ? Number(s.ppt_years_max) : null
                    if (min != null && pptYears < min) return false
                    if (max != null && pptYears > max) return false
                    return true
                  })
                }
                if (slab) {
                  ccPercent = parseFloat(slab.cc ?? product.cc ?? 0)
                  siPercent = parseFloat(slab.si ?? product.si ?? 0)
                }
              }
              collectionCredit = Math.round(((ccPercent / 100) * investmentAmount) * 100) / 100 // Round to 2 decimal places
              serviceIncome = Math.round(((siPercent / 100) * investmentAmount) * 100) / 100 // Round to 2 decimal places
            }
          }
        } else if (productCategory === 'MISC') {
          // Fetch misc services scheme to get CC and SI percentages based on price range
          const miscSchemes = await q(`
            FOR scheme IN misc_services_schemes
            FILTER scheme.is_active == true
            LIMIT 1
            RETURN scheme
          `)
          
          if (miscSchemes.length > 0 && miscSchemes[0].price_ranges && miscSchemes[0].price_ranges.length > 0) {
            const scheme = miscSchemes[0]
            const servicePrice = parseFloat(d.service_price || d.servicePrice || investmentAmount)
            
            // Find matching price range
            const matchingRange = scheme.price_ranges.find(range => {
              const minPrice = parseFloat(range.min_price)
              const maxPrice = parseFloat(range.max_price)
              return servicePrice >= minPrice && servicePrice <= maxPrice
            })
            
            if (matchingRange) {
              const ccPercent = parseFloat(matchingRange.cc || 0)
              const siPercent = parseFloat(matchingRange.si || 0)
              collectionCredit = Math.round(((ccPercent / 100) * servicePrice) * 100) / 100 // Round to 2 decimal places
              serviceIncome = Math.round(((siPercent / 100) * servicePrice) * 100) / 100 // Round to 2 decimal places
            }
          }
        }
      } catch (error) {
        console.error('Error calculating CC/SI from scheme:', error)
        // Continue with 0 values if calculation fails - log for debugging
      }
    }

    // ============================================
    // BUILD STRUCTURED RECEIPT SCHEMA
    // ============================================
    
    // Employee Information
    const employee = {
      code: d.empCode || d.emp_code || null,
      name: d.employeeName || d.employee_name || null,
      branch: d.branch || null
    }
    
    // Investor Information
    const investorAddress = d.investorAddress || d.investor_address || ''
    const addressParts = investorAddress.split('\n').filter(Boolean)
    const investor = {
      id: d.investorId || d.investor_id || null,
      name: d.investorName || d.investor_name || null,
      address: {
        line1: addressParts[0] || null,
        line2: addressParts[1] || null,
        line3: addressParts[2] || null,
        city: d.city || null,
        state: d.state || null,
        pin_code: d.pinCode || d.pin_code || null,
        country: d.country || 'India'
      },
      pan: d.pan || null,
      email: d.email || null,
      mobile: d.mobile || null
    }
    
    // Product Information
    const product = {
      category: productCategory || null,
      name: productCategory === 'MISC' 
        ? (d.service_name || d.serviceName || null)
        : (d.schemeName || d.scheme_name || d.fd_scheme_name || null),
      option: d.schemeOption || d.scheme_option || null,
      folio_number: d.folio_number || d.folioNumber || null,
      has_existing_folio: d.has_existing_folio !== undefined ? d.has_existing_folio : (d.hasExistingFolio !== undefined ? d.hasExistingFolio : null)
    }
    
    const txnTypeForMode =
      d.txnType || d.txn_type || d.transaction_type || d.transactionType || null

    const deriveModeFromTxnType = (raw) => {
      const v = String(raw || '').trim()
      if (!v) return null
      const upper = v.toUpperCase()

      // Switch Over
      if (upper === 'SWITCHOVER' || v === 'Switch Over') return 'Switch Over'

      // Lump Sum (normalize Lumpsum -> Lump Sum)
      if (v === 'Lumpsum' || v === 'LumpSum' || v === 'Lump Sum') return 'Lump Sum'
      if (upper === 'LUMPSUM') return 'Lump Sum'

      // SIP / SWP / STP
      if (v === 'SIP' || v === 'SWP' || v === 'STP') return v

      return v
    }

    // Transaction Details (mode is MF-only; FD/INS/BOND do not use mode)
    const transaction = {
      type: d.txnType || d.txn_type || d.fd_transaction_type || d.transaction_type || 'Fresh',
      // `mode` is deprecated. MF behaviour is determined via `txn_type` (+ sip/swp/stp frequency fields).
      mode: null,
      amount: investmentAmount || null,
      units_or_amount: d.unitsOrAmount || d.units_or_amount || null,
      date: date || null,
      from_text: d.from || d.from_text || null,
      to_text: d.to || d.to_text || null,
      period_installments: d.period_installments || d.sip_stp_swp_period || null,
      installments_count: d.noOfInstallments || d.installments_count || null
    }
    
    // SIP Details
    if (transaction.mode === 'SIP' || d.sip_frequency) {
      transaction.sip = {
        frequency: d.sip_frequency || null,
        start_date: d.sip_start_date || null,
        end_date: d.sip_end_date || null,
        is_perpetual: d.sip_is_perpetual !== undefined ? d.sip_is_perpetual : false
      }
    }
    
    // SWP Details
    if (transaction.mode === 'SWP' || d.swp_frequency) {
      transaction.swp = {
        frequency: d.swp_frequency || null,
        start_date: d.swp_start_date || null,
        amount: d.swp_amount || null
      }
    }
    
    // STP Details
    if (transaction.mode === 'STP' || d.stp_frequency) {
      transaction.stp = {
        // Source = selected receipt scheme, Target = selected STP target scheme
        from_scheme_code: d.scheme_code || null,
        from_scheme_name: d.schemeName || d.scheme_name || null,
        to_scheme_code: d.stp_target_scheme_code || null,
        to_scheme_name: d.stp_target_scheme_name || null,
        frequency: d.stp_frequency || null,
        start_date: d.stp_start_date || null,
        amount: d.stp_amount || null,
        original_amount: d.stp_original_amount || null
      }
    }
    
    // Switch Over Details
    if (transaction.type === 'Switch Over' || d.switch_from_scheme_code) {
      transaction.switch_over = {
        from_scheme_code: d.switch_from_scheme_code || null,
        from_scheme_name: d.switch_from_scheme_name || null,
        to_scheme_code: d.switch_to_scheme_code || d.scheme_code || null,
        to_scheme_name: d.switch_to_scheme_name || d.schemeName || d.scheme_name || null,
        type: d.switch_type || null,
        value: d.switch_value || null
      }
    }
    
    // Product-Specific Details
    const productDetails = {}
    
    // MF Details
    if (productCategory === 'MF') {
      const validMfAmcCategories = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']
      const mfAmcCategory = (d.mf_amc_category && validMfAmcCategories.includes(d.mf_amc_category)) ? d.mf_amc_category : 'MF'
      const mfAmcMinInvestment = d.mf_amc_category_min_investment != null ? parseFloat(d.mf_amc_category_min_investment) : null
      productDetails.mf = {
        amc_category: mfAmcCategory,
        min_investment: Number.isFinite(mfAmcMinInvestment) ? mfAmcMinInvestment : null,
        amc: {
          code: d.amc_code || null,
          name: d.amc_name || null
        },
        scheme: {
          code: d.scheme_code || null,
          name: d.schemeName || d.scheme_name || null,
          category: d.scheme_category || null,
          sub_category: d.scheme_sub_category || null,
          plan: d.scheme_plan || null,
          type: d.scheme_type || null,
          is_nfo: d.scheme_is_nfo !== undefined ? d.scheme_is_nfo : false
        }
      }
    }
    
    // FD Details
    if (productCategory === 'FD') {
      const fdTenureUnit = normalizeTenureUnit(d.fd_tenure_unit)
      const fdTenureValue = d.fd_tenure_value != null ? Number(d.fd_tenure_value) : (d.fd_tenure_months != null ? Number(d.fd_tenure_months) : null)
      productDetails.fd = {
        issuer: {
          key: d.fd_issuer_key || null,
          name: d.fd_issuer_name || null,
          type: d.fd_issuer_type || null
        },
        scheme: {
          id: d.fd_scheme_id || null,
          name: d.fd_scheme_name || null,
          is_cumulative: d.fd_is_cumulative !== undefined ? d.fd_is_cumulative : false
        },
        deposit: {
          amount: d.fd_deposit_amount || null,
          tenure_months: fdTenureUnit === 'months' ? (d.fd_tenure_months || fdTenureValue || null) : null,
          tenure_unit: fdTenureValue != null ? fdTenureUnit : null,
          tenure_value: fdTenureValue != null ? fdTenureValue : null,
          payout_frequency: d.fd_payout_frequency || null,
          booking_date: d.fd_booking_date || null,
          deposit_date: d.fd_deposit_date || null
        },
        rates: {
          base_rate_pa: d.fd_base_rate_pa || null,
          senior_citizen_bonus: d.fd_senior_citizen_bonus || null,
          women_bonus: d.fd_women_bonus || null,
          renewal_bonus: d.fd_renewal_bonus || null,
          total_rate_pa: d.fd_total_rate_pa || null,
          locked_interest_rate_pa: d.fd_locked_interest_rate_pa || null,
          effective_yield_pa: d.fd_effective_yield_pa || null
        },
        maturity: {
          amount: d.fd_maturity_amount || null,
          date: d.fd_maturity_date || null,
          periodic_payout: d.fd_periodic_payout || null,
          total_interest: d.fd_total_interest || null
        },
        tax: {
          tds_applicable: d.fd_tds_applicable !== undefined ? d.fd_tds_applicable : null,
          form_15g_15h: d.fd_form_15g_15h !== undefined ? d.fd_form_15g_15h : null
        },
        application: {
          number: d.fd_application_number || null,
          transaction_type: d.fd_transaction_type || 'Fresh',
          renewal: d.fd_transaction_type === 'Renewal' ? {
            investment_type: d.fd_renewal_investment_type || null,
            additional_amount: d.fd_renewal_additional_amount || null
          } : null
        }
      }
    }
    
    // Insurance Details
    if (productCategory === 'INS') {
      const policyPeriodRaw = d.insurance_policy_period ?? d.insurancePolicyPeriod ?? null
      const policyPeriodNum = policyPeriodRaw != null && String(policyPeriodRaw).trim() !== '' ? Number(policyPeriodRaw) : null
      const policyPeriodYears = Number.isFinite(policyPeriodNum) ? policyPeriodNum : null

      productDetails.insurance = {
        issuer: {
          key: d.insurance_issuer_key || null,
          name: d.issuerCompany || d.issuer_company || null,
          type: d.issuerCategory || d.issuer_category || 'Insurance'
        },
        product: {
          id: d.insurance_product_id || null,
          name: d.insurance_product_name || d.scheme_name || null,
          category: d.insurance_category || null,
          sub_category: d.insurance_sub_category || null
        },
        policy: {
          number: d.folioPolicyNo || d.folio_policy_no || d.insurance_policy_number || null,
          type: d.fd_type || d.fdType || d.insurance_policy_type || null,
          premium_amount: investmentAmount || d.insurance_premium_amount || null,
          premium_frequency: d.interest_frequency || d.interestFrequency || d.insurance_premium_frequency || null,
          premium_payment_term: d.insurance_premium_payment_term || null,
          premium_payment_term_type: d.insurance_premium_payment_term_type || null,
          // Persist fields used by edit modal autofill / normalizer
          renewal_date: d.insurance_renewal_date || d.insuranceRenewalDate || null,
          period: policyPeriodRaw
        },
        coverage: {
          sum_assured: d.insurance_sum_assured || null,
          // Prefer explicit policy term; fallback to policy period (years) when provided by UI.
          policy_term_years: d.insurance_policy_term_years || policyPeriodYears || null,
          // UI sends `insurance_date_of_issue`; keep compatibility with `insurance_policy_start_date`
          policy_start_date: d.insurance_policy_start_date || d.insurance_date_of_issue || d.insuranceDateOfIssue || null,
          maturity_date: d.insurance_maturity_date || null
        },
        riders: d.insurance_selected_riders ? (Array.isArray(d.insurance_selected_riders) ? d.insurance_selected_riders : [d.insurance_selected_riders]) : null,
        beneficiaries: d.insurance_beneficiaries || null,
        coverage_details: d.insurance_coverage_details || null
      }
    }
    
    // Misc Services Details
    if (productCategory === 'MISC') {
      const servicePrice = parseFloat(d.service_price || d.servicePrice || investmentAmount)
      productDetails.misc = {
        service_name: d.service_name || d.serviceName || null,
        service_price: servicePrice || null
      }
    }
    
    // Bond/NCD Details
    if (productCategory === 'BOND' || productCategory === 'NCD') {
      productDetails.bond = {
        issuer: {
          key: d.bond_issuer_key || null,
          name: d.bond_issuer_name || d.issuerCompany || d.issuer_company || null,
          type: d.bond_issuer_type || d.issuerCategory || d.issuer_category || 'Corporate'
        },
        scheme: {
          id: d.bond_scheme_id || null,
          name: d.bond_scheme_name || d.scheme_name || null,
          isin: d.bond_isin || null
        },
        instrument: {
          coupon_rate: d.bond_coupon_rate || d.roi || d.roi_percent || null,
          face_value: d.bond_face_value || null,
          issue_date: d.bond_issue_date || null,
          maturity_date: d.bond_maturity_date || d.renewalDueDate || d.renewal_due_date || null,
          tenure_months: d.bond_tenure_months != null && d.bond_tenure_months !== ''
            ? Number(d.bond_tenure_months)
            : null
        },
        transaction: {
          type: d.bond_transaction_type || d.txn_type || null,
          number_of_units: d.bond_number_of_units || null,
          amount: d.bond_investment_amount || d.investment_amount || investmentAmount || null,
          date: d.bond_transaction_date || null
        },
        application: {
          number: d.bond_application_number || null
        },
        tax: {
          form_15g_15h: d.bond_form_15g_15h || null
        }
      }
    }
    
    // Payment Information – build from both transaction_details and top-level flat fields so we never lose Online/Offline/Others data
    const td = d.transaction_details && typeof d.transaction_details === 'object' ? d.transaction_details : {}

    const entryMode = td.entry_mode ?? d.entry_mode ?? d.transactionType ?? null
    let channel = td.channel ?? d.transaction_channel ?? null
    if (channel == null || channel === '') {
      if (entryMode === 'Online' || d.transactionType === 'Online') {
        channel = d.transactionNumber ?? td.reference_no ?? null
      } else if (entryMode === 'Offline' || d.transactionType === 'Offline') {
        channel = 'Cheque'
      } else if (entryMode === 'Others' || d.transactionType === 'Others') {
        channel = d.othersTransactionType ?? td.notes ?? null
      }
    }

    let referenceNo = td.reference_no ?? d.transaction_reference_no ?? d.transactionNumber ?? null
    if (referenceNo == null || referenceNo === '') {
      if (entryMode === 'Online' || d.transactionType === 'Online') {
        referenceNo = d.transactionNumber ?? td.reference_no ?? null
      } else if (entryMode === 'Offline' || d.transactionType === 'Offline') {
        referenceNo = d.chequeNumber ?? td.reference_no ?? null
      }
    }
    if (referenceNo == null || referenceNo === '') {
      referenceNo = d.transactionNumber ?? null
    }

    const bankName = td.bank_name ?? d.bankName ?? d.bank_name ?? null
    const bankBranch = td.bank_branch ?? d.bankBranch ?? d.bank_branch ?? null
    const transactionDate = td.txn_date ?? d.txn_date ?? d.chequeDate ?? d.instrumentDate ?? d.instrument_date ?? null

    let notes = td.notes ?? d.transaction_notes ?? d.notes ?? null
    if ((notes == null || notes === '') && (entryMode === 'Others' || d.transactionType === 'Others')) {
      notes = d.othersTransactionType ?? null
    }

    const instrumentType = d.instrumentType ?? d.instrument_type ?? (entryMode === 'Offline' || d.transactionType === 'Offline' ? 'Cheque' : null)
    const instrumentNo = d.instrumentNo ?? d.instrument_no ?? (entryMode === 'Offline' ? d.chequeNumber : null) ?? null
    const instrumentDate = d.instrumentDate ?? d.instrument_date ?? (entryMode === 'Offline' ? d.chequeDate : null) ?? null

    const payment = {
      instrument: {
        type: instrumentType,
        number: instrumentNo,
        date: instrumentDate,
        bank: {
          name: bankName,
          branch: bankBranch
        }
      },
      entry_mode: entryMode,
      channel: channel,
      reference_no: referenceNo,
      transaction_date: transactionDate,
      account_last4: td.account_last4 ?? d.account_last4 ?? null,
      notes: notes
    }
    
    // Calculations
    const calculations = {
      collection_credit: collectionCredit,
      service_income: serviceIncome,
      // Legacy aliases for backward compatibility
      cc: collectionCredit,
      si: serviceIncome
    }
    
    // Legacy nested structures (for backward compatibility)
    const mfDetails = productCategory === 'MF' ? {
      amc_code: d.amc_code || null,
      amc_name: d.amc_name || null,
      scheme_code: d.scheme_code || null,
      scheme_name: d.schemeName || d.scheme_name || null,
      category: d.scheme_category || null,
      sub_category: d.scheme_sub_category || null,
      plan: d.scheme_plan || null,
      option: d.scheme_option || null,
      type: d.scheme_type || null,
      is_nfo: d.scheme_is_nfo || null,
      amc_category: (d.mf_amc_category && ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS'].includes(d.mf_amc_category)) ? d.mf_amc_category : 'MF',
      min_investment: d.mf_amc_category_min_investment != null ? parseFloat(d.mf_amc_category_min_investment) : null
    } : null

    const fdDetails = productCategory === 'FD' ? {
      issuer_key: d.fd_issuer_key || null,
      issuer_name: d.fd_issuer_name || null,
      issuer_type: d.fd_issuer_type || null,
      scheme_id: d.fd_scheme_id || null,
      scheme_name: d.fd_scheme_name || null,
      is_cumulative: d.fd_is_cumulative || null,
      deposit_amount: d.fd_deposit_amount || null,
      tenure_months: (normalizeTenureUnit(d.fd_tenure_unit) === 'months')
        ? (d.fd_tenure_months || (d.fd_tenure_value != null ? Number(d.fd_tenure_value) : null) || null)
        : null,
      tenure_unit: d.fd_tenure_unit != null ? normalizeTenureUnit(d.fd_tenure_unit) : null,
      tenure_value: d.fd_tenure_value != null ? Number(d.fd_tenure_value) : null,
      payout_frequency: d.fd_payout_frequency || null,
      base_rate_pa: d.fd_base_rate_pa || null,
      senior_citizen_bonus: d.fd_senior_citizen_bonus || null,
      women_bonus: d.fd_women_bonus || null,
      renewal_bonus: d.fd_renewal_bonus || null,
      total_rate_pa: d.fd_total_rate_pa || null,
      maturity_amount: d.fd_maturity_amount || null,
      maturity_date: d.fd_maturity_date || null,
      application_number: d.fd_application_number || null,
      deposit_date: d.fd_deposit_date || null,
      tds_applicable: d.fd_tds_applicable || null,
      form_15g_15h: d.fd_form_15g_15h || null,
      transaction_type: d.fd_transaction_type || null,
      renewal_investment_type: d.fd_renewal_investment_type || null,
      renewal_additional_amount: d.fd_renewal_additional_amount || null
    } : null

    // Build structured receipt document — nested tree only; stats/list use product.category, transaction.amount, etc.
    const receiptEmpCode = d.empCode || d.emp_code || req.user.emp_code || null
    const receiptDoc = {
      // ============================================
      // CORE METADATA
      // ============================================
      receipt_no: receiptNo,
      date: date,
      status: 'Pending',
      branch: d.branch || null,
      user_id: req.user.sub,
      emp_code: receiptEmpCode,
      created_at: new Date().toISOString(),
      updated_at: null,
      is_deleted: false,
      deleted_at: null,

      // ============================================
      // STRUCTURED SECTIONS (nested tree — single source of truth)
      // ============================================
      employee: employee,
      investor: investor,
      product: product,
      transaction: transaction,
      product_details: Object.keys(productDetails).length > 0 ? productDetails : null,
      payment: payment,
      calculations: calculations
    }

    const result = await getCollection('receipts').save(receiptDoc)
    const receiptId = result._key

    // Handle file uploads if any
    let uploadedFiles = []
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileData = {
          id: Date.now() + Math.random(), // Generate unique ID
          original_name: file.originalname,
          filename: file.filename,
          file_size: file.size,
          mime_type: file.mimetype,
          uploaded_by: req.user.sub,
          uploaded_at: new Date().toISOString()
        }
        uploadedFiles.push(fileData)
      }

      // Update the receipt with files
      await getCollection('receipts').update(receiptId, { files: uploadedFiles })
    }

    // Generate and store PDF in background
    try {
      // Import PDF generation function dynamically
      const pdfModule = await import('./receipt-pdf.js')
      const pdfBuffer = await pdfModule.generateReceiptPDF(receiptDoc)
      
      // Store PDF in database
      await getCollection('receipts').update(receiptId, {
        pdf_data: pdfBuffer.toString('base64'),
        pdf_generated_at: new Date().toISOString()
      })
    } catch (pdfError) {
      console.error('Failed to generate PDF on receipt creation:', pdfError)
      // Don't fail the receipt creation if PDF generation fails
    }

    publishEvent({
      type: 'receipt.created',
      payload: {
        receipt_id: receiptId,
        customer_id: receiptDoc.customer_id || null,
        customer_name: receiptDoc.customer_name || null,
        category: receiptDoc.category || null,
        amount: calculations?.total || calculations?.amount || null,
        branch: receiptDoc.branch || null,
        branch_code: receiptDoc.branch_code || null
      },
      actor: { id: req.user.sub, emp_code: req.user.emp_code },
      branch: receiptDoc.branch || null
    })

    res.status(201).json({ 
      id: receiptId,
      files: uploadedFiles
    })
  } catch (e) {
    console.error('Insert failed:', e)
    
    // Clean up uploaded files if database insert fails
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path)
        } catch (unlinkError) {
          console.error('Failed to clean up file:', unlinkError)
        }
      })
    }
    
    res.status(400).json({ error: 'save_failed', detail: e.code || e.message || String(e) })
  }
})

// Helper: normalize older receipt documents to the new nested shape
function withNormalizedDetails(receipt) {
  if (!receipt) return receipt
  const normalized = { ...receipt }

  // Backfill mf_details for legacy MF receipts (from flat or product_details.mf)
  if (!normalized.mf_details && normalized.product_category === 'MF') {
    const mf = normalized.product_details?.mf
    const validMfAmc = ['MF', 'SIF', 'PMS', 'AIF', 'GIFT_CITY_FUNDS']
    const amcCat = (normalized.mf_amc_category && validMfAmc.includes(normalized.mf_amc_category)) ? normalized.mf_amc_category : (mf?.amc_category && validMfAmc.includes(mf.amc_category) ? mf.amc_category : 'MF')
    const minInv = normalized.mf_amc_category_min_investment ?? mf?.min_investment ?? null
    normalized.mf_details = {
      amc_code: normalized.amc_code ?? mf?.amc?.code ?? null,
      amc_name: normalized.amc_name ?? mf?.amc?.name ?? null,
      scheme_code: normalized.scheme_code ?? mf?.scheme?.code ?? null,
      scheme_name: normalized.scheme_name ?? mf?.scheme?.name ?? null,
      category: normalized.scheme_category ?? mf?.scheme?.category ?? null,
      sub_category: normalized.scheme_sub_category ?? mf?.scheme?.sub_category ?? null,
      plan: normalized.scheme_plan ?? mf?.scheme?.plan ?? null,
      option: normalized.scheme_option ?? null,
      type: normalized.scheme_type ?? mf?.scheme?.type ?? null,
      is_nfo: normalized.scheme_is_nfo ?? mf?.scheme?.is_nfo ?? null,
      amc_category: amcCat,
      min_investment: minInv != null ? parseFloat(minInv) : null
    }
  }

  // Backfill fd_details for legacy FD receipts
  if (!normalized.fd_details && normalized.product_category === 'FD') {
    normalized.fd_details = {
      issuer_key: normalized.fd_issuer_key || null,
      issuer_name: normalized.fd_issuer_name || null,
      issuer_type: normalized.fd_issuer_type || null,
      scheme_id: normalized.fd_scheme_id || null,
      scheme_name: normalized.fd_scheme_name || null,
      is_cumulative: normalized.fd_is_cumulative || null,
      deposit_amount: normalized.fd_deposit_amount || null,
      tenure_months: normalized.fd_tenure_months || null,
      tenure_unit: normalized.fd_tenure_unit != null ? normalizeTenureUnit(normalized.fd_tenure_unit) : null,
      tenure_value: normalized.fd_tenure_value != null ? Number(normalized.fd_tenure_value) : null,
      payout_frequency: normalized.fd_payout_frequency || null,
      base_rate_pa: normalized.fd_base_rate_pa || null,
      senior_citizen_bonus: normalized.fd_senior_citizen_bonus || null,
      women_bonus: normalized.fd_women_bonus || null,
      renewal_bonus: normalized.fd_renewal_bonus || null,
      total_rate_pa: normalized.fd_total_rate_pa || null,
      maturity_amount: normalized.fd_maturity_amount || null,
      maturity_date: normalized.fd_maturity_date || null,
      application_number: normalized.fd_application_number || null,
      deposit_date: normalized.fd_deposit_date || null,
      tds_applicable: normalized.fd_tds_applicable || null,
      form_15g_15h: normalized.fd_form_15g_15h || null,
      transaction_type: normalized.fd_transaction_type || normalized.txn_type || null,
      renewal_investment_type: normalized.fd_renewal_investment_type || null,
      renewal_additional_amount: normalized.fd_renewal_additional_amount || null
    }
  }

  // Backfill flat fields from nested tree so list/export/PDF can use them (we store only nested)
  const inv = normalized.investor
  if (inv && typeof inv === 'object') {
    if (normalized.investor_id == null) normalized.investor_id = inv.id ?? null
    if (normalized.investor_name == null) normalized.investor_name = inv.name ?? null
  }
  const prod = normalized.product
  if (prod && typeof prod === 'object') {
    if (normalized.product_category == null) normalized.product_category = prod.category ?? null
  }
  const txn = normalized.transaction
  if (txn && typeof txn === 'object' && normalized.investment_amount == null && txn.amount != null) {
    normalized.investment_amount = txn.amount
  }
  if (normalized.product_details?.fd?.deposit?.amount != null && normalized.fd_deposit_amount == null) {
    normalized.fd_deposit_amount = normalized.product_details.fd.deposit.amount
  }
  const mfPd = normalized.product_details?.mf
  if (mfPd && typeof mfPd === 'object' && normalized.product_category === 'MF') {
    if (normalized.mf_amc_category == null && mfPd.amc_category != null) normalized.mf_amc_category = mfPd.amc_category
    if (normalized.mf_amc_category_min_investment == null && mfPd.min_investment != null) normalized.mf_amc_category_min_investment = mfPd.min_investment
  }

  // Flatten payment onto root so consumers (view page, list, PDF) always get entry_mode, reference_no, etc.
  const payment = normalized.payment
  if (payment && typeof payment === 'object') {
    if (normalized.entry_mode == null) normalized.entry_mode = payment.entry_mode ?? null
    if (normalized.channel == null) normalized.channel = payment.channel ?? null
    if (normalized.reference_no == null) normalized.reference_no = payment.reference_no ?? null
    const txnDate = payment.transaction_date ?? null
    if (normalized.transaction_date == null) normalized.transaction_date = txnDate
    if (normalized.txn_date == null) normalized.txn_date = txnDate
    if (normalized.notes == null) normalized.notes = payment.notes ?? null
    if (payment.instrument && typeof payment.instrument === 'object') {
      if (normalized.instrument_type == null) normalized.instrument_type = payment.instrument.type ?? null
      if (normalized.instrument_no == null) normalized.instrument_no = payment.instrument.number ?? null
      if (normalized.instrument_date == null) normalized.instrument_date = payment.instrument.date ?? null
      if (payment.instrument.bank && typeof payment.instrument.bank === 'object') {
        if (normalized.bank_name == null) normalized.bank_name = payment.instrument.bank.name ?? null
        if (normalized.bank_branch == null) normalized.bank_branch = payment.instrument.bank.branch ?? null
      }
    }
  }

  return normalized
}

// Helper: strip SI fields for non-admin responses (after normalization)
function stripSIForNonAdmin(user, receipt) {
  if (!receipt || !user || user.role === 'admin') return receipt
  const { service_income, si, ...rest } = receipt
  return rest
}

// Get recent receipts for quick picks
router.get('/recent', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)))
    let filterConditions = ['receipt.is_deleted == false']
    const bindVars = { }

    if (req.user.role === 'employee') {
      filterConditions.push('receipt.user_id == @user_id')
      bindVars.user_id = String(req.user.sub)
    } else if (req.user.role === 'manager') {
      const userBranch = await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizeBranchName(userBranch) || userBranch
      }
    }

    const filterClause = filterConditions.length ? `FILTER ${filterConditions.join(' AND ')}` : ''

    const rows = await q(`
      FOR receipt IN receipts
      ${filterClause}
      SORT receipt.created_at DESC
      LIMIT ${limit}
      RETURN receipt
    `, bindVars)

    const sanitized = rows.map((r) => normalizeReceiptCategory(stripSIForNonAdmin(req.user, withNormalizedDetails(r))))
    res.json({ items: sanitized })
  } catch (error) {
    console.error('Error fetching recent receipts:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to fetch recent receipts' })
  }
})

// Duplicate check for receipt creation
router.get('/check-duplicate', requireAuth, async (req, res) => {
  try {
    const {
      investor_id,
      product_category,
      investment_amount,
      date,
      scheme_code,
      scheme_name,
      issuer_company,
      fd_issuer_key,
      fd_scheme_id,
      bond_issuer_key,
      bond_scheme_id,
      insurance_issuer_key,
      insurance_product_id
    } = req.query

    if (!investor_id || !product_category || !investment_amount) {
      return res.status(400).json({ error: 'validation_error', detail: 'investor_id, product_category, and investment_amount are required' })
    }

    const checkDate = date || new Date().toISOString().slice(0, 10)
    const bindVars = {
      investor_id: String(investor_id),
      product_category,
      investment_amount: Number(investment_amount),
      date: checkDate
    }

    const filterConditions = [
      'receipt.is_deleted == false',
      '((receipt.investor != null && receipt.investor.id == @investor_id) OR receipt.investor_id == @investor_id)',
      '((receipt.product != null && receipt.product.category == @product_category) OR receipt.product_category == @product_category)',
      'receipt.date == @date',
      'ABS((TO_NUMBER(receipt.transaction.amount) != null ? TO_NUMBER(receipt.transaction.amount) : (TO_NUMBER(receipt.investment_amount) != null ? TO_NUMBER(receipt.investment_amount) : (TO_NUMBER(receipt.fd_deposit_amount) || 0))) - @investment_amount) <= 1'
    ]

    if (scheme_code) {
      filterConditions.push('receipt.scheme_code == @scheme_code')
      bindVars.scheme_code = scheme_code
    }
    if (scheme_name) {
      filterConditions.push('receipt.scheme_name == @scheme_name')
      bindVars.scheme_name = scheme_name
    }
    if (issuer_company) {
      filterConditions.push('receipt.issuer_company == @issuer_company')
      bindVars.issuer_company = issuer_company
    }
    if (fd_issuer_key) {
      filterConditions.push('receipt.fd_issuer_key == @fd_issuer_key')
      bindVars.fd_issuer_key = fd_issuer_key
    }
    if (fd_scheme_id) {
      filterConditions.push('receipt.fd_scheme_id == @fd_scheme_id')
      bindVars.fd_scheme_id = fd_scheme_id
    }
    if (bond_issuer_key) {
      filterConditions.push('receipt.bond_issuer_key == @bond_issuer_key')
      bindVars.bond_issuer_key = bond_issuer_key
    }
    if (bond_scheme_id) {
      filterConditions.push('receipt.bond_scheme_id == @bond_scheme_id')
      bindVars.bond_scheme_id = bond_scheme_id
    }
    if (insurance_issuer_key) {
      filterConditions.push('receipt.insurance_issuer_key == @insurance_issuer_key')
      bindVars.insurance_issuer_key = insurance_issuer_key
    }
    if (insurance_product_id) {
      filterConditions.push('receipt.insurance_product_id == @insurance_product_id')
      bindVars.insurance_product_id = insurance_product_id
    }

    const filterClause = `FILTER ${filterConditions.join(' AND ')}`

    const rows = await q(`
      FOR receipt IN receipts
      ${filterClause}
      SORT receipt.created_at DESC
      LIMIT 5
      RETURN receipt
    `, bindVars)

    res.json({ duplicate: rows.length > 0, items: rows })
  } catch (error) {
    console.error('Error checking duplicate receipt:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to check duplicates' })
  }
})

// Get transaction summary statistics
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const {
      from,
      to,
      category,
      status,
      mode,
      txn_type,
      emp_code,
      branch_code,
      search,
      includeDeleted = '0',
      date_basis
    } = req.query

    const bindVars = {}
    const filterConditions = ['receipt.is_deleted == false']

    // Date filters
    const dateExpr = effectiveDateExprAql(date_basis)
    if (from) {
      filterConditions.push(`${dateExpr} >= @from`)
      bindVars.from = from
    }
    if (to) {
      filterConditions.push(`${dateExpr} <= @to`)
      bindVars.to = to
    }

    applyReceiptCategoryFilter(filterConditions, bindVars, category)

    // Status filter
    if (status) {
      filterConditions.push('receipt.status == @status')
      bindVars.status = status
    }

    applyMfTxnTypeOrModeFilter(filterConditions, bindVars, txn_type, mode)

    // Employee code filter
    if (emp_code) {
      filterConditions.push('receipt.emp_code == @emp_code')
      bindVars.emp_code = emp_code
    }

    // Branch code filter (admin) - match by code, name, or key
    if (branch_code) {
      const branchIdentifiers = await getBranchIdentifiersForFilter(branch_code)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else {
        filterConditions.push('receipt.branch == @branch_code')
        bindVars.branch_code = branch_code
      }
    }

    // Search filter (investor name, ID, PAN, or receipt number)
    if (search) {
      filterConditions.push('(LIKE(receipt.receipt_no, CONCAT("%", @search, "%"), true) OR (receipt.investor != null && (LIKE(receipt.investor.name, CONCAT("%", @search, "%"), true) || LIKE(receipt.investor.id, CONCAT("%", @search, "%"), true) || LIKE(receipt.investor.pan, CONCAT("%", @search, "%"), true))) OR LIKE(receipt.investor_name, CONCAT("%", @search, "%"), true) OR LIKE(receipt.investor_id, CONCAT("%", @search, "%"), true) OR LIKE(receipt.pan, CONCAT("%", @search, "%"), true))')
      bindVars.search = search
    }

    // User access control - same scope as list and dashboard
    if (req.user.role === 'employee' && req.user.emp_code) {
      filterConditions.push('receipt.emp_code == @user_emp_code')
      bindVars.user_emp_code = req.user.emp_code
    } else if (req.user.role === 'manager') {
      const userBranch = await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizeBranchName(userBranch) || userBranch
      }
    } else if (req.user.role === 'branch' && req.user.branch_code) {
      const branchIdentifiers = await getBranchIdentifiersForFilter(req.user.branch_code)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else {
        filterConditions.push('receipt.branch == @user_branch_code')
        bindVars.user_branch_code = req.user.branch_code
      }
    }

    const filterClause = filterConditions.length > 0 ? `FILTER ${filterConditions.join(' AND ')}` : ''

    // Calculate summary statistics (category and amount from nested tree first)
    const summary = await q(`
      FOR receipt IN receipts
      ${filterClause}
      LET status_val = receipt.status != null ? receipt.status : "Pending"
      LET category_raw = (receipt.product != null && receipt.product.category != null && receipt.product.category != "") ? receipt.product.category : (receipt.product_category != null && receipt.product_category != "" ? receipt.product_category : "Other")
      LET issuer_sig = LOWER(TO_STRING((receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.issuer != null && receipt.product_details.fd.issuer.type != null)
        ? receipt.product_details.fd.issuer.type
        : (receipt.fd_issuer_type != null ? receipt.fd_issuer_type : "")))
      LET is_govt_issuer = (CONTAINS(issuer_sig, "govt") OR CONTAINS(issuer_sig, "government") OR CONTAINS(issuer_sig, "post office") OR CONTAINS(issuer_sig, "post-office") OR CONTAINS(issuer_sig, "postoffice"))
      LET category_upper = UPPER(TO_STRING(category_raw))
      LET category_val = (category_upper == "FD" AND is_govt_issuer) ? "GOVT_FD" : category_raw
      LET inv_amount = (TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0) : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0) : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0)
      COLLECT status = status_val, category = category_val
      AGGREGATE
        total_count = LENGTH(1),
        total_investment = SUM(inv_amount),
        avg_investment = AVG(inv_amount)
      RETURN {
        status,
        category,
        count: total_count,
        total_investment,
        avg_investment
      }
    `, bindVars)

    // Calculate overall totals (amount from nested first)
    const totals = await q(`
      FOR receipt IN receipts
      ${filterClause}
      LET inv_amount = (TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0) : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0) : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0)
      COLLECT WITH COUNT INTO total_count
      AGGREGATE 
        total_investment = SUM(inv_amount),
        avg_investment = AVG(inv_amount)
      RETURN {
        total_count,
        total_investment,
        avg_investment
      }
    `, bindVars)

    // Organize by status
    const statusCounts = {
      Pending: 0,
      Completed: 0,
      Failed: 0
    }

    // Organize by category
    const categoryCounts = {}
    const categoryTotals = {}

    summary.forEach(item => {
      // Status counts
      if (statusCounts.hasOwnProperty(item.status)) {
        statusCounts[item.status] += item.count
      }

      // Category counts and totals
      if (!categoryCounts[item.category]) {
        categoryCounts[item.category] = 0
        categoryTotals[item.category] = 0
      }
      categoryCounts[item.category] += item.count
      categoryTotals[item.category] += item.total_investment
    })

    const result = totals[0] || { total_count: 0, total_investment: 0, avg_investment: 0 }

    res.json({
      total_receipts: result.total_count,
      total_investment: result.total_investment || 0,
      avg_investment: result.avg_investment || 0,
      status_counts: statusCounts,
      category_counts: categoryCounts,
      category_totals: categoryTotals
    })

  } catch (error) {
    console.error('Error fetching transaction summary:', error)
    res.status(500).json({ error: 'server_error', detail: 'Failed to fetch summary statistics' })
  }
})

// Get all receipts with filtering
router.get('/', requireAuth, async (req, res) => {
  try {
    const {
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      from,
      to,
      category,
      status,
      mode,
      txn_type, // Transaction type filter (Fresh, Additional, Redemption, Switch Over, etc.)
      issuer,
      emp_code,
      branch_code,
      search, // Search by investor name/ID or receipt ID
      includeDeleted = '0',
      date_basis
    } = req.query

    // sanitize page & size
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))

    // sanitize sort
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'date', 'amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'
    const effectiveAmountExpr = '((TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0) : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0) : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0))'
    const dateExpr = effectiveDateExprAql(date_basis)
    const orderExpr =
      orderBy === 'amount'
        ? effectiveAmountExpr
        : (orderBy === 'date' ? dateExpr : `receipt.${orderBy}`)

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage  = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { }
    let filterConditions = []

    // safe date filter (only if both provided and valid)
    if (
      from &&
      to &&
      !isNaN(Date.parse(from)) &&
      !isNaN(Date.parse(to))
    ) {
      filterConditions.push(`${dateExpr} >= @from AND ${dateExpr} <= @to`)
      bindVars.from = from
      bindVars.to = to
    }

    applyReceiptCategoryFilter(filterConditions, bindVars, category)
    if (status) {
      // Handle status filtering - treat null/undefined as 'Pending'
      if (status === 'Pending') {
        filterConditions.push('(receipt.status == null || receipt.status == @status)')
      } else {
        filterConditions.push('receipt.status == @status')
      }
      bindVars.status = status
    } else if (req.query.includePending === '0') {
      // Global "Include pending" toggle is OFF → exclude pending / null-status receipts
      // so listings stay consistent with KPIs/charts that also exclude them.
      filterConditions.push('receipt.status == "Completed"')
    }
    applyMfTxnTypeOrModeFilter(filterConditions, bindVars, txn_type, mode)
    if (issuer) {
      filterConditions.push('receipt.issuer_company LIKE @issuer')
      bindVars.issuer = `%${issuer}%`
    }

    // Branch filter (for admins) - match by branch code, name, or key
    if (branch_code && req.user.role === 'admin') {
      const branchIdentifiers = await getBranchIdentifiersForFilter(branch_code)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else {
        filterConditions.push('receipt.branch == @branch_code')
        bindVars.branch_code = branch_code
      }
    }

    // Search filter (investor name, ID, PAN, or receipt number)
    if (search && search.trim().length > 0) {
      const searchTerm = `%${search.trim()}%`
      filterConditions.push('(receipt.receipt_no LIKE @search OR (receipt.investor != null && (receipt.investor.name LIKE @search OR receipt.investor.id LIKE @search OR receipt.investor.pan LIKE @search)) OR receipt.investor_name LIKE @search OR receipt.investor_id LIKE @search OR receipt.pan LIKE @search)')
      bindVars.search = searchTerm
    }

    if (req.user.role === 'employee') {
      filterConditions.push('receipt.user_id == @user_id')
      bindVars.user_id = String(req.user.sub)
    } else if (req.user.role === 'manager') {
      const userBranch = await getUserBranch(req.user.sub)
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizeBranchName(userBranch) || userBranch
      }
    } else if (req.user.role === 'branch') {
      const userBranch = req.user.branch_code || req.user.branch
      const branchIdentifiers = await getBranchIdentifiersForFilter(userBranch)
      if (branchIdentifiers.length > 0) {
        filterConditions.push('receipt.branch IN @branchIdentifiers')
        bindVars.branchIdentifiers = branchIdentifiers
      } else if (userBranch) {
        filterConditions.push('receipt.branch == @branch')
        bindVars.branch = normalizeBranchName(userBranch) || userBranch
      }
    } else if (emp_code) {
      // Admin viewing personal / emp filter: match list to dashboard (user_id OR emp_code)
      if (req.user.role === 'admin' && req.user.emp_code === emp_code) {
        filterConditions.push('(receipt.user_id == @user_id OR receipt.emp_code == @emp_code)')
        bindVars.user_id = String(req.user.sub)
        bindVars.emp_code = emp_code
      } else {
        filterConditions.push('receipt.emp_code == @emp_code')
        bindVars.emp_code = emp_code
      }
    }

    // only admins can include deleted
    if (!(req.user.role === 'admin' && includeDeleted === '1')) {
      filterConditions.push('receipt.is_deleted == false')
    }

    if (filterConditions.length > 0) {
      filterClause = `FILTER ${filterConditions.join(' AND ')}\n`
    }

    const query = `
      FOR receipt IN receipts
      ${filterClause}
      SORT ${orderExpr} ${sortDir}
      LIMIT ${numOffset}, ${numLimit}
      RETURN MERGE(receipt, {
        media_count: LENGTH(receipt.files || [])
      })
    `

    const countQuery = `
      FOR receipt IN receipts
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])

    const total = totalResult[0] || 0

    const sanitized = rows.map((r) => normalizeReceiptCategory(stripSIForNonAdmin(req.user, withNormalizedDetails(r))))

    res.json({ page: numPage, size: numLimit, total, items: sanitized })
 
  } catch (err) {
    console.error('Error fetching receipts:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

// Get receipts by employee code
router.get('/emp/:empCode', requireAuth, async (req, res) => {
  try {
    const {
      from,
      to,
      category,
      status,
      mode,
      txn_type,
      issuer,
      search, // Search by investor name/ID or receipt ID
      page = '1',
      size = '20',
      sort = 'created_at:desc',
      includeDeleted = '0'
    } = req.query

    const requestedEmpCode = req.params.empCode
    const isAdmin = req.user.role === 'admin'
    const authedEmpCode = req.user.emp_code

    // Role guard: employees can only access their own emp_code
    if (!isAdmin && requestedEmpCode !== authedEmpCode) {
      return res.status(403).json({ error: 'forbidden' })
    }

    // Paging + sorting
    const p = Math.max(1, parseInt(page, 10) || 1)
    const s = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const [sortCol, sortDirRaw] = String(sort).split(':')
    const sortDir = String(sortDirRaw || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
    const allowedSort = new Set(['created_at', 'date', 'amount', 'receipt_no'])
    const orderBy = allowedSort.has(sortCol) ? sortCol : 'created_at'
    const effectiveAmountExpr = '((TO_NUMBER(receipt.transaction.amount) || 0) != 0 ? (TO_NUMBER(receipt.transaction.amount) || 0) : (receipt.product_details != null && receipt.product_details.fd != null && receipt.product_details.fd.deposit != null && receipt.product_details.fd.deposit.amount != null) ? (TO_NUMBER(receipt.product_details.fd.deposit.amount) || 0) : (TO_NUMBER(receipt.investment_amount) || 0) != 0 ? (TO_NUMBER(receipt.investment_amount) || 0) : (TO_NUMBER(receipt.fd_deposit_amount) || 0))'
    const orderExpr = orderBy === 'amount' ? effectiveAmountExpr : `receipt.${orderBy}`

    const numLimit = Math.min(200, Math.max(1, parseInt(size, 10) || 20))
    const numPage  = Math.max(1, parseInt(page, 10) || 1)
    const numOffset = (numPage - 1) * numLimit

    let filterClause = ''
    let bindVars = { emp_code: requestedEmpCode }
    let filterConditions = [
      '(receipt.emp_code == @emp_code OR (receipt.employee != null && receipt.employee.code == @emp_code))'
    ]

    // Safe date filter only if both are valid
    if (
      typeof from === 'string' && typeof to === 'string' &&
      from.trim() && to.trim() &&
      !isNaN(Date.parse(from.trim())) &&
      !isNaN(Date.parse(to.trim()))
    ) {
      filterConditions.push('receipt.date >= @from AND receipt.date <= @to')
      bindVars.from = from.trim()
      bindVars.to = to.trim()
    }

    applyReceiptCategoryFilter(filterConditions, bindVars, category)

    // Status filter
    if (status) {
      // Handle status filtering - treat null/undefined as 'Pending'
      if (status === 'Pending') {
        filterConditions.push('(receipt.status == null || receipt.status == @status)')
      } else {
        filterConditions.push('receipt.status == @status')
      }
      bindVars.status = status
    }

    applyMfTxnTypeOrModeFilter(filterConditions, bindVars, txn_type, mode)

    // Issuer filter (for issuer company)
    if (issuer) {
      filterConditions.push('receipt.issuer_company LIKE @issuer')
      bindVars.issuer = `%${issuer}%`
    }

    // Search filter (investor name, ID, PAN, or receipt number)
    if (search && search.trim().length > 0) {
      const searchTerm = `%${search.trim()}%`
      filterConditions.push('(receipt.receipt_no LIKE @search OR (receipt.investor != null && (receipt.investor.name LIKE @search OR receipt.investor.id LIKE @search OR receipt.investor.pan LIKE @search)) OR receipt.investor_name LIKE @search OR receipt.investor_id LIKE @search OR receipt.pan LIKE @search)')
      bindVars.search = searchTerm
    }

    // includeDeleted only for admins
    if (!(isAdmin && includeDeleted === '1')) {
      filterConditions.push('receipt.is_deleted == false')
    }

    filterClause = `FILTER ${filterConditions.join(' AND ')}\n`

    const query = `
      FOR receipt IN receipts
      ${filterClause}
      SORT ${orderExpr} ${sortDir}
      LIMIT ${numOffset}, ${numLimit}
      RETURN MERGE(receipt, {
        media_count: LENGTH(receipt.files || [])
      })
    `

    const countQuery = `
      FOR receipt IN receipts
      ${filterClause}
      COLLECT WITH COUNT INTO total
      RETURN total
    `
    
    // Create separate bindVars for count query (without limit/offset)
    const countBindVars = { ...bindVars }

    const [rows, totalResult] = await Promise.all([
      q(query, bindVars),
      q(countQuery, countBindVars)
    ])

    const total = totalResult[0] || 0

    const sanitized = rows.map((r) => normalizeReceiptCategory(stripSIForNonAdmin(req.user, withNormalizedDetails(r))))

    res.json({ page: numPage, size: numLimit, total, items: sanitized })
  } catch (err) {
    console.error('Error fetching receipts by emp_code:', err)
    res.status(500).json({ error: 'server_error', detail: err.message })
  }
})

// Get single receipt
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    
    // Get receipt with media count
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN MERGE(receipt, {
        media_count: LENGTH(receipt.files || [])
      })
    `, { id })
    
    if (!receiptRows.length) return res.status(404).json({ error: 'not_found' })
    
    const receipt = normalizeReceiptCategory(stripSIForNonAdmin(req.user, withNormalizedDetails(receiptRows[0])))
    
    // Get media files if requested
    const includeMedia = req.query.include_media === 'true'
    if (includeMedia) {
      try {
        if (receipt.files) {
          const filesData = receipt.files
          // Get user names for uploaded_by fields
          const userIds = [...new Set(filesData.map(f => f.uploaded_by))]
          const users = await q(`
            FOR user IN users
            FILTER user._key IN @userIds
            RETURN { id: user._key, name: user.name }
          `, { userIds })
          const userMap = users.reduce((acc, user) => {
            acc[user.id] = user.name
            return acc
          }, {})
          
          receipt.media_files = filesData.map(file => ({
            ...file,
            uploaded_by_name: userMap[file.uploaded_by] || 'Unknown'
          }))
        } else {
          receipt.media_files = []
        }
      } catch (parseError) {
        console.warn('Failed to parse files JSON:', parseError)
        receipt.media_files = []
      }
    }
    
    res.json(receipt)
  } catch (error) {
    console.error('Error fetching receipt:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Update receipt
router.patch('/:id', requireAuth, async (req, res) => {
  const id = req.params.id
  const own = await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    LIMIT 1
    RETURN { id: receipt._key, user_id: receipt.user_id, status: receipt.status, product_category: receipt.product_category, receipt }
  `, { id })
  if (!own.length) return res.status(404).json({ error: 'not_found' })
  
  const currentStatus = own[0].status || 'Pending'
  // Newer receipts store category under nested `product.category` (and may not have legacy `product_category`).
  // For edit-sync logic (FD deposit amount), resolve category from either location.
  const receiptProductCategory =
    own[0].product_category ??
    (own[0].receipt && typeof own[0].receipt === 'object' ? own[0].receipt.product?.category : null) ??
    null
  const existingReceipt = own[0].receipt || {}
  const isOwner = String(own[0].user_id) === String(req.user.sub)
  const isAdmin = req.user.role === 'admin'
  const isPending = currentStatus === 'Pending'
  
  // Allow editing if: admin, owner, OR status is Pending (all users can edit pending receipts)
  if (!(isAdmin || isOwner || isPending)) {
    return res.status(403).json({ error: 'forbidden', detail: 'Only admins, owners, or pending receipts can be edited' })
  }
  
  const allowed = [
    'date','branch','scheme_name','scheme_option','investment_amount','folio_policy_no','mode',
    'period_installments','installments_count','txn_type','from_text','to_text','units_or_amount',
    'fd_type','client_type','deposit_period_ym','roi_percent','interest_payable','interest_frequency',
    'instrument_type','instrument_no','instrument_date','bank_name','bank_branch','fdr_demat_policy',
    'renewal_due_date','maturity_amount','renewal_amount','issuer_company','issuer_category','product_category',
    'collection_credit','cc','service_income','si', // Allow manual updates to CC/SI if needed
    'switch_from_scheme_code','switch_from_scheme_name','switch_to_scheme_code','switch_to_scheme_name','switch_type','switch_value',
    'stp_target_scheme_name','stp_target_scheme_code',
    'transaction_details','entry_mode','transaction_channel','transaction_reference_no','txn_date','account_last4','transaction_notes',
    'insurance_date_of_issue','insurance_renewal_date','insurance_policy_period',
    'fd_maturity_date','bond_issue_date','bond_maturity_date','bond_tenure_months',
    'fd_transaction_type', // Fresh or Renewal for FD receipts
    'rejection_remark','rejected_at','rejected_by' // Rejection fields for failed transactions
  ]
  const d = req.body || {}
  const updates = {}
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(d, k)) {
      // `mode` is deprecated; ignore any client-sent updates to it.
      if (k === 'mode') continue
      updates[k] = d[k]
    }
  }

  // Enforce transaction-details immutability once status is not Pending
  if (currentStatus !== 'Pending') {
    const transactionKeys = [
      'mode','txn_type','from_text','to_text','units_or_amount',
      'instrument_type','instrument_no','instrument_date','bank_name','bank_branch',
      'transaction_details','entry_mode','transaction_channel','transaction_reference_no','txn_date','account_last4','transaction_notes'
    ]
    const attemptingTxnUpdate = transactionKeys.some(key => Object.prototype.hasOwnProperty.call(updates, key))
    if (attemptingTxnUpdate) {
      return res.status(400).json({
        error: 'transaction_locked',
        detail: 'Transaction details cannot be modified once the receipt status is not Pending'
      })
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no_updates' })

  // Keep nested structures in sync with edited flat fields so edits are visible everywhere.
  const hasOwn = (k) => Object.prototype.hasOwnProperty.call(d, k)

  if (hasOwn('investment_amount')) {
    const numericAmount = Number(d.investment_amount)
    updates.investment_amount = Number.isFinite(numericAmount) ? numericAmount : d.investment_amount
    const currentTxn = (existingReceipt.transaction && typeof existingReceipt.transaction === 'object') ? existingReceipt.transaction : {}
    updates.transaction = {
      ...currentTxn,
      amount: Number.isFinite(numericAmount) ? numericAmount : d.investment_amount
    }

    // FD receipts: keep nested FD deposit amount in sync.
    // Main views/records typically read `product_details.fd.deposit.amount` (-> `fd_deposit_amount` via normalizer),
    // while the edit modal updates `investment_amount`.
    const catUpper = String(receiptProductCategory || '').toUpperCase()
    const isFdReceipt =
      catUpper === 'FD' ||
      catUpper === 'GOVT_FD' ||
      (existingReceipt.product_details && typeof existingReceipt.product_details === 'object' && existingReceipt.product_details.fd != null)

    if (isFdReceipt) {
      const currentProductDetails = (existingReceipt.product_details && typeof existingReceipt.product_details === 'object')
        ? existingReceipt.product_details
        : {}
      const currentFd = (currentProductDetails.fd && typeof currentProductDetails.fd === 'object')
        ? currentProductDetails.fd
        : {}
      const currentDeposit = (currentFd.deposit && typeof currentFd.deposit === 'object')
        ? currentFd.deposit
        : {}

      const fdAmount = Number.isFinite(numericAmount) ? numericAmount : d.investment_amount
      updates.product_details = {
        ...currentProductDetails,
        fd: {
          ...currentFd,
          deposit: {
            ...currentDeposit,
            amount: fdAmount
          }
        }
      }

      // Also update legacy/flat consumers if they exist.
      updates.fd_deposit_amount = fdAmount

      // Invalidate cached PDF so next download reflects edited deposit amount.
      updates.pdf_data = null
    }
  }

  if (hasOwn('txn_type')) {
    const currentTxn = (updates.transaction && typeof updates.transaction === 'object')
      ? updates.transaction
      : ((existingReceipt.transaction && typeof existingReceipt.transaction === 'object') ? existingReceipt.transaction : {})
    updates.transaction = {
      ...currentTxn,
      type: d.txn_type ?? null
    }
  }

  if (hasOwn('stp_target_scheme_name') || hasOwn('stp_target_scheme_code')) {
    const baseTxn = (updates.transaction && typeof updates.transaction === 'object')
      ? updates.transaction
      : ((existingReceipt.transaction && typeof existingReceipt.transaction === 'object') ? existingReceipt.transaction : {})
    const stp = (baseTxn.stp && typeof baseTxn.stp === 'object') ? baseTxn.stp : {}
    updates.transaction = {
      ...baseTxn,
      stp: {
        ...stp,
        to_scheme_name: hasOwn('stp_target_scheme_name') ? (d.stp_target_scheme_name ?? null) : (stp.to_scheme_name ?? null),
        to_scheme_code: hasOwn('stp_target_scheme_code') ? (d.stp_target_scheme_code ?? null) : (stp.to_scheme_code ?? null)
      }
    }
  }

  if (hasOwn('scheme_name')) {
    const currentProduct = (existingReceipt.product && typeof existingReceipt.product === 'object') ? existingReceipt.product : {}
    updates.product = {
      ...currentProduct,
      name: d.scheme_name ?? null
    }
  }

  const paymentFieldTouched = [
    'entry_mode',
    'transaction_channel',
    'transaction_reference_no',
    'txn_date',
    'instrument_type',
    'instrument_no',
    'instrument_date',
    'bank_name',
    'bank_branch',
    'transaction_notes',
    'account_last4'
  ].some(hasOwn)

  if (paymentFieldTouched) {
    const currentPayment = (existingReceipt.payment && typeof existingReceipt.payment === 'object') ? existingReceipt.payment : {}
    const currentInstrument = (currentPayment.instrument && typeof currentPayment.instrument === 'object') ? currentPayment.instrument : {}
    const currentBank = (currentInstrument.bank && typeof currentInstrument.bank === 'object') ? currentInstrument.bank : {}

    updates.payment = {
      ...currentPayment,
      entry_mode: hasOwn('entry_mode') ? (d.entry_mode || null) : (currentPayment.entry_mode ?? null),
      channel: hasOwn('transaction_channel') ? (d.transaction_channel || null) : (currentPayment.channel ?? null),
      reference_no: hasOwn('transaction_reference_no') ? (d.transaction_reference_no || null) : (currentPayment.reference_no ?? null),
      transaction_date: hasOwn('txn_date') ? (d.txn_date || null) : (currentPayment.transaction_date ?? null),
      account_last4: hasOwn('account_last4') ? (d.account_last4 || null) : (currentPayment.account_last4 ?? null),
      notes: hasOwn('transaction_notes') ? (d.transaction_notes || null) : (currentPayment.notes ?? null),
      instrument: {
        ...currentInstrument,
        type: hasOwn('instrument_type') ? (d.instrument_type || null) : (currentInstrument.type ?? null),
        number: hasOwn('instrument_no') ? (d.instrument_no || null) : (currentInstrument.number ?? null),
        date: hasOwn('instrument_date') ? (d.instrument_date || null) : (currentInstrument.date ?? null),
        bank: {
          ...currentBank,
          name: hasOwn('bank_name') ? (d.bank_name || null) : (currentBank.name ?? null),
          branch: hasOwn('bank_branch') ? (d.bank_branch || null) : (currentBank.branch ?? null)
        }
      }
    }
  }

  if (hasOwn('insurance_renewal_date')) {
    // Keep legacy/common renewal field in sync for views that read renewal_due_date.
    updates.renewal_due_date = d.insurance_renewal_date || null
  }

  if (receiptProductCategory === 'INS' && (hasOwn('insurance_date_of_issue') || hasOwn('insurance_renewal_date') || hasOwn('insurance_policy_period'))) {
    const pd = { ...(existingReceipt.product_details && typeof existingReceipt.product_details === 'object' ? existingReceipt.product_details : {}) }
    const ins = { ...(pd.insurance && typeof pd.insurance === 'object' ? pd.insurance : {}) }
    const policy = { ...(ins.policy && typeof ins.policy === 'object' ? ins.policy : {}) }
    const coverage = { ...(ins.coverage && typeof ins.coverage === 'object' ? ins.coverage : {}) }
    if (hasOwn('insurance_date_of_issue')) coverage.policy_start_date = d.insurance_date_of_issue || null
    if (hasOwn('insurance_renewal_date')) policy.renewal_date = d.insurance_renewal_date || null
    if (hasOwn('insurance_policy_period')) {
      policy.period = d.insurance_policy_period || null
      const ny = Number(d.insurance_policy_period)
      if (Number.isFinite(ny) && String(d.insurance_policy_period).trim() !== '') coverage.policy_term_years = ny
    }
    pd.insurance = { ...ins, policy: { ...ins.policy, ...policy }, coverage: { ...ins.coverage, ...coverage } }
    updates.product_details = pd
  }

  if (hasOwn('fd_maturity_date')) {
    const currentFdDetails = (existingReceipt.fd_details && typeof existingReceipt.fd_details === 'object') ? existingReceipt.fd_details : {}
    updates.fd_details = {
      ...currentFdDetails,
      maturity_date: d.fd_maturity_date || null
    }
  }

  if (hasOwn('bond_issue_date') || hasOwn('bond_maturity_date')) {
    const currentBondDetails = (existingReceipt.bond_details && typeof existingReceipt.bond_details === 'object') ? existingReceipt.bond_details : {}
    updates.bond_details = {
      ...currentBondDetails,
      issue_date: hasOwn('bond_issue_date') ? (d.bond_issue_date || null) : (currentBondDetails.issue_date ?? null),
      maturity_date: hasOwn('bond_maturity_date') ? (d.bond_maturity_date || null) : (currentBondDetails.maturity_date ?? null)
    }
    if (hasOwn('bond_maturity_date')) {
      // Keep common renewal field aligned for legacy consumers.
      updates.renewal_due_date = d.bond_maturity_date || null
    }
  }

  if ((receiptProductCategory === 'BOND' || receiptProductCategory === 'NCD') && hasOwn('bond_tenure_months')) {
    const basePd =
      updates.product_details && typeof updates.product_details === 'object'
        ? updates.product_details
        : (existingReceipt.product_details && typeof existingReceipt.product_details === 'object'
          ? existingReceipt.product_details
          : {})
    const bond = { ...(basePd.bond && typeof basePd.bond === 'object' ? basePd.bond : {}) }
    const instrument = { ...(bond.instrument && typeof bond.instrument === 'object' ? bond.instrument : {}) }
    const tm = Number(d.bond_tenure_months)
    instrument.tenure_months = Number.isFinite(tm) ? tm : null
    updates.product_details = { ...basePd, bond: { ...bond, instrument: { ...instrument } } }
    updates.bond_tenure_months = Number.isFinite(tm) ? tm : null
    updates.pdf_data = null
  }
  
  await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    UPDATE receipt WITH @updates IN receipts
  `, { id, updates })
  res.status(204).end()
})

// Update receipt status
router.patch('/:id/status', requireAuth, async (req, res) => {
  try {
    const id = req.params.id
    const { status } = req.body || {}
    
    if (!status) {
      return res.status(400).json({ error: 'missing_status', detail: 'Status is required' })
    }
    
    // Validate status values
    const validStatuses = ['Pending', 'Completed', 'Cancelled', 'Failed']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'invalid_status', detail: `Status must be one of: ${validStatuses.join(', ')}` })
    }
    
    // Check if receipt exists and get ownership info
    const receiptRows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN { id: receipt._key, user_id: receipt.user_id, status: receipt.status }
    `, { id })
    
    if (!receiptRows.length) {
      return res.status(404).json({ error: 'not_found' })
    }
    
    const receipt = receiptRows[0]
    
    // Check permissions - only admin can update status
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden', detail: 'Only admin users can update receipt status' })
    }
    
    // Update the receipt status
    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH { 
        status: @status,
        status_updated_at: DATE_ISO8601(DATE_NOW()),
        status_updated_by: @user_id
      } IN receipts
    `, { id, status, user_id: req.user.sub })
    
    res.status(200).json({ 
      message: 'Status updated successfully',
      receipt_id: id,
      new_status: status
    })
    
  } catch (error) {
    console.error('Error updating receipt status:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Add or update additional CC/SI bonus on a receipt
router.put('/:id/bonus', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const id = req.params.id
    const { additional_cc = 0, additional_si = 0 } = req.body || {}

    // Load current receipt
    const rows = await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      LIMIT 1
      RETURN receipt
    `, { id })

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', detail: 'Receipt not found' })
    }

    const receipt = rows[0]

    // Derive base CC/SI amounts (excluding any existing additional bonus)
    const baseCC =
      (typeof receipt.total_cc === 'number' && receipt.total_cc !== 0)
        ? Number(receipt.total_cc)
        : (typeof receipt.cc_amount === 'number' && receipt.cc_amount !== 0)
          ? Number(receipt.cc_amount)
          : (receipt.collection_credit != null || receipt.cc != null)
            ? Number(receipt.collection_credit || receipt.cc || 0)
            : (receipt.calculations && (receipt.calculations.collection_credit != null || receipt.calculations.cc != null))
              ? Number(receipt.calculations.collection_credit || receipt.calculations.cc || 0)
              : 0

    const baseSI =
      (typeof receipt.total_si === 'number' && receipt.total_si !== 0)
        ? Number(receipt.total_si)
        : (typeof receipt.si_amount === 'number' && receipt.si_amount !== 0)
          ? Number(receipt.si_amount)
          : (receipt.service_income != null || receipt.si != null)
            ? Number(receipt.service_income || receipt.si || 0)
            : (receipt.calculations && (receipt.calculations.service_income != null || receipt.calculations.si != null))
              ? Number(receipt.calculations.service_income || receipt.calculations.si || 0)
              : 0

    const addCC = Number(additional_cc) || 0
    const addSI = Number(additional_si) || 0

    const updates = {
      additional_cc: addCC,
      additional_si: addSI,
      cc_amount: baseCC,
      si_amount: baseSI,
      total_cc: baseCC + addCC,
      total_si: baseSI + addSI
    }

    await q(`
      FOR receipt IN receipts
      FILTER receipt._key == @id
      UPDATE receipt WITH @updates IN receipts
      RETURN NEW
    `, { id, updates })

    res.status(200).json({ message: 'Bonus updated successfully', receipt_id: id, additional_cc: addCC, additional_si: addSI })
  } catch (error) {
    console.error('Error updating receipt bonus:', error)
    res.status(500).json({ error: 'server_error', detail: error.message })
  }
})

// Soft delete receipt
router.delete('/:id', requireAuth, async (req, res) => {
  const id = req.params.id
  const { reason = null } = req.body || {}
  const rows = await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    LIMIT 1
    RETURN { id: receipt._key, user_id: receipt.user_id }
  `, { id })
  if (!rows.length) return res.status(404).json({ error: 'not_found' })

  await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    UPDATE receipt WITH {
      is_deleted: true,
      deleted_at: DATE_NOW(),
      deleted_by: @deleted_by,
      delete_reason: @reason
    } IN receipts
  `, { id, deleted_by: req.user.sub, reason })
  res.status(204).end()
})

// Restore receipt (admin only)
router.post('/:id/restore', requireAuth, requireRole('admin'), async (req, res) => {
  const id = req.params.id
  await q(`
    FOR receipt IN receipts
    FILTER receipt._key == @id
    UPDATE receipt WITH {
      is_deleted: false,
      deleted_at: null,
      deleted_by: null,
      delete_reason: null
    } IN receipts
  `, { id })
  res.status(204).end()
})

export default router
