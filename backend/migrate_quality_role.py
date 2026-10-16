"""Add 'quality' role to users.role ENUM."""
from sqlalchemy import text
from app.models import engine


def main():
    stmt = (
        "ALTER TABLE users MODIFY COLUMN role "
        "ENUM('operator','supervisor','maintenance','admin','quality') NOT NULL"
    )
    with engine.begin() as conn:
        conn.execute(text(stmt))
    print("[OK] users.role includes 'quality'")


if __name__ == "__main__":
    main()
