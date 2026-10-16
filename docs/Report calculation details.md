# Report Calculation Details

**Product:** EAP IMM PMS (Production Monitoring System)  
**Document purpose:** Customer reference for OEE / production report columns, formulas, and how derived values are calculated  
**Applies to:** Production OEE Dashboard download and scheduled email OEE reports (**Live** rows)  
**Timezone:** IST (Asia/Kolkata)  
**Document name:** Report calculation details  
**Version:** 1.1  

---

## 1. Important note (Live IMM OEE)

The **Live** OEE report does **not** calculate Performance as:

> Actual ÷ Possible

That is why many rows can show **100% AR / PR / QR / OEE** even when **Actual &lt; Possible** and **Prod Loss &gt; 0**.

Live OEE uses **time-based** Availability and Performance formulas (Sections 5–7). Possible Qty is for **capacity / loss display** only.

---

## 2. Report columns — meaning

| Column | Meaning |
|--------|---------|
| Date / Station / Machine / Shift | Shift identity |
| Work Order / Model / Variant | Plan / mold context |
| Running Cavity | Cavities producing parts per shot |
| Shot Weight (g) | Standard shot weight from mold master / plan |
| Shot Counts | Injection cycles (shots) in the shift |
| RM Usage (kg) | Material usage from shots × shot weight |
| CT (sec) | Set / standard cycle time |
| Avail (min) | Planned production time |
| Op Time (min) | Operating time |
| Plan Qty | Planned quantity from production plan |
| Possible Qty | Theoretical capacity (pcs) — **not used in PR%** |
| Actual Qty | Units produced (pcs) |
| Prod Loss | Possible − Actual (pcs) |
| Accepted Qty / Defect Qty | Good vs rejected units |
| AR% / PR% / QR% / OEE% | Display rates (**capped at 100%**) |
| AR% / PR% / QR% / OEE% (original) | Uncapped rates when available (Live may show “—”) |
| Source | `Live` = realtime; `Data Entry` = manual entry |

---

## 3. How Live OEE inputs are derived

| Symbol | Meaning (from report) |
|--------|------------------------|
| **Avail (min)** | Planned production time ≈ Scheduled − Planned downtime |
| **Op Time (min)** | Operating time = Planned production time − Unplanned downtime |
| **CT (sec)** | Set / standard cycle time |
| **Actual Qty** | Units produced (Shot Count × Running Cavity in the live path) |
| **Accepted Qty** | Good units = Actual − Defect |
| **Possible Qty** | Capacity for display: (Op or Planned min × 60 / CT) × cavity — **not used in PR%** |

---

## 4. Quantity & material formulas

### 4.1 Actual Qty

\[
\textbf{Actual Qty} = \textbf{Shot Count} \times \textbf{Running Cavity}
\]

### 4.2 Accepted Qty

\[
\textbf{Accepted Qty} = \max(0,\ \textbf{Actual Qty} - \textbf{Defect Qty})
\]

### 4.3 Shot Weight & RM Usage

**Shot Weight (g)** = mold Std. Shot Weight (plan snapshot → mold master → mounted mold).

\[
\textbf{RM Usage (kg)} = \frac{\textbf{Shot Count} \times \textbf{Shot Weight (g)}}{1000}
\]

**Example:** 90 shots × 65 g = 5,850 g = **5.850 kg**

### 4.4 Possible Qty & Prod Loss

\[
\textbf{Possible shots} = \textbf{Operating Time (min)} \times \frac{60}{\textbf{CT (sec)}}
\]

\[
\textbf{Possible Qty} = \textbf{Possible shots} \times \textbf{Running Cavity}
\]

\[
\textbf{Prod Loss} = \max(0,\ \textbf{Possible Qty} - \textbf{Actual Qty})
\]

---

## 5. Live IMM OEE formulas (primary method)

### 5.1 Availability (AR%)

\[
\textbf{AR\%} = \frac{\textbf{Operating Time}}{\textbf{Planned Production Time}} \times 100
\]

### 5.2 Performance (PR%)

\[
\textbf{PR\%} = \frac{\textbf{Units} \times \textbf{CT (sec)}}{\textbf{Operating Time (sec)}} \times 100
\]

Same as:

\[
\textbf{PR\%} = \frac{\textbf{Actual Qty} \times \textbf{CT}}{\textbf{Op Time (min)} \times 60} \times 100
\]

**PR% is not Actual ÷ Possible.**

### 5.3 Quality (QR%)

\[
\textbf{QR\%} = \frac{\textbf{Accepted Qty}}{\textbf{Actual Qty}} \times 100
\]

If Actual = 0 ⇒ QR treated as **100%**.

### 5.4 Overall Equipment Effectiveness (OEE%)

\[
\textbf{OEE\%} = \frac{\textbf{AR\%} \times \textbf{PR\%} \times \textbf{QR\%}}{10000}
\]

---

## 6. Display capping

For customer-facing columns, rates are capped at 100%:

\[
\begin{aligned}
\textbf{AR\% (shown)} &= \min(\textbf{AR\% raw},\ 100) \\
\textbf{PR\% (shown)} &= \min(\textbf{PR\% raw},\ 100) \\
\textbf{QR\% (shown)} &= \min(\textbf{QR\% raw},\ 100)
\end{aligned}
\]

