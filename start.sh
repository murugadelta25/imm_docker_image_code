#!/bin/bash
# ============================================================
# start.sh — Start PMS Dashboard on Ubuntu
# Usage:
#   chmod +x start.sh
#   ./start.sh            # start both backend + frontend
#   ./start.sh backend    # backend only
#   ./start.sh frontend   # frontend only
#   ./start.sh stop       # stop both
# ============================================================

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"
BACKEND_PID="$PROJECT_DIR/.backend.pid"
FRONTEND_PID="$PROJECT_DIR/.frontend.pid"

start_backend() {
  echo "▶ Starting backend..."
  cd "$BACKEND_DIR"
  # Match Windows run.ps1: use backend/.venv (migrate legacy venv/)
  if [ -d "venv" ] && [ ! -d ".venv" ]; then
    mv venv .venv
  fi
  if [ ! -d ".venv" ]; then
    echo "  Creating Python venv (backend/.venv)..."
    python3 -m venv .venv
  fi
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install -r requirements.txt -q
  nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload \
    > "$PROJECT_DIR/backend.log" 2>&1 &
  echo $! > "$BACKEND_PID"
  echo "  Backend started (PID $(cat $BACKEND_PID)) → http://0.0.0.0:8000"
  echo "  Logs: tail -f $PROJECT_DIR/backend.log"
}

start_frontend() {
  echo "▶ Starting frontend..."
  cd "$FRONTEND_DIR"
  if [ ! -d "node_modules" ]; then
    echo "  Installing npm packages..."
    npm install
  fi
  nohup npm run dev -- --host \
    > "$PROJECT_DIR/frontend.log" 2>&1 &
  echo $! > "$FRONTEND_PID"
  echo "  Frontend started (PID $(cat $FRONTEND_PID)) → http://0.0.0.0:5173"
  echo "  Logs: tail -f $PROJECT_DIR/frontend.log"
}

stop_all() {
  echo "■ Stopping services..."
  if [ -f "$BACKEND_PID" ]; then
    kill "$(cat $BACKEND_PID)" 2>/dev/null && echo "  Backend stopped"
    rm -f "$BACKEND_PID"
  fi
  if [ -f "$FRONTEND_PID" ]; then
    kill "$(cat $FRONTEND_PID)" 2>/dev/null && echo "  Frontend stopped"
    rm -f "$FRONTEND_PID"
  fi
}

case "${1:-all}" in
  backend)  start_backend ;;
  frontend) start_frontend ;;
  stop)     stop_all ;;
  *)
    start_backend
    sleep 2
    start_frontend
    echo ""
    echo "✅ PMS Dashboard running"
    echo "   Frontend : http://$(hostname -I | awk '{print $1}'):5173"
    echo "   Backend  : http://$(hostname -I | awk '{print $1}'):8000"
    echo "   API Docs : http://$(hostname -I | awk '{print $1}'):8000/docs"
    echo ""
    echo "To stop: ./start.sh stop"
    ;;
esac
