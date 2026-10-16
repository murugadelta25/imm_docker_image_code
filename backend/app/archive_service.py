"""
Database backup & archive service.

Primary method : mysqldump / mysql CLI  (full-fidelity SQL dump)
Fallback       : SQLAlchemy row-level JSON export (portable, always works)

Backups are stored under  <project>/backups/  with timestamped filenames.
"""
from __future__ import annotations

import gzip
import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlparse

from sqlalchemy import text
from sqlalchemy.orm import Session

from .models import SessionLocal, engine

BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
_DB_CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "database" / "db.config.json"

TABLES_TO_BACKUP = [
    "stations", "machines", "users", "site_config",
    "factories", "factory_departments", "factory_zones", "factory_zone_stations",
    "parts", "part_documents", "part_document_history", "part_qc_parameters",
    "tool_stocks", "tool_events", "tool_alerts",
    "work_orders", "production_plans", "oee_entries", "oee_defect_log",
    "model_change_requests", "breakdown_tickets",
    "machine_status_log", "machine_kpi_log",
    "deviation_alert_log", "deviation_escalation_cases",
    "email_groups", "email_recipients", "email_schedules",
    "email_smtp_config", "email_logs",
    "qc_inspection_reports",
]


def _parse_db_url() -> dict:
    """Extract host, port, user, password, dbname from DATABASE_URL / db.config.json.

    Passwords in DATABASE_URL are URL-encoded by DbConfig.ps1 (EscapeDataString).
    They must be unquoted before passing to mysqldump — SQLAlchemy does this
    automatically, but urlparse alone does not.
    """
    # Prefer plain credentials from db.config.json when available
    if _DB_CONFIG_PATH.exists():
        try:
            with open(_DB_CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if cfg.get("database") and cfg.get("password") is not None:
                return {
                    "host": cfg.get("host") or "localhost",
                    "port": int(cfg.get("port") or 3306),
                    "user": cfg.get("user") or "root",
                    "password": str(cfg.get("password") or ""),
                    "database": str(cfg["database"]),
                }
        except Exception:
            pass

    raw = os.getenv("DATABASE_URL", "")
    if not raw:
        raise RuntimeError("DATABASE_URL not set")
    parsed = urlparse(raw.replace("mysql+pymysql://", "mysql://"))
    return {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or "root"),
        "password": unquote(parsed.password or ""),
        "database": (parsed.path or "").lstrip("/"),
    }


