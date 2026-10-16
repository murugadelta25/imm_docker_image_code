# EAP PMS â€” Software Architecture Document

**Project:** Production Monitoring System (PMS)  
**Version:** 1.0  
**Generated:** 2026-07-16  

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Frontend Architecture](#3-frontend-architecture)
4. [Backend Architecture](#4-backend-architecture)
5. [Data Flow Diagrams](#5-data-flow-diagrams)
6. [Deployment Architecture](#6-deployment-architecture)
7. [Feature Capabilities](#7-feature-capabilities)
8. [Limitations](#8-limitations)
9. [Strengths & Advantages](#9-strengths--advantages)

---

## 1. System Overview

The Production Monitoring System (PMS) is a full-stack web application designed for real-time monitoring, tracking, and analysis of manufacturing production lines. It provides live machine status tracking, OEE (Overall Equipment Effectiveness) computation, production planning, quality control, and automated alert systems.

### Target Environment
- **Deployment:** On-premise Ubuntu IPC (Industrial PC) on the factory floor
- **Network:** Factory LAN (accessible via `http://<ipc-ip>:5174`)
- **Users:** Operators, Supervisors, Maintenance, Quality, Admin
- **Scale:** Single factory, multiple stations, 1â€“50 machines

---

## 2. High-Level Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                        CLIENT BROWSERS                          â”‚
â”‚              (Chrome / Edge on factory terminals)                â”‚
â”‚                                                                 â”‚
â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”‚
â”‚   â”‚  Dashboard    â”‚  â”‚ Hourly Outputâ”‚  â”‚ Loss Tracker â”‚  ...    â”‚
â”‚   â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜         â”‚
â”‚          â”‚                  â”‚                  â”‚                  â”‚
â”‚          â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                 â”‚
â”‚                             â”‚                                    â”‚
â”‚                    HTTP / WebSocket                               â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                              â”‚
                              â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                      VITE DEV SERVER                            â”‚
â”‚                  (localhost:5174 â€” dev mode)                     â”‚
â”‚              Reverse proxy: /api â†’ :8040, /ws â†’ :8040           â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                              â”‚
                              â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                    FASTAPI BACKEND (:8040)                       â”‚
â”‚                                                                 â”‚
â”‚  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â” â”‚
â”‚  â”‚ REST API   â”‚  â”‚ WebSocket  â”‚  â”‚ Scheduler  â”‚  â”‚ Static    â”‚ â”‚
â”‚  â”‚ (20 routersâ”‚  â”‚ (real-time â”‚  â”‚ (APSchedulerâ”‚  â”‚ Files     â”‚ â”‚
â”‚  â”‚  60+ endpt)â”‚  â”‚  broadcast)â”‚  â”‚  email jobs)â”‚  â”‚ (images)  â”‚ â”‚
â”‚  â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜ â”‚
â”‚         â”‚               â”‚               â”‚                       â”‚
â”‚         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜                       â”‚
â”‚                         â”‚                                        â”‚
â”‚                  SQLAlchemy ORM                                   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                          â”‚
                          â–¼
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                   MySQL / MariaDB                                â”‚
â”‚                 (22 tables, InnoDB)                              â”‚
â”‚                                                                 â”‚
â”‚    machines Â· production_plans Â· machine_status_log              â”‚
â”‚    oee_entries Â· work_orders Â· parts Â· machine_kpi_log          â”‚
â”‚    model_change_requests Â· breakdown_tickets Â· ...              â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## 3. Frontend Architecture

### 3.1 Tech Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| **React** | 19.2 | UI library â€” functional components with hooks |
| **Vite** | 8.0 | Build tool & dev server (HMR, proxy, fast builds) |
| **React Router** | 7.15 | Client-side routing with nested layouts |
| **Axios** | 1.16 | HTTP client for API communication |
| **Recharts** | 3.8 | Charting library (OEE bar charts, histograms) |
| **date-fns** | 4.2 | Date manipulation utilities |
| **SheetJS (xlsx)** | 0.18 | Client-side Excel file parsing |
| **CSS-in-JS** | â€” | Inline styles with theme objects (no CSS framework) |

### 3.2 Frontend Architecture Diagram

```
App.jsx
 â”‚
 â”œâ”€â”€ BrowserRouter
 â”‚    â””â”€â”€ AuthProvider (JWT token management)
 â”‚         â””â”€â”€ PlatformAuthProvider (multi-tenant auth)
 â”‚              â””â”€â”€ BrandingProvider (dynamic site title/favicon)
 â”‚                   â””â”€â”€ ThemeProvider (dark/light mode)
 â”‚                        â””â”€â”€ ConfigProvider (shifts, breaks, factory config)
 â”‚                             â””â”€â”€ FeatureFlagsProvider (module toggles)
 â”‚                                  â””â”€â”€ AppRoutes
 â”‚
 â”œâ”€â”€ Public Routes
 â”‚    â”œâ”€â”€ /login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Login.jsx
 â”‚    â”œâ”€â”€ /autologin â”€â”€â”€â”€â”€â”€â”€â”€ AutoLogin.jsx
 â”‚    â””â”€â”€ /platform/* â”€â”€â”€â”€â”€â”€â”€ PlatformLogin / FeatureModulesAdmin
 â”‚
 â””â”€â”€ Authenticated Routes (wrapped in AppShell layout)
      â”‚
      â”œâ”€â”€ PRODUCTION
      â”‚    â”œâ”€â”€ /dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Dashboard.jsx (OEE overview + real-time)
      â”‚    â”œâ”€â”€ /planning â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ ProductionPlanning.jsx
      â”‚    â”œâ”€â”€ /work-orders â”€â”€â”€â”€â”€â”€â”€â”€ WorkOrderManagement.jsx (Gantt chart)
      â”‚    â”œâ”€â”€ /entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ DataEntry.jsx (manual OEE input)
      â”‚    â”œâ”€â”€ /hourly-output â”€â”€â”€â”€â”€â”€ MachineHourlyOutput.jsx (per-slot metrics)
      â”‚    â””â”€â”€ /model-change â”€â”€â”€â”€â”€â”€â”€ ModelChange.jsx (changeover interlock)
      â”‚
      â”œâ”€â”€ QC (Quality Control)
      â”‚    â”œâ”€â”€ /qc-approvals â”€â”€â”€â”€â”€â”€â”€ QcApprovals.jsx
      â”‚    â”œâ”€â”€ /work-instructions â”€â”€ OperatorWorkInstructionDashboard.jsx
      â”‚    â”œâ”€â”€ /parts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PartManagement.jsx
      â”‚    â””â”€â”€ /wi-revisions â”€â”€â”€â”€â”€â”€â”€ WorkInstructionRevision.jsx
      â”‚
      â”œâ”€â”€ MAINTENANCE
      â”‚    â”œâ”€â”€ /breakdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Breakdown.jsx (ticket management)
      â”‚    â”œâ”€â”€ /maintenance â”€â”€â”€â”€â”€â”€â”€â”€ MaintenanceDashboard.jsx
      â”‚    â””â”€â”€ /loss-tracker â”€â”€â”€â”€â”€â”€â”€ LossTracker.jsx (shift utilization)
      â”‚
      â”œâ”€â”€ ALERTS
      â”‚    â””â”€â”€ /alerts/email â”€â”€â”€â”€â”€â”€â”€ EmailAlerts.jsx (schedule & groups)
      â”‚
      â””â”€â”€ SETTINGS
           â”œâ”€â”€ /config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Configuration.jsx (shifts, breaks, thresholds)
           â”œâ”€â”€ /machines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ MachineConfig.jsx
           â”œâ”€â”€ /factory-setup â”€â”€â”€â”€â”€ FactorySetup.jsx
           â””â”€â”€ /users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ UserManagement.jsx
```

### 3.3 State Management

| Layer | Technology | Scope |
|-------|-----------|-------|
| **Server State** | Direct `useState` + API calls | Data fetched from backend (no React Query) |
| **UI State** | `useState` / `useReducer` | Component-local state |
| **Persisted State** | `usePersistedState` hook (sessionStorage) | Form drafts, filter selections |
| **Cross-Cutting** | React Context | Auth, Theme, Config, Branding, Feature Flags |
| **Real-Time** | WebSocket (`useWebSocket` hook) | Live machine status updates, plan events |

### 3.4 Key Frontend Patterns

```
Context Providers (global state)
 â”‚
 â”œâ”€â”€ AuthContext â”€â”€â”€â”€â”€â”€ JWT token, user role, login/logout
 â”œâ”€â”€ ThemeContext â”€â”€â”€â”€â”€ Dark/Light mode toggle, theme object (colors)
 â”œâ”€â”€ ConfigContext â”€â”€â”€â”€ Site config (shifts, breaks), getCurrentShift()
 â”œâ”€â”€ BrandingContext â”€â”€ Dynamic site title, favicon per factory
 â””â”€â”€ FeatureFlagsContext â”€â”€ Module enable/disable toggles
 â”‚
 â–¼
Pages (data fetching + business logic)
 â”‚
 â”œâ”€â”€ useState + useEffect for API calls
 â”œâ”€â”€ useMemo / useCallback for computed values
 â”œâ”€â”€ usePersistedState for filter persistence across navigation
 â””â”€â”€ Inline styles with theme objects (s = getStyles(t))
 â”‚
 â–¼
Shared Components
 â”‚
 â”œâ”€â”€ PageHeader â”€â”€â”€â”€â”€â”€â”€ Title, shift indicator, auto-refresh countdown
 â”œâ”€â”€ AppShell â”€â”€â”€â”€â”€â”€â”€â”€ Sidebar navigation + Outlet (React Router)
 â”œâ”€â”€ PerformanceLegend â”€â”€ Color legend for hourly output
 â”œâ”€â”€ WorkOrderGantt â”€â”€â”€â”€ Gantt chart for work order timelines
 â””â”€â”€ MachineCard â”€â”€â”€â”€â”€â”€ Hourly output card per machine
```

### 3.5 Real-Time Communication

```
Frontend (useWebSocket hook)
    â”‚
    â”‚  ws://host:5174/ws  (proxied to :8040)
    â”‚
    â–¼
FastAPI WebSocket endpoint
    â”‚
    â”‚  Broadcast events:
    â”‚    â€¢ plan_started / plan_completed / plan_updated
    â”‚    â€¢ model_change_request / model_change_completed
    â”‚    â€¢ actual_qty_updated
    â”‚    â€¢ machine_status_changed
    â”‚
    â–¼
All connected clients receive JSON messages
â†’ Frontend re-fetches relevant data on event receipt
```

---

## 4. Backend Architecture

### 4.1 Tech Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| **Python** | 3.10+ | Server-side language |
| **FastAPI** | 0.115 | Async web framework (REST + WebSocket) |
| **Uvicorn** | 0.29 | ASGI server (production & development) |
| **SQLAlchemy** | 2.0 | ORM for database access |
| **PyMySQL** | 1.1 | MySQL database driver |
| **Pydantic** | 2.10 | Request/response validation & serialization |
| **APScheduler** | 3.10 | Background job scheduler (email reports) |
| **python-jose** | 3.3 | JWT token generation & validation |
| **passlib + bcrypt** | â€” | Password hashing |
| **openpyxl** | 3.1 | Excel report generation (.xlsx) |
| **websockets** | 12.0 | WebSocket protocol support |
| **pytz** | 2024.2 | IST timezone handling |
| **python-dotenv** | 1.0 | Environment variable management |

### 4.2 Backend Architecture Diagram

```
FastAPI Application (main.py)
 â”‚
 â”œâ”€â”€ Lifespan (startup/shutdown)
 â”‚    â”œâ”€â”€ Auto-migrate tables (if missing)
 â”‚    â”œâ”€â”€ Start APScheduler (email jobs)
 â”‚    â””â”€â”€ Shutdown: stop scheduler
 â”‚
 â”œâ”€â”€ Middleware
 â”‚    â””â”€â”€ CORS (allow all origins for LAN access)
 â”‚
 â”œâ”€â”€ WebSocket Manager (ws_manager.py)
 â”‚    â””â”€â”€ Broadcast events to all connected clients
 â”‚
 â”œâ”€â”€ Scheduler Service (scheduler_service.py)
 â”‚    â””â”€â”€ APScheduler cron jobs for scheduled email reports
 â”‚
 â”œâ”€â”€ Static Files (/static)
 â”‚    â”œâ”€â”€ /machines â€” machine images
 â”‚    â”œâ”€â”€ /parts â€” part images & sketches
 â”‚    â”œâ”€â”€ /factory â€” factory logos
 â”‚    â””â”€â”€ /work-instructions â€” document uploads
 â”‚
 â””â”€â”€ API Routers (20 routers, 60+ endpoints)
      â”‚
      â”œâ”€â”€ AUTHENTICATION
      â”‚    â””â”€â”€ auth.py â”€â”€â”€â”€â”€â”€â”€ POST /api/auth/login (JWT tokens)
      â”‚
      â”œâ”€â”€ CORE PRODUCTION
      â”‚    â”œâ”€â”€ oee.py â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ /api/oee/* (CRUD, realtime, download, CSV)
      â”‚    â”œâ”€â”€ plans.py â”€â”€â”€â”€â”€â”€â”€â”€â”€ /api/plans/* (CRUD, reschedule, bulk ops)
      â”‚    â”œâ”€â”€ work_orders.py â”€â”€â”€ /api/work-orders/* (CRUD, Gantt data)
      â”‚    â”œâ”€â”€ hourly_output.py â”€â”€ /api/hourly-output/* (computed metrics)
      â”‚    â”œâ”€â”€ machine_kpi.py â”€â”€â”€â”€ /api/machine-kpi/* (OEE/AR/PR/QR/TEEP)
      â”‚    â””â”€â”€ model_change.py â”€â”€â”€ /api/model-change/* (approval workflow)
      â”‚
      â”œâ”€â”€ MACHINE & STATION
      â”‚    â”œâ”€â”€ machines.py â”€â”€â”€â”€â”€â”€â”€ /api/machines/* (CRUD, status, status-log)
      â”‚    â””â”€â”€ stations.py â”€â”€â”€â”€â”€â”€â”€ /api/stations/* (CRUD)
      â”‚
      â”œâ”€â”€ QUALITY CONTROL
      â”‚    â”œâ”€â”€ parts.py â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ /api/parts/* (CRUD, documents, QC params)
      â”‚    â”œâ”€â”€ qc_inspection.py â”€â”€â”€ /api/qc/* (inspections, approvals, SPC)
      â”‚    â””â”€â”€ operator_dashboard.py â”€â”€ /api/operator-dashboard/*
      â”‚
      â”œâ”€â”€ MAINTENANCE
      â”‚    â”œâ”€â”€ breakdown.py â”€â”€â”€â”€â”€â”€â”€ /api/breakdown/* (ticket lifecycle)
      â”‚    â””â”€â”€ deviation_alerts.py â”€â”€ /api/deviation-alerts/* (escalation)
      â”‚
      â”œâ”€â”€ CONFIGURATION
      â”‚    â”œâ”€â”€ config.py â”€â”€â”€â”€â”€â”€â”€â”€ /api/config/* (site config, factory, branding)
      â”‚    â”œâ”€â”€ users.py â”€â”€â”€â”€â”€â”€â”€â”€â”€ /api/users/* (CRUD, role management)
      â”‚    â””â”€â”€ features.py â”€â”€â”€â”€â”€â”€ /api/features/* (module toggles)
      â”‚
      â”œâ”€â”€ NOTIFICATIONS
      â”‚    â”œâ”€â”€ email_router.py â”€â”€ /api/email/* (groups, schedules, send)
      â”‚    â””â”€â”€ notifications.py â”€â”€ /api/notifications/* (in-app)
      â”‚
      â””â”€â”€ PLATFORM
           â””â”€â”€ platform.py â”€â”€â”€â”€ /api/platform/* (multi-tenant auth)
```

### 4.3 API Authentication Flow

```
Client                          Backend
  â”‚                                â”‚
  â”‚  POST /api/auth/login          â”‚
  â”‚  { username, password }        â”‚
  â”‚ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–ºâ”‚
  â”‚                                â”‚  Verify bcrypt hash
  â”‚                                â”‚  Generate JWT (python-jose)
  â”‚  { access_token, role }        â”‚
  â”‚ â—„â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”‚
  â”‚                                â”‚
  â”‚  GET /api/oee/                 â”‚
  â”‚  Authorization: Bearer <jwt>   â”‚
  â”‚ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–ºâ”‚
  â”‚                                â”‚  Decode JWT â†’ get_current_user()
  â”‚                                â”‚  Role check â†’ require_role()
  â”‚  { data }                      â”‚
  â”‚ â—„â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”‚
```

### 4.4 Key Backend Patterns

**Dependency Injection:**
```python
@router.get("/")
def get_data(
    db: Session = Depends(get_db),        # DB session
    user = Depends(get_current_user),      # JWT auth
):
```

**Role-Based Access:**
```python
@router.delete("/{id}")
async def delete(id: int,
    user = Depends(require_role("supervisor", "admin")),
):
```

**WebSocket Broadcasting:**
```python
await manager.broadcast({
    "type": "plan_started",
    "plan_id": plan.id,
    "machine_id": plan.machine_id,
})
```

**Auto-Transition (Shift Continuity):**
```python
def auto_transition_shift_plans(db, entry_date, shift_id, cfg):
    # If same part continues from previous shift:
    # 1. Auto-start current shift plan (no model-change needed)
    # 2. Auto-complete previous shift plan
    # Works across days (Shift C â†’ next-day Shift A)
```

---

## 5. Data Flow Diagrams

### 5.1 Real-Time Machine Monitoring Flow

```
PLC / Manual Input
    â”‚
    â”‚  Machine status change (running â†’ idle â†’ breakdown...)
    â”‚
    â–¼
POST /api/machines/{id}/status
    â”‚
    â”œâ”€â”€ 1. Update machines.status in DB
    â”œâ”€â”€ 2. Insert into machine_status_log (timestamp journal)
    â”œâ”€â”€ 3. Check deviation thresholds (config)
    â”‚       â””â”€â”€ If breach â†’ send escalation email
    â””â”€â”€ 4. WebSocket broadcast â†’ all clients
                â”‚
                â–¼
         Frontend re-renders:
          â€¢ Dashboard heart icon color changes
          â€¢ Hourly Output updates running count
          â€¢ Loss Tracker recalculates utilization
```

### 5.2 Production Planning & Execution Flow

```
Supervisor creates Work Order
    â”‚
    â–¼
Supervisor creates Production Plans (per shift, per machine)
    â”‚
    â–¼
Plan status: PENDING
    â”‚
    â”œâ”€â”€ Same part as previous shift? â”€â”€â–º AUTO-START (no approval needed)
    â”‚
    â””â”€â”€ Different part? â”€â”€â–º Create Model Change Request
                                â”‚
                                â”œâ”€â”€ Supervisor approves on Model Change page
                                â”‚
                                â–¼
                          Plan status: RUNNING
                                â”‚
                                â”œâ”€â”€ Machine status â†’ running
                                â”œâ”€â”€ Hourly Output starts counting parts
                                â”œâ”€â”€ Dashboard shows real-time OEE
                                â”‚
                                â–¼
                     actual_qty â‰¥ planned_qty?
                          â”‚           â”‚
                         YES          NO (shift ends)
                          â”‚           â”‚
                          â–¼           â–¼
                    AUTO-COMPLETE   PAUSE/COMPLETE
                          â”‚
                          â–¼
                   Work Order progress updated
```

### 5.3 OEE Calculation Flow

```
                    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                    â”‚  machine_status_log  â”‚
                    â”‚  (real-time journal)  â”‚
                    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                               â”‚
                    â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                    â”‚  Build Status        â”‚
                    â”‚  Segments            â”‚
                    â”‚  â€¢ Classify idle     â”‚
                    â”‚    durations as      â”‚
                    â”‚    ld_unld or idle    â”‚
                    â”‚  â€¢ Merge micro-gaps  â”‚
                    â”‚  â€¢ Stitch multi-     â”‚
                    â”‚    segment cycles    â”‚
                    â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                               â”‚
          â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
          â”‚                    â”‚                     â”‚
          â–¼                    â–¼                     â–¼
  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
  â”‚ Running Time  â”‚  â”‚ Operating Time â”‚   â”‚ Part Count     â”‚
  â”‚ (state=runningâ”‚  â”‚ (running +     â”‚   â”‚ (countable     â”‚
  â”‚  segments)    â”‚  â”‚  ld_unld)      â”‚   â”‚  running segs  â”‚
  â””â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜  â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜   â”‚  above CT      â”‚
          â”‚                   â”‚           â”‚  threshold)    â”‚
          â”‚                   â”‚           â””â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜
          â”‚                   â”‚                    â”‚
          â–¼                   â–¼                    â–¼
  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
  â”‚                   KPI CALCULATIONS                    â”‚
  â”‚                                                      â”‚
  â”‚  AR = Operating Time / Available Time Ã— 100          â”‚
  â”‚  PR = Actual Output / Expected Output Ã— 100          â”‚
  â”‚  QR = Good Units / Total Units Ã— 100 (default 100%)  â”‚
  â”‚  OEE = AR Ã— PR Ã— QR / 10000                         â”‚
  â”‚  MUR = Running Time / Available Time Ã— 100           â”‚
  â”‚  Yield = Actual Output / Theoretical Output Ã— 100    â”‚
  â”‚  TEEP = OEE Ã— MUR / 100                             â”‚
  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
          â”‚
          â”œâ”€â”€â–º Hourly Output Dashboard (per-slot breakdown)
          â”œâ”€â”€â–º Dashboard (shift-level summary)
          â”œâ”€â”€â–º Machine KPI Dialog (7 metrics)
          â””â”€â”€â–º machine_kpi_log (historic snapshots)
```

### 5.4 Email & Report Flow

```
                  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                  â”‚   APScheduler       â”‚
                  â”‚   (cron jobs)       â”‚
                  â”‚   Runs at configuredâ”‚
                  â”‚   send_hour:minute  â”‚
                  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                             â”‚
              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
              â”‚              â”‚              â”‚
              â–¼              â–¼              â–¼
        OEE Report    Planning Report   Breakdown Report
              â”‚              â”‚              â”‚
              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                             â”‚
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚  Build XLSX with  â”‚
                   â”‚  openpyxl         â”‚
                   â”‚  (styled headers, â”‚
                   â”‚   multiple sheets)â”‚
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                             â”‚
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚  Send via SMTP    â”‚
                   â”‚  (Gmail / custom) â”‚
                   â”‚  To: email groups â”‚
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                             â”‚
                   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â–¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
                   â”‚  Log to email_logsâ”‚
                   â”‚  (audit trail)    â”‚
                   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜

  Manual triggers:
    â€¢ Dashboard â†’ Download Excel / CSV
    â€¢ Email Alerts page â†’ Send Now
    â€¢ Planning page â†’ Export / Email Report
```

---

## 6. Deployment Architecture

### 6.1 Production Deployment (Ubuntu IPC)

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                   Ubuntu IPC (Factory Floor)                  â”‚
â”‚                                                              â”‚
â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”‚
â”‚   â”‚  systemd service: pms-backend                       â”‚    â”‚
â”‚   â”‚  uvicorn app.main:app --host 0.0.0.0 --port 8040   â”‚    â”‚
â”‚   â”‚                                                     â”‚    â”‚
â”‚   â”‚  Python 3.10+ virtual environment                   â”‚    â”‚
â”‚   â”‚  â””â”€â”€ FastAPI + SQLAlchemy + APScheduler             â”‚    â”‚
â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â”‚
â”‚                            â”‚                                 â”‚
â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”‚
â”‚   â”‚  systemd service: pms-frontend                      â”‚    â”‚
â”‚   â”‚  npx vite preview --host --port 5174                â”‚    â”‚
â”‚   â”‚  (or: npx serve dist -l 5174)                       â”‚    â”‚
â”‚   â”‚                                                     â”‚    â”‚
â”‚   â”‚  Vite production build (static assets)              â”‚    â”‚
â”‚   â”‚  Proxy: /api â†’ localhost:8040                       â”‚    â”‚
â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â”‚
â”‚                            â”‚                                 â”‚
â”‚   â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”    â”‚
â”‚   â”‚  MySQL / MariaDB Server                             â”‚    â”‚
â”‚   â”‚  Database: pms_dashboard (or configured name)       â”‚    â”‚
â”‚   â”‚  22 tables, InnoDB engine                           â”‚    â”‚
â”‚   â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜    â”‚
â”‚                                                              â”‚
â”‚   Access: http://<ipc-ip>:5174                              â”‚
â”‚   Factory terminals connect via LAN                          â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

### 6.2 Development Setup

```
Windows / Linux / macOS developer machine
    â”‚
    â”œâ”€â”€ Terminal 1: cd backend && uvicorn app.main:app --port 8040 --reload
    â”œâ”€â”€ Terminal 2: cd frontend && pnpm dev (Vite HMR on :5174)
    â””â”€â”€ MySQL running locally or remote
```

---

## 7. Feature Capabilities

### 7.1 Production Monitoring

| Feature | Description |
|---------|-------------|
| **Real-Time Dashboard** | Live OEE, AR, PR, QR per machine with animated status hearts |
| **Hourly Output** | Per-slot (hourly) production count, expected vs actual, OEE breakdown |
| **Loss Tracker** | Shift utilization breakdown with status duration analysis, cycle time histograms |
| **Machine KPI Dialog** | 7 KPIs (OEE, AR, PR, QR, MUR, Yield, TEEP) with historic snapshots |
| **Machine Status Log** | Complete status change journal with deviation reasons |
| **Multi-Shift Support** | 3 configurable shifts (A/B/C) with automatic shift transitions |
| **Cross-Day Continuity** | Same-part auto-transition across overnight shifts and day boundaries |
| **Micro-Gap Merging** | Automatically merges brief interruptions (< configurable seconds) |
| **Cycle Stitching** | Multi-segment cycle support for milling/orientation-change operations |

### 7.2 Production Planning

| Feature | Description |
|---------|-------------|
| **Work Orders** | Create, track, and complete work orders with Gantt chart visualization |
| **Shift Planning** | Plan per machine, per shift, per date with multi-day/multi-shift bulk creation |
| **Model Change Interlock** | Supervisor approval required when changing parts (auto-skipped for same part) |
| **Plan Rescheduling** | Individual and bulk reschedule with split-remaining support |
| **Auto-Complete** | Plans auto-complete when actual qty reaches planned qty |
| **Priority Queue** | Machine pipeline view ordered by priority |

### 7.3 Quality Control

| Feature | Description |
|---------|-------------|
| **Part Management** | Full part master with operations, cycle times, QC parameters |
| **Process Control Sheets** | Work instructions with document revision tracking |
| **QC Inspection Reports** | Multi-level approval (Operator â†’ Inspector â†’ Incharge) |
| **SPC Integration** | LSL/USL limits on numeric QC parameters |
| **Defect Tracking** | Before/after OEE audit when defects are updated post-QC |
| **Document Versioning** | Full revision history with archive/supersede workflow |

### 7.4 Maintenance & Alerts

| Feature | Description |
|---------|-------------|
| **Breakdown Tickets** | Full lifecycle: raised â†’ acknowledged â†’ in_progress â†’ resolved |
| **Deviation Alerts** | Configurable thresholds per status type (idle, breakdown, alarm, etc.) |
| **Multi-Level Escalation** | Auto-escalate alerts (Operator â†’ Supervisor â†’ Manager) with configurable delays |
| **Email Reports** | Scheduled daily/shift reports with XLSX attachments |
| **Email Groups** | Configurable recipient groups by report type |

### 7.5 Configuration & Admin

| Feature | Description |
|---------|-------------|
| **Shift Configuration** | Define shift times, enable/disable shifts, configure breaks |
| **Break Windows** | Lunch, tea, TPM breaks deducted from available time |
| **Threshold Configuration** | Running part threshold %, Ld/UnLd max, micro-gap merge duration |
| **Factory Hierarchy** | Factory â†’ Department â†’ Line â†’ Station mapping |
| **User Management** | Role-based access (operator, supervisor, maintenance, admin, quality) |
| **Feature Flags** | Enable/disable application modules per deployment |
| **Dark/Light Theme** | User-selectable UI theme |
| **Auto-Login** | URL-based auto-login for kiosk/terminal deployments |

### 7.6 Reporting & Export

| Feature | Description |
|---------|-------------|
| **Excel Download** | OEE, Hourly Output, Planning reports in styled XLSX |
| **CSV Export** | Lightweight CSV downloads for data analysis |
| **Email Reports** | Automated scheduled reports with XLSX attachments |
| **Manual Email** | Send reports on-demand to selected groups |
| **Report Columns** | Full data parity: Date, Station, Machine, Shift, Work Order, Model, CT, Plan Qty, Possible, Actual, Prod Loss, AR, PR, QR, OEE |

---

## 8. Limitations

### 8.1 Architecture Limitations

| Area | Limitation | Impact |
|------|-----------|--------|
| **No ORM Relationships** | SQLAlchemy models lack `relationship()` mappings | Requires multiple queries + Python-side joins; no lazy loading |
| **No API Versioning** | All endpoints are `/api/*` without version prefix | Breaking changes affect all clients simultaneously |
| **No Caching Layer** | No Redis/Memcached for frequently accessed data | Every request hits the database directly |
| **Single Process** | Uvicorn runs as a single process (no Gunicorn workers) | Limited concurrency under heavy load |
| **No Message Queue** | No RabbitMQ/Kafka for async processing | Email sending and heavy computations block the request thread |
| **No Database Migrations Framework** | Manual migration scripts instead of Alembic | Schema changes require manual SQL scripts |
| **Session-Based Persistence** | Frontend uses sessionStorage for filter state | State lost on browser tab close; no cross-device persistence |

### 8.2 Scalability Limitations

| Area | Limitation |
|------|-----------|
| **Single Database** | No read replicas or sharding; single MySQL instance |
| **No Horizontal Scaling** | Application designed for single-instance deployment |
| **Machine Count** | Tested with 1â€“10 machines; may slow with 50+ machines and dense status logs |
| **Status Log Volume** | `machine_status_log` grows indefinitely; no archival/purge strategy |
| **No CDN** | Static assets served directly from Uvicorn; no CDN for images |

### 8.3 Security Limitations

| Area | Limitation |
|------|-----------|
| **JWT Secret** | Stored in `.env` file; no key rotation mechanism |
| **CORS** | Set to `allow_origins=["*"]` (open to all origins) |
| **No HTTPS** | Runs on HTTP within factory LAN; no TLS certificate management |
| **Password Policy** | No password complexity requirements or expiration |
| **No Audit Trail** | User actions (login, data changes) not comprehensively logged |
| **SMTP Password** | Stored in plaintext in `email_smtp_config` table |

### 8.4 Feature Limitations

| Area | Limitation |
|------|-----------|
| **No Mobile App** | Web-only; responsive but not optimized for mobile |
| **No Offline Mode** | Requires constant network connectivity |
| **Single Language** | English-only UI (no i18n/l10n support) |
| **No Multi-Factory** | Designed for single factory deployment; factory hierarchy is visual only |
| **Manual Machine Status** | PLC integration (MQTT/Modbus/OPC-UA) is configured but primarily manual |
| **No SPC Charts** | QC has LSL/USL parameters but no control charts (X-bar, R-chart) |
| **No Predictive Analytics** | Historical data only; no ML-based predictive maintenance |

---

## 9. Strengths & Advantages

### 9.1 Architecture Strengths

| Strength | Benefit |
|----------|---------|
| **Simple Stack** | React + FastAPI + MySQL â€” easy to understand, debug, and maintain |
| **Zero External Dependencies** | No Redis, Kafka, Nginx, or Docker required â€” single machine deployment |
| **Real-Time Updates** | WebSocket broadcasting ensures all connected clients see instant status changes |
| **Self-Contained** | Single `git clone` + `pip install` + `pnpm install` gets the full system running |
| **Auto-Migration** | Backend auto-creates missing tables on startup; no manual migration steps |
| **LAN-Optimized** | Runs entirely on factory LAN; no cloud dependency or internet requirement |

### 9.2 Development Strengths

| Strength | Benefit |
|----------|---------|
| **Hot Module Replacement** | Vite HMR enables instant UI changes during development |
| **Type Hints** | Pydantic models validate all API request/response data automatically |
| **FastAPI Docs** | Auto-generated OpenAPI (Swagger) documentation at `/docs` |
| **Modular Routers** | 20 independent routers make feature development isolated |
| **Inline Styles + Theme** | No CSS build pipeline; theme-aware styles without CSS-in-JS library overhead |
| **Single Codebase** | Frontend and backend in one repo â€” simple CI/CD and deployment |

### 9.3 Production Strengths

| Strength | Benefit |
|----------|---------|
| **Configurable Thresholds** | Running part %, micro-gap duration, Ld/UnLd classification â€” all configurable without code changes |
| **Smart Part Counting** | Duration-based threshold prevents over-counting micro-runs as parts |
| **Cycle Stitching** | Handles multi-orientation milling where 1 part = 3+ running cycles |
| **Automatic Shift Transitions** | Same-part continuity across shifts without manual intervention |
| **Computed Columns** | MySQL-level calculations ensure data consistency for OEE breakdowns |
| **Historic KPI Storage** | `machine_kpi_log` enables trend analysis and shift-over-shift comparison |
| **Multi-Level Escalation** | Automated alert escalation ensures breakdowns are never ignored |

### 9.4 Operational Strengths

| Strength | Benefit |
|----------|---------|
| **Low Resource Footprint** | Runs on a single Ubuntu IPC (2GB RAM sufficient) |
| **No License Costs** | 100% open-source stack â€” no per-seat or per-machine licensing |
| **Cross-Platform Backend** | Python backend runs identically on Windows (dev) and Linux (prod) |
| **Instant Deploy** | `git pull` + restart services â€” no build pipelines required in production |
| **Dual Data Source** | Dashboard merges real-time computed data with manual data entry; neither blocks the other |
| **Role-Based Access** | 5 user roles (operator â†’ admin) with appropriate feature restrictions |

---

## Appendix A: File Structure

```
EAP_PMS_code/
â”‚
â”œâ”€â”€ frontend/
â”‚   â”œâ”€â”€ src/
â”‚   â”‚   â”œâ”€â”€ api/            # Axios client, WebSocket hook
â”‚   â”‚   â”œâ”€â”€ components/     # Shared UI components
â”‚   â”‚   â”‚   â””â”€â”€ layout/     # AppShell, Sidebar, Navigation
â”‚   â”‚   â”œâ”€â”€ context/        # React Context providers (7 contexts)
â”‚   â”‚   â”œâ”€â”€ hooks/          # Custom hooks (usePersistedState, etc.)
â”‚   â”‚   â”œâ”€â”€ pages/          # 18 page components
â”‚   â”‚   â”œâ”€â”€ themes/         # Theme definitions, color palettes
â”‚   â”‚   â”œâ”€â”€ utils/          # Utility functions
â”‚   â”‚   â””â”€â”€ App.jsx         # Root component with routing
â”‚   â”œâ”€â”€ package.json
â”‚   â””â”€â”€ vite.config.js
â”‚
â”œâ”€â”€ backend/
â”‚   â”œâ”€â”€ app/
â”‚   â”‚   â”œâ”€â”€ routers/        # 20 API routers (60+ endpoints)
â”‚   â”‚   â”œâ”€â”€ models.py       # SQLAlchemy ORM models (22 tables)
â”‚   â”‚   â”œâ”€â”€ main.py         # FastAPI app, lifespan, middleware
â”‚   â”‚   â”œâ”€â”€ auth.py         # JWT authentication
â”‚   â”‚   â”œâ”€â”€ ws_manager.py   # WebSocket broadcast manager
â”‚   â”‚   â”œâ”€â”€ scheduler_service.py  # APScheduler email jobs
â”‚   â”‚   â””â”€â”€ cycle_stitcher.py     # Multi-segment cycle logic
â”‚   â”œâ”€â”€ static/             # Uploaded images (machines, parts, docs)
â”‚   â”œâ”€â”€ requirements.txt
â”‚   â””â”€â”€ .env                # DATABASE_URL, JWT_SECRET, SMTP config
â”‚
â”œâ”€â”€ database/
â”‚   â”œâ”€â”€ schema.sql          # Full database schema
â”‚   â”œâ”€â”€ init_database.ps1   # PowerShell DB init script
â”‚   â””â”€â”€ migrate_*.sql/py    # Migration scripts
â”‚
â”œâ”€â”€ deploy/                 # Deployment scripts
â”œâ”€â”€ docs/                   # Documentation
â”‚   â”œâ”€â”€ DATABASE_SCHEMA.md
â”‚   â””â”€â”€ SOFTWARE_ARCHITECTURE.md (this file)
â”‚
â””â”€â”€ CLAUDE.md               # AI assistant project guide
```

---

## Appendix B: API Endpoint Summary

| Router | Prefix | Endpoints | Key Operations |
|--------|--------|-----------|----------------|
| auth | /api/auth | 1 | Login (JWT) |
| oee | /api/oee | 8 | CRUD, realtime, download XLSX/CSV, summary |
| plans | /api/plans | 8 | CRUD, status, reschedule, bulk ops, export |
| work_orders | /api/work-orders | 6 | CRUD, Gantt, status sync |
| hourly_output | /api/hourly-output | 3 | Computed hourly data, machine CT, XLSX |
| machine_kpi | /api/machine-kpi | 2 | Compute KPI, history |
| machines | /api/machines | 5 | CRUD, status, status-log |
| stations | /api/stations | 3 | CRUD |
| model_change | /api/model-change | 4 | Request, approve, start, complete |
| breakdown | /api/breakdown | 4 | CRUD, acknowledge, resolve |
| parts | /api/parts | 8 | CRUD, documents, QC params, search |
| qc_inspection | /api/qc | 6 | Reports, approvals, SPC |
| config | /api/config | 4 | Site config, branding, factory logos |
| users | /api/users | 3 | CRUD, role management |
| email_router | /api/email | 6 | Groups, schedules, send, logs |
| deviation_alerts | /api/deviation-alerts | 3 | Config, logs, escalation |
| notifications | /api/notifications | 2 | In-app notifications |
| platform | /api/platform | 2 | Multi-tenant auth |
| features | /api/features | 2 | Module toggle |
| operator_dashboard | /api/operator-dashboard | 2 | Operator view |

