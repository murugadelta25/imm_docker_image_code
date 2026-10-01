#!/bin/bash
# =============================================================
#  EAP PMS — Ubuntu launcher (install deps + systemd + start)
#
#  Usage:
#    ./run.sh              Install (if needed) and start via systemd
#    ./run.sh stop         Stop backend and frontend services
#    ./run.sh restart      Restart services
#    ./run.sh status       Show service status
#    ./run.sh logs         Tail both service logs
#    ./run.sh preflight    Safe DB backup + schema checks only
#    ./run.sh help         Show this help
# =============================================================

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$PROJECT_DIR/scripts"

# shellcheck source=scripts/common.sh
source "$SCRIPTS_DIR/common.sh"

ACTION="${1:-start}"

print_banner() {
  echo -e "${CYAN}================================================${NC}"
  echo -e "${CYAN}  EAP PMS — Ubuntu Application Launcher${NC}"
  echo -e "${CYAN}================================================${NC}"
}

prompt_first_deploy() {
  log_step "[config] First-time deployment setup"
  echo ""
  echo -e "  Enter client and database details (saved to deploy.env and database/db.config.json):"
  echo ""

  local input_client input_pass input_db default_db

  while [ -z "${input_client:-}" ]; do
    read -p "  Client name (used for systemd services): " input_client
    input_client=$(echo "$input_client" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -z "$input_client" ]; then
      log_warn "Client name is required"
    fi
  done

  read -s -p "  MySQL password: " input_pass
  echo ""

  default_db="eap_pms_$(sanitize_client_slug "$input_client" | tr '-' '_')"
  read -p "  Database name [${default_db}]: " input_db
  input_db="${input_db:-$default_db}"

  write_deploy_files "$input_client" "$input_pass" "$input_db" "root"
  load_deploy_env
  read_db_creds
  resolve_service_names

  log_ok "Saved deploy.env and database/db.config.json"
  log_info "Client: ${CLIENT_NAME}"
  log_info "Database: ${DB_NAME}"
  log_info "Services: ${BACKEND_SERVICE}, ${FRONTEND_SERVICE}"
}

ensure_deploy_config() {
  if is_first_deploy; then
    prompt_first_deploy
  else
    load_deploy_env
    read_db_creds
    resolve_service_names
  fi
}

cmd_stop() {
  ensure_deploy_config
  print_banner
  log_step "Stopping services..."
  service_ctl stop 2>/dev/null || true
  log_ok "Stopped ${BACKEND_SERVICE} and ${FRONTEND_SERVICE}"
}

cmd_status() {
  ensure_deploy_config
  print_banner
  sudo systemctl status "${BACKEND_SERVICE}" "${FRONTEND_SERVICE}" --no-pager || true
}

cmd_logs() {
  ensure_deploy_config
  print_banner
  sudo journalctl -u "${BACKEND_SERVICE}" -u "${FRONTEND_SERVICE}" -f --no-pager
}

show_usage() {
  echo "Usage: ./run.sh [start|stop|restart|status|logs|preflight|help]"
}

cmd_preflight() {
  ensure_deploy_config
  print_banner
  log_step "[preflight] Running safe deployment checks..."
  bash "$SCRIPTS_DIR/install-deps.sh"
  ensure_backend_env
  configure_frontend_env
  bash "$SCRIPTS_DIR/setup-database.sh"
  log_ok "Preflight complete"
  log_info "Dependencies verified, DB backup created if needed, migrations/schema guard applied"
  log_info "Next steps: git pull && ./run.sh restart"
}

cmd_restart() {
  ensure_deploy_config
  print_banner
  bash "$SCRIPTS_DIR/install-deps.sh"
  ensure_backend_env
  configure_frontend_env
  bash "$SCRIPTS_DIR/setup-database.sh"
  bash "$SCRIPTS_DIR/install-systemd.sh"
  service_ctl restart
  if ! verify_services_running; then
    log_fail "Restart verification failed"
    exit 1
  fi
  bash "$SCRIPTS_DIR/install-nginx.sh" || log_warn "nginx setup skipped or failed"
  bash "$SCRIPTS_DIR/install-local-dns.sh" || log_warn "LAN DNS skipped or failed"
  print_urls
}

print_urls() {
  print_app_urls
}

cmd_start() {
  print_banner
  ensure_deploy_config

  bash "$SCRIPTS_DIR/install-deps.sh"
  ensure_backend_env
  configure_frontend_env
  bash "$SCRIPTS_DIR/setup-database.sh"

  INSTALL_SYSTEMD="${INSTALL_SYSTEMD:-yes}"
  if [[ "$INSTALL_SYSTEMD" =~ ^[Yy] ]]; then
    bash "$SCRIPTS_DIR/install-systemd.sh"
  fi

  log_step "[start] Starting ${BACKEND_SERVICE} and ${FRONTEND_SERVICE}..."
  service_ctl restart

  if ! verify_services_running; then
    echo ""
    log_fail "Deployment finished with errors — check logs above"
    sudo journalctl -u "${BACKEND_SERVICE}" -n 20 --no-pager 2>/dev/null || true
    sudo journalctl -u "${FRONTEND_SERVICE}" -n 20 --no-pager 2>/dev/null || true
    exit 1
  fi

  log_step "[nginx] Standard URL reverse proxy..."
  bash "$SCRIPTS_DIR/install-nginx.sh" || log_warn "nginx setup skipped or failed — direct ports still work"

  log_step "[dns] LAN DNS for network-wide din.eappms..."
  bash "$SCRIPTS_DIR/install-local-dns.sh" || log_warn "LAN DNS skipped or failed"

  print_urls

  load_domain_config
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${APP_URL}" >/dev/null 2>&1 &
  fi
}

case "$ACTION" in
  help|--help|-h)
    show_usage
    ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  preflight) cmd_preflight ;;
  restart) cmd_restart ;;
  start|"") cmd_start ;;
  *)
    echo "Unknown command: $ACTION"
    show_usage
    exit 1
    ;;
esac
