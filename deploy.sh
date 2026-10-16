#!/bin/bash
# =============================================================
# deploy.sh — First-time setup helper (optional)
# Prefer: ./run.sh  (installs deps, DB, systemd, and starts)
# =============================================================

set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "EAP PMS deploy — delegating to ./run.sh"
echo ""

if [ ! -f "$PROJECT_DIR/deploy.env" ] && [ -f "$PROJECT_DIR/deploy.env.example" ]; then
  cp "$PROJECT_DIR/deploy.env.example" "$PROJECT_DIR/deploy.env"
  echo "Created deploy.env from example — edit DB_PASS before continuing."
  echo ""
fi

chmod +x "$PROJECT_DIR/run.sh" "$PROJECT_DIR/scripts/"*.sh 2>/dev/null || true
exec "$PROJECT_DIR/run.sh" start
