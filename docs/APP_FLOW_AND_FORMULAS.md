# EAP IMM PMS — Application Flow & Formulas

**Product:** EAP IMM PMS (Production Monitoring System for Injection Molding)  
**Also branded:** Titan OEE  
**Document version:** 1.1  
**Last updated:** October 2026  
**Timezone for all business time:** IST (`Asia/Kolkata`)

---

## 1. System overview

EAP IMM PMS monitors injection molding machines (IMM), plans production, computes OEE, tracks shots/material, and supports QC, breakdown, and mold life workflows.

| Tier | Technology | Default port |
|------|------------|--------------|
| Presentation | React 19 SPA (Vite) | **5174** |
| Application | Python FastAPI | **8040** |
| Data | MySQL 8.x (PyMySQL) | **3306** |
| Optional edge | Node-RED / OPC UA bridge | factory LAN |

```
Operators / Supervisors / QC / Maintenance / Admin
        │
        ▼
  React UI (:5174)  ──HTTP/WS──►  FastAPI (:8040)  ──►  MySQL
                                      ▲
                     OPC UA / Node-RED / PLC status tags
```

---

## 2. Application map (main screens)

| Route | Screen | Purpose |
|-------|--------|---------|
| `/login` | Login | JWT auth |
| `/dashboard` | IMM Factory Dashboard | Live factory overview |
| `/imm/zone`, `/imm/zone/:zoneId` | Zone Dashboard | Zone-level machine status |
| `/imm/equipment` | Device Monitor | Machine list / live status |
| `/imm/equipment/:machineId` | Equipment Detail | Live tags, shots, mold, CT |
| `/imm/kpis` | IMM KPI Dashboard | IMM KPI history views |
| `/imm/energy` | Energy Dashboard | Energy-related views |
| `/oee-dashboard` | **Production OEE Dashboard** | Live + data-entry OEE table |
| `/hourly-output` | Machine Hourly Output | Hourly Running / Possible / RM |
| `/planning` | Production Planning | Plans, mold, cavity, CT, capacity |
| `/work-orders` | Work Orders | WO create / track |
| `/entry` | Data Entry | Manual OEE entry |
| `/breakdown` | Breakdown | Raise issue to maintenance |
| `/maintenance` | Maintenance Dashboard | Ticket handling |
| `/loss-tracker` | Loss Tracker | Status timeline / losses |
| `/model-change` | Model Change | Mold / model change requests |
| `/tools`, `/molds` | Mold Management | Mold master (CT, cavity, shot wt) |
| `/parts` | Part Master | Part definitions |
| `/work-instructions` | Work Instructions | Operator WI / process sheets |
| `/qc-approvals` | QC Approvals | Inspection approvals |
| `/alerts/email` | Email Alerts | SMTP, schedules, OEE reports |
| `/machines`, `/factory-setup`, `/config` | Setup | Machines, stations, site config |
| `/users`, `/operators` | Admin | Users & operators |

---

## 3. End-to-end application flows

### 3.1 Startup / access

```
Deploy IPC (Ubuntu) or Windows
  → MySQL + backend (:8040) + frontend (:5174)
  → User opens http://<host>:5174 or din.eappms
  → Login → JWT stored → AuthenticatedShell (sidebar + pages)
  → WebSocket optional for live machine / OEE updates
```

**Launchers:** `./run.sh` (Ubuntu systemd), `START_ALL.ps1` / `run.ps1` (Windows).

---

### 3.2 Master data → plan → run

```
1. Mold Management          Create mold: Std CT, Running Cavity, Std. Shot Weight (g)
2. Part / Work Order        Link part & WO to mold
3. Production Planning      Select machine, shift, mold → snapshot mold_details_json
                            CT = standard cycle time only (mold change time NOT added)
                            Possible capacity uses CT × running cavity
4. Mold Monitoring          Mount mold on machine (ImmMold)
5. Live capture             OPC UA / Node-RED → ImmShotEvent / status logs
6. Dashboards               OEE / Hourly / Equipment show live metrics
```

---

### 3.3 Shot counting flow (IMM)

```
Machine tags / Node-RED
        │
        ▼
imm_shot_counter (backend)
        │
        ├─ OPC UA (e.g. IMM_07..11): Total_Good_Count change ⇒ 1 shot
        ├─ Status machines (e.g. IMM17/18): injection/refilling FSM ⇒ 1 shot
        │
        ▼
ImmShotEvent (+ mold usage / ToolStock cycles)
        │
        ▼
Actual parts = Shot Count × Running Cavity
```

- Shift shot counter resets each shift window (events only inside shift).
- Mold / tool life does **not** reset at shift start.

---

### 3.4 Production OEE Dashboard flow

