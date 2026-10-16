/** Part-level QC spec column definitions (Method, Freq, custom columns). */

export const DEFAULT_QC_COLUMNS = [
  { key: 'method', label: 'Inspection Method' },
  { key: 'frequency', label: 'Inspection Frequency (Operator)' },
  { key: 'freq_inspector', label: 'Inspection Frequency (Inspector)' },
  { key: 'control_method', label: 'Control Method' },
];

export function normalizeQcColumnSchema(schema, qcParameters = []) {
  if (Array.isArray(schema) && schema.length > 0) {
    return schema.map((c) => ({ key: c.key, label: c.label || c.key }));
  }
  const cols = [...DEFAULT_QC_COLUMNS];
  const seen = new Set(cols.map((c) => c.key));
  for (const q of qcParameters || []) {
    for (const ec of q.extra_columns || []) {
      const key = ec.key || (ec.label ? `legacy_${ec.label.replace(/\s+/g, '_')}` : null);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cols.push({ key, label: ec.label || key });
    }
  }
  return cols;
}

export function getParamColumnValue(param, key) {
  if (key === 'method') return param.method ?? '';
  if (key === 'frequency') return param.frequency ?? '';
  const ec = (param.extra_columns || []).find(
    (c) => c.key === key || (!c.key && c.label && `legacy_${c.label.replace(/\s+/g, '_')}` === key),
  );
  return ec?.value ?? '';
}

export function setParamColumnValue(param, key, value) {
  if (key === 'method') return { ...param, method: value };
  if (key === 'frequency') return { ...param, frequency: value };
  const extras = [...(param.extra_columns || [])];
  const idx = extras.findIndex((c) => c.key === key);
  if (idx >= 0) {
    extras[idx] = { ...extras[idx], key, value };
  } else {
    extras.push({ key, value });
  }
  return { ...param, extra_columns: extras };
}

export function emptyParamFromSchema(schema) {
  const row = {
    method: '',
    frequency: '',
    extra_columns: [],
  };
  for (const col of schema || DEFAULT_QC_COLUMNS) {
    if (col.key === 'method' || col.key === 'frequency') continue;
    row.extra_columns.push({ key: col.key, value: '' });
  }
  return row;
}

export function serializeParamColumns(param, schema) {
  const cols = schema || DEFAULT_QC_COLUMNS;
  return {
    method: getParamColumnValue(param, 'method'),
    frequency: getParamColumnValue(param, 'frequency'),
    extra_columns: cols
      .filter((c) => c.key !== 'method' && c.key !== 'frequency')
      .map((c) => ({
        key: c.key,
        label: c.label,
        value: getParamColumnValue(param, c.key),
      }))
      .filter((c) => c.label?.trim() || c.value?.trim()),
  };
}
