import { useState, useEffect, useCallback, useMemo, Fragment, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useWebSocket } from '../api/useWebSocket';
import PageHeader from '../components/PageHeader';
import Donut3D, { DONUT_CANVAS } from '../components/charts/Donut3D';
import ProductionVsPossibleChart from '../components/charts/ProductionVsPossibleChart';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { downloadBlobResponse } from '../utils/downloadBlob';
import { formatCtSeconds, sumCt } from '../utils/cycleTime';
import { useConfig, getCurrentShift } from '../context/ConfigContext';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const AR_COLOR = '#4fc3f7';
const PR_COLOR = '#f8a5c8';
const QR_COLOR = '#f8bf05';
const todayStr = () => new Date().toISOString().slice(0, 10);

const STATUS_DOT_COLORS = {
  running: '#10b981',
  idle: '#f59e0b',
  breakdown: '#ef4444',
  alarm: '#f97316',
  setting_change: '#8b5cf6',
  offline: '#6b7280',
};
const PULSE_CSS = `@keyframes liveHeartbeat{0%,100%{transform:scale(1)}25%{transform:scale(1.25)}40%{transform:scale(1)}55%{transform:scale(1.15)}70%{transform:scale(1)}}`;

function isValidDate(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function weekRangeEndingToday() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  return {
    date_from: from.toISOString().slice(0, 10),
    date_to: to.toISOString().slice(0, 10),
  };
}