def _mysqldump_available() -> bool:
    try:
        subprocess.run(
            ["mysqldump", "--version"],
            capture_output=True, timeout=5,
        )
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _mysql_available() -> bool:
    try:
        subprocess.run(
            ["mysql", "--version"],
            capture_output=True, timeout=5,
        )
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def create_backup(method: str = "auto", triggered_by: str = "manual") -> dict:
    """
    Create a database backup.

    method: "auto" (try mysqldump first, then json), "sql", "json"
    triggered_by: "manual" | "scheduled"
    Returns metadata dict about the created backup.
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    if method == "auto":
        if _mysqldump_available():
            try:
                return _backup_sql(ts, triggered_by)
            except Exception as exc:
                print(f"[Archive] mysqldump failed, falling back to JSON: {exc}")
                return _backup_json(ts, triggered_by)
        return _backup_json(ts, triggered_by)

    if method == "sql":
        return _backup_sql(ts, triggered_by)
    return _backup_json(ts, triggered_by)


def _write_mysql_defaults(db_info: dict) -> Path:
    """Write a temporary my.cnf so password is not passed on the command line."""
    import tempfile
    # Use 127.0.0.1 instead of localhost to force TCP (avoids Unix socket auth issues)
    host = db_info["host"]
    if host in ("localhost", "::1"):
        host = "127.0.0.1"
    fd, path = tempfile.mkstemp(prefix="pms_mysql_", suffix=".cnf")
    os.close(fd)
    content = (
        "[client]\n"
        f"host={host}\n"
        f"port={db_info['port']}\n"
        f"user={db_info['user']}\n"
        f"password={db_info['password']}\n"
    )
    Path(path).write_text(content, encoding="utf-8")
    return Path(path)


def _backup_sql(ts: str, triggered_by: str) -> dict:
    """Full mysqldump → gzipped .sql.gz file."""
    db_info = _parse_db_url()
    filename = f"pms_backup_{ts}.sql.gz"
    filepath = BACKUP_DIR / filename
    defaults_file = _write_mysql_defaults(db_info)

    try:
        cmd = [
            "mysqldump",
            f"--defaults-extra-file={defaults_file}",
            "--single-transaction",
            "--routines",
            "--triggers",
            "--add-drop-table",
            db_info["database"],
        ]

        proc = subprocess.run(cmd, capture_output=True, timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(f"mysqldump failed: {proc.stderr.decode('utf-8', errors='replace')}")

        with gzip.open(filepath, "wb") as f:
            f.write(proc.stdout)
    finally:
        try:
            defaults_file.unlink(missing_ok=True)
        except Exception:
            pass

    meta = _build_meta(filename, filepath, "sql", triggered_by)
    _write_meta(filename, meta)
    return meta


def _backup_json(ts: str, triggered_by: str) -> dict:
    """SQLAlchemy-based JSON export of all tables → gzipped .json.gz file."""
    filename = f"pms_backup_{ts}.json.gz"
    filepath = BACKUP_DIR / filename

    db: Session = SessionLocal()
    try:
        data: dict[str, list] = {}
        for table in TABLES_TO_BACKUP:
            try:
                rows = db.execute(text(f"SELECT * FROM `{table}`")).mappings().all()
                data[table] = [_row_to_dict(r) for r in rows]
            except Exception:
                data[table] = []

        with gzip.open(filepath, "wt", encoding="utf-8") as f:
            json.dump(data, f, default=str, ensure_ascii=False)
    finally:
        db.close()

    meta = _build_meta(filename, filepath, "json", triggered_by)
    _write_meta(filename, meta)
    return meta


def _row_to_dict(row) -> dict:
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, (datetime,)):
            d[k] = v.isoformat()
        elif isinstance(v, bytes):
            d[k] = v.decode("utf-8", errors="replace")
    return d


def _build_meta(filename: str, filepath: Path, method: str, triggered_by: str) -> dict:
    size_bytes = filepath.stat().st_size
    return {
        "filename": filename,
        "method": method,
        "triggered_by": triggered_by,
        "created_at": datetime.now().isoformat(),
        "size_bytes": size_bytes,
        "size_display": _human_size(size_bytes),
    }


def _write_meta(filename: str, meta: dict):
    meta_path = BACKUP_DIR / f"{filename}.meta.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, default=str)


def _human_size(b: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


def list_backups() -> list[dict]:
    """List all available backups, newest first."""
    backups = []
    for meta_file in sorted(BACKUP_DIR.glob("*.meta.json"), reverse=True):
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
            backup_file = BACKUP_DIR / meta["filename"]
            if backup_file.exists():
                meta["size_bytes"] = backup_file.stat().st_size
                meta["size_display"] = _human_size(meta["size_bytes"])
                backups.append(meta)
        except Exception:
            continue
    return backups


def get_backup_path(filename: str) -> Optional[Path]:
    """Return full path if backup file exists."""
    fp = BACKUP_DIR / filename
    if fp.exists() and fp.is_file():
        return fp
    return None


def delete_backup(filename: str) -> bool:
    """Delete a backup and its metadata."""
    fp = BACKUP_DIR / filename
    meta_fp = BACKUP_DIR / f"{filename}.meta.json"
    deleted = False
    if fp.exists():
        fp.unlink()
        deleted = True
    if meta_fp.exists():
        meta_fp.unlink()
        deleted = True
    return deleted


def restore_backup(filename: str) -> dict:
    """
    Restore the database from a backup file.
    Returns status dict.
    """
    fp = BACKUP_DIR / filename
    if not fp.exists():
        raise FileNotFoundError(f"Backup file not found: {filename}")

    if filename.endswith(".sql.gz"):
        return _restore_sql(fp)
    elif filename.endswith(".json.gz"):
        return _restore_json(fp)
    else:
        raise ValueError(f"Unknown backup format: {filename}")


def _restore_sql(filepath: Path) -> dict:
    """Restore from a mysqldump .sql.gz file."""
    if not _mysql_available():
        raise RuntimeError("mysql CLI not found — cannot restore SQL backup")

    db_info = _parse_db_url()
    defaults_file = _write_mysql_defaults(db_info)

    try:
        with gzip.open(filepath, "rb") as f:
            sql_data = f.read()

        cmd = [
            "mysql",
            f"--defaults-extra-file={defaults_file}",
            db_info["database"],
        ]

        proc = subprocess.run(
            cmd, input=sql_data, capture_output=True, timeout=600,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"mysql restore failed: {proc.stderr.decode('utf-8', errors='replace')}")
    finally:
        try:
            defaults_file.unlink(missing_ok=True)
        except Exception:
            pass

    return {
        "status": "restored",
        "method": "sql",
        "filename": filepath.name,
        "restored_at": datetime.now().isoformat(),
    }


def _restore_json(filepath: Path) -> dict:
    """Restore from a JSON .json.gz backup — truncate + re-insert."""
    with gzip.open(filepath, "rt", encoding="utf-8") as f:
        data = json.load(f)

    db: Session = SessionLocal()
    try:
        db.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        restored_tables = []

        for table in reversed(TABLES_TO_BACKUP):
            if table in data:
                try:
                    db.execute(text(f"TRUNCATE TABLE `{table}`"))
                except Exception:
                    db.execute(text(f"DELETE FROM `{table}`"))

        for table in TABLES_TO_BACKUP:
            rows = data.get(table, [])
            if not rows:
                continue
            for row in rows:
                cols = ", ".join(f"`{k}`" for k in row.keys())
                placeholders = ", ".join(f":{k}" for k in row.keys())
                stmt = text(f"INSERT INTO `{table}` ({cols}) VALUES ({placeholders})")
                db.execute(stmt, row)
            restored_tables.append(f"{table} ({len(rows)} rows)")

        db.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
        db.commit()
    except Exception as exc:
        db.rollback()
        raise RuntimeError(f"JSON restore failed: {exc}") from exc
    finally:
        db.close()

    return {
        "status": "restored",
        "method": "json",
        "filename": filepath.name,
        "restored_at": datetime.now().isoformat(),
        "tables": restored_tables,
    }


def cleanup_old_backups(max_keep: int = 10):
    """Remove oldest backups beyond max_keep count."""
    backups = list_backups()
    if len(backups) <= max_keep:
        return 0
    removed = 0
    for old in backups[max_keep:]:
        if delete_backup(old["filename"]):
            removed += 1
    return removed


def run_scheduled_backup():
    """Called by APScheduler — create backup + cleanup old ones."""
    from .models import SessionLocal
    import json as _json

    db = SessionLocal()
    try:
        from .models import SiteConfig
        row = db.query(SiteConfig).first()
        cfg = _json.loads(row.config_json) if row else {}
        backup_cfg = cfg.get("backup", {})
        max_keep = backup_cfg.get("max_backups", 10)
    except Exception:
        max_keep = 10
    finally:
        db.close()

    try:
        result = create_backup(method="auto", triggered_by="scheduled")
        print(f"[Archive] Scheduled backup created: {result['filename']} ({result['size_display']})")
        removed = cleanup_old_backups(max_keep)
        if removed:
            print(f"[Archive] Cleaned up {removed} old backup(s)")
    except Exception as exc:
        print(f"[Archive] Scheduled backup FAILED: {exc}")
