import { useCallback, useEffect, useState } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ImmHistoryTabs, { exportCsv, historyChipStyle, historySelectStyle } from '../components/ImmHistoryTabs';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

const CHART_DEFS = [
  { tag: 'injection_end', title: 'Injection Minimum Position' },
  { tag: 'max_pressure', title: 'Injection Maximum Pressure' },
  { tag: 'temp', title: 'Temperature', tabs: [
    { tag: 'nozzle_temp', label: 'Nozzle' },
    { tag: 'barrel_temp', label: 'Barrel' },
  ]},
  { tag: 'charge_time', title: 'Charge Time' },
];

function ParamChart({ chart, title, theme: t }) {
  if (!chart) {
    return <div style={{ color: t.textFaint, padding: 24, textAlign: 'center' }}>No data</div>;
  }
  const data = (chart.points || []).map((p) => ({
    t: (p.t || '').replace('T', ' ').slice(5, 16),
    v: p.v,
    full: p.t,
  }));
  return (
    <div style={{ width: '100%', height: 240, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={t.border} strokeDasharray="3 3" opacity={0.35} />
          <XAxis dataKey="t" stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 10 }} minTickGap={28} />
          <YAxis stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }}
            label={{ value: chart.unit || '', angle: -90, position: 'insideLeft', fill: t.textMuted, fontSize: 11 }} />
          <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }} />
          <Legend />
          {(chart.downtime || []).map((band, i) => (
            <ReferenceArea
              key={`${band.from}-${i}`}
              x1={(band.from || '').replace('T', ' ').slice(5, 16)}
              x2={(band.to || '').replace('T', ' ').slice(5, 16)}
              fill="#6b7280"
              fillOpacity={0.35}
            />
          ))}
          {chart.standard != null && (
            <ReferenceLine y={chart.standard} stroke="#22c55e" strokeDasharray="4 4" />
          )}
          {chart.upper != null && <ReferenceLine y={chart.upper} stroke="#ef4444" />}
          {chart.lower != null && <ReferenceLine y={chart.lower} stroke="#ef4444" />}
          <Line type="monotone" dataKey="v" name={stripCjk(title)} stroke="#38bdf8" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ImmHistoryEquipmentParams() {
  const { theme: t } = useTheme();
  const [zones, setZones] = useState([]);
  const [zoneId, setZoneId] = useState('');
  const [stationId, setStationId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [days, setDays] = useState(3);
  const [tempTab, setTempTab] = useState('nozzle_temp');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/imm/history/equipment-parameters', {
        params: {
          zone_id: zoneId || undefined,
          machine_id: machineId || undefined,
          days,
        },
      });
      setData(r.data);
      setZones(r.data?.zones || []);
      if (!zoneId && r.data?.zone?.id) setZoneId(r.data.zone.id);
      if (!machineId && r.data?.machine_id) setMachineId(String(r.data.machine_id));
      setErr('');
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load equipment parameters');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [zoneId, machineId, days]);

  useEffect(() => { load(); }, [load]);

  const equipment = data?.equipment || [];
  const stations = data?.stations || [];
  const charts = data?.charts || {};

  const doExport = () => {
    const lines = ['tag,time,value,unit'];
    for (const [tag, c] of Object.entries(charts)) {
      for (const p of c.points || []) {
        lines.push(`${tag},${p.t},${p.v},${c.unit || ''}`);
      }
    }
    exportCsv(`imm_equipment_params_${days}d.csv`, lines);
  };

  const sel = historySelectStyle(t);
  const card = {
    background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14,
  };

  const legendNote = (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: t.textMuted, marginTop: 8 }}>
      <span style={{ color: '#38bdf8' }}>● Actual</span>
      <span style={{ color: '#22c55e' }}>― Standard</span>
      <span style={{ color: '#ef4444' }}>― Upper / lower limits</span>
      <span style={{ color: '#9ca3af' }}>▮ Downtime</span>
    </div>
  );

  return (
    <div className={pageClass(t)} style={{ padding: 16 }}>
      <PageHeader title="IMM History" subtitle="Equipment Parameter" onRefresh={load} extra={(
        <button type="button" style={historyChipStyle(t, true)} onClick={doExport}>Export Report</button>
      )} />
      <ImmHistoryTabs />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Zone</span>
        <select style={sel} value={zoneId} onChange={(e) => { setZoneId(e.target.value); setMachineId(''); }}>
          {(zones.length ? zones : data?.zones || []).map((z) => (
            <option key={z.id} value={z.id}>{stripCjk(z.name)}</option>
          ))}
        </select>
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Station</span>
        <select style={sel} value={stationId} onChange={(e) => setStationId(e.target.value)}>
          <option value="">All</option>
          {stations.map((st) => (
            <option key={st.id} value={st.id}>{stripCjk(st.name)}</option>
          ))}
        </select>
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Equipment</span>
        <select style={sel} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
          {equipment.map((eq) => (
            <option key={eq.id} value={eq.id}>{stripCjk(eq.name)}</option>
          ))}
        </select>
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Date</span>
        <select style={sel} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>In 1 Day</option>
          <option value={3}>In 3 Days</option>
          <option value={7}>In 7 Days</option>
        </select>
        <button type="button" style={historyChipStyle(t, true)} onClick={load}>Search</button>
        <button type="button" style={historyChipStyle(t)} onClick={() => {
          setStationId('');
          setDays(3);
          load();
        }}>Clear</button>
        {loading && <span style={{ color: t.textFaint, fontSize: 12 }}>Loading…</span>}
      </div>

      {err && <div style={{ color: '#fecaca', marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {CHART_DEFS.map((def) => {
          const isTemp = def.tag === 'temp';
          const activeTag = isTemp ? tempTab : def.tag;
          const chart = charts[activeTag];
          return (
            <section key={def.tag} className={surfaceClass(t)} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h3 style={{ margin: 0, color: t.titleColor || t.text, fontSize: 14, fontWeight: 800 }}>
                  {def.title}
                </h3>
                {isTemp && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    {def.tabs.map((tb) => (
                      <button
                        key={tb.tag}
                        type="button"
                        style={historyChipStyle(t, tempTab === tb.tag)}
                        onClick={() => setTempTab(tb.tag)}
                      >
                        {tb.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ParamChart chart={chart} title={chart?.label || def.title} theme={t} />
              {legendNote}
            </section>
          );
        })}
      </div>
    </div>
  );
}
