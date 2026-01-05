import { Database } from 'arangojs'

console.log('📥 Populating Insurance Schemes data...\n')

// Database connection
const ARANGO_URL = 'https://db.ecsfinancial.tech'
const ARANGO_USERNAME = 'root'
const ARANGO_PASSWORD = ''
const ARANGO_DATABASE = 'ecs_backend'

console.log(`Connecting to: ${ARANGO_URL}/${ARANGO_DATABASE}`)

const db = new Database({
  url: ARANGO_URL,
  auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
  databaseName: ARANGO_DATABASE
})

// Comprehensive insurance data for major Indian insurance companies
const insuranceIssuers = [
  // ============================================
  // LIFE INSURANCE COMPANIES
  // ============================================
  
  {
    _key: 'lic_of_india',
    legal_name: 'Life Insurance Corporation of India',
    short_name: 'LIC',
    type: 'Life',
    license_number: 'LIC001',
    is_active: true,
    products: [
      {
        product_id: 'lic_jeevan_amar',
        product_name: 'New Jeevan Amar',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance plan with high sum assured at affordable premiums',
        policy_types: ['Term'],
        min_sum_assured: 2500000,
        max_sum_assured: null,
        min_premium: 5000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year', 'Pre-existing conditions'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 98.31
        },
        riders: [
          {
            rider_id: 'lic_ja_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional sum assured in case of accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.5,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'lic_ja_critical_illness',
            rider_name: 'Critical Illness Rider',
            description: 'Coverage for specified critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 5000000,
            rider_premium_percentage: 1.2,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          },
          {
            rider_id: 'lic_ja_waiver_premium',
            rider_name: 'Waiver of Premium',
            description: 'Waives future premiums in case of disability',
            rider_type: 'Waiver of Premium',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 0.3,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.5,
        si: 1.5,
        is_active: true,
        launch_date: '2020-01-01',
        withdrawal_date: null
      },
      {
        product_id: 'lic_jeevan_anand',
        product_name: 'Jeevan Anand',
        category: 'Life',
        sub_category: 'Endowment Plan',
        description: 'Endowment plan with life cover and maturity benefit',
        policy_types: ['Endowment'],
        min_sum_assured: 100000,
        max_sum_assured: null,
        min_premium: 3000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 50,
        policy_term_years_min: 15,
        policy_term_years_max: 35,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 15,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit + Maturity Benefit',
          additional_coverage: 'Accidental Death Benefit',
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 98.31
        },
        riders: [
          {
            rider_id: 'lic_ja_accidental_benefit',
            rider_name: 'Accidental Death and Disability Benefit',
            description: 'Additional coverage for accidental death and disability',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.4,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 3.0,
        si: 2.0,
        is_active: true,
        launch_date: '2014-01-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'hdfc_life',
    legal_name: 'HDFC Life Insurance Company Limited',
    short_name: 'HDFC Life',
    type: 'Life',
    license_number: 'HL001',
    is_active: true,
    products: [
      {
        product_id: 'hdfc_click2protect_super',
        product_name: 'Click 2 Protect Super',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Comprehensive term insurance plan with flexible options',
        policy_types: ['Term'],
        min_sum_assured: 5000000,
        max_sum_assured: null,
        min_premium: 8000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Single'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: 'Terminal Illness Benefit',
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 98.19
        },
        riders: [
          {
            rider_id: 'hdfc_c2ps_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 1000000,
            max_sum_assured: 20000000,
            rider_premium_percentage: 0.4,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'hdfc_c2ps_disability',
            rider_name: 'Disability Rider',
            description: 'Monthly income in case of disability',
            rider_type: 'Disability',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 0.8,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 60',
            is_active: true
          },
          {
            rider_id: 'hdfc_c2ps_critical_illness',
            rider_name: 'Critical Illness Cover',
            description: 'Coverage for critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 5000000,
            rider_premium_percentage: 1.0,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 3.0,
        si: 2.0,
        is_active: true,
        launch_date: '2019-06-01',
        withdrawal_date: null
      },
      {
        product_id: 'hdfc_sanchay_plus',
        product_name: 'Sanchay Plus',
        category: 'Life',
        sub_category: 'Savings Plan',
        description: 'Unit linked savings plan with life cover',
        policy_types: ['ULIP'],
        min_sum_assured: 1000000,
        max_sum_assured: null,
        min_premium: 12000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 30,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 25,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit + Investment Returns',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.8
        },
        riders: [
          {
            rider_id: 'hdfc_sp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.3,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 4.0,
        si: 3.0,
        is_active: true,
        launch_date: '2021-01-15',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'sbi_life',
    legal_name: 'SBI Life Insurance Company Limited',
    short_name: 'SBI Life',
    type: 'Life',
    license_number: 'SL001',
    is_active: true,
    products: [
      {
        product_id: 'sbi_smart_shield',
        product_name: 'Smart Shield',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Affordable term insurance with comprehensive coverage',
        policy_types: ['Term'],
        min_sum_assured: 1000000,
        max_sum_assured: null,
        min_premium: 3000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 5,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.85
        },
        riders: [
          {
            rider_id: 'sbi_ss_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional sum assured for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.5,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'sbi_ss_critical_illness',
            rider_name: 'Critical Illness Rider',
            description: 'Coverage for critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 3000000,
            rider_premium_percentage: 1.1,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.0,
        si: 1.2,
        is_active: true,
        launch_date: '2021-03-15',
        withdrawal_date: null
      },
      {
        product_id: 'sbi_smart_wealth_builder',
        product_name: 'Smart Wealth Builder',
        category: 'Life',
        sub_category: 'Investment Plan',
        description: 'Unit linked plan for wealth creation with life cover',
        policy_types: ['ULIP'],
        min_sum_assured: 500000,
        max_sum_assured: null,
        min_premium: 10000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 30,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 25,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit + Investment Returns',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.5
        },
        riders: [],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 3.5,
        si: 2.5,
        is_active: true,
        launch_date: '2020-08-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'icici_pru_life',
    legal_name: 'ICICI Prudential Life Insurance Company Limited',
    short_name: 'ICICI Prudential Life',
    type: 'Life',
    license_number: 'IP001',
    is_active: true,
    products: [
      {
        product_id: 'icici_iprotect_smart',
        product_name: 'ICICI Pru iProtect Smart',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with return of premium option',
        policy_types: ['Term'],
        min_sum_assured: 5000000,
        max_sum_assured: null,
        min_premium: 10000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: 'Return of Premium Option',
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.92
        },
        riders: [
          {
            rider_id: 'icici_ips_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 1000000,
            max_sum_assured: 15000000,
            rider_premium_percentage: 0.4,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'icici_ips_critical_illness',
            rider_name: 'Critical Illness Cover',
            description: 'Coverage for critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 5000000,
            rider_premium_percentage: 1.0,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          },
          {
            rider_id: 'icici_ips_waiver_premium',
            rider_name: 'Waiver of Premium',
            description: 'Waives future premiums in case of disability',
            rider_type: 'Waiver of Premium',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 0.25,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 3.5,
        si: 2.5,
        is_active: true,
        launch_date: '2020-09-01',
        withdrawal_date: null
      },
      {
        product_id: 'icici_pru_wealth_builder',
        product_name: 'ICICI Pru Wealth Builder',
        category: 'Life',
        sub_category: 'Investment Plan',
        description: 'Unit linked plan for long-term wealth creation',
        policy_types: ['ULIP'],
        min_sum_assured: 1000000,
        max_sum_assured: null,
        min_premium: 12000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 30,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 25,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit + Investment Returns',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.6
        },
        riders: [],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 4.5,
        si: 3.5,
        is_active: true,
        launch_date: '2019-11-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'max_life',
    legal_name: 'Max Life Insurance Company Limited',
    short_name: 'Max Life',
    type: 'Life',
    license_number: 'ML001',
    is_active: true,
    products: [
      {
        product_id: 'max_life_online_term_plus',
        product_name: 'Online Term Plan Plus',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Pure term insurance plan with high coverage',
        policy_types: ['Term'],
        min_sum_assured: 5000000,
        max_sum_assured: null,
        min_premium: 7000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 10,
        premium_payment_term_max: 40,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 98.02
        },
        riders: [
          {
            rider_id: 'max_otp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 1000000,
            max_sum_assured: 20000000,
            rider_premium_percentage: 0.35,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'max_otp_critical_illness',
            rider_name: 'Critical Illness Rider',
            description: 'Coverage for critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 5000000,
            rider_premium_percentage: 0.9,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.8,
        si: 1.8,
        is_active: true,
        launch_date: '2021-05-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'bajaj_allianz_life',
    legal_name: 'Bajaj Allianz Life Insurance Company Limited',
    short_name: 'Bajaj Allianz Life',
    type: 'Life',
    license_number: 'BAL001',
    is_active: true,
    products: [
      {
        product_id: 'bajaj_allianz_term_care',
        product_name: 'Term Care',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with comprehensive coverage',
        policy_types: ['Term'],
        min_sum_assured: 3000000,
        max_sum_assured: null,
        min_premium: 6000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.4
        },
        riders: [
          {
            rider_id: 'bajaj_tc_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.45,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.5,
        si: 1.5,
        is_active: true,
        launch_date: '2020-02-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'kotak_life',
    legal_name: 'Kotak Mahindra Life Insurance Company Limited',
    short_name: 'Kotak Life',
    type: 'Life',
    license_number: 'KL001',
    is_active: true,
    products: [
      {
        product_id: 'kotak_term_plan',
        product_name: 'Kotak Term Plan',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Affordable term insurance plan',
        policy_types: ['Term'],
        min_sum_assured: 2000000,
        max_sum_assured: null,
        min_premium: 5000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.2
        },
        riders: [
          {
            rider_id: 'kotak_tp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 8000000,
            rider_premium_percentage: 0.5,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.2,
        si: 1.3,
        is_active: true,
        launch_date: '2021-01-01',
        withdrawal_date: null
      }
    ]
  },
  
  // ============================================
  // HEALTH INSURANCE COMPANIES
  // ============================================
  
  {
    _key: 'star_health',
    legal_name: 'Star Health and Allied Insurance Company Limited',
    short_name: 'Star Health',
    type: 'Health',
    license_number: 'SH001',
    is_active: true,
    products: [
      {
        product_id: 'star_medi_classic',
        product_name: 'Medi Classic',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Comprehensive health insurance with cashless facility',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 10000000,
        min_premium: 8000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care Procedures, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)', 'Cosmetic surgery'],
          waiting_period_days: 90,
          renewability: 'Renewable',
          claim_settlement_ratio: 92.25
        },
        riders: [
          {
            rider_id: 'star_mc_hospital_cash',
            rider_name: 'Hospital Cash Benefit',
            description: 'Daily cash benefit during hospitalization',
            rider_type: 'Hospital Cash',
            min_sum_assured: 1000,
            max_sum_assured: 5000,
            rider_premium_percentage: null,
            rider_premium_fixed: 2000,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'star_mc_opd_coverage',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses coverage',
            rider_type: 'OPD Coverage',
            min_sum_assured: 10000,
            max_sum_assured: 50000,
            rider_premium_percentage: 15,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'star_mc_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 20,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.0,
        si: 3.0,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      },
      {
        product_id: 'star_travel_protect',
        product_name: 'Star Travel Protect',
        category: 'Health',
        sub_category: 'Travel Plans',
        description: 'Travel insurance for domestic and international trips',
        policy_types: ['Travel'],
        min_sum_assured: 50000,
        max_sum_assured: 5000000,
        min_premium: 500,
        max_premium: 50000,
        min_entry_age: 0,
        max_entry_age: 80,
        policy_term_years_min: 0.083,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Single'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Premiums',
        coverage_details: {
          base_coverage: 'Medical Expenses, Trip Cancellation',
          additional_coverage: 'Baggage Loss, Flight Delay',
          exclusions: ['Pre-existing conditions', 'Extreme sports'],
          waiting_period_days: 0,
          renewability: 'Non-renewable',
          claim_settlement_ratio: 95.5
        },
        riders: [
          {
            rider_id: 'star_tp_personal_accident',
            rider_name: 'Personal Accident',
            description: 'Additional personal accident coverage',
            rider_type: 'Personal Accident',
            min_sum_assured: 100000,
            max_sum_assured: 1000000,
            rider_premium_percentage: 10,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: [],
        cc: 5.0,
        si: 4.0,
        is_active: true,
        launch_date: '2019-05-01',
        withdrawal_date: null
      },
      {
        product_id: 'star_comprehensive',
        product_name: 'Star Comprehensive',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Comprehensive health insurance with no room rent limit',
        policy_types: ['Health'],
        min_sum_assured: 500000,
        max_sum_assured: 25000000,
        min_premium: 12000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'No Room Rent Limit, Day Care',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 93.1
        },
        riders: [
          {
            rider_id: 'star_comp_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 100000,
            max_sum_assured: 300000,
            rider_premium_percentage: 25,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.5,
        si: 3.5,
        is_active: true,
        launch_date: '2020-03-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'hdfc_ergo',
    legal_name: 'HDFC ERGO General Insurance Company Limited',
    short_name: 'HDFC ERGO',
    type: 'Health',
    license_number: 'HE001',
    is_active: true,
    products: [
      {
        product_id: 'hdfc_ergo_optima_restore',
        product_name: 'Optima Restore',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with restore benefit',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 50000000,
        min_premium: 10000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Restore Benefit, Day Care',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.12
        },
        riders: [
          {
            rider_id: 'hdfc_ergo_or_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 20,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          },
          {
            rider_id: 'hdfc_ergo_or_opd',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses',
            rider_type: 'OPD Coverage',
            min_sum_assured: 20000,
            max_sum_assured: 100000,
            rider_premium_percentage: 18,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.5,
        si: 3.5,
        is_active: true,
        launch_date: '2020-03-01',
        withdrawal_date: null
      },
      {
        product_id: 'hdfc_ergo_my_health_suraksha',
        product_name: 'My Health Suraksha',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with comprehensive coverage',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 30000000,
        min_premium: 9500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 93.8
        },
        riders: [
          {
            rider_id: 'hdfc_mhs_opd',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses',
            rider_type: 'OPD Coverage',
            min_sum_assured: 20000,
            max_sum_assured: 100000,
            rider_premium_percentage: 18,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.3,
        si: 3.3,
        is_active: true,
        launch_date: '2021-06-01',
        withdrawal_date: null
      },
      {
        product_id: 'hdfc_ergo_travel_explorer',
        product_name: 'Travel Explorer',
        category: 'Health',
        sub_category: 'Travel Plans',
        description: 'Comprehensive travel insurance',
        policy_types: ['Travel'],
        min_sum_assured: 100000,
        max_sum_assured: 10000000,
        min_premium: 1000,
        max_premium: 100000,
        min_entry_age: 0,
        max_entry_age: 80,
        policy_term_years_min: 0.083,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Single'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Premiums',
        coverage_details: {
          base_coverage: 'Medical Expenses, Trip Cancellation',
          additional_coverage: 'Baggage, Personal Liability',
          exclusions: ['Pre-existing conditions'],
          waiting_period_days: 0,
          renewability: 'Non-renewable',
          claim_settlement_ratio: 96.8
        },
        riders: [
          {
            rider_id: 'hdfc_ergo_te_personal_accident',
            rider_name: 'Personal Accident',
            description: 'Additional personal accident coverage',
            rider_type: 'Personal Accident',
            min_sum_assured: 200000,
            max_sum_assured: 2000000,
            rider_premium_percentage: 12,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: [],
        cc: 5.5,
        si: 4.5,
        is_active: true,
        launch_date: '2021-01-15',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'icici_lombard',
    legal_name: 'ICICI Lombard General Insurance Company Limited',
    short_name: 'ICICI Lombard',
    type: 'General',
    license_number: 'IL001',
    is_active: true,
    products: [
      {
        product_id: 'icici_lombard_elevate',
        product_name: 'Elevate',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with comprehensive coverage',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 10000000,
        min_premium: 9000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 93.45
        },
        riders: [
          {
            rider_id: 'icici_elevate_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 22,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.0,
        si: 3.0,
        is_active: true,
        launch_date: '2019-08-01',
        withdrawal_date: null
      },
      {
        product_id: 'icici_lombard_health_advantage',
        product_name: 'Health Advantage',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with advantage benefits',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 15000000,
        min_premium: 11000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.2
        },
        riders: [
          {
            rider_id: 'icici_ha_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 60000,
            max_sum_assured: 200000,
            rider_premium_percentage: 22,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.2,
        si: 3.2,
        is_active: true,
        launch_date: '2020-09-01',
        withdrawal_date: null
      },
      {
        product_id: 'icici_lombard_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance for cars and bikes',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident, Zero Depreciation',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 91.5
        },
        riders: [
          {
            rider_id: 'icici_motor_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover for own damage',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 15,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          },
          {
            rider_id: 'icici_motor_engine_protect',
            rider_name: 'Engine Protect',
            description: 'Coverage for engine and gearbox damage',
            rider_type: 'Engine Protect',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 10,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all vehicles',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 6.0,
        si: 5.0,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      },
      {
        product_id: 'icici_lombard_motor_comprehensive',
        product_name: 'Motor Comprehensive',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance with additional benefits',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident, Zero Depreciation, Engine Protect',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 92.1
        },
        riders: [
          {
            rider_id: 'icici_mc_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover for own damage',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 15,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          },
          {
            rider_id: 'icici_mc_engine_protect',
            rider_name: 'Engine Protect',
            description: 'Coverage for engine and gearbox damage',
            rider_type: 'Engine Protect',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 10,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all vehicles',
            is_active: true
          },
          {
            rider_id: 'icici_mc_roadside_assistance',
            rider_name: 'Roadside Assistance',
            description: '24/7 roadside assistance coverage',
            rider_type: 'Roadside Assistance',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: null,
            rider_premium_fixed: 1500,
            eligibility_criteria: 'Available for all vehicles',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 6.5,
        si: 5.5,
        is_active: true,
        launch_date: '2020-01-15',
        withdrawal_date: null
      },
      {
        product_id: 'icici_lombard_travel',
        product_name: 'Travel Insurance',
        category: 'Health',
        sub_category: 'Travel Plans',
        description: 'Travel insurance for domestic and international trips',
        policy_types: ['Travel'],
        min_sum_assured: 50000,
        max_sum_assured: 5000000,
        min_premium: 600,
        max_premium: 80000,
        min_entry_age: 0,
        max_entry_age: 80,
        policy_term_years_min: 0.083,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Single'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Premiums',
        coverage_details: {
          base_coverage: 'Medical Expenses, Trip Cancellation',
          additional_coverage: 'Baggage Loss, Flight Delay',
          exclusions: ['Pre-existing conditions'],
          waiting_period_days: 0,
          renewability: 'Non-renewable',
          claim_settlement_ratio: 95.2
        },
        riders: [
          {
            rider_id: 'icici_travel_adventure',
            rider_name: 'Adventure Sports Cover',
            description: 'Coverage for adventure sports activities',
            rider_type: 'Adventure Sports',
            min_sum_assured: 100000,
            max_sum_assured: 500000,
            rider_premium_percentage: 20,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: [],
        cc: 5.0,
        si: 4.0,
        is_active: true,
        launch_date: '2020-06-01',
        withdrawal_date: null
      },
      {
        product_id: 'icici_lombard_travel_plus',
        product_name: 'Travel Plus',
        category: 'Health',
        sub_category: 'Travel Plans',
        description: 'Premium travel insurance with enhanced coverage',
        policy_types: ['Travel'],
        min_sum_assured: 100000,
        max_sum_assured: 10000000,
        min_premium: 1200,
        max_premium: 120000,
        min_entry_age: 0,
        max_entry_age: 80,
        policy_term_years_min: 0.083,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Single'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Premiums',
        coverage_details: {
          base_coverage: 'Medical Expenses, Trip Cancellation',
          additional_coverage: 'Baggage Loss, Flight Delay, Personal Liability',
          exclusions: ['Pre-existing conditions'],
          waiting_period_days: 0,
          renewability: 'Non-renewable',
          claim_settlement_ratio: 96.5
        },
        riders: [
          {
            rider_id: 'icici_travel_plus_adventure',
            rider_name: 'Adventure Sports Cover',
            description: 'Coverage for adventure sports activities',
            rider_type: 'Adventure Sports',
            min_sum_assured: 100000,
            max_sum_assured: 500000,
            rider_premium_percentage: 20,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'icici_travel_plus_baggage',
            rider_name: 'Enhanced Baggage Cover',
            description: 'Enhanced coverage for baggage loss',
            rider_type: 'Baggage',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 8,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: [],
        cc: 5.5,
        si: 4.5,
        is_active: true,
        launch_date: '2021-03-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'sbi_general',
    legal_name: 'SBI General Insurance Company Limited',
    short_name: 'SBI General',
    type: 'General',
    license_number: 'SG001',
    is_active: true,
    products: [
      {
        product_id: 'sbi_general_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident Cover',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 90.8
        },
        riders: [
          {
            rider_id: 'sbi_motor_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 18,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.5,
        si: 4.5,
        is_active: true,
        launch_date: '2018-03-01',
        withdrawal_date: null
      },
      {
        product_id: 'sbi_general_health',
        product_name: 'SBI General Health',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance plan',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 10000000,
        min_premium: 9200,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 92.5
        },
        riders: [
          {
            rider_id: 'sbi_gh_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 20,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.1,
        si: 3.1,
        is_active: true,
        launch_date: '2019-07-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'bajaj_allianz_general',
    legal_name: 'Bajaj Allianz General Insurance Company Limited',
    short_name: 'Bajaj Allianz',
    type: 'General',
    license_number: 'BAG001',
    is_active: true,
    products: [
      {
        product_id: 'bajaj_allianz_health_guard',
        product_name: 'Health Guard',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Comprehensive health insurance plan',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 50000000,
        min_premium: 11000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.5
        },
        riders: [
          {
            rider_id: 'bajaj_hg_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 75000,
            max_sum_assured: 250000,
            rider_premium_percentage: 23,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.2,
        si: 3.2,
        is_active: true,
        launch_date: '2020-04-01',
        withdrawal_date: null
      },
      {
        product_id: 'bajaj_allianz_health_advantage',
        product_name: 'Health Advantage',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with advantage features',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 30000000,
        min_premium: 10800,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.7
        },
        riders: [
          {
            rider_id: 'bajaj_ha_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 75000,
            max_sum_assured: 250000,
            rider_premium_percentage: 23,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          },
          {
            rider_id: 'bajaj_ha_opd',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses',
            rider_type: 'OPD Coverage',
            min_sum_assured: 15000,
            max_sum_assured: 60000,
            rider_premium_percentage: 16,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.6,
        si: 3.6,
        is_active: true,
        launch_date: '2021-02-01',
        withdrawal_date: null
      },
      {
        product_id: 'bajaj_allianz_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance for all vehicles',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2200,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident, Zero Depreciation',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 92.1
        },
        riders: [
          {
            rider_id: 'bajaj_motor_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 16,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.8,
        si: 4.8,
        is_active: true,
        launch_date: '2018-02-01',
        withdrawal_date: null
      },
      {
        product_id: 'bajaj_allianz_motor_comprehensive',
        product_name: 'Motor Comprehensive',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance with enhanced coverage',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2800,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident, Zero Depreciation, Engine Protect',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 93.2
        },
        riders: [
          {
            rider_id: 'bajaj_mc_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 16,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          },
          {
            rider_id: 'bajaj_mc_engine_protect',
            rider_name: 'Engine Protect',
            description: 'Coverage for engine and gearbox damage',
            rider_type: 'Engine Protect',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 11,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all vehicles',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 6.2,
        si: 5.2,
        is_active: true,
        launch_date: '2020-05-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'aditya_birla_health',
    legal_name: 'Aditya Birla Health Insurance Company Limited',
    short_name: 'Aditya Birla Health',
    type: 'Health',
    license_number: 'ABH001',
    is_active: true,
    products: [
      {
        product_id: 'aditya_birla_activ_health',
        product_name: 'Activ Health',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with wellness benefits',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 50000000,
        min_premium: 9500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Wellness Benefits, Day Care',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 93.8
        },
        riders: [
          {
            rider_id: 'ab_ah_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 60000,
            max_sum_assured: 200000,
            rider_premium_percentage: 21,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.3,
        si: 3.3,
        is_active: true,
        launch_date: '2019-09-01',
        withdrawal_date: null
      },
      {
        product_id: 'aditya_birla_activ_health_enhanced',
        product_name: 'Activ Health Enhanced',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Enhanced health insurance with wellness benefits',
        policy_types: ['Health'],
        min_sum_assured: 500000,
        max_sum_assured: 50000000,
        min_premium: 13000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Wellness Benefits, Day Care, No Room Rent Limit',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.5
        },
        riders: [
          {
            rider_id: 'ab_ahe_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 60000,
            max_sum_assured: 200000,
            rider_premium_percentage: 21,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          },
          {
            rider_id: 'ab_ahe_opd',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses',
            rider_type: 'OPD Coverage',
            min_sum_assured: 25000,
            max_sum_assured: 100000,
            rider_premium_percentage: 19,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.8,
        si: 3.8,
        is_active: true,
        launch_date: '2021-08-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'new_india_assurance',
    legal_name: 'The New India Assurance Company Limited',
    short_name: 'New India Assurance',
    type: 'General',
    license_number: 'NIA001',
    is_active: true,
    products: [
      {
        product_id: 'new_india_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2300,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 89.5
        },
        riders: [],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.0,
        si: 4.0,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'united_india',
    legal_name: 'United India Insurance Company Limited',
    short_name: 'United India',
    type: 'General',
    license_number: 'UI001',
    is_active: true,
    products: [
      {
        product_id: 'united_india_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2400,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 88.9
        },
        riders: [],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 4.8,
        si: 3.8,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'oriental_insurance',
    legal_name: 'The Oriental Insurance Company Limited',
    short_name: 'Oriental Insurance',
    type: 'General',
    license_number: 'OI001',
    is_active: true,
    products: [
      {
        product_id: 'oriental_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2350,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 89.2
        },
        riders: [],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 4.9,
        si: 3.9,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'tata_aia_life',
    legal_name: 'Tata AIA Life Insurance Company Limited',
    short_name: 'Tata AIA Life',
    type: 'Life',
    license_number: 'TAL001',
    is_active: true,
    products: [
      {
        product_id: 'tata_aia_sampoorna_raksha',
        product_name: 'Sampoorna Raksha',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with comprehensive coverage',
        policy_types: ['Term'],
        min_sum_assured: 3000000,
        max_sum_assured: null,
        min_premium: 7500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.7
        },
        riders: [
          {
            rider_id: 'tata_sr_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 12000000,
            rider_premium_percentage: 0.42,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'tata_sr_critical_illness',
            rider_name: 'Critical Illness Rider',
            description: 'Coverage for critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 4000000,
            rider_premium_percentage: 1.1,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.7,
        si: 1.7,
        is_active: true,
        launch_date: '2020-07-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'pnb_metlife',
    legal_name: 'PNB MetLife India Insurance Company Limited',
    short_name: 'PNB MetLife',
    type: 'Life',
    license_number: 'PM001',
    is_active: true,
    products: [
      {
        product_id: 'pnb_metlife_term_plan',
        product_name: 'PNB MetLife Term Plan',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Affordable term insurance plan',
        policy_types: ['Term'],
        min_sum_assured: 2000000,
        max_sum_assured: null,
        min_premium: 5500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 96.9
        },
        riders: [
          {
            rider_id: 'pnb_tp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 9000000,
            rider_premium_percentage: 0.48,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.3,
        si: 1.4,
        is_active: true,
        launch_date: '2021-02-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'reliance_nippon_life',
    legal_name: 'Reliance Nippon Life Insurance Company Limited',
    short_name: 'Reliance Nippon Life',
    type: 'Life',
    license_number: 'RNL001',
    is_active: true,
    products: [
      {
        product_id: 'reliance_nippon_term_plan',
        product_name: 'Reliance Term Plan',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with flexible options',
        policy_types: ['Term'],
        min_sum_assured: 2500000,
        max_sum_assured: null,
        min_premium: 6000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 96.5
        },
        riders: [
          {
            rider_id: 'reliance_tp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.46,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.4,
        si: 1.5,
        is_active: true,
        launch_date: '2020-11-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'reliance_general',
    legal_name: 'Reliance General Insurance Company Limited',
    short_name: 'Reliance General',
    type: 'General',
    license_number: 'RG001',
    is_active: true,
    products: [
      {
        product_id: 'reliance_general_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2100,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 91.2
        },
        riders: [
          {
            rider_id: 'reliance_motor_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 17,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.2,
        si: 4.2,
        is_active: true,
        launch_date: '2018-04-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'manipal_cigna',
    legal_name: 'ManipalCigna Health Insurance Company Limited',
    short_name: 'ManipalCigna',
    type: 'Health',
    license_number: 'MC001',
    is_active: true,
    products: [
      {
        product_id: 'manipal_cigna_prohealth',
        product_name: 'ProHealth',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Comprehensive health insurance plan',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 10000000,
        min_premium: 10000,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.8
        },
        riders: [
          {
            rider_id: 'manipal_ph_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 60000,
            max_sum_assured: 200000,
            rider_premium_percentage: 22,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          },
          {
            rider_id: 'manipal_ph_opd',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses',
            rider_type: 'OPD Coverage',
            min_sum_assured: 15000,
            max_sum_assured: 60000,
            rider_premium_percentage: 16,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.4,
        si: 3.4,
        is_active: true,
        launch_date: '2020-05-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'religare_health',
    legal_name: 'Religare Health Insurance Company Limited',
    short_name: 'Religare Health',
    type: 'Health',
    license_number: 'RH001',
    is_active: true,
    products: [
      {
        product_id: 'religare_care_health',
        product_name: 'Care Health',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Health insurance with comprehensive coverage',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 50000000,
        min_premium: 9800,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 93.6
        },
        riders: [
          {
            rider_id: 'religare_ch_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 50000,
            max_sum_assured: 200000,
            rider_premium_percentage: 21,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.1,
        si: 3.1,
        is_active: true,
        launch_date: '2019-10-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'future_generali',
    legal_name: 'Future Generali India Insurance Company Limited',
    short_name: 'Future Generali',
    type: 'General',
    license_number: 'FG001',
    is_active: true,
    products: [
      {
        product_id: 'future_generali_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2250,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 90.5
        },
        riders: [
          {
            rider_id: 'future_motor_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 19,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.3,
        si: 4.3,
        is_active: true,
        launch_date: '2018-06-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'royal_sundaram',
    legal_name: 'Royal Sundaram General Insurance Company Limited',
    short_name: 'Royal Sundaram',
    type: 'General',
    license_number: 'RS001',
    is_active: true,
    products: [
      {
        product_id: 'royal_sundaram_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2150,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 91.8
        },
        riders: [],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.1,
        si: 4.1,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'canara_hsbc_life',
    legal_name: 'Canara HSBC Oriental Bank of Commerce Life Insurance Company Limited',
    short_name: 'Canara HSBC Life',
    type: 'Life',
    license_number: 'CHL001',
    is_active: true,
    products: [
      {
        product_id: 'canara_hsbc_term_plan',
        product_name: 'Canara HSBC Term Plan',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with comprehensive coverage',
        policy_types: ['Term'],
        min_sum_assured: 2500000,
        max_sum_assured: null,
        min_premium: 6500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 97.1
        },
        riders: [
          {
            rider_id: 'canara_tp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 11000000,
            rider_premium_percentage: 0.44,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'canara_tp_critical_illness',
            rider_name: 'Critical Illness Rider',
            description: 'Coverage for critical illnesses',
            rider_type: 'Critical Illness',
            min_sum_assured: 500000,
            max_sum_assured: 4500000,
            rider_premium_percentage: 1.05,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available up to age 55',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.6,
        si: 1.6,
        is_active: true,
        launch_date: '2020-12-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'aegon_life',
    legal_name: 'Aegon Life Insurance Company Limited',
    short_name: 'Aegon Life',
    type: 'Life',
    license_number: 'AL001',
    is_active: true,
    products: [
      {
        product_id: 'aegon_term_plan',
        product_name: 'Aegon Term Plan',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with flexible options',
        policy_types: ['Term'],
        min_sum_assured: 2000000,
        max_sum_assured: null,
        min_premium: 5800,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 96.7
        },
        riders: [
          {
            rider_id: 'aegon_tp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 9500000,
            rider_premium_percentage: 0.47,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.4,
        si: 1.4,
        is_active: true,
        launch_date: '2021-04-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'aviva_life',
    legal_name: 'Aviva Life Insurance Company India Limited',
    short_name: 'Aviva Life',
    type: 'Life',
    license_number: 'AVL001',
    is_active: true,
    products: [
      {
        product_id: 'aviva_term_plan',
        product_name: 'Aviva Term Plan',
        category: 'Life',
        sub_category: 'Protection Plan',
        description: 'Term insurance with comprehensive coverage',
        policy_types: ['Term'],
        min_sum_assured: 2500000,
        max_sum_assured: null,
        min_premium: 6200,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 10,
        policy_term_years_max: 40,
        premium_payment_frequency: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly'],
        premium_payment_term_min: 5,
        premium_payment_term_max: 35,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Death Benefit',
          additional_coverage: null,
          exclusions: ['Suicide within first year'],
          waiting_period_days: 0,
          renewability: 'Term',
          claim_settlement_ratio: 96.8
        },
        riders: [
          {
            rider_id: 'aviva_tp_accidental_death',
            rider_name: 'Accidental Death Benefit',
            description: 'Additional coverage for accidental death',
            rider_type: 'Accidental Death',
            min_sum_assured: 500000,
            max_sum_assured: 10000000,
            rider_premium_percentage: 0.45,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'aviva_tp_waiver_premium',
            rider_name: 'Waiver of Premium',
            description: 'Waives future premiums in case of disability',
            rider_type: 'Waiver of Premium',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 0.28,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: true,
        nomination_allowed: true,
        tax_benefits: ['Section 80C'],
        cc: 2.5,
        si: 1.5,
        is_active: true,
        launch_date: '2020-10-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'niva_bupa',
    legal_name: 'Niva Bupa Health Insurance Company Limited',
    short_name: 'Niva Bupa',
    type: 'Health',
    license_number: 'NB001',
    is_active: true,
    products: [
      {
        product_id: 'niva_bupa_reassure',
        product_name: 'ReAssure',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Comprehensive health insurance with restore benefit',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 10000000,
        min_premium: 10500,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Restore Benefit, Day Care',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.3
        },
        riders: [
          {
            rider_id: 'niva_reassure_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 70000,
            max_sum_assured: 250000,
            rider_premium_percentage: 24,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          },
          {
            rider_id: 'niva_reassure_opd',
            rider_name: 'OPD Coverage',
            description: 'Outpatient department expenses',
            rider_type: 'OPD Coverage',
            min_sum_assured: 20000,
            max_sum_assured: 80000,
            rider_premium_percentage: 17,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          },
          {
            rider_id: 'niva_reassure_hospital_cash',
            rider_name: 'Hospital Cash Benefit',
            description: 'Daily cash benefit during hospitalization',
            rider_type: 'Hospital Cash',
            min_sum_assured: 1500,
            max_sum_assured: 6000,
            rider_premium_percentage: null,
            rider_premium_fixed: 2500,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.6,
        si: 3.6,
        is_active: true,
        launch_date: '2020-07-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'care_health',
    legal_name: 'Care Health Insurance Company Limited',
    short_name: 'Care Health',
    type: 'Health',
    license_number: 'CHI001',
    is_active: true,
    products: [
      {
        product_id: 'care_health_plan',
        product_name: 'Care Health Plan',
        category: 'Health',
        sub_category: 'Health Plans',
        description: 'Comprehensive health insurance plan',
        policy_types: ['Health'],
        min_sum_assured: 300000,
        max_sum_assured: 50000000,
        min_premium: 10200,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: 65,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Hospitalization Expenses',
          additional_coverage: 'Day Care, Pre/Post Hospitalization',
          exclusions: ['Pre-existing conditions (waiting period)'],
          waiting_period_days: 48,
          renewability: 'Renewable',
          claim_settlement_ratio: 94.0
        },
        riders: [
          {
            rider_id: 'care_hp_maternity',
            rider_name: 'Maternity Cover',
            description: 'Coverage for maternity expenses',
            rider_type: 'Maternity',
            min_sum_assured: 65000,
            max_sum_assured: 220000,
            rider_premium_percentage: 23,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for ages 18-45',
            is_active: true
          },
          {
            rider_id: 'care_hp_personal_accident',
            rider_name: 'Personal Accident Cover',
            description: 'Additional personal accident coverage',
            rider_type: 'Personal Accident',
            min_sum_assured: 100000,
            max_sum_assured: 500000,
            rider_premium_percentage: 8,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all ages',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: true,
        tax_benefits: ['Section 80D'],
        cc: 4.4,
        si: 3.4,
        is_active: true,
        launch_date: '2019-12-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'iffco_tokio',
    legal_name: 'IFFCO Tokio General Insurance Company Limited',
    short_name: 'IFFCO Tokio',
    type: 'General',
    license_number: 'IT001',
    is_active: true,
    products: [
      {
        product_id: 'iffco_tokio_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2200,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 90.3
        },
        riders: [
          {
            rider_id: 'iffco_motor_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 18,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          },
          {
            rider_id: 'iffco_motor_engine_protect',
            rider_name: 'Engine Protect',
            description: 'Coverage for engine and gearbox damage',
            rider_type: 'Engine Protect',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 11,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for all vehicles',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.2,
        si: 4.2,
        is_active: true,
        launch_date: '2018-05-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'liberty_general',
    legal_name: 'Liberty General Insurance Limited',
    short_name: 'Liberty General',
    type: 'General',
    license_number: 'LG001',
    is_active: true,
    products: [
      {
        product_id: 'liberty_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2300,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 89.7
        },
        riders: [],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 4.9,
        si: 3.9,
        is_active: true,
        launch_date: '2018-01-01',
        withdrawal_date: null
      }
    ]
  },
  {
    _key: 'tata_aig_general',
    legal_name: 'Tata AIG General Insurance Company Limited',
    short_name: 'Tata AIG General',
    type: 'General',
    license_number: 'TAG001',
    is_active: true,
    products: [
      {
        product_id: 'tata_aig_motor',
        product_name: 'Motor Insurance',
        category: 'General',
        sub_category: 'Vehicle Plans',
        description: 'Comprehensive motor insurance',
        policy_types: ['Vehicle'],
        min_sum_assured: null,
        max_sum_assured: null,
        min_premium: 2400,
        max_premium: null,
        min_entry_age: 18,
        max_entry_age: null,
        policy_term_years_min: 1,
        policy_term_years_max: 1,
        premium_payment_frequency: ['Yearly'],
        premium_payment_term_min: 1,
        premium_payment_term_max: 1,
        premium_payment_term_type: 'Years',
        coverage_details: {
          base_coverage: 'Third Party Liability, Own Damage',
          additional_coverage: 'Personal Accident, Zero Depreciation',
          exclusions: ['Wear and tear', 'Mechanical breakdown'],
          waiting_period_days: 0,
          renewability: 'Renewable',
          claim_settlement_ratio: 92.4
        },
        riders: [
          {
            rider_id: 'tata_aig_zero_dep',
            rider_name: 'Zero Depreciation',
            description: 'Zero depreciation cover',
            rider_type: 'Zero Depreciation',
            min_sum_assured: null,
            max_sum_assured: null,
            rider_premium_percentage: 16,
            rider_premium_fixed: null,
            eligibility_criteria: 'Available for vehicles up to 5 years',
            is_active: true
          }
        ],
        beneficiary_required: false,
        nomination_allowed: false,
        tax_benefits: [],
        cc: 5.4,
        si: 4.4,
        is_active: true,
        launch_date: '2018-03-01',
        withdrawal_date: null
      }
    ]
  }
]

async function populateInsuranceSchemes() {
  try {
    console.log('🔍 Checking insurance_issuers collection...')
    const collection = db.collection('insurance_issuers')
    
    try {
      await collection.load()
      console.log('✅ Collection exists')
    } catch (err) {
      console.log('📦 Creating insurance_issuers collection...')
      await collection.create()
      console.log('✅ Collection created')
    }
    
    // Truncate existing data
    console.log('🗑️  Clearing existing data...')
    await collection.truncate()
    console.log('✅ Existing data cleared')
    
    // Import all issuers with nested products and riders
    console.log('📥 Importing insurance issuers with products and riders...')
    const result = await collection.import(insuranceIssuers)
    const importedCount = result.created || result.imported || insuranceIssuers.length
    console.log(`✅ Imported: ${importedCount}/${insuranceIssuers.length} issuers`)
    
    // Calculate totals
    let totalProducts = 0
    let totalRiders = 0
    for (const issuer of insuranceIssuers) {
      totalProducts += issuer.products.length
      for (const product of issuer.products) {
        totalRiders += (product.riders || []).length
      }
    }
    
    console.log('\n✅ Population completed successfully!')
    console.log('📊 Summary:')
    console.log(`   - Total Issuers: ${importedCount}`)
    console.log(`   - Total Products: ${totalProducts}`)
    console.log(`   - Total Riders: ${totalRiders}`)
    
    // Breakdown by type
    const byType = {
      Life: { issuers: 0, products: 0 },
      Health: { issuers: 0, products: 0 },
      General: { issuers: 0, products: 0 }
    }
    
    for (const issuer of insuranceIssuers) {
      byType[issuer.type] = byType[issuer.type] || { issuers: 0, products: 0 }
      byType[issuer.type].issuers++
      byType[issuer.type].products += issuer.products.length
    }
    
    console.log('\n📈 Breakdown by type:')
    for (const [type, counts] of Object.entries(byType)) {
      if (counts.issuers > 0) {
        console.log(`   - ${type}: ${counts.issuers} issuers, ${counts.products} products`)
      }
    }
    
    // Breakdown by category
    const byCategory = {}
    for (const issuer of insuranceIssuers) {
      for (const product of issuer.products) {
        byCategory[product.category] = (byCategory[product.category] || 0) + 1
      }
    }
    
    console.log('\n📋 Breakdown by category:')
    for (const [category, count] of Object.entries(byCategory)) {
      console.log(`   - ${category}: ${count} products`)
    }
    
  } catch (error) {
    console.error('❌ Error during population:', error)
    process.exit(1)
  }
}

populateInsuranceSchemes()
