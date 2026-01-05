import 'dotenv/config'
import { Database } from 'arangojs'

const {
  ARANGO_URL = 'https://db.ecsfinancial.tech',
  ARANGO_USERNAME = 'root',
  ARANGO_PASSWORD = '',
  ARANGO_DATABASE = 'ecs_backend'
} = process.env

// Comprehensive list of NCD/Bond issuers and schemes based on public information
const ncdBondData = [
  // Government Bonds
  {
    issuer: {
      _key: 'rbi',
      legal_name: 'Reserve Bank of India',
      short_name: 'RBI',
      type: 'Government',
      credit_rating_agency: 'Sovereign',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'RBI-FRSB-2024',
          scheme_name: 'RBI Floating Rate Savings Bonds',
          isin: 'IN0020230010',
          description: 'Floating Rate Savings Bonds with interest linked to National Savings Certificate (NSC) rate',
          coupon_rate: 7.15,
          face_value: 1000,
          issue_date: '2024-01-01',
          maturity_date: '2027-01-01',
          is_variable_rate: true,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 1000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 7 years with penalty',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: 'Ongoing',
          is_active: true,
          cc: 0.5,
          si: 0.3
        }
      ]
    }
  },
  // Infrastructure Bonds - PFC
  {
    issuer: {
      _key: 'pfc',
      legal_name: 'Power Finance Corporation Limited',
      short_name: 'PFC',
      type: 'Government',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'PFC-54EC-SERIES-VIII',
          scheme_name: 'PFC 54EC Bonds Series VIII',
          isin: 'INE134E08001',
          description: 'Tax-saving infrastructure bonds under Section 54EC',
          coupon_rate: 5.75,
          face_value: 10000,
          issue_date: '2023-04-01',
          maturity_date: '2026-04-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Annual',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed - Lock-in for 3 years',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 0.75,
          si: 0.5
        }
      ]
    }
  },
  // Infrastructure Bonds - REC
  {
    issuer: {
      _key: 'rec',
      legal_name: 'Rural Electrification Corporation Limited',
      short_name: 'REC',
      type: 'Government',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'REC-54EC-SERIES-XVIII',
          scheme_name: 'REC 54EC Bonds Series XVIII',
          isin: 'INE020B08001',
          description: 'Tax-saving infrastructure bonds under Section 54EC',
          coupon_rate: 5.75,
          face_value: 10000,
          issue_date: '2023-05-01',
          maturity_date: '2026-05-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Annual',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed - Lock-in for 3 years',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 0.75,
          si: 0.5
        }
      ]
    }
  },
  // Housing Finance Companies
  {
    issuer: {
      _key: 'hdfc_housing',
      legal_name: 'HDFC Limited',
      short_name: 'HDFC',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'HDFC-NCD-2024-SERIES-I',
          scheme_name: 'HDFC NCD Series I 2024',
          isin: 'INE001A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 8.50,
          face_value: 1000,
          issue_date: '2024-03-01',
          maturity_date: '2027-03-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 1.0,
          si: 0.75
        },
        {
          scheme_id: 'HDFC-NCD-2024-SERIES-II',
          scheme_name: 'HDFC NCD Series II 2024',
          isin: 'INE001A08002',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 8.75,
          face_value: 1000,
          issue_date: '2024-06-01',
          maturity_date: '2029-06-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 1.0,
          si: 0.75
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'lic_housing',
      legal_name: 'LIC Housing Finance Limited',
      short_name: 'LIC Housing Finance',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'LICHF-NCD-2024-SERIES-A',
          scheme_name: 'LIC Housing Finance NCD Series A 2024',
          isin: 'INE115A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 8.25,
          face_value: 1000,
          issue_date: '2024-04-01',
          maturity_date: '2027-04-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹300 Crores',
          is_active: true,
          cc: 0.9,
          si: 0.7
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'indiabulls_housing',
      legal_name: 'Indiabulls Housing Finance Limited',
      short_name: 'Indiabulls Housing',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'IBHF-NCD-2024-SERIES-I',
          scheme_name: 'Indiabulls Housing Finance NCD Series I 2024',
          isin: 'INE148I08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.25,
          face_value: 1000,
          issue_date: '2024-05-01',
          maturity_date: '2027-05-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹200 Crores',
          is_active: true,
          cc: 1.2,
          si: 0.9
        }
      ]
    }
  },
  // NBFCs
  {
    issuer: {
      _key: 'edelweiss',
      legal_name: 'Edelweiss Financial Services Limited',
      short_name: 'Edelweiss',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'EDEL-NCD-2025-SERIES-I',
          scheme_name: 'Edelweiss NCD Series I 2025',
          isin: 'INE532F08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.50,
          face_value: 1000,
          issue_date: '2025-09-24',
          maturity_date: '2027-09-24',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Monthly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 12 months with penalty',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹300 Crores',
          is_active: true,
          cc: 1.3,
          si: 1.0
        },
        {
          scheme_id: 'EDEL-NCD-2025-SERIES-II',
          scheme_name: 'Edelweiss NCD Series II 2025',
          isin: 'INE532F08002',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 10.25,
          face_value: 1000,
          issue_date: '2025-09-24',
          maturity_date: '2030-09-24',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Monthly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 12 months with penalty',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹300 Crores',
          is_active: true,
          cc: 1.3,
          si: 1.0
        }
      ]
    }
  },
  // Infrastructure Companies
  {
    issuer: {
      _key: 'irfc',
      legal_name: 'Indian Railway Finance Corporation Limited',
      short_name: 'IRFC',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'IRFC-BOND-2024-SERIES-A',
          scheme_name: 'IRFC Bond Series A 2024',
          isin: 'INE053F08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.50,
          face_value: 1000,
          issue_date: '2024-02-01',
          maturity_date: '2029-02-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹1000 Crores',
          is_active: true,
          cc: 0.8,
          si: 0.6
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'nhai',
      legal_name: 'National Highways Authority of India',
      short_name: 'NHAI',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'NHAI-BOND-2024-SERIES-I',
          scheme_name: 'NHAI Bond Series I 2024',
          isin: 'INE906A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.25,
          face_value: 1000,
          issue_date: '2024-03-01',
          maturity_date: '2027-03-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 0.7,
          si: 0.5
        }
      ]
    }
  },
  // Corporate Bonds - Major Companies
  {
    issuer: {
      _key: 'tata_steel',
      legal_name: 'Tata Steel Limited',
      short_name: 'Tata Steel',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'TATASTEEL-BOND-2024-SERIES-I',
          scheme_name: 'Tata Steel Bond Series I 2024',
          isin: 'INE081A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 8.00,
          face_value: 1000,
          issue_date: '2024-04-01',
          maturity_date: '2027-04-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 1.1,
          si: 0.8
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'reliance',
      legal_name: 'Reliance Industries Limited',
      short_name: 'Reliance',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'RELIANCE-BOND-2024-SERIES-I',
          scheme_name: 'Reliance Bond Series I 2024',
          isin: 'INE002A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.75,
          face_value: 1000,
          issue_date: '2024-05-01',
          maturity_date: '2029-05-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹1000 Crores',
          is_active: true,
          cc: 0.9,
          si: 0.7
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'adani_enterprises',
      legal_name: 'Adani Enterprises Limited',
      short_name: 'Adani Enterprises',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'ADANI-NCD-2025-SERIES-I',
          scheme_name: 'Adani Enterprises NCD Series I 2025',
          isin: 'INE423A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.00,
          face_value: 1000,
          issue_date: '2025-07-09',
          maturity_date: '2028-07-09',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹300 Crores',
          is_active: true,
          cc: 1.4,
          si: 1.1
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'cesc',
      legal_name: 'CESC Limited',
      short_name: 'CESC',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'CESC-NCD-2025-SERIES-I',
          scheme_name: 'CESC NCD Series I 2025',
          isin: 'INE486A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 8.75,
          face_value: 1000,
          issue_date: '2025-09-24',
          maturity_date: '2028-09-24',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹200 Crores',
          is_active: true,
          cc: 1.2,
          si: 0.9
        }
      ]
    }
  },
  // More Housing Finance Companies
  {
    issuer: {
      _key: 'bajaj_housing',
      legal_name: 'Bajaj Housing Finance Limited',
      short_name: 'Bajaj Housing',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'BAJAHF-NCD-2024-SERIES-I',
          scheme_name: 'Bajaj Housing Finance NCD Series I 2024',
          isin: 'INE296I08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 8.50,
          face_value: 1000,
          issue_date: '2024-06-01',
          maturity_date: '2027-06-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹250 Crores',
          is_active: true,
          cc: 1.0,
          si: 0.75
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'piramal_housing',
      legal_name: 'Piramal Capital & Housing Finance Limited',
      short_name: 'Piramal Housing',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'PCHF-NCD-2024-SERIES-I',
          scheme_name: 'Piramal Housing Finance NCD Series I 2024',
          isin: 'INE140K08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.00,
          face_value: 1000,
          issue_date: '2024-07-01',
          maturity_date: '2027-07-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹200 Crores',
          is_active: true,
          cc: 1.2,
          si: 0.9
        }
      ]
    }
  },
  // More NBFCs
  {
    issuer: {
      _key: 'muthoot_finance',
      legal_name: 'Muthoot Finance Limited',
      short_name: 'Muthoot Finance',
      type: 'NCD',
      credit_rating_agency: 'CARE',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'MUTHOOT-NCD-2024-SERIES-I',
          scheme_name: 'Muthoot Finance NCD Series I 2024',
          isin: 'INE414G08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.25,
          face_value: 1000,
          issue_date: '2024-08-01',
          maturity_date: '2027-08-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Monthly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 12 months with penalty',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹300 Crores',
          is_active: true,
          cc: 1.3,
          si: 1.0
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'manappuram_finance',
      legal_name: 'Manappuram Finance Limited',
      short_name: 'Manappuram Finance',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'MANAPPURAM-NCD-2024-SERIES-I',
          scheme_name: 'Manappuram Finance NCD Series I 2024',
          isin: 'INE522D08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.50,
          face_value: 1000,
          issue_date: '2024-09-01',
          maturity_date: '2027-09-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Monthly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 12 months with penalty',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹250 Crores',
          is_active: true,
          cc: 1.3,
          si: 1.0
        }
      ]
    }
  },
  // More Infrastructure and PSU Bonds
  {
    issuer: {
      _key: 'nhb',
      legal_name: 'National Housing Bank',
      short_name: 'NHB',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'NHB-BOND-2024-SERIES-I',
          scheme_name: 'NHB Bond Series I 2024',
          isin: 'INE195A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.30,
          face_value: 1000,
          issue_date: '2024-03-15',
          maturity_date: '2027-03-15',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 0.75,
          si: 0.55
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'sbi',
      legal_name: 'State Bank of India',
      short_name: 'SBI',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'SBI-BOND-2024-SERIES-I',
          scheme_name: 'SBI Bond Series I 2024',
          isin: 'INE062A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.40,
          face_value: 1000,
          issue_date: '2024-04-10',
          maturity_date: '2029-04-10',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹1000 Crores',
          is_active: true,
          cc: 0.8,
          si: 0.6
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'icici_bank',
      legal_name: 'ICICI Bank Limited',
      short_name: 'ICICI Bank',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'ICICIBANK-BOND-2024-SERIES-I',
          scheme_name: 'ICICI Bank Bond Series I 2024',
          isin: 'INE090A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.45,
          face_value: 1000,
          issue_date: '2024-05-15',
          maturity_date: '2027-05-15',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹750 Crores',
          is_active: true,
          cc: 0.85,
          si: 0.65
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'axis_bank',
      legal_name: 'Axis Bank Limited',
      short_name: 'Axis Bank',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AAA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'AXISBANK-BOND-2024-SERIES-I',
          scheme_name: 'Axis Bank Bond Series I 2024',
          isin: 'INE238A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 7.50,
          face_value: 1000,
          issue_date: '2024-06-01',
          maturity_date: '2027-06-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AAA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹500 Crores',
          is_active: true,
          cc: 0.85,
          si: 0.65
        }
      ]
    }
  },
  // More Housing Finance
  {
    issuer: {
      _key: 'canfin_homes',
      legal_name: 'Can Fin Homes Limited',
      short_name: 'Can Fin Homes',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'CANFIN-NCD-2024-SERIES-I',
          scheme_name: 'Can Fin Homes NCD Series I 2024',
          isin: 'INE477A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 8.75,
          face_value: 1000,
          issue_date: '2024-07-15',
          maturity_date: '2027-07-15',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹150 Crores',
          is_active: true,
          cc: 1.1,
          si: 0.85
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'republic_housing',
      legal_name: 'Repco Home Finance Limited',
      short_name: 'Repco Home Finance',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'REPCO-NCD-2024-SERIES-I',
          scheme_name: 'Repco Home Finance NCD Series I 2024',
          isin: 'INE998A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.00,
          face_value: 1000,
          issue_date: '2024-08-01',
          maturity_date: '2027-08-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Quarterly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹100 Crores',
          is_active: true,
          cc: 1.15,
          si: 0.9
        }
      ]
    }
  },
  // More NBFCs
  {
    issuer: {
      _key: 'shriram_finance',
      legal_name: 'Shriram Finance Limited',
      short_name: 'Shriram Finance',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'SHRIRAM-NCD-2024-SERIES-I',
          scheme_name: 'Shriram Finance NCD Series I 2024',
          isin: 'INE721A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.25,
          face_value: 1000,
          issue_date: '2024-09-01',
          maturity_date: '2027-09-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Monthly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 12 months with penalty',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹400 Crores',
          is_active: true,
          cc: 1.25,
          si: 0.95
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'mahindra_finance',
      legal_name: 'Mahindra & Mahindra Financial Services Limited',
      short_name: 'Mahindra Finance',
      type: 'NCD',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'MAHINDRA-NCD-2024-SERIES-I',
          scheme_name: 'Mahindra Finance NCD Series I 2024',
          isin: 'INE774A08001',
          description: 'Secured, Rated, Listed, Redeemable Non-Convertible Debentures',
          coupon_rate: 9.00,
          face_value: 1000,
          issue_date: '2024-10-01',
          maturity_date: '2027-10-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Monthly',
          is_secured: true,
          early_redemption_allowed: true,
          early_redemption_terms: 'After 12 months with penalty',
          put_option_available: false,
          call_option_available: false,
          currency: 'INR',
          issue_size: '₹350 Crores',
          is_active: true,
          cc: 1.2,
          si: 0.9
        }
      ]
    }
  },
  // Corporate Bonds
  {
    issuer: {
      _key: 'tata_motors',
      legal_name: 'Tata Motors Limited',
      short_name: 'Tata Motors',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'TATAMOTORS-BOND-2024-SERIES-I',
          scheme_name: 'Tata Motors Bond Series I 2024',
          isin: 'INE155A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 8.25,
          face_value: 1000,
          issue_date: '2024-11-01',
          maturity_date: '2027-11-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹300 Crores',
          is_active: true,
          cc: 1.1,
          si: 0.8
        }
      ]
    }
  },
  {
    issuer: {
      _key: 'jsw_steel',
      legal_name: 'JSW Steel Limited',
      short_name: 'JSW Steel',
      type: 'Bond',
      credit_rating_agency: 'CRISIL',
      credit_rating: 'AA',
      is_active: true,
      schemes: [
        {
          scheme_id: 'JSWSTEEL-BOND-2024-SERIES-I',
          scheme_name: 'JSW Steel Bond Series I 2024',
          isin: 'INE019A08001',
          description: 'Secured, Rated, Listed, Redeemable Bonds',
          coupon_rate: 8.50,
          face_value: 1000,
          issue_date: '2024-12-01',
          maturity_date: '2027-12-01',
          is_variable_rate: false,
          listing_status: 'Listed',
          credit_rating: 'AA',
          min_investment: 10000,
          interest_payment_frequency: 'Half-Yearly',
          is_secured: true,
          early_redemption_allowed: false,
          early_redemption_terms: 'Not allowed before maturity',
          put_option_available: false,
          call_option_available: true,
          currency: 'INR',
          issue_size: '₹250 Crores',
          is_active: true,
          cc: 1.15,
          si: 0.85
        }
      ]
    }
  }
]

