import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, Legend,
} from 'recharts';
import TitanModal from './basic/TitanModal';

const USL_LSL_ORANGE = '#ffb300';
const NOM_LIGHT_GREEN = '#a5d6a7';
const DOT_IN_SPEC = '#66bb6a';
const DOT_DEVIATED = '#c62828';

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  return (
    <div style={{
      background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '8px 12px', fontSize: 12,
    }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {p?.value != null && <div>Value: <strong>{p.value}</strong></div>}
      {p?.raw_value && <div>Reading: {p.raw_value}</div>}
      {p?.in_spec != null && (
        <div style={{ color: p.in_spec ? DOT_IN_SPEC : DOT_DEVIATED, fontWeight: 700 }}>
          {p.in_spec ? `✓ In spec — ${p.value}` : `✗ Deviated — out of tolerance (${p.value})`}
        </div>
      )}
    </div>
  );
}

function SpcDot({ cx, cy, payload }) {
  if (cx == null || cy == null || payload?.value == null) return null;
  const deviated = payload.in_spec === false;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={7}
      fill={deviated ? DOT_DEVIATED : DOT_IN_SPEC}
      stroke="#fff"
      strokeWidth={2}
    />
  );
}

function limitLabel(value, text, color = USL_LSL_ORANGE) {
  return {
    value: `${text} ${value}`,
    position: 'insideTopRight',
    fill: color,
    fontSize: 11,
    fontWeight: 700,
  };
}

function chartAxisColors(t) {
  const isDark = t?.isDark ?? true;
  if (isDark) {
    return {
      hourLabel: '#ffffff',
      timeLabel: '#ffd54f',
      yTick: '#ffffff',
      axisLine: 'rgba(212, 238, 248, 0.7)',
      grid: 'rgba(212, 238, 248, 0.22)',
      legend: '#ffffff',
    };
  }
  return {
    hourLabel: '#1a237e',
    timeLabel: '#e65100',
    yTick: '#212121',
    axisLine: '#78909c',
    grid: '#e0e0e0',
    legend: '#212121',
  };
}

/** Split "H1 (08:00–09:30)" into hour + time for readable two-line ticks. */
function SpcXAxisTick({ x, y, payload, hourFill, timeFill }) {
  const raw = String(payload?.value || '');
  const match = raw.match(/^((?:H\d+|1st)(?:\s+piece)?)\s*(\([^)]+\))?$/i);
  const hour = match?.[1] || raw;
  const time = match?.[2] || '';

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={14}
        textAnchor="middle"
        fill={hourFill}
        fontSize={11}
        fontWeight={700}
      >
        {hour}
      </text>
      {time ? (
        <text
          x={0}
          y={0}
          dy={28}
          textAnchor="middle"
          fill={timeFill}
          fontSize={9}
          fontWeight={600}
        >
          {time}
        </text>
      ) : null}
    </g>
  );
}

function SpcYAxisTick({ x, y, payload, fill }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={4}
        textAnchor="end"
        fill={fill}
        fontSize={11}
        fontWeight={700}
      >
        {formatTick(payload?.value)}
      </text>
    </g>
  );
}

