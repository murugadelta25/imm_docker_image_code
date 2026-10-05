#!/bin/bash
# Shared helpers for EAP PMS Ubuntu deployment scripts.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"
DATABASE_DIR="$PROJECT_DIR/database"
DEPLOY_ENV="$PROJECT_DIR/deploy.env"
DB_CONFIG="$DATABASE_DIR/db.config.json"
DOMAIN_CONFIG="$PROJECT_DIR/deploy/domain.config.json"

APP_DOMAIN="${APP_DOMAIN:-din.eappms}"
APP_USE_HTTPS="${APP_USE_HTTPS:-no}"
APP_SCHEME="${APP_SCHEME:-http}"
APP_SSL_CERT=""
APP_SSL_KEY=""

BACKEND_PORT="${BACKEND_PORT:-8040}"
FRONTEND_PORT="${FRONTEND_PORT:-5184}"
BACKEND_LOG="$PROJECT_DIR/backend.log"
FRONTEND_LOG="$PROJECT_DIR/frontend.log"
BACKEND_SERVICE=""
FRONTEND_SERVICE=""

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_step() { echo -e "\n${CYAN}$1${NC}"; }
log_ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}!${NC} $1"; }
log_fail() { echo -e "  ${RED}✗${NC} $1"; }
log_info() { echo -e "  ${YELLOW}ℹ${NC} $1"; }

load_deploy_env() {
  if [ -f "$DEPLOY_ENV" ]; then
    # shellcheck disable=SC1090
    set -a; source "$DEPLOY_ENV"; set +a
  fi
  BACKEND_PORT="${BACKEND_PORT:-8040}"
  FRONTEND_PORT="${FRONTEND_PORT:-5184}"
  DB_USER="${DB_USER:-root}"
  resolve_service_names
}

sanitize_client_slug() {
  local raw="${1:-eap-pms}"
  local slug
  slug=$(echo "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  [ -z "$slug" ] && slug="eap-pms"
  echo "$slug"
}

resolve_service_names() {
  local slug
  if [ -f "$DB_CONFIG" ]; then
    CLIENT_NAME="${CLIENT_NAME:-$(python3 -c "import json;print(json.load(open('$DB_CONFIG')).get('clientName',''))" 2>/dev/null || true)}"
  fi
  slug=$(sanitize_client_slug "${CLIENT_NAME:-eap-pms}")
  BACKEND_SERVICE="${slug}-backend"
  FRONTEND_SERVICE="${slug}-frontend"
  BACKEND_LOG="$PROJECT_DIR/${slug}-backend.log"
  FRONTEND_LOG="$PROJECT_DIR/${slug}-frontend.log"
}

is_first_deploy() {
  [ ! -f "$DEPLOY_ENV" ] || [ ! -f "$DB_CONFIG" ]
}

write_deploy_files() {
  local client_name="$1" db_pass="$2" db_name="$3" db_user="${4:-root}"

  python3 - "$DEPLOY_ENV" "$DB_CONFIG" "$client_name" "$db_user" "$db_pass" "$db_name" \
    "${BACKEND_PORT:-8040}" "${FRONTEND_PORT:-5184}" <<'PY'
import json, shlex, sys
deploy_path, db_config_path, client, user, password, database, bport, fport = sys.argv[1:9]
lines = [
    f"CLIENT_NAME={shlex.quote(client)}",
    f"DB_USER={shlex.quote(user)}",
    f"DB_PASS={shlex.quote(password)}",
    f"DB_NAME={shlex.quote(database)}",
    f"BACKEND_PORT={bport}",
    f"FRONTEND_PORT={fport}",
    "INSTALL_SYSTEMD=yes",
    "",
]
open(deploy_path, "w", encoding="utf-8").write("\n".join(lines))
json.dump({
    "clientName": client,
    "user": user,
    "password": password,
    "database": database,
    "host": "localhost",
    "migrate": False,
    "legacyDatabase": "titan_oee",
    "mysql": {
        "host": "localhost",
        "port": 3306,
        "user": user,
        "password": password,
    },
}, open(db_config_path, "w", encoding="utf-8"), indent=2)
open(db_config_path, "a", encoding="utf-8").write("\n")
PY
}

detect_server_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

load_domain_config() {
  APP_DOMAIN="din.eappms"
  APP_USE_HTTPS="no"
  APP_SCHEME="http"
  APP_SSL_CERT=""
  APP_SSL_KEY=""

  if [ -f "$DOMAIN_CONFIG" ]; then
    eval "$(python3 - "$DOMAIN_CONFIG" <<'PY'
import json, shlex, sys
raw = json.load(open(sys.argv[1], encoding="utf-8"))
domain = raw.get("domain") or "din.eappms"
use_https = bool(raw.get("useHttps"))
print(f"APP_DOMAIN={shlex.quote(domain)}")
print(f"APP_USE_HTTPS={'yes' if use_https else 'no'}")
print(f"APP_SCHEME={'https' if use_https else 'http'}")
print(f"APP_SSL_CERT={shlex.quote(str(raw.get('sslCert') or ''))}")
print(f"APP_SSL_KEY={shlex.quote(str(raw.get('sslKey') or ''))}")
PY
)"
  fi
  APP_URL="${APP_SCHEME}://${APP_DOMAIN}"
}

