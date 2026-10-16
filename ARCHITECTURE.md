# EAP PMS â€” System Architecture Document

**Product name:** EAP PMS (also branded **Titan OEE**)  
**Document version:** 1.0  
**Last updated:** July 2026  

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Context](#2-system-context)
3. [Technology Stack](#3-technology-stack)
4. [High-Level Architecture](#4-high-level-architecture)
5. [Application Startup Flow](#5-application-startup-flow)
6. [Frontend Architecture](#6-frontend-architecture)
7. [Backend Architecture](#7-backend-architecture)
8. [Authentication & Authorization Flow](#8-authentication--authorization-flow)
9. [REST API Request Flow](#9-rest-api-request-flow)
10. [Real-Time (WebSocket) Flow](#10-real-time-websocket-flow)
11. [Database Architecture](#11-database-architecture)
12. [OEE Data Flow](#12-oee-data-flow)
13. [Production Planning Flow](#13-production-planning-flow)
14. [QC Inspection & Approval Flow](#14-qc-inspection--approval-flow)
15. [Breakdown & Machine Status Flow](#15-breakdown--machine-status-flow)
16. [Deviation Alert & Escalation Flow](#16-deviation-alert--escalation-flow)
17. [Email & Scheduler Flow](#17-email--scheduler-flow)
18. [Static File & Upload Flow](#18-static-file--upload-flow)
19. [Deployment Architecture](#19-deployment-architecture)
20. [Configuration Reference](#20-configuration-reference)
21. [API Endpoint Index](#21-api-endpoint-index)
22. [Source Code Layout](#22-source-code-layout)
23. [Design Principles & Constraints](#23-design-principles--constraints)

---

## 1. Executive Summary

EAP PMS is a **factory production management system** designed for manufacturing environments. It digitizes shop-floor operations including:

- **OEE tracking** (Availability, Performance, Quality)
- **Production planning** and work order management
- **Hourly output** monitoring
- **Quality control** inspections with SPC charts and multi-level approval
- **Work instructions** and part master data
- **Breakdown** and maintenance workflows
- **Loss tracking** with machine status timelines
- **Automated email reports** and deviation alerts

The system follows a classic **three-tier architecture**:

| Tier | Technology | Port |
|------|------------|------|
| Presentation | React 19 SPA (Vite) | 5174 |
| Application | Python FastAPI | 8040 |
| Data | MySQL 8.x | 3306 |

All business time calculations use **IST (Asia/Kolkata)** timezone.

---

## 2. System Context

The system serves multiple user roles on the shop floor and in management. External systems (PLC bridges, Node-RED, MQTT) can push machine status via the API.

```mermaid
flowchart TB
    subgraph Actors["Human Actors"]
        OP["Operator"]
        SUP["Supervisor"]
        QC["Quality Inspector"]
        MAINT["Maintenance"]
        ADM["Administrator"]
    end

    subgraph EAP["EAP PMS System"]
        FE["React Frontend :5174"]
        BE["FastAPI Backend :8040"]
        DB[("MySQL eap_pms")]
        FS["Local File Storage"]
    end

    subgraph External["External Integrations"]
        PLC["PLC / MQTT / Modbus Bridge"]
        SMTP["SMTP Mail Server"]
        NR["Node-RED / Custom Scripts"]
    end

    OP & SUP & QC & MAINT & ADM --> FE
    FE --> BE
    BE --> DB
    BE --> FS
    PLC & NR -->|"PATCH /api/machines/{id}/status"| BE
    BE --> SMTP
```

**Explanation:** Operators enter production data through the browser. Supervisors approve QC and manage planning. Maintenance handles breakdowns. Administrators configure machines, users, and site settings. PLC bridges can push live machine status without going through the UI. The backend sends scheduled and alert emails via SMTP.

---

## 3. Technology Stack

### 3.1 Frontend

| Layer | Technology | Version | Role |
|-------|------------|---------|------|
| UI Framework | React | 19.2 | Component-based single-page application |
| Routing | React Router DOM | 7.15 | Client-side navigation, protected routes |
| Build Tool | Vite | 8.0 | Dev server, HMR, production bundling |
| HTTP | axios | 1.16 | REST API calls with JWT interceptors |
| Charts | recharts | 3.8 | Dashboard and analytics visualizations |
| Spreadsheets | xlsx | 0.18 | Client-side Excel import/export |
| Dates | date-fns | 4.2 | Date formatting and manipulation |
| Language | JavaScript (JSX) | â€” | No TypeScript in this project |
| Styling | Custom CSS + JS themes | â€” | `cplm-layout.css`, `pmsThemes.js` |

### 3.2 Backend

| Layer | Technology | Version | Role |
|-------|------------|---------|------|
| API Framework | FastAPI | 0.115 | REST endpoints, OpenAPI/Swagger docs |
| ASGI Server | Uvicorn | 0.29 | HTTP and WebSocket server |
| ORM | SQLAlchemy | 2.0 | Database models and queries |
| DB Driver | PyMySQL | 1.1 | MySQL connectivity |
| Auth | python-jose + bcrypt | 3.3 / 4.0 | JWT tokens and password hashing |
| Validation | Pydantic | 2.10 | Request/response schemas |
| Scheduler | APScheduler | 3.10 | Cron email jobs, interval deviation scans |
| Reports | openpyxl | 3.1 | Server-side XLSX report generation |
| Timezone | pytz | 2024 | IST datetime handling |
| WebSocket | websockets | 12.0 | Real-time event broadcast |
| Config | python-dotenv | 1.0 | Environment variable loading |

### 3.3 Data & Infrastructure

| Component | Technology | Role |
|-----------|------------|------|
| Database | MySQL 8.x | Relational data store (`eap_pms`) |
| File Storage | Local filesystem | PDFs, images under `backend/static/` |
| Dev Launcher | PowerShell (`run.ps1`) | Windows one-command startup |
| Prod Launcher | Bash (`run.sh`) | Ubuntu deployment |
| Packaging | `PACKAGE.ps1` | Creates portable `eap-pms.zip` |

### 3.4 UI Integration Pattern

The frontend shell follows **CPLM Web UI** layout conventions (sidebar, app bar, navigation split) while preserving all original Titan OEE business logic in page files. See `TITAN-CPLM-INTEGRATION.md` for details.

---

## 4. High-Level Architecture

```mermaid
flowchart TB
    subgraph Browser["User Browser"]
        direction TB
        App["App.jsx"]
        Shell["AppShell\nSidebar + AppBar + Outlet"]
        Pages["Feature Pages"]
        Ctx["React Contexts"]
        API["axios client.js"]
        WS["useWebSocket.js"]
    end

    subgraph ViteServer["Vite Dev Server :5174"]
        ProxyAPI["Proxy /api â†’ :8040"]
        ProxyStatic["Proxy /static â†’ :8040"]
        ProxyWS["Proxy /ws â†’ :8040"]
    end

    subgraph FastAPI["FastAPI Application :8040"]
        direction TB
        Main["main.py\nlifespan + CORS + mounts"]
        Routers["REST Routers /api/*"]
        WSMgr["ws_manager.py\nConnectionManager"]
        Scheduler["scheduler_service.py\nAPScheduler"]
        Services["Domain Services\nOEE Â· QC SPC Â· Deviation Alerts"]
        StaticMount["StaticFiles /static"]
    end

    subgraph Persistence["Persistence"]
        MySQL[("MySQL\neap_pms")]
        Files["backend/static/\nmachines Â· parts Â· work-instructions"]
    end

    App --> Shell --> Pages
    Pages --> Ctx
    Pages --> API
    Pages --> WS
    API --> ProxyAPI --> Routers
    WS --> ProxyWS --> WSMgr
    ProxyStatic --> StaticMount --> Files
    Routers --> Services --> MySQL
    Routers --> Files
    Scheduler --> Services
    Scheduler --> MySQL
    Routers -.->|broadcast events| WSMgr
```

**Explanation:**

1. **Browser** renders the React SPA. Each feature page makes direct axios calls to `/api/*` endpoints.
2. **Vite** proxies API, static, and WebSocket traffic to the backend so the frontend can use relative URLs (no CORS issues on LAN).
3. **FastAPI** handles REST logic, file serving, WebSocket connections, and background jobs.
4. **MySQL** stores all transactional data. Uploaded files live on disk and are referenced by URL paths in the database.

---

## 5. Application Startup Flow

### 5.1 Development Startup (`run.ps1`)

```mermaid
flowchart TD
    A["run.ps1"] --> B["Check MySQL connection"]
    B --> C["init_database.ps1\nCreate DB + apply schema"]
    C --> D["Write frontend/.env\n(empty VITE_API_URL = use proxy)"]
    D --> E["Start uvicorn :8040\n(new PowerShell window)"]
    E --> F["Poll /health until OK"]
    F --> G["npm run dev :5174\n(new PowerShell window)"]
    G --> H["Application ready\nhttp://localhost:5174"]
```

### 5.2 Backend Lifespan (on uvicorn start)

When FastAPI starts, the `lifespan` context manager in `main.py` runs:

```mermaid
sequenceDiagram
    participant U as Uvicorn
    participant M as main.py
    participant DB as MySQL
    participant S as scheduler_service

    U->>M: Application startup
    M->>M: _ensure_work_instruction_tables()
    Note over M: Auto-run Python migrations if tables missing
    M->>M: _ensure_deviation_alert_table()
    M->>DB: Open session
    M->>S: start_scheduler(db)
    S->>DB: Load email_schedules
    S->>S: Register cron jobs + 5-min deviation scan
    M-->>U: App ready

    Note over U,M: ... application runs ...

    U->>M: Application shutdown
    M->>S: stop_scheduler()
```

**Bootstrap migrations run at startup** (if tables are missing):

| Script | Purpose |
|--------|---------|
| `migrate_work_instructions.sql` | Parts, documents, QC parameters tables |
| `migrate_qc_enhancements.py` | QC inspection enhancements |
| `migrate_quality_role.py` | Adds `quality` user role |
| `migrate_operation_code.py` | Part operation code fields |
| `migrate_work_orders.py` | Work order tables |

This design avoids manual migration steps on small deployments.

---

## 6. Frontend Architecture

### 6.1 Component Hierarchy

```mermaid
flowchart TB
    main["main.jsx"] --> App["App.jsx"]

    App --> TP["ThemeProvider"]
    TP --> AP["AuthProvider"]
    AP --> BR["BrowserRouter"]
    BR --> BP["BrandingProvider"]
    BP --> EP["EmbedProvider"]
    EP --> CP["ConfigProvider"]
    CP --> Routes["AppRoutes"]

    Routes --> Login["Login.jsx"]
    Routes --> AuthShell["AuthenticatedShell"]
    AuthShell --> AppShell["AppShell.jsx"]
    AppShell --> Sidebar["Sidebar.jsx"]
    AppShell --> AppBar["AppBar.jsx"]
    AppShell --> Outlet["<Outlet /> â†’ Feature Pages"]
```

### 6.2 Provider Responsibilities

| Context | File | Responsibility |
|---------|------|----------------|
| `ThemeProvider` | `context/ThemeContext.jsx` | Light/dark theme, color tokens |
| `AuthProvider` | `context/AuthContext.jsx` | Login, logout, user state in localStorage |
| `BrandingProvider` | `context/BrandingContext.jsx` | Factory logo, site name |
| `EmbedProvider` | `context/EmbedContext.jsx` | Integration/embed mode (hide nav) |
| `ConfigProvider` | `context/ConfigContext.jsx` | Shifts, breaks, site config from API |

### 6.3 Routing Model

Routes are defined in `App.jsx`. Navigation items are defined separately in `navigation.jsx` (CPLM pattern). Role-based filtering hides menu items the user cannot access.

```mermaid
flowchart LR
    subgraph Public
        L["/login"]
    end

    subgraph Authenticated["AuthenticatedShell (requires user)"]
        D["/dashboard"]
        P["/planning"]
        WO["/work-orders"]
        E["/entry"]
        HO["/hourly-output"]
        WI["/work-instructions"]
        QC["/qc-approvals"]
        MC["/model-change"]
        BD["/breakdown"]
        MT["/maintenance"]
        LT["/loss-tracker"]
        EM["/alerts/email"]
        US["/users"]
        PT["/parts"]
        WR["/wi-revisions"]
        MA["/machines"]
        FS["/factory-setup"]
        CF["/config"]
    end

    L -->|"success"| D
```

### 6.4 Data Fetching Pattern

Unlike CPLM Web UI (which uses React Query + service modules), EAP PMS uses **page-centric data fetching**:

- Each page imports `api` from `api/client.js`
- Pages call `api.get()`, `api.post()`, etc. directly in `useEffect` or event handlers
- No centralized cache invalidation layer
- WebSocket events trigger manual re-fetch in subscribed pages

### 6.5 API Client Behavior

```javascript
// frontend/src/api/client.js
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',  // empty = Vite proxy
  timeout: 30000,
});
```

| Behavior | Detail |
|----------|--------|
| Auth header | `Authorization: Bearer <token>` from localStorage |
| 401 response | Clears token, redirects to `/login` |
| Timeout | 30 seconds |

---

## 7. Backend Architecture

### 7.1 Layered Structure

```mermaid
flowchart TB
    subgraph HTTP["HTTP Layer"]
        R1["FastAPI Routers\nrouters/*.py"]
        R2["WebSocket /ws"]
        R3["StaticFiles /static"]
    end

    subgraph Security["Security Layer"]
        A1["get_current_user()"]
        A2["require_role()"]
    end

    subgraph Business["Business Logic"]
        B1["calculate_oee()"]
        B2["qc_shift_utils / qc_spc_utils"]
        B3["deviation_alert_service"]
        B4["scheduler_service"]
        B5["upload_limits"]
    end

    subgraph Data["Data Access"]
        D1["SQLAlchemy Models\nmodels.py"]
        D2["Session via get_db()"]
    end

    R1 --> A1 --> A2 --> B1 & B2 & B3 & B4
    B1 & B2 & B3 & B4 --> D1 --> D2
    R2 --> WSMgr["ws_manager.broadcast()"]
```

### 7.2 Router Registration

All routers are mounted in `main.py`:

| Router Module | Prefix | Domain |
|---------------|--------|--------|
| `auth.py` | `/api/auth` | Login, JWT |
| `oee.py` | `/api/oee` | OEE entries, summary, export |
| `plans.py` | `/api/plans` | Production plans |
| `work_orders.py` | `/api/work-orders` | Work orders |
| `machines.py` | `/api/machines` | Machine fleet, status push |
| `stations.py` | `/api/stations` | Production stations/lines |
| `breakdown.py` | `/api/breakdown` | Breakdown tickets |
| `model_change.py` | `/api/model-change` | Setting change requests |
| `hourly_output.py` | `/api/hourly-output` | Hourly production |
| `parts.py` | `/api/parts` | Part master, documents |
| `qc_inspection.py` | `/api/qc-inspection` | QC sheets, approvals |
| `operator_dashboard.py` | `/api/operator-dashboard` | Operator WI context |
| `users.py` | `/api/users` | User management |
| `config.py` | `/api/config` | Site configuration |
| `email_router.py` | `/api/email` | SMTP, schedules, send |
| `deviation_alerts.py` | `/api/deviation-alerts` | Threshold alerts |

### 7.3 Database Session Pattern

```python
# Dependency injection on every protected endpoint
def endpoint(db: Session = Depends(get_db), user=Depends(get_current_user)):
    ...
```

- One session per request
- Auto-closed in `finally` block
- Connection pool with `pool_pre_ping=True` and `pool_recycle=3600`

---

## 8. Authentication & Authorization Flow

### 8.1 Login Sequence

```mermaid
sequenceDiagram
    participant U as User
    participant L as Login.jsx
    participant A as axios client
    participant F as POST /api/auth/login
    participant D as MySQL users

    U->>L: Enter username + password
    L->>A: POST /api/auth/login (form-urlencoded)
    A->>F: username, password
    F->>D: SELECT user WHERE username = ?
    D-->>F: user row (password_hash, role)
    F->>F: bcrypt.verify(password, hash)
    F->>F: create_access_token({sub, role})
    F-->>A: {access_token, role, username, id}
    A-->>L: Response
    L->>L: localStorage.setItem('token', ...)
    L->>L: localStorage.setItem('user', ...)
    L->>U: Navigate to /dashboard
```

### 8.2 Token Details

| Property | Value |
|----------|-------|
| Algorithm | HS256 |
| Secret | `SECRET_KEY` from `.env` (default: `changeme`) |
| Expiry | 480 minutes (`ACCESS_TOKEN_EXPIRE_MINUTES`) |
| Payload | `{ sub: username, role: role, exp: ... }` |
| Transport | `Authorization: Bearer <token>` header |

### 8.3 Role Matrix

| Role | Access |
|------|--------|
| `operator` | Data entry, planning, hourly output, work instructions, QC entry |
| `supervisor` | Operator access + approvals, loss tracker, email alerts, part master |
| `maintenance` | Breakdown, maintenance dashboard, loss tracker |
| `quality` | QC approvals, work instructions |
| `admin` | Full access: users, machines, factory setup, configuration |

**Enforcement:** Navigation filtered in `navigation.jsx` â†’ `getNavigationForRole()`. API endpoints use `require_role('admin', 'supervisor', ...)`.

---

## 9. REST API Request Flow

```mermaid
sequenceDiagram
    participant P as React Page
    participant X as axios
    participant V as Vite Proxy
    participant F as FastAPI Router
    participant Auth as auth.py
    participant BL as Business Logic
    participant DB as MySQL

    P->>X: api.get('/api/oee?date=...')
    X->>X: Attach Bearer token
    X->>V: HTTP GET /api/oee
    V->>F: Forward to :8040
    F->>Auth: get_current_user(token)
    Auth->>DB: Load user by username from JWT
    Auth-->>F: User object
    F->>BL: Query + calculate
    BL->>DB: SQLAlchemy query
    DB-->>BL: Rows
    BL-->>F: Serialized response
    F-->>X: JSON 200
    X-->>P: response.data
```

**Error handling:**

| Status | Meaning | Frontend action |
|--------|---------|-----------------|
| 401 | Invalid/expired token | Redirect to login |
| 403 | Insufficient role | Error shown in page |
| 404 | Resource not found | Error shown in page |
| 503 | Database unavailable | `/health/db` returns error |

---

## 10. Real-Time (WebSocket) Flow

### 10.1 Connection Lifecycle

```mermaid
sequenceDiagram
    participant P as Page (Dashboard, LossTracker, etc.)
    participant H as useWebSocket hook
    participant V as Vite Proxy
    participant M as ws_manager
    participant R as Router (plans, machines, etc.)

    P->>H: useWebSocket(onMessage)
    H->>V: new WebSocket('ws://host/ws')
    V->>M: Forward connection
    M->>M: manager.connect(ws)

    Note over R,M: State change occurs
    R->>M: await manager.broadcast({type: 'plan_updated', ...})
    M->>H: JSON message to all clients
    H->>P: onMessage(data) â†’ re-fetch or update UI

    Note over H: On disconnect
    H->>H: Exponential backoff reconnect (3s â†’ 30s max)
```

### 10.2 Broadcast Event Types

| Event `type` | Source Router | Trigger |
|--------------|---------------|---------|
| `plan_created` | plans | New production plan |
| `plan_updated` | plans | Status/actual qty change |
| `plan_completed` | plans | Plan marked complete |
| `plan_deleted` | plans | Plan removed |
| `plans_bulk_rescheduled` | plans | Bulk reschedule |
| `machine_status_updated` | machines | PLC push or manual status |
| `machine_created/updated/deleted` | machines | Fleet CRUD |
| `breakdown_raised/acknowledged/...` | breakdown | Ticket lifecycle |
| `model_change_request/approved/...` | model_change | Setting change workflow |
| `station_created/updated/deleted` | stations | Station CRUD |
| `work_order_created/updated` | work_orders | Work order changes |

---

## 11. Database Architecture

### 11.1 Entity Relationship Diagram

```mermaid
erDiagram
    users ||--o{ oee_entries : creates
    users ||--o{ production_plans : creates
    users ||--o{ work_orders : creates
    users ||--o{ breakdown_tickets : raises

    stations ||--o{ machines : contains
    machines ||--o{ oee_entries : tracks
    machines ||--o{ production_plans : scheduled_on
    machines ||--o{ breakdown_tickets : has
    machines ||--o{ machine_status_log : logs
    machines ||--o{ qc_inspection_reports : inspected_on

    work_orders ||--o{ production_plans : generates
    parts ||--o{ work_orders : defines
    parts ||--o{ part_documents : has
    parts ||--o{ part_qc_parameters : defines
    parts ||--o{ qc_inspection_reports : inspected

    oee_entries ||--o{ oee_defect_log : audit

    email_groups ||--o{ email_recipients : contains
    email_schedules }o--|| email_groups : targets

    machines ||--o{ deviation_alert_log : alerts
    machine_status_log ||--o{ deviation_escalation_cases : escalates
```

### 11.2 Core Tables

| Table | Description |
|-------|-------------|
| `users` | Authentication, roles |
| `stations` | Production lines (formerly "pairs") |
| `machines` | Machine fleet with status and PLC config |
| `oee_entries` | Per-shift OEE data with computed columns |
| `oee_defect_log` | Audit when defect qty updated post-QC |
| `production_plans` | Daily shift production plans |
| `work_orders` | Production work orders |
| `model_change_requests` | Setting/model change workflow |
| `breakdown_tickets` | Maintenance breakdown lifecycle |
| `machine_status_log` | Status change history for Loss Tracker |
| `parts` | Part master data |
| `part_documents` | Control plans, WI PDFs with revisions |
| `part_qc_parameters` | QC parameter definitions per part |
| `qc_inspection_reports` | QC inspection sheets + approval JSON |
| `site_config` | JSON blob: shifts, thresholds, factory layout |
| `email_groups` | Email recipient groups |
| `email_recipients` | Individual email addresses |
| `email_schedules` | Cron schedule definitions |
| `email_smtp_config` | SMTP server credentials |
| `email_logs` | Sent email audit trail |
| `deviation_alert_log` | Deviation alert email audit |
| `deviation_escalation_cases` | Open escalation cases |

### 11.3 Generated Columns (OEE)

MySQL stores intermediate OEE calculations as **STORED GENERATED** columns in `oee_entries`:

| Column | Formula |
|--------|---------|
| `cycle_time` | `process_time + loading_unloading` |
| `total_breaks` | Sum of all break fields |
| `shift_working_minutes` | `total_minutes - total_breaks` |
| `management_loss_total` | Sum of management loss fields |
| `total_down_time` | Sum of downtime fields |
| `production_loss` | `possible_qty - actual_qty` |

The application writes only non-generated fields. AR, PR, QR, OEE are calculated in Python (`calculate_oee()`) and stored explicitly.

---

## 12. OEE Data Flow

### 12.1 OEE Calculation Pipeline

```mermaid
flowchart TD
    A["Operator enters shift data\n(Data Entry page)"] --> B["Frontend calcPreview()\nLive preview"]
    A --> C["POST /api/oee"]
    C --> D["calculate_oee() in oee.py"]
    D --> E["Compute CT, breaks, losses,\noperating time, possible qty"]
    E --> F["AR = operating / available Ã— 100"]
    E --> G["PR = actual / possible Ã— 100"]
    E --> H["QR = accepted / actual Ã— 100"]
    F & G & H --> I["OEE = AR Ã— PR Ã— QR / 10000"]
    I --> J["INSERT oee_entries"]
    J --> K["MySQL computes generated columns"]
    K --> L["Dashboard reads GET /api/oee/summary"]
```

### 12.2 OEE Formula Reference

Source of truth: `OEE-FORMULAS.txt` and `backend/app/routers/oee.py`.

| Step | Formula | Units |
|------|---------|-------|
| Cycle Time (CT) | `process_time + loading_unloading` | seconds |
| Shift Working Min | `total_minutes - total_breaks` | minutes |
| Available Shift Time | `shift_working - management_loss` | minutes |
| Operating Time | `available - total_down_time` | minutes |
| Possible Qty | `(operating_time Ã— 60) / CT` | parts |
| Accepted Qty | `actual_qty - defect_qty` | parts |
| AR | `operating / available Ã— 100` | % |
| PR | `actual / possible Ã— 100` | % |
| QR | `accepted / actual Ã— 100` | % |
| OEE | `AR Ã— PR Ã— QR / 10000` | % |

### 12.3 Defect Update Flow (Post-QC)

When QC updates defect quantity after initial OEE entry:

```mermaid
sequenceDiagram
    participant QC as QcApprovals page
    participant API as PATCH /api/oee/{id}/defect
    participant DB as oee_entries + oee_defect_log

    QC->>API: {defect_qty, note}
    API->>DB: Read current entry (before values)
    API->>API: Recalculate accp_qty, QR, OEE
    API->>DB: UPDATE oee_entries
    API->>DB: INSERT oee_defect_log (before/after audit)
    API-->>QC: Updated entry
```

---

## 13. Production Planning Flow

```mermaid
flowchart LR
    subgraph Input
        WO["Work Order\n/work-orders"]
        PM["Part Master\n/parts"]
    end

    subgraph Planning
        PP["Production Planning\n/planning"]
        API["POST /api/plans"]
        Gantt["WorkOrderGantt.jsx"]
    end

    subgraph Execution
        DE["Data Entry\n/entry"]
        HO["Hourly Output\n/hourly-output"]
    end

    WO --> PP
    PM --> PP
    PP --> API
    API --> DB[("production_plans")]
    DB --> Gantt
    DB --> DE
    DB --> HO
    API -.->|broadcast plan_created| WS["WebSocket clients"]
```

**Key operations:**

| Action | Endpoint | Effect |
|--------|----------|--------|
| Create plan | `POST /api/plans` | New row in `production_plans` |
| Update status | `PATCH /api/plans/{id}/status` | pending â†’ running â†’ completed |
| Update actual | `PATCH /api/plans/{id}/actual` | Record actual production qty |
| Reschedule | `POST /api/plans/{id}/reschedule` | Move to new date/shift/machine |
| Bulk reschedule | `POST /api/plans/bulk-reschedule` | Move multiple plans |
| Pipeline view | `GET /api/plans/pipeline/{station_no}` | Station queue for Gantt |
| Machine suggest | `GET /api/work-orders/suggest-machines` | AI-style machine recommendations |

---

## 14. QC Inspection & Approval Flow

### 14.1 Status State Machine

```mermaid
stateDiagram-v2
    [*] --> draft: Operator creates report
    draft --> in_progress: Operator fills hourly cells
    in_progress --> pending_inspector: Operator submits instance
    pending_inspector --> pending_incharge: Inspector approves
    pending_inspector --> in_progress: Inspector rejects
    pending_incharge --> closed: Incharge approves shift
    pending_incharge --> pending_inspector: Incharge rejects
    closed --> [*]
```

### 14.2 QC Data Flow

```mermaid
sequenceDiagram
    participant OP as Operator
    participant WI as Work Instructions page
    participant API as /api/qc-inspection
    participant SPC as qc_spc_utils
    participant DB as qc_inspection_reports

    OP->>WI: Select machine + part
    WI->>API: GET /active (today's report)
    API->>DB: Load or create draft
    OP->>API: PUT /draft (hourly readings)
    API->>SPC: enrich_readings_with_part_limits()
    OP->>API: POST /{id}/submit-instance
    API->>API: recompute_report_status()
    Note over API: Status â†’ pending_inspector
    API-->>WI: Updated report

    Note over API: Inspector approves
    API->>API: POST /{id}/approve-inspector
    Note over API: Status â†’ pending_incharge

    Note over API: Incharge closes shift
    API->>API: POST /{id}/close-shift
    Note over API: Status â†’ closed
```

**Key technical details:**

- Hourly instances derived from shift config (`qc_shift_utils.build_hour_slots`)
- Readings stored as JSON in `readings_json` column
- Approval state stored in `approval_json` column
- SPC charts built server-side via `build_spc_payload()` with LSL/USL from `part_qc_parameters`
- Roles: Inspector = `quality`, `supervisor`, `admin`; Incharge = `supervisor`, `admin`

---

## 15. Breakdown & Machine Status Flow

### 15.1 Breakdown Ticket Lifecycle

```mermaid
stateDiagram-v2
    [*] --> raised: Operator raises ticket
    raised --> acknowledged: Maintenance acknowledges
    acknowledged --> in_progress: Start troubleshooting
    in_progress --> resolved: Resolution recorded
    resolved --> [*]
```

Each state transition broadcasts a WebSocket event and may update machine status to `breakdown`.

### 15.2 External Status Push (PLC Integration)

```mermaid
sequenceDiagram
    participant PLC as PLC / Node-RED / MQTT
    participant API as PATCH /api/machines/{id}/status
    participant DB as machines + machine_status_log
    participant WS as WebSocket clients

    PLC->>API: {status: "running", source: "mqtt"}
    API->>API: Check active breakdown ticket
    alt Active breakdown exists
        API-->>PLC: Status unchanged (note: breakdown active)
    else No active breakdown
        API->>DB: UPDATE machines.status
        API->>DB: INSERT machine_status_log
        API->>WS: broadcast machine_status_updated
        API-->>PLC: {id, status, source}
    end
```

**Allowed statuses:** `running`, `idle`, `breakdown`, `setting_change`, `alarm`, `offline`

**PLC source field** on machines: `manual`, `mqtt`, `modbus`, `opcua` (configuration only; push endpoint is unified).

---

## 16. Deviation Alert & Escalation Flow

The Loss Tracker monitors how long machines remain in non-running states. When thresholds are exceeded, email alerts are sent.

### 16.1 Threshold Defaults

| Status | Default Limit |
|--------|---------------|
| `idle` | 1 minute |
| `breakdown` | 90 minutes |
| `alarm` | 30 minutes |
| `offline` | 30 minutes |
| `setting_change` | 120 minutes |

Thresholds are configurable via `site_config` and `/api/deviation-alerts/limits`.

### 16.2 Scan & Escalation Flow

```mermaid
flowchart TD
    A["APScheduler\nevery 5 minutes"] --> B["scan_ongoing_breaches()"]
    B --> C["Read machine_status_log\nfor open segments"]
    C --> D{"Duration > threshold?"}
    D -->|No| E["Skip"]
    D -->|Yes| F{"Already alerted\nfor this segment?"}
    F -->|Yes| G{"Escalation delay\nelapsed?"}
    F -->|No| H["Send Level 1 email"]
    G -->|Yes| I["Send Level N+1 email"]
    G -->|No| E
    H --> J["INSERT deviation_alert_log"]
    I --> J
    J --> K["UPDATE deviation_escalation_cases"]
```

**Escalation levels (default):**

| Level | Recipients | Delay |
|-------|------------|-------|
| 1 | Operator / Production group | 0 min |
| 2 | Supervisor (maintenance group) | 15 min |
| 3 | Manager (management group) | 30 min |

`breakdown` and `alarm` statuses trigger **immediate** alerts (no wait for threshold on first notification).

---

## 17. Email & Scheduler Flow

### 17.1 Scheduled Report Flow

```mermaid
sequenceDiagram
    participant S as APScheduler
    participant Job as _send_scheduled()
    participant DB as email_schedules
    participant SMTP as SMTP Server
    participant Log as email_logs

    S->>Job: Cron trigger (send_hour:send_minute)
    Job->>DB: Load schedule + SMTP config
    Job->>DB: Resolve recipient groups
    Job->>Job: build_attachments_for_report_types()
    Note over Job: XLSX for previous day
    Job->>Log: INSERT status=pending
    Job->>SMTP: Send email with attachments
    alt Success
        Job->>Log: UPDATE status=sent
    else Failure
        Job->>Log: UPDATE status=failed, error_msg
    end
    Job->>DB: UPDATE last_sent timestamp
```

### 17.2 Report Types

| Report Key | Content |
|------------|---------|
| `oee` | OEE entries XLSX |
| `planning` | Production plans XLSX |
| `breakdown` | Breakdown tickets XLSX |
| `loss_tracker` | Loss tracker export |

Manual send available via `POST /api/email/send`. Test SMTP via `POST /api/email/smtp/test`.

---

## 18. Static File & Upload Flow

```mermaid
flowchart LR
    subgraph Upload
        UI["Part/Machine/Factory pages"]
        API["POST multipart endpoints"]
    end

    subgraph Storage
        Disk["backend/static/"]
        M["machines/"]
        P["parts/"]
        F["factory/"]
        WI["work-instructions/"]
    end

    subgraph Serve
        Mount["GET /static/*\nStaticFiles mount"]
    end

    UI --> API --> Disk
    Disk --> M & P & F & WI
    Mount --> Disk
    UI -->|"image_url in DB"| Mount
```

**Upload limits** enforced by `upload_limits.py` (e.g., image size caps).

**Document types** for parts: `control_plan`, `wi_visual`, `wi_tray`, `breakdown_sheet` â€” with revision tracking and history in `part_document_history`.

---

## 19. Deployment Architecture

### 19.1 Development (Windows)

```
run.ps1
  â”œâ”€â”€ MySQL check (port 3306)
  â”œâ”€â”€ database/init_database.ps1
  â”œâ”€â”€ Backend: uvicorn app.main:app --host 0.0.0.0 --port 8040 --reload
  â””â”€â”€ Frontend: npm run dev (Vite :5174, proxy enabled)
```

### 19.2 Production (Ubuntu)

```
PACKAGE.ps1 â†’ eap-pms.zip
  â””â”€â”€ Transfer to server
        â””â”€â”€ unzip + ./run.sh
              â”œâ”€â”€ scripts/setup-database.sh
              â”œâ”€â”€ Backend (uvicorn, no --reload)
              â””â”€â”€ Frontend (vite preview or built dist)
```

See `DEPLOY-UBUNTU.md` for full production setup including systemd service examples.

### 19.3 Network Topology

```mermaid
flowchart TB
    subgraph LAN["Factory LAN"]
        PC1["Operator PC\n:5174"]
        PC2["Supervisor PC\n:5174"]
        SRV["App Server"]
        MYSQL["MySQL Server\n:3306"]
    end

    subgraph SRV_Detail["App Server"]
        FE["Vite/Static :5174"]
        BE["FastAPI :8040"]
    end

    PC1 & PC2 --> FE
    FE -->|proxy /api, /ws| BE
    BE --> MYSQL
```

| Port | Service | Bind |
|------|---------|------|
| 5174 | Frontend | `0.0.0.0` (LAN accessible) |
| 8040 | Backend API | `0.0.0.0` |
| 3306 | MySQL | localhost (typical) |

---

## 20. Configuration Reference

### 20.1 Environment Variables

**Backend (`backend/.env`):**

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | `mysql+pymysql://user:pass@localhost/eap_pms` |
| `SECRET_KEY` | Yes | JWT signing key |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No | Default: 480 |

**Frontend (`frontend/.env`):**

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | No | Empty = use Vite proxy (recommended for dev) |
| `VITE_WS_URL` | No | Empty = `ws://<current-host>/ws` |

**Database setup (`database/db.config.json`):**

| Field | Description |
|-------|-------------|
| `database` | Target database name |
| `user` / `password` | MySQL credentials |
| `clientName` | Display name for setup logs |

### 20.2 Runtime Configuration (`site_config` table)

Stored as JSON in `site_config.config_json`:

| Key | Purpose |
|-----|---------|
| `shifts` | Shift A/B/C times and enabled flags |
| `breaks` | Per-shift break durations |
| `factory` | Factory name, logo, configured flag |
| `deviation_limits` | Loss Tracker thresholds (minutes) |
| `deviation_escalation` | Escalation levels and delays |
| `checkDataDaysBack` | How many days back to check for missing data |

Loaded by `ConfigContext` on frontend; read by backend via `_load_config()` helpers.

---

## 21. API Endpoint Index

### Authentication
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login, returns JWT |

### OEE
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/oee` | Create OEE entry |
| GET | `/api/oee` | List entries (filters) |
| GET | `/api/oee/summary` | Aggregated dashboard data |
| PATCH | `/api/oee/{id}/defect` | Update defect qty (QC) |
| GET | `/api/oee/download-xlsx` | Export Excel |

### Production
| Method | Path | Description |
|--------|------|-------------|
| POST/GET | `/api/plans` | Create/list plans |
| PATCH | `/api/plans/{id}/status` | Update plan status |
| POST | `/api/plans/{id}/reschedule` | Reschedule plan |
| GET | `/api/plans/pipeline/{station_no}` | Station pipeline |
| POST/GET | `/api/work-orders` | Work order CRUD |
| GET | `/api/hourly-output` | Hourly production data |

### Quality
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/qc-inspection/active` | Today's active report |
| PUT | `/api/qc-inspection/draft` | Save draft readings |
| POST | `/api/qc-inspection/{id}/submit-instance` | Submit hourly instance |
| POST | `/api/qc-inspection/{id}/approve-inspector` | Inspector approval |
| POST | `/api/qc-inspection/{id}/close-shift` | Close shift |
| GET | `/api/qc-inspection/{id}/spc-data` | SPC chart data |

### Maintenance
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/breakdown` | Raise ticket |
| PATCH | `/api/breakdown/{id}/resolve` | Resolve ticket |
| PATCH | `/api/machines/{id}/status` | Push machine status (PLC) |
| GET | `/api/machines/{id}/status-log` | Status history |

### Configuration
| Method | Path | Description |
|--------|------|-------------|
| GET/PUT | `/api/config` | Site configuration |
| GET/POST | `/api/users` | User management |
| GET/POST | `/api/machines` | Machine fleet |
| GET/POST | `/api/stations` | Station management |
| GET/POST | `/api/parts` | Part master |

### Alerts & Email
| Method | Path | Description |
|--------|------|-------------|
| GET/PUT | `/api/deviation-alerts/limits` | Threshold config |
| POST | `/api/deviation-alerts/scan` | Manual breach scan |
| GET/POST | `/api/email/schedules` | Email schedules |
| POST | `/api/email/send` | Manual send |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | API alive check |
| GET | `/health/db` | Database connectivity |

Full interactive docs: `http://<host>:8040/docs`

---

## 22. Source Code Layout

```
EAP_PMS_code/
â”œâ”€â”€ ARCHITECTURE.md          â† This document
â”œâ”€â”€ run.ps1                  â† Windows launcher
â”œâ”€â”€ run.sh                   â† Ubuntu launcher
â”œâ”€â”€ PACKAGE.ps1              â† Deployment packager
â”œâ”€â”€ DEPLOY-UBUNTU.md         â† Linux deployment guide
â”œâ”€â”€ OEE-FORMULAS.txt         â† OEE calculation reference
â”œâ”€â”€ TITAN-CPLM-INTEGRATION.md
â”‚
â”œâ”€â”€ frontend/
â”‚   â”œâ”€â”€ package.json
â”‚   â”œâ”€â”€ vite.config.js       â† Proxy config, port 5174
â”‚   â””â”€â”€ src/
â”‚       â”œâ”€â”€ main.jsx         â† Entry point
â”‚       â”œâ”€â”€ App.jsx          â† Routes + providers
â”‚       â”œâ”€â”€ navigation.jsx   â† Role-based nav
â”‚       â”œâ”€â”€ api/
â”‚       â”‚   â”œâ”€â”€ client.js    â† axios + JWT
â”‚       â”‚   â””â”€â”€ useWebSocket.js
â”‚       â”œâ”€â”€ context/         â† Auth, Config, Theme, Branding, Embed
â”‚       â”œâ”€â”€ pages/           â† Feature screens (business logic)
â”‚       â”œâ”€â”€ components/
â”‚       â”‚   â”œâ”€â”€ layout/      â† AppShell, AppBar, Sidebar
â”‚       â”‚   â”œâ”€â”€ basic/       â† TitanModal, FormField
â”‚       â”‚   â”œâ”€â”€ charts/      â† Recharts wrappers
â”‚       â”‚   â””â”€â”€ production-planning/
â”‚       â”œâ”€â”€ themes/          â† CSS tokens, color themes
â”‚       â””â”€â”€ utils/           â† SPC, QC, cycle time helpers
â”‚
â”œâ”€â”€ backend/
â”‚   â”œâ”€â”€ requirements.txt
â”‚   â”œâ”€â”€ .env                 â† DATABASE_URL, SECRET_KEY
â”‚   â”œâ”€â”€ app/
â”‚   â”‚   â”œâ”€â”€ main.py          â† FastAPI app entry
â”‚   â”‚   â”œâ”€â”€ models.py        â† SQLAlchemy ORM (all tables)
â”‚   â”‚   â”œâ”€â”€ auth.py          â† JWT + bcrypt + role guards
â”‚   â”‚   â”œâ”€â”€ ws_manager.py    â† WebSocket broadcast
â”‚   â”‚   â”œâ”€â”€ scheduler_service.py
â”‚   â”‚   â”œâ”€â”€ deviation_alert_service.py
â”‚   â”‚   â”œâ”€â”€ qc_spc_utils.py
â”‚   â”‚   â”œâ”€â”€ qc_shift_utils.py
â”‚   â”‚   â”œâ”€â”€ upload_limits.py
â”‚   â”‚   â””â”€â”€ routers/         â† One file per API domain
â”‚   â”œâ”€â”€ static/              â† Uploaded files
â”‚   â””â”€â”€ migrate_*.py         â† Startup migrations
â”‚
â””â”€â”€ database/
    â”œâ”€â”€ schema.sql           â† Base schema
    â”œâ”€â”€ migrate_*.sql        â† Incremental SQL migrations
    â”œâ”€â”€ init_database.ps1    â† Windows DB setup
    â””â”€â”€ db.config.json       â† DB credentials
```

---

## 23. Design Principles & Constraints

| Principle | Implementation |
|-----------|----------------|
| **Monolithic deployment** | Single backend process, single database, local file storage |
| **Page-centric frontend** | No shared service layer; each page owns its API calls |
| **IST timezone** | All datetime operations use `Asia/Kolkata` |
| **Startup migrations** | Python scripts auto-run if tables missing |
| **JSON flexibility** | `site_config`, `readings_json`, `approval_json` for schema-light evolution |
| **Generated DB columns** | OEE intermediates computed by MySQL for consistency |
| **Real-time via WebSocket** | Server-push only; clients reconnect automatically |
| **Role-based security** | JWT + `require_role()` on backend; nav filter on frontend |
| **CPLM UI shell only** | Layout/navigation aligned; business logic unchanged |
| **No external auth** | No Keycloak/OAuth; local user table with bcrypt passwords |

### Known Architectural Trade-offs

1. **No API cache layer** â€” Pages re-fetch on every navigation; WebSocket triggers manual refresh.
2. **Local file storage** â€” Not suitable for multi-server deployment without shared storage.
3. **JWT in localStorage** â€” Standard for SPA but vulnerable to XSS (mitigate with CSP in production).
4. **Single timezone** â€” Hardcoded IST; no multi-site timezone support.
5. **No automated test suite** â€” Quality relies on manual verification.

---

## Appendix A â€” Default Credentials

| Username | Password | Role |
|----------|----------|------|
| `operator1` | `op123` | operator |

(Additional users created via User Management or database seed scripts.)

---

## Appendix B â€” Related Documents

| Document | Location |
|----------|----------|
| OEE formulas | `OEE-FORMULAS.txt` |
| CPLM UI integration | `TITAN-CPLM-INTEGRATION.md` |
| Ubuntu deployment | `DEPLOY-UBUNTU.md` |
| API interactive docs | `http://localhost:8040/docs` |

---

*End of Architecture Document*

