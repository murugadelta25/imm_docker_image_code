import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../api/client';
import { assetUrl } from '../api/config';
import PageHeader from '../components/PageHeader';
import ImmDashboardSelector from '../components/ImmDashboardSelector';
import AnimatedBarChart from '../components/charts/AnimatedBarChart';
import DonutGauge from '../components/charts/DonutGauge';
import RejectionLogModal from '../components/RejectionLogModal';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass, tileClass } from '../themes/tileHelpers';
import { formatRejectionNote } from '../constants/rejectionReasons';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

function fmtQty(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function oeeColor(pct) {
  const n = Number(pct) || 0;
  if (n >= 85) return '#22c55e';
  if (n >= 65) return '#eab308';
  if (n > 0) return '#ef4444';
  return '#94a3b8';
}

function statusBarStyle(m, t) {
  const key = m.imm_status || m.eap_imm_status || 'offline';
  if (key === 'production' || key === 'running') {
    return { bg: '#16a34a', fg: '#fff', label: 'Running' };
  }
  if (key === 'available') {
    return { bg: '#2563eb', fg: '#fff', label: 'Available' };
  }
  if (key === 'idle') {
    return { bg: '#0ea5e9', fg: '#041018', label: 'Idle' };
  }
  if (key === 'stop') {
    return { bg: '#dc2626', fg: '#fff', label: 'Stop' };
  }
  if (key === 'offline') {
    return { bg: '#64748b', fg: '#fff', label: 'Offline' };
  }
  return {
    bg: m.imm_status_color || t.textFaint || '#64748b',
    fg: '#fff',
    label: m.imm_status_label || '—',
  };
}

function MachineZoneTile({ m, theme: t, onOpen, onBadParts, onDowntime }) {
  const tile = m.tile || {};
  const oee = Number(tile.oee) || 0;
  const status = statusBarStyle(m, t);
  const rows = [
    { key: 'prod', label: 'Shift Production (Unit)', value: fmtQty(tile.total_production) },
    { key: 'good', label: 'Shift Good Parts (Unit)', value: fmtQty(tile.total_good) },
    {
      key: 'bad',
      label: 'Shift Bad Parts (Unit)',
      value: fmtQty(tile.total_bad),
      action: onBadParts,
      hint: 'Log rejection reasons',
      accent: '#ef4444',
    },
    {
      key: 'dt',
      label: 'Shift Downtime (Min.)',
      value: tile.downtime_min == null ? '—' : fmtQty(tile.downtime_min),
      action: onDowntime,
      hint: 'Log downtime reason',
      accent: '#f59e0b',
    },
    {
      key: 'lasthr',
      label: 'Last Hr Bad Parts (Unit)',
      value: tile.last_hr_bad == null ? '—' : fmtQty(tile.last_hr_bad),
    },
  ];

  return (
    <div
      className={tileClass(t)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: 0,
        overflow: 'hidden',
        background: t.isDark === false || t.id === 'light' ? '#e8eef3' : (t.surface2 || '#0f172a'),
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        textAlign: 'left',
        minHeight: 420,
        color: 'inherit',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        style={{
          background: '#111827',
          color: '#facc15',
          fontWeight: 800,
          fontSize: 14,
          textAlign: 'center',
          padding: '8px 6px',
          letterSpacing: 0.3,
          border: 'none',
          cursor: 'pointer',
          width: '100%',
        }}
      >
        {stripCjk(m.name)}
      </button>

      <div style={{ padding: '6px 8px 0' }}>
        {rows.map((r) => {
          const clickable = typeof r.action === 'function';
          const RowTag = clickable ? 'button' : 'div';
          return (
            <RowTag
              key={r.key}
              type={clickable ? 'button' : undefined}
              title={r.hint}
              onClick={clickable ? (e) => { e.stopPropagation(); r.action(); } : undefined}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.15fr 0.85fr',
                gap: 4,
                marginBottom: 4,
                width: '100%',
                padding: 0,
                border: 'none',
                background: 'transparent',
                cursor: clickable ? 'pointer' : 'default',
                textAlign: 'left',
              }}
            >
              <div style={{
                background: t.isDark === false || t.id === 'light' ? '#dbe3ea' : '#1e293b',
                border: `1px solid ${clickable ? (r.accent || t.accent) : t.border}`,
                padding: '5px 7px',
                fontSize: 11,
                fontWeight: 700,
                color: clickable ? (r.accent || t.accent) : t.text,
                textDecoration: clickable ? 'underline' : 'none',
                textDecorationStyle: clickable ? 'dotted' : undefined,
              }}>
                {r.label}
              </div>
              <div style={{
                background: t.isDark === false || t.id === 'light' ? '#fff' : '#0b1220',
                border: `1px solid ${clickable ? (r.accent || t.accent) : t.border}`,
                padding: '5px 7px',
                fontSize: 11,
                fontWeight: 800,
                color: clickable ? (r.accent || t.text) : t.text,
                textAlign: 'right',
              }}>
                {r.value}
              </div>
            </RowTag>
          );
        })}
      </div>

      <div style={{
        margin: '6px 8px 0',
        background: '#374151',
        color: '#fff',
        fontWeight: 800,
        fontSize: 12,
        textAlign: 'center',
        padding: '5px 6px',
      }}>
        Inprocess Insp.
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 4px' }}>
        <DonutGauge
          value={oee}
          color={oeeColor(oee)}
          trackColor={t.isDark === false || t.id === 'light' ? '#cbd5e1' : '#1e293b'}
          theme={t}
          valueSize={18}
          valueText={(
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: t.textMuted || '#94a3b8' }}>OEE</span>
              <span style={{ fontSize: 18, fontWeight: 800 }}>{Math.round(oee)} %</span>
            </span>
          )}
        />
      </div>

      <button
        type="button"
        onClick={onOpen}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4px 10px 8px',
          minHeight: 88,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          width: '100%',
        }}
      >
        {m.image_url ? (
          <img
            src={assetUrl(m.image_url)}
            alt={stripCjk(m.name)}
            style={{ maxWidth: '100%', maxHeight: 96, objectFit: 'contain' }}
          />
        ) : (
          <div style={{
            width: '86%',
            height: 72,
            borderRadius: 8,
            background: `linear-gradient(135deg, #ef4444 0%, #eab308 35%, #22c55e 65%, #3b82f6 100%)`,
            opacity: 0.85,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#041018',
            fontWeight: 800,
            fontSize: 12,
          }}>
            IMM
          </div>
        )}
      </button>

      <button
        type="button"
        onClick={onOpen}
        style={{
          margin: '0 10px 10px',
          background: status.bg,
          color: status.fg,
          fontWeight: 800,
          fontSize: 13,
          textAlign: 'center',
          padding: '8px 6px',
          borderRadius: 4,
          border: 'none',
          cursor: 'pointer',
          width: 'calc(100% - 20px)',
        }}
      >
        {status.label}
      </button>
    </div>
  );
}

