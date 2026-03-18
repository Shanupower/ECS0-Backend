/**
 * Migrate receipts from legacy (flat / mf_details / fd_details) structure to current nested structure.
 * Backfills product, investor, transaction, product_details from top-level and legacy nested fields.
 * Safe to run multiple times (merges into existing nested, does not overwrite when already set).
 *
 * Run: node scripts/migrate-receipts-legacy-to-nested.js
 * Dry run: DRY_RUN=1 node scripts/migrate-receipts-legacy-to-nested.js
 * Limit: LIMIT=500 node scripts/migrate-receipts-legacy-to-nested.js
 */

import 'dotenv/config'
import { q, getCollection } from '../config/database.js'

const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const LIMIT = Math.min(10000, Math.max(1, parseInt(process.env.LIMIT, 10) || 5000))

function needsMigration(receipt) {
  const hasProductCategory = receipt.product_category != null && String(receipt.product_category).trim() !== ''
  const hasNestedProduct = receipt.product && typeof receipt.product === 'object' && receipt.product.category != null && String(receipt.product.category).trim() !== ''
  const hasNestedInvestor = receipt.investor && typeof receipt.investor === 'object' && receipt.investor.id != null
  const hasFlatInvestor = receipt.investor_id != null || receipt.investor_name != null
  const hasNestedTransaction = receipt.transaction && typeof receipt.transaction === 'object' && receipt.transaction.amount != null
  const hasFlatAmount = receipt.investment_amount != null || receipt.fd_deposit_amount != null || receipt.service_price != null

  if (hasNestedProduct && hasNestedInvestor && hasNestedTransaction) return false
  if (!hasProductCategory && !hasFlatInvestor && !hasFlatAmount) return false
  return true
}

function buildProduct(receipt) {
  const existing = receipt.product && typeof receipt.product === 'object' ? receipt.product : {}
  const cat = receipt.product_category ?? existing.category ?? null
  const name = receipt.scheme_name ?? receipt.schemeName ?? receipt.fd_scheme_name ?? receipt.service_name ?? receipt.serviceName ?? existing.name ?? null
  const option = receipt.scheme_option ?? receipt.schemeOption ?? existing.option ?? null
  const folio = receipt.folio_number ?? receipt.folioNumber ?? existing.folio_number ?? null
  return {
    ...existing,
    category: cat ?? existing.category,
    name: name ?? existing.name,
    option: option ?? existing.option,
    folio_number: folio ?? existing.folio_number,
    has_existing_folio: existing.has_existing_folio
  }
}

function buildInvestor(receipt) {
  const existing = receipt.investor && typeof receipt.investor === 'object' ? receipt.investor : {}
  const addressStr = receipt.investor_address ?? receipt.investorAddress ?? ''
  const addressParts = (typeof addressStr === 'string' ? addressStr.split('\n') : []).filter(Boolean)
  return {
    ...existing,
    id: receipt.investor_id ?? existing.id,
    name: receipt.investor_name ?? existing.name,
    address: {
      ...(existing.address && typeof existing.address === 'object' ? existing.address : {}),
      line1: addressParts[0] ?? existing.address?.line1 ?? receipt.address_line1 ?? null,
      line2: addressParts[1] ?? existing.address?.line2 ?? receipt.address_line2 ?? null,
      line3: addressParts[2] ?? existing.address?.line3 ?? receipt.address_line3 ?? null,
      city: receipt.city ?? existing.address?.city ?? null,
      state: receipt.state ?? existing.address?.state ?? null,
      pin_code: receipt.pin_code ?? receipt.pinCode ?? existing.address?.pin_code ?? null,
      country: existing.address?.country ?? 'India'
    },
    pan: receipt.pan ?? existing.pan ?? null,
    email: receipt.email ?? existing.email ?? null,
    mobile: receipt.mobile ?? existing.mobile ?? receipt.phone ?? null
  }
}

