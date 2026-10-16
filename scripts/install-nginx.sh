#!/bin/bash
# Install/configure nginx reverse proxy for the standard EAP PMS domain (Ubuntu).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_domain_config

log_step "[nginx] Configuring reverse proxy for ${APP_URL}"

if ! command -v nginx >/dev/null 2>&1; then
  log_warn "Installing nginx..."
  sudo apt-get update -qq
  sudo apt-get install -y nginx
fi

TEMPLATE="$PROJECT_DIR/deploy/nginx-site.conf.template"
SITE_NAME="eappms-${APP_DOMAIN//./-}"
SITE_AVAILABLE="/etc/nginx/sites-available/${SITE_NAME}"
SITE_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}"

if [ ! -f "$TEMPLATE" ]; then
  log_fail "Missing $TEMPLATE"
  exit 1
fi

HTTPS_REDIRECT=""
HTTPS_SERVER_BLOCK=""

if [ "$APP_USE_HTTPS" = "yes" ] && [ -f "$APP_SSL_CERT" ] && [ -f "$APP_SSL_KEY" ]; then
  HTTPS_REDIRECT="    return 301 https://\$host\$request_uri;"
  HTTPS_SERVER_BLOCK=$(cat <<EOF

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${APP_DOMAIN};

    ssl_certificate     ${APP_SSL_CERT};
    ssl_certificate_key ${APP_SSL_KEY};

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:${FRONTEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /ws {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }

    location /static/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_set_header Host \$host;
    }

    location /health {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    location /docs {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    location /openapi.json {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }
}
EOF
)
  log_ok "HTTPS enabled (${APP_SSL_CERT})"
elif [ "$APP_USE_HTTPS" = "yes" ]; then
  log_warn "useHttps is true but certificate files are missing — using HTTP only"
  log_info "Place certs at paths in deploy/domain.config.json, then ./run.sh restart"
fi

TMP_SITE="$(mktemp)"
python3 - "$TEMPLATE" "$TMP_SITE" "$APP_DOMAIN" "$BACKEND_PORT" "$FRONTEND_PORT" "$HTTPS_REDIRECT" "$HTTPS_SERVER_BLOCK" <<'PY'
import sys
from pathlib import Path
template, out, domain, bport, fport, redirect, https_block = sys.argv[1:8]
text = Path(template).read_text(encoding="utf-8")
text = (
    text.replace("__DOMAIN__", domain)
    .replace("__BACKEND_PORT__", bport)
    .replace("__FRONTEND_PORT__", fport)
    .replace("__HTTPS_REDIRECT__", redirect)
    .replace("__HTTPS_SERVER_BLOCK__", https_block)
)
Path(out).write_text(text, encoding="utf-8")
PY
sudo cp "$TMP_SITE" "$SITE_AVAILABLE"
rm -f "$TMP_SITE"

sudo ln -sf "$SITE_AVAILABLE" "$SITE_ENABLED"
sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 80/tcp >/dev/null 2>&1 || true
  sudo ufw allow 443/tcp >/dev/null 2>&1 || true
fi

ensure_hosts_entry() {
  local ip="$1"
  if grep -qE "[[:space:]]${APP_DOMAIN}([[:space:]]|\$)" /etc/hosts 2>/dev/null; then
    return 0
  fi
  echo "${ip} ${APP_DOMAIN}" | sudo tee -a /etc/hosts >/dev/null
  log_ok "Added /etc/hosts: ${ip} ${APP_DOMAIN}"
}

SERVER_IP="$(detect_server_ip)"
if [ -n "$SERVER_IP" ]; then
  ensure_hosts_entry "$SERVER_IP"
fi

sudo nginx -t
sudo systemctl enable nginx >/dev/null 2>&1 || true
sudo systemctl reload nginx

if wait_for_url "${APP_URL}/" 20 "Standard URL (${APP_DOMAIN})"; then
  log_ok "nginx proxy active — ${APP_URL}"
else
  log_warn "nginx installed but ${APP_URL} not reachable yet"
  log_info "Ask IT to add DNS A record: ${APP_DOMAIN} -> ${SERVER_IP:-<server-ip>}"
fi
