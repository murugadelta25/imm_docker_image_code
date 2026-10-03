import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import SegmentedArcGauge from '../components/charts/SegmentedArcGauge';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';
import { downloadAxiosBlob } from '../utils/downloadBlob';

function currentFiscalStartYear(startMonth = 4) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= startMonth ? y : y - 1;
}

const fmt = (v, d = 2) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });
};

const TREND_TABS = [
  { id: 'kwh', label: 'Daily kWh' },
  { id: 'kvah', label: 'kVAh Consumption' },
  { id: 'kwh_per_kg', label: 'kWh/Kg' },
  { id: 'pf', label: 'Power Factor' },
];

const PERIODS = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
];

const UTILITY_KINDS = ['motor', 'chiller', 'pump', 'compressor', 'other'];

const HISTORIC_PRESETS = [
  { id: 'yesterday', label: 'Previous day' },
  { id: 'last_3_days', label: 'Previous 3 days' },
  { id: 'week', label: 'Week' },
  { id: 'custom', label: 'Custom dates' },
  { id: 'month', label: 'Month' },
];

const todayISO = () => new Date().toISOString().slice(0, 10);
const yesterdayISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};
const monthISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function PhaseTable({ title, rows, t }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        background: '#fbcfe8',
        color: '#9d174d',
        fontWeight: 700,
        fontSize: 12,
        padding: '4px 8px',
        borderRadius: '4px 4px 0 0',
      }}>
        {title}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: t.surface2 || '#e2e8f0' }}>
            {[
              { ph: 'R', color: '#ef4444' },
              { ph: 'Y', color: '#eab308' },
              { ph: 'B', color: '#3b82f6' },
            ].map(({ ph, color }) => (
              <th key={ph} style={{
                padding: '4px 6px',
                border: `1px solid ${t.border || '#cbd5e1'}`,
                color,
                fontWeight: 800,
              }}>{ph}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {[
              { ph: 'R', color: '#ef4444' },
              { ph: 'Y', color: '#ca8a04' },
              { ph: 'B', color: '#3b82f6' },
            ].map(({ ph, color }) => (
              <td key={ph} style={{
                padding: '6px',
                textAlign: 'center',
                border: `1px solid ${t.border || '#cbd5e1'}`,
                fontWeight: 700,
                color,
              }}>
                {fmt(rows?.[ph], 2)}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const GAUGE_SCALE_KEY = 'imm_energy_gauge_scale';

function loadGaugeScale() {
  try {
    const raw = JSON.parse(localStorage.getItem(GAUGE_SCALE_KEY) || '{}');
    const mode = raw.mode === 'fixed' ? 'fixed' : 'auto';
    const max = Math.min(9999, Math.max(1, Number(raw.max) || 9999));
    return { mode, max };
  } catch {
    return { mode: 'auto', max: 9999 };
  }
}

/** KWH/KVAH: Auto or Fixed max from Panel settings. PF: always 0–1. */
function EnergyArcGauge({ label, value, isPf, scaleMode = 'auto', scaleMax = 9999 }) {
  const raw = value == null || Number.isNaN(Number(value)) ? null : Number(value);
  const gaugeValue = raw == null ? 0 : (isPf ? Math.min(1, Math.max(0, raw)) : Math.max(0, raw));
  const valueText = isPf
    ? (raw == null ? '—' : fmt(raw, 4))
    : (raw == null ? '—' : fmt(raw, 2));
  if (isPf) {
    return (
      <SegmentedArcGauge value={gaugeValue} max={1} dynamic={false} label={label} valueText={valueText} />
    );
  }
  const fixed = scaleMode === 'fixed';
  return (
    <SegmentedArcGauge
      value={gaugeValue}
      max={fixed ? scaleMax : undefined}
      dynamic={!fixed}
      label={label}
      valueText={valueText}
    />
  );
}

function PlantTile({ label, value, unit, t }) {
  return (
    <div className={surfaceClass()} style={{
      flex: 1,
      minWidth: 140,
      padding: '12px 14px',
      borderRadius: 8,
      border: `1px solid ${t.border || '#334155'}`,
      background: t.surface || '#0f172a',
    }}>
      <div style={{ fontSize: 11, color: t.textDim || '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: t.accent || '#14b8a6', marginTop: 4 }}>
        {fmt(value, 3)}
        <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 6, color: t.textMuted || '#64748b' }}>{unit}</span>
      </div>
    </div>
  );
}

export default function ImmEnergyDashboard() {
  const { theme: t } = useTheme();
  const [dash, setDash] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('live'); // live | historic
  const [histPreset, setHistPreset] = useState('yesterday');
  const [customFrom, setCustomFrom] = useState(yesterdayISO);
  const [customTo, setCustomTo] = useState(yesterdayISO);
  const [histMonth, setHistMonth] = useState(monthISO);
  const [trendMetric, setTrendMetric] = useState('kwh');
  const [period, setPeriod] = useState('daily');
  const [trend, setTrend] = useState(null);
  const [energySources, setEnergySources] = useState([]);
  const [loadMachines, setLoadMachines] = useState([]);
  const [mapMeterId, setMapMeterId] = useState(null);
  const [loads, setLoads] = useState([]);
  const [mapSaving, setMapSaving] = useState(false);
  const [sourceDraft, setSourceDraft] = useState({});
  const [fyYear, setFyYear] = useState(() => currentFiscalStartYear(4));
  const [monthReport, setMonthReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [meterList, setMeterList] = useState([]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [newPanelName, setNewPanelName] = useState('');
  const [gaugeScale, setGaugeScale] = useState(loadGaugeScale);

  const isHistoric = viewMode === 'historic';

  const loadDash = useCallback(async () => {
    try {
      const params = { mode: viewMode };
      if (viewMode === 'historic') {
        params.preset = histPreset;
        if (histPreset === 'custom') {
          params.date_from = customFrom;
          params.date_to = customTo;
        }
        if (histPreset === 'month') {
          params.month = histMonth;
        }
      }
      const r = await api.get('/api/imm/energy/dashboard', { params });
      setDash(r.data);
      setErr('');
    } catch (e) {
      setErr(e?.response?.data?.detail || e.message || 'Failed to load energy dashboard');
    } finally {
      setLoading(false);
    }
  }, [viewMode, histPreset, customFrom, customTo, histMonth]);

  const loadTrend = useCallback(async () => {
    try {
      const params = {};
      if (isHistoric) {
        const from = dash?.range?.from || customFrom;
        const to = dash?.range?.to || customTo;
        params.date_from = from;
        params.date_to = to;
        params.period = 'daily';
      } else {
        params.period = period;
      }
      const r = await api.get(`/api/imm/energy/trends/${trendMetric}`, { params });
      setTrend(r.data);
    } catch {
      setTrend({ points: [] });
    }
  }, [trendMetric, period, isHistoric, dash?.range?.from, dash?.range?.to, customFrom, customTo]);

  useEffect(() => {
    loadDash();
    if (viewMode !== 'live') return undefined;
    const id = setInterval(loadDash, 15000);
    return () => clearInterval(id);
  }, [loadDash, viewMode]);

  useEffect(() => { loadTrend(); }, [loadTrend]);

  const loadEnergySources = useCallback(async () => {
    try {
      const r = await api.get('/api/imm/energy/sources');
      const list = Array.isArray(r.data?.sources) ? r.data.sources : [];
      setEnergySources(list);
      return list;
    } catch {
      setEnergySources([]);
      return [];
    }
  }, []);

  const loadProductionMachines = useCallback(async () => {
    try {
      const r = await api.get('/api/machines/');
      const list = Array.isArray(r.data) ? r.data : [];
      setLoadMachines(list);
      return list;
    } catch {
      setLoadMachines([]);
      return [];
    }
  }, []);

  useEffect(() => {
    loadEnergySources();
    loadProductionMachines();
  }, [loadEnergySources, loadProductionMachines]);

  const loadMeterSettings = useCallback(async () => {
    try {
      const r = await api.get('/api/imm/energy/meters');
      setMeterList(r.data.meters || []);
    } catch {
      setMeterList([]);
    }
  }, []);

  const openSettings = async () => {
    setSettingsOpen(true);
    setNewPanelName('');
    await loadMeterSettings();
  };

  const addPanel = async () => {
    setSettingsBusy(true);
    try {
      const body = {};
      if (newPanelName.trim()) body.name = newPanelName.trim();
      await api.post('/api/imm/energy/meters', body);
      setNewPanelName('');
      await loadMeterSettings();
      await loadDash();
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Failed to add panel');
    } finally {
      setSettingsBusy(false);
    }
  };

  const togglePanelActive = async (meter) => {
    setSettingsBusy(true);
    try {
      await api.patch(`/api/imm/energy/meters/${meter.id}`, { active: !meter.active });
      await loadMeterSettings();
      await loadDash();
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Failed to update panel');
    } finally {
      setSettingsBusy(false);
    }
  };

  const deletePanel = async (meter) => {
    const ok = window.confirm(
      `Delete ${meter.name || meter.code} permanently?\nThis removes its mappings and stored energy readings.`
    );
    if (!ok) return;
    setSettingsBusy(true);
    try {
      await api.delete(`/api/imm/energy/meters/${meter.id}`);
      await loadMeterSettings();
      await loadDash();
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Failed to delete panel');
    } finally {
      setSettingsBusy(false);
    }
  };

  const renamePanel = async (meter, name) => {
    const n = (name || '').trim();
    if (!n || n === meter.name) return;
    setSettingsBusy(true);
    try {
      await api.patch(`/api/imm/energy/meters/${meter.id}`, { name: n });
      await loadMeterSettings();
      await loadDash();
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Failed to rename panel');
    } finally {
      setSettingsBusy(false);
    }
  };

  const loadMonthReport = useCallback(async () => {
    setReportLoading(true);
    try {
      const r = await api.get('/api/imm/energy/reports/monthwise', {
        params: { fiscal_year: fyYear, fiscal_start_month: 4 },
      });
      setMonthReport(r.data);
    } catch {
      setMonthReport(null);
    } finally {
      setReportLoading(false);
    }
  }, [fyYear]);

  useEffect(() => { loadMonthReport(); }, [loadMonthReport]);

  const downloadMonthReport = async () => {
    setDownloading(true);
    try {
      const response = await api.get('/api/imm/energy/reports/monthwise/download', {
        params: { fiscal_year: fyYear, fiscal_start_month: 4 },
        responseType: 'blob',
      });
      const label = monthReport?.fiscal_year_label || String(fyYear);
      await downloadAxiosBlob(response, `monthwise_energy_${label}.xlsx`);
    } catch (e) {
      setErr(e?.message || 'Failed to download report');
    } finally {
      setDownloading(false);
    }
  };

  const downloadHistoricReport = async () => {
    setDownloading(true);
    try {
      const params = { preset: histPreset };
      if (histPreset === 'custom') {
        params.date_from = customFrom;
        params.date_to = customTo;
      }
      if (histPreset === 'month') {
        params.month = histMonth;
      }
      const response = await api.get('/api/imm/energy/reports/historic/download', {
        params,
        responseType: 'blob',
      });
      const from = dash?.range?.from || customFrom;
      const to = dash?.range?.to || customTo;
      await downloadAxiosBlob(response, `energy_historic_${histPreset}_${from}_${to}.xlsx`);
    } catch (e) {
      setErr(e?.message || 'Failed to download historic report');
    } finally {
      setDownloading(false);
    }
  };

  const chartData = useMemo(() => {
    const pts = trend?.points || [];
    return pts.map((p) => ({
      t: p.t,
      label: p.t ? new Date(`${p.t}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      v: p.v == null ? null : Number(p.v),
    }));
  }, [trend]);

  const openMapping = async (meterId) => {
    setMapMeterId(meterId);
    const [sources] = await Promise.all([loadEnergySources(), loadProductionMachines()]);
    try {
      const r = await api.get(`/api/imm/energy/meters/${meterId}/loads`);
      setLoads(r.data.loads || []);
    } catch {
      setLoads([]);
    }
    const panel = (dash?.panels || []).find((p) => p.id === meterId);
    const em = (sources || []).find((m) => String(m.name || '').toUpperCase() === 'EM_PLANT');
    const fallback = panel?.source_machine_id || em?.id || '';
    setSourceDraft((prev) => ({ ...prev, [meterId]: fallback }));
  };

  const addMachineLoad = () => {
    const first = loadMachines[0];
    setLoads((prev) => [...prev, {
      load_type: 'machine',
      machine_id: first?.id || null,
      utility_name: null,
      utility_kind: null,
    }]);
  };

  const addUtilityLoad = () => {
    setLoads((prev) => [...prev, {
      load_type: 'utility',
      machine_id: null,
      utility_name: 'Chiller',
      utility_kind: 'chiller',
    }]);
  };

  const saveMapping = async () => {
    if (!mapMeterId) return;
    setMapSaving(true);
    try {
      // Share is assigned evenly on the server from the mapped load count.
      const body = loads.map((l) => ({
        load_type: l.load_type,
        machine_id: l.load_type === 'machine' ? Number(l.machine_id) || null : null,
        utility_name: l.load_type === 'utility' ? l.utility_name : null,
        utility_kind: l.load_type === 'utility' ? l.utility_kind : null,
      }));
      await api.put(`/api/imm/energy/meters/${mapMeterId}/loads`, body);
      const src = sourceDraft[mapMeterId];
      await api.patch(`/api/imm/energy/meters/${mapMeterId}`, {
        source_machine_id: src === '' || src == null ? null : Number(src),
      });
      setMapMeterId(null);
      await loadDash();
    } catch (e) {
      setErr(e?.response?.data?.detail || 'Failed to save mapping');
    } finally {
      setMapSaving(false);
    }
  };

  const yLabel = trendMetric === 'pf' ? 'pf' : trendMetric === 'kwh_per_kg' ? 'kwh_per_kg' : trendMetric === 'kvah' ? 'kvah' : 'kwh';

  return (
    <div className={pageClass()} style={{ padding: 16, minHeight: '100%' }}>
      <PageHeader
        title="Energy Monitoring"
        subtitle={
          isHistoric
            ? `Historic · ${dash?.range?.from || '—'} → ${dash?.range?.to || '—'} (${dash?.range?.preset || histPreset})`
            : dash?.shift
              ? `Live · Shift ${dash.shift.name || dash.shift.id} · ${dash.shift.date} · ${dash.shift.start}–${dash.shift.end}`
              : 'Plant panels · shift consumption (latest − start)'
        }
      />

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        alignItems: 'center',
        marginBottom: 14,
      }}>
        <button type="button" onClick={() => setViewMode('live')} style={chipStyle(t, viewMode === 'live')}>Live</button>
        <button type="button" onClick={() => setViewMode('historic')} style={chipStyle(t, viewMode === 'historic')}>Historic</button>

        {isHistoric ? (
          <>
            {HISTORIC_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setHistPreset(p.id)}
                style={chipStyle(t, histPreset === p.id, '#0369a1')}
              >
                {p.label}
              </button>
            ))}
            {histPreset === 'custom' ? (
              <>
                <label style={{ fontSize: 12, color: t.textDim }}>
                  From
                  <input
                    type="date"
                    value={customFrom}
                    max={todayISO()}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    style={dateInputStyle(t)}
                  />
                </label>
                <label style={{ fontSize: 12, color: t.textDim }}>
                  To
                  <input
                    type="date"
                    value={customTo}
                    max={todayISO()}
                    onChange={(e) => setCustomTo(e.target.value)}
                    style={dateInputStyle(t)}
                  />
                </label>
              </>
            ) : null}
            {histPreset === 'month' ? (
              <label style={{ fontSize: 12, color: t.textDim }}>
                Month
                <input
                  type="month"
                  value={histMonth}
                  onChange={(e) => setHistMonth(e.target.value)}
                  style={dateInputStyle(t)}
                />
              </label>
            ) : null}
          </>
        ) : null}

        <div style={{ flex: 1 }} />
        {isHistoric ? (
          <button
            type="button"
            onClick={downloadHistoricReport}
            disabled={downloading}
            style={{
              ...chipStyle(t, true, '#2563eb'),
              opacity: downloading ? 0.7 : 1,
            }}
            title="Download Excel for the selected historic range"
          >
            {downloading ? 'Downloading…' : '⬇ Download Excel'}
          </button>
        ) : null}
        <button type="button" onClick={openSettings} style={chipStyle(t, false)}>
          ⚙ Panel settings
        </button>
      </div>

      {err ? (
        <div style={{ color: '#f87171', marginBottom: 12, fontSize: 13 }}>{err}</div>
      ) : null}

      {loading && !dash ? (
        <div style={{ color: t.textDim }}>Loading energy meters…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
            <PlantTile label="Plant KWH" value={dash?.plant?.kwh} unit="kWh" t={t} />
            <PlantTile label="Plant KVAH" value={dash?.plant?.kvah} unit="kVAh" t={t} />
            <PlantTile label="Plant Mc's KWH" value={dash?.plant?.machines_kwh} unit="kWh" t={t} />
            <PlantTile label="Plant Utilities KWH" value={dash?.plant?.utilities_kwh} unit="kWh" t={t} />
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
            marginBottom: 20,
          }}>
            {(dash?.panels || []).map((panel) => (
              <div
                key={panel.id}
                className={surfaceClass()}
                style={{
                  border: `1px solid ${t.border || '#334155'}`,
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: t.surface || '#0f172a',
                }}
              >
                <div style={{
                  background: '#0d9488',
                  color: '#fff',
                  fontWeight: 800,
                  fontSize: 15,
                  padding: '8px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <span>{panel.name || `Panel - ${panel.panel_no}`}</span>
                  <button
                    type="button"
                    onClick={() => openMapping(panel.id)}
                    style={{
                      background: 'rgba(255,255,255,0.15)',
                      border: '1px solid rgba(255,255,255,0.35)',
                      color: '#fff',
                      borderRadius: 6,
                      fontSize: 11,
                      padding: '3px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    Map loads
                  </button>
                </div>

                <div style={{ padding: 12 }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: 4,
                    marginBottom: 10,
                    fontSize: 12,
                  }}>
                    <div><span style={{ color: '#ef4444', fontWeight: 700 }}>KWH </span><b style={{ color: '#ef4444' }}>{fmt(panel.kwh, 3)}</b></div>
                    <div><span style={{ color: '#eab308', fontWeight: 700 }}>KVAH </span><b style={{ color: '#ca8a04' }}>{fmt(panel.kvah, 3)}</b></div>
                    <div><span style={{ color: '#3b82f6', fontWeight: 700 }}>PF </span><b style={{ color: '#3b82f6' }}>{fmt(panel.pf, 4)}</b></div>
                  </div>

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-around',
                    gap: 2,
                    marginBottom: 12,
                    flexWrap: 'wrap',
                    background: 'transparent',
                  }}>
                    <EnergyArcGauge
                      label="KWH"
                      value={panel.kwh}
                      scaleMode={gaugeScale.mode}
                      scaleMax={gaugeScale.max}
                    />
                    <EnergyArcGauge
                      label="KVAH"
                      value={panel.kvah}
                      scaleMode={gaugeScale.mode}
                      scaleMax={gaugeScale.max}
                    />
                    <EnergyArcGauge label="PF" value={panel.pf} isPf />
                  </div>

                  <div style={{ fontSize: 11, color: t.textDim, marginBottom: 6 }}>
                    {isHistoric ? (
                      <>Period total from daily rollups{panel.days_with_data != null ? ` · ${panel.days_with_data} day(s) with data` : ''}</>
                    ) : (
                      <>Cumulative: {fmt(panel.total_kwh, 2)} kWh · {fmt(panel.total_kvah, 2)} kVAh</>
                    )}
                    {panel.loads?.length ? (
                      <div style={{ marginTop: 4 }}>
                        Loads ({panel.loads.length}, ~{(100 / panel.loads.length).toFixed(1)}% each):{' '}
                        {panel.loads.map((l) => (
                          l.load_type === 'machine'
                            ? (l.machine_name || `M#${l.machine_id}`)
                            : `${l.utility_name || 'Utility'} (${l.utility_kind || 'other'})`
                        )).join(', ')}
                      </div>
                    ) : (
                      <div style={{ marginTop: 4 }}>No machine/utility mapping</div>
                    )}
                  </div>

                  {!isHistoric ? (
                    <>
                      <PhaseTable title="Ampere" rows={panel.ampere} t={t} />
                      <PhaseTable title="Phase to Phase Voltage" rows={panel.phase_to_phase} t={t} />
                      <PhaseTable title="Phase to Neutral Voltage" rows={panel.phase_to_neutral} t={t} />
                    </>
                  ) : (
                    <div style={{ fontSize: 11, color: t.textDim, marginTop: 8 }}>
                      Ampere / voltage are live-only (not stored historically).
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className={surfaceClass()} style={{
            border: `1px solid ${t.border || '#334155'}`,
            borderRadius: 10,
            padding: 14,
            background: t.surface || '#0f172a',
          }}>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
              marginBottom: 12,
              justifyContent: 'space-between',
            }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: t.text }}>
                {TREND_TABS.find((x) => x.id === trendMetric)?.label || 'Trend'} Dashboard
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {TREND_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setTrendMetric(tab.id)}
                    style={chipStyle(t, trendMetric === tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
                {!isHistoric ? PERIODS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPeriod(p.id)}
                    style={chipStyle(t, period === p.id, '#0369a1')}
                  >
                    {p.label}
                  </button>
                )) : (
                  <span style={{ fontSize: 11, color: t.textDim, alignSelf: 'center' }}>
                    Chart range follows historic selection
                  </span>
                )}
              </div>
            </div>

            <div style={{ width: '100%', height: 320 }}>
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={chartData} margin={{ top: 16, right: 16, left: 0, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={t.border || '#334155'} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: t.textDim || '#94a3b8', fontSize: 10 }}
                    angle={-35}
                    textAnchor="end"
                    height={60}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: t.textDim || '#94a3b8', fontSize: 11 }}
                    label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: t.textDim || '#94a3b8', fontSize: 11 }}
                  />
                  <Tooltip
                    contentStyle={{ background: t.surface2 || '#1e293b', border: `1px solid ${t.border || '#475569'}` }}
                    labelStyle={{ color: t.text }}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="v"
                    name={yLabel}
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#0ea5e9' }}
                    connectNulls
                    label={{ position: 'top', fill: t.textDim || '#94a3b8', fontSize: 9, formatter: (v) => (v == null ? '' : fmt(v, trendMetric === 'pf' || trendMetric === 'kwh_per_kg' ? 2 : 1)) }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ fontSize: 11, color: t.textDim, marginTop: 4 }}>
              Daily kWh / kVAh = sum of Shift A + Shift B consumption (latest − shift-start reading). Mid-shift device gaps retain the last good reading.
            </div>
          </div>

          <div className={surfaceClass()} style={{
            border: `1px solid ${t.border || '#334155'}`,
            borderRadius: 10,
            padding: 14,
            background: t.surface || '#0f172a',
            marginTop: 16,
          }}>
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 12,
            }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#3b82f6' }}>
                  Monthwise Energy Consumption Summary
                </div>
                <div style={{ fontSize: 11, color: t.textDim, marginTop: 2 }}>
                  Total kWh of all panels per month · FY Apr–Mar · Excel includes plant + per-panel sheets
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12, color: t.textDim }}>
                  Fiscal year
                  <select
                    value={fyYear}
                    onChange={(e) => setFyYear(Number(e.target.value))}
                    style={{
                      marginLeft: 6,
                      padding: '5px 8px',
                      borderRadius: 6,
                      background: t.surface2 || '#1e293b',
                      color: t.text,
                      border: `1px solid ${t.border || '#475569'}`,
                    }}
                  >
                    {Array.from({ length: 6 }, (_, i) => currentFiscalStartYear(4) - i).map((y) => (
                      <option key={y} value={y}>{y}-{(y + 1).toString().slice(-2)}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={downloadMonthReport}
                  disabled={downloading || reportLoading}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#2563eb',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {downloading ? 'Downloading…' : '⬇ Download FY Excel'}
                </button>
              </div>
            </div>

            {reportLoading && !monthReport ? (
              <div style={{ color: t.textDim, fontSize: 13 }}>Loading monthly report…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 640 }}>
                  <thead>
                    <tr style={{ background: t.surface2 || '#334155' }}>
                      {['Month', "Month's KWH", 'YTD KWH', "Month's DG Run (Hrs.)", 'YTD DG Run (Hrs.)'].map((h) => (
                        <th key={h} style={{
                          padding: '8px 10px',
                          textAlign: h === 'Month' ? 'left' : 'right',
                          border: `1px solid ${t.border || '#475569'}`,
                          color: t.text,
                          fontWeight: 700,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(monthReport?.months || []).map((row, idx) => (
                      <tr key={row.month_key || row.month} style={{
                        background: idx % 2 ? (t.surface2 || '#1e293b') : 'transparent',
                      }}>
                        <td style={{ padding: '7px 10px', border: `1px solid ${t.border || '#475569'}`, color: t.text }}>{row.month}</td>
                        <td style={{ padding: '7px 10px', border: `1px solid ${t.border || '#475569'}`, textAlign: 'right', color: t.text, fontWeight: 600 }}>{fmt(row.month_kwh, 1)}</td>
                        <td style={{ padding: '7px 10px', border: `1px solid ${t.border || '#475569'}`, textAlign: 'right', color: t.text }}>{fmt(row.ytd_kwh, 1)}</td>
                        <td style={{ padding: '7px 10px', border: `1px solid ${t.border || '#475569'}`, textAlign: 'right', color: t.textDim }}>{fmt(row.month_dg_hrs, 4)}</td>
                        <td style={{ padding: '7px 10px', border: `1px solid ${t.border || '#475569'}`, textAlign: 'right', color: t.textDim }}>{fmt(row.ytd_dg_hrs, 4)}</td>
                      </tr>
                    ))}
                    {!monthReport?.months?.length ? (
                      <tr>
                        <td colSpan={5} style={{ padding: 12, color: t.textDim, textAlign: 'center' }}>No monthly data yet</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {mapMeterId != null ? (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 80,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}>
          <div style={{
            width: 'min(640px, 100%)',
            maxHeight: '90vh',
            overflow: 'auto',
            background: t.surface || '#0f172a',
            border: `1px solid ${t.border || '#475569'}`,
            borderRadius: 12,
            padding: 16,
          }}>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 10, color: t.text }}>
              Map energy meter loads
            </div>
            <div style={{ fontSize: 12, color: t.textDim, marginBottom: 10 }}>
              Only add the machines / utilities connected to this meter.
              Share is calculated automatically and evenly
              {loads.length > 0 ? (
                <> (currently <b>{loads.length}</b> load{loads.length === 1 ? '' : 's'} → ~{(100 / loads.length).toFixed(1)}% each)</>
              ) : null}.
            </div>

            <label style={{ display: 'block', fontSize: 12, marginBottom: 12, color: t.text }}>
              Source (Node-RED energy stream)
              <div style={{ fontSize: 11, color: t.textDim, fontWeight: 400, marginTop: 2 }}>
                Choose <b>EM_PLANT</b> for plant energy tags from Node-RED. It is created automatically by EAP (not in the IMM fleet map). Not tied to IMM17/18.
              </div>
              <select
                value={sourceDraft[mapMeterId] ?? ''}
                onChange={(e) => setSourceDraft((prev) => ({ ...prev, [mapMeterId]: e.target.value }))}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: 4,
                  padding: 8,
                  borderRadius: 6,
                  background: t.surface2 || '#1e293b',
                  color: t.text,
                  border: `1px solid ${t.border || '#475569'}`,
                }}
              >
                <option value="">— none —</option>
                {energySources.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}{m.is_energy_source || String(m.name || '').toUpperCase() === 'EM_PLANT' ? ' (energy source)' : ''}
                  </option>
                ))}
              </select>
              {!energySources.some((m) => String(m.name || '').toUpperCase() === 'EM_PLANT') && (
                <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 6 }}>
                  EM_PLANT not listed — restart the EAP backend, then reopen this dialog.
                </div>
              )}
            </label>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 32px',
              gap: 6,
              marginBottom: 8,
              fontSize: 11,
              fontWeight: 700,
              color: t.textDim || '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}>
              <div>Load type</div>
              <div>Connected machine / device</div>
              <div />
            </div>

            {loads.map((l, idx) => (
              <div key={idx} style={{
                display: 'grid',
                gridTemplateColumns: '110px 1fr 32px',
                gap: 6,
                marginBottom: 8,
                alignItems: 'center',
              }}>
                <select
                  value={l.load_type}
                  aria-label="Load type"
                  onChange={(e) => {
                    const lt = e.target.value;
                    setLoads((prev) => prev.map((x, i) => (i === idx ? {
                      ...x,
                      load_type: lt,
                      machine_id: lt === 'machine' ? (loadMachines[0]?.id || null) : null,
                      utility_name: lt === 'utility' ? (x.utility_name || 'Utility') : null,
                      utility_kind: lt === 'utility' ? (x.utility_kind || 'other') : null,
                    } : x)));
                  }}
                  style={{ padding: 6, borderRadius: 6, background: t.surface2, color: t.text, border: `1px solid ${t.border}` }}
                >
                  <option value="machine">Machine</option>
                  <option value="utility">Utility</option>
                </select>
                {l.load_type === 'machine' ? (
                  <select
                    value={l.machine_id || ''}
                    aria-label="Connected machine"
                    onChange={(e) => setLoads((prev) => prev.map((x, i) => (i === idx ? { ...x, machine_id: Number(e.target.value) } : x)))}
                    style={{ padding: 6, borderRadius: 6, background: t.surface2, color: t.text, border: `1px solid ${t.border}` }}
                  >
                    {loadMachines.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={l.utility_name || ''}
                      onChange={(e) => setLoads((prev) => prev.map((x, i) => (i === idx ? { ...x, utility_name: e.target.value } : x)))}
                      placeholder="Utility name"
                      aria-label="Utility name"
                      style={{ flex: 1, padding: 6, borderRadius: 6, background: t.surface2, color: t.text, border: `1px solid ${t.border}` }}
                    />
                    <select
                      value={l.utility_kind || 'other'}
                      aria-label="Utility kind"
                      onChange={(e) => setLoads((prev) => prev.map((x, i) => (i === idx ? { ...x, utility_kind: e.target.value } : x)))}
                      style={{ padding: 6, borderRadius: 6, background: t.surface2, color: t.text, border: `1px solid ${t.border}` }}
                    >
                      {UTILITY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setLoads((prev) => prev.filter((_, i) => i !== idx))}
                  title="Remove"
                  aria-label="Remove load"
                  style={{ border: 'none', background: 'transparent', color: '#f87171', cursor: 'pointer', fontSize: 18 }}
                >
                  ×
                </button>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={addMachineLoad} style={btnStyle(t)}>+ Machine</button>
              <button type="button" onClick={addUtilityLoad} style={btnStyle(t)}>+ Utility</button>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={() => setMapMeterId(null)} style={btnStyle(t)}>Cancel</button>
              <button
                type="button"
                disabled={mapSaving}
                onClick={saveMapping}
                style={{ ...btnStyle(t), background: t.accent || '#14b8a6', color: '#fff', borderColor: 'transparent' }}
              >
                {mapSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 85,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        }}>
          <div style={{
            width: 'min(720px, 100%)',
            maxHeight: '90vh',
            overflow: 'auto',
            background: t.surface || '#0f172a',
            border: `1px solid ${t.border || '#475569'}`,
            borderRadius: 12,
            padding: 16,
          }}>
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6, color: t.text }}>
              Panel settings
            </div>
            <div style={{ fontSize: 12, color: t.textDim, marginBottom: 12 }}>
              Add extra panels when needed. Deactivate hides a panel (data kept).
              Delete removes the panel and its energy data permanently.
            </div>

            <div style={{
              marginBottom: 14,
              padding: 12,
              borderRadius: 8,
              border: `1px solid ${t.border || '#475569'}`,
              background: t.surface2 || '#1e293b',
            }}>
              <div style={{ fontWeight: 800, fontSize: 13, color: t.text, marginBottom: 6 }}>
                Gauge scale (KWH / KVAH)
              </div>
              <div style={{ fontSize: 11, color: t.textDim, marginBottom: 8 }}>
                Auto grows with the live reading (up to 9999). Fixed uses your number as 100% fill
                — set 9999, 2000, 1200, etc.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <label style={{ fontSize: 12, color: t.text }}>
                  Mode
                  <select
                    value={gaugeScale.mode}
                    onChange={(e) => {
                      const next = { ...gaugeScale, mode: e.target.value };
                      setGaugeScale(next);
                      localStorage.setItem(GAUGE_SCALE_KEY, JSON.stringify(next));
                    }}
                    style={{
                      display: 'block',
                      marginTop: 4,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: t.surface || '#0f172a',
                      color: t.text,
                      border: `1px solid ${t.border}`,
                    }}
                  >
                    <option value="auto">Auto (dynamic)</option>
                    <option value="fixed">Fixed max</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, color: t.text }}>
                  Max value (100% = this)
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    step={1}
                    disabled={gaugeScale.mode !== 'fixed'}
                    value={gaugeScale.max}
                    onChange={(e) => {
                      const max = Math.min(9999, Math.max(1, Number(e.target.value) || 1));
                      const next = { ...gaugeScale, max };
                      setGaugeScale(next);
                      localStorage.setItem(GAUGE_SCALE_KEY, JSON.stringify(next));
                    }}
                    style={{
                      display: 'block',
                      marginTop: 4,
                      width: 120,
                      padding: '6px 8px',
                      borderRadius: 6,
                      background: t.surface || '#0f172a',
                      color: t.text,
                      border: `1px solid ${t.border}`,
                      opacity: gaugeScale.mode === 'fixed' ? 1 : 0.5,
                    }}
                  />
                </label>
                {[1000, 2000, 5000, 9999].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      const next = { mode: 'fixed', max: v };
                      setGaugeScale(next);
                      localStorage.setItem(GAUGE_SCALE_KEY, JSON.stringify(next));
                    }}
                    style={btnStyle(t)}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '70px 1fr 90px 90px 200px',
              gap: 6,
              fontSize: 11,
              fontWeight: 700,
              color: t.textDim,
              textTransform: 'uppercase',
              marginBottom: 6,
            }}>
              <div>Panel #</div>
              <div>Name</div>
              <div>Code</div>
              <div>Status</div>
              <div>Actions</div>
            </div>

            {meterList.map((m) => (
              <div key={m.id} style={{
                display: 'grid',
                gridTemplateColumns: '70px 1fr 90px 90px 200px',
                gap: 6,
                alignItems: 'center',
                marginBottom: 8,
              }}>
                <div style={{ color: t.text, fontWeight: 700 }}>{m.panel_no}</div>
                <input
                  defaultValue={m.name}
                  onBlur={(e) => renamePanel(m, e.target.value)}
                  disabled={settingsBusy}
                  style={{
                    padding: 6,
                    borderRadius: 6,
                    background: t.surface2,
                    color: t.text,
                    border: `1px solid ${t.border}`,
                  }}
                />
                <div style={{ color: t.textDim, fontSize: 12 }}>{m.code}</div>
                <div style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: m.active ? '#34d399' : '#f87171',
                }}>
                  {m.active ? 'Active' : 'Inactive'}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    disabled={settingsBusy}
                    onClick={() => togglePanelActive(m)}
                    style={btnStyle(t)}
                  >
                    {m.active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    type="button"
                    disabled={settingsBusy}
                    onClick={() => deletePanel(m)}
                    style={{ ...btnStyle(t), color: '#fff', background: '#dc2626', borderColor: '#b91c1c' }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}

            <div style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px solid ${t.border || '#475569'}`,
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}>
              <input
                value={newPanelName}
                onChange={(e) => setNewPanelName(e.target.value)}
                placeholder="New panel name (optional)"
                style={{
                  flex: 1,
                  minWidth: 180,
                  padding: 8,
                  borderRadius: 6,
                  background: t.surface2,
                  color: t.text,
                  border: `1px solid ${t.border}`,
                }}
              />
              <button
                type="button"
                disabled={settingsBusy}
                onClick={addPanel}
                style={{ ...btnStyle(t), background: t.accent || '#14b8a6', color: '#fff', borderColor: 'transparent' }}
              >
                {settingsBusy ? 'Working…' : '+ Add panel'}
              </button>
              <button type="button" onClick={() => setSettingsOpen(false)} style={btnStyle(t)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function btnStyle(t) {
  return {
    padding: '6px 12px',
    borderRadius: 6,
    border: `1px solid ${t.border || '#475569'}`,
    background: t.surface2 || '#1e293b',
    color: t.text || '#e2e8f0',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function chipStyle(t, active, activeColor) {
  const on = activeColor || t.accent || '#14b8a6';
  return {
    padding: '5px 10px',
    borderRadius: 6,
    border: `1px solid ${active ? on : (t.border || '#475569')}`,
    background: active ? on : 'transparent',
    color: active ? '#fff' : (t.text || '#e2e8f0'),
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function dateInputStyle(t) {
  return {
    marginLeft: 6,
    padding: '4px 6px',
    borderRadius: 6,
    background: t.surface2 || '#1e293b',
    color: t.text,
    border: `1px solid ${t.border || '#475569'}`,
  };
}
