import { useState, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { useConfig, getCurrentShift, timeToMinutes, isMobileIntegrationEnabled, isManualDataEntryEnabled } from '../context/ConfigContext';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { parseCtSeconds, sumCt, formatCtSeconds, isValidDecimalInput } from '../utils/cycleTime';
import { planModelVariant } from '../utils/partVariant';
import { DRAFT_KEYS } from '../utils/formPersistence';
import usePersistedState from '../hooks/usePersistedState';


const today = () => new Date().toISOString().slice(0, 10);

function buildInit(shiftId, breakDefaults) {
  return {
    entry_date: today(),
    station_no: 1, machine_id: '', shift: shiftId || 'A',
    plan_id: '',
    current_operation: '', next_operation: '', model_variant: '',
    process_time: '', loading_unloading: '',
    start_time: '', stop_time: '', total_minutes: '',
    lunch_break: breakDefaults?.lunch_break ?? 0,
    tea_break: breakDefaults?.tea_break ?? 0,
    tpm_cleaning: breakDefaults?.tpm_cleaning ?? 0,
    other_cleaning: breakDefaults?.other_cleaning ?? 0,
    management_meeting: breakDefaults?.management_meeting ?? 0,
    no_load: 0, new_model_trial: 0, power_cut: 0, planned_maintenance: 0, no_manpower_planned: 0,
    setting_time: 0, tool_change: 0, dimension_correction: 0, scrap_removal: 0, break_down: 0,
    actual_qty: '', defect_qty: 0
  };
}

function calcPreview(f) {
  const ct = sumCt(f.process_time, f.loading_unloading);
  const totalBreaks = ['lunch_break','tea_break','tpm_cleaning','other_cleaning','management_meeting']
    .reduce((s, k) => s + (parseInt(f[k]) || 0), 0);
  const shiftWorking = (parseInt(f.total_minutes) || 0) - totalBreaks;
  const mgmtLoss = ['no_load','new_model_trial','power_cut','planned_maintenance','no_manpower_planned']
    .reduce((s, k) => s + (parseInt(f[k]) || 0), 0);
  const available = shiftWorking - mgmtLoss;
  const totalDown = ['setting_time','tool_change','dimension_correction','scrap_removal','break_down']
    .reduce((s, k) => s + (parseInt(f[k]) || 0), 0);
  const operating = available - totalDown;
  const possible = ct > 0 ? Math.floor((operating * 60) / ct) : 0;
  const actual = parseInt(f.actual_qty) || 0;
  const defect = parseInt(f.defect_qty) || 0;
  const accp = Math.max(0, actual - defect);
  const productionLoss = Math.max(0, possible - actual);
  const ar = available > 0 && shiftWorking > 0 ? +(operating / available * 100).toFixed(2) : 0;
  const pr = possible > 0 ? +(actual / possible * 100).toFixed(2) : 0;
  const qr = actual > 0 ? +(accp / actual * 100).toFixed(2) : 0;
  const oee = +((ar * pr * qr) / 10000).toFixed(2);
  return { ct, totalBreaks, shiftWorking, mgmtLoss, available, totalDown, operating, possible, accp, productionLoss, ar, pr, qr, oee };
}

function planFieldsFromPlan(plan, parts = []) {
  if (!plan) return { plan_id: '' };
  return {
    plan_id: String(plan.id),
    model_variant: planModelVariant(plan, parts),
    process_time: plan.process_time != null && plan.process_time !== '' ? String(plan.process_time) : '',
    loading_unloading: plan.loading_unloading != null && plan.loading_unloading !== ''
      ? String(plan.loading_unloading)
      : '',
    current_operation: plan.current_operation || '',
    next_operation: plan.next_operation || '',
  };
}

function pickBestPlan(plans, machineId) {
  let list = (plans || []).filter((p) => p.status !== 'cancelled');
  if (machineId) {
    const mid = parseInt(machineId, 10);
    const matched = list.filter((p) => p.machine_id === mid || p.machine_id == null);
    if (matched.length) list = matched;
  }
  const byPriority = [...list].sort((a, b) => (a.priority || 99) - (b.priority || 99));
  return byPriority.find((p) => p.status === 'running')
    || byPriority.find((p) => p.status === 'pending')
    || byPriority.find((p) => p.status === 'paused')
    || byPriority[0]
    || null;
}

export default function DataEntry() {
  const { user } = useAuth();
  const { canAccess } = useFeatureFlags();
  const { config } = useConfig();
  const mobileCoupled = isMobileIntegrationEnabled(config);
  const manualEntry = isManualDataEntryEnabled(config);
  const currentShift = useMemo(() => getCurrentShift(config), [config]);

  const [activeShift, setActiveShift] = useState(currentShift || config.shifts.find(s => s.enabled));
  const [form, setForm, { resetPersisted }] = usePersistedState(
    DRAFT_KEYS.dataEntry,
    () => buildInit(
      (currentShift || config.shifts.find(s => s.enabled))?.id,
      config.breaks[(currentShift || config.shifts.find(s => s.enabled))?.id],
    ),
  );
  const [stations, setStations] = useState([]);
  const [machines, setMachines] = useState([]);
  const [plansForEntry, setPlansForEntry] = useState([]);
  const [partsMaster, setPartsMaster] = useState([]);
  const [msg, setMsg] = useState('');
  const [alerts, setAlerts] = useState([]);
  const [mcAutoMinutes, setMcAutoMinutes] = useState(0);
  const [mobileLossSync, setMobileLossSync] = useState(null); // { count, totalDown, syncedAt }
  const [lossSyncTick, setLossSyncTick] = useState(0);
  const [includeOperations, setIncludeOperations] = useState(true);

  const stationMachines = useMemo(
    () => machines.filter(m => m.station_id === parseInt(form.station_no, 10)),
    [machines, form.station_no]
  );

  const getStationLabel = (stationId) => {
    const station = stations.find(s => s.id === parseInt(stationId));
    return station ? (station.display_name || station.name) : String(stationId);
  };

  const downloadExcel = async () => {
    try {
      const selectedDate = form.entry_date;
      const monthStart = selectedDate.slice(0, 8) + '01'; // YYYY-MM-01

      // Prefer live capture; fall back to data-entry rows (same as backend reports)
      const [dayRes, monthRes, dayRt, monthRt] = await Promise.all([
        api.get('/api/oee/', { params: { entry_date: selectedDate } }),
        api.get('/api/oee/', { params: { date_from: monthStart, date_to: selectedDate } }),
        api.get('/api/oee/realtime', { params: { entry_date: selectedDate } }).catch(() => ({ data: [] })),
        api.get('/api/oee/realtime', { params: { date_from: monthStart, date_to: selectedDate } }).catch(() => ({ data: [] })),
      ]);

      const mergeLiveFirst = (manualList, liveList) => {
        const map = new Map();
        (Array.isArray(manualList) ? manualList : []).forEach((e) => {
          map.set(`${e.machine_id}_${e.shift}_${e.entry_date}`, { ...e, source: e.source || 'manual' });
        });
        (Array.isArray(liveList) ? liveList : []).forEach((e) => {
          map.set(`${e.machine_id}_${e.shift}_${e.entry_date}`, { ...e, source: 'realtime' });
        });
        return Array.from(map.values());
      };

      const dayEntries = mergeLiveFirst(dayRes.data, dayRt.data);
      const monthEntries = mergeLiveFirst(monthRes.data, monthRt.data);

      if (!dayEntries.length && !monthEntries.length) {
        setMsg('✗ No live or data-entry records found for this date or month'); return;
      }

      const toRow = e => ({
        'Date': e.entry_date,
        'Station': e.station_name || getStationLabel(e.station_no),
        'Machine': e.machine_name || '',
        'Shift': e.shift,
        'Work Order': e.work_order_no || '',
        'Model / Variant': e.model_variant || '',
        'Current Operation': e.current_operation, 'Next Operation': e.next_operation,
        'Process Time (s)': e.process_time, 'L&U (s)': e.loading_unloading,
        'CT (s)': sumCt(e.process_time, e.loading_unloading),
        'Start Time': e.start_time || '', 'Stop Time': e.stop_time || '', 'Total Minutes': e.total_minutes || 0,
        'Lunch Break': e.lunch_break || 0, 'Tea Break': e.tea_break || 0,
        'TPM Cleaning': e.tpm_cleaning || 0, 'Other Cleaning': e.other_cleaning || 0, 'Mgmt Meeting': e.management_meeting || 0,
        'Total Breaks': e.total_breaks || 0, 'Shift Working Min': e.shift_working_minutes || 0,
        'No Load': e.no_load || 0, 'New Model Trial': e.new_model_trial || 0, 'Power Cut': e.power_cut || 0,
        'Planned Maintenance': e.planned_maintenance || 0, 'No Manpower': e.no_manpower_planned || 0,
        'Mgmt Loss Total': e.management_loss_total || 0, 'Available Time (min)': e.available_shift_time,
        'Setting Time': e.setting_time || 0, 'Tool Change': e.tool_change || 0,
        'Dim Correction': e.dimension_correction || 0, 'Scrap Removal': e.scrap_removal || 0, 'Break Down': e.break_down || 0,
        'Total Down Time': e.total_down_time || 0, 'Operating Time (min)': e.operating_time,
        'Plan Qty': e.planned_qty ?? '',
        'Possible Qty': e.possible_qty, 'Actual Qty': e.actual_qty,
        'Prod Loss': Math.max(0, (e.possible_qty || 0) - (e.actual_qty || 0)),
        'Accepted Qty': e.accp_qty, 'Defect Qty': e.defect_qty || 0,
        'AR%': parseFloat(e.ar || 0).toFixed(2),
        'PR%': parseFloat(e.pr || 0).toFixed(2),
        'QR%': parseFloat(e.qr || 0).toFixed(2),
        'OEE%': parseFloat(e.oee || 0).toFixed(2),
        'Source': e.source === 'realtime' ? 'Live' : 'Data Entry',
      });

      const wb = XLSX.utils.book_new();

      // Per-shift sheets for selected date only
      if (dayEntries.length) {
        const shifts = [...new Set(dayEntries.map(e => e.shift))].sort();
        shifts.forEach(sh => {
          const shiftRows = dayEntries.filter(e => e.shift === sh).map(toRow);
          XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shiftRows), `Shift ${sh} — ${selectedDate}`);
        });
      }

      // Monthly consolidated sheet — 01st of month to selected date, all shifts
      const monthLabel = new Date(selectedDate + 'T00:00:00')
        .toLocaleString('en-GB', { month: 'short', year: 'numeric' });
      const sortedMonth = [...monthEntries].sort((a, b) =>
        String(a.entry_date).localeCompare(String(b.entry_date)) ||
        String(a.shift).localeCompare(String(b.shift)) ||
        String(a.station_no).localeCompare(String(b.station_no))
      );
      const monthSheet = XLSX.utils.json_to_sheet(sortedMonth.map(toRow));
      XLSX.utils.book_append_sheet(wb, monthSheet, `Monthly — ${monthLabel}`);

      XLSX.writeFile(wb, `data_entry_${monthStart}_to_${selectedDate}.xlsx`);
      const shifts = [...new Set(dayEntries.map(e => e.shift))].sort();
      setMsg(`✓ Downloaded: Shift ${shifts.join(', ') || '—'} (${selectedDate}) + Monthly (${monthStart} → ${selectedDate})`);
      setTimeout(() => setMsg(''), 4000);
    } catch (err) {
      setMsg('✗ ' + (err.response?.data?.detail || err.message || 'Failed to download report'));
    }
  };

  useEffect(() => {
    api.get('/api/stations/').then(r => {
      setStations(r.data);
      if (r.data.length > 0) {
        setForm((prev) => ({ ...prev, station_no: prev.station_no || r.data[0].id }));
      }
    }).catch(() => {});
    api.get('/api/machines/').then(r => setMachines(r.data)).catch(() => {});
    api.get('/api/parts/options', { params: { active_only: true, limit: 500 } })
      .then((r) => setPartsMaster(r.data))
      .catch(() => setPartsMaster([]));
  }, []);

  // Fetch approved model change minutes (badge + setting when no machine selected yet)
  useEffect(() => {
    if (!form.entry_date || !form.shift || !form.station_no) return;
    api.get('/api/model-change/approved', {
      params: { entry_date: form.entry_date, shift: form.shift, station_id: form.station_no }
    }).then(r => {
      const mins = r.data.total_minutes || 0;
      setMcAutoMinutes(mins);
      if (!form.machine_id) {
        setForm(prev => ({ ...prev, setting_time: mins }));
      }
    }).catch(() => {});
  }, [form.entry_date, form.shift, form.station_no, form.machine_id]);

  // Optional: prefill from tablet/mobile loss logs only when mobile integration is ON and losses exist
  useEffect(() => {
    if (!mobileCoupled) {
      setMobileLossSync(null);
      return undefined;
    }
    if (!form.entry_date || !form.shift || !form.machine_id) {
      setMobileLossSync(null);
      return undefined;
    }
    let cancelled = false;
    const applyRollup = () => {
      api.get('/api/mobile/losses/oee-rollup', {
        params: {
          machine_id: form.machine_id,
          entry_date: form.entry_date,
          shift: form.shift,
        },
      }).then((r) => {
        if (cancelled) return;
        const fields = r.data?.fields || {};
        const count = r.data?.count || 0;
        const mcrMins = r.data?.model_change_setting_minutes || 0;
        if (mcrMins > 0) setMcAutoMinutes(mcrMins);

        // No mobile/tablet losses → do not touch Data Entry fields (web-only sites)
        if (count === 0) {
          setMobileLossSync(null);
          if (mcrMins > 0) {
            setForm((prev) => ({ ...prev, setting_time: mcrMins }));
          }
          return;
        }

        setMobileLossSync({
          count,
          totalDown: r.data?.total_down_time || 0,
          mgmt: r.data?.management_loss_total || 0,
          breaks: r.data?.total_breaks || 0,
          syncedAt: new Date().toLocaleTimeString(),
        });
        setForm((prev) => {
          const next = { ...prev };
          const breakKeys = ['lunch_break', 'tea_break', 'tpm_cleaning', 'other_cleaning', 'management_meeting'];
          const mgmtKeys = ['no_load', 'new_model_trial', 'power_cut', 'planned_maintenance', 'no_manpower_planned'];
          const downKeys = ['tool_change', 'dimension_correction', 'scrap_removal', 'break_down'];
          // Only overwrite a field when the rollup has a positive value (never wipe web entry with zeros)
          breakKeys.forEach((k) => {
            if ((fields[k] || 0) > 0) next[k] = fields[k];
          });
          mgmtKeys.forEach((k) => {
            if ((fields[k] || 0) > 0) next[k] = fields[k];
          });
          downKeys.forEach((k) => {
            if ((fields[k] || 0) > 0) next[k] = fields[k];
          });
          if (mcrMins > 0) {
            next.setting_time = mcrMins;
          } else if ((fields.setting_time || 0) > 0) {
            next.setting_time = fields.setting_time;
          }
          return next;
        });
      }).catch(() => {
        // Mobile API unavailable / unused — leave web form as-is
        if (!cancelled) setMobileLossSync(null);
      });
    };
    applyRollup();
    return () => { cancelled = true; };
  }, [mobileCoupled, form.entry_date, form.shift, form.machine_id, lossSyncTick]);

  // Load production plan for selected date / shift / station and auto-fill part details
  useEffect(() => {
    if (!form.entry_date || !form.shift || !form.station_no) {
      setPlansForEntry([]);
      return undefined;
    }
    let cancelled = false;
    api.get('/api/plans/', {
      params: {
        plan_date: form.entry_date,
        shift: form.shift,
        station_no: form.station_no,
      },
    }).then((r) => {
      if (cancelled) return;
      const all = (r.data || []).filter((p) => p.status !== 'cancelled');
      setPlansForEntry(all);
      const best = pickBestPlan(all, form.machine_id);
      if (best) {
        setForm((prev) => ({ ...prev, ...planFieldsFromPlan(best, partsMaster) }));
      } else {
        setForm((prev) => ({
          ...prev,
          plan_id: '',
          model_variant: '',
          process_time: '',
          loading_unloading: '',
        }));
      }
    }).catch(() => {
      if (!cancelled) setPlansForEntry([]);
    });
    return () => { cancelled = true; };
  }, [form.entry_date, form.shift, form.station_no, form.machine_id, partsMaster]);

  const preview = calcPreview(form);
  const { theme: t } = useTheme();
  const s = getStyles(t);

  // Missing-shift alerts — only when Manual data entry is enabled
  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    if (!manualEntry) {
      setAlerts([]);
      return;
    }
    const checkMissing = async () => {
      const newAlerts = [];
      
      const enabledShifts = config.shifts.filter(s => s.enabled);
      const currentShiftIndex = enabledShifts.findIndex(s => s.id === currentShift?.id);
      
      if (currentShiftIndex === -1) return;
      
      // Determine which shift to check and which date to start from
      let previousShift, startDate;
      
      if (currentShiftIndex === 0) {
        // Current is first shift (A): check previous shift (B/C) from yesterday
        previousShift = enabledShifts[enabledShifts.length - 1];
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        startDate = yesterday;
      } else {
        // Current is not first shift (B/C): check previous shift from today
        previousShift = enabledShifts[currentShiftIndex - 1];
        startDate = new Date();
      }
      
      // Check N days back for previous shift data
      const daysToCheck = config.checkDataDaysBack || 1;
      let foundData = false;
      
      for (let i = 0; i < daysToCheck; i++) {
        const checkDate = new Date(startDate);
        checkDate.setDate(checkDate.getDate() - i);
        const dateStr = checkDate.toISOString().slice(0, 10);
        
        try {
          const res = await api.get('/api/oee/', { params: { entry_date: dateStr, shift: previousShift.id } });
          if (res.data && res.data.length > 0) {
            foundData = true;
            break;
          }
        } catch { /* ignore */ }
      }
      
      if (!foundData) {
        const dateLabel = startDate.toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' });
        newAlerts.push(`⚠ ${previousShift.name} data is not updated for ${dateLabel}`);
      }
      
      setAlerts(newAlerts);
    };
    checkMissing();
  }, [config.shifts, config.checkDataDaysBack, currentShift, manualEntry]);

  // When shift changes, update break defaults but keep user-modified values if they differ
  const handleShiftChange = (shiftId) => {
    const sh = config.shifts.find(s => s.id === shiftId);
    const defaults = config.breaks[shiftId] || {};
    setActiveShift(sh);
    setForm(prev => ({
      ...prev,
      shift: shiftId,
      start_time: sh?.start || '',
      stop_time: sh?.end || '',
      total_minutes: sh ? timeToMinutes(sh.start, sh.end) : '',
      lunch_break: defaults.lunch_break ?? 0,
      tea_break: defaults.tea_break ?? 0,
      tpm_cleaning: defaults.tpm_cleaning ?? 0,
      other_cleaning: defaults.other_cleaning ?? 0,
      management_meeting: defaults.management_meeting ?? 0,
    }));
  };

  // Auto-populate start/stop/total when shift is first loaded
  useEffect(() => {
    if (activeShift && !form.start_time) {
      setForm(prev => ({
        ...prev,
        start_time: activeShift.start,
        stop_time: activeShift.end,
        total_minutes: timeToMinutes(activeShift.start, activeShift.end),
      }));
    }
  }, []);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const setNonNeg = (k, v) => {
    const num = parseInt(v);
    set(k, isNaN(num) ? 0 : Math.max(0, num));
  };

  const setDecimal = (k, v) => {
    if (isValidDecimalInput(v)) set(k, v);
  };

  const handleTimeChange = (k, v) => {
    const updated = { ...form, [k]: v };
    const mins = timeToMinutes(updated.start_time, updated.stop_time);
    setForm({ ...updated, total_minutes: mins || '' });
  };

  // A shift is enterable when:
  // 1. The selected date is a past date (always allow backdated entry)
  // 2. The selected shift is the currently running shift
  // 3. The selected shift has already ended today (current time >= shift end)
  const isShiftEnabled = (shiftId, entryDate) => {
    const todayDate = today();
    // Past date — always allow
    if (entryDate && entryDate < todayDate) return true;
    // Future date — never allow
    if (entryDate && entryDate > todayDate) return false;

    // Today: check time-based rules
    const sh = config.shifts.find(s => s.id === shiftId);
    if (!sh) return true;

    // Currently running shift — always allow
    if (currentShift?.id === shiftId) return true;

    // Check if this shift has already ended
    const now = new Date();
    const hhmm = now.getHours() * 60 + now.getMinutes();
    const [eH, eM] = sh.end.split(':').map(Number);
    const [sH, sM] = sh.start.split(':').map(Number);
    const shiftEnd = eH * 60 + eM;
    const shiftStart = sH * 60 + sM;

    // Overnight shift: ends next day (end < start)
    if (shiftEnd <= shiftStart) {
      // Shift spans midnight — ended if current time is past end (and before start)
      return hhmm >= shiftEnd && hhmm < shiftStart;
    }
    // Normal shift: ended if current time >= shift end
    return hhmm >= shiftEnd;
  };

  const shiftEntryOpen = isShiftEnabled(form.shift, form.entry_date);
  const entryEnabled = manualEntry && shiftEntryOpen;
  const canSubmit = canAccess('capability.edit_data_entry', user?.role);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!canSubmit) {
      setMsg('✗ View-only — your role cannot submit data entry');
      return;
    }
    if (!manualEntry) {
      setMsg('✗ Manual data entry is disabled — switch to Manual mode in Configuration');
      return;
    }
    if (!shiftEntryOpen) { setMsg('✗ Data entry not yet enabled for this shift'); return; }
    try {
      // Only send OEECreate schema fields — backend computes accp_qty and all derived values
      const payload = {
        ...form,
        machine_id: form.machine_id === '' ? null : parseInt(form.machine_id, 10),
        current_operation: includeOperations ? (form.current_operation || '') : '',
        next_operation: includeOperations ? (form.next_operation || '') : '',
        model_variant: form.model_variant?.trim() || null,
        total_minutes: parseInt(form.total_minutes) || 0,
        process_time: parseCtSeconds(form.process_time),
        loading_unloading: parseCtSeconds(form.loading_unloading),
        actual_qty: parseInt(form.actual_qty) || 0,
      };
      await api.post('/api/oee/', payload);
      setMsg('✓ Entry saved successfully');
      setTimeout(() => setMsg(''), 3000);
      const defaults = config.breaks[form.shift] || {};
      const currentStation = form.station_no;
      const currentShiftVal = form.shift;
      const currentMachine = form.machine_id;
      resetPersisted({
        ...buildInit(currentShiftVal, defaults),
        station_no: currentStation,
        machine_id: currentMachine,
      });
    } catch (err) {
      setMsg('✗ ' + (err.response?.data?.detail || 'Error saving entry'));
    }
  };

  const enabledShifts = config.shifts.filter(s => s.enabled);

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader title="PRODUCTION DATA ENTRY"
        extra={
          <button style={s.dlBtn} onClick={downloadExcel}>⬇ Download Shift Report</button>
        }
      />

      {/* Shift alerts */}
      {alerts.map((a, i) => (
        <div key={i} style={s.alert}>⚠ {a}</div>
      ))}

      {!manualEntry && (
        <div style={s.warnBanner}>
          Auto capturing is active — production data comes from live machine status.
          Manual Data Entry is disabled. To enter shifts by hand, open Configuration → Data Capture Mode → Manual data entry.
        </div>
      )}

      {manualEntry && !shiftEntryOpen && (
        <div style={s.warnBanner}>
          ⏳ Data entry for Shift {form.shift} is not yet enabled. It will be available once the shift ends.
        </div>
      )}

      {msg && <p style={{ color: msg.startsWith('✓') ? '#10b981' : '#ef4444', marginBottom: 12, fontSize: 13 }}>{msg}</p>}

      {form.machine_id && mobileLossSync?.count > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px', borderRadius: 8,
          background: t.surface2 || 'rgba(16,185,129,0.08)',
          border: `1px solid ${t.border || '#10b98155'}`,
          fontSize: 13, color: t.textDim || '#94a3b8',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{ color: '#10b981', fontWeight: 700 }}>Mobile loss sync</span>
          <span>
            {mobileLossSync.count} log(s) → downtime {mobileLossSync.totalDown}m
            {mobileLossSync.mgmt ? ` · mgmt ${mobileLossSync.mgmt}m` : ''}
            {mcAutoMinutes > 0 ? ` · setting from Model Change ${mcAutoMinutes}m (no double-count)` : ''}
            {mobileLossSync.syncedAt ? ` · ${mobileLossSync.syncedAt}` : ''}
          </span>
          <button
            type="button"
            onClick={() => setLossSyncTick((n) => n + 1)}
            style={{
              marginLeft: 'auto', padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${t.border}`, background: t.surface, color: t.accent || '#38bdf8',
              fontSize: 12, fontWeight: 600,
            }}
          >
            Refresh from tablet
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ opacity: entryEnabled ? 1 : 0.6, pointerEvents: entryEnabled ? 'auto' : 'none' }}>
        {/* Section 1: Basic Info */}
        <Section title="Basic Information">
          <Row>
            <Field label="Date" required>
              <input style={s.inp} type="date" value={form.entry_date}
                onChange={e => set('entry_date', e.target.value)} required />
            </Field>
            <Field label="Station No">
              <select style={s.inp} value={form.station_no}
                onChange={e => setForm(p => ({
                  ...p,
                  station_no: parseInt(e.target.value, 10),
                  machine_id: '',
                }))}>
                {stations.map(s => <option key={s.id} value={s.id}>{s.display_name}</option>)}
              </select>
            </Field>
            <Field label="Shift">
              <select style={s.inp} value={form.shift} onChange={e => handleShiftChange(e.target.value)}>
                {enabledShifts.map(sh => (
                  <option key={sh.id} value={sh.id}>{sh.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Machine">
              <select style={s.inp} value={form.machine_id}
                onChange={e => set('machine_id', e.target.value)}>
                <option value="">— Select machine —</option>
                {stationMachines.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Production Plan">
              <select
                style={s.inp}
                value={form.plan_id || ''}
                onChange={(e) => {
                  const plan = plansForEntry.find((p) => String(p.id) === e.target.value);
                  if (plan) {
                    setForm((prev) => ({ ...prev, ...planFieldsFromPlan(plan, partsMaster) }));
                  } else {
                    setForm((prev) => ({ ...prev, plan_id: '' }));
                  }
                }}
              >
                <option value="">
                  {plansForEntry.length ? '— Select plan —' : '— No plan for this date/shift —'}
                </option>
                {plansForEntry.map((p) => (
                  <option key={p.id} value={p.id}>
                    {planModelVariant(p, partsMaster) || p.current_operation || 'Plan'}
                    {' · '}{p.status}
                    {p.priority ? ` · P${p.priority}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model / Variant">
              <input
                style={s.inp}
                value={form.model_variant}
                placeholder="From production plan or enter manually"
                onChange={e => setForm((p) => ({ ...p, model_variant: e.target.value, plan_id: '' }))}
              />
            </Field>
            <Field label="Current Operation">
              <input style={{ ...s.inp, opacity: includeOperations ? 1 : 0.5 }}
                disabled={!includeOperations}
                value={form.current_operation}
                onChange={e => set('current_operation', e.target.value)} />
            </Field>
            <Field label="Next Operation">
              <input style={{ ...s.inp, opacity: includeOperations ? 1 : 0.5 }}
                disabled={!includeOperations}
                value={form.next_operation}
                onChange={e => set('next_operation', e.target.value)} />
            </Field>
            <div style={{ display: 'flex', alignItems: 'center', minWidth: 180, paddingTop: 18 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: t.textDim, fontSize: 11, cursor: 'pointer' }}>
                <input type="checkbox" checked={includeOperations}
                  onChange={e => setIncludeOperations(e.target.checked)} />
                Include current &amp; next operation
              </label>
            </div>
            <Field label="Process Time (sec)">
              <input style={s.inp} type="number" min="0" step="0.01" value={form.process_time}
                onChange={e => setDecimal('process_time', e.target.value)} />
            </Field>
            <Field label="Loading & Unloading (sec)">
              <input style={s.inp} type="number" min="0" step="0.01" value={form.loading_unloading}
                onChange={e => setDecimal('loading_unloading', e.target.value)} />
            </Field>
            <Field label="Cycle Time (CT)">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={`${formatCtSeconds(preview.ct)} sec`} />
            </Field>
            <Field label="Start Time">
              <input style={s.inp} type="time" value={form.start_time}
                onChange={e => handleTimeChange('start_time', e.target.value)} />
            </Field>
            <Field label="Stop Time">
              <input style={s.inp} type="time" value={form.stop_time}
                onChange={e => handleTimeChange('stop_time', e.target.value)} />
            </Field>
            <Field label="Total Minutes (auto)">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={form.total_minutes || 0} />
            </Field>
          </Row>
        </Section>

        {/* Section 2: Breaks */}
        <Section title="Breaks & Planned Losses">
          <Row>
            {[['lunch_break','Lunch Break'],['tea_break','Tea Break'],['tpm_cleaning','TPM Cleaning'],
              ['other_cleaning','Other Cleaning'],['management_meeting','Mgmt Meeting']].map(([k, l]) => (
              <Field key={k} label={l}>
                <input style={s.inp} type="number" min="0" value={form[k]}
                  onChange={e => setNonNeg(k, e.target.value)} />
              </Field>
            ))}
            <Field label="Total Breaks">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.totalBreaks} />
            </Field>
          </Row>
          <Row>
            <Field label="Shift Working Min">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.shiftWorking} />
            </Field>
          </Row>
        </Section>

        {/* Section 3: Management Loss */}
        <Section title="Management Loss">
          <Row>
            {[['no_load','No Load'],['new_model_trial','New Model Trial'],['power_cut','Power Cut'],
              ['planned_maintenance','Planned Maintenance'],['no_manpower_planned','No Manpower (Planned)']].map(([k, l]) => (
              <Field key={k} label={l}>
                <input style={s.inp} type="number" min="0" value={form[k]}
                  onChange={e => setNonNeg(k, e.target.value)} />
              </Field>
            ))}
            <Field label="Mgmt Loss Total">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.mgmtLoss} />
            </Field>
          </Row>
          <Row>
            <Field label="Available Shift Time (min)">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.available} />
            </Field>
          </Row>
        </Section>

        {/* Section 4: Downtime */}
        <Section title="Downtime">
          <Row>
            {[['setting_time','Setting (auto from Model Change / mobile)'],['tool_change','Tool Change'],['dimension_correction','Dim. Correction'],
              ['scrap_removal','Scrap Removal'],['break_down','Break Down']].map(([k, l]) => (
              <Field key={k} label={k === 'setting_time' ? `${l}${mcAutoMinutes > 0 ? ` ✓ auto: ${mcAutoMinutes}min` : ''}` : l}>
                <input style={{ ...s.inp, ...((k === 'setting_time' && mcAutoMinutes > 0) || (mobileLossSync?.count > 0 && k !== 'setting_time' && (form[k] || 0) > 0) ? { borderColor: '#10b981' } : {}) }}
                  type="number" min="0" value={form[k]}
                  onChange={e => setNonNeg(k, e.target.value)}
                  readOnly={k === 'setting_time' && mcAutoMinutes > 0}
                />
              </Field>
            ))}
            <Field label="Total Down Time">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.totalDown} />
            </Field>
          </Row>
          <Row>
            <Field label="Operating Time (min)">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.operating} />
            </Field>
            <Field label="Possible Qty">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.possible} />
            </Field>
          </Row>
        </Section>

        {/* Section 5: Production */}
        <Section title="Production Output">
          <Row>
            <Field label="Actual Qty" required>
              <input style={s.inp} type="number" min="0" value={form.actual_qty}
                onChange={e => setNonNeg('actual_qty', e.target.value)} required />
            </Field>
            <Field label="Production Loss">
              <input style={{ ...s.inp, ...s.lossCalc }} readOnly value={preview.productionLoss} />
            </Field>
            <Field label="Defect Qty">
              <input style={s.inp} type="number" min="0" value={form.defect_qty}
                onChange={e => setNonNeg('defect_qty', e.target.value)} />
            </Field>
            <Field label="Accepted Qty (auto)">
              <input style={{ ...s.inp, ...s.calc }} readOnly value={preview.accp} />
            </Field>
          </Row>
        </Section>

        {/* OEE Preview */}
        <div style={s.oeePreview}>
          {[
            ['AR', preview.ar + '%', '#0ea5e9', 'Operating Time / Available Shift Time'],
            ['PR', preview.pr + '%', '#8b5cf6', 'Actual Qty / Possible Qty'],
            ['QR', preview.qr + '%', '#10b981', 'Accepted Qty / Actual Qty'],
            ['OEE', preview.oee + '%', preview.oee >= 85 ? '#10b981' : preview.oee >= 65 ? '#f59e0b' : '#ef4444', 'AR × PR × QR'],
          ].map(([l, v, c, hint]) => (
            <div key={l} style={{ ...s.oeeCard, borderTop: `3px solid ${c}` }} title={hint}>
              <div style={{ color: c, fontSize: 22, fontWeight: 700 }}>{v}</div>
              <div style={{ color: t.textMuted, fontSize: 12 }}>{l}</div>
              <div style={{ color: t.textDim, fontSize: 10, marginTop: 2 }}>{hint}</div>
            </div>
          ))}
        </div>

        {msg && <p style={{ color: msg.startsWith('✓') ? '#10b981' : '#ef4444', marginBottom: 12 }}>{msg}</p>}
        <button style={s.submitBtn} type="submit">Save Entry</button>
      </form>
    </div>
  );
}

