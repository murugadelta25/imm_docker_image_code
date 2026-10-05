# EAP PMS â€” Ubuntu Deployment

Deploy on Ubuntu IPC/server using **git clone** (recommended) or a **zip package** from Windows.

**Repository:** https://github.com/murugadelta25/eap_imm_pms.git

## Ports (IMM â€” do not use PMS 5173 / 8030)

| Service  | Port |
|----------|------|
| Backend  | 8040 |
| Frontend | 5174 |

## Option A â€” Git clone on Ubuntu (recommended for IPC server)

On the Ubuntu IPC/server:

```bash
# One-time: install git
sudo apt update && sudo apt install -y git

# Clone (or update) the repository
git clone https://github.com/murugadelta25/eap_imm_pms.git
cd eap_imm_pms

# First deploy
chmod +x run.sh scripts/*.sh start.sh
./run.sh

# Later updates (pull latest code and restart)
git pull origin main
./run.sh restart
```

Pre-configure before first `./run.sh` (optional):

```bash
cp deploy.env.example deploy.env
nano deploy.env   # CLIENT_NAME, DB_PASS, DB_NAME
```

See [DOMAIN-SETUP.md](DOMAIN-SETUP.md) for `din.eappms` DNS and nginx.

## Option B â€” Zip package from Windows

## 1. Create the package (Windows)

From the project root:

```powershell
.\package.ps1
```

This creates `eap-pms.zip` with only runtime files (no `venv`, `node_modules`, secrets, or dev clutter).

## 2. Transfer to Ubuntu

```bash
scp eap-pms.zip user@<server-ip>:~/
```

On the server:

```bash
unzip eap-pms.zip
cd eap-pms
```

## 3. Configure (optional)

On first run, `./run.sh` prompts for:

| Input | Purpose |
|-------|---------|
| **Client name** | Labels systemd services (e.g. `acme-corp-backend`) |
| **MySQL password** | Database root/user password |
| **Database name** | MySQL database (default: `eap_pms_<client>`) |

Or pre-configure before first run:

```bash
cp deploy.env.example deploy.env
nano deploy.env   # set CLIENT_NAME, DB_PASS, DB_NAME
```

Values are saved to `deploy.env` and `database/db.config.json`.

## 4. Run the application

```bash
chmod +x run.sh scripts/*.sh
./run.sh
```

`run.sh` will:

1. Install system packages (Python 3, Node.js 20, MySQL client, curl)
2. Create Python venv and install `requirements.txt`
3. Run `npm install` in `frontend/`
4. Apply `database/schema.sql` and migrations
5. Install **systemd** units named from client (e.g. `acme-corp-backend`, `acme-corp-frontend`)
6. Start services, verify they are running, and print dashboard URLs

If the database already exists, setup skips creation and shows: **Database already available**.

## 5. Service management

Service names use the **client name** (lowercase, hyphenated):

```bash
# Example for client "Acme Corp":
sudo systemctl status acme-corp-backend
sudo systemctl status acme-corp-frontend
sudo systemctl stop acme-corp-backend acme-corp-frontend
```

Or use run.sh helpers:

```bash
./run.sh status    # service status
./run.sh restart   # restart after code update
./run.sh stop      # stop services
./run.sh logs      # tail journal logs
```

Services auto-start on boot after the first `./run.sh`.

## 6. Access

- **Standard URL:** `http://din.eappms` (configured automatically by `./run.sh` via nginx)
- **API docs:** `http://din.eappms/docs`
- **Fallback:** `http://<server-ip>:5174`
- **DNS:** Ask IT for `din.eappms` A â†’ server IP (see `DOMAIN-SETUP.md`)

### Embed mode (CPLM integration)

Hide navigation when embedded in another app:

| Method | Example |
|--------|---------|
| URL param | `?embed=1` or `?hideNav=1` |
| Env (build) | `VITE_EMBED_INTEGRATION=true` |
| iframe | Auto-detected |
| Parent frame | `postMessage({ type: 'titan-shell-nav', hidden: true })` |

App bar shows **Nav On/Off** toggle in integration mode.

### Branding

- Set site title in **Factory Setup** or via `VITE_APP_NAME` at build time
- Backend env: `SITE_TITLE=Your Plant Name (PMS)`

Default users (from `database/schema.sql` / seed):

- `operator1` / `op123`
- `admin` â€” check schema seed for password hash

## 7. Firewall

If UFW is enabled, ports 8040 and 5174 are opened automatically during dependency install.

```bash
sudo ufw allow 5174/tcp
sudo ufw allow 8040/tcp
```

## Files included in package

```
eap-pms/
â”œâ”€â”€ backend/          # FastAPI app
â”œâ”€â”€ frontend/         # React + Vite
â”œâ”€â”€ database/         # schema.sql, migrations, examples
â”œâ”€â”€ scripts/          # install-deps, setup-database, install-systemd
â”œâ”€â”€ run.sh            # main launcher
â”œâ”€â”€ deploy.sh         # wrapper â†’ run.sh
â”œâ”€â”€ deploy.env.example
â””â”€â”€ DEPLOY-UBUNTU.md
```

## Troubleshooting

**Backend won't start**

```bash
sudo journalctl -u titan-backend -n 50
tail -f backend.log
```

Check `backend/.env` â€” `DATABASE_URL` must match your MySQL user/password.

**Frontend won't start**

```bash
sudo journalctl -u groz-frontend -n 50
cd frontend && npm install && npm run build && npm run preview -- --host 0.0.0.0 --port 5174
```

**`$RefreshSig$ is not defined` in browser (AuthContext.jsx)**

The frontend systemd unit is still running `npm run dev` with `NODE_ENV=production`. Reinstall the unit and restart:

```bash
bash scripts/install-systemd.sh
sudo systemctl daemon-reload
sudo systemctl restart groz-frontend
curl -s http://localhost:5174/ | grep -E '/assets/.*\.js'   # should match; must NOT show /src/main.jsx
```

Or run `./run.sh restart` after copying the updated `scripts/` and `run.sh` from the latest package.

**API returns 500 (`/api/config/branding`, `/api/auth/login`)**

`/health` can pass while the database is misconfigured â€” API routes need MySQL. Usually `backend/.env` has a stale `DATABASE_URL` (wrong database name or password).

```bash
# Diagnose
curl -s http://localhost:8040/health
curl -s http://localhost:8040/health/db
curl -s http://localhost:8040/api/config/branding
grep DATABASE_URL backend/.env
cat database/db.config.json

# Fix: sync DATABASE_URL from db.config.json and restart backend
python3 - <<'PY'
import json, urllib.parse
from pathlib import Path
cfg = json.load(open("database/db.config.json"))
enc = urllib.parse.quote(cfg["password"], safe="")
url = f"mysql+pymysql://{cfg['user']}:{enc}@localhost:3306/{cfg['database']}"
lines = Path("backend/.env").read_text().splitlines()
out = [f"DATABASE_URL={url}" if l.startswith("DATABASE_URL=") else l for l in lines]
if not any(l.startswith("DATABASE_URL=") for l in out):
    out.insert(0, f"DATABASE_URL={url}")
Path("backend/.env").write_text("\n".join(out) + "\n")
print("Updated:", url)
PY
sudo systemctl restart groz-backend
curl -s http://localhost:8040/health/db
```

Default login after seed: `operator1` / `op123` (not `opt123`).

**MySQL connection failed**

```bash
sudo systemctl status mysql
mysql -u root -p -e "SHOW DATABASES;"
```

Update `deploy.env` and `backend/.env`, then `./run.sh restart`.

