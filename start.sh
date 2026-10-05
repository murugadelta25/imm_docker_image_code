#!/bin/bash
# ============================================================
# start.sh — Start EAP IMM PMS on Ubuntu (dev / no systemd)
# Usage:
#   chmod +x start.sh
#   ./start.sh            # start both backend + frontend
#   ./start.sh backend    # backend only
#   ./start.sh frontend   # frontend only
#   ./start.sh stop       # stop both
#
# Ports default to IMM 8040 / 5174; override via deploy.env.
# For production prefer: ./run.sh (systemd, no --reload).
# ============================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"
BACKEND_PID="$PROJECT_DIR/.backend.pid"
FRONTEND_PID="$PROJECT_DIR/.frontend.pid"
DEPLOY_ENV="$PROJECT_DIR/deploy.env"

# IMM defaults (same as Windows run.ps1 / scripts/common.sh)
BACKEND_PORT="${BACKEND_PORT:-8040}"
FRONTEND_PORT="${FRONTEND_PORT:-5174}"

if [ -f "$DEPLOY_ENV" ]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source "$DEPLOY_ENV"
  set +a
  BACKEND_PORT="${BACKEND_PORT:-8040}"
  FRONTEND_PORT="${FRONTEND_PORT:-5174}"
fi

resolve_venv_python() {
  if [ -x "$BACKEND_DIR/.venv/bin/python" ]; then
    echo "$BACKEND_DIR/.venv/bin/python"
  elif [ -x "$BACKEND_DIR/.venv/bin/python3" ]; then
    echo "$BACKEND_DIR/.venv/bin/python3"
  else
    echo ""
  fi
}

start_backend() {
  echo "▶ Starting backend on :${BACKEND_PORT}..."
  cd "$BACKEND_DIR"
  # Match Windows run.ps1: use backend/.venv (migrate legacy venv/)
  if [ -d "venv" ] && [ ! -d ".venv" ]; then
    mv venv .venv
  fi
  if [ ! -d ".venv" ]; then
    echo "  Creating Python venv (backend/.venv)..."
    python3 -m venv .venv
  fi
  # Best-effort cleanup of leftover stale venvs (WatchFiles reload loops)
  find "$BACKEND_DIR" -maxdepth 1 -type d \( -name '.venv.stale_*' -o -name '.venv.todelete_*' \) \
    -exec rm -rf {} + 2>/dev/null || true

  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -r requirements.txt -q

  VENV_PY="$(resolve_venv_python)"
  if [ -z "$VENV_PY" ]; then
    echo "  ✗ backend/.venv python not found" >&2
    exit 1
  fi

  # Reload only app/ — never watch .venv (same issue as Windows WatchFiles loops)
  nohup "$VENV_PY" -m uvicorn app.main:app \
    --host 0.0.0.0 --port "$BACKEND_PORT" \
    --reload --reload-dir app \
    > "$PROJECT_DIR/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID"
  echo "  Backend started (PID $(cat "$BACKEND_PID")) → http://0.0.0.0:${BACKEND_PORT}"
  echo "  Logs: tail -f $PROJECT_DIR/backend.log"
}

start_frontend() {
  echo "▶ Starting frontend on :${FRONTEND_PORT}..."
  cd "$FRONTEND_DIR"
  if [ ! -d "node_modules" ]; then
    echo "  Installing npm packages..."
    npm install
  fi
  nohup npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" \
    > "$PROJECT_DIR/frontend.log" 2>&1 &
  echo $! > "$FRONTEND_PID"
  echo "  Frontend started (PID $(cat "$FRONTEND_PID")) → http://0.0.0.0:${FRONTEND_PORT}"
  echo "  Logs: tail -f $PROJECT_DIR/frontend.log"
}

stop_all() {
  echo "■ Stopping services..."
  if [ -f "$BACKEND_PID" ]; then
    kill "$(cat "$BACKEND_PID")" 2>/dev/null && echo "  Backend stopped" || true
    # Also stop uvicorn reloader child if still listening
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${BACKEND_PORT}/tcp" 2>/dev/null || true
    fi
    rm -f "$BACKEND_PID"
  fi
  if [ -f "$FRONTEND_PID" ]; then
    kill "$(cat "$FRONTEND_PID")" 2>/dev/null && echo "  Frontend stopped" || true
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${FRONTEND_PORT}/tcp" 2>/dev/null || true
    fi
    rm -f "$FRONTEND_PID"
  fi
}

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
HOST_IP="${HOST_IP:-127.0.0.1}"

case "${1:-all}" in
  backend)  start_backend ;;
  frontend) start_frontend ;;
  stop)     stop_all ;;
  *)
    start_backend
    sleep 2
    start_frontend
    echo ""
    echo "✅ EAP IMM PMS running"
    echo "   Frontend : http://${HOST_IP}:${FRONTEND_PORT}"
    echo "   Backend  : http://${HOST_IP}:${BACKEND_PORT}"
    echo "   API Docs : http://${HOST_IP}:${BACKEND_PORT}/docs"
    echo ""
    echo "To stop: ./start.sh stop"
    echo "Production (systemd): ./run.sh"
    ;;
esac
