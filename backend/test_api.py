from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
r = client.post('/api/auth/login', data={'username': 'admin', 'password': 'admin123'})
print('Status:', r.status_code)
print('Body:', r.text)