print_app_urls() {
  load_domain_config
  SERVER_IP="$(detect_server_ip)"
  ALL_IPS=""
  if command -v hostname >/dev/null 2>&1; then
    ALL_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | grep -v '^$' || true)
  fi

  echo ""
  echo -e "${GREEN}================================================${NC}"
  echo -e "${GREEN}  EAP PMS is running — ${CLIENT_NAME:-EAP PMS}${NC}"
  echo -e "${GREEN}================================================${NC}"
  echo ""
  echo -e "  ${YELLOW}Standard URL (use this):${NC}"
  echo -e "    ${GREEN}${APP_URL}${NC}"
  echo -e "  ${YELLOW}API Docs:${NC} ${APP_URL}/docs"
  echo ""
  echo -e "  ${YELLOW}Direct access (fallback):${NC}"
  echo -e "    Local  : http://localhost:${FRONTEND_PORT}"
  if [ -n "$ALL_IPS" ]; then
    while IFS= read -r ip; do
      [ -z "$ip" ] && continue
      echo -e "    Network (port 80) : ${GREEN}http://${ip}${NC}"
      echo -e "    Network (Vite)    : http://${ip}:${FRONTEND_PORT}"
    done <<< "$ALL_IPS"
  elif [ -n "$SERVER_IP" ]; then
    echo -e "    Network (port 80) : ${GREEN}http://${SERVER_IP}${NC}"
    echo -e "    Network (Vite)    : http://${SERVER_IP}:${FRONTEND_PORT}"
  fi
  echo ""
  echo -e "  ${YELLOW}Network access (Windows / Ubuntu / Android):${NC}"
  echo -e "    Standard URL : ${GREEN}${APP_URL}${NC}"
  echo -e "    Primary IP   : ${GREEN}${SERVER_IP:-<this-server-ip>}${NC}  (http://IP works without DNS)"
  echo ""
  echo -e "  ${YELLOW}If IPC IP changes (DHCP):${NC}"
  echo -e "    Direct http://<new-ip> still works; LAN DNS auto-refreshes din.eappms every 30s"
  echo -e "    Reserve a static DHCP IP for the IPC in production; update router DNS if IP changes"
  echo ""
  echo -e "  ${YELLOW}ONE-TIME router/IT setup (PC + Android + tablets):${NC}"
  echo -e "    Set DHCP DNS server to: ${YELLOW}${SERVER_IP:-<this-server-ip>}${NC}"
  echo -e "    Then all devices open ${APP_URL} on the LAN"
  echo ""
  echo -e "  ${YELLOW}Fallback (no router access):${NC} deploy/Setup-Client-PC.bat on each PC"
  echo ""
  echo -e "  Default login: ${YELLOW}operator1 / op123${NC}"
  echo ""
  if [ -n "${BACKEND_SERVICE:-}" ]; then
    echo -e "  ${CYAN}systemd services (client: ${CLIENT_NAME})${NC}"
    echo -e "    sudo systemctl status ${BACKEND_SERVICE}"
    echo -e "    sudo systemctl status ${FRONTEND_SERVICE}"
    echo -e "    sudo systemctl stop ${BACKEND_SERVICE} ${FRONTEND_SERVICE}"
    echo ""
    echo -e "  Logs:"
    echo -e "    sudo journalctl -u ${BACKEND_SERVICE} -f"
    echo -e "    sudo journalctl -u ${FRONTEND_SERVICE} -f"
    echo ""
  fi
}

