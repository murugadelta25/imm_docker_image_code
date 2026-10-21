import { useState, useEffect, useCallback, useMemo } from 'react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../api/useWebSocket';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';
import { useConfig, getCurrentShift } from '../context/ConfigContext';
import { parseCtSeconds, formatCtSeconds, isValidDecimalInput } from '../utils/cycleTime';
import { computePlanningCapacityHints } from '../utils/hourlyOutput';
import { partToPlanningVariant, planModelVariant } from '../utils/partVariant';
import { DRAFT_KEYS } from '../utils/formPersistence';
import usePersistedState from '../hooks/usePersistedState';
import MachineSuggestions from '../components/production-planning/MachineSuggestions';
import MovePlanModal from '../components/production-planning/MovePlanModal';
import { Link } from 'react-router-dom';

/** Distinct from accent blue — work order links/labels across planning UI */
const WO_LINK_COLOR = '#f97316';
const woLinkStyle = { color: WO_LINK_COLOR, fontWeight: 700, textDecoration: 'none' };

function resolveFormShifts(form, enabledShifts) {
  if (form.shift_scope === 'all') return enabledShifts.map((s) => s.id);
  if (form.shift_scope === 'custom') {
    const sel = form.selected_shifts?.filter((id) => enabledShifts.some((s) => s.id === id));
    return sel?.length ? sel : [form.shift];
  }
  return [form.shift];
}

function computePlanDayCount(form) {
  if (form.plan_mode === 'single') return 1;
  if (form.plan_mode === 'weekly') return 7;
  if (form.plan_mode === 'monthly') {
    const start = new Date(form.start_date);
    if (Number.isNaN(start.getTime())) return 1;
    return new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  }
  if (form.plan_mode === 'custom_range' && form.start_date && form.end_date) {
    const start = new Date(form.start_date);
    const end = new Date(form.end_date);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
    return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
  }
  return 1;
}

function computePlanSlotCount(form, enabledShifts) {
  const days = computePlanDayCount(form);
  const shifts = resolveFormShifts(form, enabledShifts);
  return days * shifts.length;
}

const STATUS_CFG = {
  pending:    { color: '#64748b', label: 'Pending',    icon: '⏳' },
  running:    { color: '#0ea5e9', label: 'Running',    icon: '▶️' },
  completed:  { color: '#10b981', label: 'Completed',  icon: '✅' },
  paused:     { color: '#f59e0b', label: 'Paused',     icon: '⏸️' },
  cancelled:  { color: '#ef4444', label: 'Cancelled',  icon: '❌' },
  aborted:    { color: '#9f1239', label: 'Aborted',    icon: '⏹' },
  incomplete: { color: '#a16207', label: 'Incomplete', icon: '⚠' },
};

const TYPE_CFG = {
  scheduled: { color: '#0ea5e9', label: 'Scheduled' },
  urgent:    { color: '#ef4444', label: 'Urgent' },
  trial:     { color: '#8b5cf6', label: 'Trial' },
};

const INIT_FORM = {
  plan_date: new Date().toISOString().split('T')[0],
  start_date: new Date().toISOString().split('T')[0],
  end_date: new Date().toISOString().split('T')[0],
  shift: 'A', shift_scope: 'single', selected_shifts: ['A'],
  station_no: 1, machine_id: '',
  mold_id: '',
  model_variant: '',
  process_time: '',
  loading_unloading: 0, // kept for API; CT uses standard cycle time only
  planned_qty: '', priority: 1,
  plan_type: 'scheduled', plan_mode: 'single', notes: '',
  use_machine: false,  // false = station mode, true = individual machine mode
  work_order_id: '',
  enable_machine_suggestions: true,
  // Mold master snapshot (editable where noted)
  part_no: '',
  standard_cavity: '',
  running_cavity: '',
  customer_name: '',
  rm_grade: '',
  batch_grn_no: '',
  std_shot_weight: '',
  colour: '',
  std_part_weight: '',
  prod_plan: '',
  std_runner_weight: '',
  cavity_name: '',
  cavity_id: '',
  cavity_change: false,
  target_per_shift: '',
  mold_status: '',
  assigned_by: '',
};

function moldOptionLabel(m) {
  if (!m) return '';
  return [m.tool_code, m.tool_name || m.mold_name, m.part_no].filter(Boolean).join(' · ');
}

const PLAN_MODE_LABELS = {
  single: 'Single Day',
  weekly: 'Weekly',
  monthly: 'Monthly',
  custom_range: 'Custom Range',
};

function prodPlanFromMode(mode) {
  return PLAN_MODE_LABELS[mode] || PLAN_MODE_LABELS.single;
}

const PLC_ITEMS = [
  { label: 'MQTT',       desc: 'Topic: titan/station/{station_no}/actual_qty',  color: '#8b5cf6' },
  { label: 'Modbus TCP', desc: 'Register mapped to actual_qty per station',  color: '#0ea5e9' },
  { label: 'OPC-UA',     desc: 'Node: ns=2;s=Station{n}.ActualQty',          color: '#10b981' },
  { label: 'Manual',     desc: 'Click actual qty value in table to edit', color: '#f59e0b' },
];

// Helper functions for date calculations
const getDateString = (date) => date.toISOString().split('T')[0];
const getToday = () => new Date();
// IST calendar date (match Loss Tracker — avoid UTC drift from toISOString)
const todayDateStr = () => getToday().toLocaleDateString('en-CA');
const isPlanDateReached = (planDate) => !planDate || planDate <= todayDateStr();
const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};
// Returns the Monday of the week containing the given date
const getMondayOf = (dateStr) => {
  const d = new Date(dateStr);
  const day = d.getDay(); // 0=Sun, 1=Mon
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split('T')[0];
};

const getWeekStart = (date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
};
const getMonthStart = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const getMonthEnd = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);

