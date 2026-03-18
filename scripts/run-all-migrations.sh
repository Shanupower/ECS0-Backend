#!/usr/bin/env bash
#
# Run all DB-changing migration scripts in order for production.
# Uses .env (and optional .env.production) for DB connection.
#
# Usage:
#   cd /path/to/ECS0-Backend
#   RUN_PROD_MIGRATIONS=1 ./scripts/run-all-migrations.sh
#
# Optional: run with dry-run for migrations that support it (no actual writes):
#   DRY_RUN=1 RUN_PROD_MIGRATIONS=1 ./scripts/run-all-migrations.sh
#
# Post-migration verification (read-only, run separately if desired):
#   node scripts/verify-dashboard-stats.js
#   node scripts/verify-dashboard-totals.js
#

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SCRIPT_DIR="$ROOT/scripts"

# Safety: require explicit opt-in for production
if [[ "${RUN_PROD_MIGRATIONS}" != "1" ]]; then
  echo "Usage: RUN_PROD_MIGRATIONS=1 $0"
  echo "Set RUN_PROD_MIGRATIONS=1 to confirm you want to run migrations against the configured DB."
  exit 1
fi

# Optional: force dry-run for scripts that support it (migrate-branches, migrate-receipts-legacy-to-nested, fix-receipt-product-category)
DRY_RUN="${DRY_RUN:-0}"
if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  export DRY_RUN=1
  echo "--- DRY RUN: scripts that support DRY_RUN will not write ---"
fi

run() {
  local name="$1"
  local cmd="$2"
  echo ""
  echo "=============================================="
  echo "Running: $name"
  echo "=============================================="
  (cd "$ROOT" && eval "$cmd") || { echo "FAILED: $name"; exit 1; }
  echo "OK: $name"
}

# 1) AMCs: set amc_category and min_investment where missing
run "migrate-amcs-amc-category" "node scripts/migrate-amcs-amc-category.js"

# 2) MF schemes: add option field and variants (GROWTH, IDCW_PAYOUT, IDCW_REINVEST)
run "migrate-schemes-add-options" "node scripts/migrate-schemes-add-options.js"

# 3) Users: backfill branch_code from branch name (normalizeBranchName)
run "fix-branch-codes" "node scripts/fix-branch-codes.js"

# 4) Users: alternative branch_code backfill (branch_name / branch_code match)
run "fix-user-branch-codes" "node scripts/fix-user-branch-codes.js"

# 5) Branches: normalize user and customer branch fields to canonical branch codes (set DRY_RUN=false to apply)
if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  run "migrate-branches (dry run)" "DRY_RUN=true node scripts/migrate-branches.js"
else
  run "migrate-branches" "DRY_RUN=false node scripts/migrate-branches.js"
fi

# 6) Receipts: normalize receipt.branch to canonical branch key
run "normalize-receipt-branches" "node scripts/normalize-receipt-branches.js"

# 7) Receipts: legacy flat structure → nested product/investor/transaction
if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  run "migrate-receipts-legacy-to-nested (dry run)" "DRY_RUN=1 node scripts/migrate-receipts-legacy-to-nested.js"
else
  run "migrate-receipts-legacy-to-nested" "node scripts/migrate-receipts-legacy-to-nested.js"
fi

# 8) Receipts: backfill product.category (and transaction.amount) where missing
if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  run "fix-receipt-product-category (dry run)" "DRY_RUN=1 node scripts/fix-receipt-product-category.js"
else
  run "fix-receipt-product-category" "node scripts/fix-receipt-product-category.js"
fi

# 9) FD issuers: copy scheme-level CC/SI to every rate slab
run "sync-fd-slab-cc-si" "node scripts/sync-fd-slab-cc-si.js"

echo ""
echo "=============================================="
echo "All migrations completed successfully."
echo "=============================================="
echo "Optional verification (read-only):"
echo "  node scripts/verify-dashboard-stats.js"
echo "  node scripts/verify-dashboard-totals.js"
echo "  node scripts/branch-customer-counts.js"
