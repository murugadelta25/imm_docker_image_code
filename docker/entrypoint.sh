#!/bin/sh
set -eu

echo "[imm-pms] starting FastAPI on 127.0.0.1:8040"
cd /app/backend
uvicorn app.main:app --host 127.0.0.1 --port 8040 --workers 1 &
API_PID=$!

i=0
while [ "$i" -lt 45 ]; do
  if wget -q -O /dev/null http://127.0.0.1:8040/health 2>/dev/null; then
    echo "[imm-pms] API is up"
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "[imm-pms] ERROR: uvicorn exited before becoming healthy"
    wait "$API_PID" || true
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done

echo "[imm-pms] starting nginx on :80"
nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
  echo "[imm-pms] shutting down..."
  kill -TERM "$NGINX_PID" 2>/dev/null || true
  kill -TERM "$API_PID" 2>/dev/null || true
  wait "$NGINX_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
}
trap shutdown INT TERM

# Prefer nginx as the "main" process; if either exits, shut down both
while kill -0 "$NGINX_PID" 2>/dev/null && kill -0 "$API_PID" 2>/dev/null; do
  sleep 2
done
shutdown
exit 1