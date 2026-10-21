# Application Flow and Formulas

**Product:** Production Monitoring System (Injection Molding)  
**Document version:** 1.0  
**Purpose:** Generic application flow and calculation formulas (shareable)  
**Business timezone:** Site local / configured plant time  

---

## 1. System overview

The application monitors injection molding machines, plans production, computes OEE, tracks shots and material usage, and supports quality control, breakdown, and mold life workflows.

| Tier | Role |
|------|------|
| Presentation | Web application (browser) |
| Application | API / business services |
| Data | Relational database |
| Optional edge | Machine data bridge (industrial tags / gateway) |

```
Operators / Supervisors / QC / Maintenance / Admin
        │
        ▼
     Web UI  ──HTTP / WebSocket──►  Application API  ──►  Database
                                         ▲
                          Machine data bridge / industrial tags
```

---

## 2. Application map (main screens)

| Screen | Purpose |
|--------|---------|
| Login | User authentication |
| Factory Dashboard | Live factory overview |
| Zone Dashboard | Zone-level machine status |
| Device Monitor | Machine list / live status |
| Equipment Detail | Live tags, shots, mold, cycle time |
| KPI Dashboard | KPI history views |
| Energy Dashboard | Energy-related views |
| Production OEE Dashboard | Live + data-entry OEE table |
| Machine Hourly Output | Hourly Running / Possible / material |
| Production Planning | Plans, mold, cavity, CT, capacity |
| Work Orders | Work order create / track |
| Data Entry | Manual OEE entry |
| Breakdown | Raise issue to maintenance |
| Maintenance Dashboard | Ticket handling |
| Loss Tracker | Status timeline / losses |
| Model Change | Mold / model change requests |
| Mold Management | Mold master (CT, cavity, shot weight) |
| Part Master | Part definitions |
| Work Instructions | Operator work instructions / process sheets |
| QC Approvals | Inspection approvals |
| Email Alerts | Report schedules and OEE reports |
| Setup | Machines, stations, site configuration |
| Admin | Users and operators |

---

## 3. End-to-end application flows

### 3.1 Startup / access

```
Deploy application services and database
  → User opens the web application URL
  → Login → session established → main shell (navigation + pages)
  → Optional live updates for machine / OEE status
```

---

### 3.2 Master data → plan → run

```
1. Mold Management       Create mold: Std CT, Running Cavity, Std. Shot Weight (g)
2. Part / Work Order     Link part and work order to mold
3. Production Planning   Select machine, shift, mold
                         CT = standard cycle time only (mold change time not added)
                         Possible capacity uses CT × running cavity
4. Mold Monitoring       Mount mold on machine
5. Live capture          Machine tags → shot events / status logs
6. Dashboards            OEE / Hourly / Equipment show live metrics
```

---

### 3.3 Shot counting flow

```
Machine tags / gateway
        │
        ▼
Shot counter service
        │
        ├─ Count-based machines: production/good count change ⇒ 1 shot
        ├─ Status-based machines: injection / refilling sequence ⇒ 1 shot
        │
        ▼
Shot events (+ mold usage / mold life cycles)
        │
        ▼
Actual parts = Shot Count × Running Cavity
```

- Shift shot counter applies to events inside the shift window.
- Mold / tool life does **not** reset at shift start.

---

### 3.4 Production OEE Dashboard flow

```
Production OEE Dashboard
  → Load live OEE (plans + shots + downtime)
  → Merge with manual OEE entry when no live row
  → Columns: cavity, shot weight, shot counts, RM usage, AR / PR / QR / OEE
  → QC edit defects; edit running cavity on plan
  → Email / spreadsheet export include shot weight, shots, RM (kg)
```

**Shot weight resolution order:**

1. Production plan mold snapshot  
2. Mold master (by mold id / code / variant)  
3. Active mounted mold on the machine → mold master Std. Shot Weight  

---

### 3.5 Hourly Output flow

```
Machine Hourly Output
  → Build hourly output for machine / shift
  → Per hourly slot
  → Possible pcs = CT capacity × cavity
  → Running pcs = shots × cavity (when shot events available)
  → Shot Weight (g), Required RM (kg) rows
```

---

### 3.6 Breakdown / maintenance flow

```
Operator opens Breakdown → Raise Issue to Maintenance
  → Select Planned or Unplanned reason
  → Select raised-by → Submit
  → Ticket created → Maintenance Dashboard
  → Resolve / close; may affect downtime / OEE Availability
```

---

### 3.7 QC flow

```
OEE Dashboard / Data Entry
  → Enter defect quantity (+ optional rejection log)
  → Accepted = Actual − Defect
  → QR / OEE recalculated
  → Defect history retained
  → QC Approvals for inspection workflows (separate module)
```

---

### 3.8 Email report flow

```
Email Alerts configuration (mail settings + schedule + report types)
  → Scheduler or manual send
  → OEE report includes:
       Running Cavity | Shot Weight (g) | Shot Counts | RM Usage (kg) | …
  → Attach to recipients
```

---

## 4. Formulas reference

