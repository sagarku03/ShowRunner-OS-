#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="${1:-.}"

MATCHES=$(grep -rnE "AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_-]{20,}" \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir=dist-server \
  --exclude-dir=.playwright-cli \
  --exclude="secret-scan.sh" \
  "${TARGET_DIR}" || true)

if [ -n "${MATCHES}" ]; then
  echo "[SECRET SCAN FAILED] Potential secret material detected:"
  echo "${MATCHES}"
  exit 1
fi

echo "SECRET_SCAN_CLEAN (PASS)"
