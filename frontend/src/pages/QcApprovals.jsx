import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import PageHeader from '../components/PageHeader';
import QcInspectionSheet from '../components/QcInspectionSheet';
import QcSpcChart from '../components/QcSpcChart';
import { pageClass } from '../themes/tileHelpers';
import { getWorkInstructionStyles } from '../themes/workInstructionStyles';
import { INSTANCE_STATUS_LABEL, buildHourSlots } from '../utils/qcShiftHours';
import { useConfig } from '../context/ConfigContext';

const PAGE_SIZE = 10;
/** Max hour columns per band so the table stays within a normal window. */
const MAX_HOUR_BAND_WIDTH = 6;

const STATUS_STYLE = {
  green: { bg: '#e8f5e9', color: '#2e7d32' },
  yellow: { bg: '#fff8e1', color: '#f57f17' },
  red: { bg: '#ffebee', color: '#c62828' },
  gray: { bg: '#eeeeee', color: '#757575' },
  neutral: { bg: '#f5f5f5', color: '#616161' },
};

function statusPill(status, statusColor) {
  if (!status || status === 'empty') return '—';
  const st = STATUS_STYLE[statusColor] || STATUS_STYLE.neutral;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 6px',
      borderRadius: 12,
      fontSize: 10,
      fontWeight: 600,
      lineHeight: 1.3,
      background: st.bg,
      color: st.color,
      whiteSpace: 'nowrap',
    }}
    >
      {INSTANCE_STATUS_LABEL[status] || status}
    </span>
  );
}

function slotSortKey(key) {
  if (key === 'first') return -1;
  const n = parseInt(key, 10);
  return Number.isNaN(n) ? 999 : n;
}

function statusPriority(status) {
  switch (status) {
    case 'pending_inspector':
    case 'pending_incharge':
      return 0;
    case 'rejected':
    case 'draft':
      return 1;
    case 'missed':
    case 'empty':
      return 2;
    case 'approved':
    case 'frozen':
      return 3;
    default:
      return 2;
  }
}

function isActionRequired(status) {
  return statusPriority(status) === 0;
}

function groupRowsByReport(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.report_id;
    if (!map.has(key)) {
      map.set(key, {
        report_id: row.report_id,
        station_name: row.station_name,
        machine_name: row.machine_name,
        article_no: row.article_no,
        operator_username: row.operator_username,
        shift: row.shift,
        inspection_date: row.inspection_date,
        machine_id: row.machine_id,
        byKey: {},
      });
    }
    map.get(key).byKey[row.instance_key] = row;
  }

  return [...map.values()].sort((a, b) => {
    let minA = 3;
    let minB = 3;
    let latestA = '';
    let latestB = '';
    for (const row of Object.values(a.byKey)) {
      const p = statusPriority(row.status);
      if (p < minA) minA = p;
      if (isActionRequired(row.status) && (row.submitted_at || '') > latestA) {
        latestA = row.submitted_at || '';
      }
    }
    for (const row of Object.values(b.byKey)) {
      const p = statusPriority(row.status);
      if (p < minB) minB = p;
      if (isActionRequired(row.status) && (row.submitted_at || '') > latestB) {
        latestB = row.submitted_at || '';
      }
    }
    if (minA !== minB) return minA - minB;
    if (minA === 0 && latestA !== latestB) return latestB.localeCompare(latestA);
    return String(a.article_no || '').localeCompare(String(b.article_no || ''));
  });
}

/** Prefer even split across bands; never exceed MAX_HOUR_BAND_WIDTH. */
function dynamicBandWidth(hourCount) {
  if (hourCount <= 0) return 1;
  if (hourCount <= MAX_HOUR_BAND_WIDTH) return hourCount;
  const bands = Math.ceil(hourCount / MAX_HOUR_BAND_WIDTH);
  return Math.ceil(hourCount / bands);
}

function chunkHours(hourSlots, width) {
  if (!hourSlots.length) return [[]];
  const bands = [];
  for (let i = 0; i < hourSlots.length; i += width) {
    const band = hourSlots.slice(i, i + width);
    while (band.length < width) {
      band.push({ key: `__pad_${i}_${band.length}`, label: '', pad: true });
    }
    bands.push(band);
  }
  return bands;
}

