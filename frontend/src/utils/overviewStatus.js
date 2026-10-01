/** Shared machine-status chips for Factory / Zone / Equipment overviews. */

export function statusPalette(isDark) {
  if (isDark) {
    return {
      running: { color: '#34d399', bg: 'rgba(16,185,129,0.28)', border: '#34d399' },
      idle: { color: '#22d3ee', bg: 'rgba(34,211,238,0.22)', border: '#22d3ee' },
      stop: { color: '#f87171', bg: 'rgba(239,68,68,0.28)', border: '#f87171' },
      breakdown: { color: '#f87171', bg: 'rgba(239,68,68,0.28)', border: '#f87171' },
      alarm: { color: '#fb923c', bg: 'rgba(249,115,22,0.28)', border: '#fb923c' },
      setting_change: { color: '#c4b5fd', bg: 'rgba(139,92,246,0.32)', border: '#a78bfa' },
      offline: { color: '#e2e8f0', bg: 'rgba(100,116,139,0.45)', border: '#94a3b8' },
    };
  }
  return {
    running: { color: '#047857', bg: '#d1fae5', border: '#059669' },
    idle: { color: '#0e7490', bg: '#cffafe', border: '#06b6d4' },
    stop: { color: '#b91c1c', bg: '#fee2e2', border: '#dc2626' },
    breakdown: { color: '#b91c1c', bg: '#fee2e2', border: '#dc2626' },
    alarm: { color: '#c2410c', bg: '#ffedd5', border: '#ea580c' },
    setting_change: { color: '#6d28d9', bg: '#ede9fe', border: '#7c3aed' },
    offline: { color: '#334155', bg: '#e2e8f0', border: '#64748b' },
  };
}

export const STATUS_ROWS = [
  ['running', 'Running'],
  ['idle', 'Idle'],
  ['stop', 'Stop'],
  ['breakdown', 'Breakdown'],
  ['alarm', 'Alarm'],
  ['setting_change', 'Setting'],
  ['offline', 'Offline'],
];
