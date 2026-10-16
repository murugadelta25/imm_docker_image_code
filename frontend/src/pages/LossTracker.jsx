import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { useConfig, isMobileIntegrationEnabled } from '../context/ConfigContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';
import { getLossStatusStyles, getLossTileDefs, getLossHistogramColors } from '../themes/lossStatusColors';
import { downloadAxiosBlob } from '../utils/downloadBlob';
import {
  TPM_LOSS_CATEGORIES,
  formatTpmReason,
} from '../constants/tpmLosses';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, ReferenceLine, CartesianGrid, Legend,
} from 'recharts';


// Returns effective display status: idle < idleLimitMs → 'ld/unld'
function effectiveStatus(status, durationMs, idleLimitMs = 60000) {
  if (status === 'idle' && durationMs < idleLimitMs) return 'ld/unld';
  return status;
}

const DEFAULT_LIMITS_MIN = {
  idle:           1,
  breakdown:      90,
  alarm:          30,
  offline:        30,
  setting_change: 120,
};

const STORAGE_KEY = 'loss_tracker_limits';

function timeToMinutes(hhmm) {
  const [h, m] = (hhmm || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
}

function isOvernightShift(sh) {
  if (!sh) return false;
  return timeToMinutes(sh.end) <= timeToMinutes(sh.start);
}

function loadLimits() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_LIMITS_MIN, ...JSON.parse(raw) } : { ...DEFAULT_LIMITS_MIN };
  } catch { return { ...DEFAULT_LIMITS_MIN }; }
}

