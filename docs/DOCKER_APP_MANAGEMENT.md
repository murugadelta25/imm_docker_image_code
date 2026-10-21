# IMM EAP PMS — Docker Image & App Management Hosting

Software-architecture packaging for deploying **IMM PMS** on an SIE / EAP+ **Ubuntu gateway** via **App Management** (Kubernetes), per *App Management Guide V2*.

---

## Architecture decision

| Layer | Choice | Why |
|-------|--------|-----|
| App image | **One image**: nginx (UI `:80`) + uvicorn (API `127.0.0.1:8040`) | Matches App Management “one deployable app”; same-origin `/api` `/ws` `/static` |
| Database | **External MySQL by default** | Data survives redeploy; App Management ConfigMap can point to site DB |
| Optional | MySQL **sidecar** in same pod (`appzip/imm-pms-with-mysql`) | Lab/demo only unless you attach a **PVC** |
| Secrets | ConfigMap / env at deploy time | Never bake real `SECRET_KEY` / DB passwords into the image |

```
Browser / Ingress / NodePort
        │
        ▼
   nginx :18080  (in imm-pms container; avoids host :80 / :8080 clash with hostNetwork)
    ├─ /           → React SPA
    ├─ /api /ws /static /health → uvicorn 127.0.0.1:18040
        │
        ▼
   MySQL (external host OR sidecar 127.0.0.1:3306)
```

**CrashLoop tip (hostNetwork):** Do **not** bind to host `:8040` / `:8080` if other services already use them. The image uses API **18040** and UI **18080**.

**Can the database live inside the application image?**  
**No — not recommended.** Putting MySQL *inside the same Docker image filesystem* loses all data when the container is replaced. Valid options:

1. **External MySQL** (recommended) — `DATABASE_URL` → gateway / LAN MySQL  
2. **MySQL sidecar container** in the pod — same App Management deployment, data on a volume/PVC  
3. **Separate MySQL App Management app** (StatefulSet) — advanced; same as guide DB lifecycle chapter  

---

## Prerequisites

- Docker Engine on the build PC  
- EAP+ console with **App Management**  
- Target site = Ubuntu gateway (Master or Node)  
- For external DB: MySQL reachable from the pod network  

---

## 1. Build the Docker image

### A) Local / NodePort (UI at `/`)

```powershell
cd "D:\Project documents\2026\EAP-PMS_IMM\EAP_IMM_PMS_code"
docker build -t imm-pms:v1.0.0 .
```

### B) App Management Ingress path

Guide URL pattern:

`http://{site-host}/app/{app-name}/{app-tag}/{service-name}/`

For `imm-pms` / `v1` / `imm-pms`:

```powershell
docker build --build-arg VITE_BASE=/app/imm-pms/v1/imm-pms/ -t imm-pms:v1.0.0 .
```

### Smoke-test on the build machine

```powershell
copy docker\.env.docker.example docker\.env.docker
# Edit DATABASE_URL / SECRET_KEY in docker\.env.docker

# External MySQL already running on host:
docker compose -f docker/docker-compose.yml up --build

# OR bundled MySQL for lab:
docker compose -f docker/docker-compose.yml --profile with-mysql up --build
```

Open: `http://localhost:18080`

---

## 2. Pack for App Management (zip + image tar)

### One-shot script (Windows)

```powershell
# External DB pack (recommended)
.\scripts\build-docker-appzip.ps1 -ViteBase "/" -Variant external-db

# Ingress-ready frontend base
.\scripts\build-docker-appzip.ps1 -ViteBase "/app/imm-pms/v1/imm-pms/" -Variant external-db
```

### Linux / Ubuntu

```bash
chmod +x scripts/build-docker-appzip.sh
VITE_BASE=/app/imm-pms/v1/imm-pms/ VARIANT=external-db ./scripts/build-docker-appzip.sh
```

Output:

