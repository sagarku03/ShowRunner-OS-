#!/usr/bin/env bash
set -euo pipefail

echo "============================================================"
echo "  ShowRunner OS v1.3.0 — Android Termux Environment Setup"
echo "============================================================"

if command -v pkg >/dev/null 2>&1; then
  pkg update -y && pkg upgrade -y
  pkg install -y nodejs-lts git sqlite python make clang termux-api
fi

echo ""
echo "[!] Android 12+ Phantom Process Killer Fix (Run once via ADB or Wireless Debugging):"
echo "    adb shell \"/system/bin/device_config set_sync_disabled_for_tests persistent\""
echo "    adb shell \"/system/bin/device_config put activity_manager max_phantom_processes 2147483647\""
echo "    adb shell settings put global settings_enable_monitor_phantom_procs false"
echo ""

SECRET_FILE="${HOME}/.showrunner_secret"
TOKEN_FILE="${HOME}/.showrunner_token"

if [ ! -f "${SECRET_FILE}" ]; then
  node -e "const crypto = require('node:crypto'); process.stdout.write(crypto.randomBytes(32).toString('hex'));" > "${SECRET_FILE}"
  chmod 600 "${SECRET_FILE}"
  echo "[+] Created AES-256-GCM master secret at ${SECRET_FILE} (0600)"
fi

if [ ! -f "${TOKEN_FILE}" ]; then
  node -e "const crypto = require('node:crypto'); process.stdout.write(crypto.randomBytes(32).toString('hex'));" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  echo "[+] Created local Bearer token at ${TOKEN_FILE} (0600)"
fi

mkdir -p database
npm install --no-audit --no-fund

if [ -f "dist/index.html" ]; then
  echo "[+] Pre-built production bundle found in dist/ — skipping Vite build on Android ARM64"
else
  npm run build
fi

echo "============================================================"
echo "  Setup Complete! Start ShowRunner OS with: ./scripts/start.sh"
echo "============================================================"