### 4.1 Core quantity relationships

| Name | Formula | Notes |
|------|---------|--------|
| Cycle Time (CT) | Standard cycle time (sec) from mold / plan | Planning: mold change time is not added to CT |
| Data Entry CT | Process Time + Loading/Unloading (sec) | Manual OEE entry form only |
| Shot Count | Count of injection cycles in window | From shot events / count / status sequence |
| Actual Qty (pcs) | Shot Count × Running Cavity | Parts produced |
| Possible shots | Operating (or planned prod) minutes × (60 / CT) | Integer where applied |
| Possible Qty (pcs) | Possible shots × Running Cavity | Theoretical capacity |
| Production Loss | max(0, Possible Qty − Actual Qty) | |
| Accepted Qty | max(0, Actual Qty − Defect Qty) | |

---

### 4.2 Material / shot weight

| Name | Formula | Unit |
|------|---------|------|
| Std. Shot Weight | From mold master / plan snapshot | g / shot |
| Shot Weight (hourly actual) | Actual shots × Std. Shot Weight | g |
| Req RM (hourly) | (Possible pcs ÷ Running Cavity) × Std. Shot Weight ÷ 1000 | kg |
| RM Usage (OEE dashboard) | Shot Count × Std. Shot Weight ÷ 1000 | kg |

**Example:** 90 shots × 65 g = 5850 g = **5.850 kg** RM usage.

---

### 4.3 Hourly Possible Output (capacity)

For each hour slot (after breaks / production windows):

```
Possible pcs/hour = (Net minutes × 60 / CT) × Running Cavity
```

---

### 4.4 Live IMM OEE (Production OEE Dashboard)

| Step | Formula |
|------|---------|
| Scheduled | Shift start → evaluation end (minutes) |
| Planned Production Time | Scheduled − Planned Downtime |
| Operating Time | Planned Production Time − Unplanned Downtime |
| AR % | Operating Time / Planned Production Time × 100 |
| PR % | (Units × Set CT) / Operating Time (sec) × 100 |
| QR % | Good Units / Units × 100 (100% if no units) |
| OEE % | AR × PR × QR / 10000 |

Where:

- Units = Actual Qty = Shots × Running Cavity  
- Good Units = Accepted Qty  
- Display AR / PR / QR / OEE are capped at 100%; uncapped originals may be kept for audit  

**Possible Qty (live):**

```
Possible shots = Operating (or Planned Prod) min × (60 / CT)
Possible Qty = Possible shots × Running Cavity
```

---

### 4.5 Manual Data Entry OEE

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
| Accepted | Actual − Defect |
| AR % | Operating / Available × 100 |
| PR % | Actual / Possible × 100 |
| QR % | Accepted / Actual × 100 |
| OEE % | AR × PR × QR / 10000 |

---

### 4.6 Hourly Output OEE (per slot)

| Metric | Formula |
|--------|---------|
| AR % | Operating minutes / Available minutes × 100 (capped 100) |
| PR % | Actual parts (running) / Expected (possible) × 100 |
| QR % | From OEE entries average (default 100) |
| OEE % | AR × PR × QR / 10000 |

Shift totals use the same formulas with summed minutes / quantities.

---

### 4.7 Machine KPI formulas

| Metric | Formula |
|--------|---------|
| Expected Qty | Available Time (min) × 60 / CT |
| Theoretical Qty | Shift Total (min) × 60 / CT |
| AR % | Operating Time / Available Time × 100 |
| PR % | Actual / Expected × 100 |
| QR % | Good / Actual × 100 |
| OEE % | AR × PR × QR / 10000 |
| MUR | Actual Production Time / Available Time × 100 |
| Production Yield | Actual / Theoretical × 100 |
| TEEP | OEE × MUR / 100 |

---

### 4.8 Planning capacity

On Production Planning:

```
Possible / capacity ∝ (Available minutes × 60 / CT) × Running Cavity
```

CT used for capacity is **standard cycle time only**.

---

## 5. Functional modules (by flow)

| Flow | Area |
|------|------|
| Auth | Login / session |
| OEE live + reports | OEE calculation and report export |
| Hourly output | Hourly capacity and production |
| Planning | Production plans |
| Shots | Shot counting and events |
| Mold master | Mold master data |
| Mold mount | Mold mounted on machine |
| Equipment live | Live equipment parameters |
| Breakdown | Breakdown tickets |
| Machine status / loss | Status logs and loss tracking |

---

## 6. Data entities (simplified)

```
Work Order ──► Production Plan ──► Machine / Station / Shift
                 │
                 ├─ mold reference, CT, cavity, shot weight snapshot
                 │
Mold master ◄── Mounted mold (on machine)
                 │
Shot events ──► shot counts ──► Actual = shots × cavity
                 │
Manual OEE entry / live OEE row (computed)
                 │
Defect log, Breakdown ticket, Machine status log
```

---

## 7. Formula quick card (shop floor)

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
| QR | Accepted / Actual |
| OEE | AR × PR × QR |

---

*End of document*