function buildTransaction(receipt) {
  const existing = receipt.transaction && typeof receipt.transaction === 'object' ? receipt.transaction : {}
  const cat = receipt.product_category ?? receipt.product?.category
  let amount = receipt.investment_amount ?? receipt.transaction?.amount
  if (amount == null && (cat === 'FD' || receipt.fd_deposit_amount != null)) amount = receipt.fd_deposit_amount
  if (amount == null && (cat === 'MISC' || receipt.service_price != null)) amount = receipt.service_price
  if (amount != null) amount = Number(amount)
  return {
    ...existing,
    amount: amount ?? existing.amount,
    type: receipt.txn_type ?? receipt.transaction_type ?? existing.type ?? 'Fresh',
    mode: receipt.mode ?? existing.mode ?? null,
    date: receipt.date ?? existing.date ?? null,
    from_text: receipt.from_text ?? receipt.from ?? existing.from_text ?? null,
    to_text: receipt.to_text ?? receipt.to ?? existing.to_text ?? null,
    units_or_amount: receipt.units_or_amount ?? existing.units_or_amount ?? null,
    period_installments: receipt.period_installments ?? existing.period_installments ?? null,
    installments_count: receipt.installments_count ?? existing.installments_count ?? null
  }
}

function buildProductDetails(receipt) {
  const existing = receipt.product_details && typeof receipt.product_details === 'object' ? receipt.product_details : {}
  const cat = receipt.product_category ?? receipt.product?.category

  if (cat === 'MF') {
    const mfLegacy = receipt.mf_details && typeof receipt.mf_details === 'object' ? receipt.mf_details : {}
    existing.mf = {
      ...(existing.mf && typeof existing.mf === 'object' ? existing.mf : {}),
      amc: {
        code: receipt.amc_code ?? mfLegacy.amc_code ?? existing.mf?.amc?.code ?? null,
        name: receipt.amc_name ?? mfLegacy.amc_name ?? existing.mf?.amc?.name ?? null
      },
      scheme: {
        code: receipt.scheme_code ?? mfLegacy.scheme_code ?? existing.mf?.scheme?.code ?? null,
        name: receipt.scheme_name ?? receipt.schemeName ?? mfLegacy.scheme_name ?? existing.mf?.scheme?.name ?? null,
        category: receipt.scheme_category ?? mfLegacy.category ?? existing.mf?.scheme?.category ?? null,
        sub_category: receipt.scheme_sub_category ?? mfLegacy.sub_category ?? existing.mf?.scheme?.sub_category ?? null,
        plan: receipt.scheme_plan ?? mfLegacy.plan ?? existing.mf?.scheme?.plan ?? null,
        type: receipt.scheme_type ?? mfLegacy.type ?? existing.mf?.scheme?.type ?? null,
        is_nfo: receipt.scheme_is_nfo ?? mfLegacy.is_nfo ?? existing.mf?.scheme?.is_nfo ?? false
      }
    }
  }

  if (cat === 'FD') {
    const fdLegacy = receipt.fd_details && typeof receipt.fd_details === 'object' ? receipt.fd_details : {}
    existing.fd = {
      ...(existing.fd && typeof existing.fd === 'object' ? existing.fd : {}),
      issuer: {
        key: receipt.fd_issuer_key ?? fdLegacy.issuer_key ?? existing.fd?.issuer?.key ?? null,
        name: receipt.fd_issuer_name ?? fdLegacy.issuer_name ?? existing.fd?.issuer?.name ?? null,
        type: receipt.fd_issuer_type ?? fdLegacy.issuer_type ?? existing.fd?.issuer?.type ?? null
      },
      scheme: {
        id: receipt.fd_scheme_id ?? fdLegacy.scheme_id ?? existing.fd?.scheme?.id ?? null,
        name: receipt.fd_scheme_name ?? fdLegacy.scheme_name ?? existing.fd?.scheme?.name ?? null,
        is_cumulative: receipt.fd_is_cumulative ?? fdLegacy.is_cumulative ?? existing.fd?.scheme?.is_cumulative ?? false
      },
      deposit: {
        amount: receipt.fd_deposit_amount ?? fdLegacy.deposit_amount ?? existing.fd?.deposit?.amount ?? null,
        tenure_months: receipt.fd_tenure_months ?? fdLegacy.tenure_months ?? existing.fd?.deposit?.tenure_months ?? null,
        payout_frequency: receipt.fd_payout_frequency ?? fdLegacy.payout_frequency ?? existing.fd?.deposit?.payout_frequency ?? null,
        deposit_date: receipt.fd_deposit_date ?? fdLegacy.deposit_date ?? existing.fd?.deposit?.deposit_date ?? null
      },
      rates: {
        base_rate_pa: receipt.fd_base_rate_pa ?? fdLegacy.base_rate_pa ?? existing.fd?.rates?.base_rate_pa ?? null,
        total_rate_pa: receipt.fd_total_rate_pa ?? fdLegacy.total_rate_pa ?? existing.fd?.rates?.total_rate_pa ?? null
      },
      maturity: {
        amount: receipt.fd_maturity_amount ?? fdLegacy.maturity_amount ?? existing.fd?.maturity?.amount ?? null,
        date: receipt.fd_maturity_date ?? fdLegacy.maturity_date ?? existing.fd?.maturity?.date ?? null
      },
      application: {
        number: receipt.fd_application_number ?? fdLegacy.application_number ?? existing.fd?.application?.number ?? null,
        transaction_type: receipt.fd_transaction_type ?? fdLegacy.transaction_type ?? 'Fresh'
      }
    }
  }

  if (cat === 'INS') {
    existing.insurance = existing.insurance || {}
    existing.insurance.issuer = {
      key: receipt.insurance_issuer_key ?? existing.insurance?.issuer?.key ?? null,
      name: receipt.issuer_company ?? existing.insurance?.issuer?.name ?? null
    }
    existing.insurance.policy = existing.insurance.policy || {}
    existing.insurance.policy.premium_amount = receipt.investment_amount ?? receipt.transaction?.amount ?? existing.insurance?.policy?.premium_amount ?? null
  }

  if (cat === 'MISC') {
    existing.misc = {
      service_name: receipt.service_name ?? receipt.serviceName ?? existing.misc?.service_name ?? null,
      service_price: receipt.service_price ?? receipt.servicePrice ?? existing.misc?.service_price ?? null
    }
  }

  if (cat === 'BOND' || cat === 'NCD') {
    existing.bond = existing.bond || {}
    existing.bond.issuer = {
      key: receipt.bond_issuer_key ?? existing.bond?.issuer?.key ?? null,
      name: receipt.bond_issuer_name ?? receipt.issuer_company ?? existing.bond?.issuer?.name ?? null
    }
    existing.bond.transaction = existing.bond.transaction || {}
    existing.bond.transaction.amount = receipt.bond_investment_amount ?? receipt.investment_amount ?? existing.bond?.transaction?.amount ?? null
  }

  return existing
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN (no writes)\n' : 'Migrate legacy receipts to nested structure\n')
  console.log('Limit:', LIMIT)

  const rows = await q(`
    FOR receipt IN receipts
      FILTER receipt.is_deleted != true
      LIMIT ${LIMIT}
      RETURN receipt
  `)

  const toMigrate = rows.filter(needsMigration)
  if (!toMigrate.length) {
    console.log('No receipts need migration.')
    return
  }

  console.log(`Found ${toMigrate.length} receipt(s) to migrate.\n`)
  const coll = getCollection('receipts')
  let updated = 0

  for (const r of toMigrate) {
    const product = buildProduct(r)
    const investor = buildInvestor(r)
    const transaction = buildTransaction(r)
    const product_details = buildProductDetails(r)

    const updates = {}
    const needsProduct = (r.product == null || (r.product.category == null && product.category != null)) && (product.category != null || product.name != null)
    const needsInvestor = (r.investor == null || (r.investor.id == null && investor.id != null)) && (investor.id != null || investor.name != null)
    const needsTransaction = (r.transaction == null || (r.transaction.amount == null && transaction.amount != null)) && (transaction.amount != null || transaction.type != null)
    if (needsProduct) updates.product = product
    if (needsInvestor) updates.investor = investor
    if (needsTransaction) updates.transaction = transaction
    if (Object.keys(product_details).length > 0 && (r.product_details == null || Object.keys(r.product_details).length === 0)) updates.product_details = product_details

    if (Object.keys(updates).length === 0) continue

    console.log(`  ${r.receipt_no} (${r._key}) → product.category=${product.category}, investor.id=${investor.id || '(none)'}, transaction.amount=${transaction.amount != null ? transaction.amount : '(none)'}`)

    if (!DRY_RUN) {
      await coll.update(r._key, updates)
      updated++
    }
  }

  if (DRY_RUN) {
    console.log(`\nWould migrate ${toMigrate.length} receipt(s). Run without DRY_RUN=1 to apply.`)
  } else {
    console.log(`\nMigrated ${updated} receipt(s).`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
