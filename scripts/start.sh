#!/usr/bin/env bash
set -euo pipefail

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
  echo "[+] Acquired Termux WakeLock"
fi

export SHOWRUNNER_MODE="${SHOWRUNNER_MODE:-termux}"
export SHOWRUNNER_PORT="${SHOWRUNNER_PORT:-5000}"
export NODE_ENV=production
export HOST=127.0.0.1
export PORT="${SHOWRUNNER_PORT}"
export UV_THREADPOOL_SIZE=2

mkdir -p database

if [ ! -f "dist/index.html" ] || [ ! -f "dist-server/server.mjs" ]; then
  npm run build
fi

nohup node --expose-gc --max-old-space-size=512 dist-server/server.mjs > server.log 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > .showrunner.pid

echo "============================================================"
echo "  ShowRunner OS v1.3.0 started in background (PID ${SERVER_PID})"
echo "  Local URL  : http://127.0.0.1:${SHOWRUNNER_PORT}"
echo "  Auth Token : $(cat "${HOME}/.showrunner_token" 2>/dev/null || echo 'See ~/.showrunner_token')"
echo "  Log File   : ./server.log"
echo "============================================================"
