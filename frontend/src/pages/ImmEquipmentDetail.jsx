import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import api from '../api/client';
import { assetUrl } from '../api/config';
import PageHeader from '../components/PageHeader';
import ImmDashboardSelector from '../components/ImmDashboardSelector';
import Donut3D, { DONUT_CANVAS } from '../components/charts/Donut3D';
import { pulseLeadShape } from '../components/charts/pulseLeadLineShape.jsx';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useConfig, getCurrentShift } from '../context/ConfigContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';

const TIME_PRESETS = [
  { label: '30 min', hours: 0.5, value: '0.5' },
  { label: '1 hour', hours: 1, value: '1' },
  { label: '6 hours', hours: 6, value: '6' },
  { label: '24 hours', hours: 24, value: '24' },
  { label: 'Custom range', hours: null, value: 'custom' },
];

const toLocalInputValue = (d) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const defaultCustomRange = () => {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  return { start: toLocalInputValue(start), end: toLocalInputValue(end) };
};

const CHART_TAGS = [
  { tag: 'injection_end', title: 'Injection End Point' },
  { tag: 'max_pressure', title: 'Max Injection Pressure' },
  { tag: 'temp', title: 'Actual Temperature', tabs: [
    { tag: 'nozzle_temp', label: 'Nozzle' },
    { tag: 'barrel_temp', label: 'Barrel 1' },
  ]},
  { tag: 'charge_time', title: 'Feeding Time' },
];

// Guarantee there is no CJK (Chinese/Japanese/Korean) text rendered in this UI.
const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