export default function ImmZoneDashboard() {
  const { zoneId } = useParams();
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [zones, setZones] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [focusLine, setFocusLine] = useState(null);
  const [rejectionModal, setRejectionModal] = useState({
    open: false, machine: null, initialJson: null, maxTotal: null, error: '', saving: false,
  });
  const inflightRef = useRef(false);
  const zonesLoadedRef = useRef(false);

  const statusMeta = {
    running: { label: 'Running', color: t.brand || '#77AF46' },
    available: { label: 'Available', color: '#3b82f6' },
    warning: { label: 'Warning', color: '#eab308' },
    idle: { label: 'Idle', color: t.textDim || '#22cae7' },
    stop: { label: 'Stop', color: '#ef4444' },
    offline: { label: 'Offline', color: t.textFaint || '#9ec8de' },
    abnormal: { label: 'Warning', color: '#ef4444' },
  };

  const load = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      let id = zoneId;
      // Zone detail already returns zones[] — only hit /zones once for redirect when no zoneId
      if (!id) {
        try {
          const zr = await api.get('/api/imm/dashboard/zones');
          const list = zr.data?.zones || [];
          setZones(list);
          zonesLoadedRef.current = true;
          id = list[0]?.id;
        } catch (e) {
          // If zones timeout/fail, show loading instead of error
          setZones([]);
          setErr('');
          setLoading(true);
          return;
        }
        
        if (!id) {
          setData(null);
          setErr('No zones configured. Add Departments → Zones and assign stations in Factory Setup.');
          setLoading(false);
          return;
        }
        navigate(`/imm/zone/${encodeURIComponent(id)}`, { replace: true });
        return;
      }
      
      // Load zone detail with fast timeout
      try {
        const r = await api.get(`/api/imm/dashboard/zone/${encodeURIComponent(id)}`);
        setData(r.data);
        if (Array.isArray(r.data?.zones) && r.data.zones.length) {
          setZones(r.data.zones);
          zonesLoadedRef.current = true;
        } else if (!zonesLoadedRef.current) {
          try {
            const zr = await api.get('/api/imm/dashboard/zones');
            setZones(zr.data?.zones || []);
            zonesLoadedRef.current = true;
          } catch {
            // zones timeout is ok, we have data from zone detail
          }
        }
        setErr('');
        const firstStation = r.data?.stations?.[0];
        const firstBlockId = firstStation
          ? `station-${firstStation.id}`
          : (r.data?.lines?.[0]?.id || null);
        setFocusLine((prev) => prev || firstBlockId);
        setLoading(false);
        
        // WebSocket polling will be managed by useEffect below
      } catch (e) {
        // Zone detail failed - show loading state, not error
        if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
          setErr('');
          setLoading(true);
        } else {
          setErr(e.response?.data?.detail || e.message || 'Failed to load zone dashboard');
          setLoading(false);
        }
      }
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load zone dashboard');
      setLoading(false);
    } finally {
      inflightRef.current = false;
    }
  }, [zoneId, navigate]);

  useEffect(() => { load(); }, [load]);
  
  useEffect(() => {
    // Don't poll immediately - only after initial load completes
    let pollId = null;
    const delayId = setTimeout(() => {
      // After 5 minutes, start polling every 30 seconds (not 15s)
      pollId = setInterval(() => {
        if (!inflightRef.current) load();
      }, 30000);
    }, 300000); // 5 minutes
    
    return () => {
      clearTimeout(delayId);
      if (pollId) clearInterval(pollId);
    };
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

  const openBadPartsLog = async (m) => {
    const tile = m.tile || {};
    const entryDate = tile.entry_date || data?.plan_achievement?.plan_date || data?.current_shift?.plan_date;
    const shift = tile.shift_id || data?.plan_achievement?.shift_id || data?.current_shift?.shift_id;
    if (!m.id || !entryDate || !shift) {
      setErr('Cannot open Rejection Log — shift/date not available for this machine.');
      return;
    }
    let initialJson = null;
    let maxTotal = Number(tile.total_production) || 0;
    try {
      const r = await api.get('/api/oee/rejection/by-machine', {
        params: { machine_id: m.id, entry_date: entryDate, shift },
      });
      initialJson = r.data?.rejection_json || null;
      if (r.data?.actual_qty != null) maxTotal = Number(r.data.actual_qty) || maxTotal;
    } catch { /* empty form */ }
    setRejectionModal({
      open: true,
      machine: { ...m, entry_date: entryDate, shift },
      initialJson,
      maxTotal,
      error: '',
      saving: false,
    });
  };

  const saveBadPartsLog = async ({ quantities, total }) => {
    const m = rejectionModal.machine;
    if (!m) return;
    setRejectionModal((p) => ({ ...p, saving: true, error: '' }));
    try {
      await api.patch('/api/oee/defect/by-machine', {
        machine_id: m.id,
        entry_date: m.entry_date,
        shift: m.shift,
        defect_qty: total,
        note: formatRejectionNote(quantities),
        rejection_reasons: quantities,
      });
      setRejectionModal({
        open: false, machine: null, initialJson: null, maxTotal: null, error: '', saving: false,
      });
      load();
    } catch (e) {
      setRejectionModal((p) => ({
        ...p,
        saving: false,
        error: e.response?.data?.detail || e.message || 'Failed to save rejection log',
      }));
    }
  };

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
                { key: 'available', count: sc.available || 0 },
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
              {loading ? (
                <>
                  <div style={{ fontSize: 14, color: t.textMuted, marginBottom: 12 }}>Loading machines for this zone...</div>
                  <div style={{ fontSize: 12, color: t.textFaint }}>Please wait while we fetch the data</div>
                </>
              ) : (
                <>
                  No machines for this zone yet. In Machine Management, set Station and Location to this zone
                  (or assign the station under Factory Setup → Zone).
                </>
              )}
            </div>
          )}
          {blockMachines.map((m) => (
            <MachineZoneTile
              key={m.id}
              m={m}
              theme={t}
              onOpen={() => navigate(`/imm/equipment/${m.id}`)}
              onBadParts={() => openBadPartsLog(m)}
              onDowntime={() => navigate(`/breakdown?machineId=${m.id}`)}
            />
          ))}
        </div>
      </section>

      <RejectionLogModal
        open={rejectionModal.open}
        theme={t}
        subtitle={rejectionModal.machine
          ? `${stripCjk(rejectionModal.machine.name)} · ${rejectionModal.machine.entry_date} · Shift ${rejectionModal.machine.shift}`
          : ''}
        initialJson={rejectionModal.initialJson}
        maxTotal={rejectionModal.maxTotal}
        busy={rejectionModal.saving}
        error={rejectionModal.error}
        onClose={() => setRejectionModal({
          open: false, machine: null, initialJson: null, maxTotal: null, error: '', saving: false,
        })}
        onSave={saveBadPartsLog}
      />
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
      gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
      gap: 14,
      alignItems: 'stretch',
    },
    empty: { color: t.textFaint, padding: 24, textAlign: 'center', gridColumn: '1 / -1' },
  };
}
