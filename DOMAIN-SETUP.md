# Standard URL â€” `din.eappms`

> **Browser error `DNS_PROBE_FINISHED_NXDOMAIN`?**  
> `din.eappms` is **not on the public internet**. Each PC must map the name to your IPC server IP (see [Fix NXDOMAIN](#fix-dns_probe_finished_nxdomain) below).

EAP PMS is configured to open at a **fixed standard URL**:

| Mode | URL |
|------|-----|
| HTTP (default) | **http://din.eappms** |
| HTTPS (optional) | **https://din.eappms** |

Running **`run.ps1`** (Windows) or **`./run.sh`** (Ubuntu) automatically:

1. Starts backend (`8040`) and frontend (`5174`)
2. Installs/configures **nginx** reverse proxy on port **80** (and **443** when HTTPS certs exist)
3. Maps the domain on the **server** (`hosts` / `/etc/hosts`)
4. Prints the standard URL (no IP or `:5174` in the main link)

Configuration file: **`deploy/domain.config.json`**

```json
{
  "domain": "din.eappms",
  "useHttps": false,
  "sslCert": "/etc/ssl/certs/din.eappms.crt",
  "sslKey": "/etc/ssl/private/din.eappms.key"
}
```

---

## Network-wide access (PC, Android, tablets)

`run.ps1` / `run.sh` now start a **LAN DNS service** on the IPC server so `din.eappms` can resolve for every device on the LAN.

### One-time router / IT setup (recommended)

Ask IT to set the **DHCP DNS server** on the factory WiFi/LAN to the **IPC IP**:

```
DHCP DNS server = 10.151.47.6
```

After that, **all devices** (Windows PCs, Android phones, tablets) open:

```
http://din.eappms
```

No hosts file or per-PC scripts needed.

### What the application does automatically (IPC server)

| Step | Service | Port |
|------|---------|------|
| nginx reverse proxy | `http://din.eappms` | 80 |
| LAN DNS | `din.eappms` -> IPC IP | 53 |
| Backend API | proxied via nginx | 8040 |
| Frontend | proxied via nginx | 5174 |

Optional: pin a fixed IPC IP in `deploy/domain.config.json` (recommended for production with DHCP reservation):

```json
"lanIp": "10.151.47.6"
```

Leave `"lanIp": ""` for **auto-detect** â€” LAN DNS refreshes every 30 seconds when the address changes.

### Dynamic IP (network / DHCP changes)

| Access method | What happens when IPC IP changes |
|---------------|----------------------------------|
| **Direct IP** `http://<current-ip>` | Always works â€” nginx listens on all interfaces (port 80). Use any IP shown when `run.ps1` finishes. |
| **LAN DNS** (`din.eappms` via router DHCP DNS) | DNS answers update every 30s to the new IP, but **router DHCP DNS must still point to the IPC** â€” if the IPC moved from `10.151.47.6` to `10.151.47.20`, IT must update the router (or use a **static DHCP reservation** for the IPC). |
| **Client hosts file** (`Setup-Client-PC.bat`) | Must be re-run with the new IPC IP on each PC. |
| **Login page** | Shows current LAN URLs from `GET /api/config/network` when you can reach the server. |

**Production recommendation:** reserve a static DHCP address for the IPC MAC address so the IP never changes.

**No DNS at all:** open `http://192.168.1.116` or `http://10.151.47.6` (whichever is current) from any phone or PC on the same LAN â€” port 80, no `:5174` required.

### Fallback (if router DNS cannot be changed)

Use `deploy\Setup-Client-PC.bat` (Admin) on each PC, or manual hosts entry.

---

This error means **this PC does not know what IP `din.eappms` is**. The app on the IPC server can be running fine â€” the name just is not registered on your machine.

### On the IPC server (same PC where you ran `run.ps1`)

1. Re-run **as Administrator**:
   ```powershell
   .\run.ps1
   ```
2. Or manually edit `C:\Windows\System32\drivers\etc\hosts` (Admin):
   ```
   127.0.0.1   din.eappms
   ```
3. Flush DNS: `ipconfig /flushdns`
4. Open: **http://din.eappms**

### On other PCs (operator / supervisor machines) â€” e.g. client `10.151.32.56`, IPC `10.151.47.6`

`din.eappms` is **not on the public internet**. Each client PC must map the name to the **IPC server IP** on your LAN.

**Option A â€” standalone batch file (easiest, no PowerShell policy errors)**

Copy both files to the client PC:

- `deploy\Setup-Client-PC.bat`
- `deploy\Setup-Client-PC.ps1`

**Right-click `Setup-Client-PC.bat` â†’ Run as administrator**

Default IPC IP is `10.151.47.6`. Or from an Admin command prompt:

```bat
Setup-Client-PC.bat 10.151.47.6
```

**Option A2 â€” PowerShell bypass (if you only copied the .ps1 file)**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-Client-PC.ps1 -ServerIp 10.151.47.6
```

(Run PowerShell as Administrator.)

**Option B â€” from full project folder**

```powershell
.\scripts\Register-ClientHost.ps1 -ServerIp 10.151.47.6
```

**Option C â€” manual hosts file** (Administrator)  
Edit `C:\Windows\System32\drivers\etc\hosts` on the **client PC**:

```
10.151.47.6   din.eappms
```

Then on the client:

```powershell
ipconfig /flushdns
```

Open: **http://din.eappms** (not `din.eappms/login` until the site loads)

**Use the IPC IP on the same network as the client.** If the server shows both `192.168.1.116` and `10.151.47.6`, PCs on `10.151.32.x` should use **`10.151.47.6`**, not the 192.168 address.

### For the whole factory (best)

Ask IT for an **internal DNS A record**:

```
din.eappms   A   <ipc-server-ip>
```

No hosts file needed on each PC after that.

### Until DNS is ready â€” use IP directly

```
http://<ipc-server-ip>:5174
```

or (if nginx on IPC is working):

```
http://<ipc-server-ip>
```

---

## Quick start

### Windows

```powershell
# Run as Administrator (recommended â€” port 80 + hosts file)
.\run.ps1
```

Open: **http://din.eappms**

### Ubuntu

```bash
chmod +x run.sh scripts/*.sh
./run.sh
```

Open: **http://din.eappms**

---

## Architecture

```mermaid
flowchart LR
    User["Browser\ndin.eappms"] --> Nginx["nginx :80 / :443"]
    Nginx -->|"/"| FE["Frontend :5174"]
    Nginx -->|"/api /ws /static"| BE["Backend :8040"]
```

| Path | Proxied to |
|------|------------|
| `/` | Frontend (React) |
| `/api/*` | FastAPI |
| `/ws` | WebSocket |
| `/static/*` | Uploaded files |
| `/docs` | API documentation |

---

## DNS for other PCs on the factory LAN

`run.ps1` / `run.sh` configure nginx **on the server**. Other computers still need DNS so `din.eappms` resolves to the app server IP.

Ask IT to add an **internal DNS A record**:

```
din.eappms   A   <server-ip>
```

Example: if the Ubuntu server is `192.168.1.116`:

```
din.eappms   A   192.168.1.116
```

After DNS propagates, every PC on the network opens **http://din.eappms** without typing an IP or port.

### Single-PC test (no DNS yet)

**Windows** (Administrator) â€” `C:\Windows\System32\drivers\etc\hosts`:

```
192.168.1.116   din.eappms
```

**Ubuntu** â€” `/etc/hosts` (added automatically by `install-nginx.sh` on the server):

```
192.168.1.116   din.eappms
```

---

## HTTPS

1. Obtain a certificate (company CA or Let's Encrypt).
2. Edit `deploy/domain.config.json`:

```json
{
  "domain": "din.eappms",
  "useHttps": true,
  "sslCert": "/path/to/fullchain.pem",
  "sslKey": "/path/to/privkey.pem"
}
```

3. Re-run:

```bash
./run.sh restart
```

or on Windows, re-run `.\run.ps1` (or `scripts\Install-Nginx.ps1`).

**Let's Encrypt (Ubuntu, public DNS):**

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d din.eappms
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| nginx fails on Windows | Run PowerShell **as Administrator** (port 80, hosts, firewall) |
| Port 80 already in use | Stop IIS/skype/other web server, or change IIS binding |
| `din.eappms` works on server only | Add internal DNS A record for other PCs |
| Login/API fails | Confirm nginx proxies `/api/` to port 8040 |
| Still need fallback | `http://<ip>:5174` always works |

**Stop nginx (Windows portable):**

```powershell
.\deploy\nginx-win\nginx.exe -p .\deploy\nginx-win -s quit
```

**Reload nginx (Ubuntu):**

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Related files

| File | Purpose |
|------|---------|
| `deploy/domain.config.json` | Domain name and HTTPS settings |
| `deploy/nginx-site.conf.template` | Ubuntu nginx site template |
| `scripts/install-nginx.sh` | Ubuntu nginx setup (called by `run.sh`) |
| `scripts/Install-Nginx.ps1` | Windows nginx setup (called by `run.ps1`) |
| `deploy/nginx-win/` | Windows nginx (downloaded on first run) |

