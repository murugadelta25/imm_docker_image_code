/**
 * Loss Tracker status colors — theme-aware contrast for shift tiles, filters, and tables.
 */

const LABELS = {
  running: 'Running',
  idle: 'Idle',
  'ld/unld': 'Ld/UnLd',
  breakdown: 'Breakdown',
  setting_change: 'Setting Change',
  alarm: 'Alarm',
  offline: 'Offline',
  _unaccounted: 'Unaccounted',
  _remaining: 'Remaining',
};

function entry(color, bg, border, glow = null, colorMuted = null) {
  return {
    color,
    bg,
    border,
    glow,
    colorMuted: colorMuted ?? color,
  };
}

const PALETTES = {
  techBlue: {
    running: entry('#4ade80', 'rgba(74, 222, 128, 0.2)', 'rgba(74, 222, 128, 0.6)', 'rgba(74, 222, 128, 0.12)'),
    'ld/unld': entry('#22d3ee', 'rgba(34, 211, 238, 0.18)', 'rgba(34, 211, 238, 0.55)', 'rgba(34, 211, 238, 0.1)'),
    idle: entry('#fbbf24', 'rgba(251, 191, 36, 0.2)', 'rgba(251, 191, 36, 0.58)', 'rgba(251, 191, 36, 0.1)'),
    breakdown: entry('#fca5a5', 'rgba(248, 113, 113, 0.18)', 'rgba(248, 113, 113, 0.55)', 'rgba(248, 113, 113, 0.1)'),
    alarm: entry('#f9a8d4', 'rgba(244, 114, 182, 0.18)', 'rgba(244, 114, 182, 0.55)', 'rgba(244, 114, 182, 0.1)'),
    offline: entry('#e8f4fc', 'rgba(203, 213, 225, 0.22)', 'rgba(203, 213, 225, 0.65)', 'rgba(203, 213, 225, 0.15)', '#cbd5e1'),
    setting_change: entry('#93c5fd', 'rgba(96, 165, 250, 0.18)', 'rgba(96, 165, 250, 0.55)', 'rgba(96, 165, 250, 0.1)'),
    _unaccounted: entry('#fdba74', 'rgba(251, 146, 60, 0.2)', 'rgba(251, 146, 60, 0.55)', 'rgba(251, 146, 60, 0.1)'),
    _remaining: entry('#38bdf8', 'rgba(56, 189, 248, 0.15)', 'rgba(56, 189, 248, 0.45)', 'rgba(56, 189, 248, 0.08)'),
  },
  dark: {
    running: entry('#34d399', 'rgba(16, 185, 129, 0.18)', 'rgba(16, 185, 129, 0.5)', 'rgba(16, 185, 129, 0.1)'),
    'ld/unld': entry('#22d3ee', 'rgba(6, 182, 212, 0.18)', 'rgba(6, 182, 212, 0.5)', 'rgba(6, 182, 212, 0.1)'),
    idle: entry('#fbbf24', 'rgba(245, 158, 11, 0.2)', 'rgba(245, 158, 11, 0.55)', 'rgba(245, 158, 11, 0.1)'),
    breakdown: entry('#f87171', 'rgba(239, 68, 68, 0.18)', 'rgba(239, 68, 68, 0.5)', 'rgba(239, 68, 68, 0.1)'),
    alarm: entry('#f472b6', 'rgba(244, 114, 182, 0.18)', 'rgba(244, 114, 182, 0.5)', 'rgba(244, 114, 182, 0.1)'),
    offline: entry('#cbd5e1', 'rgba(148, 163, 184, 0.2)', 'rgba(148, 163, 184, 0.55)', 'rgba(148, 163, 184, 0.12)', '#94a3b8'),
    setting_change: entry('#60a5fa', 'rgba(59, 130, 246, 0.18)', 'rgba(59, 130, 246, 0.5)', 'rgba(59, 130, 246, 0.1)'),
    _unaccounted: entry('#fb923c', 'rgba(248, 137, 46, 0.2)', 'rgba(248, 137, 46, 0.5)', 'rgba(248, 137, 46, 0.1)'),
    _remaining: entry('#38bdf8', 'rgba(56, 189, 248, 0.15)', 'rgba(56, 189, 248, 0.45)', 'rgba(56, 189, 248, 0.08)'),
  },
  light: {
    running: entry('#059669', 'rgba(16, 185, 129, 0.12)', 'rgba(16, 185, 129, 0.45)', null, '#047857'),
    'ld/unld': entry('#0891b2', 'rgba(6, 182, 212, 0.12)', 'rgba(6, 182, 212, 0.45)', null, '#0e7490'),
    idle: entry('#d97706', 'rgba(245, 158, 11, 0.14)', 'rgba(245, 158, 11, 0.45)', null, '#b45309'),
    breakdown: entry('#dc2626', 'rgba(239, 68, 68, 0.12)', 'rgba(239, 68, 68, 0.45)', null, '#b91c1c'),
    alarm: entry('#db2777', 'rgba(244, 114, 182, 0.12)', 'rgba(244, 114, 182, 0.45)', null, '#be185d'),
    offline: entry('#475569', 'rgba(71, 85, 105, 0.12)', 'rgba(71, 85, 105, 0.4)', null, '#334155'),
    setting_change: entry('#2563eb', 'rgba(59, 130, 246, 0.12)', 'rgba(59, 130, 246, 0.45)', null, '#1d4ed8'),
    _unaccounted: entry('#ea580c', 'rgba(248, 137, 46, 0.14)', 'rgba(248, 137, 46, 0.45)', null, '#c2410c'),
    _remaining: entry('#0284c7', 'rgba(2, 132, 199, 0.1)', 'rgba(2, 132, 199, 0.35)', null, '#0369a1'),
  },
};

