#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

log_step "[deps] Checking system packages..."

if ! command -v python3 >/dev/null; then
  log_warn "Installing Python 3..."
  sudo apt-get update -qq
  sudo apt-get install -y python3 python3-pip python3-venv python3-dev build-essential
elif ! python3 -c "import ensurepip" 2>/dev/null || ! command -v pip3 >/dev/null; then
  # python3 may exist without venv/pip packages (common on Ubuntu)
  log_warn "Installing python3-venv / pip..."
  sudo apt-get update -qq
  sudo apt-get install -y python3-pip python3-venv python3-dev build-essential
fi

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
  log_warn "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v mysql >/dev/null; then
  log_warn "Installing MySQL server..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
  sudo systemctl enable mysql
  sudo systemctl start mysql
fi

for pkg in curl lsof; do
  if ! command -v "$pkg" >/dev/null; then
    sudo apt-get install -y "$pkg"
  fi
done

if command -v ufw >/dev/null; then
  sudo ufw allow "${BACKEND_PORT}/tcp" >/dev/null 2>&1 || true
  sudo ufw allow "${FRONTEND_PORT}/tcp" >/dev/null 2>&1 || true
fi

log_step "[deps] Python virtual environment..."
# Same layout as Windows run.ps1: backend/.venv (migrate legacy backend/venv)
ensure_backend_venv
cd "$BACKEND_DIR"
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q --upgrade pip
pip install -q -r requirements.txt
deactivate
log_ok "Backend .venv ready (Ubuntu + Windows shared path)"

log_step "[deps] Frontend npm packages..."
cd "$FRONTEND_DIR"
if [ ! -d node_modules ]; then
  npm install --silent
else
  npm install --silent
fi
log_ok "Frontend dependencies ready"

log_step "[deps] Building frontend for production..."
npm run build --silent
log_ok "Frontend production build ready (frontend/dist)"
