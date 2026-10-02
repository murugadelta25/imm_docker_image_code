import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { useWebSocket } from '../api/useWebSocket';
import PageHeader from '../components/PageHeader';
import ImmDashboardSelector from '../components/ImmDashboardSelector';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';

const STATUS_META = {
  production: { label: 'Running', color: '#22c55e' },
  available: { label: 'Available', color: '#3b82f6' },
  idle: { label: 'Idle', color: '#eab308' },
  stop: { label: 'Stop', color: '#ef4444' },
  warning: { label: 'Warning', color: '#eab308' },
  abnormal: { label: 'Abnormal', color: '#ef4444' },
  offline: { label: 'Offline', color: '#6b7280' },
};

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

function isAnimatedStatus(key) {
  return key === 'production' || key === 'available' || key === 'idle';
}

function MachineCard({ m, stationName, dimmed, theme: t, onOpen }) {
  const color = m.imm_status_color || STATUS_META[m.imm_status]?.color || '#6b7280';
  const label = m.imm_status_label || STATUS_META[m.imm_status]?.label || '—';
  const animate = isAnimatedStatus(m.imm_status) && !dimmed;
  const typeLine = [m.machine_type || 'IMM', m.make].filter(Boolean).map(stripCjk).join(' · ');

  return (
    <button
      type="button"
      onClick={onOpen}
      title={stripCjk(m.name)}
      style={{
        background: t.surface2 || t.surface,
        borderRadius: 12,
        padding: 14,
        border: `2px solid ${color}`,
        textAlign: 'center',
        position: 'relative',
        cursor: 'pointer',
        opacity: dimmed ? 0.38 : 1,
        transition: 'border-color .25s ease, transform .2s ease, box-shadow .25s ease',
        boxShadow: animate ? `0 0 18px ${color}33` : 'none',
        color: 'inherit',
        width: '100%',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-3px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div style={{ position: 'relative', width: 88, height: 88, margin: '0 auto 10px' }}>
        {animate && (
          <>
            <div style={{
              position: 'absolute',
              inset: -5,
              borderRadius: '50%',
              border: `3px solid ${color}`,
              animation: 'pulse-ring 1.8s ease-out infinite',
              opacity: 0.55,
              pointerEvents: 'none',
            }}
            />
            <div style={{
              position: 'absolute',
              inset: -5,
              borderRadius: '50%',
              border: `2px solid ${color}`,
              animation: 'pulse-ring 1.8s ease-out 0.6s infinite',
              opacity: 0.35,
              pointerEvents: 'none',
            }}
            />
          </>
        )}
        <div style={{
          width: 88,
          height: 88,
          borderRadius: 12,
          overflow: 'hidden',
          border: `3px solid ${color}`,
          background: t.surface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: animate ? 'immMachineBob 2.4s ease-in-out infinite' : 'none',
        }}
        >
          {m.image_url ? (
            <img
              src={assetUrl(m.image_url)}
              alt={stripCjk(m.name)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                animation: animate ? 'immMachineGlow 2.4s ease-in-out infinite' : 'none',
              }}
            />
          ) : (
            <div style={{
              width: '78%',
              height: '62%',
              borderRadius: 8,
              background: `linear-gradient(135deg, ${color}aa, #94a3b8 55%, ${color})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 11,
              color: '#0f172a',
            }}
            >
              IMM
            </div>
          )}
        </div>
        <div style={{
          position: 'absolute',
          bottom: 2,
          right: 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: color,
          border: `2px solid ${t.surface2 || t.surface}`,
          boxShadow: animate ? `0 0 8px ${color}` : 'none',
        }}
        />
      </div>

      <div style={{ color: t.text, fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
        {stripCjk(m.name)}
      </div>
      <div style={{ color: t.textFaint || t.textMuted, fontSize: 11, marginBottom: 4 }}>
        {stripCjk(stationName || m.station_name || '—')}
      </div>
      <div style={{
        color: t.textFaint || t.textMuted,
        fontSize: 10,
        marginBottom: 4,
        fontStyle: 'italic',
      }}
      >
        {m.operator_name ? `Op: ${stripCjk(m.operator_name)}` : 'No operator'}
      </div>
      {typeLine ? (
        <div style={{ color: t.textFaint || t.textMuted, fontSize: 11, marginBottom: 6 }}>
          {typeLine}
        </div>
      ) : null}

      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 999,
        background: `${color}22`,
        marginBottom: 6,
      }}
      >
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: animate ? `0 0 6px ${color}` : 'none',
        }}
        />
        <span style={{ color, fontSize: 11, fontWeight: 800 }}>{label}</span>
      </div>

      {(m.imm_status === 'production' || m.imm_status === 'available') && !m.has_plan && (
        <div style={{
          fontSize: 10,
          color: '#f59e0b',
          background: '#f59e0b22',
          border: '1px solid #f59e0b55',
          borderRadius: 6,
          padding: '3px 8px',
          fontWeight: 700,
        }}
        >
          ⚠ No Plan Assigned
        </div>
      )}
    </button>
  );
}

export default function ImmDeviceMonitor() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [factoryMeta, setFactoryMeta] = useState({ factory_name: '', factories: [] });
  const [filter, setFilter] = useState('all');
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

  const counts = data?.counts || {
    total: 0, production: 0, available: 0, idle: 0, stop: 0, warning: 0, abnormal: 0, offline: 0,
  };
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
      <style>{`
        @keyframes immMachineBob {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-3px); }
        }
        @keyframes immMachineGlow {
          0%, 100% { filter: brightness(1); }
          50% { filter: brightness(1.12); }
        }
      `}</style>
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

      <div style={s.legendRow}>
        <span style={{ color: t.textMuted, fontSize: 12, fontWeight: 600 }}>MACHINE TYPES</span>
        {makes.map((mk, i) => (
          <span
            key={mk}
            style={{
              ...s.makeTag,
              borderLeft: i === 0 ? `3px dashed ${t.accent}` : `3px solid ${t.accent}`,
            }}
          >
            {stripCjk(mk)}
          </span>
        ))}
        <button
          type="button"
          style={{ ...s.linkBtn, marginLeft: 'auto' }}
          onClick={() => navigate('/imm/kpis')}
        >
          Historical Data →
        </button>
      </div>

      <div style={s.countRow}>
        {[
          { key: 'all', countKey: 'total', label: 'Total Equipment', color: '#22d3ee' },
          { key: 'production', countKey: 'production', label: 'Running', color: '#22c55e' },
          { key: 'available', countKey: 'available', label: 'Available', color: '#3b82f6' },
          { key: 'idle', countKey: 'idle', label: 'Idle', color: '#eab308' },
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

      <div style={s.gridWrap}>
        <h4 style={{
          color: t.accent,
          margin: '0 0 14px',
          fontSize: 14,
          fontWeight: 700,
        }}
        >
          Machine Status Layout
        </h4>
        {loading && <div style={s.empty}>Loading equipment…</div>}
        {!loading && filteredStations.length === 0 && (
          <div style={s.empty}>No machines match this status filter.</div>
        )}
        {filteredStations.map((st) => (
          <div key={st.station_id} style={s.stationBlock}>
            <div style={s.stationLabel}>{stripCjk(st.station_name)}</div>
            <div style={s.deviceGrid}>
              {(st.machines || []).map((m) => (
                <MachineCard
                  key={m.id}
                  m={m}
                  stationName={st.station_name}
                  dimmed={filter !== 'all' && m.imm_status !== filter}
                  theme={t}
                  onOpen={() => navigate(`/imm/equipment/${m.id}`)}
                />
              ))}
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
    stationBlock: { marginBottom: 20 },
    stationLabel: {
      color: t.accent, fontWeight: 700, fontSize: 13, marginBottom: 10,
      letterSpacing: 0.4, textTransform: 'uppercase',
    },
    deviceGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
      gap: 12,
    },
    empty: { color: t.textFaint, textAlign: 'center', padding: 40 },
  };
}
