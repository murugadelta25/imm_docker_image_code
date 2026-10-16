import pymysql

conn = pymysql.connect(host='localhost', user='root', password='Mysql@2026', db='eap_pms', charset='utf8mb4')
cur = conn.cursor()

# Create pairs table
cur.execute("""
CREATE TABLE IF NOT EXISTS pairs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
""")

# Add pair_id column to machines table if it doesn't exist
cur.execute("SHOW COLUMNS FROM machines WHERE Field='pair_id'")
if not cur.fetchone():
    # First, we need to get max pair_no to create initial pairs
    cur.execute("SELECT DISTINCT pair_no FROM machines ORDER BY pair_no")
    existing_pairs = [row[0] for row in cur.fetchall()]
    
    # Create pairs for existing pair numbers
    for pair_no in existing_pairs:
        pair_name = f"pair_{pair_no}"
        display_name = f"Pair {pair_no}"
        try:
            cur.execute("INSERT INTO pairs (name, display_name) VALUES (%s, %s)", 
                       (pair_name, display_name))
            conn.commit()
        except:
            pass
    
    # Add pair_id column
    cur.execute("""
    ALTER TABLE machines 
    ADD COLUMN pair_id INT AFTER pair_no
    """)
    
    # Populate pair_id from pair_no
    cur.execute("""
    UPDATE machines m 
    JOIN pairs p ON CAST(SUBSTRING(p.name, 6) AS UNSIGNED) = m.pair_no
    SET m.pair_id = p.id
    """)
    
    conn.commit()
    
    # Now we can drop pair_no column (optional - keeping for backward compatibility)
    # cur.execute("ALTER TABLE machines DROP COLUMN pair_no")
    
    # Add foreign key constraint
    try:
        cur.execute("""
        ALTER TABLE machines 
        ADD CONSTRAINT fk_machines_pair_id 
        FOREIGN KEY (pair_id) REFERENCES pairs(id)
        """)
        conn.commit()
    except:
        pass

print("[OK] Pairs table created and machines migrated")
cur.execute("SHOW TABLES")
print("Tables:", [r[0] for r in cur.fetchall()])
cur.close()
conn.close()
