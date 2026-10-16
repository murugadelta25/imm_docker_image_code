#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_deploy_env
read_db_creds

log_step "[db] Ensuring MySQL is running..."
if ! sudo systemctl is-active --quiet mysql 2>/dev/null; then
  sudo systemctl start mysql
fi
log_ok "MySQL running"

log_step "[db] Checking database '${DB_NAME}'..."

backup_database_if_exists() {
  local ts backup_dir backup_file
  if ! database_exists; then
    return 0
  fi
  if ! command -v mysqldump >/dev/null 2>&1; then
    log_warn "mysqldump not found — skipping pre-migration backup"
    return 0
  fi
  ts=$(date +"%Y%m%d_%H%M%S")
  backup_dir="$DATABASE_DIR/backups/preflight"
  backup_file="$backup_dir/${DB_NAME}_preflight_${ts}.sql"
  mkdir -p "$backup_dir"
  if MYSQL_PWD="${DB_PASS}" mysqldump -u "$DB_USER" -h localhost --single-transaction --routines --triggers "$DB_NAME" > "$backup_file" 2>/dev/null; then
    log_ok "Backup created: $backup_file"
  else
    log_warn "Backup failed (continuing): $backup_file"
    rm -f "$backup_file" 2>/dev/null || true
  fi
}

apply_database_migrations() {
  for sql in "$DATABASE_DIR"/migrate_*.sql; do
    [ -f "$sql" ] || continue
    fname=$(basename "$sql")
    apply_sql_file "$sql" 2>/dev/null && \
      log_ok "$fname applied to '${DB_NAME}'" || log_warn "$fname skipped"
  done
}

resolve_python() {
  if [ -x "$BACKEND_DIR/.venv/bin/python3" ]; then
    echo "$BACKEND_DIR/.venv/bin/python3"
  elif [ -x "$BACKEND_DIR/.venv/bin/python" ]; then
    echo "$BACKEND_DIR/.venv/bin/python"
  elif [ -x "$BACKEND_DIR/venv/bin/python3" ]; then
    echo "$BACKEND_DIR/venv/bin/python3"
  elif [ -x "$BACKEND_DIR/venv/bin/python" ]; then
    echo "$BACKEND_DIR/venv/bin/python"
  else
    echo "python3"
  fi
}

run_schema_guard() {
  local py
  py="$(resolve_python)"
  log_step "[db] Running schema guard (IMM + base integration)..."
  (
    cd "$BACKEND_DIR"
    "$py" ensure_customer_db.py
  )
  log_ok "Schema guard complete"
}


if database_exists; then
  log_info "Database '${DB_NAME}' already exists — applying migrations"
  backup_database_if_exists
  export MYSQL_PWD="${DB_PASS}"
  apply_database_migrations
  unset MYSQL_PWD
  run_schema_guard
  log_ok "Database migrations complete (${DB_NAME})"
  exit 0
fi

log_step "[db] Creating database and applying schema..."

export MYSQL_PWD="${DB_PASS}"
if ! mysql -u "$DB_USER" -h localhost -e "CREATE DATABASE \`${DB_NAME}\`;" 2>/dev/null; then
  log_warn "Could not connect as ${DB_USER}. Trying sudo mysql..."
  sudo mysql -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;"
  if [ -n "$DB_PASS" ]; then
    sudo mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';" 2>/dev/null || true
    sudo mysql -e "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost'; FLUSH PRIVILEGES;" 2>/dev/null || true
  fi
fi
log_ok "Database '${DB_NAME}' created"

if [ -f "$DATABASE_DIR/schema.sql" ]; then
  apply_sql_file "$DATABASE_DIR/schema.sql" && \
    log_ok "schema.sql applied to '${DB_NAME}'" || log_warn "schema.sql had warnings (tables may partially exist)"
else
  log_warn "database/schema.sql not found — skipping"
fi

apply_database_migrations

if [ -f "$DATABASE_DIR/seed_minimal.sql" ]; then
  apply_sql_file "$DATABASE_DIR/seed_minimal.sql" 2>/dev/null && \
    log_ok "seed_minimal.sql applied to '${DB_NAME}'" || true
fi

unset MYSQL_PWD
run_schema_guard
log_ok "Database setup complete (${DB_NAME})"
