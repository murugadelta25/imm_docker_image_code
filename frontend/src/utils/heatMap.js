/** Percentage → heatmap color bands for overview charts. */
export function heatMapColor(pct) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  if (v < 25) return '#ef4444';
  if (v < 50) return '#0ea5e9';
  if (v < 80) return '#eab308';
  return '#10b981';
}

export function heatMapSoftBg(pct) {
  return `${heatMapColor(pct)}33`;
}

export const HEAT_MAP_LEGEND = [
  { label: '0–25%', color: '#ef4444' },
  { label: '25–50%', color: '#0ea5e9' },
  { label: '50–80%', color: '#eab308' },
  { label: '>80%', color: '#10b981' },
];

export const LINE_SERIES_COLORS = [
  '#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#fb923c',
  '#22d3ee', '#f87171', '#84cc16', '#818cf8', '#e879f9', '#2dd4bf',
];

export function seriesColor(index) {
  const i = Math.abs(Number(index) || 0);
  return LINE_SERIES_COLORS[i % LINE_SERIES_COLORS.length];
}

/** Standard Hourly Running Rate by Zone palette: green → white → saffron, then extras. */
export const HOURLY_RUNNING_RATE_EXTRA_COLORS = [
  '#38bdf8', '#a78bfa', '#f472b6', '#fbbf24', '#fb923c', '#22d3ee', '#818cf8',
];

const SAFFRON = '#FF9933';
const GREEN = '#22C55E';

export function hourlyRunningRateColor(index, isDark = true) {
  const i = Math.abs(Number(index) || 0);
  if (i === 0) return GREEN;
  if (i === 1) return isDark ? '#FFFFFF' : '#64748B';
  if (i === 2) return SAFFRON;
  return HOURLY_RUNNING_RATE_EXTRA_COLORS[(i - 3) % HOURLY_RUNNING_RATE_EXTRA_COLORS.length];
}

/** Dot/line stroke so the “white” series stays visible on light backgrounds. */
export function hourlyRunningRateLineStyle(color, isDark, bgColor) {
  const isLightSeries = color === '#FFFFFF' || color === '#64748B';
  return {
    stroke: color,
    strokeWidth: isLightSeries && !isDark ? 3 : 2.5,
    dot: {
      r: 4,
      fill: color,
      strokeWidth: isLightSeries ? 2 : 1.5,
      stroke: isLightSeries && !isDark ? '#334155' : bgColor,
    },
    activeDot: {
      r: 6,
      strokeWidth: 2,
      stroke: isLightSeries && !isDark ? '#334155' : bgColor,
      fill: color,
    },
  };
}
