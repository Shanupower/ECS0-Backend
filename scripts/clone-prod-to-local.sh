#!/usr/bin/env bash
#
# Clone prod ArangoDB (ecs_backend) -> local (ecs_backend_clones) using
# arangodump/arangorestore that live inside the already-running local
# 'arangodb-local' Docker container.
#
# Prereqs:
#   - Docker Desktop running
#   - Container 'arangodb-local' up (image: arangodb:3.11)
#   - The container has a bind-mount from host:/Users/admin/ecs-backup-20250310
#     to /dump (so dump files persist on the host)
#
# Usage:
#   scripts/clone-prod-to-local.sh
#
# Env overrides:
#   PROD_URL (default ssl://db.ecsfinancial.tech:443)
#   PROD_DB  (default ecs_backend)
#   PROD_USER / PROD_PASSWORD (defaults root / empty)
#   LOCAL_URL (default tcp://localhost:8529 — inside container)
#   LOCAL_DB  (default ecs_backend_clones)
#   LOCAL_USER / LOCAL_PASSWORD (defaults root / empty)
#   CONTAINER (default arangodb-local)
#
# Behaviour:
#   1. Dumps prod -> /dump/prod-clone-<timestamp> (persists on host)
#   2. Creates local DB if missing
#   3. Restores dump into local DB with --overwrite (drops + re-imports collections)

set -euo pipefail

PROD_URL="${PROD_URL:-ssl://db.ecsfinancial.tech:443}"
PROD_DB="${PROD_DB:-ecs_backend}"
PROD_USER="${PROD_USER:-root}"
PROD_PASSWORD="${PROD_PASSWORD:-}"

LOCAL_URL="${LOCAL_URL:-tcp://localhost:8529}"
LOCAL_DB="${LOCAL_DB:-ecs_backend_clones}"
LOCAL_USER="${LOCAL_USER:-root}"
LOCAL_PASSWORD="${LOCAL_PASSWORD:-}"

CONTAINER="${CONTAINER:-arangodb-local}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_DIR="/dump/prod-clone-${STAMP}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[clone] ERROR: container '${CONTAINER}' is not running." >&2
  exit 1
fi

echo "[clone] Target: ${CONTAINER}"
echo "[clone] Prod  : ${PROD_URL}/${PROD_DB} (user=${PROD_USER})"
echo "[clone] Local : ${LOCAL_URL}/${LOCAL_DB} (user=${LOCAL_USER})"
echo "[clone] Dump  : ${DUMP_DIR} (in container — host path: /Users/admin/ecs-backup-20250310/prod-clone-${STAMP})"
echo

echo "[clone] 1/3 Dumping prod -> ${DUMP_DIR}"
docker exec "${CONTAINER}" arangodump \
  --server.endpoint "${PROD_URL}" \
  --server.database "${PROD_DB}" \
  --server.username "${PROD_USER}" \
  --server.password "${PROD_PASSWORD}" \
  --output-directory "${DUMP_DIR}" \
  --overwrite true \
  --include-system-collections false \
  --compress-output true

echo
echo "[clone] 2/3 Ensuring local database '${LOCAL_DB}' exists"
docker exec "${CONTAINER}" arangosh \
  --server.endpoint "${LOCAL_URL}" \
  --server.username "${LOCAL_USER}" \
  --server.password "${LOCAL_PASSWORD}" \
  --server.database _system \
  --javascript.execute-string "try { db._createDatabase('${LOCAL_DB}'); print('created ${LOCAL_DB}'); } catch(e) { if (e.errorNum === 1207) { print('${LOCAL_DB} already exists'); } else { throw e; } }"

echo
echo "[clone] 3/3 Restoring dump -> ${LOCAL_DB}"
docker exec "${CONTAINER}" arangorestore \
  --server.endpoint "${LOCAL_URL}" \
  --server.database "${LOCAL_DB}" \
  --server.username "${LOCAL_USER}" \
  --server.password "${LOCAL_PASSWORD}" \
  --input-directory "${DUMP_DIR}" \
  --create-database false \
  --overwrite true \
  --include-system-collections false

echo
echo "[clone] Done."
echo "[clone] Dump kept at host: /Users/admin/ecs-backup-20250310/prod-clone-${STAMP}"
echo "[clone] Next: run 'node setup-arangodb.js' to ensure new collections + indexes."
