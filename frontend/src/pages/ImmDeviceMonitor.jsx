import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useWebSocket } from '../api/useWebSocket';
import PageHeader from '../components/PageHeader';
import ImmDashboardSelector from '../components/ImmDashboardSelector';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';

const STATUS_META = {
  production: { label: 'Running', color: '#22c55e' },
  idle: { label: 'Idle', color: '#22cae7' },
  stop: { label: 'Stop', color: '#ef4444' },
  warning: { label: 'Warning', color: '#eab308' },
  abnormal: { label: 'Abnormal', color: '#ef4444' },
  offline: { label: 'Offline', color: '#6b7280' },
};

// Guarantee there is no CJK (Chinese/Japanese/Korean) text rendered in this UI.
const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

export default function ImmDeviceMonitor() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [factoryMeta, setFactoryMeta] = useState({ factory_name: '', factories: [] });
  const [filter, setFilter] = useState('all');
  const [hover, setHover] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [overview, factory] = await Promise.all([
        api.get('/api/imm/overview'),
        api.get('/api/imm/dashboard/factory').catch(() => ({ data: {} })),
      ]);
      setData(overview.data);
      setFactoryMeta({
        factory_name: factory.data?.factory_name || factory.data?.site_label || '',
        factories: factory.data?.factories || [],
      });
    } catch (err) {
      console.error('IMM overview fetch failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useWebSocket(useCallback((msg) => {
    if (msg.type === 'machine_status_updated' || msg.type === 'oee_updated') fetchData();
  }, [fetchData]));

  const counts = data?.counts || { total: 0, production: 0, idle: 0, stop: 0, warning: 0, abnormal: 0, offline: 0 };
  const stations = data?.stations || [];
  const makes = data?.makes || [];

  const filteredStations = useMemo(() => {
    if (filter === 'all') return stations;
    return stations.map((st) => ({
      ...st,
      machines: (st.machines || []).filter((m) => m.imm_status === filter),
    })).filter((st) => st.machines.length > 0);
  }, [stations, filter]);

  const s = styles(t);

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader
        title={(
          <ImmDashboardSelector
            mode="equipment"
            factoryName={stripCjk(factoryMeta.factory_name)}
            factories={factoryMeta.factories}
            equipmentName=""
            equipmentList={(data?.machines || data?.stations?.flatMap((st) => st.machines || []) || []).map((m) => ({
              id: m.id,
              name: m.name,
            }))}
            onEquipmentChange={(id) => navigate(`/imm/equipment/${id}`)}
          />
        )}
        onRefresh={fetchData}
        extra={(
          <button type="button" style={s.linkBtn} onClick={() => navigate('/oee-dashboard')}>
            OEE Dashboard →
          </button>
        )}
      />

      {/* Machine type legend */}
      <div style={s.legendRow}>
        <span style={{ color: t.textMuted, fontSize: 12, fontWeight: 600 }}>MACHINE TYPES</span>
        {makes.map((mk, i) => (
          <span key={mk} style={{
            ...s.makeTag,
            borderLeft: i === 0 ? `3px dashed ${t.accent}` : `3px solid ${t.accent}`,
          }}>{stripCjk(mk)}</span>
        ))}
        <button type="button" style={{ ...s.linkBtn, marginLeft: 'auto' }}
          onClick={() => navigate('/imm/kpis')}>
          Historical Data →
        </button>
      </div>

      {/* Status summary cards */}
      <div style={s.countRow}>
        {[
          { key: 'all', countKey: 'total', label: 'Total Equipment', color: '#22d3ee' },
          { key: 'production', countKey: 'production', label: 'Running', color: '#22c55e' },
          { key: 'idle', countKey: 'idle', label: 'Idle', color: '#22cae7' },
          { key: 'stop', countKey: 'stop', label: 'Stop', color: '#ef4444' },
          { key: 'warning', countKey: 'warning', label: 'Warning', color: '#eab308' },
          { key: 'abnormal', countKey: 'abnormal', label: 'Abnormal', color: '#ef4444' },
          { key: 'offline', countKey: 'offline', label: 'Offline', color: '#6b7280' },
        ].map((c) => {
          const active = filter === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              style={{
                ...s.countCard,
                borderColor: active ? c.color : t.border,
                boxShadow: active ? `0 0 0 1px ${c.color}, 0 0 18px ${c.color}44` : 'none',
              }}
            >
              <div style={{ color: t.textMuted, fontSize: 12, fontWeight: 600 }}>{c.label}</div>
              <div style={{ color: c.color, fontSize: 36, fontWeight: 800, lineHeight: 1.1, marginTop: 6 }}>
                {counts[c.countKey] ?? 0}
              </div>
            </button>
          );
        })}
      </div>

      {/* Equipment grid */}
      <div style={s.gridWrap}>
        {loading && <div style={s.empty}>Loading equipment…</div>}
        {!loading && filteredStations.length === 0 && (
          <div style={s.empty}>No machines match this status filter.</div>
        )}
        {filteredStations.map((st) => (
          <div key={st.station_id} style={s.stationBlock}>
            <div style={s.stationLabel}>{stripCjk(st.station_name)}</div>
            <div style={s.deviceGrid}>
              {(st.machines || []).map((m) => {
                const dimmed = filter !== 'all' && m.imm_status !== filter;
                const color = m.imm_status_color || STATUS_META[m.imm_status]?.color || '#6b7280';
                const dashed = /sumitomo/i.test(m.make || '') || /sumitomo/i.test(m.machine_type || '');
                return (
                  <div
                    key={m.id}
                    style={{ position: 'relative' }}
                    onMouseEnter={() => setHover(m.id)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <button
                      type="button"
                      title={stripCjk(m.name)}
                      onClick={() => navigate(`/imm/equipment/${m.id}`)}
                      style={{
                        ...s.deviceTile,
                        background: color + (dimmed ? '40' : ''),
                        color: (m.imm_status === 'offline' || m.imm_status === 'stop') ? '#e5e7eb' : '#0f172a',
                        borderLeft: dashed ? `3px dashed ${t.accent}` : `3px solid ${t.accent}`,
                        opacity: dimmed ? 0.35 : 1,
                      }}
                    >
                      {stripCjk(m.name)}
                    </button>
                    {hover === m.id && (
                      <div style={s.tooltip}>
                        <div style={s.tipHead}>
                          <strong>{stripCjk(m.name)}</strong>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <span style={{
                              ...s.badge,
                              background: color + '33',
                              color,
                            }}>{m.imm_status_label}</span>
                            <span style={{
                              ...s.badge,
                              background: (m.kpiv_status_color || '#86efac') + '33',
                              color: m.kpiv_status_color || '#86efac',
                            }}>KPIV: {m.kpiv_status_label || 'Normal'}</span>
                          </div>
                        </div>
                        <div style={{ color: t.textMuted, fontSize: 11, marginBottom: 6 }}>
                          {stripCjk(m.make || m.machine_type || 'IMM')} · {stripCjk(m.station_name)}
                        </div>
                        {m.opcua && Object.keys(m.opcua).length > 0 && (
                          <div style={{ fontSize: 11, color: t.textDim, marginBottom: 6, lineHeight: 1.45 }}>
                            {m.opcua.Actual_Cycle_Time && (
                              <div>Cycle: {m.opcua.Actual_Cycle_Time.value_text ?? m.opcua.Actual_Cycle_Time.value_num ?? '—'} s</div>
                            )}
                            {m.opcua.Actual_Production_Count && (
                              <div>Prod: {m.opcua.Actual_Production_Count.value_text ?? m.opcua.Actual_Production_Count.value_num ?? '—'}</div>
                            )}
                            {m.opcua.Actual_Mold_Name && (
                              <div>Mold: {stripCjk(m.opcua.Actual_Mold_Name.value_text || '—')}</div>
                            )}
                            {m.opcua.Connection_Status && (
                              <div>OPC UA: {stripCjk(m.opcua.Connection_Status.value_text || '—')}</div>
                            )}
                          </div>
                        )}
                        {(m.err_msgs || []).length === 0 ? (
                          <div style={{ color: t.textDim, fontSize: 12 }}>No abnormality messages</div>
                        ) : (
                          <ul style={{ margin: 0, paddingLeft: 16, color: '#fca5a5', fontSize: 12 }}>
                            {m.err_msgs.map((msg) => <li key={msg}>{msg}</li>)}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function styles(t) {
  return {
    page: { padding: 16, minHeight: '100%' },
    legendRow: {
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      marginBottom: 14, padding: '8px 4px',
    },
    makeTag: {
      padding: '4px 10px', color: t.text, fontSize: 13, fontWeight: 600,
      background: t.surface, borderRadius: 4,
    },
    linkBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.accent,
      borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    },
    countRow: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 12,
      marginBottom: 18,
    },
    countCard: {
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      padding: '14px 16px',
      textAlign: 'left',
      cursor: 'pointer',
      transition: 'box-shadow .15s ease, border-color .15s ease',
    },
    gridWrap: {
      background: t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 14,
      padding: 16,
      minHeight: 280,
    },
    stationBlock: { marginBottom: 18 },
    stationLabel: {
      color: t.accent, fontWeight: 700, fontSize: 13, marginBottom: 8,
      letterSpacing: 0.4, textTransform: 'uppercase',
    },
    deviceGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))',
      gap: 8,
    },
    deviceTile: {
      width: '100%',
      minHeight: 36,
      border: 'none',
      borderRadius: 6,
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer',
      padding: '6px 4px',
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    },
    tooltip: {
      position: 'absolute',
      zIndex: 40,
      left: 0,
      top: '110%',
      minWidth: 260,
      maxWidth: 340,
      background: t.surface2 || t.surface,
      border: `1px solid ${t.border}`,
      borderRadius: 10,
      padding: 12,
      boxShadow: '0 12px 28px rgba(0,0,0,.45)',
      pointerEvents: 'none',
    },
    tipHead: {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 8, marginBottom: 4, color: t.text,
    },
    badge: {
      fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
    },
    empty: { color: t.textFaint, textAlign: 'center', padding: 40 },
  };
}
