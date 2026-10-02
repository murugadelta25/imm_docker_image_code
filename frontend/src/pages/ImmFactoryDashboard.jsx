import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ImmDashboardSelector from '../components/ImmDashboardSelector';
import FreeformTileBoard from '../components/FreeformTileBoard';
import AnimatedBarChart from '../components/charts/AnimatedBarChart';
import DonutGauge from '../components/charts/DonutGauge';
import OverviewDonutGauge from '../components/charts/OverviewDonutGauge';
import LineAchievementBarChart from '../components/charts/LineAchievementBarChart';
import LineUtilizationBarChart from '../components/charts/LineUtilizationBarChart';
import RunningRateTrendChart from '../components/charts/RunningRateTrendChart';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass, tileClass } from '../themes/tileHelpers';
import { hourlyRunningRateColor, seriesColor } from '../utils/heatMap';
import { statusPalette, STATUS_ROWS } from '../utils/overviewStatus';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

/** Per-station running % bars inside a zone (fallback: configured lines). */
function zoneEquipmentBars(z) {
  const machines = z.machines || [];
  const stations = z.stations || [];
  if (stations.length && machines.length) {
    return stations.map((st) => {
      const stMachines = machines.filter((m) => Number(m.station_id) === Number(st.id));
      const total = stMachines.length;
      const running = stMachines.filter((m) => m.imm_status === 'production').length;
      const pct = total > 0 ? Math.round((1000 * running) / total) / 10 : 0;
      return { name: stripCjk(st.name), pct };
    });
  }
  return (z.lines || []).map((l) => ({
    name: stripCjk(l.name),
    pct: l.running_pct ?? 0,
  }));
}

