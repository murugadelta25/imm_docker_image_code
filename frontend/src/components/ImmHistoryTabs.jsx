export function historySelectStyle(t) {
  return {
    padding: '7px 10px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.surface2 || t.bg,
    color: t.text,
    fontSize: 13,
    minWidth: 120,
  };
}

export function historyChipStyle(t, on = false) {
  return {
    border: `1px solid ${on ? t.accent : t.border}`,
    background: on ? t.accent : (t.surface2 || t.bg),
    color: on ? '#fff' : t.textMuted,
    borderRadius: 8,
    padding: '7px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  };
}

export function exportCsv(filename, rows) {
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** @deprecated History tabs moved into IMM KPI's Dashboard */
export default function ImmHistoryTabs() {
  return null;
}
