import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ImmHistoryTabs, { exportCsv, historyChipStyle, historySelectStyle } from '../components/ImmHistoryTabs';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

export default function ImmHistoryTransferRate() {
  const { theme: t } = useTheme();
  const [days, setDays] = useState(3);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/imm/history/transfer-rate', { params: { days } });
      setData(r.data);
      setErr('');
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load transfer rate');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const chartData = useMemo(() => {
    const dates = data?.dates || [];
    return dates.map((d, i) => {
      const row = { date: d };
      for (const s of data?.series || []) {
        row[s.id] = s.points?.[i]?.pct ?? null;
      }
      return row;
    });
  }, [data]);

  const doExport = () => {
    const header = ['date', ...(data?.series || []).map((s) => s.name)];
    const lines = [header.join(',')];
    for (const row of chartData) {
      lines.push([row.date, ...(data?.series || []).map((s) => row[s.id] ?? '')].join(','));
    }
    exportCsv(`imm_transfer_rate_${days}d.csv`, lines);
  };

  const sel = historySelectStyle(t);

  return (
    <div className={pageClass(t)} style={{ padding: 16 }}>
      <PageHeader title="IMM History" subtitle="Zone Transfer Rate" onRefresh={load} extra={(
        <button type="button" style={historyChipStyle(t, true)} onClick={doExport}>Export Report</button>
      )} />
      <ImmHistoryTabs />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: t.textMuted, fontSize: 13, fontWeight: 600 }}>Date</span>
        <select style={sel} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={3}>In 3 Days</option>
          <option value={7}>In 7 Days</option>
          <option value={14}>In 14 Days</option>
          <option value={30}>In 30 Days</option>
        </select>
        {loading && <span style={{ color: t.textFaint, fontSize: 12 }}>Loading…</span>}
      </div>

      {err && <div style={{ color: '#fecaca', marginBottom: 10 }}>{err}</div>}

      <section className={surfaceClass(t)} style={{
        background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14,
      }}>
        <h3 style={{ margin: '0 0 10px', color: t.titleColor || t.text, fontSize: 15, fontWeight: 800 }}>
          Zone Transfer Rate
        </h3>
        <div style={{ width: '100%', height: 360, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke={t.border} strokeDasharray="3 3" opacity={0.35} />
              <XAxis dataKey="date" stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }} />
              <YAxis domain={[0, 100]} stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }}
                label={{ value: 'Transfer Rate (%)', angle: -90, position: 'insideLeft', fill: t.textMuted, fontSize: 11 }} />
              <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }} />
              <Legend />
              {(data?.series || []).map((s) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={s.id}
                  name={stripCjk(s.name)}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
