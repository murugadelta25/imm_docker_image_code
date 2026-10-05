"""Detect LAN IPv4 addresses for dynamic network access (DHCP IP changes)."""
from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import List, Optional


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def load_domain_config() -> dict:
    path = _project_root() / "deploy" / "domain.config.json"
    if not path.exists():
        return {"domain": "din.eappms", "lanIp": "", "useHttps": False}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"domain": "din.eappms", "lanIp": "", "useHttps": False}


def detect_lan_ips() -> List[str]:
    """All non-loopback IPv4 addresses on this host."""
    ips: List[str] = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127.") and ip not in ips:
                ips.insert(0, ip)
    except OSError:
        pass
    return ips


def primary_lan_ip(configured: Optional[str] = None) -> str:
    """
    Pick the best LAN IP for DNS and client URLs.
    Uses deploy/domain.config.json lanIp when set (static reservation).
    Otherwise auto-detects (updates when DHCP changes after service restart).
    """
    if configured and configured.strip():
        return configured.strip()
    cfg = load_domain_config()
    pinned = (cfg.get("lanIp") or "").strip()
    if pinned:
        return pinned
    ips = detect_lan_ips()
    for ip in ips:
        if ip.startswith("10.151."):
            return ip
    if ips:
        return ips[0]
    return "127.0.0.1"


def build_network_payload() -> dict:
    cfg = load_domain_config()
    domain = (cfg.get("domain") or "din.eappms").strip()
    use_https = bool(cfg.get("useHttps"))
    scheme = "https" if use_https else "http"
    ips = detect_lan_ips()
    primary = primary_lan_ip()
    if primary not in ips and primary != "127.0.0.1":
        ips.insert(0, primary)
    access_urls = [f"{scheme}://{domain}"]
    for ip in ips:
        access_urls.append(f"{scheme}://{ip}")
    access_urls_direct = [f"http://{ip}:5174" for ip in ips]
    return {
        "domain": domain,
        "standard_url": f"{scheme}://{domain}",
        "primary_lan_ip": primary,
        "lan_ips": ips,
        "access_urls": access_urls,
        "access_urls_direct": access_urls_direct,
        "ip_auto_detected": not bool((cfg.get("lanIp") or "").strip()),
        "dns_note": (
            "Set router DHCP DNS to primary_lan_ip so din.eappms works on all devices. "
            "Or open any access_urls entry directly (no DNS needed)."
        ),
    }
