#!/bin/bash
# Start LAN DNS (din.eappms -> IPC IP) for network-wide access.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

load_domain_config

DNS_ENABLED="yes"
if [ -f "$DOMAIN_CONFIG" ]; then
  DNS_ENABLED=$(python3 -c "import json;print('yes' if json.load(open('$DOMAIN_CONFIG')).get('dnsEnabled',True) else 'no')")
fi

if [ "$DNS_ENABLED" != "yes" ]; then
  log_warn "LAN DNS disabled in deploy/domain.config.json"
  exit 0
fi

LAN_IP="${LAN_IP:-}"
if [ -f "$DOMAIN_CONFIG" ]; then
  LAN_IP=$(python3 -c "import json;v=json.load(open('$DOMAIN_CONFIG')).get('lanIp','');print(v or '')")
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i ~ /^10\.151\./) {print $i; exit}}')
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP="$(detect_server_ip)"
fi

VENV_PY="$(resolve_backend_python)" || {
  log_warn "Python venv not found - skipping LAN DNS"
  exit 0
}

"$VENV_PY" -m pip install -q dnslib

if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 53/udp >/dev/null 2>&1 || true
  sudo ufw allow 53/tcp >/dev/null 2>&1 || true
fi

pkill -f "scripts/local_dns.py" 2>/dev/null || true
sleep 1

DNS_IP_ARG="auto"
if [ -n "$LAN_IP" ]; then
  DNS_IP_ARG="$LAN_IP"
fi

nohup "$VENV_PY" "$SCRIPT_DIR/local_dns.py" --domain "$APP_DOMAIN" --ip "$DNS_IP_ARG" \
  >> "$PROJECT_DIR/local-dns.log" 2>&1 &

if [ "$DNS_IP_ARG" = "auto" ]; then
  log_ok "LAN DNS running (auto IP) - ${APP_DOMAIN}"
  log_info "DNS re-detects LAN IP every 30s when DHCP changes"
else
  log_ok "LAN DNS running (pinned IP) - ${APP_DOMAIN} -> ${DNS_IP_ARG}"
fi
log_info "For ALL devices: set router DHCP DNS server to ${LAN_IP}"
log_info "Log: ${PROJECT_DIR}/local-dns.log"
