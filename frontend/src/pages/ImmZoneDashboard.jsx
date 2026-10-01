import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ImmDashboardSelector from '../components/ImmDashboardSelector';
import AnimatedBarChart from '../components/charts/AnimatedBarChart';
import DonutGauge from '../components/charts/DonutGauge';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass, tileClass } from '../themes/tileHelpers';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

export default function ImmZoneDashboard() {
  const { zoneId } = useParams();
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [zones, setZones] = useState([]);
  const [err, setErr] = useState('');
  const [focusLine, setFocusLine] = useState(null);

  const statusMeta = {
    running: { label: 'Running', color: t.brand || '#77AF46' },
    warning: { label: 'Warning', color: '#eab308' },
    idle: { label: 'Idle', color: t.textDim || '#22cae7' },
    stop: { label: 'Stop', color: '#ef4444' },
    offline: { label: 'Offline', color: t.textFaint || '#9ec8de' },
    abnormal: { label: 'Warning', color: '#ef4444' },
  };

  const load = useCallback(async () => {
    try {
      const zr = await api.get('/api/imm/dashboard/zones');
      setZones(zr.data?.zones || []);
      const id = zoneId || zr.data?.zones?.[0]?.id;
      if (!id) {
        setData(null);
        setErr('No zones configured. Add Departments → Zones and assign stations in Factory Setup.');
        return;
      }
      if (!zoneId && id) {
        navigate(`/imm/zone/${encodeURIComponent(id)}`, { replace: true });
        return;
      }
      const r = await api.get(`/api/imm/dashboard/zone/${encodeURIComponent(id)}`);
      setData(r.data);
      setErr('');
      const firstStation = r.data?.stations?.[0];
      const firstBlockId = firstStation
        ? `station-${firstStation.id}`
        : (r.data?.lines?.[0]?.id || null);
      setFocusLine((prev) => prev || firstBlockId);
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load zone dashboard');
    }
  }, [zoneId, navigate]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const rr = data?.running_rate || { pct: 0, running: 0, total: 0 };
  const sc = data?.status_counts || {};
  const stations = data?.stations || [];
  const machines = data?.machines || [];
  const lines = data?.lines || [];
  // Prefer stations (from Factory Setup / machine location); fall back to zone machine list
  const stationBlocks = stations.length
    ? stations.map((st) => ({
      id: `station-${st.id}`,
      name: st.name,
      machines: machines.filter((m) => Number(m.station_id) === Number(st.id)),
      total: machines.filter((m) => Number(m.station_id) === Number(st.id)).length,
      running_pct: (() => {
        const ms = machines.filter((m) => Number(m.station_id) === Number(st.id));
        if (!ms.length) return 0;
        return Math.round(100 * ms.filter((m) => m.imm_status === 'production').length / ms.length);
      })(),
    }))
    : (lines.length
      ? lines
      : (machines.length
        ? [{
          id: 'zone-all',
          name: data?.zone?.name || 'Zone',
          machines,
          total: machines.length,
          running_pct: rr.pct,
        }]
        : []));
  const activeBlock = stationBlocks.find((l) => l.id === focusLine) || stationBlocks[0];
  const blockMachines = activeBlock?.machines || [];
  const chartBlocks = stationBlocks;
  const s = styles(t);

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader
        title={(
          <ImmDashboardSelector
            mode="zone"
            factoryName={stripCjk(data?.factory_name || data?.site_label || '')}
            factories={data?.factories || []}
            zoneName={stripCjk(data?.zone?.name || '')}
            zones={data?.zones || zones}
            selectedZoneId={zoneId || data?.zone?.id || ''}
            onZoneChange={(id) => navigate(`/imm/zone/${encodeURIComponent(id)}`)}
          />
        )}
        onRefresh={load}
      />
      {err && <div style={s.alert}>{err}</div>}

      <div style={s.topRow}>
        <section className={surfaceClass(t)} style={s.card}>
          <h3 style={s.cardTitle}>Status Statistics</h3>
          <div style={s.statsInner}>
            <div>
              <div style={{ ...s.statLine, color: t.accent }}>
                Running Equipment: <strong style={{ color: t.text }}>{rr.running}</strong> units
              </div>
              <div style={{ ...s.statLine, color: t.accent }}>
                Total Equipment Quantity: <strong style={{ color: t.text }}>{rr.total}</strong> units
              </div>
              <DonutGauge
                value={rr.pct}
                color={t.accent}
                trackColor={t.surface2}
                theme={t}
                label="Running"
              />
            </div>
            <div style={s.statusGrid}>
              {[
                { key: 'running', count: sc.running ?? sc.production ?? 0 },
                { key: 'warning', count: (sc.warning || 0) + (sc.abnormal || 0) },
                { key: 'idle', count: sc.idle || 0 },
                { key: 'stop', count: sc.stop || 0 },
                { key: 'offline', count: sc.offline || 0 },
              ].map((row) => (
                <div key={row.key} style={s.statusItem}>
                  <span style={{ ...s.dot, background: statusMeta[row.key].color }} />
                  <div>
                    <div style={{ color: t.text, fontWeight: 700 }}>{statusMeta[row.key].label}</div>
                    <div style={{ color: t.textMuted, fontSize: 12 }}>{row.count} units</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={surfaceClass(t)} style={s.card}>
          <h3 style={s.cardTitle}>Station Running Rate</h3>
          <AnimatedBarChart
            data={chartBlocks.map((l) => ({ name: stripCjk(l.name), pct: l.running_pct, id: l.id }))}
            theme={t}
            series={[{ key: 'pct', label: 'Running %', color: t.brand || t.accent }]}
            yDomain={[0, 100]}
            height={220}
            labelKey="pct"
            labelFormatter={(v) => `${v}%`}
            onBarClick={(d) => d?.id && setFocusLine(d.id)}
          />
        </section>
      </div>

      <section className={surfaceClass(t)} style={{ ...s.card, marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {chartBlocks.map((l) => (
            <button
              key={l.id}
              type="button"
              style={{
                ...s.lineTab,
                ...(activeBlock?.id === l.id ? { borderColor: t.accent, color: t.accent } : {}),
              }}
              onClick={() => setFocusLine(l.id)}
            >
              {stripCjk(l.name)}
              <span style={s.badge}>{l.total ?? (l.machines || []).length}</span>
            </button>
          ))}
        </div>

        <div style={s.machineGrid}>
          {blockMachines.length === 0 && (
            <div style={s.empty}>
              No machines for this zone yet. In Machine Management, set Station and Location to this zone
              (or assign the station under Factory Setup → Zone).
            </div>
          )}
          {blockMachines.map((m) => (
            <button
              key={m.id}
              type="button"
              className={tileClass(t)}
              style={s.machineCard}
              onClick={() => navigate(`/imm/equipment/${m.id}`)}
            >
              <div style={{ color: t.text, fontWeight: 800, fontSize: 14 }}>{stripCjk(m.name)}</div>
              <div style={{
                marginTop: 18,
                background: m.imm_status_color || t.textFaint,
                color: t.isDark ? '#041018' : '#fff',
                borderRadius: 8,
                padding: '8px 10px',
                fontWeight: 800,
                textAlign: 'center',
                border: `1px solid ${t.border}`,
              }}>
                {m.imm_status_label}
              </div>
              <div style={{
                marginTop: 6,
                fontSize: 11,
                fontWeight: 700,
                textAlign: 'center',
                color: m.kpiv_status_color || '#86efac',
              }}>
                KPIV: {m.kpiv_status_label || (m.err_msgs?.length ? 'Abnormal' : 'Normal')}
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function styles(t) {
  return {
    page: { padding: 16, minHeight: '100%' },
    alert: {
      background: 'rgba(127, 29, 29, 0.35)',
      color: '#fecaca',
      border: `1px solid ${t.border}`,
      padding: 10,
      borderRadius: 8,
      marginBottom: 12,
    },
    topRow: { display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 },
    card: {
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: 14,
    },
    cardTitle: {
      margin: '0 0 10px',
      color: t.labelColor || t.accent,
      fontSize: 13,
      fontWeight: 700,
    },
    statsInner: { display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 12 },
    statLine: { fontSize: 12, marginBottom: 4 },
    statusGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignContent: 'center' },
    statusItem: { display: 'flex', gap: 10, alignItems: 'center' },
    dot: { width: 28, height: 28, borderRadius: 8, display: 'block', border: `1px solid ${t.border}` },
    lineTab: {
      background: t.surface2,
      border: `1px solid ${t.border}`,
      color: t.text,
      borderRadius: 999,
      padding: '6px 12px',
      cursor: 'pointer',
      fontWeight: 700,
      fontSize: 12,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
    },
    badge: {
      background: t.accent,
      color: '#041018',
      borderRadius: 999,
      minWidth: 20,
      height: 20,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      fontWeight: 800,
    },
    machineGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
      gap: 12,
    },
    machineCard: {
      background: t.surface2,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: 12,
      cursor: 'pointer',
      textAlign: 'left',
      minHeight: 110,
    },
    empty: { color: t.textFaint, padding: 24, textAlign: 'center', gridColumn: '1 / -1' },
  };
}