async function populateNCDBonds() {
  try {
    console.log('Populating NCD/Bond issuers and schemes...')
    console.log(`Connecting to: ${ARANGO_URL}/${ARANGO_DATABASE}`)
    
    const appDb = new Database({
      url: ARANGO_URL,
      auth: { username: ARANGO_USERNAME, password: ARANGO_PASSWORD },
      databaseName: ARANGO_DATABASE
    })
    
    const collection = appDb.collection('ncd_bond_issuers')
    
    let totalIssuers = 0
    let totalSchemes = 0
    
    for (const item of ncdBondData) {
      const issuer = item.issuer
      const issuerKey = issuer._key
      
      try {
        // Check if issuer already exists
        const existing = await collection.document(issuerKey).catch(() => null)
        
        if (existing) {
          console.log(`Issuer ${issuer.short_name} already exists, skipping...`)
          continue
        }
        
        // Save issuer with schemes
        await collection.save(issuer)
        totalIssuers++
        totalSchemes += issuer.schemes.length
        console.log(`✓ Added issuer: ${issuer.short_name} with ${issuer.schemes.length} scheme(s)`)
      } catch (error) {
        if (error.errorNum === 1210) {
          console.log(`Issuer ${issuer.short_name} already exists (unique constraint), skipping...`)
        } else {
          console.error(`Error adding issuer ${issuer.short_name}:`, error.message)
        }
      }
    }
    
    console.log('\n=== Population Summary ===')
    console.log(`Total issuers added: ${totalIssuers}`)
    console.log(`Total schemes added: ${totalSchemes}`)
    console.log('NCD/Bond population completed successfully!')
  } catch (error) {
    console.error('Error populating NCD/Bonds:', error)
    process.exit(1)
  }
}

populateNCDBonds()

