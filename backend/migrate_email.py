import pymysql

conn = pymysql.connect(host='localhost', user='root', password='Mysql@2026', db='eap_pms', charset='utf8mb4')
cur = conn.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS email_groups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(200),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS email_recipients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL,
    active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES email_groups(id) ON DELETE CASCADE
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS email_schedules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    group_ids VARCHAR(200) NOT NULL,
    report_type VARCHAR(50) DEFAULT 'daily',
    send_hour INT DEFAULT 18,
    send_minute INT DEFAULT 0,
    attach_report TINYINT(1) DEFAULT 1,
    active TINYINT(1) DEFAULT 1,
    last_sent DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
""")

cur.execute("""
CREATE TABLE IF NOT EXISTS email_smtp_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    smtp_server VARCHAR(100) DEFAULT 'smtp.gmail.com',
    smtp_port INT DEFAULT 587,
    email_address VARCHAR(150),
    email_password VARCHAR(255),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
""")

conn.commit()

# Seed default groups
for name, desc in [('production','Production team - operators and supervisors'),
                   ('maintenance','Maintenance team'),
                   ('management','Management - HODs and senior managers')]:
    try:
        cur.execute("INSERT INTO email_groups (name, description) VALUES (%s,%s)", (name, desc))
        conn.commit()
    except: pass

print("[OK] Email tables created")
cur.execute("SHOW TABLES")
print("Tables:", [r[0] for r in cur.fetchall()])
cur.close()
conn.close()
