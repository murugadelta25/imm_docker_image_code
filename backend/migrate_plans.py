import pymysql

conn = pymysql.connect(host='localhost', user='root', password='Mysql@2026', db='eap_pms', charset='utf8mb4')
cur = conn.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS production_plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    plan_date DATE NOT NULL,
    shift CHAR(1) NOT NULL,
    pair_no INT NOT NULL,
    machine_id INT,
    ip_stock_no VARCHAR(50) NOT NULL,
    op_stock_no VARCHAR(50) NOT NULL,
    process_time INT NOT NULL,
    loading_unloading INT NOT NULL DEFAULT 10,
    planned_qty INT NOT NULL,
    actual_qty INT NOT NULL DEFAULT 0,
    priority INT NOT NULL DEFAULT 1,
    status ENUM('pending','running','completed','paused','cancelled') DEFAULT 'pending',
    plan_type ENUM('scheduled','urgent','trial') DEFAULT 'scheduled',
    notes TEXT,
    created_by INT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
)
""")
conn.commit()
print("[OK] production_plans table created")

# Verify
cur.execute("SHOW TABLES")
print("Tables:", [r[0] for r in cur.fetchall()])
cur.close()
conn.close()
