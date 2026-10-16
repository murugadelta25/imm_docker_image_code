import { timeToMinutes } from '../context/ConfigContext';

/** Parse "HH:MM" to minutes from midnight. */
export function parseTimeToMinutes(hhmm) {
  if (!hhmm) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Format minutes from midnight as HH:MM. */
export function formatMinutes(mins) {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function isOvernightShift(shift) {
  if (!shift?.start || !shift?.end) return false;
  return parseTimeToMinutes(shift.end) <= parseTimeToMinutes(shift.start);
}

/** Build hourly slot definitions for a shift (minute-accurate, supports overnight). */
export function buildShiftHourSlots(shift) {
  if (!shift?.start || !shift?.end) return [];
  const startM = parseTimeToMinutes(shift.start);
  const endM = parseTimeToMinutes(shift.end);
  const overnight = isOvernightShift(shift);
  const totalMinutes = overnight ? (24 * 60 - startM + endM) : Math.max(0, endM - startM);
  const slots = [];
  for (let i = 0; i < totalMinutes; i += 60) {
    const fromM = (startM + i) % (24 * 60);
    const toM = (fromM + 60) % (24 * 60);
    const fromH = Math.floor(fromM / 60);
    const toH = Math.floor(toM / 60);
    slots.push({
      label: `${String(fromH).padStart(2, '0')}:00-${String(toH).padStart(2, '0')}:00`,
      fromMinutes: fromM,
      toMinutes: toM,
      slotIndex: i / 60,
      durationMinutes: 60,
    });
  }
  return slots;
}

/** Cycle time in seconds → parts per minute (rounded for display). */
export function partsPerMinute(ctSec) {
  if (!ctSec || ctSec <= 0) return 0;
  return 60 / ctSec;
}

/** Expected parts for N working minutes at given CT (rounded). */
export function expectedParts(ctSec, workingMinutes) {
  if (!ctSec || ctSec <= 0 || workingMinutes <= 0) return 0;
  return Math.round(workingMinutes * (60 / ctSec));
}

/** Overlap in minutes between [aStart, aEnd) and [bStart, bEnd) on a 24h clock. */
function overlapMinutes(aStart, aEnd, bStart, bEnd) {
  // Normalize ranges that may wrap midnight by expanding to linear timeline
  const normalize = (start, end) => {
    if (end > start) return [[start, end]];
    return [[start, 24 * 60], [0, end]];
  };
  let total = 0;
  for (const [as, ae] of normalize(aStart, aEnd)) {
    for (const [bs, be] of normalize(bStart, bEnd)) {
      const lo = Math.max(as, bs);
      const hi = Math.min(ae, be);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

/**
 * Break windows from shift break config.
 * Each break: { key, start, end, minutes }
 */
export function getBreakWindows(breakCfg = {}) {
  const defs = [
    { key: 'lunch', startKey: 'lunch_start', endKey: 'lunch_end', minKey: 'lunch_break' },
    { key: 'tea', startKey: 'tea_start', endKey: 'tea_end', minKey: 'tea_break' },
    { key: 'tpm', startKey: 'tpm_start', endKey: 'tpm_end', minKey: 'tpm_cleaning' },
  ];
  return defs.map(d => {
    const start = breakCfg[d.startKey] || '';
    const end = breakCfg[d.endKey] || '';
    let minutes = breakCfg[d.minKey] || 0;
    if (start && end) {
      let diff = parseTimeToMinutes(end) - parseTimeToMinutes(start);
      if (diff < 0) diff += 24 * 60;
      minutes = diff || minutes;
    }
    return { key: d.key, start, end, minutes, startM: parseTimeToMinutes(start), endM: parseTimeToMinutes(end) };
  }).filter(b => b.minutes > 0 && b.start);
}

/** Deduct break overlap from a 60-min hour slot. */
export function availableMinutesInSlot(slot, breakWindows) {
  const slotStart = slot.fromMinutes;
  const slotEnd = slot.fromMinutes + 60;
  let deducted = 0;
  for (const bw of breakWindows) {
    deducted += overlapMinutes(slotStart, slotEnd, bw.startM, bw.endM);
  }
  return Math.max(0, 60 - deducted);
}

/** Expected hourly output per slot for a machine CT. */
export function buildExpectedHourlyOutputs(ctSec, slots, breakWindows) {
  return slots.map(slot => expectedParts(ctSec, availableMinutesInSlot(slot, breakWindows)));
}

/** Shift total expected parts (shift minutes − total break minutes). */
export function expectedShiftTotal(ctSec, shiftMinutes, breakCfg) {
  const windows = getBreakWindows(breakCfg);
  const breakTotal = windows.reduce((s, w) => s + w.minutes, 0);
  const untimed = (breakCfg?.other_cleaning || 0) + (breakCfg?.management_meeting || 0);
  return expectedParts(ctSec, Math.max(0, shiftMinutes - breakTotal - untimed));
}

/** Distribute planned qty across hourly slots by productive minutes (largest remainder). */
export function distributePlannedToSlots(slotWeights, target) {
  const n = slotWeights.length;
  if (n === 0) return [];
  if (target <= 0) return Array(n).fill(0);
  const rawSum = slotWeights.reduce((s, w) => s + w, 0);
  if (rawSum <= 0) {
    const base = Math.floor(target / n);
    const rem = target % n;
    return slotWeights.map((_, i) => base + (i < rem ? 1 : 0));
  }
  const scaled = [];
  const remainders = [];
  let allocated = 0;
  slotWeights.forEach((r, i) => {
    const exact = (target * r) / rawSum;
    const flo = Math.floor(exact);
    scaled.push(flo);
    remainders.push({ frac: exact - flo, i });
    allocated += flo;
  });
  remainders
    .sort((a, b) => b.frac - a.frac)
    .slice(0, Math.max(0, target - allocated))
    .forEach(({ i }) => { scaled[i] += 1; });
  return scaled;
}

/**
 * Theoretical max for one shift slot (shift window + configured breaks).
 * Shots = net minutes × 60 / CT; pcs = shots × running cavity.
 */
export function computeShiftCapacity(ctSec, shift, breakCfg = {}, runningCavity = 1) {
  const shiftMinutes = timeToMinutes(shift?.start, shift?.end);
  const breakWindows = getBreakWindows(breakCfg);
  const breakMinutes = breakWindows.reduce((sum, w) => sum + w.minutes, 0)
    + (breakCfg.other_cleaning || 0)
    + (breakCfg.management_meeting || 0);
  const workingMinutes = Math.max(0, shiftMinutes - breakMinutes);
  const cav = Number(runningCavity);
  const cavity = Number.isFinite(cav) && cav > 0 ? cav : 1;
  const maxShots = expectedParts(ctSec, workingMinutes);
  return {
    shiftId: shift?.id,
    shiftName: shift?.name || shift?.id || 'Shift',
    shiftMinutes,
    breakMinutes,
    workingMinutes,
    runningCavity: cavity,
    maxShots,
    maxQty: Math.round(maxShots * cavity),
  };
}

/**
 * Planner hints: per-shift CT × cavity capacity, WO cap, and suggested qty per slot.
 * suggestedQty = min(lowest shift theoretical pcs, WO max per shift slot).
 */
export function computePlanningCapacityHints({
  ctSec,
  shifts = [],
  breaks = {},
  unplannedQty = null,
  slotCount = 1,
  runningCavity = 1,
}) {
  if (!ctSec || ctSec <= 0 || !shifts.length) return null;
  const perShift = shifts.map((sh) =>
    computeShiftCapacity(ctSec, sh, breaks[sh.id] || {}, runningCavity));
  const theoreticalMin = Math.min(...perShift.map((row) => row.maxQty));
  const woCapPerShift = slotCount > 0 && unplannedQty != null
    ? Math.floor(unplannedQty / slotCount)
    : null;
  const suggestedQty = woCapPerShift != null
    ? Math.min(theoreticalMin, woCapPerShift)
    : theoreticalMin;
  const cav = Number(runningCavity);
  return {
    perShift,
    runningCavity: Number.isFinite(cav) && cav > 0 ? cav : 1,
    theoreticalMin,
    theoreticalMax: Math.max(...perShift.map((row) => row.maxQty)),
    woCapPerShift,
    suggestedQty: Math.max(0, suggestedQty),
  };
}

/** Convert seconds of state time to parts at CT. */
export function partsFromSeconds(seconds, ctSec) {
  if (!ctSec || ctSec <= 0 || !seconds) return 0;
  return Math.round(seconds / ctSec);
}