// Parse a threshold input string → decimal minutes
// Accepts: "1.5", "1m 30s", "1:30", "90s", "90"
function parseThresholdInput(raw) {
  const s = String(raw || '').trim();
  // mm:ss format
  const colonMatch = s.match(/^(\d+):(\d{1,2})$/);
  if (colonMatch) return parseInt(colonMatch[1]) + parseInt(colonMatch[2]) / 60;
  // "Xm Ys" or "Xm" or "Ys"
  const minsMatch = s.match(/(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/);
  if (minsMatch && (minsMatch[1] || minsMatch[2])) {
    return (parseFloat(minsMatch[1] || 0)) + (parseFloat(minsMatch[2] || 0) / 60);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 1 : n;
}

function formatThresholdDisplay(minutes) {
  const m = Math.floor(minutes);
  const s = Math.round((minutes - m) * 60);
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

const REASON_STATUSES  = ['idle', 'breakdown', 'alarm', 'offline', 'setting_change'];
const SUMMARY_STATUSES = ['idle', 'breakdown', 'alarm', 'offline', 'setting_change'];

// All timestamps from DB are IST naive but API appends 'Z' — strip it before parsing
const parseTS = str => str ? new Date(String(str).replace('Z','').replace(' IST','').replace(' ','T')) : null;

// Today/yesterday as YYYY-MM-DD in IST (machine local = IST)
const todayStr     = () => new Date().toLocaleDateString('en-CA'); // en-CA gives YYYY-MM-DD
const yesterdayStr = () => { const d = new Date(); d.setDate(d.getDate()-1); return d.toLocaleDateString('en-CA'); };

// IST date string from a parsed IST Date object
const istDateStr = d => (d instanceof Date ? d : new Date(d)).toLocaleDateString('en-CA');

const _p = n => String(n).padStart(2,'0');

function fmtIST(str) {
  if (!str) return '—';
  const d = parseTS(str);
  if (!d || isNaN(d)) return '—';
  return `${_p(d.getDate())}-${_p(d.getMonth()+1)}-${d.getFullYear()} ${_p(d.getHours())}:${_p(d.getMinutes())}:${_p(d.getSeconds())} IST`;
}

function fmtISTShort(str) {
  if (!str) return '(ongoing)';
  return fmtIST(str);
}

function istMinOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
}

function liveQueryDates(shifts) {
  const now     = new Date();
  const istMin  = istMinOfDay(now);
  const today   = todayStr();
  const yest    = yesterdayStr();
  for (const sh of shifts) {
    if (sh.enabled === false) continue;
    const [sH, sM] = sh.start.split(':').map(Number);
    const [eH, eM] = sh.end.split(':').map(Number);
    const s0 = sH * 60 + sM, e0 = eH * 60 + eM;
    const inShift = s0 < e0 ? (istMin >= s0 && istMin < e0) : (istMin >= s0 || istMin < e0);
    if (!inShift) continue;
    if (s0 > e0 && istMin < e0) return { date_from: yest, date_to: today };
    return { date_from: today, date_to: today };
  }
  return { date_from: today, date_to: today };
}

// Returns IST ms window [wStart, wEnd) for the currently active shift
function currentShiftWindow(shifts) {
  const now    = new Date();
  const istMin = istMinOfDay(now);
  const DAY    = 86400000;
  // IST midnight as local ms
  const istMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const sh of shifts) {
    if (sh.enabled === false) continue;
    const [sH, sM] = sh.start.split(':').map(Number);
    const [eH, eM] = sh.end.split(':').map(Number);
    const s0 = sH * 60 + sM, e0 = eH * 60 + eM;
    const inShift = s0 < e0 ? (istMin >= s0 && istMin < e0) : (istMin >= s0 || istMin < e0);
    if (!inShift) continue;
    let wStart = istMid + s0 * 60000;
    let wEnd   = istMid + e0 * 60000;
    if (e0 <= s0) {
      wEnd += DAY;
      if (istMin < e0) { wStart -= DAY; wEnd -= DAY; }
    }
    return { shiftId: sh.id, wStart, wEnd };
  }
  return null;
}

function filterRowsForCurrentShift(rows, shifts) {
  const shiftWin = currentShiftWindow(shifts);
  if (!shiftWin) return [];
  return rows.filter(r => {
    const ms = parseTS(r.changed_at)?.getTime();
    return ms >= shiftWin.wStart && ms < shiftWin.wEnd;
  });
}

function durationLabel(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function buildRows(statusLog, limitsMs = {}) {
  return statusLog.map((log, i) => {
    const from = parseTS(log.changed_at);
    const to   = log.end_time ? parseTS(log.end_time) : (i === 0 ? new Date() : parseTS(statusLog[i - 1].changed_at));
    const durationMs = to.getTime() - from.getTime();
    const effStatus = effectiveStatus(log.status, durationMs, limitsMs?.idle ?? 60000);
    const limit = limitsMs?.[log.status] ?? null;
    return {
      ...log,
      durationMs,
      effStatus,
      breached: limit !== null && durationMs > limit,
      isOngoing: !log.end_time && i === 0,
    };
  });
}

export default function LossTracker() {
  const { theme: t } = useTheme();
  const { config } = useConfig();
  const mobileCoupled = isMobileIntegrationEnabled(config);
  const statusStyles = useMemo(() => getLossStatusStyles(t), [t]);
  const tileDefs = useMemo(() => getLossTileDefs(t), [t]);
  const histoColors = useMemo(() => getLossHistogramColors(t), [t]);

  // shared selectors
  const [stations, setStations]         = useState([]);
  const [machines, setMachines]   = useState([]);
  const [stationId, setStationId]       = useState('');
  const [machineId, setMachineId] = useState('');

  // page tab
  const [pageTab, setPageTab] = useState('live');

  // live state
  const [liveLog, setLiveLog]       = useState([]);
  const [liveFilter, setLiveFilter] = useState('');
  const [liveMode, setLiveMode]     = useState('all');

  // historic state
  const [dateFrom, setDateFrom]     = useState(yesterdayStr());
  const [dateTo, setDateTo]         = useState(todayStr());
  const [histLog, setHistLog]       = useState([]);
  const [histFilter, setHistFilter] = useState('');
  const [histMode, setHistMode]     = useState('top20');
  const [histLoaded, setHistLoaded] = useState(false);

  // reason editing
  const [editReason, setEditReason]     = useState({
    id: null, value: '', source: '', applyToStation: false,
    mode: 'manual', // manual | tpm — default manual so web-only sites keep free-text entry
    lossCode: '', detail: '',
  });
  const [saving, setSaving]             = useState(false);
  const [reasonErr, setReasonErr]       = useState('');
  const [stationApplyResult, setStationApplyResult] = useState(null);

  // cycle stitching
  const [stitchEnabled, setStitchEnabled] = useState(false);
  const [stitchVariant, setStitchVariant] = useState('');
  const [partOptions, setPartOptions]     = useState([]);

  // threshold config
  const [limitsMin, setLimitsMin]     = useState(loadLimits);
  const [showSettings, setShowSettings] = useState(false);
  const [editLimits, setEditLimits]   = useState(() => Object.fromEntries(Object.entries(loadLimits()).map(([k,v]) => [k, String(v)])));

  // Load thresholds from backend on mount (source of truth — survives code pull)
  useEffect(() => {
    api.get('/api/deviation-alerts/limits').then(r => {
      const merged = { ...DEFAULT_LIMITS_MIN, ...r.data };
      // Coerce to numbers (API may return floats)
      const numeric = Object.fromEntries(
        Object.entries(merged).map(([k, v]) => [k, Math.max(0.01, Number(v) || DEFAULT_LIMITS_MIN[k] || 1)])
      );
      setLimitsMin(numeric);
      setEditLimits(Object.fromEntries(Object.entries(numeric).map(([k, v]) => [k, String(v)])));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(numeric));
    }).catch(() => {}); // fallback to localStorage already set via useState
  }, []);

  // charts
  const [showPareto, setShowPareto]       = useState(false);
  const [showHistogram, setShowHistogram] = useState(false);

  // shift config
  const [shifts, setShifts] = useState([]);

  // histogram — own independent pair/machine selectors + state
  const [histoShift,     setHistoShift]     = useState('');
  const [histoHour,      setHistoHour]      = useState('');
  const [histoStationId,    setHistoStationId]    = useState('');
  const [histoMachineId, setHistoMachineId] = useState('');
  const [histoDate,      setHistoDate]      = useState(todayStr()); // reference IST date for window
  const [histoLog,       setHistoLog]       = useState([]);
  const [histoLoading,   setHistoLoading]   = useState(false);

  // machine CT + threshold config for cycle time analysis (matches hourly output logic)
  const [histoCt, setHistoCt] = useState({ cycle_time_sec: 0, running_part_threshold_pct: 30 });

  // convert minutes to ms
  const LIMITS_MS = Object.fromEntries(
    Object.entries(limitsMin).map(([k, v]) => [k, v * 60 * 1000])
  );

  // fetch shifts once, then re-fetch live log with correct date range
  useEffect(() => {
    api.get('/api/config/').then(r => {
      const enabled = (r.data.shifts || []).filter(s => s.enabled !== false);
      setShifts(enabled);
      if (enabled.length) {
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        const active = enabled.find(sh => {
          const s = sh.start.split(':').map(Number);
          const e = sh.end.split(':').map(Number);
          const s0 = s[0] * 60 + s[1], e0 = e[0] * 60 + e[1];
          return e0 > s0 ? (nowMin >= s0 && nowMin < e0) : (nowMin >= s0 || nowMin < e0);
        });
        setHistoShift((active || enabled[0]).id);
      }
    }).catch(() => {});
  }, []);

  // re-fetch live log whenever shifts config loads (shifts changes date range logic)
  useEffect(() => {
    if (shifts.length && machineId) fetchLive(machineId);
  }, [shifts]); // eslint-disable-line

  // hour slots for selected shift (minute-accurate, supports overnight)
  const shiftHourSlots = useMemo(() => {
    const sh = shifts.find(s => s.id === histoShift);
    if (!sh) return [];
    const startM = timeToMinutes(sh.start);
    const endM = timeToMinutes(sh.end);
    const overnight = isOvernightShift(sh);
    const totalMinutes = overnight ? (24 * 60 - startM + endM) : Math.max(0, endM - startM);
    const slots = [];
    for (let i = 0; i < totalMinutes; i += 60) {
      const fromM = (startM + i) % (24 * 60);
      const toM = (fromM + 60) % (24 * 60);
      const fromH = Math.floor(fromM / 60);
      const toH = Math.floor(toM / 60);
      slots.push({
        label: `${String(fromH).padStart(2, '0')}:00-${String(toH).padStart(2, '0')}:00`,
        value: `${fromH}-${toH}`,
        slotIndex: i / 60,
      });
    }
    return slots;
  }, [shifts, histoShift]);

  // Auto-select current hour slot; for overnight shifts initialise histoDate = shift START date
  useEffect(() => {
    const syncHour = () => {
      if (!shiftHourSlots.length || !shifts.length) return;
      const sh = shifts.find(s => s.id === histoShift);
      const now = new Date();
      const currentH = now.getHours();
      const currentMin = currentH * 60 + now.getMinutes();

      // Only auto-correct histoDate when it is still set to today/yesterday
      // (i.e. user has NOT manually picked a historic date)
      const liveDate = (() => {
        if (!sh) return todayStr();
        const [sH] = sh.start.split(':').map(Number);
        const [eH] = sh.end.split(':').map(Number);
        return (eH <= sH && currentMin < eH * 60) ? yesterdayStr() : todayStr();
      })();
      setHistoDate(prev => (prev === todayStr() || prev === yesterdayStr()) ? liveDate : prev);

      const match = shiftHourSlots.find(sl => parseInt(sl.value.split('-')[0]) === currentH);
      setHistoHour(match?.value || shiftHourSlots[0]?.value || '');
    };
    syncHour();
    const timer = setInterval(syncHour, 60000);
    return () => clearInterval(timer);
  }, [shiftHourSlots, histoShift, shifts]); // eslint-disable-line

  // histogram pair -> machine cascade
  const histoPairMachines = histoStationId
    ? machines.filter(m => m.station_id === parseInt(histoStationId))
    : machines;

  useEffect(() => {
    if (!histoStationId) return;
    const list = machines.filter(m => m.station_id === parseInt(histoStationId));
    setHistoMachineId(list.length ? String(list[0].id) : '');
    setHistoLog([]);
  }, [histoStationId, machines]);

  // fetch histogram machine log — scoped to selected shift on selected histoDate
  useEffect(() => {
    if (!histoMachineId || !histoShift || !shifts.length) { setHistoLog([]); return; }
    setHistoLoading(true);
    const sh = shifts.find(s => s.id === histoShift);
    const [eH] = (sh?.end || '08:00').split(':').map(Number);
    const [sH] = (sh?.start || '08:00').split(':').map(Number);
    // For overnight shifts (B shift), also fetch next day
    const isOvernight = isOvernightShift(sh);
    const d = new Date(histoDate + 'T00:00:00');
    const nextDay = new Date(d); nextDay.setDate(nextDay.getDate() + 1);
    const fmt = dt => dt.toLocaleDateString('en-CA'); // local IST date string, not UTC
    // histoDate = shift START date (e.g. 2026-06-18 for Shift B 20:00→2026-06-19 08:00)
    // For overnight shifts fetch histoDate + nextDay to cover post-midnight portion
    const dateFrom = histoDate;
    const dateTo   = isOvernight ? fmt(nextDay) : histoDate;
    const params = { limit: 5000, date_from: dateFrom, date_to: dateTo, include_plan_metrics: true };
    if (stitchEnabled && stitchVariant) {
      params.stitch = true;
      params.model_variant = stitchVariant;
    }
    api.get(`/api/machines/${histoMachineId}/status-log`, { params })
      .then(r => setHistoLog(r.data))
      .catch(() => {})
      .finally(() => setHistoLoading(false));
  }, [histoMachineId, histoShift, histoDate, shifts, stitchEnabled, stitchVariant]);

  // fetch machine CT + threshold config for cycle time analysis
  useEffect(() => {
    if (!histoMachineId || !histoShift || !histoDate) {
      setHistoCt({ cycle_time_sec: 0, running_part_threshold_pct: 30 });
      return;
    }
    api.get('/api/hourly-output/machine-ct', {
      params: { machine_id: histoMachineId, entry_date: histoDate, shift: histoShift },
    }).then(r => setHistoCt(r.data))
      .catch(() => setHistoCt({ cycle_time_sec: 0, running_part_threshold_pct: 30 }));
  }, [histoMachineId, histoShift, histoDate]);

  // Pareto data
  const paretoData = useMemo(() => {
    const activeLog = pageTab === 'live' ? liveLog : histLog;
    const rows = buildRows(activeLog, LIMITS_MS);
    const counts = {}, totalMs = {};
    rows.forEach(r => {
      if (!r.breached) return;
      counts[r.status]  = (counts[r.status]  || 0) + 1;
      totalMs[r.status] = (totalMs[r.status] || 0) + r.durationMs;
    });
    return Object.entries(counts)
      .map(([status, count]) => ({
        status, label: statusStyles[status]?.label || status, count,
        totalMin: Math.round(totalMs[status] / 60000),
        color: statusStyles[status]?.color || t.textMuted,
      }))
      .sort((a, b) => b.totalMin - a.totalMin);
  }, [pageTab, liveLog, histLog, limitsMin, statusStyles, t.textMuted]); // eslint-disable-line

//   // Compute total occurrences/counts for each state in the active log view
// const occurrenceCounts = useMemo(() => {
//     const counts = {
//       running: 0,
//       idle: 0,
//       breakdown: 0,
//       alarm: 0,
//       offline: 0,
//       "ld/unld": 0,
//       setting_change: 0
//     };

//     const rows = buildRows(liveLog, LIMITS_MS);

//     const shiftRows =
//       pageTab === "live"
//         ? filterRowsForCurrentShift(rows, shifts)
//         : rows;

//     shiftRows.forEach(r => {
//       if (counts[r.effStatus] !== undefined) {
//         counts[r.effStatus]++;
//       }
//     });

//     return counts;
//   }, [
//     pageTab,
//     liveLog,
//     histLog,
//     LIMITS_MS,
//     shifts
//   ]);
  // const occurrenceCounts = useMemo(() => {
  //   const activeLog = pageTab === 'live' ? liveLog : histLog;
  //   const rows = buildRows(activeLog, LIMITS_MS);
    
  //   // Initialize counters for all statuses to 0
  //   const counts = {
  //     running: 0,
  //     'ld/unld': 0,
  //     idle: 0,
  //     breakdown: 0,
  //     alarm: 0,
  //     setting_change: 0,
  //     offline: 0
  //   };

  //   // Count raw transitions into each effective status
  //   rows.forEach(r => {
  //     if (counts[r.effStatus] !== undefined) {
  //       counts[r.effStatus] += 1;
  //     }
  //   });

  //   return counts;
  // }, [pageTab, liveLog, histLog, LIMITS_MS]);


  // Shift time-split tiles (uses main loaded log)
  const shiftTiles = useMemo(() => {
    const activeLog = pageTab === 'live' ? liveLog : histLog;
    if (!activeLog.length || !shifts.length) return [];
    const rows = buildRows(activeLog, LIMITS_MS);
    const isStitchedView = stitchEnabled && !!stitchVariant;
    const ALL_ST = ['running','ld/unld','idle','breakdown','alarm','offline','setting_change'];
    const DAY = 86400000;
    const nowUTC = Date.now();

    // For live: use currentShiftWindow (only active shift, exact UTC window)
    // For historic: derive each shift's UTC window from the IST date of the loaded log
    const activeWin = pageTab === 'live' ? currentShiftWindow(shifts) : null;

    // Determine the IST reference date from the log (oldest record)
    const refIST = pageTab === 'historic' && rows.length
      ? (() => {
          const oldest = rows[rows.length - 1];
          const d = parseTS(oldest.changed_at);
          return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        })()
      : null;

    // Build ms window [wStart, wEnd) from IST midnight ms
    const buildWindow = (istMidMs, s0, e0) => {
      let wStart = istMidMs + s0 * 60000;
      let wEnd   = istMidMs + e0 * 60000;
      if (e0 <= s0) wEnd += DAY;
      return { wStart, wEnd };
    };

    const overlapMs = (rowStart, rowEnd, wStart, wEnd) => {
      const lo = Math.max(rowStart, wStart);
      const hi = Math.min(rowEnd, wEnd);
      return hi > lo ? hi - lo : 0;
    };

    return shifts.map(sh => {
      const [sH, sM] = sh.start.split(':').map(Number);
      const [eH, eM] = sh.end.split(':').map(Number);
      const s0 = sH * 60 + sM, e0 = eH * 60 + eM;
      const shiftDurMs = e0 > s0 ? (e0 - s0) * 60000 : (1440 - s0 + e0) * 60000;

      // Determine the exact UTC window for this shift
      let win;
      if (pageTab === 'live') {
        // Only process the active shift; skip others
        if (!activeWin || activeWin.shiftId !== sh.id)
          return null;
        win = { wStart: activeWin.wStart, wEnd: activeWin.wEnd };
      } else {
        // Historic: anchor this shift to the IST date of the loaded data
        win = buildWindow(refIST, s0, e0);
        // If this shift's window is entirely in the future, show zeros
        if (win.wStart > nowUTC) {
          const toHM = ms => { const t = Math.max(0,Math.round(ms/60000)); return t>=60?`${Math.floor(t/60)}h ${t%60}m`:`${t}m`; };
          const dateLabel = istDateStr(win.wStart);
          const acc = {}; ALL_ST.forEach(s => { acc[s] = 0; });
          const cnt = {}; ALL_ST.forEach(s => { cnt[s] = 0; });
          acc._unaccounted = shiftDurMs;
          cnt._unaccounted = 0;
          return { shift: sh, acc, cnt, toHM, shiftDurMs, elapsedMs: 0, dateLabel, notStarted: true };
        }
      }

      // Elapsed: how much of this shift window has passed
      const elapsedMs = Math.max(0, Math.min(nowUTC - win.wStart, shiftDurMs));

      const acc = {};
      const cnt = {};
      ALL_ST.forEach(s => { acc[s] = 0; cnt[s] = 0; });
      rows.forEach(r => {
        const rowStart = parseTS(r.changed_at).getTime();
        const rowEnd   = rowStart + r.durationMs;
        const ov = overlapMs(rowStart, rowEnd, win.wStart, win.wEnd);
        const effectiveStatus = isStitchedView && r.status === 'running' && r.is_stitched ? 'running' : r.effStatus;
        if (!ALL_ST.includes(effectiveStatus)) return;
        const startsInShift = rowStart >= win.wStart && rowStart < win.wEnd;
        if (ov > 0) {
          acc[effectiveStatus] += ov;
        }
        if (startsInShift) {
          cnt[effectiveStatus] += 1;
        }
      });

      const knownMs = ALL_ST.filter(k => k !== '_unaccounted' && k !== '_remaining').reduce((s, k) => s + acc[k], 0);
      const baseMs = pageTab === 'live' ? elapsedMs : shiftDurMs;
      acc._unaccounted = Math.max(0, baseMs - knownMs);
      cnt._unaccounted = 0;
      acc._remaining = Math.max(0, shiftDurMs - elapsedMs);
      cnt._remaining = 0;

      const dateLabel = istDateStr(win.wStart);

      const toHM = ms => {
        const tot = Math.max(0, Math.round(ms / 60000));
        if (tot >= 60) return `${Math.floor(tot / 60)}h ${tot % 60}m`;
        if (tot > 0) return `${tot}m`;
        const secs = Math.max(0, Math.round(ms / 1000));
        return secs > 0 ? `${secs}s` : '0m';
      };
      return { shift: sh, acc, cnt, toHM, shiftDurMs, elapsedMs, dateLabel, notStarted: false };
    }).filter(Boolean);
  }, [pageTab, liveLog, histLog, shifts, limitsMin, stitchEnabled, stitchVariant]); // eslint-disable-line

  // Bell curve: X = hour slots for whole shift, Y = count of running+idle cycles per slot
  // Selected slot is highlighted; avg running reference line shown on that slot
  const bellData = useMemo(() => {
    if (!histoShift || !shifts.length) return { bars: [], runAvg: 0, ldAvg: 0, idleAvg: 0 };
    const sh = shifts.find(s => s.id === histoShift);
    if (!sh) return { bars: [], runAvg: 0, ldAvg: 0, idleAvg: 0 };
    const rows = buildRows(histoLog, LIMITS_MS);

    // DB stores IST naive but API appends Z — parse without offset correction
    // Strip the Z and parse as local to get correct IST ms value
    const toMs = utcStr => new Date(utcStr.replace('Z', '')).getTime();

    // Build shift window in IST ms (no offset needed — timestamps are already IST)
    const [sH, sM] = sh.start.split(':').map(Number);
    const [eH, eM] = sh.end.split(':').map(Number);
    const s0 = sH * 60 + sM, e0 = eH * 60 + eM;
    const isOvernightShift = e0 <= s0;
    // histoDate = shift START date → winStart = histoDate 20:00, winEnd = nextDay 08:00
    const anchorDate = new Date(histoDate + 'T00:00:00').getTime();
    let winStart = anchorDate + s0 * 60000;
    let winEnd   = anchorDate + e0 * 60000;
    if (isOvernightShift) winEnd += 86400000;

    // Shift B not started yet (winStart is in the future) → return empty
    if (winStart > Date.now()) return { bars: [], runAvg: 0, ldAvg: 0, idleAvg: 0, notStarted: true };

    const shiftRows = rows.filter(r => {
      const ms = toMs(r.changed_at);
      return ms >= winStart && ms < winEnd;
    });

    const isStitchedView = stitchEnabled && !!stitchVariant;

    const ctSec = histoCt.cycle_time_sec || 0;
    const threshPct = histoCt.running_part_threshold_pct ?? 30;
    const runThreshMs = ctSec > 0 && threshPct > 0
      ? ctSec * (threshPct / 100) * 1000
      : 0;

    const bars = shiftHourSlots.map(sl => {
      const slotStart = winStart + sl.slotIndex * 3600000;
      const slotEnd = slotStart + 3600000;
      const inSlot = r => {
        const ms = toMs(r.changed_at);
        return ms >= slotStart && ms < slotEnd;
      };
      const runRowsAll = shiftRows.filter(r => {
        const effectiveStatus = isStitchedView && r.status === 'running' && r.is_stitched ? 'running' : r.effStatus;
        return effectiveStatus === 'running' && inSlot(r);
      });
      const runRows = runThreshMs > 0
        ? runRowsAll.filter(r => r.durationMs >= runThreshMs)
        : runRowsAll;
      const ldRows   = shiftRows.filter(r => {
        const effectiveStatus = isStitchedView && r.status === 'running' && r.is_stitched ? 'running' : r.effStatus;
        return effectiveStatus === 'ld/unld' && inSlot(r);
      });
      const idleRows = shiftRows.filter(r => {
        const effectiveStatus = isStitchedView && r.status === 'running' && r.is_stitched ? 'running' : r.effStatus;
        return effectiveStatus === 'idle' && inSlot(r);
      });
      const avg = arr => arr.length
        ? Math.round(arr.reduce((s, r) => s + r.durationMs / 1000, 0) / arr.length) : 0;
      return {
        slot:       sl.label,
        running:    runRows.length,
        ldUnld:     ldRows.length,
        idle:       idleRows.length,
        runAvg:     avg(runRows),
        ldAvg:      avg(ldRows),
        idleAvg:    avg(idleRows),
        isSelected: sl.value === histoHour,
      };
    });

    const avg = arr => arr.length
      ? Math.round(arr.reduce((s, r) => s + r.durationMs / 1000, 0) / arr.length) : 0;
    const pickStatus = r => (isStitchedView && r.status === 'running' && r.is_stitched ? 'running' : r.effStatus);
    const countableRun = (r) => {
      if (pickStatus(r) !== 'running') return false;
      if (threshPct <= 0) return true;
      if (typeof r.running_completion_pct === 'number') {
        return r.running_completion_pct >= threshPct;
      }
      return runThreshMs <= 0 || r.durationMs >= runThreshMs;
    };
    return {
      bars,
      runAvg:  avg(shiftRows.filter(r => countableRun(r))),
      ldAvg:   avg(shiftRows.filter(r => pickStatus(r) === 'ld/unld')),
      idleAvg: avg(shiftRows.filter(r => pickStatus(r) === 'idle')),
      ctSec,
      threshPct,
    };
  }, [histoShift, histoHour, histoDate, histoLog, shifts, shiftHourSlots, limitsMin, stitchEnabled, stitchVariant, histoCt]); // eslint-disable-line

  useEffect(() => {
    Promise.all([api.get('/api/stations/'), api.get('/api/machines/'), api.get('/api/parts/options', { params: { active_only: true, limit: 200 } })])
      .then(([p, m, parts]) => {
        setStations(p.data);
        setMachines(m.data);
        setPartOptions(parts.data || []);
        if (p.data.length > 0) {
          const firstPair = String(p.data[0].id);
          setStationId(firstPair);
          setHistoStationId(firstPair);
        }
        if (m.data.length > 0) {
          const firstMachine = String(m.data[0].id);
          setMachineId(firstMachine);
          setHistoMachineId(firstMachine);
        }
      })
      .catch(err => console.error('Failed to load pairs/machines', err));
  }, []);

  useEffect(() => {
    if (!showHistogram) return;
    if (stationId) setHistoStationId(stationId);
    if (machineId) setHistoMachineId(machineId);
  }, [showHistogram, stationId, machineId]);

  const stationMachines = stationId
    ? machines.filter(m => m.station_id === parseInt(stationId))
    : machines;

  useEffect(() => {
    if (!stationId) return;
    const list = machines.filter(m => m.station_id === parseInt(stationId));
    setMachineId(list.length ? String(list[0].id) : '');
    setLiveLog([]); setHistLog([]);
    setLiveFilter(''); setHistFilter('');
    setHistLoaded(false);
  }, [stationId, machines]);

  const buildStatusLogParams = useCallback((extra = {}) => {
    const params = { limit: 5000, include_plan_metrics: true, ...extra };
    if (stitchEnabled && stitchVariant) {
      params.stitch = true;
      params.model_variant = stitchVariant;
    }
    return params;
  }, [stitchEnabled, stitchVariant]);

  const fetchLive = useCallback(async (mid) => {
    if (!mid) { setLiveLog([]); return; }
    const dates = liveQueryDates(shifts);
    const params = buildStatusLogParams({ ...dates });
    const r = await api.get(`/api/machines/${mid}/status-log`, { params });
    setLiveLog(r.data);
  }, [shifts, buildStatusLogParams]);

  useEffect(() => { if (machineId) fetchLive(machineId); }, [machineId, fetchLive]);

  const fetchHistoric = useCallback(async () => {
    if (!machineId || !dateFrom || !dateTo) return;
    const params = buildStatusLogParams({ limit: 2000, date_from: dateFrom, date_to: dateTo });
    const r = await api.get(`/api/machines/${machineId}/status-log`, { params });
    setHistLog(r.data);
    setHistLoaded(true);
    setHistFilter('');
  }, [machineId, dateFrom, dateTo, buildStatusLogParams]);

  const saveReason = async (logId) => {
    const selectedLoss = TPM_LOSS_CATEGORIES.find((l) => l.code === editReason.lossCode);
    let reason = editReason.value.trim();
    const useTpm = mobileCoupled && editReason.mode === 'tpm' && selectedLoss;
    if (useTpm) {
      if ((selectedLoss.rootCauses || selectedLoss.subDivisions) && !editReason.detail) {
        setReasonErr('Select root cause / management option');
        return;
      }
      reason = formatTpmReason(selectedLoss.code, selectedLoss.description, editReason.detail || null);
    }
    if (!reason) { setReasonErr('Reason is mandatory — pick a TPM loss or type manually'); return; }
    setSaving(true); setReasonErr(''); setStationApplyResult(null);
    try {
      const payload = {
        reason,
        create_loss_log: Boolean(useTpm),
        loss_code: useTpm ? selectedLoss.code : null,
        loss_description: useTpm ? selectedLoss.description : null,
        sub_division: useTpm ? (editReason.detail || null) : null,
      };
      await api.patch(`/api/machines/status-log/${logId}/reason`, payload);
      const updater = prev => prev.map(l => l.id === logId ? { ...l, deviation_reason: reason } : l);
      setLiveLog(updater);
      setHistLog(updater);

      if (editReason.applyToStation) {
        const currentMachine = machines.find(m => m.id === parseInt(machineId));
        const pairedMachines = currentMachine
          ? machines.filter(m => m.station_id === currentMachine.station_id && m.id !== currentMachine.id)
          : [];
        if (pairedMachines.length > 0) {
          const currentLog = [...liveLog, ...histLog].find(l => l.id === logId);
          if (currentLog) {
            const currentTs = new Date(currentLog.changed_at).getTime();
            let appliedCount = 0;
            const appliedNames = [];
            for (const pm of pairedMachines) {
              const dateStr = new Date(currentTs).toLocaleDateString('en-CA');
              try {
                const r = await api.get(`/api/machines/${pm.id}/status-log`, {
                  params: { limit: 500, date_from: dateStr, date_to: dateStr }
                });
                const WINDOW_MS = 2 * 60 * 1000;
                const matches = r.data.filter(l => {
                  const ts = new Date(l.changed_at).getTime();
                  return l.status === currentLog.status && Math.abs(ts - currentTs) <= WINDOW_MS;
                });
                for (const match of matches) {
                  await api.patch(`/api/machines/status-log/${match.id}/reason`, payload);
                  appliedCount++;
                }
                if (matches.length > 0) appliedNames.push(pm.name);
              } catch { /* ignore */ }
            }
            if (appliedCount > 0) {
              setStationApplyResult({ applied: appliedCount, machineNames: appliedNames });
              setTimeout(() => setStationApplyResult(null), 5000);
            }
          }
        }
      }
      setEditReason({ id: null, value: '', source: '', applyToStation: false, mode: 'manual', lossCode: '', detail: '' });
    } finally { setSaving(false); }
  };

  // styles
  const inp  = { padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
                 background: t.inp, color: t.text, fontSize: 13 };
  const card = { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 };
  const thS  = { padding: '10px', background: t.surface2, color: t.textDim,
                 textAlign: 'left', whiteSpace: 'nowrap', fontSize: 12 };
  const tdS  = { padding: '10px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' };
  const tabBtn = (key) => ({
    padding: '8px 18px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
    borderBottom: pageTab === key ? `3px solid ${t.accent}` : '3px solid transparent',
    color: pageTab === key ? t.accent : t.textMuted, fontWeight: pageTab === key ? 600 : 400,
  });

  const machineName = machines.find(m => m.id === parseInt(machineId))?.name || '';
  const currentMachineObj = machines.find(m => m.id === parseInt(machineId));
  const pairedMachines = currentMachineObj
    ? machines.filter(m => m.station_id === currentMachineObj.station_id && m.id !== currentMachineObj.id)
    : [];

  const downloadReport = async (reportDate) => {
    const date = reportDate || todayStr();
    try {
      const r = await api.get('/api/email/download/loss-tracker', {
        params: { report_date: date },
        responseType: 'blob',
      });
      await downloadAxiosBlob(r, `loss_tracker_${date}.xlsx`);
    } catch (err) {
      alert(`Download failed: ${err.message}`);
    }
  };

  // shared table renderer
  const renderTable = (rawLog, filter, setFilter, mode, setMode, isHistoric = false) => {
    const rows = buildRows(rawLog, LIMITS_MS);
    const breachCounts = {};
    rows.forEach(r => { if (r.breached) breachCounts[r.status] = (breachCounts[r.status] || 0) + 1; });
    const pending = rows.filter(r => r.breached && REASON_STATUSES.includes(r.status) && !r.deviation_reason);

    let displayRows;
    if (filter) {
      displayRows = rows.filter(r => r.status === filter && r.breached)
                        .sort((a, b) => b.durationMs - a.durationMs).slice(0, 20);
    } else if (mode === 'breached' || mode === 'top20') {
      displayRows = rows.filter(r => r.breached)
                        .sort((a, b) => b.durationMs - a.durationMs).slice(0, 20);
    } else {
      displayRows = rows;
    }

    const maxMs = Math.max(...displayRows.map(r => r.durationMs), 1);

    return (
      <>
        {pending.length > 0 && (
          <div style={{ background: '#ef444415', border: '1px solid #ef4444', borderRadius: 8,
                        padding: '10px 16px', marginBottom: 12, fontSize: 13, color: '#ef4444', fontWeight: 600 }}>
            &#9888; {pending.length} breach record(s) missing a deviation reason &mdash; please fill them in.
          </div>
        )}

        {stationApplyResult && (
          <div style={{ background: '#10b98115', border: '1px solid #10b981', borderRadius: 8,
                        padding: '10px 16px', marginBottom: 12, fontSize: 13, color: '#10b981', fontWeight: 600 }}>
            &#10003; Reason also applied to {stationApplyResult.applied} matching record(s) on:{' '}
            {stationApplyResult.machineNames.join(', ')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          {rawLog.length > 0 && !filter && (
            <div style={{ display: 'flex', gap: 4 }}>
              {(isHistoric
                ? [['all','All Logs'],['top20','Top 20 Exceeded']]
                : [['all','All Logs'],['breached','Top 20 Exceeded']]
              ).map(([m, label]) => (
                <button key={m} onClick={() => setMode(m)} style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                  background: mode === m ? t.accent : t.surface2,
                  color: mode === m ? '#fff' : t.textMuted,
                  border: `1px solid ${mode === m ? t.accent : t.border}`,
                }}>{label}</button>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SUMMARY_STATUSES.map(s => {
              const st = statusStyles[s];
              const bc = breachCounts[s] || 0;
              const active = filter === s;
              return (
                <button key={s} onClick={() => { setFilter(active ? '' : s); setMode('all'); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                    borderRadius: 8, fontSize: 12, cursor: 'pointer', outline: 'none',
                    background: active ? st.color + '33' : bc > 0 ? st.bg : t.surface2,
                    border: `1.5px solid ${active ? st.color : bc > 0 ? st.color + '66' : t.border}`,
                    opacity: bc > 0 || active ? 1 : 0.45,
                  }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                  <span style={{ color: active ? st.color : bc > 0 ? st.color : t.textFaint, fontWeight: 600 }}>{st.label}</span>
                  <span style={{ background: bc > 0 ? st.color : t.border, color: '#fff', borderRadius: 10,
                                 padding: '0 6px', fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: 'center' }}>{bc}</span>
                  {bc > 0 && (
                    <span title={`${bc} exceeded threshold`}
                      style={{ background: '#ef4444', color: '#fff', borderRadius: 10,
                               padding: '0 5px', fontSize: 10, fontWeight: 700 }}>&#9888;{bc}</span>
                  )}
                  <span style={{ fontSize: 9, color: t.textFaint, borderLeft: `1px solid ${t.border}`,
                                 paddingLeft: 4, marginLeft: 1 }}>&gt;{limitsMin[s]}m</span>
                </button>
              );
            })}
            {filter && (
              <button onClick={() => setFilter('')}
                style={{ padding: '5px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                         background: t.surface2, border: `1px solid ${t.border}`, color: t.textMuted }}>
                &#10005; Clear
              </button>
            )}
          </div>
        </div>

        {machineName && rawLog.length > 0 && (
          <div style={{ color: t.textDim, fontSize: 12, marginBottom: 10 }}>
            {filter
              ? <>Top 20 exceeded <b style={{ color: statusStyles[filter]?.color }}>{statusStyles[filter]?.label}</b> for <b style={{ color: t.accent }}>{machineName}</b></>
              : (mode === 'breached' || mode === 'top20')
                ? <>Top 20 longest exceeded records for <b style={{ color: t.accent }}>{machineName}</b> &mdash; {rows.filter(r=>r.breached).length} total breaches in {rows.length} entries</>
                : <>Full log for <b style={{ color: t.accent }}>{machineName}</b> &mdash; {rows.length} entries, {rows.filter(r=>r.breached).length} breaches</>
            }
          </div>
        )}

        {displayRows.length === 0 ? (
          <div style={{ color: t.textFaint, textAlign: 'center', padding: 32, fontSize: 13 }}>
            {rawLog.length === 0 ? 'No data loaded.' : 'No threshold breaches found.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={thS}>#</th>
                  <th style={thS}>Status</th>
                  <th style={thS}>Start Time (IST)</th>
                  <th style={thS}>End Time (IST)</th>
                  <th style={thS}>Duration</th>
                  <th style={thS}>Bar</th>
                  <th style={{ ...thS, color: '#ef4444' }}>Deviation Reason</th>
                  <th style={thS}>Source</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((log) => {
                  const st = statusStyles[log.effStatus] || statusStyles[log.status] || { color: t.textMuted, bg: 'transparent', label: log.status };
                  const completionPct = log.effStatus === 'running'
                    ? log.running_completion_pct
                    : log.effStatus === 'ld/unld'
                      ? log.ld_unld_completion_pct
                      : null;
                  const pct = Number.isFinite(completionPct)
                    ? Math.max(0, Math.min(completionPct, 100))
                    : Math.min((log.durationMs / maxMs) * 100, 100);
                  const rowBg = log.breached
                    ? (log.deviation_reason ? st.bg : '#ef444415')
                    : REASON_STATUSES.includes(log.status) ? st.bg : 'transparent';
                  const isEditing = editReason.id === log.id;
                  const originalIdx = rawLog.findIndex(l => l.id === log.id);
                  const rowNum = rawLog.length - originalIdx;

                  return (
                    <tr key={log.id} style={{
                      background: rowBg,
                      borderLeft: log.breached
                        ? `3px solid ${log.deviation_reason ? st.color : '#ef4444'}`
                        : '3px solid transparent',
                    }}>
                      <td style={{ ...tdS, color: t.textFaint, fontSize: 11, minWidth: 36 }}>{rowNum}</td>

                      <td style={tdS}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                                         padding: '3px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                                         background: st.bg, color: st.color, border: `1px solid ${st.color}44` }}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                            {st.label}
                          </span>
                          {log.breached && (
                            <span style={{ fontSize: 10, background: '#ef4444', color: '#fff',
                                           borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>EXCEEDED</span>
                          )}
                          {log.is_stitched && (
                            <span title={`Merged ${log.merged_count} segments: ${(log.stitched_ids || []).join(', ')}`}
                              style={{ fontSize: 10, background: '#8b5cf6', color: '#fff',
                                       borderRadius: 4, padding: '1px 6px', fontWeight: 700, cursor: 'help' }}>
                              ⊕ {log.merged_count} segs
                            </span>
                          )}
                        </div>
                      </td>

                      <td style={{ ...tdS, fontVariantNumeric: 'tabular-nums', fontSize: 12, color: t.text }}>
                        {fmtIST(log.changed_at)}
                      </td>

                      <td style={{ ...tdS, fontVariantNumeric: 'tabular-nums', fontSize: 12,
                                    color: log.isOngoing ? t.accent : t.textMuted }}>
                        {log.isOngoing ? '(ongoing)' : fmtISTShort(log.end_time)}
                      </td>

                      <td style={{ ...tdS, fontWeight: log.breached ? 700 : 400,
                                    color: log.breached ? '#ef4444' : REASON_STATUSES.includes(log.status) ? st.color : t.textMuted,
                                    fontSize: 12, whiteSpace: 'nowrap' }}>
                        {log.isOngoing
                          ? <>{durationLabel(log.durationMs)} <span style={{ fontSize: 10, color: t.accent }}>(ongoing)</span></>
                          : durationLabel(log.durationMs)}
                        {log.breached && LIMITS_MS[log.status] && (
                          <div style={{ fontSize: 10, color: '#ef4444', marginTop: 1 }}>
                            limit: {durationLabel(LIMITS_MS[log.status])}
                          </div>
                        )}
                      </td>

                      <td style={{ ...tdS, minWidth: 110 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ flex: 1, height: 7, background: t.surface2, borderRadius: 4, overflow: 'hidden', minWidth: 70 }}>
                            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 4,
                                          background: log.breached ? '#ef4444' : st.color, transition: 'width 0.3s' }} />
                          </div>
                          <span style={{ fontSize: 10, color: t.textFaint, minWidth: 32, textAlign: 'right' }}>{Math.round(pct)}%</span>
                        </div>
                      </td>

                      <td style={{ ...tdS, minWidth: 220 }}>
                        {!REASON_STATUSES.includes(log.status) ? (
                          <span style={{ color: t.textFaint, fontSize: 11 }}>&mdash;</span>
                        ) : isEditing ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {mobileCoupled && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button type="button"
                                onClick={() => setEditReason(p => ({ ...p, mode: 'tpm', value: '' }))}
                                style={{
                                  padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                  border: `1px solid ${editReason.mode === 'tpm' ? t.accent : t.border}`,
                                  background: editReason.mode === 'tpm' ? `${t.accent}22` : t.surface2,
                                  color: editReason.mode === 'tpm' ? t.accent : t.textMuted, fontWeight: 600,
                                }}>TPM loss</button>
                              <button type="button"
                                onClick={() => setEditReason(p => ({ ...p, mode: 'manual', lossCode: '', detail: '' }))}
                                style={{
                                  padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                  border: `1px solid ${editReason.mode === 'manual' ? t.accent : t.border}`,
                                  background: editReason.mode === 'manual' ? `${t.accent}22` : t.surface2,
                                  color: editReason.mode === 'manual' ? t.accent : t.textMuted, fontWeight: 600,
                                }}>Manual text</button>
                            </div>
                            )}
                            {mobileCoupled && editReason.mode === 'tpm' ? (
                              <>
                                <select
                                  style={{ ...inp, fontSize: 12, padding: '5px 8px' }}
                                  value={editReason.lossCode}
                                  onChange={(e) => {
                                    setEditReason(p => ({ ...p, lossCode: e.target.value, detail: '' }));
                                    setReasonErr('');
                                  }}
                                >
                                  <option value="">— Select TPM loss —</option>
                                  {TPM_LOSS_CATEGORIES.map((l) => (
                                    <option key={l.code} value={l.code}>{l.code} · {l.label}</option>
                                  ))}
                                </select>
                                {(() => {
                                  const sel = TPM_LOSS_CATEGORIES.find((l) => l.code === editReason.lossCode);
                                  const opts = sel?.rootCauses || sel?.subDivisions || [];
                                  if (!opts.length) return null;
                                  return (
                                    <select
                                      style={{ ...inp, fontSize: 12, padding: '5px 8px' }}
                                      value={editReason.detail}
                                      onChange={(e) => {
                                        setEditReason(p => ({ ...p, detail: e.target.value }));
                                        setReasonErr('');
                                      }}
                                    >
                                      <option value="">— Select detail —</option>
                                      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                  );
                                })()}
                              </>
                            ) : (
                              <input autoFocus style={{ ...inp, fontSize: 12, padding: '5px 8px' }}
                                placeholder="Enter reason (manual)..."
                                value={editReason.value}
                                onChange={e => { setEditReason(p => ({ ...p, value: e.target.value })); setReasonErr(''); }}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveReason(log.id);
                                  if (e.key === 'Escape') setEditReason({ id: null, value: '', source: '', applyToStation: false, mode: 'manual', lossCode: '', detail: '' });
                                }}
                              />
                            )}
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <button disabled={saving} onClick={() => saveReason(log.id)}
                                style={{ padding: '4px 10px', background: '#10b981', color: '#fff',
                                         border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>&#10003; Save</button>
                              <button onClick={() => { setEditReason({ id: null, value: '', source: '', applyToStation: false, mode: 'manual', lossCode: '', detail: '' }); setReasonErr(''); }}
                                style={{ padding: '4px 8px', background: t.surface2, color: t.textMuted,
                                         border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>&#10005;</button>
                            </div>
                            {pairedMachines.length > 0 && (
                              <label style={{ display: 'flex', alignItems: 'center', gap: 6,
                                             cursor: 'pointer', fontSize: 11, color: t.textMuted, padding: '3px 0' }}>
                                <input type="checkbox"
                                  checked={editReason.applyToStation}
                                  onChange={e => setEditReason(p => ({ ...p, applyToStation: e.target.checked }))}
                                  style={{ accentColor: t.accent, width: 13, height: 13 }} />
                                <span>
                                  Also apply to paired machine(s):{' '}
                                  <b style={{ color: t.accent }}>
                                    {pairedMachines.map(pm => pm.name).join(', ')}
                                  </b>
                                  {' '}(same status &plusmn;2 min)
                                </span>
                              </label>
                            )}
                            {reasonErr && <span style={{ color: '#ef4444', fontSize: 11 }}>&#9888; {reasonErr}</span>}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                            onClick={() => setEditReason({
                              id: log.id,
                              value: log.deviation_reason || '',
                              source: pageTab,
                              applyToStation: false,
                              mode: 'manual',
                              lossCode: '',
                              detail: '',
                            })}>
                            {log.deviation_reason ? (
                              <>
                                <span style={{ color: '#10b981', fontSize: 12 }}>&#10003; {log.deviation_reason}</span>
                                <span style={{ fontSize: 10, color: t.accent }}>&#9998;</span>
                              </>
                            ) : log.breached ? (
                              <span style={{ color: '#ef4444', fontSize: 11, fontWeight: 600,
                                             fontStyle: 'italic', borderBottom: '1px dashed #ef4444' }}>
                                &#9888; Click to enter reason (required)
                              </span>
                            ) : (
                              <span style={{ color: t.textFaint, fontSize: 11, fontStyle: 'italic',
                                             borderBottom: `1px dashed ${t.border}` }}>
                                + Add reason (TPM or manual)
                              </span>
                            )}
                          </div>
                        )}
                      </td>

                      <td style={{ ...tdS, color: t.textFaint, fontSize: 11 }}>{log.source}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  };

  const tileTextShadow = t.id === 'techBlue' ? '0 1px 3px rgba(1, 9, 28, 0.75)' : undefined;

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader title="LOSS TRACKER"
        onRefresh={() => pageTab === 'live' ? fetchLive(machineId) : fetchHistoric()}
        extra={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => { setShowPareto(v => !v); setShowHistogram(false); }}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: showPareto ? '#f59e0b' : t.surface2,
                color: showPareto ? '#fff' : t.textMuted,
                border: `1px solid ${showPareto ? '#f59e0b' : t.border}`, fontWeight: 600,
              }}>Pareto</button>
            <button
              onClick={() => { setShowSettings(v => !v); setEditLimits(Object.fromEntries(Object.entries(limitsMin).map(([k,v]) => [k, String(v)]))); }}
              style={{
                padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: showSettings ? t.accent : t.surface2,
                color: showSettings ? '#fff' : t.textMuted,
                border: `1px solid ${showSettings ? t.accent : t.border}`, fontWeight: 600,
              }}>
              Thresholds
            </button>
            <button style={{ padding: '6px 16px', background: '#10b981', color: '#fff', border: 'none',
                             borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              onClick={() => downloadReport(pageTab === 'historic' && histLoaded ? dateTo : todayStr())}>
              ⬇ Download Excel
            </button>
          </div>
        }
      />

      {/* Threshold settings panel */}
      {showSettings && (() => {
        const LABELS = {
          idle: 'Idle', breakdown: 'Breakdown', alarm: 'Alarm',
          offline: 'Offline', setting_change: 'Setting Change'
        };
        const saveSettings = async () => {
          const validated = Object.fromEntries(
            Object.entries(editLimits).map(([k, v]) => {
              const parsed = parseThresholdInput(v);
              return [k, Math.max(0.01, parsed)];
            })
          );
          try {
            const { data } = await api.put('/api/deviation-alerts/limits', validated);
            const saved = { ...validated, ...(data || {}) };
            const numeric = Object.fromEntries(
              Object.entries(saved).map(([k, v]) => [k, Math.max(0.01, Number(v) || validated[k])])
            );
            setLimitsMin(numeric);
            setEditLimits(Object.fromEntries(Object.entries(numeric).map(([k, v]) => [k, String(v)])));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(numeric));
            setShowSettings(false);
          } catch (e) {
            const detail = e?.response?.data?.detail;
            window.alert(
              typeof detail === 'string'
                ? `Failed to save thresholds: ${detail}`
                : 'Failed to save thresholds to the server. Check you are logged in as admin/supervisor and try again — local preview was not kept as the source of truth.'
            );
          }
        };
        return (
          <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10,
                        padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h4 style={{ color: t.accent, margin: 0, fontSize: 14 }}>Threshold Configuration</h4>
              <span style={{ color: t.textFaint, fontSize: 11 }}>
                Enter as decimal minutes (e.g. <b>1.5</b>), mm:ss (e.g. <b>1:30</b>), or with units (e.g. <b>1m 28s</b>)
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              {SUMMARY_STATUSES.map(s => {
                const st = statusStyles[s];
                const parsed = parseThresholdInput(editLimits[s]);
                const isValid = !isNaN(parsed) && parsed > 0;
                return (
                  <div key={s} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }}>
                    <label style={{ fontSize: 11, fontWeight: 600, color: st.color }}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                                     background: st.color, marginRight: 5 }} />
                      {LABELS[s]}
                    </label>
                    <input
                      style={{ ...inp, width: 110, borderColor: isValid ? st.color + '88' : '#ef4444' }}
                      value={editLimits[s]}
                      placeholder="e.g. 1.5 or 1:30"
                      onChange={e => setEditLimits(p => ({ ...p, [s]: e.target.value }))}
                    />
                    <span style={{ fontSize: 10, color: isValid ? t.textFaint : '#ef4444' }}>
                      {isValid
                        ? <>= <b style={{ color: st.color }}>{formatThresholdDisplay(parsed)}</b> · current: <b style={{ color: st.color }}>{formatThresholdDisplay(limitsMin[s])}</b></>
                        : 'Invalid — use e.g. 1.5 or 1:30 or 1m 28s'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveSettings}
                style={{ padding: '7px 20px', background: t.accent, color: '#fff', border: 'none',
                         borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Save Thresholds
              </button>
              <button onClick={() => setEditLimits(Object.fromEntries(Object.entries(DEFAULT_LIMITS_MIN).map(([k,v]) => [k, String(v)])))}
                style={{ padding: '7px 16px', background: t.surface2, color: t.textMuted,
                         border: `1px solid ${t.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                Reset to Defaults
              </button>
              <button onClick={() => setShowSettings(false)}
                style={{ padding: '7px 16px', background: 'none', color: t.textFaint,
                         border: 'none', cursor: 'pointer', fontSize: 13 }}>
                Close
              </button>
            </div>
          </div>
        );
      })()}

      {/* Pareto chart */}
      {showPareto && (
        <div style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10,
                      padding: 16, marginBottom: 16 }}>
          <h4 style={{ color: t.accent, margin: '0 0 12px', fontSize: 14 }}>
            Deviation Pareto &mdash; {machineName || 'All'}
            <span style={{ fontSize: 11, color: t.textFaint, marginLeft: 8 }}>
              (breached records: total lost minutes by status)
            </span>
          </h4>
          {paretoData.length === 0 ? (
            <div style={{ color: t.textFaint, textAlign: 'center', padding: 24, fontSize: 13 }}>No breaches found.</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={paretoData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={t.border} />
                <XAxis dataKey="label" tick={{ fill: t.textDim, fontSize: 12 }} />
                <YAxis yAxisId="min" tick={{ fill: t.textDim, fontSize: 11 }}
                       label={{ value: 'Lost min', angle: -90, position: 'insideLeft', fill: t.textFaint, fontSize: 10 }} />
                <YAxis yAxisId="cnt" orientation="right" tick={{ fill: t.textDim, fontSize: 11 }}
                       label={{ value: 'Count', angle: 90, position: 'insideRight', fill: t.textFaint, fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text, borderRadius: 6 }}
                  formatter={(val, name) => name === 'Lost (min)' ? `${val} min` : `${val} events`}
                />
                <Legend wrapperStyle={{ fontSize: 12, color: t.textMuted }} />
                <Bar yAxisId="min" dataKey="totalMin" name="Lost (min)" radius={[4,4,0,0]}>
                  {paretoData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Bar>
                <Bar yAxisId="cnt" dataKey="count" name="Count" fill="#94a3b8" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}


      {/* ── Machine selector row ── */}
      <div style={{ background: t.surface, borderRadius: 10, padding: '14px 16px',
                    marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>

        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `2px solid ${t.border}` }}>
          <button style={tabBtn('live')} onClick={() => setPageTab('live')}>Live Log</button>
          <button style={tabBtn('historic')} onClick={() => setPageTab('historic')}>Historic View</button>
        </div>
        <h4 style={{ color: t.accent, margin: 0, fontSize: 14 }}>Machine Status Log</h4>

        <select style={{ ...inp, minWidth: 150 }} value={stationId} onChange={e => setStationId(e.target.value)}>
          <option value="">All Stations</option>
          {stations.map(s => <option key={s.id} value={s.id}>{s.display_name || s.name}</option>)}
        </select>

        <select style={{ ...inp, minWidth: 170 }} value={machineId}
          onChange={e => { setMachineId(e.target.value); setLiveFilter(''); setHistFilter(''); setHistLoaded(false); }}>
          <option value="">Select Machine</option>
          {stationMachines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>

        {pageTab === 'historic' && (
          <>
            <input style={{ ...inp, minWidth: 140 }} type="date" value={dateFrom}
              max={dateTo} onChange={e => setDateFrom(e.target.value)} />
            <span style={{ color: t.textDim, fontSize: 13 }}>to</span>
            <input style={{ ...inp, minWidth: 140 }} type="date" value={dateTo}
              min={dateFrom} max={todayStr()} onChange={e => setDateTo(e.target.value)} />
            <button style={{ padding: '6px 16px', background: t.accent, color: '#fff', border: 'none',
                             borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              onClick={fetchHistoric}>Load</button>
            {histLoaded && (
              <button style={{ padding: '6px 14px', background: '#10b981', color: '#fff', border: 'none',
                               borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                onClick={() => downloadReport(dateTo)}>
                ⬇ Download ({dateTo})
              </button>
            )}
          </>
        )}

        {pageTab === 'live' && machineId && (
          <button style={{ padding: '6px 14px', background: t.accent, color: '#fff', border: 'none',
                           borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
            onClick={() => fetchLive(machineId)}>Refresh</button>
        )}

        {/* Cycle Stitch toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                          fontSize: 12, color: stitchEnabled ? '#8b5cf6' : t.textMuted, fontWeight: 600 }}>
            <input type="checkbox" checked={stitchEnabled}
              onChange={e => { setStitchEnabled(e.target.checked); setLiveLog([]); setHistLog([]); setHistLoaded(false); }}
              style={{ accentColor: '#8b5cf6', width: 14, height: 14 }} />
            Merge Multi-Segment Cycles
          </label>
          {stitchEnabled && (
            <select style={{ ...inp, fontSize: 12, padding: '4px 8px', minWidth: 180,
                             borderColor: '#8b5cf6', background: '#8b5cf611' }}
              value={stitchVariant}
              onChange={e => { setStitchVariant(e.target.value); setLiveLog([]); setHistLog([]); setHistLoaded(false); }}>
              <option value="">— Select Part / Model —</option>
              {partOptions.filter(p => p.cycle_profile).map(p => (
                <option key={p.id} value={p.part_no}>
                  {p.part_no}{p.cycle_profile?.label ? ` (${p.cycle_profile.label})` : ''}
                </option>
              ))}
              {partOptions.filter(p => !p.cycle_profile).length > 0 && (
                <optgroup label="── No cycle profile ──">
                  {partOptions.filter(p => !p.cycle_profile).map(p => (
                    <option key={p.id} value={p.part_no}>{p.part_no}</option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {stitchEnabled && stitchVariant && (
            <span style={{ fontSize: 11, color: '#8b5cf6', fontStyle: 'italic' }}>
              ⊕ cycles merged per profile
            </span>
          )}
        </div>
      </div>

      {/* ── Shift Time Split + Cycle Time (always visible) ── */}
      <div className={surfaceClass(t)} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10,
                    padding: 16, marginBottom: 16 }}>

        {/* Shift tiles */}
        <h4 style={{ color: '#d669f7', margin: '0 0 12px', fontSize: 14 }}>
          SHIFT UTILIZATION BREAKDOWN
          {machineName && (
            <span style={{ color: t.accent, fontWeight: 400, fontSize: 13 }}>
              {'\u00a0\u2014\u00a0'}{machineName}
            </span>
          )}
          <span style={{ color: t.textFaint, fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
            (based on currently loaded log)
          </span>
        </h4>
        {shiftTiles.length === 0 ? (
          <div style={{ color: t.textFaint, fontSize: 12, marginBottom: 12 }}>Load a machine log to see shift breakdown.</div>
        ) : shiftTiles.map(({ shift: sh, acc, cnt, toHM, elapsedMs, shiftDurMs, dateLabel, notStarted }) => (
          <div key={sh.id} style={{ marginBottom: 14, opacity: notStarted ? 0.5 : 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: t.textDim, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>{sh.name}</span>
              <span style={{ fontWeight: 400, color: t.textFaint, fontSize: 11 }}>
                {sh.start}&nbsp;&ndash;&nbsp;{sh.end}
              </span>
              <span style={{ fontWeight: 600, color: t.accent, fontSize: 11,
                             background: t.surface2, padding: '2px 8px', borderRadius: 4 }}>
                {dateLabel}
              </span>
              {notStarted ? (
                <span style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>Not started yet</span>
              ) : (
                <span style={{ fontWeight: 400, color: t.textFaint, fontSize: 10 }}>
                  elapsed: {(() => { const m = Math.round(elapsedMs/60000); return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; })()} / {(() => { const m = Math.round(shiftDurMs/60000); return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; })()}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {tileDefs.map(({ key, label, color, bg, border, glow, colorMuted }) => {
                  const isLive = !notStarted && pageTab === 'live';
                  if (key === '_remaining' && !isLive) return null;
                  return (
                  <div
                    key={key}
                    style={{
                      flex: '1 1 128px',
                      minWidth: 128,
                      maxWidth: 180,
                      minHeight: 100,
                      padding: '12px 14px',
                      borderRadius: 10,
                      background: bg,
                      border: `1.5px solid ${border}`,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      gap: 6,
                      boxShadow: glow
                        ? `0 0 10px ${glow}, inset 0 1px 0 rgba(255,255,255,0.05)`
                        : '0 2px 6px rgba(0,0,0,0.1)',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        textShadow: tileTextShadow,
                      }}
                    >
                      {label}
                    </span>

                    <span
                      style={{
                        fontSize: 22,
                        fontWeight: 800,
                        color,
                        fontVariantNumeric: 'tabular-nums',
                        lineHeight: 1.1,
                        textShadow: tileTextShadow,
                      }}
                    >
                      {toHM(acc[key])}
                    </span>

                    {key === '_remaining' ? (
                      <span
                        style={{
                          fontSize: 10,
                          color: colorMuted,
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          textShadow: tileTextShadow,
                          lineHeight: 1.4,
                        }}
                      >
                        {toHM(elapsedMs)} / {toHM(shiftDurMs)}
                      </span>
                    ) : key !== '_unaccounted' ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: colorMuted,
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          textShadow: tileTextShadow,
                        }}
                      >
                        {cnt[key] || 0} {cnt[key] === 1 ? 'event' : 'Event'}
                      </span>
                    ) : null}
                  </div>
                  );
                })}
              </div>

          </div>
        ))}

        {/* Cycle Time toggle */}
        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 12, marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: showHistogram ? 14 : 0 }}>
            <button onClick={() => setShowHistogram(v => !v)}
              style={{
                padding: '6px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                background: showHistogram ? '#8b5cf6' : t.surface2,
                color: showHistogram ? '#fff' : t.textMuted,
                border: `1px solid ${showHistogram ? '#8b5cf6' : t.border}`, fontWeight: 600,
              }}>
              {showHistogram ? '\u25b2 Hide Cycle Time' : '\u25bc Cycle Time Analysis'}
            </button>
            {showHistogram && (
              <>
                <select style={{ ...inp, fontSize: 12, padding: '5px 10px', minWidth: 130 }}
                  value={histoStationId} onChange={e => setHistoStationId(e.target.value)}>
                  <option value="">All Stations</option>
                  {stations.map(s => <option key={s.id} value={s.id}>{s.display_name || s.name}</option>)}
                </select>
                <select style={{ ...inp, fontSize: 12, padding: '5px 10px', minWidth: 150 }}
                  value={histoMachineId} onChange={e => { setHistoMachineId(e.target.value); setHistoLog([]); }}>
                  <option value="">Select Machine</option>
                  {histoPairMachines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <input type="date" style={{ ...inp, fontSize: 12, padding: '5px 10px' }}
                  value={histoDate} max={todayStr()}
                  onChange={e => { setHistoDate(e.target.value); setHistoLog([]); }} />
                <select style={{ ...inp, fontSize: 12, padding: '5px 10px' }}
                  value={histoShift} onChange={e => setHistoShift(e.target.value)}>
                  {shifts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select style={{ ...inp, fontSize: 12, padding: '5px 10px' }}
                  value={histoHour} onChange={e => setHistoHour(e.target.value)}>
                  {shiftHourSlots.map(sl => (
                    <option key={sl.value} value={sl.value}>{sl.label}</option>
                  ))}
                </select>
                {histoLoading && <span style={{ fontSize: 12, color: t.textFaint }}>Loading...</span>}
                {!histoLoading && histoMachineId && histoLog.length > 0 && (
                  <span style={{ fontSize: 12, color: t.textDim }}>
                    <b style={{ color: histoColors.running.legend }}>Avg Run: {bellData.runAvg}s</b>
                    {' · '}
                    <b style={{ color: histoColors.ldUnld.legend }}>Avg Ld/UnLd: {bellData.ldAvg}s</b>
                    {' · '}
                    <b style={{ color: histoColors.idle.legend }}>Avg Idle: {bellData.idleAvg}s</b>
                    {bellData.ctSec > 0 && (
                      <>
                        {' · '}
                        <span style={{ color: t.textFaint, fontSize: 11 }}>
                          CT: {bellData.ctSec}s · threshold: ≥{Math.round(bellData.ctSec * (bellData.threshPct / 100))}s ({bellData.threshPct}%)
                        </span>
                      </>
                    )}
                  </span>
                )}
              </>
            )}
          </div>
          {showHistogram && (
            !histoMachineId ? (
              <div style={{ color: t.textFaint, textAlign: 'center', padding: 28, fontSize: 13 }}>
                Select a station and machine to view the cycle time histogram.
              </div>
            ) : histoLoading ? (
              <div style={{ color: t.textFaint, textAlign: 'center', padding: 28, fontSize: 13 }}>Loading...</div>
            ) : bellData.notStarted ? (
              <div style={{ color: '#f59e0b', textAlign: 'center', padding: 28, fontSize: 13, fontWeight: 600 }}>
                ⏳ {shifts.find(s => s.id === histoShift)?.name} has not started yet on {histoDate}.
                <div style={{ fontSize: 11, color: t.textFaint, fontWeight: 400, marginTop: 4 }}>
                  Shift starts at {shifts.find(s => s.id === histoShift)?.start}. Select a past date to view historic data.
                </div>
              </div>
            ) : bellData.bars.length === 0 || bellData.bars.every(b => b.running === 0 && b.ldUnld === 0 && b.idle === 0) ? (
              <div style={{ color: t.textFaint, textAlign: 'center', padding: 28, fontSize: 13 }}>
                No data for {shifts.find(s => s.id === histoShift)?.name} on {histoDate}.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: t.textFaint, marginBottom: 8 }}>
                  {shifts.find(s => s.id === histoShift)?.name}{' '}
                  ({shifts.find(s => s.id === histoShift)?.start}&ndash;{shifts.find(s => s.id === histoShift)?.end})
                  &nbsp;&middot;&nbsp;X: hourly slots (IST) &middot; Y: cycle count
                  &nbsp;&middot;&nbsp;<span style={{ color: '#8b5cf6', fontWeight: 600 }}>highlighted:</span>{' '}
                  {shiftHourSlots.find(s => s.value === histoHour)?.label}
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={bellData.bars} margin={{ top: 8, right: 20, left: 0, bottom: 30 }}
                    barCategoryGap="20%" barGap={1}>
                    <defs>
                      <linearGradient id={`loss-histo-${t.id}-running`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={histoColors.running.top} />
                        <stop offset="100%" stopColor={histoColors.running.bottom} />
                      </linearGradient>
                      <linearGradient id={`loss-histo-${t.id}-running-sel`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={histoColors.running.selTop} />
                        <stop offset="100%" stopColor={histoColors.running.selBottom} />
                      </linearGradient>
                      <linearGradient id={`loss-histo-${t.id}-ld`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={histoColors.ldUnld.top} />
                        <stop offset="100%" stopColor={histoColors.ldUnld.bottom} />
                      </linearGradient>
                      <linearGradient id={`loss-histo-${t.id}-ld-sel`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={histoColors.ldUnld.selTop} />
                        <stop offset="100%" stopColor={histoColors.ldUnld.selBottom} />
                      </linearGradient>
                      <linearGradient id={`loss-histo-${t.id}-idle`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={histoColors.idle.top} />
                        <stop offset="100%" stopColor={histoColors.idle.bottom} />
                      </linearGradient>
                      <linearGradient id={`loss-histo-${t.id}-idle-sel`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={histoColors.idle.selTop} />
                        <stop offset="100%" stopColor={histoColors.idle.selBottom} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={histoColors.grid} />
                    <XAxis dataKey="slot" tick={{ fill: t.textDim, fontSize: 10 }}
                      angle={-35} textAnchor="end" interval={0}
                      label={{ value: 'Hour Slot (IST)', position: 'insideBottom', offset: -18,
                               fill: t.textFaint, fontSize: 11 }} />
                    <YAxis tick={{ fill: t.textDim, fontSize: 11 }}
                      label={{ value: 'Cycle Count', angle: -90, position: 'insideLeft',
                               fill: t.textFaint, fontSize: 10, dy: 40 }} />
                    <Tooltip
                      contentStyle={{ background: t.surface, border: `1px solid ${t.border}`,
                                      color: t.text, borderRadius: 6, fontSize: 12 }}
                      formatter={(val, name, props) => {
                        const p = props.payload;
                        const avgMap = { 'Running': p.runAvg, 'Ld/UnLd': p.ldAvg, 'Idle': p.idleAvg };
                        const a = avgMap[name];
                        return [`${val} cycles${a ? ` (avg ${a}s)` : ''}`, name];
                      }}
                    />
                    <Legend verticalAlign="top" wrapperStyle={{ fontSize: 12, paddingBottom: 4 }}
                      formatter={(value) => {
                        const colors = {
                          'Running': histoColors.running.legend,
                          'Ld/UnLd': histoColors.ldUnld.legend,
                          'Idle': histoColors.idle.legend,
                        };
                        return <span style={{ color: colors[value] || t.text }}>{value}</span>;
                      }}
                    />
                    <Bar dataKey="running" name="Running" radius={[4, 4, 0, 0]}
                      fill={`url(#loss-histo-${t.id}-running)`} legendType="square">
                      {bellData.bars.map((b, i) => (
                        <Cell key={i}
                          fill={b.isSelected
                            ? `url(#loss-histo-${t.id}-running-sel)`
                            : `url(#loss-histo-${t.id}-running)`}
                          fillOpacity={b.isSelected ? 1 : histoColors.dimOpacity}
                          stroke={b.isSelected ? histoColors.running.selTop : 'none'}
                          strokeWidth={b.isSelected ? 1 : 0}
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="ldUnld" name="Ld/UnLd" radius={[4, 4, 0, 0]}
                      fill={`url(#loss-histo-${t.id}-ld)`} legendType="square">
                      {bellData.bars.map((b, i) => (
                        <Cell key={i}
                          fill={b.isSelected
                            ? `url(#loss-histo-${t.id}-ld-sel)`
                            : `url(#loss-histo-${t.id}-ld)`}
                          fillOpacity={b.isSelected ? 1 : histoColors.dimOpacity}
                          stroke={b.isSelected ? histoColors.ldUnld.selTop : 'none'}
                          strokeWidth={b.isSelected ? 1 : 0}
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="idle" name="Idle" radius={[4, 4, 0, 0]}
                      fill={`url(#loss-histo-${t.id}-idle)`} legendType="square">
                      {bellData.bars.map((b, i) => (
                        <Cell key={i}
                          fill={b.isSelected
                            ? `url(#loss-histo-${t.id}-idle-sel)`
                            : `url(#loss-histo-${t.id}-idle)`}
                          fillOpacity={b.isSelected ? 1 : histoColors.dimOpacity}
                          stroke={b.isSelected ? histoColors.idle.selTop : 'none'}
                          strokeWidth={b.isSelected ? 1 : 0}
                        />
                      ))}
                    </Bar>
                    {(() => {
                      const sel = bellData.bars.find(b => b.isSelected);
                      if (!sel) return null;
                      const isCurrentHour = histoDate === todayStr() &&
                        parseInt(histoHour?.split('-')[0]) === new Date().getHours();
                      return (
                        <ReferenceLine x={sel.slot}
                          stroke={isCurrentHour ? '#facc15' : '#60a5fa'}
                          strokeWidth={isCurrentHour ? 2.5 : 2}
                          strokeDasharray={isCurrentHour ? '0' : '4 2'}
                          label={{
                            value: isCurrentHour ? `▶ Now` : sel.slot,
                            fill:  isCurrentHour ? '#facc15' : '#60a5fa',
                            fontSize: 10, position: 'top',
                          }}
                        />
                      );
                    })()}
                  </BarChart>
                </ResponsiveContainer>

                {/* ── Hourly Distribution Table ── */}
                {(() => {
                  const sh = shifts.find(s => s.id === histoShift);
                  const ROWS = [
                    { key: 'running', label: 'Running', color: histoColors.running.legend, dataKey: 'running', bg: histoColors.running.tableBg },
                    { key: 'ldUnld',  label: 'Ld/UnLd', color: histoColors.ldUnld.legend, dataKey: 'ldUnld', bg: histoColors.ldUnld.tableBg },
                    { key: 'idle',    label: 'Idle',    color: histoColors.idle.legend, dataKey: 'idle', bg: histoColors.idle.tableBg },
                  ];
                  const thCell = (content, extra = {}) => ({
                    padding: '7px 10px', background: t.surface2,
                    color: t.textMuted, fontSize: 11, fontWeight: 700,
                    textAlign: 'center', whiteSpace: 'nowrap',
                    borderBottom: `2px solid ${t.border}`,
                    borderRight: `1px solid ${t.border}`, ...extra,
                  });
                  const tdCell = (bg, extra = {}) => ({
                    padding: '6px 10px', textAlign: 'center', fontSize: 12,
                    borderBottom: `1px solid ${t.border}`,
                    borderRight: `1px solid ${t.border}`,
                    background: bg, ...extra,
                  });
                  return (
                    <div style={{ marginTop: 16, overflowX: 'auto' }}>
                      <div style={{ fontSize: 11, color: t.textDim, marginBottom: 6, fontWeight: 600 }}>
                        {sh?.name} Hourly Distribution
                        <span style={{ color: t.textFaint, fontWeight: 400, marginLeft: 8 }}>
                          ({sh?.start}–{sh?.end}) · cycle counts per hour slot
                        </span>
                      </div>
                      <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%',
                                      border: `1px solid ${t.border}`, borderRadius: 6, overflow: 'hidden' }}>
                        <thead>
                          <tr>
                            <th style={thCell('State', { textAlign: 'left', minWidth: 80 })}>State</th>
                            {bellData.bars.map((b, i) => (
                              <th key={i} style={thCell(b.slot, {
                                background: b.isSelected ? '#8b5cf622' : t.surface2,
                                color: b.isSelected ? '#8b5cf6' : t.textMuted,
                                borderBottom: b.isSelected ? '2px solid #8b5cf6' : `2px solid ${t.border}`,
                              })}>{b.slot}</th>
                            ))}
                            <th style={thCell('Total', {
                              background: '#00B0F015', color: '#38bdf8',
                              borderLeft: `2px solid #38bdf844`,
                            })}>Shift Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ROWS.map(({ label, color, dataKey, bg }) => {
                            const total = bellData.bars.reduce((s, b) => s + (b[dataKey] || 0), 0);
                            const rowBg = bg || `${color}18`;
                            return (
                              <tr key={dataKey}>
                                <td style={{ ...tdCell(rowBg), textAlign: 'left', fontWeight: 700,
                                             color, borderLeft: `3px solid ${color}` }}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%',
                                                   background: color, flexShrink: 0,
                                                   boxShadow: `0 0 6px ${color}88` }} />
                                    {label}
                                  </span>
                                </td>
                                {bellData.bars.map((b, i) => (
                                  <td key={i} style={tdCell(
                                    b.isSelected ? bg || `${color}28` : rowBg,
                                    { color: b[dataKey] > 0 ? t.text : t.textFaint,
                                      fontWeight: b.isSelected ? 700 : 400 }
                                  )}>
                                    {b[dataKey]}
                                  </td>
                                ))}
                                <td style={{ ...tdCell('#00B0F010'), fontWeight: 700,
                                             color: '#38bdf8', borderLeft: `2px solid #38bdf844` }}>
                                  {total}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </>
            )
          )}
        </div>
      </div>

      {/* Page tabs */}
      {/* <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `2px solid ${t.border}` }}>
        <button style={tabBtn('live')} onClick={() => setPageTab('live')}>Live Log</button>
        <button style={tabBtn('historic')} onClick={() => setPageTab('historic')}>Historic View</button>
      </div> */}

      <div style={card}>
        {!machineId ? (
          <div style={{ color: t.textFaint, textAlign: 'center', padding: 40, fontSize: 13 }}>
            Select a station and machine to view loss tracking data.
          </div>
        ) : pageTab === 'live' ? (
          renderTable(liveLog, liveFilter, setLiveFilter, liveMode, setLiveMode, false)
        ) : (
          !histLoaded ? (
            <div style={{ color: t.textFaint, textAlign: 'center', padding: 40, fontSize: 13 }}>
              Select a date range and click <b>Load</b> to view historic records.
            </div>
          ) : (
            renderTable(histLog, histFilter, setHistFilter, histMode, setHistMode, true)
          )
        )}
      </div>
    </div>
  );
}
