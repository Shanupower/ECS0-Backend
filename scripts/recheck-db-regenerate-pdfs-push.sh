#!/usr/bin/env bash
#
# Recheck everything we have done to the DB, regenerate receipt PDFs, and push to origin.
# Run from ECS0-Backend directory or as ./scripts/recheck-db-regenerate-pdfs-push.sh
#
# Usage:
#   cd /path/to/ECS0-Backend
#   ./scripts/recheck-db-regenerate-pdfs-push.sh
#
# Optional: run full migrations first (recommended after pulling new migrations):
#   RUN_PROD_MIGRATIONS=1 ./scripts/recheck-db-regenerate-pdfs-push.sh
#
# Requires: .env (and optional .env.production) for DB connection.
#

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo ""
echo "=============================================="
echo "Recheck DB, regenerate PDFs, push to origin"
echo "=============================================="

# 1) Optional: run all migrations (set RUN_PROD_MIGRATIONS=1 to enable)
if [[ "${RUN_PROD_MIGRATIONS}" == "1" ]]; then
  echo ""
  echo "--- Running all migrations ---"
  RUN_PROD_MIGRATIONS=1 ./scripts/run-all-migrations.sh
else
  echo ""
  echo "--- Skipping migrations (set RUN_PROD_MIGRATIONS=1 to run them) ---"
fi

# 2) Recheck DB: run verification scripts (read-only checks)
echo ""
echo "=============================================="
echo "Recheck: verify dashboard stats"
echo "=============================================="
(cd "$ROOT" && node scripts/verify-dashboard-stats.js) || { echo "WARNING: verify-dashboard-stats.js had issues"; }

echo ""
echo "=============================================="
echo "Recheck: verify dashboard totals"
echo "=============================================="
(cd "$ROOT" && node scripts/verify-dashboard-totals.js) || { echo "WARNING: verify-dashboard-totals.js had issues"; }

# 3) Regenerate all receipt PDFs
echo ""
echo "=============================================="
echo "Regenerating receipt PDFs"
echo "=============================================="
(cd "$ROOT" && npm run regenerate-pdfs) || { echo "FAILED: regenerate-pdfs"; exit 1; }

# 4) Commit any local changes and push current branch to origin
echo ""
echo "=============================================="
echo "Git: commit and push to origin"
echo "=============================================="
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)
if [[ -z "$BRANCH" ]]; then
  echo "Not a git repo or no branch; skipping push."
  exit 0
fi
git add -A
if git diff --staged --quiet 2>/dev/null; then
  echo "No file changes to commit."
else
  git commit -m "Recheck DB and regenerate PDFs"
fi
# Push current branch to origin (typically master or main)
git push origin "$BRANCH"
echo "Pushed to origin/$BRANCH."

echo ""
echo "=============================================="
echo "Done."
echo "=============================================="