/** Labels for thead hour columns: H1&H7, H2&H8, … when hours wrap across bands. */
function buildBandColumnHeaderLabels(totalHours, bandWidth) {
  if (bandWidth <= 0) return [];
  const labels = [];
  const bandCount = Math.max(1, Math.ceil(totalHours / bandWidth));
  for (let col = 0; col < bandWidth; col += 1) {
    const parts = [];
    for (let band = 0; band < bandCount; band += 1) {
      const hourNum = col + 1 + band * bandWidth;
      if (hourNum <= totalHours) parts.push(`H${hourNum}`);
    }
    labels.push({
      key: `hdr-${col}`,
      label: parts.length > 1 ? parts.join('&') : (parts[0] || `H${col + 1}`),
    });
  }
  return labels;
}

function resolveShiftTiming(config, shiftId) {
  const shifts = config?.shifts || [];
  const sh = shifts.find((s) => s.id === shiftId)
    || shifts.find((s) => s.enabled !== false)
    || shifts[0];
  return {
    id: sh?.id || shiftId || 'A',
    start: sh?.start || '08:00',
    end: sh?.end || '20:00',
    name: sh?.name || shiftId || 'A',
  };
}

/**
 * Build 1st-piece + hour bands from site shift timings only.
 * Slot times always follow current shift config — not stale instance_label from DB.
 */
function layoutForGroup(group, config) {
  const timing = resolveShiftTiming(config, group.shift);
  const hourSlots = buildHourSlots(timing.start, timing.end).map((h) => ({
    key: String(h.key),
    label: h.label,
    start: h.start,
    end: h.end,
  }));

  const bandWidth = dynamicBandWidth(hourSlots.length);
  const hourBands = chunkHours(hourSlots, bandWidth);
  const bandCount = Math.max(1, hourBands.length);
  const rowsPerGroup = bandCount * 3;

  return {
    timing,
    hourCount: hourSlots.length,
    bandColumnHeaders: buildBandColumnHeaderLabels(hourSlots.length, bandWidth),
    firstSlot: {
      key: 'first',
      label: '1st piece',
    },
    hourBands,
    bandWidth,
    bandCount,
    rowsPerGroup,
  };
}

