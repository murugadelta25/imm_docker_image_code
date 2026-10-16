/** Shared polar / arc helpers for 3D-style SVG charts. */

export function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

export function describeDonutSegment(cx, cy, innerR, outerR, startAngle, endAngle) {
  if (endAngle - startAngle >= 360) endAngle = startAngle + 359.999;
  if (endAngle <= startAngle) return '';

  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    'Z',
  ].join(' ');
}

/** Lighten/darken a #RRGGBB hex color by amount (-1..1). */
export function shadeHex(hex, amount) {
  const raw = hex.replace('#', '');
  if (raw.length !== 6) return hex;
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  const r = clamp(parseInt(raw.slice(0, 2), 16) + amount * 255);
  const g = clamp(parseInt(raw.slice(2, 4), 16) + amount * 255);
  const b = clamp(parseInt(raw.slice(4, 6), 16) + amount * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
