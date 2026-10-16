// ── Shot Counter & CSV Writer ──────────────────────────────────────────────
// Placed after "Normalize & store IMM trx".
// Receives msg.payload = { machine_id, machine_name, parameters: { Total_Good_Count, ... } }
//
// Logic:
//  - Shot count  : any CHANGE in Total_Good_Count value → +1 shot
//  - Counter     : only increments when new Total_Good_Count > 0 (status=1 logic)
//  - Shift A     : 08:00 – 20:00  local time  (CSV: ShiftA_YYYY-MM-DD.csv)
//  - Shift B     : 20:00 – 08:00 next day     (CSV: ShiftB_YYYY-MM-DD.csv, date = shift-start date)
//  - Counter resets at each shift boundary per machine
//  - CSV path    : /data/eap_shots/  (Node-RED /data directory)

const fs   = global.get('fs')   || require('fs');
const path = global.get('path') || require('path');

const CSV_DIR = '/data/eap_shots';

// ── helpers ─────────────────────────────────────────────────────────────────
function getShiftInfo(now) {
  // 'now' is a Date object (local time via getHours())
  const h = now.getHours();         // 0-23 local
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  if (h >= 8 && h < 20) {
    // Shift A: started today 08:00
    return { shift: 'A', dateLabel: fmt(now) };
  } else {
    // Shift B: started at 20:00 on either today (if h>=20) or yesterday (if h<8)
    const startDate = new Date(now);
    if (h < 8) startDate.setDate(startDate.getDate() - 1); // started yesterday
    return { shift: 'B', dateLabel: fmt(startDate) };
  }
}

function csvFileName(shift, dateLabel) {
  return path.join(CSV_DIR, 'Shift' + shift + '_' + dateLabel + '.csv');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendCsvRow(filePath, row) {
  const needHeader = !fs.existsSync(filePath);
  const header = 'timestamp,shift,date_label,machine_id,machine_name,total_good_count,shot_count,counter\n';
  const line   =
    [row.timestamp, row.shift, row.date_label,
     row.machine_id, row.machine_name,
     row.total_good_count, row.shot_count, row.counter
    ].join(',') + '\n';
  if (needHeader) fs.writeFileSync(filePath, header, 'utf8');
  fs.appendFileSync(filePath, line, 'utf8');
}

// ── main ─────────────────────────────────────────────────────────────────────
const entry = msg.payload;
if (!entry || !entry.parameters) return null;

const params  = entry.parameters;
const rawGC   = params.Total_Good_Count;
if (rawGC === undefined || rawGC === null || rawGC === '') return null;

const machineId   = entry.machine_id   || null;
const machineName = entry.machine_name || 'UNKNOWN';
const storeKey    = machineId ? ('m' + machineId) : machineName.toUpperCase();

const now       = new Date();
const shiftInfo = getShiftInfo(now);
const shiftKey  = shiftInfo.shift + '_' + shiftInfo.dateLabel; // e.g. "A_2026-10-07"

// ── per-machine state ─────────────────────────────────────────────────────
const allState = global.get('EAP_SHOT_STATE') || {};
let   st       = allState[storeKey];

if (!st) {
  st = { prevGC: null, shotCount: 0, counter: 0, shiftKey: '' };
}

// Detect shift boundary → reset
if (st.shiftKey !== shiftKey) {
  st.shotCount = 0;
  st.counter   = 0;
  st.shiftKey  = shiftKey;
  // prevGC is preserved across shift boundary so first value after reset
  // doesn't spuriously fire a shot if OPC UA sends same value at start of shift.
}

const newGC  = String(rawGC).trim();
const prevGC = st.prevGC;

let shotFired = 0;

if (prevGC !== null && prevGC !== newGC) {
  // Any change in Total_Good_Count = 1 shot
  shotFired   = 1;
  st.shotCount += 1;

  // Counter: only when new value > 0 (status=1 logic)
  const numericGC = parseFloat(newGC);
  if (Number.isFinite(numericGC) && numericGC > 0) {
    st.counter += 1;
  }
}

st.prevGC = newGC;
allState[storeKey] = st;
global.set('EAP_SHOT_STATE', allState);

// ── write CSV ─────────────────────────────────────────────────────────────
try {
  ensureDir(CSV_DIR);
  const filePath = csvFileName(shiftInfo.shift, shiftInfo.dateLabel);
  const pad = (n) => String(n).padStart(2, '0');
  const ts  = now.getFullYear() + '-' +
              pad(now.getMonth() + 1) + '-' +
              pad(now.getDate()) + 'T' +
              pad(now.getHours()) + ':' +
              pad(now.getMinutes()) + ':' +
              pad(now.getSeconds());
  appendCsvRow(filePath, {
    timestamp      : ts,
    shift          : shiftInfo.shift,
    date_label     : shiftInfo.dateLabel,
    machine_id     : machineId !== null ? machineId : '',
    machine_name   : machineName,
    total_good_count: newGC,
    shot_count     : st.shotCount,
    counter        : st.counter
  });
} catch (e) {
  node.warn('CSV write error: ' + e.message);
}

// ── output ────────────────────────────────────────────────────────────────
msg.payload = {
  machine_id        : machineId,
  machine_name      : machineName,
  Total_Good_Count  : newGC,
  machine_shot_count: st.shotCount,
  counter           : st.counter,
  shift             : shiftInfo.shift,
  shift_date        : shiftInfo.dateLabel,
  shot_fired        : shotFired
};

node.status({
  fill : shotFired ? 'green' : 'blue',
  shape: 'dot',
  text : machineName + ' GC=' + newGC + ' shots=' + st.shotCount + ' ctr=' + st.counter
});

return msg;
