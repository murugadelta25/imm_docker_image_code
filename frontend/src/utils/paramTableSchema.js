/** Dynamic parameter tables (Tools / Machine / Jigs) for Process Control Sheet. */

export const DEFAULT_TOOLS_COLUMNS = [
  { key: 'tools_detail', label: 'Tools Detail' },
  { key: 'tool_no', label: 'Tool No' },
  { key: 'approx_tool_life', label: 'Approx Tool life' },
  { key: 'rpm', label: 'RPM' },
  { key: 'feed_mm_rev', label: 'Feed mm/rev' },
  { key: 'depth_of_cut', label: 'Depth of Cut' },
  { key: 'cutting_speed', label: 'Cutting speed m/min' },
];

export const DEFAULT_MACHINE_PARAM_COLUMNS = [
  { key: 'parameter', label: 'Parameter' },
  { key: 'specifications', label: 'Specifications' },
  { key: 'inspection_method', label: 'Inspection Method' },
  { key: 'inspection_frequency', label: 'Inspection Frequency' },
];

export const DEFAULT_JIGS_COLUMNS = [
  { key: 'drawing_number', label: 'Drawing Number' },
  { key: 'description', label: 'Description' },
];

export function emptyParamTable(defaultColumns) {
  return {
    columns: (defaultColumns || []).map((c) => ({ key: c.key, label: c.label })),
    rows: [],
  };
}

export function normalizeParamTable(raw, defaultColumns) {
  const defaults = (defaultColumns || []).map((c) => ({ key: c.key, label: c.label }));
  if (!raw || typeof raw !== 'object') {
    return emptyParamTable(defaults);
  }
  let columns = Array.isArray(raw.columns) && raw.columns.length
    ? raw.columns.map((c) => ({
      key: c.key || `col_${Math.random().toString(36).slice(2, 8)}`,
      label: c.label || c.key || '',
    }))
    : defaults;
  if (!columns.length) columns = defaults;

  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((row) => {
    const out = {};
    for (const col of columns) {
      out[col.key] = row?.[col.key] ?? '';
    }
    return out;
  });

  return { columns, rows };
}

export function emptyRowFromColumns(columns) {
  const row = {};
  for (const col of columns || []) {
    row[col.key] = '';
  }
  return row;
}

export function serializeParamTable(table) {
  const columns = (table?.columns || [])
    .filter((c) => c.key)
    .map((c) => ({ key: c.key, label: (c.label || c.key).trim() }));
  const rows = (table?.rows || []).map((row) => {
    const out = {};
    for (const col of columns) {
      out[col.key] = row?.[col.key] ?? '';
    }
    return out;
  });
  return { columns, rows };
}
