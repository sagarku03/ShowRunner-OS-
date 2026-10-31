#!/usr/bin/env bash
set -euo pipefail

PID_FILE=".showrunner.pid"

if [ -f "${PID_FILE}" ]; then
  TARGET_PID=$(cat "${PID_FILE}")
  if kill -0 "${TARGET_PID}" >/dev/null 2>&1; then
    kill "${TARGET_PID}"
    echo "[+] Stopped ShowRunner OS daemon (PID ${TARGET_PID})"
  else
    echo "[i] Process ${TARGET_PID} is not running"
  fi
  rm -f "${PID_FILE}"
else
  echo "[i] No .showrunner.pid file found"
fi

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock || true
  echo "[+] Released Termux WakeLock"
fi