```
UI /oee-dashboard
  → GET live realtime OEE (plans + shots + downtime)
  → Merge with manual OEEEntry when no live row
  → Columns: cavity, shot weight, shot counts, RM usage, AR/PR/QR/OEE
  → QC edit defects; edit running cavity on plan
  → Email / XLSX / CSV include shot weight, shots, RM kg
```

**Shot weight resolution order:**

1. Plan `mold_details_json.std_shot_weight`
2. Mold master (`ToolStock`) via `mold_id` / mold code / model variant
3. Active mounted `ImmMold` on machine → mold master **Std. Shot Weight**

---

### 3.5 Hourly Output flow

```
UI /hourly-output
  → build_hourly_output (backend)
  → Per machine / shift: hourly slots
  → Possible pcs = CT capacity × cavity
  → Running pcs = shots × cavity (ImmShotEvent when available)
  → Shot Weight (g), Req RM (kg) rows
```

---

### 3.6 Breakdown / maintenance flow

```
Operator opens Breakdown → Raise Issue to Maintenance
  → Select Planned or Unplanned reason (3D capsule buttons)
  → Select raised-by → Submit
  → BreakdownTicket created → Maintenance Dashboard
  → Resolve / close; may affect downtime / OEE AR
```

---

### 3.7 QC flow

```
OEE Dashboard / Data Entry
  → Enter defect qty (+ optional rejection log)
  → Accp = Actual − Defect
  → QR / OEE recalculated
  → Defect history (OEEDefectLog)
  → QC Approvals for inspection workflows (separate module)
```

---

### 3.8 Email report flow

```
Email Alerts config (SMTP + schedule + report types)
  → Scheduler or manual send
  → build_oee_xlsx includes:
       Running Cavity | Shot Weight (g) | Shot Counts | RM Usage (kg) | …
  → Attach to recipients
```

---

## 4. Formulas reference

### 4.1 Core quantity relationships (IMM)

| Name | Formula | Notes |
|------|---------|--------|
| **Cycle Time (CT)** | Standard cycle time (sec) from mold / plan | Planning: mold change time is **not** added to CT |
| **Data Entry CT** | Process Time + Loading/Unloading (sec) | Manual OEE entry form only |
| **Shot Count** | Count of injection cycles in window | From `ImmShotEvent` / good-count / status FSM |
| **Actual Qty (pcs)** | Shot Count × Running Cavity | Parts produced |
| **Possible shots** | Operating (or planned prod) minutes × (60 / CT) | Integer where applied |
| **Possible Qty (pcs)** | Possible shots × Running Cavity | Theoretical capacity |
| **Production Loss** | max(0, Possible Qty − Actual Qty) | |
| **Accepted Qty** | max(0, Actual Qty − Defect Qty) | |

---

### 4.2 Material / shot weight

| Name | Formula | Unit |
|------|---------|------|
| **Std. Shot Weight** | From mold master / plan snapshot | g / shot |
| **Shot Weight (hourly actual)** | Actual shots × Std. Shot Weight | g |
| **Req RM (hourly)** | (Possible pcs ÷ Running Cavity) × Std. Shot Weight ÷ 1000 | kg |
| **RM Usage (OEE dashboard)** | Shot Count × Std. Shot Weight ÷ 1000 | kg |

**Example:** 90 shots × 65 g = 5850 g = **5.850 kg** RM usage.

---

### 4.3 Hourly Possible Output (capacity)

For each hour slot (after breaks / production windows):

\[
\text{Possible pcs/hour} = \left(\text{Net minutes} \times \frac{60}{\text{CT}}\right) \times \text{Running Cavity}
\]

Implemented as `_ct_capacity_hourly` in `hourly_output.py`.

---

### 4.4 Live IMM OEE (Production OEE Dashboard)

From `_compute_imm_oee_rates` in `oee.py`:

| Step | Formula |
|------|---------|
| Scheduled | Shift start → now (minutes) |
| Planned Production Time | Scheduled − Planned Downtime |
| Operating Time | Planned Production Time − Unplanned Downtime |
| **AR %** | Operating Time / Planned Production Time × 100 |
| **PR %** | (Units × Set CT) / Operating Time(sec) × 100 |
| **QR %** | Good Units / Units × 100 (100% if no units) |
| **OEE %** | AR × PR × QR / 10000 |

Where:

- **Units** = Actual Qty = Shots × Running Cavity  
- **Good Units** = Accp Qty  
- Display AR/PR/QR/OEE are **capped at 100%**; uncapped `*_raw` kept for audit when capping applies  

**Possible Qty (live):**

\[
\text{Possible shots} = \text{Operating (or Planned Prod) min} \times \frac{60}{\text{CT}}
\]
\[
\text{Possible Qty} = \text{Possible shots} \times \text{Running Cavity}
\]

---

### 4.5 Manual Data Entry OEE (`calculate_oee`)

