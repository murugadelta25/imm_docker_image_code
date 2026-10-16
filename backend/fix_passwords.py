import pymysql, bcrypt

conn = pymysql.connect(host='localhost', user='root', password='Mysql@2026', db='eap_pms', charset='utf8mb4')
cur = conn.cursor()

# Get full hashes
cur.execute('SELECT id, username, password_hash, role FROM users')
users = cur.fetchall()

test_passwords = {
    'admin': 'admin123',
    'supervisor1': 'sup123',
    'operator1': 'op123',
    'maintenance1': 'maint123',
}

print("Checking existing hashes:")
for uid, uname, uhash, urole in users:
    pwd = test_passwords.get(uname, '')
    try:
        ok = bcrypt.checkpw(pwd.encode(), uhash.encode())
        print(f"  {uname}: hash check = {ok}")
    except Exception as e:
        print(f"  {uname}: ERROR - {e}")

print("\nResetting all passwords with fresh hashes...")
for uname, pwd in test_passwords.items():
    new_hash = bcrypt.hashpw(pwd.encode(), bcrypt.gensalt()).decode()
    cur.execute("UPDATE users SET password_hash=%s WHERE username=%s", (new_hash, uname))
    conn.commit()
    print(f"  Updated: {uname} / {pwd}")

cur.close()
conn.close()
print("\nAll passwords reset. Try logging in again.")
