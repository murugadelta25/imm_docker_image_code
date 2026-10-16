from app.auth import verify_password
import pymysql

conn = pymysql.connect(host='localhost', user='root', password='Mysql@2026', db='eap_pms', charset='utf8mb4')
cur = conn.cursor()
cur.execute('SELECT username, password_hash FROM users WHERE username="admin"')
row = cur.fetchone()
print('User found:', row[0])
result = verify_password('admin123', row[1])
print('verify_password("admin123"):', result)
conn.close()