Uncapped values (AR/PR/QR/OEE “original”) may appear as **—** on Live rows when not exported.

---

## 7. Why rows can show “all 100%”

### 7.1 AR = 100%

When **Avail = Op Time** (e.g. both 720):

\[
\text{AR} = \frac{720}{720} \times 100 = 100\%
\]

⇒ no unplanned downtime subtracted in that calculation.

### 7.2 QR = 100%

When **Defect Qty = 0**:

\[
\text{Accepted} = \text{Actual} \Rightarrow \text{QR} = 100\%
\]

### 7.3 PR = 100% (often capped — not “perfect vs Possible”)

If PR raw exceeds 100%, the report stores **PR = 100**.

\[
\textbf{PR raw} = \frac{\textbf{Actual} \times \textbf{CT}}{\textbf{Op Time} \times 60} \times 100
\]

So a row can have **Actual ≪ Possible** and still show **PR = 100%** if:

\[
(\textbf{Actual} \times \textbf{CT}) \ge \textbf{Operating Time in seconds}
\]

Common causes: high unit count vs set CT, cavity scaling, CT mismatch, or missing downtime.

### 7.4 OEE = 100%

When capped AR = PR = QR = 100:

\[
\text{OEE} = \frac{100 \times 100 \times 100}{10000} = 100\%
\]

When PR is not capped (example below): OEE follows the lower PR.

---

## 8. Worked examples (sample Live report date 08-10-2026)

Assumptions for these rows: **Op Time = 720 min**, **Defect = 0** ⇒ QR = 100%, and typically Avail = 720 ⇒ AR = 100%.

| Machine / Shift | Actual | CT (sec) | Op (min) | PR raw | Shown PR |
|-----------------|--------|----------|----------|--------|----------|
| IMM17 B | 37 | 65 | 720 | (37 × 65) / (720 × 60) × 100 = **5.57%** | **5.57** (not capped) |
| IMM17 A | 455 | 65 | 720 | **68.46%** | **68.46** |
| IMM_11 A | 567 | 55 | 720 | **72.19%** | **72.19** |
| IMM18 B | 1523 | 35 | 720 | (1523 × 35) / 43200 × 100 ≈ **123%** | **100** (capped) |
| IMM_07 A | 6280 | 40 | 720 | ≈ **581%** | **100** (capped) |
| IMM_09 A | 2226 | 45 | 720 | ≈ **232%** | **100** (capped) |

**OEE check — IMM17 B (uncapped PR):**

\[
\text{OEE} = \frac{100 \times 5.57 \times 100}{10000} = 5.57\%
\]

**OEE check — capped PR machines:**

\[
\text{OEE} = \frac{100 \times 100 \times 100}{10000} = 100\%
\]

**Possible Qty vs PR (IMM18 B example):**

| Column | Role | Example value |
|--------|------|----------------|
| Possible Qty | Capacity at CT × cavity | 2468 |
| Actual Qty | Units produced | 1523 |
| Prod Loss | Possible − Actual | 945 |
| PR% | (Actual × CT) / operating seconds, then capped | **100** (raw ≈ 123%) |

Possible / Prod Loss do **not** force PR below 100% under the Live formula.

---

## 9. Possible Qty vs PR% (easy to confuse)

| Column | Role |
|--------|------|
| **Possible Qty** | How many pcs *could* fit in Op/Planned time at CT × cavity (capacity / loss display) |
| **Prod Loss** | Possible − Actual |
| **PR %** | (Actual × CT) / Operating seconds — time-based performance, then capped at 100% |

---

## 10. Quick reference card

| Report column | Formula / derivation |
|---------------|----------------------|
| Shot Counts | Count of shots in shift |
| Running Cavity | Plan / mold cavity |
| Actual Qty | Shot Counts × Running Cavity |
| Shot Weight (g) | Mold Std. Shot Weight |
| RM Usage (kg) | Shot Counts × Shot Weight ÷ 1000 |
| CT (sec) | Standard cycle time |
| Avail (min) | Planned Production Time |
| Op Time (min) | Operating Time |
| Possible Qty | (Op Time × 60 / CT) × Running Cavity |
| Prod Loss | max(0, Possible − Actual) |
| Accepted Qty | Actual − Defect |
| AR% | Op Time / Avail × 100 (≤ 100) |
| PR% | (Actual × CT) / (Op Time × 60) × 100 (≤ 100) |
| QR% | Accepted / Actual × 100 (≤ 100) |
| OEE% | AR × PR × QR / 10000 |

---

## 11. Practical takeaways

1. **100% AR** ⇒ Op Time equals Planned Production Time (no unplanned DT in the calc).  
2. **100% QR** ⇒ zero defects recorded.  
3. **100% PR / OEE** on high-output machines often means **PR was capped**, not “Actual = Possible”. Review unit count vs CT and whether downtime is fully reported.  
4. Machines with lower output correctly show lower PR/OEE (e.g. IMM17 B ≈ 5.57%).  
5. Shot Weight and RM Usage are independent of AR/PR/QR.

---

## 12. Document control

| Item | Value |
|------|--------|
| Document name | Report calculation details |
| Audience | Customer / plant operations |
| System | EAP IMM PMS |
| Version | 1.1 |

---

*End of document*
