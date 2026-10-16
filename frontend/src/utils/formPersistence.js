/** Session-scoped form drafts — survive page refresh (same browser tab). */
const PREFIX = 'pms:draft:';

export const DRAFT_KEYS = {
  dataEntry: `${PREFIX}data-entry:form`,
  wiDashboard: `${PREFIX}wi-dashboard`,
  hourlyOutput: `${PREFIX}hourly-output:filters`,
  productionPlanning: `${PREFIX}production-planning:form`,
  breakdown: `${PREFIX}breakdown:form`,
  modelChange: `${PREFIX}model-change:form`,
  configuration: `${PREFIX}configuration:edit`,
  partManagement: `${PREFIX}part-management:form`,
};

export function draftKey(...parts) {
  return PREFIX + parts.filter((p) => p != null && p !== '').join(':');
}

export function loadDraft(key, fallback = null) {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'payload' in parsed) {
      return parsed.payload;
    }
    if (parsed && parsed._savedAt != null) {
      const { _savedAt, ...rest } = parsed;
      void _savedAt;
      return Object.keys(rest).length ? rest : fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function saveDraft(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ payload: value, _savedAt: Date.now() }));
  } catch {
    /* storage full — ignore */
  }
}

export function clearDraft(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Merge QC reading rows — local draft only fills cells the server left empty. */
export function mergeQcReadings(serverReadings, localReadings, displayParams, cellCount) {
  if (!localReadings?.length) return serverReadings || [];
  if (!serverReadings?.length) {
    return displayParams.map((p, i) => {
      const loc = localReadings.find((r) => r.parameter === p.parameter) || localReadings[i] || {};
      const cells = [...(loc.cells || [])];
      while (cells.length < cellCount) cells.push('');
      return { ...p, ...loc, cells: cells.slice(0, cellCount) };
    });
  }

  return displayParams.map((p, i) => {
    const srv = serverReadings.find((r) => r.parameter === p.parameter) || serverReadings[i] || {};
    const loc = localReadings.find((r) => r.parameter === p.parameter) || localReadings[i] || {};
    const srvCells = srv.cells || [];
    const locCells = loc.cells || [];
    const cc = cellCount || Math.max(srvCells.length, locCells.length);
    const cells = Array.from({ length: cc }, (_, c) => {
      const server = String(srvCells[c] ?? '').trim();
      const local = String(locCells[c] ?? '').trim();
      // Server value always wins — local draft only fills truly empty server cells
      return server || local || '';
    });
    return {
      ...srv,
      parameter: p.parameter,
      std_value: p.std_value ?? srv.std_value,
      method: p.method ?? srv.method,
      frequency: p.frequency ?? srv.frequency,
      extra_columns: p.extra_columns ?? srv.extra_columns,
      cells,
    };
  });
}

export function rowsToReadings(rows, cellCount) {
  return (rows || []).map((row) => {
    const cells = [...(row.cells || [])];
    while (cells.length < cellCount) cells.push('');
    return cells.slice(0, cellCount);
  });
}