export default function ProductionPlanning() {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const { config } = useConfig();
  const enabledShifts = useMemo(() => config.shifts.filter(s => s.enabled), [config.shifts]);
  const [plans, setPlans]       = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [machines, setMachines] = useState([]);
  const [stations, setStations]       = useState([]);
  const [parts, setParts]       = useState([]);
  const [molds, setMolds]       = useState([]);
  const [summary, setSummary]   = useState(null);
  const [form, setForm] = usePersistedState(DRAFT_KEYS.productionPlanning, INIT_FORM);

  const getStationLabel = (stationId) => {
    const station = stations.find(s => s.id === stationId);
    return station ? (station.display_name || station.name || `Station ${station.id}`) : stationId;
  };
  const [showForm, setShowForm] = useState(false);
  const [movePlan, setMovePlan] = useState(null);
  const [selectedPlanIds, setSelectedPlanIds] = useState(new Set());
  const [showPlcInfo, setShowPlcInfo] = useState(false);
  const [viewMode, setViewMode] = useState('day');
  const [historicMode, setHistoricMode] = useState(null); // 'prev_day', 'prev_week', 'prev_month', null
  const [filters, setFilters]   = useState({
    start_date: new Date().toISOString().split('T')[0],
    end_date: new Date().toISOString().split('T')[0],
    plan_date: new Date().toISOString().split('T')[0],
    shift: '', station_no: '', month: '', year: new Date().getFullYear(),
    use_date_range: false
  });
  const [pipeline, setPipeline] = useState({});
  const [planSearch, setPlanSearch] = useState('');
  const [actualEdit, setActualEdit] = useState({ id: null, qty: '' });
  const [msg, setMsg] = useState('');
  const [toolForecast, setToolForecast] = useState(null);
  const [pendingPlanPayload, setPendingPlanPayload] = useState(null);

  // Default form shift from Configuration (enabled shifts)
  useEffect(() => {
    if (!enabledShifts.length) return;
    const defaultShift = getCurrentShift(config)?.id || enabledShifts[0].id;
    setForm(prev => (
      enabledShifts.some(s => s.id === prev.shift)
        ? prev
        : { ...prev, shift: defaultShift, selected_shifts: [defaultShift] }
    ));
  }, [config, enabledShifts]);

  // Auto-set Monday when weekly mode is selected
  useEffect(() => {
    if (form.plan_mode === 'weekly') {
      const monday = getMondayOf(form.start_date || new Date().toISOString().split('T')[0]);
      setForm(p => ({ ...p, start_date: monday }));
    }
  }, [form.plan_mode]);

  // Update filter dates when historic mode changes
  useEffect(() => {
    if (!historicMode) return;
    const today = getToday();
    let start, end;
    
    if (historicMode === 'prev_day') {
      start = addDays(today, -1);
      end = start;
    } else if (historicMode === 'prev_week') {
      end = addDays(today, -1);
      start = addDays(getWeekStart(end), -6);
    } else if (historicMode === 'prev_month') {
      end = addDays(new Date(today.getFullYear(), today.getMonth(), 1), -1);
      start = getMonthStart(end);
    }
    
    setFilters(p => ({
      ...p,
      start_date: getDateString(start),
      end_date: getDateString(end),
      use_date_range: true
    }));
  }, [historicMode]);

  const buildParams = () => {
    const p = {};
    if (filters.use_date_range && filters.start_date && filters.end_date) {
      p.date_from = filters.start_date;
      p.date_to = filters.end_date;
    } else if (!filters.use_date_range && viewMode === 'day' && filters.plan_date) {
      p.plan_date = filters.plan_date;
    }
    if (viewMode === 'month' && filters.month && !filters.use_date_range) p.month = filters.month;
    if (filters.year && !filters.use_date_range) p.year = filters.year;
    if (filters.shift)   p.shift = filters.shift;
    if (filters.station_no) p.station_no = parseInt(filters.station_no, 10);
    return p;
  };

  const fetchWorkOrders = useCallback(async () => {
    try {
      // Lightweight open-WO list for Add Plan dropdown (avoids heavy /work-orders/ sync timeouts)
      const r = await api.get('/api/work-orders/options', { params: { limit: 500 } });
      setWorkOrders(Array.isArray(r.data) ? r.data : []);
    } catch {
      try {
        // Fallback: full list filtered to open statuses
        const r = await api.get('/api/work-orders/', { params: { active_only: true } });
        const list = Array.isArray(r.data) ? r.data : [];
        setWorkOrders(list.filter((wo) => ['draft', 'in_progress'].includes(wo.status)));
      } catch {
        setWorkOrders([]);
      }
    }
  }, []);

  const fetchAll = useCallback(async () => {
    const params = buildParams();
    const [pl, sm, mc, pr] = await Promise.all([
      api.get('/api/plans/', { params }),
      api.get('/api/plans/summary', { params }),
      api.get('/api/machines/'),
      api.get('/api/stations/'),
    ]);
    setPlans(pl.data);
    setSummary(sm.data);
    setMachines(mc.data);
    setStations(pr.data);

    setForm(prev => {
      if (prev.use_machine) return prev;
      const validStationIds = new Set(pr.data.map(station => station.id));
      if (validStationIds.has(prev.station_no)) return prev;
      return { ...prev, station_no: pr.data[0]?.id || '' };
    });

    const validStationIds = new Set(pr.data.map(station => station.id));
    const planStationNos = [...new Set(pl.data.map(p => p.station_no).filter(pn => validStationIds.has(pn)))];
    const pipelineData = {};
    await Promise.all(planStationNos.map(async pn => {
      const r = await api.get(`/api/plans/pipeline/${pn}`);
      if (r.data.length > 0) pipelineData[pn] = r.data;
    }));
    setPipeline(pipelineData);
  }, [filters, viewMode]);

  useEffect(() => { fetchAll(); fetchWorkOrders(); }, [fetchAll, fetchWorkOrders]);

  useEffect(() => {
    api.get('/api/parts/options', { params: { active_only: true, limit: 500 } })
      .then((r) => setParts(r.data))
      .catch(() => setParts([]));
    api.get('/api/tools/', { params: { active_only: true, limit: 1000 } })
      .then((r) => setMolds(Array.isArray(r.data) ? r.data : []))
      .catch(() => setMolds([]));
  }, []);

  const applyMoldToForm = useCallback((moldId, extra = {}) => {
    if (!moldId) {
      setForm((p) => ({
        ...p,
        mold_id: '',
        model_variant: '',
        part_no: '',
        standard_cavity: '',
        running_cavity: '',
        customer_name: '',
        rm_grade: '',
        std_shot_weight: '',
        colour: '',
        std_part_weight: '',
        std_runner_weight: '',
        cavity_name: '',
        cavity_id: '',
        cavity_change: false,
        target_per_shift: '',
        mold_status: '',
        process_time: '',
        ...extra,
      }));
      return;
    }
    const mold = molds.find((m) => String(m.id) === String(moldId));
    if (!mold) {
      setForm((p) => ({ ...p, mold_id: String(moldId), ...extra }));
      return;
    }
    const cavities = Array.isArray(mold.cavities) ? mold.cavities : [];
    const active = mold.active_cavity || cavities.find((c) => c.enabled) || cavities[0] || null;
    const cycle = mold.standard_cycle_time != null ? String(mold.standard_cycle_time) : '';
    const assigned = user?.username || user?.full_name || user?.name || '';
    setForm((p) => ({
      ...p,
      ...extra,
      mold_id: String(moldId),
      model_variant: moldOptionLabel(mold),
      part_no: mold.part_no || mold.effective_part_no || '',
      standard_cavity: mold.standard_cavity != null ? String(mold.standard_cavity) : '',
      running_cavity: mold.running_cavity != null ? String(mold.running_cavity) : '',
      customer_name: mold.customer_name || '',
      rm_grade: mold.rm_grade || '',
      std_shot_weight: mold.std_shot_weight != null ? String(mold.std_shot_weight) : '',
      colour: mold.colour || '',
      std_part_weight: mold.std_part_weight != null ? String(mold.std_part_weight) : '',
      std_runner_weight: mold.std_runner_weight != null ? String(mold.std_runner_weight) : '',
      cavity_name: active?.name || mold.active_cavity_name || '',
      cavity_id: active?.id || '',
      cavity_change: false,
      target_per_shift: mold.target_per_shift != null ? String(mold.target_per_shift) : '',
      mold_status: mold.tool_status || '',
      process_time: cycle,
      loading_unloading: 0,
      assigned_by: p.assigned_by || assigned,
      planned_qty: (!p.planned_qty && mold.target_per_shift != null)
        ? String(mold.target_per_shift)
        : p.planned_qty,
      prod_plan: prodPlanFromMode(p.plan_mode),
    }));
  }, [molds, user, setForm]);

  const selectedMold = useMemo(
    () => molds.find((m) => String(m.id) === String(form.mold_id)),
    [molds, form.mold_id],
  );

  const moldCavities = useMemo(() => {
    const list = Array.isArray(selectedMold?.cavities) ? selectedMold.cavities : [];
    return list.filter((c) => c && (c.name || c.part_no));
  }, [selectedMold]);

  useWebSocket(useCallback(msg => {
    if ([
      'plan_created', 'plan_started', 'plan_completed', 'plan_updated', 'plan_deleted',
      'actual_qty_updated', 'station_created', 'station_updated', 'station_deleted',
      'work_order_created', 'work_order_updated', 'plan_rescheduled', 'plans_bulk_rescheduled',
      'model_change_request', 'model_change_approved', 'model_change_completed', 'model_change_rejected',
    ].includes(msg.type)) {
      fetchAll();
      fetchWorkOrders();
    }
  }, [fetchAll, fetchWorkOrders]));

  const selectedWorkOrder = useMemo(
    () => workOrders.find((wo) => String(wo.id) === String(form.work_order_id)),
    [workOrders, form.work_order_id],
  );

  const planCapacity = useMemo(() => {
    const slotCount = computePlanSlotCount(form, enabledShifts);
    const perShiftQty = parseInt(form.planned_qty, 10) || 0;
    const totalPlanned = perShiftQty * slotCount;
    const unplanned = selectedWorkOrder?.unplanned_qty ?? null;
    const maxPerShift = slotCount > 0 && unplanned != null
      ? Math.floor(unplanned / slotCount)
      : null;
    return { slotCount, perShiftQty, totalPlanned, unplanned, maxPerShift };
  }, [form, enabledShifts, selectedWorkOrder]);

  const selectedShifts = useMemo(
    () => enabledShifts.filter((sh) => resolveFormShifts(form, enabledShifts).includes(sh.id)),
    [form, enabledShifts],
  );

  const selectedMachine = useMemo(
    () => machines.find((m) => String(m.id) === String(form.machine_id)),
    [machines, form.machine_id],
  );

  const shiftCapacityHints = useMemo(() => {
    const ctSec = parseCtSeconds(form.process_time);
    const runCav = form.running_cavity !== '' && form.running_cavity != null
      ? Number(form.running_cavity)
      : 1;
    return computePlanningCapacityHints({
      ctSec,
      shifts: selectedShifts,
      breaks: config.breaks || {},
      unplannedQty: selectedWorkOrder?.unplanned_qty ?? null,
      slotCount: planCapacity.slotCount,
      runningCavity: Number.isFinite(runCav) && runCav > 0 ? runCav : 1,
    });
  }, [form.process_time, form.running_cavity, selectedShifts, config.breaks, selectedWorkOrder, planCapacity.slotCount]);

  const buildPlanPayload = useCallback((shifts, { toolAck = false } = {}) => {
    const moldDetails = {
      part_no: form.part_no || null,
      standard_cavity: form.standard_cavity !== '' ? Number(form.standard_cavity) : null,
      running_cavity: form.running_cavity !== '' ? Number(form.running_cavity) : null,
      customer_name: form.customer_name || null,
      rm_grade: form.rm_grade || null,
      standard_cycle_time: form.process_time !== '' ? Number(form.process_time) : null,
      batch_grn_no: form.batch_grn_no || null,
      std_shot_weight: form.std_shot_weight !== '' ? Number(form.std_shot_weight) : null,
      colour: form.colour || null,
      std_part_weight: form.std_part_weight !== '' ? Number(form.std_part_weight) : null,
      prod_plan: prodPlanFromMode(form.plan_mode),
      std_runner_weight: form.std_runner_weight !== '' ? Number(form.std_runner_weight) : null,
      cavity_name: form.cavity_name || null,
      cavity_id: form.cavity_id || null,
      cavity_change: !!form.cavity_change,
      target_per_shift: form.target_per_shift !== '' ? Number(form.target_per_shift) : null,
      mold_status: form.mold_status || null,
      assigned_by: form.assigned_by || null,
      mold_code: selectedMold?.tool_code || null,
      mold_name: selectedMold?.tool_name || selectedMold?.mold_name || null,
    };
    return {
      machine_id: form.machine_id === '' ? null : parseInt(form.machine_id, 10),
      work_order_id: form.work_order_id ? parseInt(form.work_order_id, 10) : null,
      mold_id: form.mold_id ? parseInt(form.mold_id, 10) : null,
      mold_details: moldDetails,
      process_time: parseCtSeconds(form.process_time),
      loading_unloading: 0,
      planned_qty: parseInt(form.planned_qty, 10),
      priority: parseInt(form.priority, 10),
      shift: shifts[0],
      shifts,
      station_no: parseInt(form.station_no, 10),
      model_variant: form.model_variant || null,
      plan_type: form.plan_type,
      notes: form.notes,
      ...(toolAck ? { tool_shortage_ack: true } : {}),
    };
  }, [form, selectedMold]);

  const createPlan = async e => {
    e.preventDefault();
    try {
      const shifts = resolveFormShifts(form, enabledShifts);
      if (!shifts.length) {
        setMsg('❌ Select at least one shift');
        return;
      }
      if (!form.mold_id) {
        setMsg('❌ Select a mold from mold master');
        return;
      }
      if (form.plan_mode === 'custom_range') {
        const dayCount = computePlanDayCount(form);
        if (dayCount <= 0) {
          setMsg('❌ End date must be on or after start date');
          return;
        }
      }
      if (selectedWorkOrder && planCapacity.totalPlanned > (selectedWorkOrder.unplanned_qty ?? 0)) {
        const { slotCount, maxPerShift, totalPlanned } = planCapacity;
        setMsg(
          `❌ Total planned qty (${totalPlanned} pcs = ${planCapacity.perShiftQty} × ${slotCount} slots) `
          + `exceeds work order capacity (${selectedWorkOrder.unplanned_qty} pcs left). `
          + (maxPerShift != null ? `Max per shift for this range: ${maxPerShift} pcs.` : ''),
        );
        return;
      }
      let payload = buildPlanPayload(shifts);

      const shiftLabel = shifts.length > 1 ? `${shifts.length} shifts (${shifts.join(', ')})` : `shift ${shifts[0]}`;

      // Handle different plan modes
      if (form.plan_mode === 'single') {
        payload.plan_date = form.plan_date;
      } else if (form.plan_mode === 'weekly') {
        payload.plan_date = form.start_date;
        const end = new Date(form.start_date);
        end.setDate(end.getDate() + 6);
        payload.end_date = end.toISOString().split('T')[0];
      } else if (form.plan_mode === 'monthly') {
        const start = new Date(form.start_date);
        payload.plan_date = form.start_date;
        const year = start.getFullYear();
        const month = start.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const end = new Date(year, month, daysInMonth);
        payload.end_date = end.toISOString().split('T')[0];
      } else if (form.plan_mode === 'custom_range') {
        payload.plan_date = form.start_date;
        payload.end_date = form.end_date;
      }

      const r = await api.post('/api/plans/', payload);
      const count = Array.isArray(r.data) ? r.data.length : 1;
      setMsg(`✅ Plan created · ${count} slot(s) · ${shiftLabel}`);
      setForm(INIT_FORM);
      setShowForm(false);
      setToolForecast(null);
      setPendingPlanPayload(null);
      fetchAll();
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (err.response?.status === 409 && detail && typeof detail === 'object') {
        if (detail.code === 'tool_eol_blocked') {
          setToolForecast(detail.forecast || null);
          setPendingPlanPayload(null);
          setMsg(`❌ ${detail.message || 'Tool end-of-life blocks planning — correct or replace in Tool Management'}`);
          return;
        }
        if (detail.code === 'tool_forecast_ack_required') {
          // Rebuild payload for ack retry
          const shifts = resolveFormShifts(form, enabledShifts);
          let payload = {
            ...buildPlanPayload(shifts, { toolAck: true }),
          };
          if (form.plan_mode === 'single') payload.plan_date = form.plan_date;
          else if (form.plan_mode === 'weekly') {
            payload.plan_date = form.start_date;
            const end = new Date(form.start_date);
            end.setDate(end.getDate() + 6);
            payload.end_date = end.toISOString().split('T')[0];
          } else if (form.plan_mode === 'monthly') {
            const start = new Date(form.start_date);
            payload.plan_date = form.start_date;
            const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
            payload.end_date = new Date(start.getFullYear(), start.getMonth(), daysInMonth).toISOString().split('T')[0];
          } else {
            payload.plan_date = form.start_date;
            payload.end_date = form.end_date;
          }
          setToolForecast(detail.forecast || null);
          setPendingPlanPayload(payload);
          setMsg('⚠ Tool forecast requires planner acknowledgment');
          return;
        }
      }
      const errMsg = (typeof detail === 'string' ? detail : detail?.message) || err.response?.data?.message || err.message;
      setMsg('❌ Error: ' + errMsg);
    }
  };

  const confirmToolForecastAck = async () => {
    if (!pendingPlanPayload) return;
    try {
      const r = await api.post('/api/plans/', pendingPlanPayload);
      const count = Array.isArray(r.data) ? r.data.length : 1;
      setMsg(`✅ Plan created with tool forecast acknowledgment · ${count} slot(s)`);
      setForm(INIT_FORM);
      setShowForm(false);
      setToolForecast(null);
      setPendingPlanPayload(null);
      fetchAll();
    } catch (err) {
      const detail = err.response?.data?.detail;
      setMsg('❌ ' + ((typeof detail === 'string' ? detail : detail?.message) || err.message));
    }
  };

  const setStatus = async (id, status) => {
    try {
      const { data } = await api.patch(`/api/plans/${id}/status`, { status });
      if (data?.model_change_pending || data?.awaiting_model_change) {
        setMsg(
          `⏳ Model change request #${data.model_change_request_id || ''} raised — `
          + 'approve it on the Model Change page to start the plan and apply the part on WI.',
        );
      } else if (data?.message) {
        setMsg(`✅ ${data.message}`);
      } else if (status === 'running') {
        setMsg('✅ Plan started');
      } else if (status === 'paused') {
        setMsg('⏸ Plan paused');
      } else if (status === 'aborted') {
        setMsg('⏹ Plan aborted — will not resume');
      } else if (status === 'completed') {
        setMsg('✅ Plan completed');
      }
      await fetchAll();
      // Keep feedback visible near actions (not only in create form)
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const detail = err.response?.data?.detail;
      const errText = Array.isArray(detail)
        ? detail.map((d) => d.msg || d).join(', ')
        : (detail || err.message);
      setMsg(`❌ ${errText}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const saveActual = async (id) => {
    try {
      await api.patch(`/api/plans/${id}/actual`, { actual_qty: parseInt(actualEdit.qty), source: 'manual' });
      setActualEdit({ id: null, qty: '' });
      fetchAll();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const deletePlan = async id => {
    if (!window.confirm('Delete this plan?')) return;
    await api.delete(`/api/plans/${id}`);
    fetchAll();
  };

  const bulkMovePlans = async (daysOffset = 7) => {
    const ids = [...selectedPlanIds];
    if (!ids.length) return;
    if (!window.confirm(`Move ${ids.length} selected plan(s) forward by ${daysOffset} day(s)?`)) return;
    try {
      const r = await api.post('/api/plans/bulk-reschedule', {
        plan_ids: ids,
        mode: 'next_week',
        days_offset: daysOffset,
        split_remaining: true,
      });
      setMsg(`✅ Moved ${r.data.moved} plan(s) by ${r.data.days_offset} days`);
      setSelectedPlanIds(new Set());
      fetchAll();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const togglePlanSelect = (id) => {
    setSelectedPlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectMovablePlans = () => {
    const movable = plans.filter((p) => ['pending', 'paused'].includes(p.status)).map((p) => p.id);
    setSelectedPlanIds(new Set(movable));
  };

  const clearHistoricMode = () => {
    setHistoricMode(null);
    setFilters(p => ({ ...p, use_date_range: false, plan_date: getDateString(getToday()) }));
  };

  const exportToExcel = () => {
    try {
      const wb = XLSX.utils.book_new();
      
      // Get date range for filename and title
      let dateRange = '';
      if (filters.use_date_range) {
        dateRange = `${filters.start_date} to ${filters.end_date}`;
      } else if (viewMode === 'day') {
        dateRange = filters.plan_date;
      } else if (viewMode === 'month' && filters.month) {
        dateRange = `${MONTHS[filters.month - 1]} ${filters.year}`;
      } else if (viewMode === 'month') {
        dateRange = `All of ${filters.year}`;
      } else if (viewMode === 'week') {
        dateRange = `Week of ${filters.plan_date}`;
      }

      // ==================== Sheet 1: Summary ==================== 
      const summaryData = [
        ['PRODUCTION PLANNING REPORT'],
        [''],
        ['Report Date:', new Date().toLocaleDateString('en-GB')],
        ['Period:', dateRange],
        [''],
        ['SUMMARY METRICS'],
        ['Total Plans:', summary?.total_plans || 0],
        ['Planned Quantity:', summary?.total_planned || 0],
        ['Actual Quantity:', summary?.total_actual || 0],
        ['Achievement %:', (summary?.achievement_pct || 0) + '%'],
        [''],
        ['STATUS BREAKDOWN'],
        ['Pending:', summary?.by_status?.pending || 0],
        ['Running:', summary?.by_status?.running || 0],
        ['Completed:', summary?.by_status?.completed || 0],
        ['Paused:', summary?.by_status?.paused || 0],
        ['Cancelled:', summary?.by_status?.cancelled || 0],
        ['Aborted:', summary?.by_status?.aborted || 0],
      ];
      const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
      summaryWs['!cols'] = [{ wch: 20 }, { wch: 15 }];
      XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

      // ==================== Sheet 2: Detailed Plans ====================
      const plansHeader = [
        'Date', 'Shift', 'Station', 'Work Order No', 'WO Target Qty', 'WO Completed', 'WO Remaining',
        'Current Operation', 'Next Operation', 'Process Time (s)',
        'Loading/Unloading (s)', 'Cycle Time (s)', 'Type', 'Priority', 'Planned Qty',
        'Actual Qty', 'Achievement %', 'Status', 'Notes'
      ];
      
      const plansData = plans.map(p => {
        const pct = p.planned_qty > 0 ? Math.round(p.actual_qty / p.planned_qty * 100) : 0;
        const wo = workOrders.find(w => w.id === p.work_order_id);
        return [
          p.plan_date,
          p.shift,
          p.station_no,
          wo?.work_order_no || '',
          wo?.target_qty ?? '',
          wo?.completed_qty ?? '',
          wo?.remaining_qty ?? '',
          p.current_operation,
          p.next_operation,
          p.process_time,
          0,
          parseCtSeconds(p.process_time),
          p.plan_type,
          p.priority,
          p.planned_qty,
          p.actual_qty,
          pct + '%',
          p.status,
          p.notes || ''
        ];
      });

      const detailWs = XLSX.utils.aoa_to_sheet([plansHeader, ...plansData]);
      
      // Set column widths
      detailWs['!cols'] = [
        { wch: 12 }, { wch: 8 }, { wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 14 }, { wch: 14 },
        { wch: 15 }, { wch: 17 }, { wch: 14 }, { wch: 12 }, { wch: 10 },
        { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 20 }
      ];

      // Style header row (bold + background)
      for (let i = 0; i < plansHeader.length; i++) {
        const cellRef = XLSX.utils.encode_col(i) + '1';
        if (!detailWs[cellRef]) continue;
        detailWs[cellRef].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '1e293b' } },
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      }

      XLSX.utils.book_append_sheet(wb, detailWs, 'Plans Details');

      // ==================== Sheet 3: Production By Station ====================
      const stationStats = {};
      plans.forEach(p => {
        if (!stationStats[p.station_no]) {
          stationStats[p.station_no] = {
            stationKey: p.station_no,
            totalPlans: 0,
            plannedQty: 0,
            actualQty: 0,
            completed: 0,
            running: 0,
            pending: 0
          };
        }
        stationStats[p.station_no].totalPlans++;
        stationStats[p.station_no].plannedQty += p.planned_qty;
        stationStats[p.station_no].actualQty += p.actual_qty;
        if (p.status === 'completed') stationStats[p.station_no].completed++;
        else if (p.status === 'running') stationStats[p.station_no].running++;
        else if (p.status === 'pending') stationStats[p.station_no].pending++;
      });

      const stationHeader = ['Station No', 'Total Plans', 'Planned Qty', 'Actual Qty', 'Achievement %', 'Completed', 'Running', 'Pending'];
      const stationRows = Object.values(stationStats).map(ps => {
        const achievementPct = ps.plannedQty > 0 ? Math.round(ps.actualQty / ps.plannedQty * 100) : 0;
        return [
          ps.stationKey,
          ps.totalPlans,
          ps.plannedQty,
          ps.actualQty,
          achievementPct + '%',
          ps.completed,
          ps.running,
          ps.pending
        ];
      });

      const stationWs = XLSX.utils.aoa_to_sheet([stationHeader, ...stationRows]);
      stationWs['!cols'] = [
        { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }
      ];

      // Style header row
      for (let i = 0; i < stationHeader.length; i++) {
        const cellRef = XLSX.utils.encode_col(i) + '1';
        if (!stationWs[cellRef]) continue;
        stationWs[cellRef].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '1e293b' } },
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      }

      XLSX.utils.book_append_sheet(wb, stationWs, 'By Station');

      // ==================== Sheet 4: Shift Analysis ====================
      const shiftStats = {};
      plans.forEach(p => {
        if (!shiftStats[p.shift]) {
          shiftStats[p.shift] = {
            shift: p.shift,
            totalPlans: 0,
            plannedQty: 0,
            actualQty: 0,
            completed: 0,
            running: 0
          };
        }
        shiftStats[p.shift].totalPlans++;
        shiftStats[p.shift].plannedQty += p.planned_qty;
        shiftStats[p.shift].actualQty += p.actual_qty;
        if (p.status === 'completed') shiftStats[p.shift].completed++;
        else if (p.status === 'running') shiftStats[p.shift].running++;
      });

      const shiftHeader = ['Shift', 'Total Plans', 'Planned Qty', 'Actual Qty', 'Achievement %', 'Completed', 'Running'];
      const shiftRows = Object.values(shiftStats).map(ss => {
        const achievementPct = ss.plannedQty > 0 ? Math.round(ss.actualQty / ss.plannedQty * 100) : 0;
        return [
          ss.shift,
          ss.totalPlans,
          ss.plannedQty,
          ss.actualQty,
          achievementPct + '%',
          ss.completed,
          ss.running
        ];
      });

      const shiftWs = XLSX.utils.aoa_to_sheet([shiftHeader, ...shiftRows]);
      shiftWs['!cols'] = [
        { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 14 }, { wch: 12 }, { wch: 12 }
      ];

      // Style header row
      for (let i = 0; i < shiftHeader.length; i++) {
        const cellRef = XLSX.utils.encode_col(i) + '1';
        if (!shiftWs[cellRef]) continue;
        shiftWs[cellRef].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' } },
          fill: { fgColor: { rgb: '1e293b' } },
          alignment: { horizontal: 'center', vertical: 'center' }
        };
      }

      XLSX.utils.book_append_sheet(wb, shiftWs, 'By Shift');

      // Generate filename with date range
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `Production_Plan_${timestamp}_${dateRange.replace(/\s+/g, '_')}.xlsx`;

      // Download file
      XLSX.writeFile(wb, filename);
      setMsg('✅ Report exported successfully');
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg('Error: Failed to export report - ' + err.message);
    }
  };

  const canEdit   = user?.role === 'supervisor' || user?.role === 'admin';
  const canCreate = user?.role !== 'maintenance';

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const daysDiff = filters.start_date && filters.end_date ? 
    Math.ceil((new Date(filters.end_date) - new Date(filters.start_date)) / (1000 * 60 * 60 * 24)) + 1 : 0;

  // derive runtime styles from theme
  const s = getStyles(t);

  const msgIsError = msg.startsWith('❌') || msg.toLowerCase().includes('error');
  const msgIsWait = msg.startsWith('⏳') || msg.startsWith('⚠');

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text, transition: 'background 0.2s, color 0.2s' }}>
      {/* Header with clock + refresh + info button */}
      <PageHeader
        title="PRODUCTION PLANNING"
        onRefresh={() => { fetchAll(); fetchWorkOrders(); }}
        extra={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              style={s.exportBtn}
              onClick={exportToExcel}
              title="Download planning report as Excel"
            >
              ⬇ Export Excel
            </button>
            {canCreate && (
              <button style={s.addBtn} onClick={() => setShowForm(v => !v)}>
                {showForm ? '✕ Cancel' : '+ New Plan'}
              </button>
            )}
            <button
              style={s.infoBtn}
              onClick={() => setShowPlcInfo(v => !v)}
              title="PLC / Machine Integration Info"
            >
              ⓘ
            </button>
          </div>
        }
      />

      {msg && (
        <div
          role="status"
          style={{
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            background: msgIsError ? '#fef2f2' : msgIsWait ? '#fffbeb' : '#ecfdf5',
            color: msgIsError ? '#dc2626' : msgIsWait ? '#b45309' : '#047857',
            border: `1px solid ${msgIsError ? '#fecaca' : msgIsWait ? '#fde68a' : '#a7f3d0'}`,
          }}
        >
          <span>{msg}</span>
          <button
            type="button"
            onClick={() => setMsg('')}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontWeight: 700,
              color: 'inherit',
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {toolForecast && (
        <div style={{
          marginBottom: 16, padding: 16, borderRadius: 12,
          background: t.surface, border: `1px solid ${pendingPlanPayload ? '#f59e0b' : '#ef4444'}`,
        }}>
          <div style={{ fontWeight: 700, color: pendingPlanPayload ? '#f59e0b' : '#ef4444', marginBottom: 8 }}>
            Tool Forecast — {toolForecast.work_order_no || 'Work Order'}
          </div>
          <div style={{ fontSize: 12, color: t.textDim, marginBottom: 10 }}>{toolForecast.message}</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['Tool', 'Stock', 'Required', 'Remaining', 'Life', 'Status', 'Note'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: t.textDim }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(toolForecast.tools || []).map((row, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${t.border}` }}>
                    <td style={{ padding: '6px 8px' }}>{row.tool_code || row.tool_name || '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{row.stock_available ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>{row.required_qty ?? '—'}</td>
                    <td style={{
                      padding: '6px 8px',
                      color: row.remaining_after != null && row.remaining_after < 0 ? '#ef4444' : undefined,
                      fontWeight: 600,
                    }}>{row.remaining_after ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {row.life_cycles_limit
                        ? `${row.cycles_used}/${row.life_cycles_limit} → ${row.projected_cycles_after ?? '—'}`
                        : '—'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{row.tool_status || row.status || '—'}</td>
                    <td style={{ padding: '6px 8px', color: t.textMuted }}>{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {pendingPlanPayload && (
              <button type="button" onClick={confirmToolForecastAck}
                style={{ padding: '8px 16px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                Acknowledge & Plan Anyway
              </button>
            )}
            <Link to="/tools" style={{ padding: '8px 16px', background: t.surface2, color: t.accent, border: `1px solid ${t.border}`, borderRadius: 8, textDecoration: 'none', fontWeight: 600 }}>
              Open Tool Management
            </Link>
            <button type="button" onClick={() => { setToolForecast(null); setPendingPlanPayload(null); }}
              style={{ padding: '8px 16px', background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer' }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {movePlan && (
        <MovePlanModal
          t={t}
          plan={movePlan}
          enabledShifts={enabledShifts}
          machines={machines}
          stations={stations}
          onClose={() => setMovePlan(null)}
          onMoved={(result) => {
            setMsg(result.split
              ? '✅ Plan split — completed portion kept, remainder moved'
              : '✅ Plan moved successfully');
            fetchAll();
          }}
        />
      )}

      {showPlcInfo && (
        <div style={s.plcCard}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h4 style={{ ...s.cardTitle, margin: 0 }}>🔌 PLC / Machine Integration</h4>
            <button style={s.closeBtn} onClick={() => setShowPlcInfo(false)}>✕</button>
          </div>
          <p style={{ color: t.textDim, fontSize: 13, marginBottom: 12 }}>
            Actual production count is automatically updated when received from the machine via:
          </p>
          <div style={s.plcGrid}>
            {PLC_ITEMS.map(i => (
              <div key={i.label} style={{ ...s.plcItem, borderLeft: `3px solid ${i.color}` }}>
                <div style={{ color: i.color, fontWeight: 700, fontSize: 13 }}>{i.label}</div>
                <div style={{ color: t.textDim, fontSize: 12 }}>{i.desc}</div>
              </div>
            ))}
          </div>
          <p style={{ color: t.textFaint, fontSize: 12, marginTop: 10 }}>
            API endpoint: <code style={{ color: t.accent }}>PATCH /api/plans/{'{id}'}/actual</code> —{' '}
            called by Node-RED, MQTT bridge, or Modbus bridge with{' '}
            <code style={{ color: t.accent }}>{'{"actual_qty": 123, "source": "mqtt"}'}</code>
          </p>
        </div>
      )}

      {/* Create Plan Form - Enhanced with date range and weekly/monthly options */}
      {showForm && (
        <div className={surfaceClass(t)} style={s.card}>
          <h4 style={s.cardTitle}>Create Production Plan</h4>
          <form onSubmit={createPlan}>
            {/* Plan Mode Selection */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ color: t.textDim, fontSize: 11, marginBottom: 8, display: 'block' }}>Plan Mode</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { value: 'single', label: '📅 Single Day', desc: 'Create plan for one date' },
                  { value: 'weekly', label: '📆 Weekly', desc: '7 consecutive days' },
                  { value: 'monthly', label: '📊 Monthly', desc: 'Full month plan' },
                  { value: 'custom_range', label: '📋 Custom Range', desc: 'Any date range' },
                ].map(mode => (
                  <div key={mode.value} style={{ flex: '1 1 auto', minWidth: 140 }}>
                    <button
                      type="button"
                      style={{
                        ...s.modeBtn,
                        ...(form.plan_mode === mode.value ? s.modeBtnActive : s.modeBtnInactive)
                      }}
                      onClick={() => setForm((p) => ({
                        ...p,
                        plan_mode: mode.value,
                        prod_plan: prodPlanFromMode(mode.value),
                      }))}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{mode.label}</div>
                      <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{mode.desc}</div>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Work Order linkage */}
            <div style={{ marginBottom: 16, padding: 12, background: t.surface2, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ color: t.accent, fontSize: 12, fontWeight: 600 }}>Master Work Order</label>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <Link to="/work-orders" style={{ color: t.accent, fontSize: 12, textDecoration: 'none' }}>Manage work orders →</Link>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textMuted, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.enable_machine_suggestions}
                    onChange={(e) => setForm((p) => ({ ...p, enable_machine_suggestions: e.target.checked }))} />
                  Smart machine suggestions
                </label>
                </div>
              </div>
              <select style={s.inp} value={form.work_order_id}
                onChange={(e) => {
                  const wo = workOrders.find((w) => String(w.id) === e.target.value);
                  if (wo?.mold_id) {
                    applyMoldToForm(wo.mold_id, { work_order_id: e.target.value });
                  } else {
                    setForm((p) => ({
                      ...p,
                      work_order_id: e.target.value,
                      model_variant: wo?.mold_label || wo?.model_variant || wo?.mold_name || p.model_variant,
                    }));
                  }
                }}>
                <option value="">— Optional: link plan to work order —</option>
                {workOrders.map((wo) => (
                  <option key={wo.id} value={wo.id}>
                    {wo.work_order_no} · {wo.mold_label || wo.model_variant || wo.mold_name || wo.part_no} · {wo.remaining_qty}/{wo.target_qty} remaining
                  </option>
                ))}
              </select>
              {selectedWorkOrder && (
                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, flexWrap: 'wrap' }}>
                  <span style={{ color: t.text }}>Target: <strong>{selectedWorkOrder.target_qty}</strong> pcs</span>
                  <span style={{ color: '#10b981' }}>Completed: {selectedWorkOrder.completed_qty}</span>
                  <span style={{ color: '#f59e0b' }}>Remaining: {selectedWorkOrder.remaining_qty}</span>
                  <span style={{ color: t.textMuted }}>Unplanned: {selectedWorkOrder.unplanned_qty}</span>
                  <Link to={`/work-orders?id=${selectedWorkOrder.id}`}
                    style={{ ...woLinkStyle, fontSize: 12 }}>
                    View work order details →
                  </Link>
                </div>
              )}
            </div>

            <div style={s.formGrid}>
              {/* Date fields based on plan mode */}
              {form.plan_mode === 'single' && (
                <FField t={t} label="Date">
                  <input style={s.inp} type="date" value={form.plan_date}
                    onChange={e => setForm(p => ({ ...p, plan_date: e.target.value }))} required />
                </FField>
              )}
              {form.plan_mode === 'weekly' && (
                <FField t={t} label="Start Date (Monday)" wide>
                  <input style={s.inp} type="date" value={form.start_date}
                    onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} required />
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 6 }}>
                    Creates plans for 7 consecutive days (Mon–Sun). For a shorter range (e.g. Mon–Fri), use Custom Range.
                  </div>
                </FField>
              )}
              {form.plan_mode === 'monthly' && (
                <FField t={t} label="Start Date (1st of month)">
                  <input style={s.inp} type="date" value={form.start_date}
                    onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} required />
                </FField>
              )}
              {form.plan_mode === 'custom_range' && (
                <>
                  <FField t={t} label="Start Date">
                    <input style={s.inp} type="date" value={form.start_date}
                      onChange={e => setForm(p => ({ ...p, start_date: e.target.value }))} required />
                  </FField>
                  <FField t={t} label="End Date">
                    <input style={s.inp} type="date" value={form.end_date}
                      onChange={e => setForm(p => ({ ...p, end_date: e.target.value }))} required />
                  </FField>
                </>
              )}

              <FField t={t} label="Shift Coverage" wide>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {[
                    { id: 'single', label: 'Single shift' },
                    { id: 'custom', label: 'Pick shifts' },
                    { id: 'all', label: 'All shifts (full day)' },
                  ].map((opt) => (
                    <button key={opt.id} type="button"
                      onClick={() => setForm((p) => ({
                        ...p,
                        shift_scope: opt.id,
                        selected_shifts: opt.id === 'all'
                          ? enabledShifts.map((s) => s.id)
                          : (p.selected_shifts?.length ? p.selected_shifts : [p.shift]),
                      }))}
                      style={{
                        ...s.modeBtn,
                        padding: '6px 12px',
                        ...(form.shift_scope === opt.id ? s.modeBtnActive : s.modeBtnInactive),
                      }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
                {form.shift_scope === 'single' && (
                  <select style={s.inp} value={form.shift}
                    onChange={(e) => setForm((p) => ({ ...p, shift: e.target.value, selected_shifts: [e.target.value] }))}>
                    {enabledShifts.length === 0 ? (
                      <option value="">No shifts configured</option>
                    ) : enabledShifts.map((sh) => (
                      <option key={sh.id} value={sh.id}>{sh.name} ({sh.start}–{sh.end})</option>
                    ))}
                  </select>
                )}
                {form.shift_scope === 'custom' && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {enabledShifts.map((sh) => {
                      const checked = (form.selected_shifts || []).includes(sh.id);
                      return (
                        <label key={sh.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textMuted, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setForm((p) => {
                                const cur = new Set(p.selected_shifts || []);
                                if (e.target.checked) cur.add(sh.id);
                                else cur.delete(sh.id);
                                const next = [...cur];
                                return {
                                  ...p,
                                  selected_shifts: next.length ? next : [sh.id],
                                  shift: next[0] || p.shift,
                                };
                              });
                            }}
                          />
                          {sh.name} ({sh.start}–{sh.end})
                        </label>
                      );
                    })}
                  </div>
                )}
                {form.shift_scope === 'all' && (
                  <div style={{ fontSize: 12, color: t.textDim }}>
                    Creates one plan per shift per day: {enabledShifts.map((s) => s.name).join(', ') || '—'}
                  </div>
                )}
                <div style={{ fontSize: 11, color: t.textFaint, marginTop: 6 }}>
                  Qty applies per shift slot (e.g. 500 pcs × 2 shifts = 2 plans of 500 each).
                </div>
              </FField>
              <FField t={t} label="Station No">
                <select style={s.inp} value={form.station_no || ''}
                  disabled={form.use_machine || stations.length === 0}
                  onChange={e => setForm(p => ({ ...p, station_no: parseInt(e.target.value), machine_id: '' }))}>
                  {stations.length === 0 ? (
                    <option value="">No stations available</option>
                  ) : (
                    stations.map(station => (
                      <option key={station.id} value={station.id}>
                        {station.display_name || station.name}
                      </option>
                    ))
                  )}
                </select>
              </FField>
              <FField t={t} label="Select Machine">
                <select style={s.inp} value={form.machine_id}
                  onChange={e => setForm(p => ({ ...p, machine_id: e.target.value }))}>
                  <option value="">— Any machine in station —</option>
                  {machines
                    .filter(m => !form.station_no || m.station_id === parseInt(form.station_no, 10))
                    .map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <MachineSuggestions
                  t={t}
                  partId={null}
                  modelVariant={form.model_variant}
                  enabled={form.enable_machine_suggestions}
                  machines={machines}
                  onSelectMachine={(machineId, stationId) => setForm((p) => ({
                    ...p,
                    machine_id: String(machineId),
                    station_no: stationId || p.station_no,
                  }))}
                />
              </FField>

              <FField t={t} label="Mold Master *" wide>
                <select
                  style={s.inp}
                  value={form.mold_id}
                  required
                  onChange={(e) => applyMoldToForm(e.target.value)}
                >
                  <option value="">— Select mold —</option>
                  {molds.map((m) => (
                    <option key={m.id} value={m.id}>{moldOptionLabel(m)}</option>
                  ))}
                </select>
              </FField>
              <FField t={t} label="Mold Name">
                <input style={{ ...s.inp, background: t.surface2 }} readOnly
                  value={selectedMold?.tool_name || selectedMold?.mold_name || ''}
                  placeholder="From mold master" />
              </FField>

              <div style={{
                gridColumn: '1 / -1',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 12,
                padding: 12,
                borderRadius: 8,
                background: t.surface2,
                border: `1px solid ${t.border}`,
              }}>
                <div style={{ gridColumn: '1 / -1', fontSize: 12, fontWeight: 700, color: t.accent }}>
                  Mold details (from mold master)
                  <span style={{ marginLeft: 8, fontWeight: 500, color: t.textDim }}>
                    Read-only except highlighted fields — edit master data in Mold Management
                  </span>
                </div>

                {/* Editable / derived — highlighted */}
                <div style={{
                  gridColumn: '1 / -1',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  gap: 12,
                }}>
                  <div style={{
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #f59e0b',
                    background: 'rgba(245, 158, 11, 0.10)',
                    boxShadow: 'inset 0 0 0 1px rgba(245, 158, 11, 0.15)',
                  }}>
                    <FField t={t} label="Running Cavity (editable)">
                      <input
                        style={{
                          ...s.inp,
                          border: '1px solid #f59e0b',
                          background: t.inp,
                          fontWeight: 700,
                        }}
                        type="number"
                        min="0"
                        value={form.running_cavity}
                        onChange={(e) => setForm((p) => ({ ...p, running_cavity: e.target.value }))}
                      />
                    </FField>
                  </div>
                  <div style={{
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #38bdf8',
                    background: 'rgba(56, 189, 248, 0.10)',
                    boxShadow: 'inset 0 0 0 1px rgba(56, 189, 248, 0.15)',
                  }}>
                    <FField t={t} label="Prod Plan (from Plan Mode)">
                      <input
                        style={{
                          ...s.inp,
                          border: '1px solid #38bdf8',
                          background: t.bg,
                          fontWeight: 700,
                          color: t.accent,
                        }}
                        readOnly
                        value={prodPlanFromMode(form.plan_mode)}
                      />
                      <div style={{ fontSize: 10, color: t.textDim, marginTop: 4 }}>
                        Changes when you pick Single Day / Weekly / Monthly / Custom Range above
                      </div>
                    </FField>
                  </div>
                  <div style={{
                    padding: 10,
                    borderRadius: 8,
                    border: '1px solid #f59e0b',
                    background: 'rgba(245, 158, 11, 0.10)',
                    boxShadow: 'inset 0 0 0 1px rgba(245, 158, 11, 0.15)',
                  }}>
                    <FField t={t} label="Cavity Name (editable)">
                      <select
                        style={{
                          ...s.inp,
                          border: '1px solid #f59e0b',
                          background: form.cavity_change ? t.inp : t.bg,
                          fontWeight: 600,
                        }}
                        value={form.cavity_id || form.cavity_name || ''}
                        disabled={!form.cavity_change}
                        onChange={(e) => {
                          const val = e.target.value;
                          const cav = moldCavities.find((c) => String(c.id) === String(val) || c.name === val);
                          setForm((p) => ({
                            ...p,
                            cavity_id: cav?.id || '',
                            cavity_name: cav?.name || val,
                            part_no: cav?.part_no || p.part_no,
                          }));
                        }}
                      >
                        <option value="">{form.cavity_name || '— Select cavity —'}</option>
                        {moldCavities.map((c) => (
                          <option key={c.id || c.name} value={c.id || c.name}>
                            {c.name}{c.part_no ? ` (${c.part_no})` : ''}
                          </option>
                        ))}
                      </select>
                      <label style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 8,
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#f59e0b',
                      }}>
                        <input
                          type="checkbox"
                          checked={!!form.cavity_change}
                          onChange={(e) => setForm((p) => ({ ...p, cavity_change: e.target.checked }))}
                        />
                        Cavity name change (enable to select another cavity)
                      </label>
                    </FField>
                  </div>
                </div>

                {/* Mold master — read only */}
                <FField t={t} label="Part No">
                  <input style={{ ...s.inp, background: t.bg, opacity: 0.95 }} readOnly value={form.part_no} />
                </FField>
                <FField t={t} label="Standard Cavity">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.standard_cavity} />
                </FField>
                <FField t={t} label="Customer Name">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.customer_name} />
                </FField>
                <FField t={t} label="RM Grade">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.rm_grade} />
                </FField>
                <FField t={t} label="Standard Cycle Time (sec)">
                  <input
                    style={{ ...s.inp, background: t.bg }}
                    readOnly
                    value={form.process_time === '' || form.process_time == null || Number.isNaN(Number(form.process_time)) ? '' : form.process_time}
                  />
                </FField>
                <FField t={t} label="Batch / GRN No">
                  <input
                    style={s.inp}
                    value={form.batch_grn_no}
                    onChange={(e) => setForm((p) => ({ ...p, batch_grn_no: e.target.value }))}
                    placeholder="Plan-level batch / GRN"
                  />
                </FField>
                <FField t={t} label="Std Shot Weight">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.std_shot_weight} />
                </FField>
                <FField t={t} label="Colour">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.colour} />
                </FField>
                <FField t={t} label="Std. Part Weight">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.std_part_weight} />
                </FField>
                <FField t={t} label="Std Runner Weight">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.std_runner_weight} />
                </FField>
                <FField t={t} label="Target / Shift">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.target_per_shift} />
                </FField>
                <FField t={t} label="Mold Status">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.mold_status} />
                </FField>
                <FField t={t} label="Assigned By">
                  <input style={{ ...s.inp, background: t.bg }} readOnly value={form.assigned_by} />
                </FField>
                <FField t={t} label="Cycle Time CT (sec)">
                  <input
                    style={{ ...s.inp, background: t.bg, color: t.brand, fontWeight: 700 }}
                    readOnly
                    value={form.process_time === '' || form.process_time == null || Number.isNaN(Number(form.process_time)) ? '' : formatCtSeconds(form.process_time)}
                  />
                </FField>
              </div>
              {shiftCapacityHints && (
                <div style={{ gridColumn: '1 / -1', padding: 12, borderRadius: 8, background: t.surface2, border: `1px solid ${t.border}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: t.accent }}>
                        Shift production capacity
                        {selectedMachine ? ` · ${selectedMachine.name}` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>
                        Based on CT {formatCtSeconds(form.process_time)}s × running cavity {shiftCapacityHints.runningCavity}
                        {' '}(pcs = shots × cavity) and net shift hours (breaks deducted)
                      </div>
                    </div>
                    {shiftCapacityHints.suggestedQty > 0 && (
                      <button
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, planned_qty: shiftCapacityHints.suggestedQty }))}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 6,
                          border: '1px solid #10b981',
                          background: '#10b98118',
                          color: '#10b981',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Apply {shiftCapacityHints.suggestedQty} pcs/shift
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {shiftCapacityHints.perShift.map((row) => {
                      const shiftDef = selectedShifts.find((sh) => sh.id === row.shiftId);
                      return (
                        <div key={row.shiftId} style={{ fontSize: 11, color: t.textMuted, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <strong style={{ color: t.text }}>{row.shiftName}</strong>
                          <span>({shiftDef?.start}–{shiftDef?.end})</span>
                          <span>· {row.workingMinutes} min net</span>
                          <span>· {row.maxShots} shots × {row.runningCavity} cav</span>
                          <span>· max <strong style={{ color: '#0ea5e9' }}>{row.maxQty} pcs</strong>/shift</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>
                      Theoretical range: {shiftCapacityHints.theoreticalMin}
                      {shiftCapacityHints.theoreticalMin !== shiftCapacityHints.theoreticalMax
                        ? `–${shiftCapacityHints.theoreticalMax}`
                        : ''} pcs/shift
                    </span>
                    {selectedWorkOrder && shiftCapacityHints.woCapPerShift != null && (
                      <span>WO limit: <strong style={{ color: '#10b981' }}>{shiftCapacityHints.woCapPerShift} pcs</strong>/shift for this range</span>
                    )}
                    {shiftCapacityHints.suggestedQty > 0 && (
                      <span>
                        Suggested: <strong style={{ color: '#f59e0b' }}>{shiftCapacityHints.suggestedQty} pcs</strong>/shift
                        {selectedWorkOrder && shiftCapacityHints.suggestedQty < shiftCapacityHints.theoreticalMin
                          ? ' (WO-limited)'
                          : ''}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {!shiftCapacityHints && form.process_time && selectedShifts.length > 0 && (
                <div style={{ gridColumn: '1 / -1', fontSize: 11, color: t.textFaint }}>
                  Enter valid process time to see shift capacity estimate.
                </div>
              )}
              <FField t={t} label="Planned Qty (per shift slot)" wide>
                <input
                  style={s.inp}
                  type="number"
                  value={form.planned_qty === '' || form.planned_qty == null || Number.isNaN(Number(form.planned_qty))
                    ? ''
                    : form.planned_qty}
                  onChange={e => {
                    const v = e.target.value;
                    setForm((p) => ({
                      ...p,
                      planned_qty: v === '' ? '' : (Number.isNaN(parseInt(v, 10)) ? '' : parseInt(v, 10)),
                    }));
                  }}
                  required
                />
                {planCapacity.slotCount > 1 && (
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 6 }}>
                    {planCapacity.slotCount} plan slot(s) ({computePlanDayCount(form)} day(s) × {resolveFormShifts(form, enabledShifts).length} shift(s))
                    {planCapacity.perShiftQty > 0 && (
                      <> · total = <strong style={{ color: t.textMuted }}>{planCapacity.totalPlanned} pcs</strong></>
                    )}
                  </div>
                )}
                {selectedWorkOrder && planCapacity.maxPerShift != null && planCapacity.slotCount > 0 && (
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 4 }}>
                    WO capacity left: {selectedWorkOrder.unplanned_qty} pcs
                    · max per shift for this range: <strong style={{ color: '#10b981' }}>{planCapacity.maxPerShift} pcs</strong>
                  </div>
                )}
                {selectedWorkOrder && planCapacity.totalPlanned > (selectedWorkOrder.unplanned_qty ?? 0) && (
                  <span style={{ color: '#ef4444', fontSize: 11, display: 'block', marginTop: 4 }}>
                    Total ({planCapacity.totalPlanned} pcs) exceeds WO capacity ({selectedWorkOrder.unplanned_qty} pcs left to plan)
                  </span>
                )}
              </FField>
              <FField t={t} label="Priority (1=High)">
                <input
                  style={s.inp}
                  type="number"
                  min="1"
                  max="10"
                  value={form.priority === '' || form.priority == null || Number.isNaN(Number(form.priority))
                    ? ''
                    : form.priority}
                  onChange={e => {
                    const v = e.target.value;
                    setForm((p) => ({
                      ...p,
                      priority: v === '' ? '' : (Number.isNaN(parseInt(v, 10)) ? '' : parseInt(v, 10)),
                    }));
                  }}
                />
              </FField>
              <FField t={t} label="Type">
                <select style={s.inp} value={form.plan_type} onChange={e => setForm(p => ({ ...p, plan_type: e.target.value }))}>
                  <option value="scheduled">Scheduled</option>
                  <option value="urgent">Urgent</option>
                  <option value="trial">Trial (concurrent — allows running alongside existing plan)</option>
                </select>
                {form.plan_type === 'trial' && (
                  <div style={{ fontSize: 11, color: '#8b5cf6', marginTop: 4, padding: '4px 8px',
                                background: '#8b5cf615', borderRadius: 4, border: '1px solid #8b5cf644' }}>
                    ⚠ Trial mode: this plan will run concurrently with any existing running plan on the same machine.
                    For normal production, use Scheduled — it will auto-pause the previous plan.
                  </div>
                )}
              </FField>
              <FField t={t} label="Notes" wide><input style={s.inp} value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes..." /></FField>
            </div>
            {msg && (
              <p style={{
                color: msgIsError ? '#ef4444' : msgIsWait ? '#b45309' : t.brand,
                fontSize: 13,
                fontWeight: 600,
              }}
              >
                {msg}
              </p>
            )}
            <button style={s.submitBtn} type="submit">
              {form.plan_mode === 'single' && '✓ Create Plan'}
              {form.plan_mode === 'weekly' && '✓ Create Weekly Plan'}
              {form.plan_mode === 'monthly' && '✓ Create Monthly Plan'}
              {form.plan_mode === 'custom_range' && '✓ Create Plan Range'}
            </button>
          </form>
        </div>
      )}

      {/* Filters - Enhanced with date range and historic quick select */}
      <div style={s.filterBar}>
        <div style={s.filterSection}>
          <label style={{ color: t.textMuted, fontSize: 11, fontWeight: 600, marginRight: 8 }}>View Period:</label>
          <div style={s.viewBtns}>
            {['day','week','month'].map(v => (
              <button key={v} style={{ ...s.vBtn, ...(viewMode === v && !filters.use_date_range ? s.vBtnActive : {}) }}
                onClick={() => {
                  setViewMode(v);
                  clearHistoricMode();
                }}>
                {v.charAt(0).toUpperCase()+v.slice(1)}
              </button>
            ))}
            <button style={{ ...s.vBtn, ...(filters.use_date_range ? s.vBtnActive : {}) }}
              onClick={() => setFilters(p => ({ ...p, use_date_range: !p.use_date_range }))}>
              📋 Date Range
            </button>
          </div>
        </div>

        {/* Historic Data Quick Select */}
        <div style={s.filterSection}>
          <label style={{ color: t.textMuted, fontSize: 11, fontWeight: 600, marginRight: 8 }}>Historic Data:</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button style={{ ...s.histBtn, ...(historicMode === 'prev_day' ? s.histBtnActive : {}) }}
              onClick={() => setHistoricMode(historicMode === 'prev_day' ? null : 'prev_day')} title="View previous day data">
              ← Prev Day
            </button>
            <button style={{ ...s.histBtn, ...(historicMode === 'prev_week' ? s.histBtnActive : {}) }}
              onClick={() => setHistoricMode(historicMode === 'prev_week' ? null : 'prev_week')} title="View previous week data">
              ← Prev Week
            </button>
            <button style={{ ...s.histBtn, ...(historicMode === 'prev_month' ? s.histBtnActive : {}) }}
              onClick={() => setHistoricMode(historicMode === 'prev_month' ? null : 'prev_month')} title="View previous month data">
              ← Prev Month
            </button>
          </div>
        </div>

        {/* Date Range Inputs */}
        {filters.use_date_range && (
          <div style={s.filterSection}>
            <label style={{ color: t.textMuted, fontSize: 11, fontWeight: 600, marginRight: 8 }}>Date Range:</label>
            <input style={s.inp} type="date" value={filters.start_date}
              onChange={e => setFilters(p => ({ ...p, start_date: e.target.value }))} />
            <span style={{ color: t.textDim, padding: '0 8px', alignSelf: 'center' }}>to</span>
            <input style={s.inp} type="date" value={filters.end_date}
              onChange={e => setFilters(p => ({ ...p, end_date: e.target.value }))} />
            {daysDiff > 0 && <span style={{ color: t.textMuted, fontSize: 11, alignSelf: 'center' }}>({daysDiff} days)</span>}
          </div>
        )}

        {/* Standard date filters when not using range */}
        {!filters.use_date_range && (
          <div style={s.filterSection}>
            {viewMode === 'day' && <input style={s.inp} type="date" value={filters.plan_date}
              onChange={e => setFilters(p => ({ ...p, plan_date: e.target.value }))} />}
            {viewMode === 'month' && (
              <select style={s.inp} value={filters.month} onChange={e => setFilters(p => ({ ...p, month: e.target.value }))}>
                <option value="">All Months</option>
                {MONTHS.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
              </select>
            )}
            <select style={s.inp} value={filters.year} onChange={e => setFilters(p => ({ ...p, year: e.target.value }))}>
              {[2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        )}

        {/* Common filters */}
        <div style={s.filterSection}>
          <select style={s.inp} value={filters.shift} onChange={e => setFilters(p => ({ ...p, shift: e.target.value }))}>
            <option value="">All Shifts</option>
            {enabledShifts.map(sh => (
              <option key={sh.id} value={sh.id}>{sh.name}</option>
            ))}
          </select>
          <select style={s.inp} value={filters.station_no} onChange={e => setFilters(p => ({ ...p, station_no: e.target.value }))}>
            <option value="">All Stations</option>
            {stations.map(station => (
              <option key={station.id} value={station.id}>
                {station.display_name || station.name || `Station ${station.id}`}
              </option>
            ))}
          </select>
        </div>

        {/* Display active filter info */}
        {historicMode && (
          <div style={s.histInfoBadge}>
            {historicMode === 'prev_day' && '📅 Viewing previous day'}
            {historicMode === 'prev_week' && '📆 Viewing previous week'}
            {historicMode === 'prev_month' && '📊 Viewing previous month'}
          </div>
        )}
        {filters.use_date_range && !historicMode && (
          <div style={s.histInfoBadge}>
            📋 Viewing {daysDiff} days ({filters.start_date} to {filters.end_date})
          </div>
        )}
      </div>

      {/* Summary KPIs */}
      {summary && (
        <div style={s.kpiRow}>
          {[
            { label: 'Total Plans',  value: summary.total_plans,   color: '#64748b' },
            { label: 'Planned Qty',  value: summary.total_planned, color: '#0ea5e9' },
            { label: 'Actual Qty',   value: summary.total_actual,  color: '#8b5cf6' },
            { label: 'Achievement',  value: summary.achievement_pct + '%',
              color: summary.achievement_pct >= 90 ? '#10b981' : summary.achievement_pct >= 70 ? '#f59e0b' : '#ef4444' },
            { label: 'Running',   value: summary.by_status?.running   || 0, color: '#0ea5e9' },
            { label: 'Completed', value: summary.by_status?.completed || 0, color: '#10b981' },
            { label: 'Pending',   value: summary.by_status?.pending   || 0, color: '#64748b' },
          ].map(k => (
            <div key={k.label} style={{ ...s.kpi, borderTop: `3px solid ${k.color}` }}>
              <div style={{ color: k.color, fontSize: 22, fontWeight: 700 }}>{k.value}</div>
              <div style={{ color: t.textMuted, fontSize: 11, marginTop: 4 }}>{k.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Pipeline View per Station */}
      {Object.keys(pipeline).length > 0 && (
        <div className={surfaceClass(t)} style={s.card}>
          <h4 style={s.cardTitle}>🔁 Production Pipeline (Next to Load)</h4>
          <div style={s.pipelineGrid}>
            {Object.entries(pipeline).map(([stationNo, queue]) => (
              <div key={stationNo} className={surfaceClass(t, 'nested')} style={s.pipelineCol}>
                <div style={s.pipelineHeader}>{getStationLabel(parseInt(stationNo))}</div>
                {queue.length === 0 && <div style={s.pipelineEmpty}>Queue empty</div>}
                {queue.map((p, idx) => {
                  const partLabel = p.mold_label || p.mold_name || planModelVariant(p, parts) || p.model_variant;
                  const cavityLabel = p.mold_details?.cavity_name || p.next_operation;
                  const wo = workOrders.find(w => w.id === p.work_order_id);
                  const canStart = isPlanDateReached(p.plan_date);
                  return (
                  <div key={p.id} className={surfaceClass(t, 'raised')} style={{ ...s.pipelineItem, borderLeft: `3px solid ${idx === 0 ? t.accent : t.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: idx === 0 ? t.accent : t.textMuted, fontWeight: idx === 0 ? 700 : 400, fontSize: 13 }}>
                        {idx === 0 ? '▶ ' : `${idx+1}. `}{partLabel || p.current_operation}
                      </span>
                      <span style={{ ...s.typeBadge, background: TYPE_CFG[p.plan_type]?.color + '33',
                                     color: TYPE_CFG[p.plan_type]?.color }}>
                        {p.plan_type}
                      </span>
                    </div>
                    {cavityLabel && cavityLabel !== '-' && (
                      <div style={{ color: t.textDim, fontSize: 11 }}>Cavity: {cavityLabel}</div>
                    )}
                    {wo && (
                      <div style={{ marginTop: 2 }}>
                        <Link to={`/work-orders?id=${wo.id}`}
                          style={{ ...woLinkStyle, fontSize: 11 }}
                          title="View work order">
                          📋 <strong style={{ color: WO_LINK_COLOR }}>{wo.work_order_no}</strong>
                        </Link>
                      </div>
                    )}
                    {partLabel && (
                      <div style={{ color: t.text, fontSize: 11, fontWeight: 600, marginTop: 2 }}>
                        {partLabel}
                      </div>
                    )}
                    <div style={{ color: t.textMuted, fontSize: 11 }}>
                      Planned: {p.planned_qty} | CT: {formatCtSeconds(p.process_time)}s | {p.shift} | {p.plan_date}
                    </div>
                    {idx === 0 && p.status === 'pending' && p.awaiting_model_change && (
                      <span title="Approve on Model Change page to start plan and apply part on WI"
                        style={{ fontSize: 10, color: '#f59e0b', marginTop: 4, display: 'inline-block', fontWeight: 600 }}>
                        ⏳ Awaiting model change approval{p.model_change_request_id ? ` #${p.model_change_request_id}` : ''}
                      </span>
                    )}
                    {idx === 0 && p.status === 'pending' && canEdit && canStart && !p.awaiting_model_change && (
                      <button style={{ ...s.miniBtn, background: t.accent, marginTop: 4 }}
                        onClick={() => setStatus(p.id, 'running')}>▶ Start</button>
                    )}
                    {idx === 0 && p.status === 'pending' && canEdit && !canStart && !p.awaiting_model_change && (
                      <span title={`Start allowed on or after ${p.plan_date}`}
                        style={{ fontSize: 10, color: t.textFaint, marginTop: 4, display: 'inline-block' }}>
                        🔒 Starts {p.plan_date}
                      </span>
                    )}
                  </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Plans Table */}
      <div className={surfaceClass(t)} style={s.card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <h4 style={{ ...s.cardTitle, margin: 0 }}>All Plans ({plans.length})</h4>
          {canEdit && selectedPlanIds.size > 0 && (
            <>
              <button onClick={() => bulkMovePlans(7)}
                style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: t.brand, color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                Move {selectedPlanIds.size} → Next Week
              </button>
              <button onClick={() => setSelectedPlanIds(new Set())}
                style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2, color: t.textMuted, cursor: 'pointer', fontSize: 12 }}>
                Clear selection
              </button>
            </>
          )}
          {canEdit && (
            <button onClick={selectMovablePlans}
              style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2, color: t.textMuted, cursor: 'pointer', fontSize: 12 }}>
              Select pending/paused
            </button>
          )}
          <input
            style={{ padding: '5px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
                     background: t.inp, color: t.text, fontSize: 13, minWidth: 220 }}
            placeholder="Search model, variant, station, shift, status…"
            value={planSearch}
            onChange={e => setPlanSearch(e.target.value)}
          />
          {planSearch && (
            <button onClick={() => setPlanSearch('')}
              style={{ padding: '4px 8px', borderRadius: 6, border: `1px solid ${t.border}`,
                       background: t.surface2, color: t.textMuted, cursor: 'pointer', fontSize: 12 }}>✕</button>
          )}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                {canEdit && <th style={s.th}>☑</th>}
                {['Date','Shift','Station','Machine','Work Order','Mold','Cavity','CT(s)','Type','Priority',
                  'Planned','Actual','%','Status','Actions'].map(h =>
                  <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {plans.filter(p => {
                if (!planSearch.trim()) return true;
                const q = planSearch.toLowerCase();
                const variant = (planModelVariant(p, parts) || p.model_variant || p.mold_label || '').toLowerCase();
                const machineName = (machines.find(m => m.id === p.machine_id)?.name || '').toLowerCase();
                const cavity = (p.mold_details?.cavity_name || p.next_operation || '').toLowerCase();
                return (
                  variant.includes(q) ||
                  cavity.includes(q) ||
                  (p.mold_name || '').toLowerCase().includes(q) ||
                  (p.current_operation || '').toLowerCase().includes(q) ||
                  (p.next_operation || '').toLowerCase().includes(q) ||
                  getStationLabel(p.station_no).toLowerCase().includes(q) ||
                  machineName.includes(q) ||
                  (p.shift || '').toLowerCase().includes(q) ||
                  (p.status || '').toLowerCase().includes(q)
                );
              }).map(p => {
                const pct = p.planned_qty > 0 ? Math.round(p.actual_qty / p.planned_qty * 100) : 0;
                const cfg = STATUS_CFG[p.status];
                const wo = workOrders.find(w => w.id === p.work_order_id);
                const canComplete = isPlanDateReached(p.plan_date);
                const canStart = isPlanDateReached(p.plan_date);
                return (
                  <tr key={p.id}>
                    {canEdit && (
                      <td style={s.td}>
                        {['pending', 'paused'].includes(p.status) && (
                          <input type="checkbox" checked={selectedPlanIds.has(p.id)}
                            onChange={() => togglePlanSelect(p.id)} />
                        )}
                      </td>
                    )}
                    <td style={s.td}>{p.plan_date}</td>
                    <td style={s.td}>{p.shift}</td>
                    <td style={s.td}>{getStationLabel(p.station_no)}</td>
                    <td style={s.td}>{machines.find(m => m.id === p.machine_id)?.name || '—'}</td>
                    <td style={s.td}>
                      {wo ? (
                        <Link to={`/work-orders?id=${wo.id}`}
                          style={{ ...woLinkStyle, fontSize: 12 }}>
                          <strong style={{ color: WO_LINK_COLOR }}>{wo.work_order_no}</strong>
                        </Link>
                      ) : '—'}
                    </td>
                    <td style={s.td}>{p.mold_label || p.mold_name || planModelVariant(p, parts) || p.model_variant || '—'}</td>
                    <td style={s.td}>{p.mold_details?.cavity_name || p.next_operation || '—'}</td>
                    <td style={s.td}>{formatCtSeconds(p.process_time)}</td>
                    <td style={s.td}>
                      <span style={{ ...s.typeBadge, background: TYPE_CFG[p.plan_type]?.color + '33',
                                     color: TYPE_CFG[p.plan_type]?.color }}>
                        {p.plan_type}
                      </span>
                    </td>
                    <td style={s.td}>{p.priority}</td>
                    <td style={s.td}>{p.planned_qty}</td>
                    <td style={s.td}>
                      {actualEdit.id === p.id ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input style={{ ...s.inp, width: 70, padding: '3px 6px' }} type="number"
                            value={actualEdit.qty} onChange={e => setActualEdit(v => ({ ...v, qty: e.target.value }))} />
                          <button style={{ ...s.miniBtn, background: t.brand }} onClick={() => saveActual(p.id)}>✓</button>
                          <button style={{ ...s.miniBtn, background: t.textFaint }} onClick={() => setActualEdit({ id: null, qty: '' })}>✕</button>
                        </div>
                      ) : (
                        <span style={{ cursor: 'pointer', color: t.text }}
                          onClick={() => setActualEdit({ id: p.id, qty: p.actual_qty })}>
                          {p.actual_qty}
                        </span>
                      )}
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, height: 6, background: t.scrollTrack, borderRadius: 3, minWidth: 50 }}>
                          <div style={{ width: `${Math.min(pct,100)}%`, height: '100%', borderRadius: 3,
                                        background: pct >= 100 ? '#10b981' : pct >= 70 ? '#f59e0b' : '#0ea5e9' }} />
                        </div>
                        <span style={{ color: t.textMuted, fontSize: 11 }}>{pct}%</span>
                      </div>
                    </td>
                    <td style={s.td}>
                      <span style={{ ...s.statusBadge, background: cfg?.color + '22', color: cfg?.color }}>
                        {cfg?.icon} {cfg?.label}
                      </span>
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {p.status === 'pending' && p.awaiting_model_change && (
                          <span title="Awaiting model change approval" style={{ fontSize: 10, color: '#f59e0b', fontWeight: 600 }}>
                            ⏳ MC #{p.model_change_request_id || '—'}
                          </span>
                        )}
                        {p.status === 'pending' && canEdit && canStart && !p.awaiting_model_change && (
                          <button style={{ ...s.miniBtn, background: t.accent }} title="Start — raises Model Change if part differs"
                            onClick={() => setStatus(p.id, 'running')}>▶</button>
                        )}
                        {p.status === 'pending' && canEdit && !canStart && !p.awaiting_model_change && (
                          <span title={`Start allowed on or after ${p.plan_date}`}
                            style={{ fontSize: 10, color: t.textFaint, alignSelf: 'center' }}>🔒</span>
                        )}
                        {p.status === 'running' && (
                          <>
                            <button style={{ ...s.miniBtn, background: '#f59e0b' }} title="Pause"
                              onClick={() => setStatus(p.id, 'paused')}>⏸</button>
                            {canEdit && canComplete && (
                              <button style={{ ...s.miniBtn, background: t.brand }} title="Mark completed"
                                onClick={() => setStatus(p.id, 'completed')}>✓</button>
                            )}
                            {canEdit && !canComplete && (
                              <span title={`Completion allowed on or after ${p.plan_date}`}
                                style={{ fontSize: 10, color: t.textFaint, alignSelf: 'center' }}>🔒 {p.plan_date}</span>
                            )}
                          </>
                        )}
                        {p.status === 'paused' && canStart && (
                          <button style={{ ...s.miniBtn, background: t.accent }} title="Resume"
                            onClick={() => setStatus(p.id, 'running')}>▶</button>
                        )}
                        {p.status === 'paused' && !canStart && (
                          <span title={`Resume allowed on or after ${p.plan_date}`}
                            style={{ fontSize: 10, color: t.textFaint, alignSelf: 'center' }}>🔒</span>
                        )}
                        {canEdit && ['paused', 'running'].includes(p.status) && (
                          <button
                            style={{ ...s.miniBtn, background: '#9f1239' }}
                            title="Abort — permanently stop this plan (will not resume)"
                            onClick={() => {
                              if (window.confirm(
                                `Abort plan #${p.id}?\n\n`
                                + 'This permanently stops the plan. It will not resume.',
                              )) {
                                setStatus(p.id, 'aborted');
                              }
                            }}
                          >⏹</button>
                        )}
                        {canEdit && ['pending', 'paused'].includes(p.status) && (
                          <button style={{ ...s.miniBtn, background: '#6366f1' }} title="Edit / reschedule"
                            onClick={() => setMovePlan(p)}>✎</button>
                        )}
                        {canEdit && !['completed', 'aborted', 'incomplete'].includes(p.status) && (
                          <button style={{ ...s.miniBtn, background: '#ef4444' }} title="Delete"
                            onClick={() => deletePlan(p.id)}>🗑</button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FField({ label, children, wide, t }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: wide ? 'span 2' : 'span 1' }}>
      <label style={{ color: t?.textDim, fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}

function getStyles(t) {
  return {
    page: { padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text },
    addBtn: { padding: '8px 20px', background: t.accent, color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    exportBtn: { padding: '8px 20px', background: t.brand, color: '#fff', border: 'none',
                 borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    infoBtn: { width: 30, height: 30, borderRadius: '50%', border: `1px solid ${t.border}`,
               background: t.surface, color: t.accent, cursor: 'pointer', fontSize: 15,
               fontWeight: 700, lineHeight: 1, flexShrink: 0 },
    closeBtn: { background: 'none', border: 'none', color: t.textDim, cursor: 'pointer',
                fontSize: 16, padding: '2px 6px' },
    card: { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 },
    cardTitle: { color: t.accent, margin: '0 0 14px', fontSize: 14, fontWeight: 600 },
    formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 14 },
    inp: { padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`, background: t.inp,
           color: t.text, fontSize: 13 },
    submitBtn: { padding: '9px 28px', background: t.brand, color: '#fff', border: 'none',
                 borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' },
    viewBtns: { display: 'flex', gap: 4 },
    vBtn: { padding: '6px 14px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface,
            color: t.textMuted, cursor: 'pointer', fontSize: 13 },
    vBtnActive: { background: t.accent, color: '#fff', border: `1px solid ${t.accent}` },
    kpiRow: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 },
    kpi: { background: t.surface, borderRadius: 10, padding: '14px 18px', flex: 1, minWidth: 100 },
    pipelineGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
    pipelineCol: { background: t.surface2, borderRadius: 8, padding: 12 },
    pipelineHeader: { color: t.accent, fontWeight: 700, fontSize: 13, marginBottom: 8,
                      borderBottom: `1px solid ${t.border}`, paddingBottom: 6 },
    pipelineEmpty: { color: t.textFaint, fontSize: 12, fontStyle: 'italic' },
    pipelineItem: { padding: '8px 10px', marginBottom: 6, background: t.surfaceRaised ?? t.surface, borderRadius: 6 },
    typeBadge: { padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 600 },
    miniBtn: { padding: '3px 8px', border: 'none', borderRadius: 4, color: '#fff',
               cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { padding: '9px 8px', background: t.surface2, color: t.textDim, textAlign: 'left', whiteSpace: 'nowrap' },
    td: { padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted, whiteSpace: 'nowrap' },
    statusBadge: { padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 },
    plcCard: { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16,
               border: `1px solid ${t.border}` },
    plcGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 },
    plcItem: { background: t.surface2, borderRadius: 6, padding: '10px 12px' },
    // New styles for enhanced planning features
    filterSection: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
    modeBtn: { padding: '10px 12px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface,
               cursor: 'pointer', textAlign: 'center', transition: 'all 0.2s' },
    modeBtnActive: { background: t.accent, color: '#fff', border: `1px solid ${t.accent}` },
    modeBtnInactive: { color: t.textMuted, hover: { background: t.border } },
    histBtn: { padding: '6px 12px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface,
               color: t.textMuted, cursor: 'pointer', fontSize: 13, fontWeight: 500 },
    histBtnActive: { background: t.brand, color: '#fff', border: `1px solid ${t.brand}` },
    histInfoBadge: { padding: '6px 12px', borderRadius: 6, background: t.brand + '33', color: t.brand,
                     fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  };
}

