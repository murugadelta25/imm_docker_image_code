/** Parse seconds field (process time / L&U) — supports decimals e.g. 20.5 */
export function parseCtSeconds(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function sumCt(processTime, loadingUnloading) {
  return parseCtSeconds(processTime) + parseCtSeconds(loadingUnloading);
}

/** Display CT without trailing zeros (28.5 not 28.50; 28 not 28.0) */
export function formatCtSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
}

/** Allow typing partial decimals in controlled inputs */
export function isValidDecimalInput(raw) {
  return raw === '' || /^\d*\.?\d*$/.test(raw);
}
