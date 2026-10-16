import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import AnimatedBarChart from '../components/charts/AnimatedBarChart';
import { createPulseLeadShape } from '../components/charts/pulseLeadLineShape.jsx';
import { hourlyRunningRateColor } from '../utils/heatMap';
import { useConfig } from '../context/ConfigContext';
import { useTheme } from '../context/ThemeContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayStr = () => new Date().toISOString().slice(0, 10);

function weekRangeEndingToday() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6);
  return {
    date_from: start.toISOString().slice(0, 10),
    date_to: end.toISOString().slice(0, 10),
  };
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const diff = Math.round((b - a) / 86400000) + 1;
  return Math.max(1, Math.min(90, diff || 1));
}

const KPI_TABS = [
  { id: 'transfer', label: 'Transfer Rate' },
  { id: 'hit', label: 'Hit Rate' },
  { id: 'params', label: 'Equipment Parameter' },
];

export default function ImmKpiDashboard() {
  const { theme: t } = useTheme();
  const { config } = useConfig();
  const [mode, setMode] = useState('live'); // live | historic
  const [kpiTab, setKpiTab] = useState('transfer');
  const [viewMode, setViewMode] = useState('week');
  const [filters, setFilters] = useState(() => {
    const wr = weekRangeEndingToday();
    return {
      shift: '',
      entry_date: todayStr(),
      date_from: wr.date_from,
      date_to: wr.date_to,
      month: String(new Date().getMonth() + 1),
      year: String(new Date().getFullYear()),
      machine_id: '',
      zone_id: '',
    };
  });

  const [transfer, setTransfer] = useState(null);
  const [hit, setHit] = useState(null);
  const [params, setParams] = useState(null);
  const [tempTab, setTempTab] = useState('nozzle_temp');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [zonesList, setZonesList] = useState([]);

  const historicDays = useMemo(() => {
    if (mode === 'live') return 1;
    if (viewMode === 'day' || viewMode === 'shift' || viewMode === 'machine') return 1;
    if (viewMode === 'week') return daysBetween(filters.date_from, filters.date_to);
    if (viewMode === 'range') return daysBetween(filters.date_from, filters.date_to);
    if (viewMode === 'month' && filters.month && filters.year) {
      const m = Number(filters.month);
      const y = Number(filters.year);
      const last = new Date(y, m, 0).getDate();
      return last;
    }
    return 7;
  }, [mode, viewMode, filters]);

  const historicDate = useMemo(() => {
    if (mode === 'live') return todayStr();
    if (viewMode === 'day' || viewMode === 'shift' || viewMode === 'machine') return filters.entry_date || todayStr();
    return filters.date_to || todayStr();
  }, [mode, viewMode, filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const days = mode === 'live' ? 3 : historicDays;
      // Fetch only the active tab — avoids stacking 3 heavy APIs every poll
      if (kpiTab === 'transfer') {
        const tr = await api.get('/api/imm/history/transfer-rate', {
          params: mode === 'live' ? { live: true } : { days },
        });
        setTransfer(tr.data);
        if (tr.data?.zones?.length) setZonesList(tr.data.zones);
      } else if (kpiTab === 'hit') {
        const hr = await api.get('/api/imm/history/hit-rate', {
          params: { zone_id: filters.zone_id || undefined, date: historicDate },
        });
        setHit(hr.data);
        if (hr.data?.zones?.length) setZonesList(hr.data.zones);
        if (!filters.zone_id && hr.data?.zone?.id) {
          setFilters((p) => ({ ...p, zone_id: String(hr.data.zone.id) }));
        }
      } else {
        const ep = await api.get('/api/imm/history/equipment-parameters', {
          params: {
            zone_id: filters.zone_id || undefined,
            machine_id: filters.machine_id || undefined,
            days: mode === 'live' ? 1 : Math.min(days, 14),
          },
        });
        setParams(ep.data);
        if (ep.data?.zones?.length) setZonesList(ep.data.zones);
        if (!filters.zone_id && ep.data?.zone?.id) {
          setFilters((p) => ({ ...p, zone_id: String(ep.data.zone.id) }));
        }
        const equipIds = new Set((ep.data?.equipment || []).map((eq) => String(eq.id)));
        const midOk = filters.machine_id && equipIds.has(String(filters.machine_id));
        if (!midOk && ep.data?.machine_id != null) {
          setFilters((p) => ({ ...p, machine_id: String(ep.data.machine_id) }));
        }
      }
      setErr('');
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to load KPI dashboard');
    } finally {
      setLoading(false);
    }
  }, [mode, historicDays, historicDate, filters.zone_id, filters.machine_id, kpiTab]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (mode !== 'live') return undefined;
    // Transfer/hit are heavier — poll less aggressively
    const ms = kpiTab === 'params' ? 5000 : 15000;
    const id = setInterval(load, ms);
    return () => clearInterval(id);
  }, [mode, load, kpiTab]);

  const isLiveTransfer = mode === 'live' && transfer?.mode === 'live';

  const transferChart = useMemo(() => {
    if (isLiveTransfer) {
      const slots = transfer?.slots || [];
      return slots.map((slot, i) => {
        const row = { slot: String(slot).split('-')[0]?.trim() || slot, slotFull: slot };
        for (const s of transfer?.series || []) {
          row[s.id] = s.hourly_pct?.[i] ?? s.points?.[i]?.pct ?? null;
        }
        return row;
      });
    }
    const dates = transfer?.dates || [];
    return dates.map((d, i) => {
      const row = { date: d };
      for (const s of transfer?.series || []) row[s.id] = s.points?.[i]?.pct ?? null;
      return row;
    });
  }, [transfer, isLiveTransfer]);

  const transferSeries = useMemo(() => {
    const isDark = t?.isDark !== false && t?.id !== 'light';
    return (transfer?.series || []).map((s, i) => ({
      ...s,
      reactKey: `xfer-${String(s.id)}-${i}`,
      color: isLiveTransfer
        ? (s.id === 'all' ? '#38bdf8' : hourlyRunningRateColor(Math.max(0, i - 1), isDark))
        : s.color,
      legendLabel: s.id === 'all' ? 'All' : `${stripCjk(s.name)} - Zone`,
    }));
  }, [transfer, isLiveTransfer, t]);

  const zoneOptions = zonesList.length
    ? zonesList
    : (hit?.zones || transfer?.zones || params?.zones || []);

  const isEnergyUtility = (eq) => {
    const n = String(eq?.name || '').trim().toUpperCase();
    const t = String(eq?.machine_type || '').trim().toUpperCase();
    return t === 'ENERGY' || t === 'UTILITY' || t === 'METER'
      || n === 'EM_PLANT' || n.startsWith('EM_') || n.startsWith('PANEL-');
  };
  const machineOptions = (params?.equipment || []).filter((eq) => !isEnergyUtility(eq));
  const selectedMachineName = (
    machineOptions.find((eq) => String(eq.id) === String(filters.machine_id))?.name
    || (params?.machine_name && !isEnergyUtility({ name: params.machine_name }) ? params.machine_name : '')
    || machineOptions[0]?.name
    || ''
  );

  const sel = {
    padding: '7px 10px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.surface2 || t.bg,
    color: t.text,
    fontSize: 13,
  };
  const chip = (on) => ({
    border: `1px solid ${on ? t.accent : t.border}`,
    background: on ? t.accent : (t.surface2 || t.bg),
    color: on ? '#fff' : t.textMuted,
    borderRadius: 8,
    padding: '7px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
  });
  const card = {
    background: t.surface,
    border: `1px solid ${t.border}`,
    borderRadius: 12,
    padding: 14,
    minWidth: 0,
  };

  const showContextFilters = mode === 'historic' || kpiTab === 'hit' || kpiTab === 'params';

  return (
    <div className={pageClass(t)} style={{ padding: 16 }}>
      <PageHeader title="IMM KPI's Dashboard" onRefresh={load} />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" style={chip(mode === 'live')} onClick={() => setMode('live')}>Live</button>
        <button type="button" style={chip(mode === 'historic')} onClick={() => setMode('historic')}>Historic</button>
        {loading && <span style={{ color: t.textFaint, fontSize: 12, alignSelf: 'center' }}>Loading…</span>}
        {mode === 'live' && (
          <span style={{ color: t.accent, fontSize: 12, fontWeight: 700, alignSelf: 'center' }}>
            ● Real-time ({kpiTab === 'params' ? '5s' : '15s'})
          </span>
        )}
      </div>

      {showContextFilters && (
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
          marginBottom: 12, background: t.surface, border: `1px solid ${t.border}`,
          borderRadius: 12, padding: 12,
        }}>
          {mode === 'historic' && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['week', 'day', 'range', 'shift', 'month', 'machine'].map((v) => (
                  <button
                    key={v}
                    type="button"
                    style={chip(viewMode === v)}
                    onClick={() => {
                      if (v === 'week') {
                        const wr = weekRangeEndingToday();
                        setFilters((p) => ({ ...p, date_from: wr.date_from, date_to: wr.date_to }));
                      }
                      setViewMode(v);
                    }}
                  >
                    {v === 'range' ? 'Date Range'
                      : v === 'week' ? 'Weekly'
                        : v === 'month' ? 'Monthly'
                          : v === 'shift' ? 'Shift'
                            : v === 'machine' ? 'Machine'
                              : 'Day'}
                  </button>
                ))}
              </div>

              {(viewMode === 'day' || viewMode === 'shift' || viewMode === 'machine') && (
                <input style={sel} type="date" value={filters.entry_date}
                  onChange={(e) => setFilters((p) => ({ ...p, entry_date: e.target.value }))} />
              )}
              {(viewMode === 'week' || viewMode === 'range') && (
                <>
                  <input style={sel} type="date" value={filters.date_from}
                    onChange={(e) => setFilters((p) => ({ ...p, date_from: e.target.value }))} />
                  <span style={{ color: t.textDim, fontSize: 13 }}>to</span>
                  <input style={sel} type="date" value={filters.date_to}
                    onChange={(e) => setFilters((p) => ({ ...p, date_to: e.target.value }))} />
                </>
              )}
              {viewMode === 'month' && (
                <select style={sel} value={filters.month}
                  onChange={(e) => setFilters((p) => ({ ...p, month: e.target.value }))}>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              )}
              <select style={sel} value={filters.year}
                onChange={(e) => setFilters((p) => ({ ...p, year: e.target.value }))}>
                {[2024, 2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <select style={sel} value={filters.shift}
                onChange={(e) => setFilters((p) => ({ ...p, shift: e.target.value }))}>
                <option value="">All Shifts</option>
                {(config?.shifts || []).filter((sh) => sh.enabled).map((sh) => (
                  <option key={String(sh.id)} value={sh.id}>{sh.name}</option>
                ))}
              </select>
            </>
          )}

          {(kpiTab === 'hit' || kpiTab === 'params' || mode === 'historic') && (
            <select style={sel} value={filters.zone_id}
              onChange={(e) => setFilters((p) => ({ ...p, zone_id: e.target.value, machine_id: '' }))}>
              <option value="">All Zones</option>
              {zoneOptions.map((z, i) => (
                <option key={`zone-${String(z.id)}-${i}`} value={z.id}>{stripCjk(z.name)}</option>
              ))}
            </select>
          )}

          {(kpiTab === 'params' || (mode === 'historic' && viewMode === 'machine')) && (
            <select style={sel} value={filters.machine_id}
              onChange={(e) => setFilters((p) => ({ ...p, machine_id: e.target.value }))}>
              <option value="">Select machine…</option>
              {machineOptions.map((eq) => (
                <option key={`eq-${eq.id}`} value={eq.id}>{stripCjk(eq.name)}</option>
              ))}
            </select>
          )}

          <button type="button" style={chip(true)} onClick={load}>Apply</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {KPI_TABS.map((tab) => (
          <button key={tab.id} type="button" style={chip(kpiTab === tab.id)} onClick={() => setKpiTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {err && <div style={{ color: '#fecaca', marginBottom: 10 }}>{err}</div>}

      {kpiTab === 'transfer' && (
        <section className={surfaceClass(t)} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, color: t.titleColor || t.text, fontSize: 15, fontWeight: 800 }}>
              Zone Transfer Rate {mode === 'live' ? '(Live)' : '(Historic)'}
            </h3>
            {isLiveTransfer && transfer?.shift_name && (
              <span style={{ fontSize: 11, fontWeight: 700, color: t.textDim }}>
                {transfer.shift_name} · {transfer.shift_start}–{transfer.shift_end}
                {transfer.date ? ` · ${transfer.date}` : ''}
              </span>
            )}
          </div>

          {isLiveTransfer && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexWrap: 'wrap', gap: '6px 16px', marginBottom: 8,
            }}>
              {transferSeries.map((s) => (
                <span key={s.reactKey} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: s.color }}>
                  <span style={{
                    display: 'inline-block', width: 18, height: 3, borderRadius: 2, background: s.color,
                    boxShadow: s.color === '#FFFFFF' || s.color === '#64748B'
                      ? `0 0 0 1px ${t.textDim || '#64748b'}` : undefined,
                  }} />
                  {s.legendLabel}
                </span>
              ))}
            </div>
          )}

          <div style={{ width: '100%', height: 360, minWidth: 0, minHeight: 360 }}>
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={160}>
              <LineChart
                data={transferChart}
                margin={{
                  top: 8,
                  right: 16,
                  left: 4,
                  bottom: isLiveTransfer ? 28 : 8,
                }}
              >
                <CartesianGrid stroke={t.border} strokeDasharray="3 3" opacity={0.35} />
                <XAxis
                  dataKey={isLiveTransfer ? 'slot' : 'date'}
                  interval={0}
                  stroke={t.textDim}
                  tick={{
                    fill: t.textMuted,
                    fontSize: isLiveTransfer ? 9 : 11,
                    fontWeight: 600,
                    angle: isLiveTransfer && transferChart.length > 5 ? -40 : 0,
                    textAnchor: isLiveTransfer && transferChart.length > 5 ? 'end' : 'middle',
                  }}
                  tickMargin={6}
                  height={isLiveTransfer && transferChart.length > 5 ? 44 : 32}
                />
                <YAxis
                  domain={[0, 100]}
                  stroke={t.textDim}
                  tick={{ fill: t.textMuted, fontSize: 11 }}
                  tickFormatter={(v) => `${v}%`}
                  label={isLiveTransfer ? {
                    value: 'Transfer Rate %',
                    angle: -90,
                    position: 'insideLeft',
                    fill: t.textMuted,
                    fontSize: 11,
                    fontWeight: 700,
                  } : undefined}
                />
                <Tooltip
                  contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }}
                  formatter={(value) => (typeof value === 'number' ? `${value}%` : value)}
                  labelFormatter={(label, payload) => (
                    isLiveTransfer && payload?.[0]?.payload?.slotFull
                      ? payload[0].payload.slotFull
                      : label
                  )}
                />
                {!isLiveTransfer && <Legend />}
                {transferSeries.map((s, i) => (
                  <Line
                    key={s.reactKey}
                    type="monotone"
                    dataKey={s.id}
                    name={s.legendLabel}
                    stroke={s.color}
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: s.color, strokeWidth: 0 }}
                    connectNulls
                    isAnimationActive={false}
                    shape={createPulseLeadShape({
                      uid: `transfer-${s.reactKey}`,
                      dur: `${4 + (i % 3) * 0.4}s`,
                      begin: `${(i * 0.35) % 2}s`,
                    })}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {isLiveTransfer && (
            <div style={{ textAlign: 'center', fontSize: 12, fontWeight: 700, color: t.textDim, marginTop: 4 }}>
              Hour
            </div>
          )}
        </section>
      )}

      {kpiTab === 'hit' && (() => {
        const hitSeries = (hit?.series || []).map((s, i) => ({
          key: s.key,
          label: s.label || s.key,
          color: s.color || '#3b82f6',
          reactKey: `hit-s-${s.key}-${i}`,
        }));
        const eqData = (hit?.equipment || []).map((eq) => {
          const row = { name: stripCjk(eq.name), id: eq.id };
          for (const s of hitSeries) row[s.key] = eq[s.key] == null ? null : eq[s.key];
          return row;
        });
        const periodData = (hit?.periods || []).map((p, i) => {
          const row = {
            name: p.shift_label ? `${p.label} (${p.shift_label})` : p.label,
            id: p.key || `${p.shift_key}-${p.label}-${i}`,
          };
          for (const s of hitSeries) row[s.key] = p[s.key] == null ? null : p[s.key];
          return row;
        });
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
            <section className={surfaceClass(t)} style={card}>
              <h3 style={{ margin: '0 0 10px', color: t.titleColor || t.text, fontSize: 15, fontWeight: 800 }}>
                Equipment Hit Rate
                {hit?.zone?.name ? (
                  <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 600, color: t.textDim }}>
                    · {stripCjk(hit.zone.name)}
                  </span>
                ) : null}
              </h3>
              <AnimatedBarChart
                data={eqData}
                theme={t}
                series={hitSeries}
                yDomain={[0, 100]}
                yLabel="Hit Rate %"
                xLabel="Equipment"
                height={320}
                showLegend
              />
            </section>
            <section className={surfaceClass(t)} style={card}>
              <h3 style={{ margin: '0 0 10px', color: t.titleColor || t.text, fontSize: 15, fontWeight: 800 }}>
                Time Period Hit Rate
              </h3>
              <AnimatedBarChart
                data={periodData}
                theme={t}
                series={hitSeries}
                yDomain={[0, 100]}
                yLabel="Hit Rate %"
                xLabel="Time Period"
                height={320}
                showLegend
              />
            </section>
          </div>
        );
      })()}

      {kpiTab === 'params' && (
        <div>
          <div style={{
            marginBottom: 10, fontSize: 13, fontWeight: 700, color: t.textMuted,
            display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
          }}>
            <span>Equipment Parameter for:</span>
            <span style={{ color: t.titleColor || t.text, fontSize: 14 }}>
              {selectedMachineName ? stripCjk(selectedMachineName) : '— select a machine —'}
            </span>
            {params?.zone?.name && (
              <span style={{ color: t.textDim, fontWeight: 600 }}>
                ({stripCjk(params.zone.name)})
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[
              { tag: 'injection_end', title: 'Injection Minimum Position' },
              { tag: 'max_pressure', title: 'Injection Maximum Pressure' },
              { tag: 'temp', title: 'Temperature', tabs: true },
              { tag: 'charge_time', title: 'Charge Time' },
            ].map((def) => {
              const activeTag = def.tabs ? tempTab : def.tag;
              const chart = params?.charts?.[activeTag];
              const dataPts = (chart?.points || []).map((p) => ({
                t: (p.t || '').replace('T', ' ').slice(5, 16),
                v: p.v,
              }));
              return (
                <section key={def.tag} className={surfaceClass(t)} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h3 style={{ margin: 0, color: t.titleColor || t.text, fontSize: 14, fontWeight: 800 }}>{def.title}</h3>
                    {def.tabs && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" style={chip(tempTab === 'nozzle_temp')} onClick={() => setTempTab('nozzle_temp')}>Nozzle</button>
                        <button type="button" style={chip(tempTab === 'barrel_temp')} onClick={() => setTempTab('barrel_temp')}>Barrel</button>
                      </div>
                    )}
                  </div>
                  <div style={{ width: '100%', height: 220, minWidth: 0, minHeight: 220 }}>
                    {dataPts.length === 0 ? (
                      <div style={{
                        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: t.textFaint, fontSize: 13,
                      }}>
                        No KPIV samples for this machine
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={160}>
                        <LineChart data={dataPts} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke={t.border} strokeDasharray="3 3" opacity={0.35} />
                          <XAxis dataKey="t" stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 10 }} minTickGap={24} />
                          <YAxis stroke={t.textDim} tick={{ fill: t.textMuted, fontSize: 11 }} />
                          <Tooltip contentStyle={{ background: t.surface, border: `1px solid ${t.border}`, color: t.text }} />
                          {(chart?.downtime || []).map((band, i) => (
                            <ReferenceArea
                              key={`${def.tag}-dt-${i}-${band.from}`}
                              x1={(band.from || '').replace('T', ' ').slice(5, 16)}
                              x2={(band.to || '').replace('T', ' ').slice(5, 16)}
                              fill="#6b7280"
                              fillOpacity={0.35}
                            />
                          ))}
                          {chart?.standard != null && <ReferenceLine y={chart.standard} stroke="#22c55e" strokeDasharray="4 4" />}
                          {chart?.upper != null && <ReferenceLine y={chart.upper} stroke="#ef4444" />}
                          {chart?.lower != null && <ReferenceLine y={chart.lower} stroke="#ef4444" />}
                          <Line
                            type="monotone"
                            dataKey="v"
                            name={stripCjk(chart?.label || def.title)}
                            stroke="#38bdf8"
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                            shape={createPulseLeadShape({
                              uid: `param-${def.tag}`,
                              dur: '3.2s',
                            })}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
