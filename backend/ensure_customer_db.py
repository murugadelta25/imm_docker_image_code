"""
Ensure customer MySQL database exists and IMM + base EAP tables are present.
Uses database/db.config.json (preferred) or backend/.env DATABASE_URL.

Run:
  backend\\.venv\\Scripts\\python.exe ensure_customer_db.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import quote_plus, urlparse

ROOT = Path(__file__).resolve().parent.parent
BACKEND = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND))

# Load .env early
from dotenv import load_dotenv

load_dotenv(BACKEND / ".env")


def _cfg():
    cfg_path = ROOT / "database" / "db.config.json"
    if cfg_path.exists():
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        mysql = raw.get("mysql") or {}
        db_name = raw.get("database") or ""
        client = raw.get("clientName") or db_name or "EAP PMS"
        if not db_name:
            raise SystemExit(
                "database/db.config.json is incomplete (missing database). "
                "Run .\\run.ps1 or ./run.sh on first launch."
            )
        return {
            "clientName": client,
            "host": mysql.get("host") or raw.get("host") or "localhost",
            "port": int(mysql.get("port") or raw.get("port") or 3306),
            "user": mysql.get("user") or raw.get("user") or "root",
            "password": mysql.get("password") or raw.get("password") or "",
            "database": db_name,
        }
    url = os.getenv("DATABASE_URL") or ""
    if not url or url.rstrip().endswith("=") or url.endswith("DATABASE_URL="):
        raise SystemExit(
            "No database/db.config.json and DATABASE_URL is empty. "
            "Run .\\run.ps1 to enter customer details on first launch."
        )
    # mysql+pymysql://user:pass@host:3306/db
    u = urlparse(url.replace("mysql+pymysql://", "mysql://"))
    db = (u.path or "").lstrip("/") or ""
    if not db:
        raise SystemExit(
            "DATABASE_URL has no database name. "
            "Run .\\run.ps1 to enter customer details on first launch."
        )
    return {
        "clientName": db,
        "host": u.hostname or "localhost",
        "port": u.port or 3306,
        "user": u.username or "root",
        "password": u.password or "",
        "database": db,
    }


def main():
    import pymysql

    cfg = _cfg()
    db_name = cfg["database"]
    print(f"Customer: {cfg['clientName']}")
    print(f"Database: {db_name}")
    print(f"Host: {cfg['host']}:{cfg['port']}")

    conn = pymysql.connect(
        host=cfg["host"],
        port=cfg["port"],
        user=cfg["user"],
        password=cfg["password"],
        charset="utf8mb4",
    )
    cur = conn.cursor()
    cur.execute(
        f"CREATE DATABASE IF NOT EXISTS `{db_name.replace('`', '``')}` "
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )
    conn.commit()
    print(f"[OK] Database ensured: {db_name}")

    # Apply base schema if core tables missing
    cur.execute(f"USE `{db_name.replace('`', '``')}`")
    cur.execute("SHOW TABLES LIKE 'machines'")
    has_machines = cur.fetchone() is not None
    if not has_machines:
        schema_path = ROOT / "database" / "schema.sql"
        raw = schema_path.read_text(encoding="utf-8")
        for stmt in raw.split(";"):
            s = "\n".join(
                ln for ln in stmt.strip().splitlines() if not ln.strip().startswith("--")
            ).strip()
            if not s:
                continue
            s = s.replace("eap_pms", db_name)
            try:
                cur.execute(s)
                conn.commit()
            except Exception as exc:  # noqa: BLE001
                if "already exists" in str(exc).lower() or "duplicate" in str(exc).lower():
                    pass
                else:
                    print(f"  schema warn: {exc}")
        print("[OK] Base schema applied")
    else:
        print("[OK] Base tables already present")

    cur.close()
    conn.close()

    # Sync .env DATABASE_URL to customer DB
    encoded = quote_plus(cfg["password"])
    env_path = BACKEND / ".env"
    lines = []
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()
    url = f"mysql+pymysql://{cfg['user']}:{encoded}@{cfg['host']}:{cfg['port']}/{db_name}"
    secret = f"eap_pms_{cfg['clientName']}_secret"
    out = []
    seen_db = seen_secret = False
    for ln in lines:
        if ln.startswith("DATABASE_URL="):
            out.append(f"DATABASE_URL={url}")
            seen_db = True
        elif ln.startswith("SECRET_KEY="):
            out.append(f"SECRET_KEY={secret}")
            seen_secret = True
        else:
            out.append(ln)
    if not seen_db:
        out.insert(0, f"DATABASE_URL={url}")
    if not seen_secret:
        out.append(f"SECRET_KEY={secret}")
    env_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("[OK] backend/.env DATABASE_URL synced")

    # Create IMM + OPC UA tables via SQLAlchemy models
    os.environ["DATABASE_URL"] = url
    from app.models import ensure_imm_schema, ensure_factory_schema, engine  # noqa: E402
    from app.opcua_imm import ensure_all_imm_tag_maps, seed_param_defs  # noqa: E402
    from app.models import SessionLocal  # noqa: E402
    from app.factory_structure import migrate_json_factories_if_empty  # noqa: E402

    ensure_imm_schema(engine)
    ensure_factory_schema(engine)
    db = SessionLocal()
    try:
        n = seed_param_defs(db)
        maps = ensure_all_imm_tag_maps(db)
        migrated = migrate_json_factories_if_empty(db)
        db.commit()
        print(f"[OK] IMM OPC UA catalog seeded (defs upserted={n}, maps created={maps})")
        if migrated:
            print("[OK] Migrated factory/zone JSON into relational tables")
    finally:
        db.close()

    bundle = ROOT / "deploy" / "config-templates" / "app_config_bundle.json"
    if bundle.exists():
        import subprocess

        py = sys.executable
        script = ROOT / "scripts" / "import_app_config.py"
        if script.exists():
            print("[..] Applying deploy config templates (if empty)...")
            rc = subprocess.call([py, str(script), "--if-empty"], cwd=str(ROOT))
            if rc == 0:
                print("[OK] Deploy config import finished")
            else:
                print(f"[WARN] Deploy config import exited {rc}")

    print("Done.")


if __name__ == "__main__":
    main()
