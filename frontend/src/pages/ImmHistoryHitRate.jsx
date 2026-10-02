import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ImmHistoryTabs, { exportCsv, historyChipStyle, historySelectStyle } from '../components/ImmHistoryTabs';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

export default function ImmHistoryHitRate() {
  const { theme: t } = useTheme();
  const [zones, setZones] = useState([]);
  const [zoneId, setZoneId] = useState('');
  const [stationId, setStationId] = useState('');
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/imm/history/hit-rate', {
        params: { zone_id: zoneId || undefined, date: dateStr || undefined },
      });
      setData(r.data);
      setZones(r.data?.zones || []);
      if (!zoneId && r.data?.zone?.id) setZoneId(r.data.zone.id);
      setErr('');
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load hit rate');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [zoneId, dateStr]);

  useEffect(() => { load(); }, [load]);

  const stations = data?.stations || [];
  const series = useMemo(() => data?.series || [], [data]);
  const equipment = (data?.equipment || []).filter(() => {
    if (!stationId) return true;
    return true;
  });

  const doExport = () => {
    const headers = ['equipment', ...series.map((s) => s.label || s.key)];
    const lines = [headers.join(',')];
    for (const eq of equipment) {
      lines.push([eq.name, ...series.map((s) => eq[s.key] ?? '')].join(','));
    }
    exportCsv(`imm_hit_rate_${dateStr}.csv`, lines);
  };

  const sel = historySelectStyle(t);

  return (
    <div className={pageClass(t)} style={{ padding: 16 }}>
      <PageHeader title="IMM History" subtitle="Equipment Hit Rate" onRefresh={load} extra={(
        <button type="button" style={historyChipStyle(t, true)} onClick={doExport}>Export Report</button>
      )} />
      <ImmHistoryTabs />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Zone</span>
        <select style={sel} value={zoneId} onChange={(e) => { setZoneId(e.target.value); setStationId(''); }}>
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
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Date</span>
        <input style={sel} type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
        {loading && <span style={{ color: t.textFaint, fontSize: 12 }}>Loading…</span>}
      </div>

      {err && <div style={{ color: '#fecaca', marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
        <section className={surfaceClass(t)} style={{
          background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14,
        }}>
          <h3 style={{ margin: '0 0 10px', color: t.titleColor || t.text, fontSize: 15, fontWeight: 800 }}>
            Equipment Hit Rate
          </h3>
          <div style={{ width: '100%', height: 320, minWidth: 0 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={equipment.map((eq) => {
                const row = { name: stripCjk(eq.name) };
                for (const s of series) row[s.key] = eq[s.key];
                return row;
              })}>
                <CartesianGrid stroke={t.border} strokeDasharray="3 3" opacity={0.35} />
                <XAxis dataKey="name" stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }} />
                <YAxis domain={[0, 120]} stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }}
                  label={{ value: 'Hit Rate (%)', angle: -90, position: 'insideLeft', fill: t.textMuted, fontSize: 11 }} />
                <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }} />
                <Legend />
                {series.map((s) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color || '#3b82f6'} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className={surfaceClass(t)} style={{
          background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14,
        }}>
          <h3 style={{ margin: '0 0 10px', color: t.titleColor || t.text, fontSize: 15, fontWeight: 800 }}>
            Time Period Hit Rate
          </h3>
          <div style={{ width: '100%', height: 320, minWidth: 0 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={(data?.periods || []).map((p) => {
                const row = { name: p.label };
                for (const s of series) row[s.key] = p[s.key];
                return row;
              })}>
                <CartesianGrid stroke={t.border} strokeDasharray="3 3" opacity={0.35} />
                <XAxis dataKey="name" stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 10 }} />
                <YAxis domain={[0, 120]} stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }} />
                <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }} />
                <Legend />
                {series.map((s) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color || '#3b82f6'} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>
    </div>
  );
}