/** CT histogram bar gradients — brighter tops for contrast on dark / Tech Blue backgrounds. */
const HISTO_PALETTES = {
  techBlue: {
    running: { top: '#86efac', bottom: '#16a34a', selTop: '#bbf7d0', selBottom: '#22c55e', legend: '#4ade80', tableBg: 'rgba(74, 222, 128, 0.14)' },
    ldUnld: { top: '#67e8f9', bottom: '#0891b2', selTop: '#a5f3fc', selBottom: '#06b6d4', legend: '#22d3ee', tableBg: 'rgba(34, 211, 238, 0.12)' },
    idle: { top: '#fde047', bottom: '#d97706', selTop: '#fef08a', selBottom: '#f59e0b', legend: '#fbbf24', tableBg: 'rgba(251, 191, 36, 0.14)' },
    grid: 'rgba(34, 202, 231, 0.18)',
    dimOpacity: 0.88,
  },
  dark: {
    running: { top: '#6ee7b7', bottom: '#059669', selTop: '#a7f3d0', selBottom: '#10b981', legend: '#34d399', tableBg: 'rgba(16, 185, 129, 0.12)' },
    ldUnld: { top: '#67e8f9', bottom: '#0e7490', selTop: '#a5f3fc', selBottom: '#06b6d4', legend: '#22d3ee', tableBg: 'rgba(6, 182, 212, 0.12)' },
    idle: { top: '#fcd34d', bottom: '#b45309', selTop: '#fde68a', selBottom: '#f59e0b', legend: '#fbbf24', tableBg: 'rgba(245, 158, 11, 0.12)' },
    grid: 'rgba(148, 163, 184, 0.2)',
    dimOpacity: 0.85,
  },
  light: {
    running: { top: '#34d399', bottom: '#047857', selTop: '#6ee7b7', selBottom: '#059669', legend: '#059669', tableBg: 'rgba(16, 185, 129, 0.1)' },
    ldUnld: { top: '#22d3ee', bottom: '#0e7490', selTop: '#67e8f9', selBottom: '#0891b2', legend: '#0891b2', tableBg: 'rgba(6, 182, 212, 0.1)' },
    idle: { top: '#fbbf24', bottom: '#b45309', selTop: '#fcd34d', selBottom: '#d97706', legend: '#d97706', tableBg: 'rgba(245, 158, 11, 0.1)' },
    grid: 'rgba(148, 163, 184, 0.35)',
    dimOpacity: 1,
  },
};

const TILE_KEYS = [
  'running',
  'ld/unld',
  'idle',
  'breakdown',
  'alarm',
  'offline',
  'setting_change',
  '_unaccounted',
  '_remaining',
];

const FILTER_KEYS = ['idle', 'breakdown', 'alarm', 'offline', 'setting_change'];

export function getLossStatusStyles(theme) {
  const palette = PALETTES[theme?.id] || PALETTES.dark;
  const styles = {};
  TILE_KEYS.forEach((key) => {
    const p = palette[key];
    if (!p) return;
    styles[key] = { label: LABELS[key], ...p };
  });
  return styles;
}

export function getLossTileDefs(theme) {
  const styles = getLossStatusStyles(theme);
  return TILE_KEYS.map((key) => ({
    key,
    label: LABELS[key],
    ...styles[key],
  }));
}

export function getLossHistogramColors(theme) {
  return HISTO_PALETTES[theme?.id] || HISTO_PALETTES.dark;
}

export { FILTER_KEYS as LOSS_FILTER_STATUSES, LABELS as LOSS_STATUS_LABELS };
