/** IMM rejection / scrap reason codes (QC Rejection Log). */
export const REJECTION_REASONS = [
  'Short Fill',
  'Sink Mark',
  'Burn Mark',
  'Flow Mark',
  'Silver Mark',
  'Warpage',
  'Blow Holes',
  'Black Spots',
  'Colour Variation',
  'Startup Rejection',
  'Parting Lines',
  'Flash',
  'Part Damage',
  'Bubble Mark',
  'Shrinkage',
  'Patch Mark',
  'Oil Mark',
  'Gloss',
  'Other',
];

export function emptyRejectionQty() {
  return Object.fromEntries(REJECTION_REASONS.map((r) => [r, 0]));
}

export function sumRejectionQty(qtyMap) {
  return REJECTION_REASONS.reduce((s, r) => s + (parseInt(qtyMap?.[r], 10) || 0), 0);
}

export function formatRejectionNote(qtyMap) {
  const parts = REJECTION_REASONS
    .filter((r) => (parseInt(qtyMap?.[r], 10) || 0) > 0)
    .map((r) => `${r}: ${parseInt(qtyMap[r], 10)}`);
  return parts.join('; ');
}

export function parseRejectionJson(raw) {
  const base = emptyRejectionQty();
  if (!raw) return base;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return base;
    for (const r of REJECTION_REASONS) {
      const n = parseInt(obj[r], 10);
      if (Number.isFinite(n) && n >= 0) base[r] = n;
    }
  } catch { /* ignore */ }
  return base;
}
