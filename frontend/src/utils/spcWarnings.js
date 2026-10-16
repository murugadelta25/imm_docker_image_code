import { COL_FIRST, COL_OPERATOR_START } from './qcShiftHours';

/** More than 5 consecutive → at least 6 */
export const MIN_SAME_SIDE_RUN = 6;
/** More than 2 out-of-spec → at least 3 */
export const MIN_OOS_COUNT = 3;

export function parseMeasuredValue(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text || ['OK', 'NOK', 'VISUAL', '—', '-'].includes(text.toUpperCase())) return null;
  const m = text.match(/[-+]?\d*\.?\d+/);
  return m ? Number(m) : null;
}

export function resolveParamLimits(param) {
  const lsl = param?.lsl;
  const usl = param?.usl;
  if (lsl != null && usl != null) {
    const l = Number(lsl);
    const u = Number(usl);
    return { nominal: (l + u) / 2, lsl: Math.min(l, u), usl: Math.max(l, u) };
  }
  return null;
}

/** Numeric readings in chronological order (1st, H1, H2, …). */
export function extractChronologicalValues(cells, approval) {
  const hourSlots = approval?.hour_slots || [];
  const cols = [COL_FIRST];
  hourSlots.forEach((_, idx) => cols.push(COL_OPERATOR_START + idx));

  const points = [];
  cols.forEach((col) => {
    const raw = cells?.[col];
    const value = parseMeasuredValue(raw);
    if (value != null) {
      points.push({ value, raw: String(raw ?? '') });
    }
  });
  return points;
}

export function detectParameterWarnings(numericPoints, limits) {
  if (!limits || !numericPoints?.length) return [];

  const warnings = [];
  const { nominal, lsl, usl } = limits;

  let run = 0;
  let side = null;
  for (let i = numericPoints.length - 1; i >= 0; i -= 1) {
    const v = numericPoints[i].value;
    const s = v > nominal ? 'above' : v < nominal ? 'below' : 'on';
    if (s === 'on') break;
    if (side === null) {
      side = s;
      run = 1;
    } else if (s === side) {
      run += 1;
    } else {
      break;
    }
  }

  if (run >= MIN_SAME_SIDE_RUN) {
    const dir = side === 'above' ? 'above' : 'below';
    warnings.push({
      code: 'same_side_run',
      severity: 'warning',
      message: `Similar trend: last ${run} readings are on the same side of nominal (${dir} ${nominal}) — process may be drifting`,
    });
  }

  const oos = numericPoints.filter((p) => p.value < lsl || p.value > usl);
  if (oos.length >= MIN_OOS_COUNT) {
    warnings.push({
      code: 'threshold_exceeded',
      severity: 'warning',
      message: `Threshold exceeded: ${oos.length} readings are outside LSL (${lsl}) / USL (${usl}) — not normal variation`,
    });
  }

  return warnings;
}

/**
 * @param {object[]} params - QC parameters from part master (with lsl/usl)
 * @param {object[]} readingRows - { parameter, cells }[] aligned to params
 * @param {object} approval - approval meta with hour_slots
 */
export function analyzeQcSpcWarnings(params, readingRows, approval) {
  const all = [];
  params.forEach((param, i) => {
    const limits = resolveParamLimits(param);
    if (!limits) return;

    const row = readingRows?.find((r) => r.parameter === param.parameter) || readingRows?.[i];
    const cells = row?.cells || [];
    const numericPoints = extractChronologicalValues(cells, approval);
    const warnings = detectParameterWarnings(numericPoints, limits);
    warnings.forEach((w) => {
      all.push({ ...w, parameter: param.parameter });
    });
  });
  return all;
}
