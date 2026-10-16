-- Migration: Add email_logs table
USE eap_pms;

CREATE TABLE IF NOT EXISTS email_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recipients TEXT,
    subject VARCHAR(255),
    report_type VARCHAR(50),
    status VARCHAR(20) DEFAULT 'sent',
    error_msg TEXT,
    sent_by INT,
    FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
);