function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function monthDateRange(month, year) {
  const y = parseInt(year, 10) || new Date().getFullYear();
  const m = parseInt(month, 10);
  if (!m || m < 1 || m > 12) return null;
  const from = new Date(y, m - 1, 1);
  const lastDay = new Date(y, m, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const to = (y === today.getFullYear() && m === today.getMonth() + 1 && lastDay > today)
    ? today
    : lastDay;
  return {
    date_from: from.toISOString().slice(0, 10),
    date_to: to.toISOString().slice(0, 10),
  };
}

function buildRealtimeParams(viewMode, params, filters) {
  const rtParams = {};
  if ((viewMode === 'day' || viewMode === 'shift') && params.entry_date) {
    rtParams.entry_date = params.entry_date;
  } else if ((viewMode === 'week' || viewMode === 'range') && params.date_from && params.date_to) {
    rtParams.date_from = params.date_from;
    rtParams.date_to = params.date_to;
  } else if (viewMode === 'month' && filters.month) {
    const range = monthDateRange(filters.month, filters.year);
    if (range) {
      rtParams.date_from = range.date_from;
      rtParams.date_to = range.date_to;
    } else {
      rtParams.entry_date = todayStr();
    }
  } else {
    rtParams.entry_date = todayStr();
  }
  if (params.shift) rtParams.shift = params.shift;
  if (params.station_no) rtParams.station_no = params.station_no;
  if (params.machine_id) rtParams.machine_id = params.machine_id;
  return rtParams;
}

function matchesSearch(entry, term) {
  if (!term) return true;
  const needle = term.toLowerCase();
  const fields = [
    entry.current_operation,
    entry.model_variant,
    entry.machine_name,
    entry.work_order_no,
    entry.running_cavity != null ? String(entry.running_cavity) : '',
  ];
  return fields.some((field) => (field || '').toLowerCase().includes(needle));
}

export default function Dashboard() {
  const { config, ready: configReady } = useConfig();
  const currentShift = useMemo(() => getCurrentShift(config), [config]);
  const shiftOverrideRef = useRef(false);

  const [filters, setFilters] = useState(() => {
    const wr = weekRangeEndingToday();
    return {
      shift: '', entry_date: todayStr(), month: '', year: new Date().getFullYear(),
      station_no: '', machine_id: '', search: '',
      date_from: wr.date_from, date_to: wr.date_to,
    };
  });
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState(null);
  const [stations, setStations] = useState([]);
  const [machines, setMachines] = useState([]);
  const [viewMode, setViewMode] = useState('day');
  const [defectEdit, setDefectEdit] = useState({ id: null, value: '', note: '' });
  const [defectSaving, setDefectSaving] = useState(false);
  const [defectLog, setDefectLog] = useState({ id: null, records: [] });
  const [cavityEdit, setCavityEdit] = useState({ id: null, value: '' });
  const [cavitySaving, setCavitySaving] = useState(false);
  const [kpiDialog, setKpiDialog] = useState({ open: false, loading: false, data: null });
  const navigate = useNavigate();

  // After site config loads, default to today + current shift + all stations/machines.
  // Avoid applying DEFAULT_CONFIG (wrong shift windows) before API config arrives.
  useEffect(() => {
    if (!configReady || shiftOverrideRef.current) return;
    setViewMode('day');
    setFilters(f => ({
      ...f,
      shift: currentShift?.id || '',
      entry_date: todayStr(),
      station_no: '',
      machine_id: '',
    }));
  }, [configReady, currentShift?.id]);

  const setShiftFilter = (shift) => {
    shiftOverrideRef.current = true;
    setFilters(p => ({ ...p, shift }));
  };
  const getStationLabel = (stationId) => {
    const station = stations.find(s => s.id === stationId);
    return station ? (station.display_name || station.name || `Station ${station.id}`) : stationId;
  };

  const getMachineLabel = (machineId) => {
    if (!machineId) return '—';
    const machine = machines.find(m => m.id === machineId);
    return machine ? machine.name : `Machine ${machineId}`;
  };

  const openMachineKpi = async (machineId, entryDate, shift) => {
    if (!machineId || !entryDate || !shift) return;
    setKpiDialog({ open: true, loading: true, data: null });
    try {
      const r = await api.get('/api/machine-kpi/compute', {
        params: { machine_id: machineId, entry_date: entryDate, shift },
      });
      setKpiDialog({ open: true, loading: false, data: r.data });
    } catch (err) {
      setKpiDialog({ open: true, loading: false, data: null, error: err.message });
    }
  };

  const buildParams = useCallback(() => {
    const p = {};
    if (filters.shift) p.shift = filters.shift;
    if ((viewMode === 'day' || viewMode === 'shift') && filters.entry_date) p.entry_date = filters.entry_date;
    if ((viewMode === 'week' || viewMode === 'range') && filters.date_from) p.date_from = filters.date_from;
    if ((viewMode === 'week' || viewMode === 'range') && filters.date_to) p.date_to = filters.date_to;
    if (viewMode === 'month' && filters.month) p.month = filters.month;
    if (filters.year) p.year = filters.year;
    if (filters.station_no) p.station_no = parseInt(filters.station_no, 10);
    if (filters.machine_id) p.machine_id = parseInt(filters.machine_id, 10);
    if (filters.search?.trim()) p.search = filters.search.trim();
    return p;
  }, [filters, viewMode]);

  const fetchData = useCallback(async () => {
    if ((viewMode === 'day' || viewMode === 'shift') && !isValidDate(filters.entry_date)) return;
    if ((viewMode === 'week' || viewMode === 'range') && (!isValidDate(filters.date_from) || !isValidDate(filters.date_to))) return;
    try {
      const params = buildParams();
      const rtParams = buildRealtimeParams(viewMode, params, filters);
      const searchTerm = params.search || '';
      // Longer timeout + allSettled so one slow endpoint does not blank the whole dashboard
      const slow = { timeout: 60000 };
      const settled = await Promise.allSettled([
        api.get('/api/oee/', { params, ...slow }),
        api.get('/api/oee/summary', { params, ...slow }),
        api.get('/api/stations/', slow),
        api.get('/api/machines/', slow),
        api.get('/api/oee/realtime', { params: rtParams, ...slow }),
      ]);
      const val = (i, fallback) =>
        (settled[i].status === 'fulfilled' ? settled[i].value?.data : fallback);
      settled.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn(`Dashboard fetch partial fail [${i}]:`, r.reason?.message || r.reason);
        }
      });

      const manualEntries = Array.isArray(val(0, [])) ? val(0, []) : [];
      const realtimeEntries = (Array.isArray(val(4, [])) ? val(4, []) : [])
        .filter((row) => matchesSearch(row, searchTerm));

      const manualKeys = new Set(
        manualEntries.map(x => `${x.machine_id}_${x.shift}_${x.entry_date}`)
      );
      const uniqueRt = realtimeEntries.filter(
        r => !manualKeys.has(`${r.machine_id}_${r.shift}_${r.entry_date}`)
      );

      setEntries([...manualEntries, ...uniqueRt]);
      setSummary(val(1, null));
      setStations(Array.isArray(val(2, [])) ? val(2, []) : []);
      setMachines(Array.isArray(val(3, [])) ? val(3, []) : []);
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    }
  }, [buildParams, viewMode, filters.entry_date, filters.date_from, filters.date_to, filters.month, filters.year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useWebSocket(useCallback(msg => {
    if (msg.type === 'oee_updated') fetchData();
  }, [fetchData]));

  const saveRunningCavity = async (entry) => {
    const cav = parseInt(cavityEdit.value, 10);
    if (!cav || cav < 1) {
      alert('Running cavity must be at least 1');
      return;
    }
    if (!entry.machine_id || !entry.entry_date || !entry.shift) {
      alert('Cannot update running cavity without machine / date / shift');
      return;
    }
    setCavitySaving(true);
    try {
      const r = await api.patch('/api/oee/running-cavity', {
        machine_id: entry.machine_id,
        entry_date: entry.entry_date,
        shift: entry.shift,
        running_cavity: cav,
        plan_id: entry.plan_id || undefined,
      });
      setEntries((prev) => prev.map((e) => {
        if (e.id !== entry.id) return e;
        const next = {
          ...e,
          running_cavity: r.data.running_cavity ?? cav,
          plan_id: r.data.plan_id ?? e.plan_id,
        };
        if (r.data.shot_count != null) next.shot_count = r.data.shot_count;
        if (r.data.actual_qty != null) next.actual_qty = r.data.actual_qty;
        if (r.data.possible_qty != null) next.possible_qty = r.data.possible_qty;
        if (r.data.production_loss != null) next.production_loss = r.data.production_loss;
        if (r.data.accp_qty != null) next.accp_qty = r.data.accp_qty;
        if (r.data.ar != null) next.ar = r.data.ar;
        if (r.data.pr != null) next.pr = r.data.pr;
        if (r.data.qr != null) next.qr = r.data.qr;
        if (r.data.oee != null) next.oee = r.data.oee;
        return next;
      }));
      setCavityEdit({ id: null, value: '' });
      fetchData();
    } catch (err) {
      alert(err.response?.data?.detail || err.message || 'Failed to update running cavity');
    } finally {
      setCavitySaving(false);
    }
  };

  const saveDefect = async (entry) => {
    if (defectEdit.value === '' || defectEdit.value < 0) return;
    setDefectSaving(true);
    try {
      const payload = {
        defect_qty: parseInt(defectEdit.value, 10),
        note: defectEdit.note,
      };
      const r = entry.source === 'realtime'
        ? await api.patch('/api/oee/defect/by-machine', {
            machine_id: entry.machine_id,
            entry_date: entry.entry_date,
            shift: entry.shift,
            ...payload,
          })
        : await api.patch(`/api/oee/${entry.id}/defect`, payload);
      setEntries(prev => prev.map(e => e.id === entry.id
        ? { ...e, id: r.data.id ?? e.id, source: 'manual',
             defect_qty: r.data.defect_qty, accp_qty: r.data.accp_qty,
             qr: r.data.qr, oee: r.data.oee }
        : e
      ));
      setDefectEdit({ id: null, value: '', note: '' });
      fetchData();
    } catch (err) {
      alert(err.response?.data?.detail || err.message || 'Failed to update defect qty');
    } finally { setDefectSaving(false); }
  };

  const loadDefectLog = async (entry) => {
    if (defectLog.id === entry.id) { setDefectLog({ id: null, records: [] }); return; }
    const r = entry.source === 'realtime'
      ? await api.get('/api/oee/defect-log/by-machine', {
          params: {
            machine_id: entry.machine_id,
            entry_date: entry.entry_date,
            shift: entry.shift,
          },
        })
      : await api.get(`/api/oee/${entry.id}/defect-log`);
    setDefectLog({ id: entry.id, records: r.data });
  };

  const fmtIST = (istStr) => {
    if (!istStr) return '—';
    return istStr.replace('T', ' ').slice(0, 19) + ' IST';
  };

  const downloadExcel = async () => {
    if (!entries.length) return;
    const params = buildParams();
    const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const token = localStorage.getItem('token');
    try {
      const response = await fetch(`/api/oee/download-xlsx?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await downloadBlobResponse(
        response,
        `oee_report_${filters.entry_date || filters.month || 'all'}.xlsx`
      );
    } catch (err) {
      alert(`Excel download failed: ${err.message}`);
    }
  };

  const mergedSummary = useMemo(() => {
    if (!entries.length) return summary;
    const allEntries = entries;
    const n = allEntries.length;
    if (n === 0) return summary;
    const avgAr = allEntries.reduce((s, e) => s + safeNum(e.ar), 0) / n;
    const avgPr = allEntries.reduce((s, e) => s + safeNum(e.pr), 0) / n;
    const avgQr = allEntries.reduce((s, e) => s + safeNum(e.qr), 0) / n;
    const avgOee = allEntries.reduce((s, e) => s + safeNum(e.oee), 0) / n;
    return {
      avg_ar: parseFloat(avgAr.toFixed(2)),
      avg_pr: parseFloat(avgPr.toFixed(2)),
      avg_qr: parseFloat(avgQr.toFixed(2)),
      avg_oee: parseFloat(avgOee.toFixed(2)),
      total_actual: allEntries.reduce((s, e) => s + safeNum(e.actual_qty), 0),
      total_accp: allEntries.reduce((s, e) => s + safeNum(e.accp_qty), 0),
      total_defect: allEntries.reduce((s, e) => s + safeNum(e.defect_qty), 0),
    };
  }, [entries, summary]);

  const chartData = entries.map(e => ({
    label: `${e.entry_date} ${e.shift}`,
    AR: safeNum(e.ar),
    PR: safeNum(e.pr),
    QR: safeNum(e.qr),
    OEE: safeNum(e.oee),
  }));

  const barData = entries.map(e => ({
    label: `${e.entry_date} ${e.shift}`,
    Possible: safeNum(e.possible_qty),
    Actual: safeNum(e.actual_qty),
    Accepted: safeNum(e.accp_qty),
  }));

  // derive runtime styles from theme
  const { theme: t } = useTheme();
  const s = getStyles(t);

  return (
    <div className={pageClass(t)} style={s.page}>
      <style>{PULSE_CSS}</style>
      <PageHeader title="PRODUCTION OEE DASHBOARD" onRefresh={fetchData} extra={(
        <button type="button" onClick={() => navigate('/dashboard')}
          style={{ background: 'transparent', border: `1px solid ${t.border}`, color: t.accent,
                   borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
          ← IMM Monitor
        </button>
      )} />

      {/* Filters */}
      <div style={s.filterBar}>
        <div style={s.viewBtns}>
          {['week','day','range','shift','month'].map(v => (
            <button key={v} style={{ ...s.viewBtn, ...(viewMode === v ? s.viewBtnActive : {}) }}
              onClick={() => {
                if (v === 'week') {
                  const wr = weekRangeEndingToday();
                  setFilters(p => ({ ...p, date_from: wr.date_from, date_to: wr.date_to }));
                }
                setViewMode(v);
              }}>
              {v === 'range' ? '📅 Date Range' : v === 'week' ? '📅 Week' : v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>

        {(viewMode === 'day' || viewMode === 'week' || viewMode === 'range') && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ ...s.viewBtn, fontSize: 12 }}
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - 1);
                setFilters(p => ({ ...p, entry_date: d.toISOString().slice(0, 10) }));
                setViewMode('day');
              }}>
              ← Yesterday
            </button>
            <button style={{ ...s.viewBtn, fontSize: 12 }}
              onClick={() => {
                const wr = weekRangeEndingToday();
                setFilters(p => ({ ...p, date_from: wr.date_from, date_to: wr.date_to }));
                setViewMode('week');
              }}>
              This Week
            </button>
          </div>
        )}

        {viewMode === 'day' && (
          <>
            <input style={s.input} type="date" value={filters.entry_date}
              onChange={e => setFilters(p => ({ ...p, entry_date: e.target.value }))} />
            <select style={s.input} value={filters.shift} onChange={e => setShiftFilter(e.target.value)}>
              <option value="">All Shifts</option>
              {config.shifts.filter(sh => sh.enabled).map(sh => (
                <option key={sh.id} value={sh.id}>{sh.name}</option>
              ))}
            </select>
          </>
        )}
        {(viewMode === 'week' || viewMode === 'range') && (
          <>
            <input style={s.input} type="date" value={filters.date_from}
              onChange={e => setFilters(p => ({ ...p, date_from: e.target.value }))} />
            <span style={{ color: t.textDim, fontSize: 13 }}>to</span>
            <input style={s.input} type="date" value={filters.date_to}
              onChange={e => setFilters(p => ({ ...p, date_to: e.target.value }))} />
            <select style={s.input} value={filters.shift} onChange={e => setShiftFilter(e.target.value)}>
              <option value="">All Shifts</option>
              {config.shifts.filter(sh => sh.enabled).map(sh => (
                <option key={sh.id} value={sh.id}>{sh.name}</option>
              ))}
            </select>
          </>
        )}
        {viewMode === 'shift' && (
          <>
            <input style={s.input} type="date" value={filters.entry_date}
              onChange={e => setFilters(p => ({ ...p, entry_date: e.target.value }))} />
            <select style={s.input} value={filters.shift} onChange={e => setShiftFilter(e.target.value)}>
              <option value="">All Shifts</option>
              {config.shifts.filter(sh => sh.enabled).map(sh => (
                <option key={sh.id} value={sh.id}>{sh.name}</option>
              ))}
            </select>
          </>
        )}
        {viewMode === 'month' && (
          <select style={s.input} value={filters.month} onChange={e => setFilters(p => ({ ...p, month: e.target.value }))}>
            <option value="">All Months</option>
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        )}
        <select style={s.input} value={filters.year} onChange={e => setFilters(p => ({ ...p, year: e.target.value }))}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select style={s.input} value={filters.station_no} onChange={e => setFilters(p => ({ ...p, station_no: e.target.value }))}>
          <option value="">All Stations</option>
          {stations.map(station => (
            <option key={station.id} value={station.id}>{station.display_name || station.name || `Station ${station.id}`}</option>
          ))}
        </select>
        <select style={s.input} value={filters.machine_id} onChange={e => setFilters(p => ({ ...p, machine_id: e.target.value }))}>
          <option value="">All Machines</option>
          {machines.map(machine => (
            <option key={machine.id} value={machine.id}>{machine.name}</option>
          ))}
        </select>
        <input style={s.input} placeholder="Model / Work Order / Machine" value={filters.search}
          onChange={e => setFilters(p => ({ ...p, search: e.target.value }))} />
        <button style={s.dlBtn} onClick={downloadExcel}>⬇ Download Excel</button>
      </div>

      {/* KPI Cards */}
      {mergedSummary && (
        <div style={s.kpiRow}>
          {[
            { label: 'Availability (AR)', value: `${Math.round(safeNum(mergedSummary.avg_ar))}%`, color: '#0ea5e9' },
            { label: 'Performance (PR)', value: `${Math.round(safeNum(mergedSummary.avg_pr))}%`, color: '#8b5cf6' },
            { label: 'Quality (QR)', value: `${Math.round(safeNum(mergedSummary.avg_qr))}%`, color: '#10b981' },
            { label: 'OEE', value: `${Math.round(safeNum(mergedSummary.avg_oee))}%`,
              color: safeNum(mergedSummary.avg_oee) >= 85 ? '#10b981' : safeNum(mergedSummary.avg_oee) >= 65 ? '#f59e0b' : '#ef4444' },
            { label: 'Total Produced', value: mergedSummary.total_actual ?? 0, color: '#64748b' },
            { label: 'Accepted Qty', value: mergedSummary.total_accp ?? 0, color: '#10b981' },
            { label: 'Defects', value: mergedSummary.total_defect ?? 0, color: '#ef4444' },
          ].map(k => (
            <div key={k.label} style={{ ...s.kpi, borderTop: `3px solid ${k.color}` }}>
              <div style={{ color: k.color, fontSize: 24, fontWeight: 700 }}>{k.value}</div>
              <div style={{ color: t.textMuted, fontSize: 12, marginTop: 4 }}>{k.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Charts */}
      <div style={s.charts}>
        <div style={s.chartBox}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <h4 style={{ ...s.chartTitle, margin: 0 }}>OEE Overview</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {[['Running','running'],['Idle','idle'],['Breakdown','breakdown'],['Alarm','alarm'],['Setting','setting_change'],['Offline','offline']].map(([label, key]) => (
                <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: t.textMuted }}>
                  <span style={{ color: STATUS_DOT_COLORS[key], fontSize: 14, animation: 'liveHeartbeat 1.2s ease-in-out infinite', filter: `drop-shadow(0 0 4px ${STATUS_DOT_COLORS[key]})`, lineHeight: 1 }}>&#x2764;</span>
                  {label}
                </span>
              ))}
            </div>
          </div>
          {!mergedSummary || chartData.length === 0
            ? <div style={s.noData}>No data for selected filters</div>
            : (
              <div style={s.donutRow}>
                {[
                  { key: 'avg_ar',  label: 'AR',  color: AR_COLOR },
                  { key: 'avg_pr',  label: 'PR',  color: PR_COLOR },
                  { key: 'avg_qr',  label: 'QR',  color: QR_COLOR },
                  { key: 'avg_oee', label: 'OEE', color: safeNum(mergedSummary.avg_oee) >= 85 ? '#10b981' : safeNum(mergedSummary.avg_oee) >= 65 ? '#f59e0b' : '#ef4444' },
                ].map(({ key, label, color }) => {
                  const val = safeNum(mergedSummary[key]);
                  return (
                    <div key={label} style={s.donutWrap}>
                      <Donut3D key={`${label}-${val}`} value={val} color={color} trackColor={t.surface2} />
                      <div style={s.donutCenter}>
                        <span style={{ color, fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{Math.round(val)}%</span>
                        <span style={{ color: t.textDim, fontSize: 14, fontWeight: 600, marginTop: 2 }}>{label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
        </div>
        <div style={s.chartBox}>
          <h4 style={s.chartTitle}>Production vs Possible</h4>
          {barData.length === 0
            ? <div style={s.noData}>No data for selected filters</div>
            : (
              <ProductionVsPossibleChart data={barData} theme={t} />
            )}
        </div>
      </div>

      {/* Data Table */}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>{['Date','Station','Machine','Shift','Work Order','Model / Variant','Running Cavity','Shot Counts','CT','Avail(min)','Op Time','Plan Qty','Possible','Actual','Prod Loss','Accp','Defect','AR%','PR%','QR%','OEE%','QC Edit'].map(h =>
              <th key={h} style={s.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr><td colSpan={22} style={{ ...s.td, textAlign: 'center', color: t.textFaint, padding: 24 }}>
                No entries found
              </td></tr>
            ) : entries.map(e => {
              const prodLoss = Math.max(0, safeNum(e.possible_qty) - safeNum(e.actual_qty));
              const oee = safeNum(e.oee);
              const isRealtime = e.source === 'realtime';
              const isEditing = defectEdit.id === e.id;
              const isCavityEditing = cavityEdit.id === e.id;
              const showLog = defectLog.id === e.id;
              const runCav = e.running_cavity != null && e.running_cavity !== '' ? Number(e.running_cavity) : null;
              const shotCounts = e.shot_count != null
                ? Number(e.shot_count)
                : (runCav > 0 ? Math.floor(safeNum(e.actual_qty) / runCav) : safeNum(e.actual_qty));
              return (
                <Fragment key={e.id}>
                  <tr style={s.tr}>
                    <td style={s.td}>
                      {e.entry_date}
                      {isRealtime && (() => {
                        const mach = machines.find(x => x.id === e.machine_id);
                        const hColor = STATUS_DOT_COLORS[mach?.status] || '#10b981';
                        return (
                          <span style={{ marginLeft: 5, color: hColor, fontSize: 18, display: 'inline-block', animation: 'liveHeartbeat 1.2s ease-in-out infinite', filter: `drop-shadow(0 0 6px ${hColor})`, verticalAlign: 'middle' }} title={`Machine: ${mach?.status || 'unknown'}`}>&#x2764;</span>
                        );
                      })()}
                    </td>
                    <td style={s.td}>{e.station_name || getStationLabel(e.station_no)}</td>
                    <td style={s.td}>
                      <span style={{ color: t.accent, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                        title="View Machine KPI"
                        onClick={() => openMachineKpi(e.machine_id, e.entry_date, e.shift)}>
                        {e.machine_name || getMachineLabel(e.machine_id)}
                      </span>
                    </td>
                    <td style={s.td}>{e.shift}</td>
                    <td style={s.td}>
                      {e.work_order_no ? (
                        <span style={{ color: '#60a5fa', cursor: 'pointer', textDecoration: 'underline' }}
                          onClick={() => navigate('/work-orders')}
                          title="Open Work Orders">
                          {e.work_order_no}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={s.td}>
                      {e.model_variant ? (
                        <span style={{ color: '#38bdf8', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                          onClick={() => navigate('/work-instructions')}
                          title="Open Process Control Sheet">
                          {e.model_variant}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{
                      ...s.td,
                      background: 'rgba(245, 158, 11, 0.12)',
                      boxShadow: 'inset 0 0 0 1px rgba(245, 158, 11, 0.45)',
                      minWidth: 88,
                    }}>
                      {isCavityEditing ? (
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            type="number"
                            min="1"
                            style={{ ...s.input, width: 56, padding: '3px 6px', fontSize: 12, background: '#fffbeb', border: '1px solid #f59e0b' }}
                            value={cavityEdit.value}
                            autoFocus
                            onChange={(ev) => setCavityEdit((p) => ({ ...p, value: ev.target.value }))}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter') saveRunningCavity(e);
                              if (ev.key === 'Escape') setCavityEdit({ id: null, value: '' });
                            }}
                          />
                          <button
                            disabled={cavitySaving}
                            onClick={() => saveRunningCavity(e)}
                            style={{ padding: '3px 8px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                          >✓</button>
                          <button
                            onClick={() => setCavityEdit({ id: null, value: '' })}
                            style={{ padding: '3px 6px', background: t.surface2, color: t.textMuted, border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
                          >✕</button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          title="Edit running cavity (Actual = Shot Counts × Running Cavity)"
                          onClick={() => setCavityEdit({ id: e.id, value: String(runCav || 1) })}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#b45309',
                            fontWeight: 700,
                            cursor: 'pointer',
                            padding: 0,
                            textDecoration: 'underline',
                            textDecorationStyle: 'dotted',
                          }}
                        >
                          {runCav != null && !Number.isNaN(runCav) ? runCav : '—'}
                        </button>
                      )}
                    </td>
                    <td style={s.td} title="Injection cycles — Actual = Shot Counts × Running Cavity">
                      {Number.isFinite(shotCounts) ? shotCounts : '—'}
                    </td>
                    <td style={s.td}>{formatCtSeconds(sumCt(e.process_time, e.loading_unloading))}</td>
                    <td style={s.td}>{e.available_shift_time}</td>
                    <td style={s.td}>{e.operating_time}</td>
                    <td style={s.td}>{e.planned_qty != null ? e.planned_qty : '—'}</td>
                    <td style={s.td}>{e.possible_qty}</td>
                    <td style={s.td}>{e.actual_qty}</td>
                    <td style={{ ...s.td, color: prodLoss > 0 ? '#f59e0b' : '#10b981' }}>{prodLoss}</td>
                    <td style={s.td}>{e.accp_qty}</td>
                    {/* Defect — editable inline (manual + live/realtime rows) */}
                    <td style={{ ...s.td, color: safeNum(e.defect_qty) > 0 ? '#ef4444' : '#10b981' }}>
                      {isEditing ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 180 }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input type="number" min="0" max={e.actual_qty}
                              style={{ ...s.input, width: 70, padding: '3px 6px', fontSize: 12 }}
                              value={defectEdit.value}
                              autoFocus
                              onChange={ev => setDefectEdit(p => ({ ...p, value: ev.target.value }))}
                              onKeyDown={ev => { if (ev.key === 'Enter') saveDefect(e); if (ev.key === 'Escape') setDefectEdit({ id: null, value: '', note: '' }); }}
                            />
                            <button disabled={defectSaving} onClick={() => saveDefect(e)}
                              style={{ padding: '3px 8px', background: '#10b981', color: '#fff',
                                       border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>✓</button>
                            <button onClick={() => setDefectEdit({ id: null, value: '', note: '' })}
                              style={{ padding: '3px 6px', background: t.surface2, color: t.textMuted,
                                       border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>✕</button>
                          </div>
                          <input placeholder="QC note (optional)"
                            style={{ ...s.input, fontSize: 11, padding: '3px 6px' }}
                            value={defectEdit.note}
                            onChange={ev => setDefectEdit(p => ({ ...p, note: ev.target.value }))}
                          />
                        </div>
                      ) : (
                        <span>{e.defect_qty}</span>
                      )}
                    </td>
                    <td style={s.td}>{Math.round(safeNum(e.ar))}%</td>
                    <td style={s.td}>{Math.round(safeNum(e.pr))}%</td>
                    <td style={s.td}>{Math.round(safeNum(e.qr))}%</td>
                    <td style={{ ...s.td, fontWeight: 700, color: oee >= 85 ? '#10b981' : oee >= 65 ? '#f59e0b' : '#ef4444' }}>
                      {Math.round(oee)}%
                    </td>
                    {/* QC Edit — manual and live/realtime rows */}
                    <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {!isEditing && (
                          <button onClick={() => setDefectEdit({ id: e.id, value: String(e.defect_qty || 0), note: '' })}
                            style={{ padding: '3px 8px', background: '#f59e0b', color: '#fff', border: 'none',
                                     borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                            title="Update defect qty after QC">✏ QC</button>
                        )}
                        <button onClick={() => loadDefectLog(e)}
                          style={{ padding: '3px 8px', background: showLog ? t.accent : t.surface2,
                                   color: showLog ? '#fff' : t.textMuted, border: 'none',
                                   borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
                          title="View QC history">{showLog ? '▲ Hide' : '📋 Log'}</button>
                        {isRealtime && (
                          <span style={{ color: t.textFaint, fontSize: 10 }} title="Live data — QC save persists to OEE">Live</span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* QC history expansion row */}
                  {showLog && (
                    <tr key={`log-${e.id}`}>
                      <td colSpan={22} style={{ padding: '0 8px 12px 8px', background: t.surface2 }}>
                        <div style={{ padding: '10px 12px', borderRadius: 8, background: t.surface,
                                      border: `1px solid ${t.border}`, marginTop: 4 }}>
                          <div style={{ color: t.accent, fontWeight: 600, fontSize: 12, marginBottom: 8 }}>
                            QC Defect Update History — {e.current_operation} | {e.entry_date} Shift {e.shift}
                          </div>
                          {defectLog.records.length === 0 ? (
                            <div style={{ color: t.textFaint, fontSize: 12 }}>No QC updates recorded yet.</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                              <thead>
                                <tr>
                                  {['Updated At (IST)','Updated By','Before Defect','Before Accp','Before QR%','Before OEE%',
                                    'After Defect','After Accp','After QR%','After OEE%','Note'].map(h => (
                                    <th key={h} style={{ padding: '5px 8px', background: t.surface2, color: t.textDim,
                                                         textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {defectLog.records.map((l, li) => (
                                  <tr key={l.id}>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.text }}>{fmtIST(l.updated_at)}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.text }}>{l.updated_by}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: '#ef4444' }}>{l.before_defect_qty}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.text }}>{l.before_accp_qty}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{Math.round(l.before_qr)}%</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: l.before_oee >= 85 ? '#10b981' : l.before_oee >= 65 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>{Math.round(l.before_oee)}%</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: '#10b981' }}>{l.after_defect_qty}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.text }}>{l.after_accp_qty}</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{Math.round(l.after_qr)}%</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: l.after_oee >= 85 ? '#10b981' : l.after_oee >= 65 ? '#f59e0b' : '#ef4444', fontWeight: 700 }}>{Math.round(l.after_oee)}%</td>
                                    <td style={{ padding: '5px 8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{l.note || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Machine KPI Dialog */}
      {kpiDialog.open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.55)' }}
          onClick={() => setKpiDialog({ open: false, loading: false, data: null })}>
          <div style={{ background: t.surface, borderRadius: 14, width: 620, maxHeight: '85vh', overflowY: 'auto', padding: 0, boxShadow: '0 8px 32px rgba(0,0,0,.35)', color: t.text }}
            onClick={ev => ev.stopPropagation()}>
            {kpiDialog.loading ? (
              <div style={{ padding: 60, textAlign: 'center', color: t.textMuted }}>Loading KPI data...</div>
            ) : kpiDialog.error ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#ef4444' }}>Error: {kpiDialog.error}</div>
            ) : kpiDialog.data ? (() => {
              const d = kpiDialog.data;
              const k = d.kpi;
              const statusColor = STATUS_DOT_COLORS[d.machine_status] || '#6b7280';
              return (
                <>
                  {/* Header with machine info */}
                  <div style={{ display: 'flex', gap: 16, padding: '20px 24px', borderBottom: `1px solid ${t.border}`, alignItems: 'center' }}>
                    {d.image_url ? (
                      <img src={d.image_url} alt={d.machine_name}
                        style={{ width: 80, height: 80, borderRadius: 10, objectFit: 'cover', border: `2px solid ${statusColor}` }} />
                    ) : (
                      <div style={{ width: 80, height: 80, borderRadius: 10, background: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, border: `2px solid ${statusColor}` }}>
                        &#x2699;
                      </div>
                    )}
                    <div style={{ flex: 1 }}>
                      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{d.machine_name}</h2>
                      <div style={{ fontSize: 13, color: t.textMuted, marginTop: 2 }}>{d.station_name} &middot; {d.machine_type} &middot; {d.make || ''} {d.model_no || ''}</div>
                      <div style={{ fontSize: 13, color: t.textMuted }}>{d.location}</div>
                      {d.operator_name ? (
                        <div style={{ fontSize: 13, color: t.accent, fontWeight: 600, marginTop: 4 }}>
                          Operator: {d.operator_name}
                          {d.operator_code && d.operator_code !== d.operator_name
                            ? ` (${d.operator_code})`
                            : ''}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: t.textFaint, marginTop: 4, fontStyle: 'italic' }}>No operator assigned</div>
                      )}
                      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: statusColor, display: 'inline-block', boxShadow: `0 0 6px ${statusColor}` }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: statusColor, textTransform: 'uppercase' }}>{d.machine_status}</span>
                        {d.is_live && <span style={{ color: statusColor, fontSize: 16, animation: 'liveHeartbeat 1.2s ease-in-out infinite', filter: `drop-shadow(0 0 6px ${statusColor})` }}>&#x2764;</span>}
                      </div>
                    </div>
                    <button onClick={() => setKpiDialog({ open: false, loading: false, data: null })}
                      style={{ background: 'none', border: 'none', color: t.textMuted, fontSize: 22, cursor: 'pointer', padding: 4 }}>&times;</button>
                  </div>

                  {/* Context */}
                  <div style={{ padding: '12px 24px', fontSize: 12, color: t.textMuted, display: 'flex', gap: 16, flexWrap: 'wrap', borderBottom: `1px solid ${t.border}` }}>
                    <span>Date: <b>{d.entry_date}</b></span>
                    <span>Shift: <b>{d.shift_name} ({d.shift_start} – {d.shift_end})</b></span>
                    <span>Part: <b>{d.model_variant || '—'}</b></span>
                    <span>CT: <b>{d.cycle_time_sec}s</b></span>
                  </div>

                  {/* OEE Gauge */}
                  <div style={{ padding: '16px 24px', textAlign: 'center', borderBottom: `1px solid ${t.border}` }}>
                    <div style={{ fontSize: 12, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Overall Equipment Effectiveness</div>
                    <div style={{ fontSize: 48, fontWeight: 800, color: k.oee >= 85 ? '#10b981' : k.oee >= 60 ? '#f59e0b' : '#ef4444' }}>
                      {Math.round(k.oee)}%
                    </div>
                    <div style={{ fontSize: 11, color: t.textMuted }}>AR × PR × QR</div>
                  </div>

                  {/* KPI Grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: t.border }}>
                    {[
                      { label: 'Availability Rate', value: k.ar, color: AR_COLOR, icon: '\u23F1' },
                      { label: 'Performance Rate', value: k.pr, color: PR_COLOR, icon: '\u26A1' },
                      { label: 'Quality Rate', value: k.qr, color: QR_COLOR, icon: '\u2705' },
                      { label: 'Machine Utilization', value: k.machine_utilization, color: '#818cf8', icon: '\u2699' },
                      { label: 'Production Yield', value: k.production_yield, color: '#34d399', icon: '\u{1F4C8}' },
                      { label: 'TEEP', value: k.teep, color: '#fb923c', icon: '\u{1F3ED}' },
                    ].map(({ label, value, color, icon }) => (
                      <div key={label} style={{ background: t.surface, padding: '14px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: 20, marginBottom: 2 }}>{icon}</div>
                        <div style={{ fontSize: 24, fontWeight: 700, color }}>{Math.round(value)}%</div>
                        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Production data */}
                  <div style={{ padding: '16px 24px', fontSize: 13 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {[
                          ['Available Time', `${d.available_time_min} min`],
                          ['Operating Time', `${d.operating_time_min} min`],
                          ['Downtime', `${d.downtime_min} min`],
                          ['Actual Production Time', `${d.actual_production_time_min} min`],
                          ['Planned Qty', d.planned_qty],
                          ['Expected Qty', d.expected_qty],
                          ['Actual Qty', d.actual_qty],
                          ['Good Qty', d.good_qty],
                          ['Defect Qty', d.defect_qty],
                          ['Theoretical Qty', d.theoretical_qty],
                        ].map(([lbl, val]) => (
                          <tr key={lbl} style={{ borderBottom: `1px solid ${t.border}` }}>
                            <td style={{ padding: '6px 0', color: t.textMuted }}>{lbl}</td>
                            <td style={{ padding: '6px 0', textAlign: 'right', fontWeight: 600 }}>{val}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Formula reference */}
                  <div style={{ padding: '14px 24px 20px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: t.textMuted, marginBottom: 8 }}>Formulas</div>
                    <div style={{
                      display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px',
                      fontSize: 12, lineHeight: 1.7, color: t.text,
                      background: t.surface2, borderRadius: 8, padding: '10px 14px',
                      border: `1px solid ${t.border}`
                    }}>
                      <span style={{ fontWeight: 600, color: t.accent }}>AR</span>
                      <span>= (OpTime − Downtime) / OpTime</span>
                      <span style={{ fontWeight: 600, color: t.accent }}>PR</span>
                      <span>= ActualOutput / ExpectedOutput</span>
                      <span style={{ fontWeight: 600, color: t.accent }}>QR</span>
                      <span>= GoodUnits / TotalUnits</span>
                      <span style={{ fontWeight: 600, color: t.accent }}>OEE</span>
                      <span>= AR × PR × QR</span>
                      <span style={{ fontWeight: 600, color: t.accent }}>MUR</span>
                      <span>= ActualProdTime / AvailTime</span>
                      <span style={{ fontWeight: 600, color: t.accent }}>Yield</span>
                      <span>= ActualOutput / TheoreticalOutput</span>
                      <span style={{ fontWeight: 600, color: t.accent }}>TEEP</span>
                      <span>= OEE × MUR</span>
                    </div>
                  </div>
                </>
              );
            })() : null}
          </div>
        </div>
      )}
    </div>
  );
}

function getStyles(t) {
  return {
    page: { padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text },
    alert: { background: '#7f1d1d', color: '#fca5a5', padding: '10px 16px', borderRadius: 8,
             marginBottom: 10, fontSize: 13, fontWeight: 600 },
    filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' },
    viewBtns: { display: 'flex', gap: 4 },
    viewBtn: { padding: '6px 14px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2,
               color: t.textMuted, cursor: 'pointer', fontSize: 13 },
    viewBtnActive: { background: t.accent, color: '#fff', border: `1px solid ${t.accent}` },
    input: { padding: '6px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`, background: t.inp,
             color: t.text, fontSize: 13 },
    dlBtn: { marginLeft: 'auto', padding: '6px 16px', background: t.brand, color: '#fff', border: 'none',
             borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
    kpiRow: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 },
    kpi: { background: t.surface, borderRadius: 10, padding: '16px 20px', minWidth: 130, flex: 1 },
    charts: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 },
    chartBox: { background: t.surface, borderRadius: 10, padding: 16, overflow: 'visible' },
    chartTitle: { color: t.textMuted, margin: '0 0 12px', fontSize: 14 },
    noData: { height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: t.textFaint, fontSize: 13 },
    donutRow: { display: 'flex', justifyContent: 'space-around', alignItems: 'center',
                flexWrap: 'wrap', gap: 8, paddingTop: 4, paddingBottom: 4, minHeight: 220 },
    donutWrap: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: DONUT_CANVAS, height: DONUT_CANVAS, flexShrink: 0 },
    donutCenter: { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                   display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                   pointerEvents: 'none', textAlign: 'center' },
    tableWrap: { background: t.surface, borderRadius: 10, overflow: 'auto' },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { padding: '10px 8px', background: t.surface2, color: t.textDim, textAlign: 'left', whiteSpace: 'nowrap' },
    td: { padding: '8px', borderBottom: `1px solid ${t.surface2}`, color: t.text, whiteSpace: 'nowrap' },
    tr: { transition: 'background .15s' },
  };
}
