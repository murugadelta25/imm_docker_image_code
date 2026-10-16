/** QC inspection column layout and hourly instance helpers (mirrors backend qc_shift_utils). */

export const COL_FIRST = 0;
export const COL_OPERATOR_START = 1;
export const MAX_OPERATOR_SLOTS = 24;
export const DEFAULT_OPERATOR_SLOTS = 8;

function parseMins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fmtMins(mins) {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function shiftDurationMinutes(shiftStart, shiftEnd) {
  const startM = parseMins(shiftStart || '06:00');
  const endM = parseMins(shiftEnd || '14:30');
  if (endM <= startM) return (24 * 60 - startM) + endM;
  return endM - startM;
}

/** One inspection column per clock hour in the shift. */
export function shiftHourCount(shiftStart, shiftEnd) {
  const total = shiftDurationMinutes(shiftStart, shiftEnd);
  if (total <= 0) return DEFAULT_OPERATOR_SLOTS;
  const hours = Math.max(1, Math.floor((total + 59) / 60));
  return Math.min(MAX_OPERATOR_SLOTS, hours);
}

export function buildHourSlots(shiftStart, shiftEnd, count) {
  const n = count ?? shiftHourCount(shiftStart, shiftEnd);
  const startM = parseMins(shiftStart || '06:00');
  const total = shiftDurationMinutes(shiftStart, shiftEnd);
  if (total <= 0 || n <= 0) return [];
  const slots = [];
  for (let i = 0; i < n; i += 1) {
    const slotStart = startM + i * 60;
    const slotEnd = Math.min(startM + (i + 1) * 60, startM + total);
    if (slotStart >= startM + total) break;
    slots.push({
      instance: i + 1,
      key: String(i + 1),
      start: fmtMins(slotStart),
      end: fmtMins(slotEnd),
      label: `H${i + 1} (${fmtMins(slotStart)}–${fmtMins(slotEnd)})`,
    });
  }
  return slots;
}

export function computeShiftLayout(shiftStart, shiftEnd, hourSlotsFromApi) {
  const hourSlots = hourSlotsFromApi?.length
    ? hourSlotsFromApi
    : buildHourSlots(shiftStart, shiftEnd);
  const operatorCount = hourSlots.length || DEFAULT_OPERATOR_SLOTS;
  const cellCount = 1 + operatorCount + 2;
  const colInspectorStart = 1 + operatorCount;
  const colInspectorEnd = colInspectorStart + 1;
  const colOperatorEnd = COL_OPERATOR_START + operatorCount - 1;
  return {
    hourSlots,
    operatorCount,
    cellCount,
    colInspectorStart,
    colInspectorEnd,
    colOperatorEnd,
  };
}

export function operatorCountFromApproval(approval) {
  const slots = approval?.hour_slots || [];
  return slots.length || approval?.operator_slot_count || DEFAULT_OPERATOR_SLOTS;
}

export function colOperatorEnd(approval) {
  return COL_OPERATOR_START + operatorCountFromApproval(approval) - 1;
}

export function colInspectorStart(approval) {
  return COL_OPERATOR_START + operatorCountFromApproval(approval);
}

export function colInspectorEnd(approval) {
  return colInspectorStart(approval) + 1;
}

export function cellCountFor(approval) {
  return 1 + operatorCountFromApproval(approval) + 2;
}

export function colToInstanceKey(col, approval) {
  if (col === COL_FIRST) return 'first';
  const end = colOperatorEnd(approval);
  if (col >= COL_OPERATOR_START && col <= end) return String(col - COL_OPERATOR_START + 1);
  return null;
}

export function instanceKeyToCol(key, approval) {
  if (key === 'first') return COL_FIRST;
  const n = Number(key);
  const opCount = operatorCountFromApproval(approval);
  if (n >= 1 && n <= opCount) return COL_OPERATOR_START + n - 1;
  return null;
}

export function normalizeCells(cells, approval) {
  const cc = cellCountFor(approval);
  const out = (cells || []).map((c) => (c != null ? String(c) : ''));
  while (out.length < cc) out.push('');
  return out.slice(0, cc);
}

export function validateInstanceReadings(readings, displayParams, instanceKey, approval) {
  const col = instanceKeyToCol(instanceKey, approval);
  if (col == null) return { complete: false, missing: [], col: null };
  const missing = (displayParams || []).filter((p, i) => {
    const row = readings[i];
    const cells = Array.isArray(row) ? row : (row?.cells || []);
    return !String(cells[col] ?? '').trim();
  }).map((p) => p.parameter);
  return { complete: missing.length === 0, missing, col };
}

export function instanceSubmitLabel(instanceKey) {
  if (!instanceKey) return 'Submit';
  if (instanceKey === 'first') return 'Submit 1st piece';
  return `Submit Hour ${instanceKey}`;
}

function nowMins(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

export function instanceStatusColor(status) {
  if (status === 'approved' || status === 'frozen') return 'green';
  if (['pending_inspector', 'pending_incharge', 'draft'].includes(status)) return 'yellow';
  if (status === 'rejected') return 'red';
  if (status === 'missed') return 'gray';
  return 'neutral';
}

/** Readable badge colors (dark text on light tinted backgrounds). */
export const INSTANCE_STATUS_THEME = {
  green: { bg: '#e8f5e9', color: '#1b5e20', border: '#81c784' },
  yellow: { bg: '#fff3e0', color: '#e65100', border: '#ffb74d' },
  red: { bg: '#ffebee', color: '#b71c1c', border: '#e57373' },
  gray: { bg: '#eceff1', color: '#37474f', border: '#90a4ae' },
  neutral: { bg: '#f5f5f5', color: '#424242', border: '#bdbdbd' },
};

export function instanceStatusTheme(status) {
  return INSTANCE_STATUS_THEME[instanceStatusColor(status)] || INSTANCE_STATUS_THEME.neutral;
}

const FROZEN = new Set(['pending_inspector', 'pending_incharge', 'approved', 'frozen', 'rejected']);

export function columnIsFrozen(approval, col) {
  const key = colToInstanceKey(col, approval);
  if (!key) {
    const ci0 = colInspectorStart(approval);
    const ci1 = colInspectorEnd(approval);
    return col === ci0 || col === ci1;
  }
  return FROZEN.has(approval?.instances?.[key]?.status);
}

export function columnIsMissed(approval, col) {
  const key = colToInstanceKey(col, approval);
  if (!key || key === 'first') return false;
  return approval?.instances?.[key]?.status === 'missed';
}

export function currentEditableInstance(approval, now = new Date()) {
  const instances = approval?.instances || {};
  const first = instances.first || {};
  if (['empty', 'draft'].includes(first.status || 'empty')) return 'first';
  const nm = nowMins(now);
  for (const slot of approval?.hour_slots || []) {
    const key = slot.key;
    const inst = instances[key] || {};
    const status = inst.status || 'empty';
    if (['missed', 'pending_inspector', 'pending_incharge', 'approved', 'rejected', 'frozen'].includes(status)) continue;
    const endM = parseMins(inst.hour_end || '23:59');
    const startM = parseMins(inst.hour_start || '00:00');
    if (nm >= startM && nm < endM) return key;
    if (['empty', 'draft'].includes(status) && nm < endM) return key;
  }
  return null;
}

export function columnEditableForOperator(approval, col, now = new Date()) {
  const ci0 = colInspectorStart(approval);
  const ci1 = colInspectorEnd(approval);
  if (col === ci0 || col === ci1) return false;
  if (columnIsFrozen(approval, col) || columnIsMissed(approval, col)) return false;
  const key = colToInstanceKey(col, approval);
  if (!key) return false;
  return key === currentEditableInstance(approval, now);
}

export function columnEditableForInspector(approval, col, reviewingKey) {
  const ci0 = colInspectorStart(approval);
  const ci1 = colInspectorEnd(approval);
  if (col !== ci0 && col !== ci1) return false;
  if (!reviewingKey) return false;
  return approval?.instances?.[reviewingKey]?.status === 'pending_inspector';
}

export function isCellReadOnly(approval, col, value, role, reviewingKey, now = new Date()) {
  const ci0 = colInspectorStart(approval);
  const ci1 = colInspectorEnd(approval);
  if (col === ci0 || col === ci1) {
    return !columnEditableForInspector(approval, col, reviewingKey);
  }
  if (columnIsMissed(approval, col)) return true;
  if (columnIsFrozen(approval, col)) return true;
  if (role === 'operator' || role === 'admin') {
    return !columnEditableForOperator(approval, col, now);
  }
  return true;
}

export function getCellStyle(approval, col, value, s, role, reviewingKey, now = new Date()) {
  const filled = String(value ?? '').trim() !== '';
  const base = { ...s.td };
  if (filled) return base;

  if (columnIsMissed(approval, col)) {
    return { ...base, background: '#e8e8e8', color: '#546e7a' };
  }
  const ci0 = colInspectorStart(approval);
  const ci1 = colInspectorEnd(approval);
  if ((col === ci0 || col === ci1) && !columnEditableForInspector(approval, col, reviewingKey)) {
    return { ...base, background: '#f5f5f5', color: '#78909c' };
  }
  if ((role === 'operator' || role === 'admin') && !columnEditableForOperator(approval, col, now)) {
    return { ...base, background: '#eeeeee', color: '#78909c' };
  }
  if (columnIsFrozen(approval, col) && col !== ci0 && col !== ci1) {
    return { ...base, background: '#f0f0f0', color: '#78909c' };
  }
  return base;
}

export function pendingReviewInstance(approval, status = 'pending_inspector') {
  return Object.entries(approval?.instances || {}).find(([, v]) => v.status === status)?.[0] || null;
}

export function pendingInstanceKeys(approval, status = 'pending_inspector') {
  return Object.entries(approval?.instances || {})
    .filter(([, v]) => v.status === status)
    .map(([k]) => k);
}

export function instanceDisplayLabel(key, hourSlots = []) {
  if (!key) return '—';
  if (key === 'first') return '1st piece';
  const slot = hourSlots.find((h) => h.key === key);
  return slot?.label || `Hour ${key}`;
}

export const INSTANCE_STATUS_LABEL = {
  empty: '—',
  draft: 'Draft',
  pending_inspector: 'Awaiting QC',
  pending_incharge: 'Awaiting Supervisor',
  approved: 'Completed',
  frozen: 'Submitted',
  rejected: 'Rejected',
  missed: 'Missed',
};
