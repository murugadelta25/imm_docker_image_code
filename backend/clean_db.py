"""
Cleans all data from the database and re-seeds default users.
Run: python clean_db.py
"""
from app.models import engine
from app.auth import hash_password
from sqlalchemy import text

TRUNCATE_ORDER = [
    "breakdown_tickets",
    "model_change_requests",
    "production_plans",
    "oee_entries",
    "email_recipients",
    "email_schedules",
    "email_groups",
    "email_smtp_config",
    "machines",
    "pairs",
    "users",
]

SEED_USERS = [
    ("admin",        "admin123",  "admin"),
    ("supervisor1",  "sup123",    "supervisor"),
    ("operator1",    "op123",     "operator"),
    ("maintenance1", "maint123",  "maintenance"),
]

with engine.begin() as conn:
    conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
    for tbl in TRUNCATE_ORDER:
        conn.execute(text(f"TRUNCATE TABLE {tbl}"))
        print(f"  Truncated: {tbl}")
    conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))

    # Re-seed default users
    for username, password, role in SEED_USERS:
        conn.execute(text(
            "INSERT INTO users (username, password_hash, role) VALUES (:u, :h, :r)"
        ), {"u": username, "h": hash_password(password), "r": role})
        print(f"  Seeded user: {username} ({role})")

print("\nDatabase cleaned and default users restored.")
print("Login credentials:")
for username, password, role in SEED_USERS:
    print(f"  {username} / {password}  [{role}]")
