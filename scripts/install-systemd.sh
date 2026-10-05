#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_deploy_env
read_db_creds
resolve_service_names

CURRENT_USER="$(whoami)"
SERVER_IP="$(detect_server_ip)"
CLIENT_LABEL="${CLIENT_NAME:-$BACKEND_SERVICE}"

log_step "[systemd] Installing ${BACKEND_SERVICE} and ${FRONTEND_SERVICE} services..."

VENV_BIN="$(resolve_backend_venv_bin)" || {
  log_fail "No backend/.venv found. Run ./scripts/install-deps.sh first."
  exit 1
}

sudo tee "/etc/systemd/system/${BACKEND_SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=EAP PMS Backend — ${CLIENT_LABEL}
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${BACKEND_DIR}
Environment=PATH=${VENV_BIN}:/usr/bin
ExecStart=${VENV_BIN}/uvicorn app.main:app --host 0.0.0.0 --port ${BACKEND_PORT}
Restart=always
RestartSec=5
StandardOutput=append:${BACKEND_LOG}
StandardError=append:${BACKEND_LOG}

[Install]
WantedBy=multi-user.target
EOF

sudo tee "/etc/systemd/system/${FRONTEND_SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=EAP PMS Frontend — ${CLIENT_LABEL}
After=network.target ${BACKEND_SERVICE}.service
Wants=${BACKEND_SERVICE}.service

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${FRONTEND_DIR}
Environment=NODE_ENV=production
# Serve production build (vite preview). Do NOT use "npm run dev" with NODE_ENV=production —
# that skips React Fast Refresh preamble injection and breaks the app ($RefreshSig$ error).
ExecStart=/usr/bin/npm run preview -- --host 0.0.0.0 --port ${FRONTEND_PORT}
Restart=always
RestartSec=5
StandardOutput=append:${FRONTEND_LOG}
StandardError=append:${FRONTEND_LOG}

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "${BACKEND_SERVICE}" "${FRONTEND_SERVICE}"
log_ok "systemd units installed for client '${CLIENT_LABEL}'"
log_info "Backend : sudo systemctl [start|stop|status] ${BACKEND_SERVICE}"
log_info "Frontend: sudo systemctl [start|stop|status] ${FRONTEND_SERVICE}"
