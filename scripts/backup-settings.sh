#!/usr/bin/env bash
# Backup local deploy settings (no secrets) and optional DB snapshot.
# Usage: ./scripts/backup-settings.sh [--skip-db]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

SKIP_DB=0
if [[ "${1:-}" == "--skip-db" ]]; then
  SKIP_DB=1
fi

if [[ -x "$PROJECT_DIR/backend/.venv/bin/python3" ]]; then
  PY="$PROJECT_DIR/backend/.venv/bin/python3"
elif [[ -x "$PROJECT_DIR/backend/.venv/bin/python" ]]; then
  PY="$PROJECT_DIR/backend/.venv/bin/python"
else
  PY="python3"
fi

echo "[..] Exporting app config templates for Git..."
"$PY" "$PROJECT_DIR/scripts/export_app_config.py"

STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_ROOT="$PROJECT_DIR/database/backups/settings"
mkdir -p "$BACKUP_ROOT"

for f in deploy/domain.config.json deploy.env.example; do
  if [[ -f "$PROJECT_DIR/$f" ]]; then
    base="$(basename "$f")"
    cp "$PROJECT_DIR/$f" "$BACKUP_ROOT/${STAMP}-${base}"
  fi
done

if [[ "$SKIP_DB" -eq 0 ]] && [[ -f "$PROJECT_DIR/database/db.config.json" ]]; then
  # shellcheck source=scripts/common.sh
  source "$SCRIPT_DIR/common.sh"
  load_deploy_env 2>/dev/null || true
  if [[ -n "${DB_NAME:-}" ]] && command -v mysqldump >/dev/null 2>&1; then
    export MYSQL_PWD="${DB_PASSWORD:-}"
    mysqldump -u "${DB_USER:-root}" -h localhost "$DB_NAME" > "$BACKUP_ROOT/${STAMP}-${DB_NAME}.sql"
    unset MYSQL_PWD
    echo "[OK] DB backup -> $BACKUP_ROOT/${STAMP}-${DB_NAME}.sql"
  fi
fi

echo "[OK] Settings backup complete. Commit deploy/config-templates/ after review."
