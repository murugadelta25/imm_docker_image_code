"""Allow dynamic part document types (VARCHAR + label)."""
from sqlalchemy import inspect, text
from app.models import engine

STATEMENTS = [
    "ALTER TABLE part_documents MODIFY COLUMN doc_type VARCHAR(100) NOT NULL",
    "ALTER TABLE part_document_history MODIFY COLUMN doc_type VARCHAR(100) NOT NULL",
    "ALTER TABLE part_documents ADD COLUMN doc_label VARCHAR(150) NULL",
    "ALTER TABLE part_document_history ADD COLUMN doc_label VARCHAR(150) NULL",
]


def main():
    insp = inspect(engine)
    existing = {f"{t}.{c['name']}" for t in insp.get_table_names() for c in insp.get_columns(t)}
    for stmt in STATEMENTS:
        if "ADD COLUMN" in stmt:
            col = stmt.split("ADD COLUMN ")[1].split()[0]
            table = stmt.split("ALTER TABLE ")[1].split()[0]
            if f"{table}.{col}" in existing:
                print(f"[SKIP] {table}.{col}")
                continue
        try:
            with engine.begin() as conn:
                conn.execute(text(stmt))
            print(f"[OK] {stmt}")
        except Exception as exc:
            if "Duplicate column" in str(exc):
                print(f"[SKIP] {stmt}")
            else:
                raise


if __name__ == "__main__":
    main()
