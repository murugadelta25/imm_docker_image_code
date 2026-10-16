#!/bin/bash
# Quick backend + database diagnostics for Ubuntu deployment.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_deploy_env
read_db_creds
resolve_service_names

echo ""
log_step "[diagnose] EAP PMS backend checks (${DB_NAME})"
echo ""

log_step "1. Service status"
systemctl is-active "${BACKEND_SERVICE}" 2>/dev/null && log_ok "Backend active" || log_fail "Backend not active"

log_step "2. HTTP health"
curl -sf "http://localhost:${BACKEND_PORT}/health" && echo "" && log_ok "/health OK" || log_fail "/health failed"

log_step "3. DATABASE_URL vs db.config.json"
grep '^DATABASE_URL=' "$BACKEND_DIR/.env" 2>/dev/null || log_warn "No backend/.env"
python3 - <<'PY'
import json, re
from pathlib import Path
cfg = json.load(open("database/db.config.json"))
env_url = ""
for line in Path("backend/.env").read_text().splitlines():
    if line.startswith("DATABASE_URL="):
        env_url = line.split("=", 1)[1]
        break
m = re.search(r"/([^/?]+)(?:\?|$)", env_url)
env_db = m.group(1) if m else "?"
match = env_db == cfg["database"]
print(f"  .env database     : {env_db}")
print(f"  db.config.json    : {cfg['database']}")
print(f"  Match             : {'YES' if match else 'NO — run ensure_backend_env / sync DATABASE_URL'}")
PY

log_step "4. MySQL connectivity"
export MYSQL_PWD="${DB_PASS}"
if mysql -u "$DB_USER" -h localhost -N -e "SELECT 1" "$DB_NAME" 2>/dev/null; then
  log_ok "MySQL login to ${DB_NAME} OK"
else
  log_fail "Cannot connect to MySQL database ${DB_NAME}"
fi

log_step "5. Required schema columns"
mysql -u "$DB_USER" -h localhost -N "$DB_NAME" -e \
  "SELECT CONCAT(table_name, '.', column_name) FROM information_schema.columns
   WHERE table_schema='${DB_NAME}'
     AND (table_name, column_name) IN (
       ('oee_entries','machine_id'),
       ('oee_entries','station_no'),
       ('oee_entries','model_variant'),
       ('machine_status_log','machine_id'),
       ('site_config','config_json')
     )
   ORDER BY table_name, column_name;" 2>/dev/null | while read -r col; do
  log_ok "Found $col"
done
missing=$(mysql -u "$DB_USER" -h localhost -N "$DB_NAME" -e \
  "SELECT c.req FROM (
     SELECT 'oee_entries.machine_id' req UNION ALL
     SELECT 'oee_entries.station_no' UNION ALL
     SELECT 'machine_status_log.machine_id'
   ) c
   LEFT JOIN information_schema.columns col
     ON col.table_schema='${DB_NAME}'
    AND CONCAT(col.table_name,'.',col.column_name)=c.req
   WHERE col.column_name IS NULL;" 2>/dev/null || true)
if [ -n "$missing" ]; then
  while read -r m; do
    [ -n "$m" ] && log_fail "Missing column: $m"
  done <<< "$missing"
  log_info "Fix: bash scripts/setup-database.sh  (applies migrate_*.sql)"
fi
unset MYSQL_PWD

log_step "6. API smoke tests"
branding_code=$(curl -s -o /tmp/eap_branding.json -w "%{http_code}" "http://localhost:${BACKEND_PORT}/api/config/branding")
echo "  /api/config/branding -> HTTP $branding_code"
[ "$branding_code" = "200" ] && log_ok "Branding API OK" || log_fail "Branding API failed (check backend log)"

token=$(curl -sf -X POST "http://localhost:${BACKEND_PORT}/api/auth/login" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=operator1&password=op123" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || true)
if [ -n "$token" ]; then
  log_ok "Login operator1/op123 OK"
  hourly_code=$(curl -s -o /tmp/eap_hourly.json -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    "http://localhost:${BACKEND_PORT}/api/hourly-output/?entry_date=$(date +%F)&shift=A&scope=all")
  echo "  /api/hourly-output -> HTTP $hourly_code"
  if [ "$hourly_code" = "200" ]; then
    log_ok "Hourly output API OK"
  else
    log_fail "Hourly output API failed"
    head -c 500 /tmp/eap_hourly.json 2>/dev/null; echo ""
  fi
else
  log_fail "Login failed — check users table / password (default: operator1 / op123)"
fi

echo ""
log_info "Backend log: sudo journalctl -u ${BACKEND_SERVICE} -n 40 --no-pager"
echo ""
