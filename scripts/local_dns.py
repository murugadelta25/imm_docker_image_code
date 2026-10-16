#!/usr/bin/env python3
"""
LAN DNS for EAP PMS — resolves din.eappms to the IPC's CURRENT LAN IP (auto-detected).
Re-detects IP every 30s so DHCP changes are picked up without manual DNS updates.
"""
from __future__ import annotations

import argparse
import socket
import sys
import time


def _load_dnslib():
    try:
        from dnslib import DNSRecord, RR, QTYPE, A
        from dnslib.server import DNSServer, BaseResolver
        return DNSRecord, RR, QTYPE, A, DNSServer, BaseResolver
    except ImportError:
        print("[FAIL] dnslib not installed. Run: pip install dnslib", file=sys.stderr)
        sys.exit(1)


def detect_primary_lan_ip(pinned: str = "") -> str:
    if pinned and pinned.lower() not in ("auto", "detect", ""):
        return pinned.strip()
    ips: list[str] = []
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
    for ip in ips:
        if ip.startswith("10.151."):
            return ip
    return ips[0] if ips else "127.0.0.1"


def main() -> None:
    parser = argparse.ArgumentParser(description="EAP PMS local DNS (dynamic LAN IP)")
    parser.add_argument("--domain", default="din.eappms")
    parser.add_argument("--ip", default="auto", help="IPC LAN IP or 'auto' to detect")
    parser.add_argument("--port", type=int, default=53)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--upstream", default="8.8.8.8")
    parser.add_argument("--refresh-sec", type=int, default=30)
    args = parser.parse_args()

    DNSRecord, RR, QTYPE, A, DNSServer, BaseResolver = _load_dnslib()
    domain = args.domain.lower().rstrip(".")
    pinned = "" if args.ip.lower() in ("auto", "detect", "") else args.ip

    class LANResolver(BaseResolver):
        def __init__(self):
            self._pinned = pinned
            self._cached_ip = detect_primary_lan_ip(self._pinned)
            self._cached_at = time.time()

        def _current_ip(self) -> str:
            if self._pinned:
                return self._pinned
            now = time.time()
            if now - self._cached_at >= args.refresh_sec:
                self._cached_ip = detect_primary_lan_ip()
                self._cached_at = now
                print(f"[DNS] IP refresh -> {self._cached_ip}", flush=True)
            return self._cached_ip

        def resolve(self, request, handler):
            qname = str(request.q.qname).lower().rstrip(".")
            if qname == domain or qname.endswith("." + domain):
                ip = self._current_ip()
                reply = request.reply()
                reply.add_answer(RR(request.q.qname, QTYPE.A, rdata=A(ip), ttl=30))
                return reply
            try:
                data = request.pack()
                sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sock.settimeout(3)
                sock.sendto(data, (args.upstream, 53))
                resp, _ = sock.recvfrom(4096)
                sock.close()
                return DNSRecord.parse(resp)
            except OSError:
                return request.reply(rcode="SERVFAIL")

    start_ip = detect_primary_lan_ip(pinned)
    mode = "pinned" if pinned else "auto"
    print(f"[DNS] {domain} -> {start_ip} ({mode}, refresh {args.refresh_sec}s, port {args.port})")
    server = DNSServer(LANResolver(), port=args.port, address=args.bind)
    server.start_thread()
    try:
        while server.isAlive():
            server.thread.join(timeout=1)
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


if __name__ == "__main__":
    main()