| Step | Formula |
|------|---------|
| CT | Process Time + Loading/Unloading (sec) |
| Total Breaks | Lunch + Tea + TPM + Other Clean + Mgmt Meeting |
| Shift Working | Total Minutes − Total Breaks |
| Mgmt Loss | No Load + New Model Trial + Power Cut + Planned Maint + No Manpower |
| Available Shift Time | Shift Working − Mgmt Loss |
| Total Down | Setting + Tool Change + Dim Correction + Scrap + Breakdown |
| Operating Time | Available − Total Down |
| Possible Qty | (Operating × 60) / CT |
| Production Loss | Possible − Actual |
| Accp | Actual − Defect |
| **AR %** | Operating / Available × 100 |
| **PR %** | Actual / Possible × 100 |
| **QR %** | Accp / Actual × 100 |
| **OEE %** | AR × PR × QR / 10000 |

---

### 4.6 Hourly Output OEE (per slot)

From `_compute_oee_slots` in `hourly_output.py`:

| Metric | Formula |
|--------|---------|
| **AR %** | Operating minutes / Available minutes × 100 (capped 100) |
| **PR %** | Actual parts (running) / Expected (possible) × 100 |
| **QR %** | From OEE entries average (default 100) |
| **OEE %** | AR × PR × QR / 10000 |

Shift totals use the same formulas with summed minutes / quantities.

---

### 4.7 Machine KPI formulas

From `machine_kpi.py`:

| Metric | Formula |
|--------|---------|
| Expected Qty | Available Time (min) × 60 / CT |
| Theoretical Qty | Shift Total (min) × 60 / CT |
| **AR %** | Operating Time / Available Time × 100 |
| **PR %** | Actual / Expected × 100 |
| **QR %** | Good / Actual × 100 |
| **OEE %** | AR × PR × QR / 10000 |
| MUR | Actual Production Time / Available Time × 100 |
| Production Yield | Actual / Theoretical × 100 |
| TEEP | OEE × MUR / 100 |

---

### 4.8 Planning capacity

On Production Planning:

\[
\text{Possible / capacity} \propto \frac{\text{Available minutes} \times 60}{\text{CT}} \times \text{Running Cavity}
\]

CT used for capacity is **standard cycle time only**.

---

## 5. Key backend modules (by flow)

| Flow | Primary modules |
|------|-----------------|
| Auth | `routers/auth.py` |
| OEE live + reports | `routers/oee.py`, `routers/email_router.py` |
| Hourly output | `routers/hourly_output.py` |
| Planning | `routers/plans.py` |
| Shots | `imm_shot_counter.py`, `ImmShotEvent` |
| Mold master | `routers/tools.py`, `tool_service.py` |
| Mold mount | `routers/imm_monitor.py`, `ImmMold` |
| Equipment live | `routers/imm_dashboard.py`, OPC UA samples |
| Breakdown | `routers/breakdown.py` |
| Machine status / loss | `routers/machines.py`, status logs |

---

## 6. Data entities (simplified)

```
WorkOrder ──► ProductionPlan ──► Machine / Station / Shift
                 │
                 ├─ mold_id, mold_details_json (CT, cavity, shot weight snapshot)
                 │
ToolStock (mold master) ◄── ImmMold (mounted on machine)
                 │
ImmShotEvent ──► shot counts ──► Actual = shots × cavity
                 │
OEEEntry (manual) / realtime OEE row (computed)
                 │
OEEDefectLog, BreakdownTicket, MachineStatusLog
```

---

## 7. Deploy cheat sheet

| Item | Value |
|------|--------|
| Frontend | `5174` |
| Backend | `8040` |
| Ubuntu update | `git pull origin main` then `./run.sh restart` |
| Repo | https://github.com/murugadelta25/eap_imm_pms |

> If `git pull` fails on local `start.sh` edits: stash/commit/discard that file, then pull again.

---

## 8. Formula quick card (shop floor)

| What you see | How it is calculated |
|--------------|----------------------|
| Shot Counts | Injection cycles this shift |
| Running Cavity | Cavities producing (editable on OEE) |
| Actual | Shots × Cavity |
| Shot Weight (g) | Mold Std. Shot Weight |
| RM Usage (kg) | Shots × Shot Weight ÷ 1000 |
| Possible | (Op time × 60 / CT) × Cavity |
| Prod Loss | Possible − Actual |
| AR | Operating / Planned Prod Time |
| PR | (Units × CT) / Operating Time *(live IMM)* |
| QR | Accp / Actual |
| OEE | AR × PR × QR |

---

*Source of truth: implementation in `backend/app/routers/oee.py`, `hourly_output.py`, `machine_kpi.py`, `imm_shot_counter.py`, and related frontend pages under `frontend/src/pages/`.*
