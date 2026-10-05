#!/bin/bash
# package.sh — Create eap-pms.zip on Linux/WSL (same output as package.ps1)
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="eap-pms"
ZIP_NAME="${APP_NAME}.zip"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "Packaging $APP_NAME for Ubuntu..."

rsync -a "$ROOT/" "$STAGING/$APP_NAME/" \
  --exclude '.git' --exclude '.cursor' --exclude '.vscode' \
  --exclude 'backend/venv' --exclude 'backend/.venv' \
  --exclude 'backend/.venv.stale_*' --exclude 'backend/.venv.todelete_*' \
  --exclude 'backend/__pycache__' \
  --exclude 'frontend/node_modules' --exclude 'frontend/dist' \
  --exclude 'new_theme' --exclude 'TITAN_OEE_FULL_PACKAGE' --exclude 'demo' \
  --exclude 'database/backups' \
  --exclude 'backend/.env' --exclude 'frontend/.env' \
  --exclude 'database/db.config.json' \
  --exclude 'deploy.env' \
  --exclude '*.log' --exclude '*.xlsx' --exclude '*.zip' \
  --exclude '**/__pycache__' \
  --exclude 'frontend/src/pages/gemini_*' \
  --exclude 'frontend/src/pages/old_*' \
  --exclude 'frontend/src/pages/bug_*'

cd "$STAGING"
zip -rq "$ROOT/$ZIP_NAME" "$APP_NAME"
SIZE=$(du -h "$ROOT/$ZIP_NAME" | cut -f1)

echo ""
echo "Package created: $ROOT/$ZIP_NAME ($SIZE)"
echo ""
echo "On Ubuntu:"
echo "  unzip $ZIP_NAME && cd $APP_NAME"
echo "  chmod +x run.sh scripts/*.sh && ./run.sh"