export default function QcApprovals() {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const { config } = useConfig();
  const s = getWorkInstructionStyles(t);
  const navigate = useNavigate();

  const isInspector = ['quality', 'supervisor', 'admin'].includes(user?.role);
  const isSupervisor = ['supervisor', 'admin'].includes(user?.role);
  const defaultTab = isSupervisor && user?.role !== 'quality' ? 'incharge' : 'inspector';
  const [tab, setTab] = useState(defaultTab);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [review, setReview] = useState(null);
  const [reviewContext, setReviewContext] = useState(null);
  const [spcRow, setSpcRow] = useState(null);
  const [spcData, setSpcData] = useState(null);
  const [spcLoading, setSpcLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const queue = tab === 'operator' ? 'operator' : tab;
      const { data } = await api.get('/api/qc-inspection/pending-approvals', {
        params: { queue, grouped: false },
      });
      setRows(data);
      setPage(1);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => groupRowsByReport(rows), [rows]);

  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageGroups = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return groups.slice(start, start + PAGE_SIZE);
  }, [groups, safePage]);

  /** Per-machine layout from that row's shift timings. */
  const groupLayouts = useMemo(
    () => pageGroups.map((g) => ({ group: g, layout: layoutForGroup(g, config) })),
    [pageGroups, config],
  );

  /** Widest hour band on this page — drives header column count. */
  const maxBandWidth = useMemo(() => {
    if (!groupLayouts.length) return MAX_HOUR_BAND_WIDTH;
    return Math.max(1, ...groupLayouts.map((x) => x.layout.bandWidth));
  }, [groupLayouts]);

  /** Hour column headers from the longest shift on this page (padded to maxBandWidth). */
  const headerHours = useMemo(() => {
    if (!groupLayouts.length) {
      const timing = resolveShiftTiming(config, 'A');
      const n = buildHourSlots(timing.start, timing.end).length;
      const w = dynamicBandWidth(n);
      return buildBandColumnHeaderLabels(n, w);
    }
    const widest = groupLayouts.reduce((best, cur) => (
      cur.layout.hourCount > best.layout.hourCount ? cur : best
    ));
    if (widest.layout.bandWidth >= maxBandWidth) {
      return widest.layout.bandColumnHeaders;
    }
    return buildBandColumnHeaderLabels(widest.layout.hourCount, maxBandWidth);
  }, [groupLayouts, maxBandWidth, config]);

  const openReview = async (row) => {
    if (!row?.report_id) return;
    try {
      const { data: report } = await api.get(`/api/qc-inspection/${row.report_id}`);
      const { data: ctx } = await api.get('/api/operator-dashboard/context', {
        params: {
          machine_id: report.machine_id,
          shift: report.shift,
          entry_date: report.inspection_date,
        },
      });
      setReviewContext(ctx);
      setReview(row);
    } catch {
      navigate(`/work-instructions?machine_id=${row.machine_id || ''}`);
    }
  };

  const openSpc = async (group) => {
    const sample = Object.values(group.byKey)[0] || group;
    setSpcRow(sample);
    setSpcLoading(true);
    setSpcData(null);
    try {
      const { data } = await api.get(`/api/qc-inspection/${group.report_id}/spc-data`);
      setSpcData(data);
    } catch {
      setSpcData(null);
    } finally {
      setSpcLoading(false);
    }
  };

  const quickApprove = async (group, action) => {
    const key = `${group.report_id}-${action}`;
    setActionBusy(key);
    try {
      if (action === 'inspector-all') {
        await api.post(`/api/qc-inspection/${group.report_id}/approve-inspector-all`);
      } else if (action === 'incharge-all') {
        await api.post(`/api/qc-inspection/${group.report_id}/approve-incharge-all`);
      }
      await load();
    } catch (e) {
      window.alert(e.response?.data?.detail || 'Approval failed');
    } finally {
      setActionBusy(null);
    }
  };

  const cellBorder = `1px solid ${t.border}`;
  // Slate base + 5% white frost; light blur only
  const frost = (slateAlpha, whiteAlpha = 0.05) => (
    `linear-gradient(rgba(255,255,255,${whiteAlpha}), rgba(255,255,255,${whiteAlpha})), rgba(15, 23, 42, ${slateAlpha})`
  );
  const tdCommon = {
    ...s.td,
    border: cellBorder,
    verticalAlign: 'middle',
    background: frost(0.72, 0.05),
    whiteSpace: 'nowrap',
    fontSize: 12,
  };
  const tdSlot = {
    ...s.td,
    border: cellBorder,
    verticalAlign: 'middle',
    background: frost(0.62, 0.05),
    textAlign: 'center',
    padding: '5px 4px',
    fontSize: 11,
  };
  const tdRowLabel = {
    ...tdSlot,
    textAlign: 'left',
    fontWeight: 700,
    fontSize: 11,
    color: t.textMuted,
    textTransform: 'lowercase',
    whiteSpace: 'nowrap',
    minWidth: 56,
    background: frost(0.78, 0.05),
  };
  const tdSlotLabel = {
    ...tdSlot,
    fontWeight: 700,
    fontSize: 10,
    background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), rgba(251, 191, 36, 0.32)',
    color: t.text,
    whiteSpace: 'nowrap',
  };
  const thStyle = {
    ...s.thYellow,
    border: cellBorder,
    textAlign: 'center',
    background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), rgba(251, 191, 36, 0.38)',
    color: t.text,
    textShadow: 'none',
    fontSize: 11,
    padding: '8px 5px',
    whiteSpace: 'nowrap',
  };
  const thCommon = { ...thStyle, textAlign: 'left' };

  const pageBtn = (active) => ({
    ...s.btnSecondary,
    padding: '6px 12px',
    fontSize: 12,
    opacity: active ? 1 : 0.45,
    cursor: active ? 'pointer' : 'default',
  });

  const colCount = 8 + maxBandWidth; // common(6) + pending + 1st piece + hour band

  const padBand = (band, width, bandIdx) => {
    const next = [...band];
    while (next.length < width) {
      next.push({ key: `__pad_${bandIdx}_${next.length}`, label: '', pad: true });
    }
    return next;
  };

  const renderSlotCell = (group, col, mode) => {
    if (!col || col.pad) {
      return <td key={`${group.report_id}-${mode}-pad-${col?.key}`} style={tdSlot}>—</td>;
    }
    const inst = group.byKey[col.key];
    if (mode === 'label') {
      return (
        <td key={`${group.report_id}-lb-${col.key}`} style={tdSlotLabel}>
          {col.label || '—'}
        </td>
      );
    }
    if (mode === 'status') {
      return (
        <td key={`${group.report_id}-st-${col.key}`} style={tdSlot}>
          {inst ? statusPill(inst.status, inst.status_color || 'yellow') : '—'}
        </td>
      );
    }
    return (
      <td key={`${group.report_id}-ac-${col.key}`} style={tdSlot}>
        {inst ? (
          <button
            type="button"
            style={{ ...s.btnSecondary, padding: '3px 8px', fontSize: 11 }}
            onClick={() => openReview(inst)}
          >
            Review
          </button>
        ) : '—'}
      </td>
    );
  };

  return (
    <div className={pageClass(t)}>
      <PageHeader
        title="QC Approvals"
        subtitle="Hour columns follow each shift’s start/end times and wrap to fit the window"
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {isInspector && (
          <button
            type="button"
            style={tab === 'inspector' ? s.btnAccent : s.btnSecondary}
            onClick={() => setTab('inspector')}
          >
            QC Pending
          </button>
        )}
        {isSupervisor && (
          <button
            type="button"
            style={tab === 'incharge' ? s.btnAccent : s.btnSecondary}
            onClick={() => setTab('incharge')}
          >
            Supervisor Pending
          </button>
        )}
        <button
          type="button"
          style={tab === 'operator' ? s.btnAccent : s.btnSecondary}
          onClick={() => setTab('operator')}
        >
          My Submissions
        </button>

        <div style={{ flex: 1 }} />

        {!loading && groups.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.textMuted }}>
            <span>
              {groups.length} part request{groups.length === 1 ? '' : 's'}
              {' · '}
              Page {safePage} of {totalPages}
            </span>
            <button
              type="button"
              style={pageBtn(safePage > 1)}
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <button
              type="button"
              style={pageBtn(safePage < totalPages)}
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          overflowX: 'auto',
          background: 'linear-gradient(rgba(255,255,255,0.05), rgba(255,255,255,0.05)), rgba(15, 23, 42, 0.55)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          border: `1px solid ${t.border}`,
          borderRadius: 8,
        }}
      >
        <table style={{
          ...s.table,
          width: '100%',
          borderCollapse: 'collapse',
          border: cellBorder,
          background: 'transparent',
          tableLayout: 'auto',
        }}
        >
          <thead>
            <tr>
              <th className="wi-qc-th" style={thCommon}>Pair</th>
              <th className="wi-qc-th" style={thCommon}>Machine</th>
              <th className="wi-qc-th" style={thCommon}>Part No</th>
              <th className="wi-qc-th" style={thCommon}>Shift</th>
              <th className="wi-qc-th" style={thCommon}>Date</th>
              <th className="wi-qc-th" style={thCommon}>Operator</th>
              <th className="wi-qc-th" style={thCommon}>Pending</th>
              <th className="wi-qc-th" style={thStyle}>1st piece</th>
              {headerHours.map((col) => (
                <th key={col.key} className="wi-qc-th" style={thStyle}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={colCount} style={tdSlot}>Loading…</td>
              </tr>
            )}
            {!loading && groupLayouts.length === 0 && (
              <tr>
                <td colSpan={colCount} style={tdSlot}>No items in this queue.</td>
              </tr>
            )}
            {!loading && groupLayouts.map(({ group, layout }, groupIdx) => {
              const { firstSlot, hourBands, rowsPerGroup, timing } = layout;
              const firstInst = group.byKey[firstSlot.key];
              const pipeColor = t.accent || '#38bdf8';

              return (
                <Fragment key={group.report_id}>
                  {/* Piping line between machines */}
                  {groupIdx > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={colCount}
                        style={{
                          padding: '10px 0 8px',
                          border: 'none',
                          background: 'transparent',
                        }}
                      >
                        <div style={{
                          height: 3,
                          borderRadius: 999,
                          background: `linear-gradient(90deg, transparent 0%, ${pipeColor} 12%, ${pipeColor} 88%, transparent 100%)`,
                          boxShadow: `0 0 8px ${pipeColor}66`,
                        }}
                        />
                      </td>
                    </tr>
                  )}

                  {hourBands.map((rawBand, bandIdx) => {
                    const isFirstBand = bandIdx === 0;
                    const band = padBand(rawBand, maxBandWidth, bandIdx);

                    return (
                      <Fragment key={`${group.report_id}-band-${bandIdx}`}>
                        {/* Always show slot labels so shift times are visible */}
                        <tr>
                          {isFirstBand && (
                            <>
                              <td
                                rowSpan={rowsPerGroup}
                                style={{
                                  ...tdCommon,
                                  borderLeft: `3px solid ${pipeColor}`,
                                }}
                              >
                                {group.station_name || '—'}
                              </td>
                              <td rowSpan={rowsPerGroup} style={tdCommon}>
                                {group.machine_name || '—'}
                                <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>
                                  {timing.name} ({timing.start}–{timing.end})
                                </div>
                              </td>
                              <td rowSpan={rowsPerGroup} style={tdCommon}>
                                {group.article_no ? (
                                  <button
                                    type="button"
                                    onClick={() => openSpc(group)}
                                    style={{
                                      background: 'none',
                                      border: 'none',
                                      padding: 0,
                                      cursor: 'pointer',
                                      color: t.accent || '#1565c0',
                                      fontWeight: 600,
                                      textDecoration: 'underline',
                                    }}
                                    title="View SPC chart"
                                  >
                                    {group.article_no}
                                  </button>
                                ) : '—'}
                                {(tab === 'inspector' || tab === 'incharge') && (
                                  <div style={{ marginTop: 6 }}>
                                    <button
                                      type="button"
                                      style={{ ...s.btnAccent, padding: '3px 8px', fontSize: 10 }}
                                      disabled={actionBusy === `${group.report_id}-${tab === 'inspector' ? 'inspector-all' : 'incharge-all'}`}
                                      onClick={() => quickApprove(
                                        group,
                                        tab === 'inspector' ? 'inspector-all' : 'incharge-all',
                                      )}
                                    >
                                      {actionBusy === `${group.report_id}-${tab === 'inspector' ? 'inspector-all' : 'incharge-all'}`
                                        ? '…'
                                        : (tab === 'inspector' ? 'Approve All' : 'Approve Shift')}
                                    </button>
                                  </div>
                                )}
                              </td>
                              <td rowSpan={rowsPerGroup} style={tdCommon}>{group.shift || '—'}</td>
                              <td rowSpan={rowsPerGroup} style={tdCommon}>{group.inspection_date || '—'}</td>
                              <td rowSpan={rowsPerGroup} style={tdCommon}>{group.operator_username || '—'}</td>
                            </>
                          )}
                          <td style={tdRowLabel}>slots</td>
                          <td style={tdSlotLabel}>
                            {isFirstBand ? (firstSlot.label || '1st piece') : '—'}
                          </td>
                          {band.map((col) => renderSlotCell(group, col, 'label'))}
                        </tr>

                        <tr>
                          <td style={tdRowLabel}>status</td>
                          <td style={tdSlot}>
                            {isFirstBand
                              ? (firstInst
                                ? statusPill(firstInst.status, firstInst.status_color || 'yellow')
                                : '—')
                              : '—'}
                          </td>
                          {band.map((col) => renderSlotCell(group, col, 'status'))}
                        </tr>

                        <tr>
                          <td style={tdRowLabel}>actions</td>
                          <td style={tdSlot}>
                            {isFirstBand && firstInst ? (
                              <button
                                type="button"
                                style={{ ...s.btnSecondary, padding: '3px 8px', fontSize: 11 }}
                                onClick={() => openReview(firstInst)}
                              >
                                Review
                              </button>
                            ) : '—'}
                          </td>
                          {band.map((col) => renderSlotCell(group, col, 'actions'))}
                        </tr>
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && groups.length > PAGE_SIZE && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 10,
          marginTop: 14,
          flexWrap: 'wrap',
        }}
        >
          <button
            type="button"
            style={pageBtn(safePage > 1)}
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === totalPages || Math.abs(n - safePage) <= 2)
            .reduce((acc, n, idx, arr) => {
              if (idx > 0 && n - arr[idx - 1] > 1) acc.push('…');
              acc.push(n);
              return acc;
            }, [])
            .map((n, idx) => (
              n === '…' ? (
                <span key={`e-${idx}`} style={{ color: t.textMuted }}>…</span>
              ) : (
                <button
                  key={n}
                  type="button"
                  style={{
                    ...s.btnSecondary,
                    padding: '6px 10px',
                    fontSize: 12,
                    fontWeight: n === safePage ? 700 : 500,
                    borderColor: n === safePage ? t.accent : t.border,
                    color: n === safePage ? t.accent : t.text,
                  }}
                  onClick={() => setPage(n)}
                >
                  {n}
                </button>
              )
            ))}
          <button
            type="button"
            style={pageBtn(safePage < totalPages)}
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      )}

      {review && reviewContext && (
        <QcInspectionSheet
          context={reviewContext}
          initialReportId={review.report_id}
          reviewingInstanceKey={review.consolidated ? null : review.instance_key}
          onClose={() => { setReview(null); setReviewContext(null); load(); }}
          onSubmitted={load}
        />
      )}

      {spcRow && !spcLoading && spcData && (
        <QcSpcChart
          reportMeta={{
            article_no: spcRow.article_no,
            shift: spcRow.shift,
            inspection_date: spcRow.inspection_date,
            machine_name: spcRow.machine_name,
          }}
          spcData={spcData}
          theme={t}
          onClose={() => { setSpcRow(null); setSpcData(null); }}
        />
      )}

      {spcRow && spcLoading && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}
        >
          <div style={{ background: t.surface, padding: 24, borderRadius: 8 }}>Loading SPC chart…</div>
        </div>
      )}
    </div>
  );
}