export default function ImmEquipmentDetail() {
  const { machineId } = useParams();
  const navigate = useNavigate();
  const { theme: t } = useTheme();
  const { user } = useAuth();
  const { config } = useConfig();
  const canEdit = ['admin', 'superadmin', 'supervisor', 'maintenance'].includes(user?.role);

  const enabledShifts = useMemo(
    () => (config?.shifts || []).filter((sh) => sh.enabled !== false),
    [config],
  );
  const currentShift = useMemo(() => getCurrentShift(config) || enabledShifts[0] || null, [config, enabledShifts]);

  const [detail, setDetail] = useState(null);
  const [kpiv, setKpiv] = useState({});
  /** 'hours' | 'shift' | 'custom' — which range control drives KPIV fetch */
  const [rangeMode, setRangeMode] = useState('hours');
  const [hours, setHours] = useState(1);
  const [rangeSelect, setRangeSelect] = useState('1');
  const [customStart, setCustomStart] = useState(() => defaultCustomRange().start);
  const [customEnd, setCustomEnd] = useState(() => defaultCustomRange().end);
  const [appliedCustom, setAppliedCustom] = useState(() => defaultCustomRange());
  const [shiftId, setShiftId] = useState(null);
  const [tempTab, setTempTab] = useState('nozzle_temp');
  const [fullscreen, setFullscreen] = useState(null);
  const [moldSearch, setMoldSearch] = useState('');
  const [showMoldList, setShowMoldList] = useState(false);
  const [modals, setModals] = useState({});
  const [msg, setMsg] = useState('');
  const [siblings, setSiblings] = useState([]);
  const [dashSummary, setDashSummary] = useState(null);
  const [zoneMeta, setZoneMeta] = useState([]);
  const [kpivLoading, setKpivLoading] = useState(false);

  useEffect(() => {
    if (!shiftId && currentShift?.id) setShiftId(currentShift.id);
  }, [currentShift, shiftId]);

  const fetchDetail = useCallback(async () => {
    const r = await api.get(`/api/imm/equipment/${machineId}`);
    setDetail(r.data);
  }, [machineId]);

  const fetchKpiv = useCallback(async () => {
    setKpivLoading(true);
    try {
      const params = {};
      if (rangeMode === 'shift' && shiftId) {
        params.shift = shiftId;
      } else if (rangeMode === 'custom') {
        if (!appliedCustom.start || !appliedCustom.end) return;
        params.since = new Date(appliedCustom.start).toISOString();
        params.until = new Date(appliedCustom.end).toISOString();
      } else {
        params.hours = hours;
      }
      const r = await api.get(`/api/imm/equipment/${machineId}/kpiv`, { params });
      const data = r.data || {};
      // Strip meta so chart map stays tag-keyed
      const { _meta, ...series } = data;
      setKpiv(series);
    } finally {
      setKpivLoading(false);
    }
  }, [machineId, hours, rangeMode, shiftId, appliedCustom]);

  const fetchDash = useCallback(async () => {
    try {
      const [eq, zones] = await Promise.all([
        api.get(`/api/imm/dashboard/equipment/${machineId}`),
        api.get('/api/imm/dashboard/zones'),
      ]);
      setDashSummary(eq.data);
      setSiblings(eq.data?.siblings || []);
      setZoneMeta(zones.data?.zones || []);
    } catch {
      /* optional enrichment */
    }
  }, [machineId]);

  const refresh = useCallback(async () => {
    try {
      await Promise.all([fetchDetail(), fetchKpiv(), fetchDash()]);
      setMsg('');
    } catch (err) {
      setMsg(err.response?.data?.detail || err.message || 'Failed to load');
    }
  }, [fetchDetail, fetchKpiv, fetchDash]);

  const refreshLive = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => { refreshLive(); }, [refreshLive]);

  useEffect(() => {
    const id = setInterval(refreshLive, 10000);
    return () => clearInterval(id);
  }, [refreshLive]);

  const selectHours = (h) => {
    setRangeMode('hours');
    setHours(h);
    setRangeSelect(String(h));
  };

  const selectShift = (id) => {
    setRangeMode('shift');
    setShiftId(id);
  };

  const onRangeSelectChange = (value) => {
    setRangeSelect(value);
    if (value === 'custom') {
      const def = defaultCustomRange();
      setCustomStart(def.start);
      setCustomEnd(def.end);
      setAppliedCustom(def);
      setRangeMode('custom');
      return;
    }
    const preset = TIME_PRESETS.find((p) => p.value === value);
    if (preset?.hours != null) {
      setRangeMode('hours');
      setHours(preset.hours);
    }
  };

  const applyCustomRange = () => {
    if (!customStart || !customEnd) {
      setMsg('Select both start and end for custom range');
      return;
    }
    if (new Date(customStart) >= new Date(customEnd)) {
      setMsg('Custom range start must be before end');
      return;
    }
    setMsg('');
    setAppliedCustom({ start: customStart, end: customEnd });
    setRangeMode('custom');
    setRangeSelect('custom');
  };

  const machine = detail?.machine;
  const mold = detail?.active_mold;
  const components = detail?.components || [];
  const opcuaParams = detail?.opcua?.parameters || [];
  const opcuaHighlights = detail?.opcua?.highlights || {};
  const opcuaByKey = useMemo(() => {
    const map = { ...opcuaHighlights };
    opcuaParams.forEach((p) => {
      if (!p?.param_key) return;
      if (!map[p.param_key]) map[p.param_key] = p;
    });
    return map;
  }, [opcuaHighlights, opcuaParams]);
  const pv = useCallback((key) => {
    const row = opcuaByKey[key];
    if (!row) return null;
    const v = row.value_text ?? row.value_num;
    return v == null || v === '' ? null : v;
  }, [opcuaByKey]);
  const fmt = useCallback((key, unit = '') => {
    const v = pv(key);
    if (v == null) return '—';
    const n = Number(v);
    const text = Number.isFinite(n)
      ? n.toLocaleString('en-US', { maximumFractionDigits: 3 })
      : stripCjk(String(v));
    return unit ? `${text} ${unit}` : text;
  }, [pv]);
  const isOn = useCallback((key) => {
    const v = String(pv(key) ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'running';
  }, [pv]);
  const molds = useMemo(() => {
    const list = detail?.molds || [];
    if (!moldSearch.trim()) return list;
    const q = moldSearch.toLowerCase();
    return list.filter((m) => (m.mold_no || '').toLowerCase().includes(q));
  }, [detail, moldSearch]);

  const overviewHeader = useMemo(() => ({
    mold: stripCjk(pv('Actual_Mold_Name') || mold?.mold_no || mold?.master?.mold_name || '—'),
    material: stripCjk(pv('Actual_Material_Name') || mold?.master?.rm_grade || '—'),
    cavity: stripCjk(pv('Actual_Cavity_No') || mold?.master?.running_cavity || mold?.master?.active_cavity_name || '—'),
  }), [pv, mold]);

  const modeFlags = useMemo(() => ([
    { key: 'Auto_Mode', label: 'Auto Mode', on: isOn('Auto_Mode') },
    { key: 'Semi_Mode', label: 'Semi Mode', on: isOn('Semi_Mode') },
    { key: 'Manual_Mode', label: 'Manual Mode', on: isOn('Manual_Mode') },
    { key: 'Robot_Running_Status', label: 'Robot Status', on: isOn('Robot_Running_Status') },
  ]), [isOn]);

  const prodCounts = useMemo(() => ([
    { label: 'Prod Target Count', value: fmt('Production_Target_Count', 'Nos.') },
    { label: 'Act Prod Count', value: fmt('Actual_Production_Count', 'Nos.') },
    { label: 'Good Count', value: fmt('Total_Good_Count', 'Nos.') },
    { label: 'Bad Count', value: fmt('Total_Bad_Count', 'Nos.') },
  ]), [fmt]);

  const setActualRows = useMemo(() => ([
    { setLabel: 'Last Cycle Time', setKey: 'Last_Cycle_Time', actLabel: 'Act. Cycle Time', actKey: 'Actual_Cycle_Time', unit: 'Sec' },
    { setLabel: 'Set Nozzle Temp', setKey: 'Set_Nozzle_Temp', actLabel: 'Act Nozzle Temp', actKey: 'Actual_Nozzle_Temp', unit: '°C' },
    { setLabel: 'Set Cyl. 1 Temp.', setKey: 'Set_Cylender_1_Temp', actLabel: 'Act Cyl. 1 Temp.', actKey: 'Actual_Cylender_1_Temp', unit: '°C' },
    { setLabel: 'Set Cyl. 2 Temp.', setKey: 'Set_Cylender_2_Temp', actLabel: 'Act Cyl. 2 Temp.', actKey: 'Actual_Cylender_2_Temp', unit: '°C' },
    { setLabel: 'Set Cyl. 3 Temp.', setKey: 'Set_Cylender_3_Temp', actLabel: 'Act Cyl. 3 Temp.', actKey: 'Actual_Cylender_3_Temp', unit: '°C' },
    { setLabel: 'Set Cooling Time', setKey: 'Set_Cooling_Time', actLabel: 'Act Cooling Time', actKey: 'Actual_Cooling_Time', unit: 'Sec' },
    { setLabel: 'Set Injection Time', setKey: 'Set_Injection_Time', actLabel: 'Act Injection Time', actKey: 'Actual_Injection_Time', unit: 'Sec' },
    { setLabel: 'Set Clamp. Force', setKey: 'Set_Clamping_Force', actLabel: 'Act Clamp. Force', actKey: 'Actual_Clamping_Force', unit: 'Bar' },
  ]), []);

  const paramPairs = useMemo(() => ([
    [
      { label: 'Motor Status', key: 'Motor_Status', unit: '' },
      { label: 'Heater Status', key: 'Heater_Status', unit: '' },
    ],
    [
      { label: 'Act Charg. RPM', key: 'Actual_Charging_RPM', unit: 'RPM' },
      { label: 'Oil Temperature', key: 'Actual_Machine_Oil_Temp', unit: '°C' },
    ],
    [
      { label: 'Mould Open Time', key: 'Actual_Mold_Open_Time', unit: 'Sec' },
      { label: 'Mould Close Time', key: 'Actual_Mold_Close_Time', unit: 'Sec' },
    ],
    [
      { label: 'Act Eje Mode', key: 'Actual_Ejector_Mode', unit: '' },
      { label: 'Act Eje Position', key: 'Actual_Ejector_Position', unit: 'mm' },
    ],
    [
      { label: 'Act Charg. Pos.', key: 'Actual_Charging_Position', unit: 'mm' },
      { label: 'Act Charge Time', key: 'Actual_Charging_Time', unit: 'Sec' },
    ],
    [
      { label: 'Act Back Press.', key: 'Actual_Back_Pressure', unit: 'Bar' },
      { label: 'Act System Pres.', key: 'Actual_System_Pressure', unit: 'Bar' },
    ],
    [
      { label: 'Act System Flow', key: 'Actual_System_Flow', unit: '' },
      { label: 'Lubrication Status', key: 'Auto_Lubrication_Status', unit: '' },
    ],
    [
      { label: 'Set Hold Tran. Pos.', key: 'Set_Holding_Transfer_Position', unit: 'mm' },
      { label: 'Inj Cushion Mon.Pos', key: 'Actual_Injection_Cusion_Monitoring_Position', unit: 'mm' },
    ],
  ]), []);

  const s = styles(t);

  const openModal = (key, payload = {}) => setModals((p) => ({ ...p, [key]: payload }));
  const closeModal = (key) => setModals((p) => ({ ...p, [key]: null }));

  const saveNewMold = async (form) => {
    await api.post(`/api/imm/equipment/${machineId}/molds`, form);
    closeModal('addMold');
    await fetchDetail();
  };

  const saveMoldEdit = async (moldId, patch) => {
    await api.put(`/api/imm/molds/${moldId}`, patch);
    closeModal('editMold');
    await fetchDetail();
  };

  const changeMold = async (moldId) => {
    await api.post(`/api/imm/molds/${moldId}/activate`);
    closeModal('changeMold');
    setShowMoldList(false);
    await fetchDetail();
  };

  const resetMaint = async () => {
    if (!mold) return;
    await api.post(`/api/imm/molds/${mold.id}/reset-maintenance`);
    await fetchDetail();
  };

  const saveComponent = async (form) => {
    await api.post(`/api/imm/equipment/${machineId}/components`, form);
    closeModal('component');
    await fetchDetail();
  };

  const saveThreshold = async (tag, form) => {
    await api.put(`/api/imm/equipment/${machineId}/kpiv/${tag}/threshold`, form);
    closeModal('threshold');
    await fetchKpiv();
  };

  const recalculate = async (tag) => {
    await api.post(`/api/imm/equipment/${machineId}/kpiv/${tag}/recalculate`);
    await fetchKpiv();
  };

  if (!detail && !msg) {
    return <div className={pageClass(t)} style={s.page}><PageHeader title="EQUIPMENT DETAILS" /><div style={s.empty}>Loading…</div></div>;
  }

  return (
    <div className={pageClass(t)} style={s.page}>
      <style>{`
        @media (max-width: 960px) {
          .imm-equip-top-grid { grid-template-columns: 1fr !important; }
          .imm-kpiv-grid { grid-template-columns: 1fr !important; grid-template-rows: none !important; min-height: auto !important; }
        }
      `}</style>
      <PageHeader
        title={(
          <ImmDashboardSelector
            mode="equipment"
            factoryName={stripCjk(dashSummary?.factory_name || '')}
            factories={dashSummary?.factories || []}
            zoneName={stripCjk(dashSummary?.zone?.name || machine?.station_name || '')}
            zones={zoneMeta}
            equipmentName={stripCjk(machine?.name || '')}
            equipmentList={
              (dashSummary?.equipment_list?.length
                ? dashSummary.equipment_list
                : (siblings.length ? siblings : [{ id: Number(machineId), name: machine?.name || 'Equipment' }]))
            }
            selectedEquipmentId={Number(machineId)}
            onEquipmentChange={(id) => navigate(`/imm/equipment/${id}`)}
          />
        )}
        onRefresh={refreshLive}
        extra={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: t.textDim, fontWeight: 700 }}>Range</span>
            <select
              value={rangeSelect}
              onChange={(e) => onRangeSelectChange(e.target.value)}
              style={s.rangeSelect}
              title="KPIV chart time range"
            >
              {TIME_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            {rangeSelect === 'custom' && (
              <>
                <input
                  type="datetime-local"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  style={s.rangeInput}
                  title="Start"
                />
                <span style={{ fontSize: 11, color: t.textMuted }}>to</span>
                <input
                  type="datetime-local"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  style={s.rangeInput}
                  title="End"
                />
                <button type="button" style={s.chipActiveBtn} onClick={applyCustomRange}>
                  Apply
                </button>
              </>
            )}
            {enabledShifts.length > 0 && (
              <>
                <span style={{ width: 1, height: 18, background: t.border, margin: '0 2px' }} />
                <span style={{ fontSize: 11, color: t.textDim, fontWeight: 700 }}>Shift</span>
                <select
                  value={rangeMode === 'shift' && shiftId != null ? String(shiftId) : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) {
                      // Clear shift filter → fall back to selected range preset
                      if (rangeSelect === 'custom') {
                        setRangeMode('custom');
                      } else {
                        const preset = TIME_PRESETS.find((p) => p.value === rangeSelect);
                        setRangeMode('hours');
                        if (preset?.hours != null) setHours(preset.hours);
                      }
                      return;
                    }
                    selectShift(v);
                  }}
                  style={s.rangeSelect}
                  title="KPIV chart by shift window"
                >
                  <option value="">—</option>
                  {enabledShifts.map((sh) => (
                    <option key={sh.id} value={String(sh.id)}>
                      {sh.name || `Shift ${sh.id}`}{sh.start || sh.end ? ` (${sh.start || ''}-${sh.end || ''})` : ''}
                    </option>
                  ))}
                </select>
              </>
            )}
            {kpivLoading && (
              <span style={{ fontSize: 11, color: t.textMuted }}>Updating KPIV…</span>
            )}
          </div>
        )}
      />

      {msg && <div style={s.alert}>{msg}</div>}

      {dashSummary?.production && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
          {[
            ['Production Qty', dashSummary.production.quantity],
            ['UPH', dashSummary.production.uph],
            ['Actual CT (s)', dashSummary.production.actual_ct],
            ['CAV', dashSummary.production.actual_cav],
            ['Operate', dashSummary.equipment_info?.operate_status],
            ['Part / Material', dashSummary.equipment_info?.part_name],
          ].map(([label, val]) => (
            <div key={label} className={surfaceClass(t)} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ color: t.labelColor || t.accent, fontSize: 11 }}>{label}</div>
              <div style={{ color: t.text, fontWeight: 800, fontSize: 16 }}>{stripCjk(val ?? '—')}</div>
            </div>
          ))}
        </div>
      )}

      <div style={s.topGrid} className="imm-equip-top-grid">
        {/* Left: basic + mold */}
        <div style={s.leftCol}>
          <section className={surfaceClass(t)} style={s.card}>
            <h3 style={s.cardTitle}>Basic Information</h3>
            <div style={s.basicRow}>
              <div style={{
                ...s.machineImgWrap,
                borderColor: machine?.imm_status_color || t.border,
              }}>
                {machine?.image_url ? (
                  <img
                    src={assetUrl(machine.image_url)}
                    alt={stripCjk(machine?.name) || 'Machine'}
                    style={s.machineImg}
                  />
                ) : (
                  <span style={{ color: t.textFaint, fontSize: 13, textAlign: 'center', padding: 8 }}>
                    No image
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: t.text }}>{stripCjk(machine?.name)}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                    <span style={{
                      ...s.badge,
                      background: (machine?.imm_status_color || '#6b7280') + '33',
                      color: machine?.imm_status_color,
                    }} title="Machine status (Motor / Heater)">
                      Machine: {machine?.imm_status_label || '—'}
                    </span>
                    <span style={{
                      ...s.badge,
                      background: (machine?.kpiv_status_color || '#86efac') + '33',
                      color: machine?.kpiv_status_color || '#86efac',
                    }} title="KPIV / process status">
                      KPIV: {machine?.kpiv_status_label || 'Normal'}
                    </span>
                  </div>
                </div>
                <div style={s.meta}>Equipment type: <strong>{stripCjk(machine?.make || machine?.machine_type || '—')}</strong></div>
                <div style={s.meta}>{stripCjk(machine?.model_no || '')} {machine?.tonnage ? `· ${stripCjk(machine?.tonnage)}` : ''}</div>
                <div style={s.meta}>
                  PLC: <strong>{stripCjk(machine?.plc_source || 'manual')}</strong>
                  {machine?.plc_topic ? ` · SIE ${stripCjk(machine.plc_topic.slice(0, 8))}…` : ''}
                  {machine?.plc_endpoint ? ` · ${stripCjk(machine.plc_endpoint)}` : ''}
                </div>
                {(machine?.err_msgs || []).length > 0 ? (
                  <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: '#fca5a5', fontSize: 13 }}>
                    {machine.err_msgs.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                ) : (
                  <div style={{ ...s.meta, marginTop: 10, color: '#86efac' }}>No KPIV abnormality</div>
                )}
              </div>
            </div>
            {Object.keys(opcuaHighlights).length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                {[
                  ['Cycle', opcuaHighlights.Actual_Cycle_Time],
                  ['Prod', opcuaHighlights.Actual_Production_Count],
                  ['Nozzle °C', opcuaHighlights.Actual_Nozzle_Temp],
                  ['Barrel1 °C', opcuaHighlights.Actual_Cylender_1_Temp],
                ].map(([label, v]) => (
                  <div key={label} style={{ background: t.surface2, borderRadius: 8, padding: '8px 10px' }}>
                    <div style={{ fontSize: 11, color: t.textMuted }}>{label}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: t.text }}>
                      {v?.value_text ?? v?.value_num ?? '—'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className={surfaceClass(t)} style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ ...s.cardTitle, margin: 0 }}>Mold Monitoring</h3>
              <input
                style={s.input}
                placeholder="Search mold…"
                value={moldSearch}
                onChange={(e) => { setMoldSearch(e.target.value); setShowMoldList(true); }}
                onFocus={() => setShowMoldList(true)}
              />
            </div>

            {mold ? (
              <>
                <div style={s.moldRow}>
                  <div style={s.donutBlock}>
                    <Donut3D value={mold.usage_pct} color="#22d3ee" trackColor={t.surface2} />
                    <div style={s.donutCenter}>
                      <div style={{ color: '#22d3ee', fontWeight: 800, fontSize: 18 }}>{Math.round(mold.usage_pct)}%</div>
                      <div style={{ color: t.textDim, fontSize: 11 }}>Usage</div>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Row label="Mold No." value={stripCjk(mold.mold_no)} onEdit={canEdit ? () => openModal('editMold', { field: 'mold_no', value: mold.mold_no, moldId: mold.id }) : null} t={t} />
                    <Row label="Uses" value={mold.usage_count} onEdit={canEdit ? () => openModal('editMold', { field: 'usage_count', value: mold.usage_count, moldId: mold.id }) : null} t={t} />
                    <Row label="Max mold" value={mold.usage_max} onEdit={canEdit ? () => openModal('editMold', { field: 'usage_max', value: mold.usage_max, moldId: mold.id }) : null} t={t} />
                    {mold.master && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${t.border}` }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, marginBottom: 6 }}>Mold Master</div>
                        <Row label="Customer" value={mold.master.customer_name || '—'} t={t} />
                        <Row label="Part No." value={mold.master.part_no || '—'} t={t} />
                        <Row label="RM Grade" value={mold.master.rm_grade || '—'} t={t} />
                        <Row label="Colour" value={mold.master.colour || '—'} t={t} />
                        <Row label="Std / Run Cav" value={`${mold.master.standard_cavity ?? '—'} / ${mold.master.running_cavity ?? '—'}`} t={t} />
                        <Row label="Cycle Time" value={mold.master.standard_cycle_time != null ? `${mold.master.standard_cycle_time} s` : '—'} t={t} />
                        <Row label="Shot / Part / Runner" value={`${mold.master.std_shot_weight ?? '—'} / ${mold.master.std_part_weight ?? '—'} / ${mold.master.std_runner_weight ?? '—'} g`} t={t} />
                        <Row label="Target / Shift" value={mold.master.target_per_shift ?? '—'} t={t} />
                        <Row label="Active Cavity" value={mold.master.active_cavity_name || '—'} t={t} />
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      {canEdit && (
                        <>
                          <button type="button" style={s.primaryBtn} onClick={() => openModal('changeMold', {})}>Change Mold</button>
                          <button type="button" style={s.primaryBtn} onClick={() => openModal('addMold', {})}>New Mold</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ ...s.moldRow, marginTop: 16, borderTop: `1px solid ${t.border}`, paddingTop: 14 }}>
                  <div style={s.donutBlock}>
                    <Donut3D value={mold.maintenance?.pct || 0} color="#38bdf8" trackColor={t.surface2} />
                    <div style={s.donutCenter}>
                      <div style={{ color: '#38bdf8', fontWeight: 800, fontSize: 18 }}>{Math.round(mold.maintenance?.pct || 0)}%</div>
                      <div style={{ color: t.textDim, fontSize: 11 }}>Maint.</div>
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ marginBottom: 8 }}>
                      <span style={{
                        ...s.badge,
                        background: mold.maintenance?.key === 'ok' ? '#22c55e33' : mold.maintenance?.key === 'warn' ? '#eab30833' : '#ef444433',
                        color: mold.maintenance?.key === 'ok' ? '#22c55e' : mold.maintenance?.key === 'warn' ? '#eab308' : '#ef4444',
                      }}>{mold.maintenance?.label}</span>
                    </div>
                    <Row label="After maintenance" value={mold.cycles_after_maintenance} t={t} />
                    <Row label="Reminder limit" value={mold.maintenance_limit} onEdit={canEdit ? () => openModal('editMold', { field: 'maintenance_limit', value: mold.maintenance_limit, moldId: mold.id }) : null} t={t} />
                    {canEdit && (
                      <button type="button" style={{ ...s.primaryBtn, marginTop: 10 }} onClick={resetMaint}>
                        Reset Maintenance
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div style={s.empty}>No active mold. {canEdit && <button type="button" style={s.primaryBtn} onClick={() => openModal('addMold', {})}>New Mold</button>}</div>
            )}

            {showMoldList && (
              <div style={s.moldList}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <strong style={{ color: t.text }}>Mold list</strong>
                  <button type="button" style={s.ghostBtn} onClick={() => setShowMoldList(false)}>Close</button>
                </div>
                {molds.length === 0 ? <div style={s.empty}>No molds found</div> : molds.map((m) => (
                  <div key={m.id} style={s.moldListRow}>
                    <div>
                      <div style={{ color: t.text, fontWeight: 700 }}>{stripCjk(m.mold_no)} {m.is_active ? '●' : ''}</div>
                      <div style={{ color: t.textMuted, fontSize: 11 }}>{m.usage_count} / {m.usage_max} · {m.usage_pct}%</div>
                    </div>
                    {canEdit && !m.is_active && (
                      <button type="button" style={s.chip} onClick={() => changeMold(m.id)}>Mount</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right: KPIV charts */}
        <section className={surfaceClass(t)} style={{ ...s.card, ...s.kpivCard }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <h3 style={{ ...s.cardTitle, margin: 0 }}>KPIV Monitoring</h3>
            <span style={{ fontSize: 11, color: t.textMuted }}>
              {rangeMode === 'shift'
                ? `Shift ${(enabledShifts.find((x) => x.id === shiftId)?.name) || shiftId || '—'}`
                : rangeMode === 'custom'
                  ? `${appliedCustom.start?.replace('T', ' ') || '—'} → ${appliedCustom.end?.replace('T', ' ') || '—'}`
                  : `Last ${TIME_PRESETS.find((p) => p.hours === hours)?.label || `${hours}h`}`}
            </span>
          </div>
          <div style={s.chartGrid} className="imm-kpiv-grid">
            {CHART_TAGS.map((cfg) => {
              const activeTag = cfg.tabs ? tempTab : cfg.tag;
              const series = kpiv[activeTag];
              const chartData = (series?.points || []).map((p) => {
                const raw = p.t || '';
                const label = rangeMode === 'custom' && raw.length >= 16
                  ? `${raw.slice(5, 10)} ${raw.slice(11, 16)}`
                  : raw.slice(11, 16);
                return { t: label, v: p.v };
              });
              const thr = series?.threshold;
              return (
                <div key={cfg.title} style={s.chartCard}>
                  <div style={s.chartHead}>
                    <div>
                      <div style={{ color: t.text, fontWeight: 700, fontSize: 13 }}>{cfg.title}</div>
                      {cfg.tabs && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          {cfg.tabs.map((tb) => (
                            <button key={tb.tag} type="button"
                              style={{ ...s.chip, ...(tempTab === tb.tag ? s.chipActive : {}), padding: '2px 8px', fontSize: 11 }}
                              onClick={() => setTempTab(tb.tag)}>{tb.label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {canEdit && (
                        <>
                          <button type="button" style={s.iconBtn} title="Recalculate center" onClick={() => recalculate(activeTag)}>↻</button>
                          <button type="button" style={s.iconBtn} title="Settings" onClick={() => openModal('threshold', { tag: activeTag, thr })}>⚙</button>
                        </>
                      )}
                      <button type="button" style={s.iconBtn} title="Fullscreen" onClick={() => setFullscreen(activeTag)}>⛶</button>
                    </div>
                  </div>
                  <div style={s.chartPlot}>
                    <KpivLine data={chartData} thr={thr} unit={series?.unit} theme={t} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Machine overview — HMI-style tabulated panel (no energy meter rows) */}
      <section className={surfaceClass(t)} style={{ ...s.card, marginTop: 14, padding: 0, overflow: 'hidden' }}>
        <div style={s.overviewTitleBar}>
          <h3 style={{ ...s.cardTitle, margin: 0, padding: '12px 16px' }}>Machine Overview</h3>
        </div>

        <div style={s.hmiHeaderRow}>
          <div style={s.hmiHeaderCell}>
            <span style={s.hmiLabel}>Mould Name</span>
            <span style={s.hmiValue}>{overviewHeader.mold}</span>
          </div>
          <div style={s.hmiHeaderCell}>
            <span style={s.hmiLabel}>Material Name</span>
            <span style={s.hmiValue}>{overviewHeader.material}</span>
          </div>
          <div style={s.hmiHeaderCell}>
            <span style={s.hmiLabel}>Run Cavity</span>
            <span style={s.hmiValue}>{overviewHeader.cavity}</span>
          </div>
        </div>

        <div style={s.hmiModeRow}>
          {modeFlags.map((m) => (
            <div
              key={m.key}
              style={{
                ...s.hmiModeCell,
                background: m.on ? 'rgba(34,197,94,0.22)' : 'rgba(239,68,68,0.18)',
                borderColor: m.on ? '#22c55e' : '#ef4444',
                color: m.on ? '#86efac' : '#fca5a5',
              }}
            >
              {m.label}
            </div>
          ))}
        </div>

        <div style={s.hmiProdRow}>
          {prodCounts.map((c) => (
            <div key={c.label} style={s.hmiProdCell}>
              <span style={s.hmiLabel}>{c.label}</span>
              <span style={s.hmiValue}>{c.value}</span>
            </div>
          ))}
        </div>

        <div style={s.hmiTableWrap}>
          <table style={s.hmiTable}>
            <thead>
              <tr>
                <th style={s.hmiTh} colSpan={2}>Set</th>
                <th style={s.hmiTh} colSpan={2}>Actual</th>
                <th style={s.hmiTh} colSpan={4}>Parameters</th>
              </tr>
            </thead>
            <tbody>
              {setActualRows.map((row, idx) => {
                const left = paramPairs[idx]?.[0];
                const right = paramPairs[idx]?.[1];
                const zebra = idx % 2 === 0 ? s.hmiRowEven : s.hmiRowOdd;
                return (
                  <tr key={row.actKey} style={zebra}>
                    <td style={s.hmiTdLabel}>{row.setLabel}</td>
                    <td style={s.hmiTdValue}>{fmt(row.setKey, row.unit)}</td>
                    <td style={s.hmiTdLabel}>{row.actLabel}</td>
                    <td style={s.hmiTdValue}>{fmt(row.actKey, row.unit)}</td>
                    <td style={s.hmiTdLabel}>{left?.label || ''}</td>
                    <td style={s.hmiTdValue}>{left ? fmt(left.key, left.unit) : ''}</td>
                    <td style={s.hmiTdLabel}>{right?.label || ''}</td>
                    <td style={s.hmiTdValue}>{right ? fmt(right.key, right.unit) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Key components */}
      <section className={surfaceClass(t)} style={{ ...s.card, marginTop: 14 }}>
        <h3 style={s.cardTitle}>Key Component Runtime</h3>
        <div style={s.compGrid}>
          {(components || [])
            .filter((c, idx, arr) => arr.findIndex((x) => x.component_type === c.component_type) === idx)
            .map((c) => (
            <div key={c.id} style={s.compCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong style={{ color: t.text }}>{stripCjk(c.label)}</strong>
                {canEdit && (
                  <button type="button" style={s.chip} onClick={() => openModal('component', { ...c, action: 'change' })}>
                    Change
                  </button>
                )}
              </div>
              <div style={{ color: '#22d3ee', fontSize: 18, fontWeight: 800, margin: '8px 0 4px' }}>
                Remaining {c.remaining_label}
              </div>
                  <div style={s.meta}>Spec: {stripCjk(c.spec_display || '—')}</div>
              <div style={s.meta}>Start: {c.start_date || '—'}</div>
              <div style={s.meta}>Expected life: {c.expect_days} days</div>
            </div>
          ))}
        </div>
      </section>

      {/* Modals */}
      {modals.addMold && (
        <FormModal title="New Mold" t={t} onClose={() => closeModal('addMold')}
          fields={[
            { key: 'mold_no', label: 'Mold number', type: 'text', required: true },
            { key: 'usage_count', label: 'Current uses', type: 'number', defaultValue: 0 },
            { key: 'usage_max', label: 'Maximum mold', type: 'number', defaultValue: 1000000 },
          ]}
          onSubmit={(vals) => saveNewMold({ ...vals, activate: true, usage_count: +vals.usage_count || 0, usage_max: +vals.usage_max || 1000000 })}
        />
      )}
      {modals.editMold && (
        <FormModal title="Edit Mold Parameter" t={t} onClose={() => closeModal('editMold')}
          fields={[{
            key: modals.editMold.field,
            label: modals.editMold.field.replace(/_/g, ' '),
            type: modals.editMold.field === 'mold_no' ? 'text' : 'number',
            defaultValue: stripCjk(modals.editMold.value),
            required: true,
          }]}
          onSubmit={(vals) => {
            const v = vals[modals.editMold.field];
            const patch = { [modals.editMold.field]: modals.editMold.field === 'mold_no' ? v : Number(v) };
            return saveMoldEdit(modals.editMold.moldId, patch);
          }}
        />
      )}
      {modals.changeMold && (
        <div style={s.overlay} onClick={() => closeModal('changeMold')}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, color: t.text }}>Change Mold</h3>
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              {(detail?.molds || []).map((m) => (
                <div key={m.id} style={s.moldListRow}>
                  <div>
                    <div style={{ color: t.text, fontWeight: 700 }}>{stripCjk(m.mold_no)}</div>
                    <div style={{ color: t.textMuted, fontSize: 12 }}>
                      {m.usage_count}/{m.usage_max}
                      {m.master?.customer_name ? ` · ${m.master.customer_name}` : ''}
                      {m.master?.active_cavity_name ? ` · cav ${m.master.active_cavity_name}` : ''}
                    </div>
                  </div>
                  <button type="button" style={s.primaryBtn} disabled={m.is_active}
                    onClick={() => changeMold(m.id)}>{m.is_active ? 'Active' : 'Select'}</button>
                </div>
              ))}
            </div>
            <button type="button" style={{ ...s.ghostBtn, marginTop: 12 }} onClick={() => closeModal('changeMold')}>Cancel</button>
          </div>
        </div>
      )}
      {modals.component && (
        <FormModal title={`Change ${stripCjk(modals.component.label || modals.component.component_type)}`} t={t}
          onClose={() => closeModal('component')}
          fields={[
            { key: 'spec_length', label: 'Spec length', type: 'text', defaultValue: stripCjk(modals.component.spec_length || '') },
            { key: 'spec_diameter', label: 'Spec diameter', type: 'text', defaultValue: stripCjk(modals.component.spec_diameter || '') },
            { key: 'start_date', label: 'Start date', type: 'date', defaultValue: new Date().toISOString().slice(0, 10) },
            { key: 'expect_days', label: 'Expected days', type: 'number', defaultValue: modals.component.expect_days || 365 },
            { key: 'description', label: 'Description', type: 'text', defaultValue: '' },
          ]}
          onSubmit={(vals) => saveComponent({
            component_type: modals.component.component_type,
            ...vals,
            expect_days: +vals.expect_days || 365,
          })}
        />
      )}
      {modals.threshold && (
        <FormModal title={`KPIV Settings — ${modals.threshold.tag}`} t={t}
          onClose={() => closeModal('threshold')}
          fields={[
            { key: 'center', label: 'Center value', type: 'number', defaultValue: modals.threshold.thr?.center ?? '' },
            { key: 'sigma', label: 'Sigma multiple', type: 'number', defaultValue: modals.threshold.thr?.sigma ?? 3 },
            { key: 'upper', label: 'Upper limit', type: 'number', defaultValue: modals.threshold.thr?.upper ?? '' },
            { key: 'lower', label: 'Lower limit', type: 'number', defaultValue: modals.threshold.thr?.lower ?? '' },
            { key: 'sample_points', label: 'Sample points after adjust', type: 'number', defaultValue: modals.threshold.thr?.sample_points ?? 20 },
            { key: 'mode', label: 'Mode (sigma|fixed)', type: 'text', defaultValue: modals.threshold.thr?.mode || 'fixed' },
          ]}
          onSubmit={(vals) => saveThreshold(modals.threshold.tag, {
            center: vals.center === '' ? null : +vals.center,
            sigma: vals.sigma === '' ? null : +vals.sigma,
            upper: vals.upper === '' ? null : +vals.upper,
            lower: vals.lower === '' ? null : +vals.lower,
            sample_points: vals.sample_points === '' ? null : +vals.sample_points,
            mode: vals.mode || 'fixed',
          })}
        />
      )}

      {fullscreen && (
        <div style={s.overlay} onClick={() => setFullscreen(null)}>
          <div style={{ ...s.modal, width: 'min(1100px, 96vw)', height: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0, color: t.text }}>{kpiv[fullscreen]?.label || fullscreen}</h3>
              <button type="button" style={s.ghostBtn} onClick={() => setFullscreen(null)}>Close</button>
            </div>
            <div style={{ width: '100%', height: 'calc(100% - 48px)' }}>
              <KpivLine
                data={(kpiv[fullscreen]?.points || []).map((p) => ({ t: (p.t || '').slice(11, 19), v: p.v }))}
                thr={kpiv[fullscreen]?.threshold}
                unit={kpiv[fullscreen]?.unit}
                theme={t}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, onEdit, t }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 13 }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <span style={{ color: t.text, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {value}
        {onEdit && <button type="button" onClick={onEdit} style={{ border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer' }}>✎</button>}
      </span>
    </div>
  );
}

function kpivYDomain(data, thr) {
  const nums = [];
  for (const d of data || []) {
    const v = Number(d?.v);
    if (Number.isFinite(v)) nums.push(v);
  }
  for (const key of ['upper', 'lower', 'center']) {
    const v = Number(thr?.[key]);
    if (Number.isFinite(v)) nums.push(v);
  }
  if (!nums.length) return ['auto', 'auto'];
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  const span = hi - lo;
  // Pad so limit lines and trend are readable; never force domain down to 0
  const pad = span > 0 ? Math.max(span * 0.18, span * 0.05 + 0.05) : Math.max(Math.abs(hi) * 0.08, 0.5);
  lo -= pad;
  hi += pad;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  // Round for nicer axis ticks
  const nice = (x, roundUp) => {
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(x) || 1)) - 1);
    const step = Math.max(mag, 0.01);
    return roundUp ? Math.ceil(x / step) * step : Math.floor(x / step) * step;
  };
  return [Number(nice(lo, false).toFixed(4)), Number(nice(hi, true).toFixed(4))];
}

function KpivLine({ data, thr, unit, theme: t }) {
  if (!data?.length) {
    return <div style={{ color: t.textFaint, fontSize: 12, padding: 24, textAlign: 'center' }}>No KPIV samples in range</div>;
  }
  const domain = kpivYDomain(data, thr);
  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={160}>
      <LineChart data={data} margin={{ top: 10, right: 14, left: 4, bottom: 4 }}>
        <CartesianGrid stroke={t.border} strokeDasharray="3 3" />
        <XAxis dataKey="t" tick={{ fill: t.textDim, fontSize: 10 }} />
        <YAxis
          domain={domain}
          tick={{ fill: t.textDim, fontSize: 10 }}
          unit={unit ? ` ${unit}` : ''}
          width={58}
          allowDataOverflow={false}
        />
        <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }} />
        {thr?.upper != null && Number.isFinite(Number(thr.upper)) && (
          <ReferenceLine y={Number(thr.upper)} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'USL', fill: '#fca5a5', fontSize: 10, position: 'insideTopRight' }} />
        )}
        {thr?.lower != null && Number.isFinite(Number(thr.lower)) && (
          <ReferenceLine y={Number(thr.lower)} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'LSL', fill: '#fca5a5', fontSize: 10, position: 'insideBottomRight' }} />
        )}
        {thr?.center != null && Number.isFinite(Number(thr.center)) && (
          <ReferenceLine y={Number(thr.center)} stroke="#22c55e" strokeDasharray="3 3" />
        )}
        <Line
          type="monotone"
          dataKey="v"
          stroke="#38bdf8"
          dot={false}
          strokeWidth={2}
          isAnimationActive={false}
          shape={pulseLeadShape}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function FormModal({ title, fields, onSubmit, onClose, t }) {
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.defaultValue ?? ''])));
  const [busy, setBusy] = useState(false);
  return (
    <div style={overlayStyle(t)} onClick={onClose}>
      <div style={modalStyle(t)} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, color: t.text }}>{title}</h3>
        {fields.map((f) => (
          <label key={f.key} style={{ display: 'block', marginBottom: 10, color: t.textMuted, fontSize: 12 }}>
            {f.label}
            <input
              type={f.type}
              required={f.required}
              value={vals[f.key]}
              onChange={(e) => setVals((p) => ({ ...p, [f.key]: e.target.value }))}
              style={{
                display: 'block', width: '100%', marginTop: 4, padding: '8px 10px',
                borderRadius: 8, border: `1px solid ${t.border}`, background: t.surface2 || t.bg, color: t.text,
              }}
            />
          </label>
        ))}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={ghost(t)}>Cancel</button>
          <button type="button" disabled={busy} style={primary(t)} onClick={async () => {
            setBusy(true);
            try { await onSubmit(vals); } finally { setBusy(false); }
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function styles(t) {
  return {
    page: { padding: 16 },
    topGrid: {
      display: 'grid',
      gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(480px, 1.55fr)',
      gap: 14,
      alignItems: 'stretch',
    },
    leftCol: { display: 'flex', flexDirection: 'column', gap: 14 },
    card: {
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14, padding: 16,
    },
    kpivCard: {
      display: 'flex',
      flexDirection: 'column',
      minHeight: 560,
      height: '100%',
    },
    cardTitle: { margin: '0 0 12px', color: t.labelColor || t.accent, fontSize: 14, fontWeight: 700, letterSpacing: 0.3 },
    overviewTitleBar: {
      borderBottom: `1px solid ${t.border}`,
      background: t.surface2 || t.bg,
    },
    hmiHeaderRow: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      borderBottom: `1px solid ${t.border}`,
    },
    hmiHeaderCell: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 10,
      padding: '10px 14px',
      borderRight: `1px solid ${t.border}`,
    },
    hmiModeRow: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 0,
      borderBottom: `1px solid ${t.border}`,
    },
    hmiModeCell: {
      textAlign: 'center',
      fontWeight: 800,
      fontSize: 13,
      padding: '12px 8px',
      borderRight: `1px solid ${t.border}`,
      borderBottom: '2px solid',
    },
    hmiProdRow: {
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      borderBottom: `1px solid ${t.border}`,
    },
    hmiProdCell: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderRight: `1px solid ${t.border}`,
    },
    hmiLabel: { color: t.labelColor || t.accent, fontWeight: 700, fontSize: 12 },
    hmiValue: { color: t.text, fontWeight: 800, fontSize: 14, textAlign: 'right' },
    hmiTableWrap: { overflowX: 'auto' },
    hmiTable: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12,
      tableLayout: 'fixed',
    },
    hmiTh: {
      textAlign: 'center',
      padding: '8px 6px',
      color: t.labelColor || t.accent,
      fontWeight: 800,
      borderBottom: `1px solid ${t.border}`,
      borderRight: `1px solid ${t.border}`,
      background: t.surface2 || t.bg,
    },
    hmiRowEven: { background: t.isDark === false || t.id === 'light' ? '#f8fafc' : 'rgba(15,23,42,0.35)' },
    hmiRowOdd: { background: 'transparent' },
    hmiTdLabel: {
      padding: '8px 8px',
      color: t.labelColor || t.accent,
      fontWeight: 700,
      borderBottom: `1px solid ${t.border}`,
      borderRight: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    },
    hmiTdValue: {
      padding: '8px 8px',
      color: t.text,
      fontWeight: 700,
      textAlign: 'right',
      borderBottom: `1px solid ${t.border}`,
      borderRight: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    },
    meta: { color: t.textMuted, fontSize: 13, marginTop: 4 },
    badge: { fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999 },
    basicRow: { display: 'flex', gap: 14, alignItems: 'flex-start' },
    machineImgWrap: {
      width: 120,
      height: 120,
      borderRadius: 12,
      overflow: 'hidden',
      background: t.surface2 || t.bg,
      border: '2px solid',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    machineImg: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
    moldRow: { display: 'flex', gap: 12, alignItems: 'center' },
    donutBlock: { position: 'relative', width: DONUT_CANVAS, height: DONUT_CANVAS, flexShrink: 0 },
    donutCenter: {
      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
    },
    chartGrid: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: '1fr 1fr',
      gap: 12,
      flex: 1,
      minHeight: 480,
    },
    chartCard: {
      background: t.surface2 || t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: 10,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
    },
    chartPlot: {
      flex: 1,
      minHeight: 200,
      width: '100%',
    },
    chartHead: { display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4, flexShrink: 0 },
    compGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 12,
    },
    compCard: {
      background: t.surface2 || t.bg, border: `1px solid ${t.border}`, borderRadius: 12, padding: 12,
    },
    moldList: {
      marginTop: 12, borderTop: `1px solid ${t.border}`, paddingTop: 10, maxHeight: 220, overflow: 'auto',
    },
    moldListRow: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
      padding: '8px 0', borderBottom: `1px solid ${t.border}`,
    },
    input: {
      padding: '6px 10px', borderRadius: 8, border: `1px solid ${t.border}`,
      background: t.surface2 || t.bg, color: t.text, fontSize: 12, width: 140,
    },
    primaryBtn: primary(t),
    ghostBtn: ghost(t),
    chip: {
      border: `1px solid ${t.border}`, background: t.surface2 || t.bg, color: t.textMuted,
      borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
    chipActive: { background: t.accent, color: '#fff', borderColor: t.accent },
    chipActiveBtn: {
      border: `1px solid ${t.accent}`, background: t.accent, color: '#fff',
      borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
    },
    rangeSelect: {
      padding: '6px 10px', borderRadius: 8, border: `1px solid ${t.accent}`,
      background: t.surface2 || t.bg, color: t.text, fontSize: 12, fontWeight: 600,
      minWidth: 120, cursor: 'pointer',
    },
    rangeInput: {
      padding: '5px 8px', borderRadius: 8, border: `1px solid ${t.border}`,
      background: t.surface2 || t.bg, color: t.text, fontSize: 12,
    },
    iconBtn: {
      border: `1px solid ${t.border}`, background: t.surface, color: t.textMuted,
      borderRadius: 6, width: 28, height: 28, cursor: 'pointer',
    },
    overlay: overlayStyle(t),
    modal: modalStyle(t),
    alert: { background: '#7f1d1d55', color: '#fecaca', padding: 10, borderRadius: 8, marginBottom: 10 },
    empty: { color: t.textFaint, padding: 16, textAlign: 'center' },
  };
}

function primary(t) {
  return {
    background: t.accent, color: '#fff', border: 'none', borderRadius: 8,
    padding: '7px 12px', cursor: 'pointer', fontWeight: 700, fontSize: 12,
  };
}
function ghost(t) {
  return {
    background: 'transparent', color: t.textMuted, border: `1px solid ${t.border}`,
    borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 12,
  };
}
function overlayStyle(t) {
  return {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  };
}
function modalStyle(t) {
  return {
    background: t.surface, border: `1px solid ${t.border}`, borderRadius: 14,
    padding: 20, width: 'min(480px, 96vw)', color: t.text,
    boxShadow: '0 16px 40px rgba(0,0,0,.45)',
  };
}