- `appzip/imm-pms-external-db/imm-pms-v1.0.0.tar`  
- `appzip/imm-pms-external-db-v1.0.0.zip`  

Zip contents (Guide V2):

| File | Required |
|------|----------|
| `metadata.json` | Yes |
| `deployment.yaml` | Yes |
| `service.yaml` | Yes |
| `configmap.yaml` | Recommended |
| `imm-pms-v1.0.0.tar` | Yes for offline import |

---

## 3. Configure before upload

Edit `appzip/imm-pms-external-db/configmap.yaml` (then rebuild zip if already packed):

```yaml
# hostNetwork: true (default in deployment.yaml) → MySQL on same gateway → 127.0.0.1
DATABASE_URL: "mysql+pymysql://root:Mysql%402026@127.0.0.1:3306/plastech_solution_imm_pms"
SECRET_KEY: "<long-random>"
NODE_RED_WEBHOOK_SECRET: "<random>"
MACHINE_STATUS_PUSH_SECRET: "<random>"
CORS_ORIGINS: "http://<site-host>"   # or * for open LAN
```

Password encoding: `@` → `%40`.

| MySQL location | `DATABASE_URL` host |
|----------------|---------------------|
| Same gateway + `hostNetwork: true` (current pack) | `127.0.0.1` |
| Same gateway **without** hostNetwork | Gateway LAN IP (pod cannot use host `localhost`) |
| Different machine | That machine’s LAN IP / hostname |

### Your current gateway reference values

| Key | Value |
|-----|-------|
| `DATABASE_URL` | `mysql+pymysql://root:Mysql%402026@127.0.0.1:3306/plastech_solution_imm_pms` |
| DB name | `plastech_solution_imm_pms` (already created on gateway) |
| `SECRET_KEY` | `eap_pms_Plastech_Solutions_Pune_secret` |
| `NODE_RED_WEBHOOK_SECRET` | not set (empty) |
| `MACHINE_STATUS_PUSH_SECRET` | supported by code; set in ConfigMap for prod |
| `CORS_ORIGINS` | `*` (open LAN) |

If root password on the gateway is **not** `Mysql@2026`, change the ConfigMap password segment and re-zip / update ConfigMap in App Management.

---

## 4. Host in App Management (UI steps)

1. EAP+ console → **App Management** → **Create / Upload**  
2. Upload `imm-pms-external-db-v1.0.0.zip`  
3. Wait until image import finishes  
4. **Deploy** → select Ubuntu **gateway site** (Node or Master)  
5. **Deployed App** → wait Pod **Running** / container **Running**  
6. Open **View configmap** if you need to fix `DATABASE_URL` after deploy  
7. Expose the UI:

### Option A — Ingress (path prefix)

1. **Add Rule** → service `imm-pms` → path `/`  
2. Enable **Ingress**  
3. Open:  
   `http://{site-host}/app/imm-pms/v1/imm-pms/`  
4. Frontend must have been built with matching `VITE_BASE`

### Option B — NodePort (no path prefix)

1. **Configure node port** (range 30000–32768), e.g. `30040`  
2. Open: `http://{gateway-ip}:30040/`  
3. Build with `VITE_BASE=/`

### Device data (Node-RED → IMM)

1. Rule on `POST /api/imm/nodered/webhook/push`  
2. Register device data stream if required by EDA  
3. Header: `X-Webhook-Secret: <NODE_RED_WEBHOOK_SECRET>`  
4. Machine status: `PATCH /api/machines/{id}/status` with `X-Machine-Push-Secret` or `X-Webhook-Secret`

---

## 5. Database options — detailed steps

### Option A — External MySQL (recommended)

**When:** Production / factory gateway already has MySQL (your present scenario).

