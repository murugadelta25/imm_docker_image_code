"""Migration: create machine_kpi_log table for historic KPI storage."""
import os, sys
from pathlib import Path
from dotenv import load_dotenv

_env = Path(__file__).resolve().parent / ".env"
load_dotenv(_env, encoding="utf-8-sig")

from sqlalchemy import create_engine, text, inspect

DATABASE_URL = os.getenv("DATABASE_URL")
engine = create_engine(DATABASE_URL, pool_pre_ping=True)

DDL = """
CREATE TABLE IF NOT EXISTS machine_kpi_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    machine_id      INT NOT NULL,
    entry_date      DATE NOT NULL,
    shift           VARCHAR(1) NOT NULL,
    model_variant   VARCHAR(100),
    available_time_min   FLOAT,
    operating_time_min   FLOAT,
    downtime_min         FLOAT,
    actual_production_time_min FLOAT,
    cycle_time_sec       FLOAT,
    planned_qty     INT,
    actual_qty      INT,
    good_qty        INT,
    defect_qty      INT,
    expected_qty    INT,
    theoretical_qty INT,
    ar              FLOAT,
    pr              FLOAT,
    qr              FLOAT,
    oee             FLOAT,
    machine_utilization FLOAT,
    production_yield    FLOAT,
    teep            FLOAT,
    computed_at     DATETIME NOT NULL,
    source          VARCHAR(20) DEFAULT 'auto',
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    INDEX idx_kpi_machine_date (machine_id, entry_date, shift)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
"""

if __name__ == "__main__":
    inspector = inspect(engine)
    if inspector.has_table("machine_kpi_log"):
        print("Table machine_kpi_log already exists.")
    else:
        with engine.begin() as conn:
            conn.execute(text(DDL))
        print("Created table machine_kpi_log.")
