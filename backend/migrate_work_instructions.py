"""Apply work-instruction / part-master tables using DATABASE_URL from .env."""
from pathlib import Path
import re
from sqlalchemy import text
from app.models import engine

SQL_PATH = Path(__file__).resolve().parent.parent / "database" / "migrate_work_instructions.sql"


def _statements(sql: str):
    for raw in sql.split(";"):
        stmt = raw.strip()
        if not stmt:
            continue
        # Drop line comments and skip USE (wrong DB when DATABASE_URL targets plant DB)
        lines = [
            ln for ln in stmt.splitlines()
            if ln.strip() and not ln.strip().startswith("--")
        ]
        stmt = "\n".join(lines).strip()
        if not stmt or stmt.upper().startswith("USE "):
            continue
        yield stmt


def main():
    sql = SQL_PATH.read_text(encoding="utf-8")
    for stmt in _statements(sql):
        with engine.begin() as conn:
            conn.execute(text(stmt))
        preview = re.sub(r"\s+", " ", stmt)[:70]
        print(f"[OK] {preview}")


if __name__ == "__main__":
    main()
