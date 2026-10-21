#!/bin/sh
set -eu

# Internal API port (not 8040): hostNetwork shares the host stack, so bare-metal
# IMM / leftover processes on :8040 would steal health checks and cause bind EADDRINUSE.
API_PORT="${IMM_API_PORT:-18040}"

echo "[imm-pms] starting FastAPI on 127.0.0.1:${API_PORT}"
cd /app/backend
# Single process — do not use --workers (multiprocess + hostNetwork can race on bind)
uvicorn app.main:app --host 127.0.0.1 --port "${API_PORT}" &
API_PID=$!

i=0
while [ "$i" -lt 45 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${API_PORT}/health" 2>/dev/null; then
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

if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "[imm-pms] ERROR: uvicorn died after health check"
  exit 1
fi

echo "[imm-pms] starting nginx on :8080 (API upstream 127.0.0.1:${API_PORT})"
# Keep nginx.conf in sync: upstream must match API_PORT (default 18040)
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