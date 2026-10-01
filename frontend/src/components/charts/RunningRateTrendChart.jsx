import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { hourlyRunningRateColor, hourlyRunningRateLineStyle } from '../../utils/heatMap';

const LEGEND_H = 28;
const X_LABEL_H = 22;

function formatHourTick(slot) {
  return String(slot || '').split('-')[0]?.trim() || slot;
}

export default function RunningRateTrendChart({
  data,
  theme,
  onLineClick,
  height = '100%',
  xLabel = 'Hour',
  yLabel = 'Running Rate %',
}) {
  const isDark = theme?.isDark !== false && theme?.id !== 'light';
  const textColor = theme?.text || (isDark ? '#e2e8f0' : '#1e293b');
  const dimColor = theme?.textDim || theme?.textMuted || (isDark ? '#94a3b8' : '#64748b');
  const gridColor = isDark ? '#475569' : '#cbd5e1';
  const axisColor = isDark ? '#64748b' : '#94a3b8';
  const bgColor = isDark ? (theme?.surface || '#0f172a') : '#ffffff';

  const plotRef = useRef(null);
  const [plotSize, setPlotSize] = useState({ w: 400, h: 200 });

  useEffect(() => {
    const el = plotRef.current;
    if (!el || height !== '100%') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height: h } = entry.contentRect;
      setPlotSize({
        w: Math.max(200, Math.floor(width)),
        h: Math.max(120, Math.floor(h)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  const slots = data?.slots || [];
  const lines = data?.lines || [];
  const slotCount = slots.length;
  const rotateTicks = slotCount > 5;
  const xAxisHeight = rotateTicks ? 44 : 32;

  const coloredLines = useMemo(
    () => lines.map((ln, i) => ({
      ...ln,
      colorIndex: i,
      color: hourlyRunningRateColor(i, isDark),
    })),
    [lines, isDark],
  );

  const drawOrderLines = useMemo(
    () => [...coloredLines].sort((a, b) => b.colorIndex - a.colorIndex),
    [coloredLines],
  );

  const chartData = useMemo(() => slots.map((slot, i) => {
    const point = { slot: formatHourTick(slot), slotFull: slot };
    coloredLines.forEach((ln) => {
      point[ln.name] = ln.hourly_pct?.[i] ?? null;
    });
    return point;
  }), [slots, coloredLines]);

  const plotHeight = height === '100%'
    ? plotSize.h
    : (typeof height === 'number' ? height : 240);

  if (!slots.length || !coloredLines.length) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: dimColor, fontSize: 13 }}>
        {slots.length === 0 ? 'Shift not started yet' : 'No zones configured'}
      </div>
    );
  }

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const full = payload[0]?.payload?.slotFull || label;
    return (
      <div style={{
        background: bgColor,
        border: `1px solid ${gridColor}`,
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 12,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      }}>
        <div style={{ fontWeight: 700, color: textColor, marginBottom: 4 }}>{full}</div>
        {payload.map((p) => (
          <div key={p.dataKey} style={{ color: p.color, fontWeight: 600 }}>
            {p.dataKey}: {p.value != null ? `${p.value}%` : '—'}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      style={{
        width: '100%',
        height: height === '100%' ? '100%' : undefined,
        flex: height === '100%' ? 1 : undefined,
        minHeight: height === '100%' ? 0 : plotHeight + LEGEND_H + X_LABEL_H,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Zone legend — top center */}
      <div style={{
        flex: `0 0 ${LEGEND_H}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: '6px 16px',
        width: '100%',
      }}>
        {coloredLines.map((ln) => (
          <button
            key={ln.id || ln.name}
            type="button"
            onClick={() => onLineClick?.(ln)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              border: 'none',
              padding: '2px 4px',
              cursor: onLineClick ? 'pointer' : 'default',
              fontSize: 11,
              fontWeight: 700,
              color: ln.color,
            }}
            title={`Zone ${ln.name}`}
          >
            <span style={{
              display: 'inline-block',
              width: 18,
              height: 3,
              borderRadius: 2,
              background: ln.color,
              boxShadow: ln.color === '#FFFFFF' || ln.color === '#64748B'
                ? `0 0 0 1px ${isDark ? '#64748b' : '#334155'}`
                : undefined,
            }} />
            Zone {ln.name} 
          </button>
        ))}
      </div>

      <div
        ref={plotRef}
        style={{
          flex: '1 1 auto',
          minHeight: 120,
          minWidth: 0,
          width: '100%',
        }}
      >
        {plotSize.w > 0 && plotHeight > 0 && (
          <ResponsiveContainer width="100%" height={plotHeight} minWidth={0}>
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 8, bottom: rotateTicks ? 4 : 2, left: 2 }}
            >
              <CartesianGrid strokeDasharray="3 4" stroke={gridColor} strokeOpacity={0.7} />
              <XAxis
                dataKey="slot"
                interval={0}
                tick={{
                  fill: dimColor,
                  fontSize: 9,
                  fontWeight: 600,
                  angle: rotateTicks ? -40 : 0,
                  textAnchor: rotateTicks ? 'end' : 'middle',
                }}
                tickMargin={4}
                height={xAxisHeight}
                axisLine={{ stroke: axisColor, strokeWidth: 1.5 }}
                tickLine={{ stroke: axisColor, strokeWidth: 1 }}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: dimColor, fontSize: 10, fontWeight: 600 }}
                axisLine={{ stroke: axisColor, strokeWidth: 1.5 }}
                tickLine={{ stroke: axisColor, strokeWidth: 1 }}
                width={38}
                tickMargin={4}
                label={{
                  value: yLabel,
                  angle: -90,
                  position: 'insideLeft',
                  offset: 10,
                  fill: dimColor,
                  fontSize: 10,
                  fontWeight: 700,
                }}
              />
              <Tooltip content={<CustomTooltip />} />
              <ReferenceLine y={100} stroke={gridColor} strokeDasharray="4 4" strokeOpacity={0.4} />
              {drawOrderLines.map((ln, idx) => {
                const lineStyle = hourlyRunningRateLineStyle(ln.color, isDark, bgColor);
                return (
                  <Line
                    key={ln.id || ln.name || idx}
                    type="monotone"
                    dataKey={ln.name}
                    name={ln.name}
                    stroke={lineStyle.stroke}
                    strokeWidth={lineStyle.strokeWidth}
                    dot={{ ...lineStyle.dot, r: slotCount > 8 ? 3 : lineStyle.dot.r }}
                    activeDot={lineStyle.activeDot}
                    connectNulls={false}
                    onClick={() => onLineClick?.(ln)}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* X-axis title */}
      <div style={{
        flex: `0 0 ${X_LABEL_H}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        color: dimColor,
      }}>
        {xLabel}
      </div>
    </div>
  );
}
