import pymysql, sys

conn = pymysql.connect(host='localhost', user='root', password='Mysql@2026', charset='utf8mb4')
cur = conn.cursor()

# Check DB
cur.execute('SELECT schema_name FROM information_schema.schemata WHERE schema_name="eap_pms"')
db = cur.fetchone()
print('DB exists:', db)

if not db:
    print("DB not found - running setup...")
    cur.execute("CREATE DATABASE eap_pms")
    conn.commit()

conn.select_db('eap_pms')

# Check tables
cur.execute('SHOW TABLES')
tables = cur.fetchall()
print('Tables:', tables)

# Check users
try:
    cur.execute('SELECT username, LEFT(password_hash,30), role FROM users')
    users = cur.fetchall()
    print('Users:', users)
except Exception as e:
    print('Users table error:', e)
    users = []

# If no users, insert them
if not users:
    print("\nNo users found - inserting seed users...")
    import bcrypt
    users_data = [
        ('admin',        bcrypt.hashpw(b'admin123', bcrypt.gensalt()).decode(), 'admin'),
        ('supervisor1',  bcrypt.hashpw(b'sup123',   bcrypt.gensalt()).decode(), 'supervisor'),
        ('operator1',    bcrypt.hashpw(b'op123',    bcrypt.gensalt()).decode(), 'operator'),
        ('maintenance1', bcrypt.hashpw(b'maint123', bcrypt.gensalt()).decode(), 'maintenance'),
    ]
    for u, h, r in users_data:
        try:
            cur.execute("INSERT INTO users (username, password_hash, role) VALUES (%s, %s, %s)", (u, h, r))
            conn.commit()
            print(f"  Inserted: {u}")
        except Exception as e:
            print(f"  {u}: {e}")

cur.close()
conn.close()
print("\nDone.")