read_db_creds() {
  DB_USER="${DB_USER:-root}"
  DB_PASS="${DB_PASS:-}"
  DB_NAME="${DB_NAME:-eap_pms}"
  CLIENT_NAME="${CLIENT_NAME:-}"

  if [ -f "$DB_CONFIG" ]; then
    CLIENT_NAME=$(python3 -c "import json;print(json.load(open('$DB_CONFIG')).get('clientName',''))" 2>/dev/null || true)
    DB_USER=$(python3 -c "import json;print(json.load(open('$DB_CONFIG')).get('user','root'))" 2>/dev/null || echo root)
    DB_PASS=$(python3 -c "import json;print(json.load(open('$DB_CONFIG')).get('password',''))" 2>/dev/null || true)
    DB_NAME=$(python3 -c "import json;print(json.load(open('$DB_CONFIG')).get('database','eap_pms'))" 2>/dev/null || echo eap_pms)
  elif [ -f "$BACKEND_DIR/.env" ]; then
    local url
    url=$(grep '^DATABASE_URL=' "$BACKEND_DIR/.env" | cut -d= -f2-)
    if [[ "$url" =~ mysql\+pymysql://([^:]+):([^@]+)@[^/]+/([^?]+) ]]; then
      DB_USER="${BASH_REMATCH[1]}"
      DB_PASS=$(python3 -c "import urllib.parse; print(urllib.parse.unquote('${BASH_REMATCH[2]}'))")
      DB_NAME="${BASH_REMATCH[3]}"
    fi
  fi
}

mysql_cmd() {
  export MYSQL_PWD="${DB_PASS}"
  if mysql -u "$DB_USER" -h localhost "$@" 2>/dev/null; then
    unset MYSQL_PWD
    return 0
  fi
  unset MYSQL_PWD
  return 1
}

database_exists() {
  local result
  result=$(MYSQL_PWD="${DB_PASS}" mysql -u "$DB_USER" -h localhost -N -e \
    "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='${DB_NAME}';" 2>/dev/null || true)
  [ -n "$result" ]
}

# Replace hardcoded eap_pms in schema/migrate SQL with the configured client database
apply_sql_file() {
  local sql_file="$1"
  local db_escaped
  db_escaped=$(echo "$DB_NAME" | sed 's/`/``/g')
  sed -e "s/USE[[:space:]]\+eap_pms[[:space:]]*;/USE \`${db_escaped}\`;/gi" \
      -e "s/CREATE DATABASE IF NOT EXISTS eap_pms/CREATE DATABASE IF NOT EXISTS \`${db_escaped}\`/gi" \
      "$sql_file" | MYSQL_PWD="${DB_PASS}" mysql -u "$DB_USER" -h localhost "$DB_NAME"
}

ensure_backend_env() {
  if [ ! -f "$BACKEND_DIR/.env" ]; then
    if [ ! -f "$BACKEND_DIR/.env.example" ]; then
      log_fail "Missing backend/.env.example"
      return 1
    fi
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
    read_db_creds
    python3 - "$BACKEND_DIR/.env" "$DB_USER" "$DB_PASS" "$DB_NAME" <<'PY'
import secrets, sys, urllib.parse
path, user, password, db = sys.argv[1:5]
secret = secrets.token_hex(32)
enc_pass = urllib.parse.quote(password, safe="")
url = f"mysql+pymysql://{user}:{enc_pass}@localhost:3306/{db}"
lines = open(path, encoding="utf-8").read().splitlines()
out = []
for line in lines:
    if line.startswith("DATABASE_URL="):
        out.append(f"DATABASE_URL={url}")
    elif line.startswith("SECRET_KEY="):
        out.append(f"SECRET_KEY={secret}")
    else:
        out.append(line)
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
    log_ok "Created backend/.env"
  fi
  sync_backend_database_url
}

sync_backend_database_url() {
  read_db_creds
  if [ ! -f "$BACKEND_DIR/.env" ]; then
    return 0
  fi
  python3 - "$BACKEND_DIR/.env" "$DB_USER" "$DB_PASS" "$DB_NAME" <<'PY'
import sys, urllib.parse
from pathlib import Path
path, user, password, db = sys.argv[1:5]
enc_pass = urllib.parse.quote(password, safe="")
url = f"mysql+pymysql://{user}:{enc_pass}@localhost:3306/{db}"
p = Path(path)
lines = p.read_text(encoding="utf-8").splitlines()
out = []
found = False
for line in lines:
    if line.startswith("DATABASE_URL="):
        out.append(f"DATABASE_URL={url}")
        found = True
    else:
        out.append(line)
if not found:
    out.insert(0, f"DATABASE_URL={url}")
p.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
  log_ok "Backend DATABASE_URL synced to ${DB_NAME}"
}

configure_frontend_env() {
  cat > "$FRONTEND_DIR/.env" <<EOF
# Auto-generated — Vite proxies /api and /ws to backend on port ${BACKEND_PORT}
VITE_API_URL=
VITE_WS_URL=
EOF
  log_ok "Frontend .env configured (Vite proxy mode)"
}

wait_for_url() {
  local url="$1" tries="${2:-20}" label="$3"
  for i in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      log_ok "$label HTTP ready ($url)"
      return 0
    fi
    sleep 1
  done
  log_fail "$label failed to respond at $url"
  return 1
}

check_systemd_service() {
  local unit="$1" label="$2"
  if systemctl is-active --quiet "$unit" 2>/dev/null; then
    log_ok "$label systemd service is active ($unit)"
    return 0
  fi
  log_fail "$label systemd service is NOT running ($unit)"
  sudo systemctl status "$unit" --no-pager -n 5 2>/dev/null || true
  return 1
}

verify_frontend_production_build() {
  local html unit_file
  unit_file="/etc/systemd/system/${FRONTEND_SERVICE}.service"

  if [ -f "$unit_file" ] && grep -qE 'npm run dev|vite([[:space:]]|$)' "$unit_file" 2>/dev/null \
     && ! grep -q 'npm run preview' "$unit_file" 2>/dev/null; then
    log_fail "Frontend systemd unit still runs Vite dev mode ($unit_file)"
    log_info "Run: bash scripts/install-systemd.sh && sudo systemctl daemon-reload && sudo systemctl restart ${FRONTEND_SERVICE}"
    return 1
  fi

  html=$(curl -sf "http://localhost:${FRONTEND_PORT}/" 2>/dev/null || true)
  if [ -z "$html" ]; then
    log_fail "Frontend returned empty response at http://localhost:${FRONTEND_PORT}/"
    return 1
  fi
  if echo "$html" | grep -q '/src/main.jsx'; then
    log_fail "Frontend is serving Vite dev sources (/src/main.jsx) — browser will hit \$RefreshSig\$ errors"
    log_info "Run: bash scripts/install-systemd.sh && sudo systemctl daemon-reload && sudo systemctl restart ${FRONTEND_SERVICE}"
    return 1
  fi
  if ! echo "$html" | grep -qE '/assets/[^"]+\.js'; then
    log_fail "Frontend index.html does not reference a production JS bundle under /assets/"
    return 1
  fi
  log_ok "Frontend serving production build"
  return 0
}

verify_services_running() {
  local ok=true
  log_step "[verify] Checking backend and frontend services..."

  if ! check_systemd_service "${BACKEND_SERVICE}.service" "Backend"; then
    ok=false
  fi
  if ! wait_for_url "http://localhost:${BACKEND_PORT}/health" 15 "Backend"; then
    ok=false
  fi
  if ! wait_for_url "http://localhost:${BACKEND_PORT}/health/db" 15 "Backend database"; then
    ok=false
    log_info "Check backend/.env DATABASE_URL matches database/db.config.json, then: sudo systemctl restart ${BACKEND_SERVICE}"
  fi

  if ! check_systemd_service "${FRONTEND_SERVICE}.service" "Frontend"; then
    ok=false
  fi
  if ! wait_for_url "http://localhost:${FRONTEND_PORT}" 20 "Frontend"; then
    ok=false
  fi
  if ! verify_frontend_production_build; then
    ok=false
  fi

  if [ "$ok" = true ]; then
    log_ok "All services verified — backend and frontend are running"
    return 0
  fi
  log_fail "One or more services failed verification"
  return 1
}

service_ctl() {
  local action="$1"
  shift
  sudo systemctl "$action" "${BACKEND_SERVICE}.service" "${FRONTEND_SERVICE}.service" "$@"
}
