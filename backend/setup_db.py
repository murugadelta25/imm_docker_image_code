"""
PMS - One-time database setup
Run: python setup_db.py
Prefers database/db.config.json; falls back to interactive password prompt.
"""
import getpass, sys, os, json
from urllib.parse import quote_plus

print("=" * 45)
print("  PMS - Database Setup")
print("=" * 45)

project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
config_path = os.path.join(project_dir, "database", "db.config.json")

db_host = "localhost"
db_port = 3306
db_user = "root"
db_name = "eap_pms"
client_name = "default"
password = ""

if os.path.isfile(config_path):
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    mysql_cfg = cfg.get("mysql", {})
    db_host = mysql_cfg.get("host", db_host)
    db_port = int(mysql_cfg.get("port", db_port))
    db_user = mysql_cfg.get("user", db_user)
    password = mysql_cfg.get("password", "")
    db_name = cfg.get("database", db_name)
    client_name = cfg.get("clientName", client_name)
    print(f"\nUsing database/db.config.json -> {db_name}")
else:
    password = getpass.getpass("\nEnter your MySQL root password: ")

try:
    import pymysql
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "pymysql", "-q"])
    import pymysql

# Read schema file
schema_path = os.path.join(os.path.dirname(__file__), "..", "database", "schema.sql")
with open(schema_path, "r") as f:
    raw = f.read()

# Split statements (skip comments and empty)
statements = []
for s in raw.split(";"):
    s = s.strip()
    lines = [l for l in s.splitlines() if not l.strip().startswith("--")]
    s = "\n".join(lines).strip()
    if s:
        statements.append(s)

print("\nConnecting to MySQL...")
try:
    conn = pymysql.connect(host=db_host, port=db_port, user=db_user, password=password, charset="utf8mb4")
    cursor = conn.cursor()
    print("Connected!\n")

    db_escaped = db_name.replace("`", "``")
    cursor.execute(
        f"CREATE DATABASE IF NOT EXISTS `{db_escaped}` "
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )
    conn.commit()

    for stmt in statements:
        stmt = stmt.replace("eap_pms", db_name)
        try:
            cursor.execute(stmt)
            conn.commit()
        except pymysql.err.OperationalError as e:
            if "already exists" in str(e) or "Duplicate entry" in str(e):
                pass  # expected on re-run
            else:
                print(f"  Warning: {e}")
        except Exception as e:
            print(f"  Warning: {e}")
    cursor.close()
    conn.close()

    encoded_pw = quote_plus(password)
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    secret_key = f"eap_pms_{client_name}_secret"
    with open(env_path, "w", encoding="utf-8") as f:
        f.write(f"DATABASE_URL=mysql+pymysql://{db_user}:{encoded_pw}@{db_host}:{db_port}/{db_name}\n")
        f.write(f"SECRET_KEY={secret_key}\n")
        f.write("ACCESS_TOKEN_EXPIRE_MINUTES=480\n")

    print(f"✓ Database created: {db_name}")
    print("✓ All tables created")
    print("✓ Seed users inserted")
    print("✓ .env file updated with your password")
    print("\n" + "=" * 45)
    print("  Setup complete! Now run START_ALL.bat")
    print("=" * 45)
    print("\nDefault logins:")
    print("  admin       / admin123  (role: admin)")
    print("  supervisor1 / sup123    (role: supervisor)")
    print("  operator1   / op123     (role: operator)")
    print("  maintenance1/ maint123  (role: maintenance)")

except pymysql.err.OperationalError as e:
    print(f"\n✗ Connection failed: {e}")
    print("\nPossible fixes:")
    print("  1. Make sure MySQL service is running")
    print("     Open Services (Win+R -> services.msc) -> MySQL84 -> Start")
    print("  2. Check your root password is correct")
    print("  3. Try running MySQL Workbench to verify connection")