1. Ensure DB exists, e.g. `plastech_solution_imm_pms` (confirmed on gateway).  
2. With **current** `deployment.yaml` (`hostNetwork: true`), app reaches MySQL at `127.0.0.1:3306` — no extra remote-grant step for localhost.  
3. If you remove hostNetwork later: set `bind-address`, allow user from pod CIDR/`%`, open firewall, and put **gateway LAN IP** in `DATABASE_URL`.  
4. Set ConfigMap (`appzip/imm-pms-external-db/configmap.yaml`):
   ```text
   DATABASE_URL=mysql+pymysql://root:Mysql%402026@127.0.0.1:3306/plastech_solution_imm_pms
   ```
5. Deploy **external-db** app zip (no MySQL sidecar).  
6. Verify: pod logs show uvicorn started; `GET /health/db` OK.  
7. First login / schema: run existing migrations against that DB once if tables are empty (same as bare-metal deploy).

**Pros:** durable data, backup with site MySQL, simple app pod.  
**Cons:** without hostNetwork, network/firewall must allow pod → MySQL.

### Option B — MySQL sidecar in the same App Management pod

**When:** Lab / POC with no external DB.

1. Use `appzip/imm-pms-with-mysql/`  
2. On gateway: `docker pull mysql:8.0` (so the node has the image)  
3. Build/pack:
   ```powershell
   .\scripts\build-docker-appzip.ps1 -Variant with-mysql
   ```
4. ConfigMap already points `DATABASE_URL` at `127.0.0.1:3306`  
5. **Before production:** change `mysql-data` volume from `emptyDir` to a **PersistentVolumeClaim** (otherwise DB is wiped on pod delete)  
6. Upload zip → deploy  

**Pros:** single deployable unit for demos.  
**Cons:** heavier pod; must manage PVC; MySQL image not usually inside `imm-pms` tar.

### Option C — MySQL “inside” the imm-pms image?

**Do not do this for production.** Embedding a MySQL datadir in the image:

- Loses writes on every new image version  
- Inflates image size  
- Breaks App Management upgrade model  

If you need “all-in-one” for a USB demo only, use **docker compose `--profile with-mysql`** on a single host — not the App Management production path.

---

## 6. Registry alternative (no tar in zip)

If the gateway can reach the master registry:

```bash
docker tag imm-pms:v1.0.0 master:32000/imm-pms:v1.0.0
docker push master:32000/imm-pms:v1.0.0
```

In `deployment.yaml` set:

```yaml
image: master:32000/imm-pms:v1.0.0
```

And remove / empty `images` tar from `metadata.json` (or follow site practice for remote images). Zip then only needs YAML + metadata.

---

## 7. Upgrade

1. Bump code → rebuild image `imm-pms:v1.1.0`  
2. Update `metadata.json` `version` + tar name  
3. New zip → upload → Deploy (same name+tag redeploys, or new tag)  
4. Wait for rolling replace; refresh Ingress/NodePort URL  

---

## 8. File map

| Path | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage IMM image |
| `docker/nginx.conf` | Reverse proxy UI ↔ API |
| `docker/entrypoint.sh` | Start uvicorn + nginx |
| `docker/docker-compose.yml` | Local smoke test ± MySQL |
| `docker/.env.docker.example` | Compose env template |
| `appzip/imm-pms-external-db/` | App Management pack (external DB) |
| `appzip/imm-pms-with-mysql/` | App Management pack (MySQL sidecar) |
| `scripts/build-docker-appzip.ps1` | Windows build + zip |
| `scripts/build-docker-appzip.sh` | Linux build + zip |

---

## 9. Quick decision guide

| Goal | Use |
|------|-----|
| Factory gateway + existing MySQL | `external-db` zip + ConfigMap `DATABASE_URL` |
| Demo without MySQL installed | compose `--profile with-mysql` or `with-mysql` zip + PVC later |
| Open via portal Ingress path | Build with `VITE_BASE=/app/imm-pms/v1/imm-pms/` |
| Open via NodePort `30040` | Build with `VITE_BASE=/` |