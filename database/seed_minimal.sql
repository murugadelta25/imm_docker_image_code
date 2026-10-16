-- Default admin users (only when users table is empty)
INSERT IGNORE INTO users (username, password_hash, role) VALUES
('admin',        '$2b$12$g5Tk5v/xj0VXC4/LwScqIuJ6W.d7v8Q.ymO5q2ZU8rpsEZmOOkkom', 'admin'),
('supervisor1',  '$2b$12$2FUlqfW2AteU3Kn8yAtVO.oizca0K/vWKi0KPJG00491J4uVfLov2', 'supervisor'),
('operator1',    '$2b$12$5cCX/Gg8yUgKbcgfpKfhzuTTnT6EaO7sEkoF0BnUwfuQNHozYh6T2', 'operator'),
('maintenance1', '$2b$12$/fydcr3PgUyRhg2wxcc24eQP5xoqRPSp1386pzl0qfXMTU13LShxy', 'maintenance');

INSERT INTO email_smtp_config (smtp_server, smtp_port)
  SELECT 'smtp.gmail.com', 587 FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM email_smtp_config LIMIT 1);