export default function ImmFactoryDashboard() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [trendData, setTrendData] = useState(null);
  const [err, setErr] = useState('');
  const resetTilesRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [r, tr] = await Promise.all([
        api.get('/api/imm/dashboard/factory'),
        api.get('/api/imm/dashboard/factory/running-rate-trend'),
      ]);
      setData(r.data);
      setTrendData(tr.data);
      setErr('');
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load factory dashboard');
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const zones = data?.zones || [];
  const zoneBars = useMemo(
    () => zones.map((z) => ({
      name: stripCjk(z.name),
      pct: z.running_pct,
      running: z.running,
      id: z.id,
    })),
    [zones],
  );
  const hitBars = useMemo(
    () => zones.map((z) => ({ name: stripCjk(z.name), pct: z.hit_rate ?? z.running_pct, id: z.id })),
    [zones],
  );
  const achieveBars = useMemo(
    () => zones.map((z) => ({
      id: z.id,
      name: stripCjk(z.name),
      pct: z.achievement_has_plan ? (z.achievement_pct ?? 0) : 0,
      actual: z.achievement_actual ?? 0,
      planned: z.achievement_planned ?? 0,
    })),
    [zones],
  );

  const s = styles(t);
  const isDark = t?.isDark !== false && t?.id !== 'light';
  const statusColors = statusPalette(isDark);
  const rr = data?.running_rate || { pct: 0, running: 0, total: 0 };
  const ar = data?.achievement_rate || { pct: null, actual: 0, planned: 0, has_plan: false };
  const at = data?.achievement_today || { pct: null, actual: 0, planned: 0, has_plan: false, by_shift: [] };
  const sc = data?.status_counts || {};
  const util = data?.utilization || {};
  const em = data?.energy_meter || {};
  const chartFill = t.accent;
  const chartFillAlt = t.brand || t.accent;

  const todayShiftBars = useMemo(
    () => (at.by_shift || []).map((sh) => ({
      name: stripCjk(sh.name || sh.id),
      pct: sh.has_plan ? (sh.pct ?? 0) : null,
      planned: sh.planned,
      actual: sh.actual,
      has_plan: !!sh.has_plan,
      id: sh.id,
    })),
    [at.by_shift],
  );

  const utilZones = useMemo(() => {
    if (util.by_line?.length) return util.by_line;
    return zones.map((z) => ({
      id: z.id,
      name: z.name,
      uptime_min: z.uptime_min,
      downtime_min: z.downtime_min,
      mttr_min: z.mttr_min,
      mtbf_min: z.mtbf_min,
    }));
  }, [util.by_line, zones]);

  const trendWithColors = useMemo(() => {
    if (!trendData) return null;
    return {
      ...trendData,
      lines: (trendData.lines || []).map((ln, i) => ({
        ...ln,
        color: hourlyRunningRateColor(i, isDark),
      })),
    };
  }, [trendData, isDark]);

  const cardShell = {
    background: isDark ? t.surface : '#ffffff',
    border: `1px solid ${isDark ? (t.border || '#334155') : '#cbd5e1'}`,
    borderRadius: 12,
    boxShadow: isDark
      ? '0 0 0 1px rgba(56,189,248,0.08)'
      : '0 2px 10px rgba(15,23,42,0.08), 0 0 0 1px rgba(15,23,42,0.04)',
  };

  const tiles = [
    {
      id: 'planAchieveToday',
      style: cardShell,
      header: <h3 style={s.cardTitle}>Plan Achievement (Today)</h3>,
      body: !at.has_plan ? (
        <div style={{
          ...s.tileBody,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 180,
          color: t.textMuted,
          fontSize: 15,
          fontWeight: 700,
        }}>
          No plan
        </div>
      ) : (
        <div style={s.tileBody}>
          <AnimatedBarChart
            data={todayShiftBars.map((sh) => ({
              name: sh.name,
              pct: sh.pct == null ? 0 : sh.pct,
            }))}
            theme={t}
            series={[{ key: 'pct', label: 'Achievement %', color: '#22c55e' }]}
            yDomain={[0, 100]}
            yLabel="Achievement %"
            xLabel="Shift"
            height={220}
            showLegend
          />
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, padding: '0 8px 8px',
            fontSize: 11, fontWeight: 700, color: t.textDim,
          }}>
            {todayShiftBars.map((sh) => (
              <span key={sh.id || sh.name}>
                {sh.name}: {sh.has_plan
                  ? `${Math.round(Number(sh.pct) || 0)}% (${Math.round(sh.actual || 0)}/${Math.round(sh.planned || 0)})`
                  : 'No plan'}
              </span>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: 'runningByLine',
      style: cardShell,
      header: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px 4px' }}>
          <h3 style={{ ...s.cardTitle, padding: 0 }}>Hourly Running Rate by Zone</h3>
          {trendData?.shift_name && (
            <span style={{ fontSize: 11, fontWeight: 700, color: t.textDim }}>
              {trendData.shift_name} · {trendData.shift_start}–{trendData.shift_end}
            </span>
          )}
        </div>
      ),
      body: (
        <div style={s.tileBodyChart}>
          <RunningRateTrendChart
            data={trendWithColors}
            theme={t}
            xLabel="Hour"
            yLabel="Running Rate %"
            onLineClick={(ln) => navigate(`/imm/zone/${encodeURIComponent(ln.id)}`)}
          />
        </div>
      ),
    },
    {
      id: 'energyMeter',
      style: cardShell,
      header: <h3 style={s.cardTitle}>Plant Energy Meter</h3>,
      body: (
        <div style={{
          ...s.tileBody,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '8px 12px 12px',
          justifyContent: 'center',
          overflow: 'auto',
        }}>
          {[
            ['Total_Active_Energy', 'kWh', em.Total_Active_Energy],
            ['Total_Appearent_Energy', 'kVAh', em.Total_Appearent_Energy],
            ['Total_Reactive_Energy', 'kVARh', em.Total_Reactive_Energy],
          ].map(([key, unit, v]) => {
            const raw = v?.value_text ?? (v?.value_num != null ? v.value_num : null);
            let display = '—';
            if (raw != null && raw !== '') {
              const n = Number(raw);
              display = Number.isFinite(n)
                ? n.toLocaleString('en-US', { maximumFractionDigits: 3 })
                : String(raw);
            }
            return (
              <div
                key={key}
                style={{
                  background: isDark ? (t.surface2 || '#1e293b') : '#f1f5f9',
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted }}>
                  {key}
                  <span style={{ fontWeight: 600, color: t.textDim }}> ({unit})</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: t.accent || '#0ea5e9', marginTop: 4 }}>
                  {display === '—' ? '—' : `${display} ${unit}`}
                </div>
              </div>
            );
          })}
        </div>
      ),
    },
    {
      id: 'planAchieve',
      style: cardShell,
      header: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px 4px', gap: 8 }}>
          <h3 style={{ ...s.cardTitle, padding: 0 }}>
            Plan Achievement ({stripCjk(ar.shift_name || 'current shift')})
          </h3>
          {(ar.shift_start || ar.shift_end) && (
            <span style={{ fontSize: 11, fontWeight: 700, color: t.textDim, whiteSpace: 'nowrap' }}>
              {ar.shift_start}–{ar.shift_end}
            </span>
          )}
        </div>
      ),
      body: !ar.has_plan ? (
        <div style={{
          ...s.tileBodyRow,
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 180,
          color: t.textMuted,
          fontSize: 15,
          fontWeight: 700,
        }}>
          No plan
        </div>
      ) : (
        <div style={s.tileBodyRow}>
          <div style={s.tileBodyFlex}>
            <OverviewDonutGauge
              key={`ar-${ar.pct}-${ar.planned}-${ar.shift_id}`}
              value={Math.round(Number(ar.pct) || 0)}
              useHeatMap
              size={200}
              trackColor={isDark ? (t.surface2 || '#1e293b') : '#e2e8f0'}
              theme={t}
              label="Actual"
              showLegend
            />
          </div>
          <div style={s.equipStats}>
            <div style={s.equipStat}>
              <div style={s.equipStatLabel}>Actual Produced Qty</div>
              <div style={s.equipStatValue}>{Math.round(Number(ar.actual) || 0)}</div>
              <div style={s.equipStatUnit}>units</div>
            </div>
            <div style={s.equipStatDivider} />
            <div style={s.equipStat}>
              <div style={s.equipStatLabel}>Total Planned Quantity</div>
              <div style={s.equipStatValue}>{Math.round(Number(ar.planned) || 0)}</div>
              <div style={s.equipStatUnit}>units</div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'achieveByLine',
      style: cardShell,
      header: <h3 style={s.cardTitle}>Achievement by Zone</h3>,
      body: (
        <div style={s.tileBody}>
          <LineAchievementBarChart
            items={achieveBars}
            theme={t}
            height="100%"
            trackColor={isDark ? (t.surface2 || '#1e293b') : '#e2e8f0'}
            yLabel="Qty / %"
            xLabel="Zone"
            onBarClick={(item) => navigate(`/imm/zone/${encodeURIComponent(item.id)}`)}
          />
        </div>
      ),
    },
    {
      id: 'overallUtil',
      style: cardShell,
      header: (
        <div style={s.utilHeader}>
          <h3 style={s.utilTitle}>Overall Utilization</h3>
          <span style={s.shiftBadge}>{util.shift_name || '—'}</span>
        </div>
      ),
      body: (
        <div style={s.tileBody}>
          <LineUtilizationBarChart
            items={utilZones}
            theme={t}
            height="100%"
            trackColor={isDark ? (t.surface2 || '#1e293b') : '#e2e8f0'}
            yLabel="Minutes"
            xLabel="Zone"
            onBarClick={(item) => navigate(`/imm/zone/${encodeURIComponent(item.id)}`)}
          />
        </div>
      ),
    },
  ];

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader
        title={(
          <ImmDashboardSelector
            mode="factory"
            factoryName={stripCjk(data?.factory_name || data?.site_label || '')}
            factories={data?.factories || []}
          />
        )}
        onRefresh={load}
      />
      {err && <div style={s.alert}>{err}</div>}
      {data?.zones_hint && !zones.length && <div style={s.hint}>{stripCjk(data.zones_hint)}</div>}

      <FreeformTileBoard tiles={tiles} theme={t} minBoardHeight={620} resetRef={resetTilesRef} />

      <section className={surfaceClass(t)} style={{ ...s.card, ...s.statusCard }}>
        <div style={s.sectionHead}>
          <h3 style={s.sectionTitle}>Overall Machine Status</h3>
          <div style={s.resetInline}>
            <span style={s.dragHint}>Drag title · resize corner</span>
            <button type="button" onClick={() => resetTilesRef.current?.()} style={s.resetBtn}>
              Reset tiles
            </button>
          </div>
        </div>
        <div style={s.statusRow}>
          {STATUS_ROWS.map(([key, label]) => {
            const palette = statusColors[key] || statusColors.offline;
            return (
              <div
                key={key}
                style={{
                  ...s.statusChip,
                  background: palette.bg,
                  border: `2px solid ${palette.border}`,
                  boxShadow: isDark
                    ? `0 0 12px ${palette.color}33, inset 0 0 8px ${palette.color}18`
                    : '0 1px 3px rgba(15,23,42,0.08)',
                }}
              >
                <span style={{ ...s.statusVal, color: palette.color }}>{sc[key] ?? 0}</span>
                <span style={{ ...s.statusLbl, color: palette.color }}>{label}</span>
              </div>
            );
          })}
        </div>
      </section>

      <div style={s.immGrid}>
        <section className={surfaceClass(t)} style={s.card}>
          <h3 style={s.cardTitle}>Equipment Running Rate</h3>
          <DonutGauge value={rr.pct} color={chartFill} trackColor={t.surface2} theme={t} label="Running" />
          <div style={s.statLine}>Running Equipment: <strong style={{ color: t.text }}>{rr.running}</strong> units</div>
          <div style={s.statLine}>Total Equipment Quantity: <strong style={{ color: t.text }}>{rr.total}</strong> units</div>
        </section>

        <section className={surfaceClass(t)} style={s.card}>
          <h3 style={s.cardTitle}>Daily Running Equipment Statistics Per Zone</h3>
          <AnimatedBarChart
            data={zoneBars}
            theme={t}
            series={[{ key: 'pct', label: 'Running %', color: chartFill }]}
            yDomain={[0, 100]}
            yLabel="Running %"
            xLabel="Zone"
            height={220}
            showLegend
            labelKey="pct"
            labelFormatter={(v) => `${v}%`}
            onBarClick={(d) => d?.id && navigate(`/imm/zone/${encodeURIComponent(d.id)}`)}
          />
        </section>

        <section className={surfaceClass(t)} style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={s.cardTitle}>Daily Hit Rate Per Zone</h3>
            <button type="button" style={s.link} onClick={() => navigate('/imm/kpis')}>History</button>
          </div>
          <AnimatedBarChart
            data={hitBars}
            theme={t}
            series={[{ key: 'pct', label: 'Hit Rate %', color: chartFillAlt }]}
            yDomain={[0, 100]}
            yLabel="Hit Rate %"
            xLabel="Zone"
            height={220}
            showLegend
            labelKey="pct"
            labelFormatter={(v) => `${v}%`}
            onBarClick={(d) => d?.id && navigate(`/imm/zone/${encodeURIComponent(d.id)}`)}
          />
        </section>
      </div>

      <section className={surfaceClass(t)} style={{ ...s.card, ...s.linesCard }}>
        <h3 style={s.sectionTitle}>Zones</h3>
        <div style={s.lineGrid}>
          {zones.map((z, idx) => (
            <button
              key={z.id}
              type="button"
              style={{ ...s.lineTile, borderColor: z.color || seriesColor(idx) }}
              onClick={() => navigate(`/imm/zone/${encodeURIComponent(z.id)}`)}
            >
              <div style={{ fontWeight: 700, fontSize: 13 }}>{stripCjk(z.name)}</div>
              <div style={{ marginTop: 4, fontSize: 18, fontWeight: 800, color: z.color || seriesColor(idx) }}>
                {z.running_pct}%
              </div>
              <div style={{ fontSize: 11, color: t.textDim }}>
                {z.running}/{z.total} running
              </div>
            </button>
          ))}
          {!zones.length && (
            <div style={{ color: t.textDim, fontSize: 13 }}>
              {stripCjk(data?.zones_hint) || 'No zones configured.'}
            </div>
          )}
        </div>
      </section>

      <section className={surfaceClass(t)} style={{ ...s.card, marginTop: 0 }}>
        <h3 style={s.sectionTitle}>Zone Equipment Running Rate</h3>
        <div style={s.zoneGrid}>
          {zones.map((z) => {
            const fill = z.color || chartFill;
            return (
              <button
                key={z.id}
                type="button"
                className={tileClass(t)}
                style={s.zoneMini}
                onClick={() => navigate(`/imm/zone/${encodeURIComponent(z.id)}`)}
              >
                <div style={{ color: fill, fontWeight: 800, marginBottom: 6 }}>{stripCjk(z.name)}</div>
                <AnimatedBarChart
                  data={zoneEquipmentBars(z)}
                  theme={t}
                  series={[{ key: 'pct', label: 'Running %', color: fill }]}
                  yDomain={[0, 100]}
                  height={128}
                  hideYAxis
                  showGrid={false}
                  maxBarSize={28}
                  barCategoryGap="22%"
                  labelKey="pct"
                  labelFormatter={(v) => `${v}%`}
                  xLabel="Station"
                  xLabelSize={11}
                />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function styles(t) {
  const isLight = t.id === 'light';
  return {
    page: { padding: '8px 12px 16px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: '100%' },
    alert: {
      background: 'rgba(127, 29, 29, 0.35)',
      color: '#fecaca',
      border: `1px solid ${t.border}`,
      padding: 10,
      borderRadius: 8,
    },
    hint: {
      background: t.surface2 || '#f1f5f9',
      color: t.textDim || '#64748b',
      borderRadius: 8,
      padding: '8px 10px',
      fontSize: 13,
    },
    card: {
      background: isLight ? '#ffffff' : t.surface,
      borderRadius: 10,
      padding: '8px 12px 10px',
      border: `1px solid ${isLight ? '#cbd5e1' : (t.border || 'transparent')}`,
      minWidth: 0,
    },
    statusCard: { padding: '8px 12px 10px' },
    linesCard: { padding: '8px 12px 10px' },
    sectionHead: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap',
    },
    sectionTitle: { margin: 0, fontSize: 14, fontWeight: 700, color: t.text },
    cardTitle: {
      margin: '0 0 10px', padding: '8px 10px 4px', color: t.labelColor || t.text, fontSize: 13, fontWeight: 700,
    },
    utilHeader: {
      position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 36, padding: '8px 10px 4px',
    },
    utilTitle: {
      position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', margin: 0, fontSize: 13, fontWeight: 700, color: t.text,
    },
    shiftBadge: {
      fontSize: 11, fontWeight: 700, color: t.textDim, padding: '2px 8px', borderRadius: 999,
      border: `1px solid ${isLight ? '#cbd5e1' : (t.border || '#334155')}`,
      background: isLight ? '#f8fafc' : (t.surface2 || t.bg),
    },
    tileBody: { flex: 1, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', padding: '0 8px 8px' },
    tileBodyChart: {
      flex: 1, minHeight: 0, height: '100%', width: '100%', display: 'flex', flexDirection: 'column', padding: '0 6px 6px',
    },
    tileBodyRow: {
      flex: 1, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 8, padding: '0 8px 8px',
    },
    tileBodyFlex: { flex: 1.15, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
    equipStats: {
      flex: '0 0 138px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10, padding: '8px 6px',
      borderLeft: `1px solid ${isLight ? '#e2e8f0' : (t.border || '#334155')}`,
    },
    equipStat: { display: 'flex', flexDirection: 'column', gap: 2 },
    equipStatLabel: { fontSize: 11, fontWeight: 700, color: t.textDim, lineHeight: 1.25 },
    equipStatValue: { fontSize: 28, fontWeight: 800, color: t.text, fontVariantNumeric: 'tabular-nums' },
    equipStatUnit: { fontSize: 12, fontWeight: 600, color: t.textDim },
    equipStatDivider: { height: 1, background: isLight ? '#e2e8f0' : (t.border || '#334155') },
    statusRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 },
    statusChip: {
      borderRadius: 10, padding: '10px 6px', textAlign: 'center', minHeight: 64,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    },
    statusVal: { display: 'block', fontSize: 22, fontWeight: 800, lineHeight: 1.1 },
    statusLbl: { display: 'block', fontSize: 11, marginTop: 4, fontWeight: 800, letterSpacing: 0.3, textTransform: 'uppercase' },
    lineGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 },
    lineTile: {
      textAlign: 'left', background: isLight ? '#f8fafc' : (t.surface2 || t.bg), borderRadius: 8, padding: '8px 10px',
      border: '2px solid', cursor: 'pointer', color: t.text,
    },
    resetInline: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
    dragHint: { fontSize: 11, fontWeight: 600, color: t.textDim },
    resetBtn: {
      fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 7,
      border: `1px solid ${isLight ? '#94a3b8' : (t.border || '#334155')}`,
      background: isLight ? '#ffffff' : (t.surface2 || t.surface), color: t.text, cursor: 'pointer',
    },
    immGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: 12,
    },
    statLine: { color: t.textMuted, fontSize: 12, marginTop: 6 },
    link: { background: 'transparent', border: 'none', color: t.accent, cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    zoneGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 },
    zoneMini: {
      background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10, padding: 8, cursor: 'pointer', textAlign: 'left',
    },
  };
}