function Section({ title, children }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ background: t.surface, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <h4 style={{ color: t.accent, margin: '0 0 12px', fontSize: 14 }}>{title}</h4>
      {children}
    </div>
  );
}

function Row({ children }) {
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>{children}</div>;
}

function Field({ label, children }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 140 }}>
      <label style={{ color: t.textDim, fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}

function getStyles(t) {
  return {
    page: { padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text },
    inp: { padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`, background: t.inp,
           color: t.text, fontSize: 13, width: '100%', boxSizing: 'border-box' },
    calc: { background: t.surface2, color: t.brand, border: `1px solid ${t.brand}33` },
    lossCalc: { background: t.surface2, color: '#ef4444', border: '1px solid #ef444433' },
    oeePreview: { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
    oeeCard: { background: t.surface, borderRadius: 10, padding: '14px 20px', flex: 1, textAlign: 'center', minWidth: 120 },
    submitBtn: { padding: '10px 32px', background: t.accent, color: '#fff', border: 'none',
                 borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
    alert: { background: t.surface2, color: t.text, padding: '10px 16px', borderRadius: 8,
             marginBottom: 10, fontSize: 13, fontWeight: 600, border: `1px solid ${t.border}` },
    warnBanner: { background: t.surface2, color: t.text, padding: '10px 16px', borderRadius: 8,
                  marginBottom: 12, fontSize: 13, border: `1px solid ${t.border}` },
    dlBtn: { padding: '7px 18px', background: t.brand, color: '#fff', border: 'none',
             borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  };
}