function formatTick(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  if (Math.abs(n) >= 100) return n.toFixed(1);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

/** Y domain that always fits USL, LSL, nominal, and all plotted points. */
export function computeSpcYDomain(limits, chartRows, paddingRatio = 0.15) {
  const values = (chartRows || []).map((r) => r.value).filter((v) => v != null && !Number.isNaN(v));
  const candidates = [
    ...values,
    limits?.usl,
    limits?.lsl,
    limits?.nominal,
  ].filter((v) => v != null && !Number.isNaN(v));

  if (candidates.length === 0) return [0, 1];

  let min = Math.min(...candidates);
  let max = Math.max(...candidates);

  const specSpan = limits ? Math.abs(limits.usl - limits.lsl) : 0;
  const dataSpan = max - min;
  const minVisibleSpan = specSpan > 0
    ? Math.max(specSpan * 1.35, dataSpan * 0.5, 0.001)
    : Math.max(dataSpan * 0.25, 0.001);

  if (max - min < minVisibleSpan) {
    const mid = (max + min) / 2;
    min = mid - minVisibleSpan / 2;
    max = mid + minVisibleSpan / 2;
  }

  const pad = (max - min) * paddingRatio;
  return [min - pad, max + pad];
}

function zoomDomain([lo, hi], factor) {
  const mid = (lo + hi) / 2;
  const half = ((hi - lo) / 2) / factor;
  return [mid - half, mid + half];
}

function ReadingsTable({ points, theme: t }) {
  const filled = (points || []).filter((p) => String(p.raw_value || '').trim());
  if (filled.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13, color: t?.textDim || '#666' }}>
        No hourly readings recorded for this parameter in this shift.
      </p>
    );
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: `2px solid ${t?.border || '#ccc'}` }}>
          <th style={{ textAlign: 'left', padding: '8px 10px' }}>Hour</th>
          <th style={{ textAlign: 'left', padding: '8px 10px' }}>Reading</th>
          <th style={{ textAlign: 'left', padding: '8px 10px' }}>Result</th>
        </tr>
      </thead>
      <tbody>
        {filled.map((p) => {
          const isPass = p.pass_fail === 'pass' || p.in_spec === true;
          const isFail = p.pass_fail === 'fail' || p.in_spec === false;
          const resultColor = isFail ? DOT_DEVIATED : isPass ? DOT_IN_SPEC : (t?.textDim || '#666');
          const resultLabel = isFail ? 'Fail / NOK' : isPass ? 'Pass / OK' : '—';
          return (
            <tr key={p.instance_key} style={{ borderBottom: `1px solid ${t?.border || '#eee'}` }}>
              <td style={{ padding: '8px 10px' }}>{p.label}</td>
              <td style={{ padding: '8px 10px', fontWeight: 600 }}>{p.raw_value || '—'}</td>
              <td style={{ padding: '8px 10px', color: resultColor, fontWeight: 700 }}>{resultLabel}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}


export default function QcSpcChart({ reportMeta, spcData, onClose, theme: t }) {
  const allParameters = spcData?.parameters || [];
  const chartable = useMemo(
    () => allParameters.filter((p) => p.chartable),
    [allParameters],
  );
  const [paramIdx, setParamIdx] = useState(0);
  const [zoomFactor, setZoomFactor] = useState(1);

  const selected = allParameters[paramIdx] || allParameters[0];
  const limits = selected?.limits;
  const isChartView = Boolean(selected?.chartable);

  const chartRows = useMemo(() => (
    (selected?.points || [])
      .filter((p) => p.value != null)
      .map((p) => ({
        name: p.label,
        value: p.value,
        raw_value: p.raw_value,
        in_spec: p.in_spec,
        status: p.status,
      }))
  ), [selected]);

  const baseDomain = useMemo(
    () => computeSpcYDomain(limits, chartRows),
    [limits, chartRows],
  );

  const yDomain = useMemo(
    () => zoomDomain(baseDomain, zoomFactor),
    [baseDomain, zoomFactor],
  );

  const [chartReady, setChartReady] = useState(false);

  useEffect(() => {
    if (!isChartView) {
      setChartReady(false);
      return undefined;
    }
    const frame = requestAnimationFrame(() => setChartReady(true));
    return () => {
      cancelAnimationFrame(frame);
      setChartReady(false);
    };
  }, [isChartView, paramIdx]);

  useEffect(() => {
    setZoomFactor(1);
  }, [paramIdx, selected?.parameter]);

  const zoomIn = useCallback(() => {
    setZoomFactor((z) => Math.min(z * 1.35, 12));
  }, []);

  const zoomOut = useCallback(() => {
    setZoomFactor((z) => Math.max(z / 1.35, 0.35));
  }, []);

  const fitLimits = useCallback(() => {
    setZoomFactor(1);
  }, []);

  const deviatedCount = chartRows.filter((p) => p.in_spec === false).length;
  const axisColors = chartAxisColors(t);

  const subtitle = [
    reportMeta?.article_no,
    reportMeta?.shift ? `Shift ${reportMeta.shift}` : null,
    reportMeta?.inspection_date,
    reportMeta?.machine_name,
  ].filter(Boolean).join(' · ');

  const btnSecondary = {
    padding: '5px 12px',
    borderRadius: 6,
    border: `1px solid ${t?.border || '#ccc'}`,
    background: t?.surface || '#fff',
    color: t?.text || '#333',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };

  return (
    <TitanModal
      title="SPC — Statistical Process Control"
      subtitle={subtitle || 'Hourly quality readings for this shift'}
      wide
      onClose={onClose}
    >
      {allParameters.length === 0 && (
        <p style={{ margin: 0, color: t?.textDim || '#666', fontSize: 13 }}>
          No QC parameters found for this shift report.
        </p>
      )}

      {allParameters.length > 0 && (
        <>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: t?.textDim || '#666' }}>
            {allParameters.length} parameter(s) on this part — select a tab below.
            {' '}
            <strong>{chartable.length}</strong> with numeric SPC chart;
            {' '}
            <strong>{allParameters.length - chartable.length}</strong> shown as hourly OK/NOK readings.
          </p>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {allParameters.map((p, i) => (
              <button
                key={p.parameter}
                type="button"
                onClick={() => setParamIdx(i)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  border: `1px solid ${i === paramIdx ? (t?.accent || '#1565c0') : (t?.border || '#ccc')}`,
                  background: i === paramIdx ? (t?.surface2 || '#e3f2fd') : (t?.surface || '#fff'),
                  color: t?.text || '#333',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: i === paramIdx ? 700 : 500,
                }}
                title={p.chartable ? 'SPC trend chart' : (p.chart_note || 'Readings table')}
              >
                {p.parameter}
                {!p.chartable && (
                  <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.75 }}>(OK/NOK)</span>
                )}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, marginBottom: 8 }}>
            <span style={{ color: t?.textDim || '#666' }}>
              Spec: <strong>{selected?.std_value}</strong>
            </span>
            {isChartView && limits && (
              <>
                <span style={{ color: NOM_LIGHT_GREEN, fontWeight: 700 }}>● Nominal {limits.nominal}</span>
                <span style={{ color: USL_LSL_ORANGE, fontWeight: 700 }}>— USL {limits.usl}</span>
                <span style={{ color: USL_LSL_ORANGE, fontWeight: 700 }}>— LSL {limits.lsl}</span>
              </>
            )}
            {isChartView && (
              <>
                <span style={{ color: DOT_IN_SPEC, fontWeight: 600 }}>● In spec</span>
                <span style={{ color: DOT_DEVIATED, fontWeight: 600 }}>● Deviated</span>
                {deviatedCount > 0 && (
                  <span style={{ color: DOT_DEVIATED, fontWeight: 700 }}>
                    {deviatedCount} deviated point{deviatedCount > 1 ? 's' : ''}
                  </span>
                )}
              </>
            )}
          </div>

          {selected?.warnings?.length > 0 && (
            <div style={{
              marginBottom: 10,
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #ed6c02',
              background: '#fff3e0',
              fontSize: 12,
              color: '#e65100',
            }}
            >
              <strong>⚠ SPC alert</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {selected.warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {!isChartView && selected?.chart_note && (
            <p style={{
              margin: '0 0 12px', padding: '10px 12px', borderRadius: 6,
              background: t?.surface2 || '#f5f5f5', fontSize: 12, color: t?.textDim || '#666',
            }}
            >
              {selected.chart_note}
            </p>
          )}

          {isChartView && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              marginBottom: 8,
            }}
            >
              <span style={{ fontSize: 12, color: t?.textDim || '#666', fontWeight: 600 }}>Y-axis:</span>
              <button type="button" style={btnSecondary} onClick={zoomOut} title="Zoom out">− Zoom out</button>
              <button type="button" style={btnSecondary} onClick={zoomIn} title="Zoom in">+ Zoom in</button>
              <button
                type="button"
                style={{ ...btnSecondary, borderColor: t?.accent || '#1565c0', color: t?.accent || '#1565c0' }}
                onClick={fitLimits}
                title="Reset scale to show USL, LSL, nominal and all points"
              >
                Fit limits
              </button>
              <span style={{ fontSize: 11, color: t?.textDim || '#888' }}>
                Range {formatTick(yDomain[0])} – {formatTick(yDomain[1])}
                {zoomFactor !== 1 && ` (${Math.round(zoomFactor * 100)}% zoom)`}
              </span>
            </div>
          )}

          {isChartView ? (
            <div style={{ width: '100%', height: 440, minWidth: 0 }}>
              {chartReady ? (
                <ResponsiveContainer width="100%" height={440} minWidth={0}>
                  <LineChart
                    data={chartRows}
                    margin={{ top: 32, right: 20, left: 8, bottom: 56 }}
                  >
                  <CartesianGrid strokeDasharray="3 3" stroke={axisColors.grid} />
                  <XAxis
                    dataKey="name"
                    interval={0}
                    axisLine={{ stroke: axisColors.axisLine, strokeWidth: 1.5 }}
                    tickLine={{ stroke: axisColors.axisLine }}
                    height={56}
                    tick={(props) => (
                      <SpcXAxisTick
                        {...props}
                        hourFill={axisColors.hourLabel}
                        timeFill={axisColors.timeLabel}
                      />
                    )}
                  />
                  <YAxis
                    domain={yDomain}
                    allowDataOverflow={false}
                    width={62}
                    axisLine={{ stroke: axisColors.axisLine, strokeWidth: 1.5 }}
                    tickLine={{ stroke: axisColors.axisLine }}
                    tick={(props) => (
                      <SpcYAxisTick {...props} fill={axisColors.yTick} />
                    )}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    wrapperStyle={{ top: -4, color: axisColors.legend }}
                    formatter={(value) => (
                      <span style={{ color: axisColors.legend, fontWeight: 700, fontSize: 12 }}>
                        {value}
                      </span>
                    )}
                  />
                  {limits && (
                    <>
                      <ReferenceLine
                        y={limits.usl}
                        stroke={USL_LSL_ORANGE}
                        strokeWidth={3}
                        ifOverflow="visible"
                        label={limitLabel(limits.usl, 'USL')}
                      />
                      <ReferenceLine
                        y={limits.nominal}
                        stroke={NOM_LIGHT_GREEN}
                        strokeWidth={2.5}
                        strokeDasharray="8 4"
                        ifOverflow="visible"
                        label={{
                          value: `Nom ${limits.nominal}`,
                          position: 'insideTopLeft',
                          fill: NOM_LIGHT_GREEN,
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      />
                      <ReferenceLine
                        y={limits.lsl}
                        stroke={USL_LSL_ORANGE}
                        strokeWidth={3}
                        ifOverflow="visible"
                        label={limitLabel(limits.lsl, 'LSL')}
                      />
                    </>
                  )}
                  <Line
                    type="monotone"
                    dataKey="value"
                    name={selected?.parameter}
                    stroke={t?.accent || '#1565c0'}
                    strokeWidth={2}
                    dot={<SpcDot />}
                    activeDot={{ r: 9, strokeWidth: 2 }}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
              ) : (
                <div style={{
                  height: 440,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: t?.textDim || '#888',
                  fontSize: 13,
                }}
                >
                  Loading chart…
                </div>
              )}
            </div>
          ) : (
            <ReadingsTable points={selected?.points} theme={t} />
          )}

          <p style={{ margin: '12px 0 0', fontSize: 11, color: t?.textDim || '#888' }}>
            {isChartView
              ? 'Y-axis auto-fits USL, LSL, nominal and all points. Use Zoom in/out or Fit limits to adjust. Orange = USL/LSL; green dashed = nominal.'
              : 'Numeric parameters plot as SPC charts when operators enter measured values instead of OK/NOK.'}
          </p>
        </>
      )}
    </TitanModal>
  );
}
