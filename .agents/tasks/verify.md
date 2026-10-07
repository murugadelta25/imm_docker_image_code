# Verification Results

## Backend syntax / import check

```
cd /home/sie/EAP-IMM/eap_imm_pms/backend
source .venv/bin/activate
python -m py_compile app/routers/imm_dashboard.py  → Syntax OK
python -m py_compile app/routers/oee.py            → Syntax OK
python -c "from app.main import app; print('OK')"  → OK
```

## Frontend build

```
cd /home/sie/EAP-IMM/eap_imm_pms/frontend
npm run build
```

Result: **✓ built in 578ms**

Note: dist/assets were owned by root from a previous deployment; ownership was corrected with `sudo chown -R sie:sie dist/` before building. The chunk-size warning (`index-aWUsk-vv.js 1811 kB`) is pre-existing and not introduced by this change.

## What was changed

**File:** `backend/app/routers/imm_dashboard.py`

- Renamed internal variable `prod_qty` → `shift_act_qty` to make its meaning explicit (shift-scoped OEE shot count).
- Added `lifetime_act_prod` by reading `Actual_Production_Count` from the OPC UA highlights dict via the existing `num_or_none()` helper.
- `prod_counts.act_prod` now returns `lifetime_act_prod` (the PLC cumulative counter, e.g. 32594) instead of `shift_act_qty` (e.g. 18).
- `production.quantity` still uses `shift_act_qty` — this field feeds UPH calculations and must remain shift-scoped.

**No frontend changes required.** The frontend's `prodCounts` memo already has the correct guard:
```js
value: pc.act_prod != null ? n(pc.act_prod) : fmt('Actual_Production_Count'),
```
After the backend fix, `act_prod` carries the correct lifetime value so the tile displays it directly.

**Bug 2 (shift bad/good count logic):** Confirmed already correct in the backend — `_batch_shift_production` derives `shift_good = shift_act - shift_bad` and `shift_act` is unchanged when defect_qty is updated. `_materialize_oee_from_realtime` reads `actual_qty` from the live realtime OEE snapshot, not from zero. No changes needed.
