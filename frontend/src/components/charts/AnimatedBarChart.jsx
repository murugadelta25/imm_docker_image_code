import { useId, useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AnimatedBarDefs,
  colorToBarSeries,
  createRisingBarShape,
} from './animatedBarUtils.jsx';

const DEFAULT_DURATIONS = ['2.8s', '3.2s', '3s', '3.1s'];

/**
 * OEE-style animated gradient bar chart with rising light sweep.
 *
 * @param {object} props
 * @param {Array} props.data
 * @param {object} props.theme
 * @param {string} [props.xKey='name']
 * @param {Array<{key,label?,color?,dur?}>} props.series
 * @param {[number,number]} [props.yDomain]
 * @param {number|string} [props.height=220]
 * @param {boolean} [props.showGrid=true]
 * @param {boolean} [props.showLegend=false]
 * @param {boolean} [props.hideAxes=false]
 * @param {boolean} [props.hideYAxis=false]
 * @param {string} [props.yLabel]
 * @param {string} [props.labelKey] — LabelList dataKey on top of bars
 * @param {(v:number)=>string} [props.labelFormatter]
 * @param {(payload)=>void} [props.onBarClick]
 * @param {number} [props.maxBarSize=36]
 * @param {string} [props.barCategoryGap='18%']
 */
export default function AnimatedBarChart({
  data = [],
  theme: t,
  xKey = 'name',
  series = [],
  yDomain,
  height = 220,
  showGrid = true,
  showLegend = false,
  hideAxes = false,
  hideYAxis = false,
  yLabel,
  xLabel,
  labelKey,
  labelFormatter,
  xLabelSize = 13,
  onBarClick,
  maxBarSize = 36,
  barCategoryGap = '18%',
}) {
  const uid = useId().replace(/:/g, '');

  const resolvedSeries = useMemo(
    () => series.map((s, i) => colorToBarSeries(
      s.key,
      s.label || s.key,
      s.color || t.accent,
      s.dur || DEFAULT_DURATIONS[i % DEFAULT_DURATIONS.length],
    )),
    [series, t.accent],
  );

  const shapes = useMemo(
    () => Object.fromEntries(
      resolvedSeries.map((s) => [s.key, createRisingBarShape(uid, s)]),
    ),
    [uid, resolvedSeries],
  );

  const tooltipStyle = {
    background: t.surface || t.bg,
    border: `1px solid ${t.border}`,
    color: t.text,
    borderRadius: 8,
  };

  const handleBarClick = onBarClick
    ? (barData) => {
      if (barData?.payload) onBarClick(barData.payload);
    }
    : undefined;

  const hideX = hideAxes;
  const hideY = hideAxes || hideYAxis;

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <ResponsiveContainer width="100%" height={height} minWidth={0} minHeight={120}>
        <BarChart
          data={data}
          margin={{
            top: labelKey ? 22 : (showLegend ? 8 : 8),
            right: 8,
            left: hideY ? 0 : (yLabel ? 18 : 4),
            bottom: hideX ? 0 : (xLabel ? 8 : 20),
          }}
          barCategoryGap={barCategoryGap}
          barGap={4}
        >
        <AnimatedBarDefs prefix={uid} seriesList={resolvedSeries} />
        {showGrid && !hideX && !hideY && (
          <CartesianGrid strokeDasharray="3 3" stroke={t.border} vertical={false} opacity={0.35} />
        )}
        <XAxis
          dataKey={xKey}
          hide={hideX}
          tick={{ fill: t.textDim || t.textMuted, fontSize: hideX ? 0 : 10, fontWeight: 600 }}
          stroke={hideX ? 'transparent' : t.textDim}
          interval={0}
        />
        <YAxis
          domain={yDomain}
          hide={hideY}
          tick={{ fill: t.textDim || t.textMuted, fontSize: hideY ? 0 : 11 }}
          stroke={hideY ? 'transparent' : t.textDim}
          label={yLabel && !hideY ? {
            value: yLabel,
            angle: -90,
            position: 'insideLeft',
            fill: t.textMuted,
            fontSize: 11,
          } : undefined}
        />
        {!hideX && (
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.06)' }}
            contentStyle={tooltipStyle}
            formatter={(value, name) => [
              typeof value === 'number' ? `${value}%` : value,
              name,
            ]}
            labelFormatter={(label) => `${xLabel || 'Item'}: ${label}`}
          />
        )}
        {showLegend && (
          <Legend
            formatter={(value) => {
              const item = resolvedSeries.find((s) => s.key === value || s.label === value);
              const legendColor = item?.stops?.[1]?.color ?? t.text;
              return <span style={{ color: legendColor }}>{value}</span>;
            }}
          />
        )}
        {resolvedSeries.map((s, i) => (
          <Bar
            key={`bar-${String(s.key)}-${i}`}
            dataKey={s.key}
            name={s.label}
            fill={`url(#${uid}-fill-${s.key})`}
            shape={shapes[s.key]}
            maxBarSize={maxBarSize}
            legendType="square"
            cursor={onBarClick ? 'pointer' : 'default'}
            onClick={handleBarClick}
          >
            {labelKey && (
              <LabelList
                dataKey={labelKey}
                position="top"
                fill={t.text}
                fontSize={hideAxes ? 9 : 11}
                formatter={labelFormatter}
              />
            )}
          </Bar>
        ))}
        </BarChart>
      </ResponsiveContainer>
      {xLabel && !hideX && (
        <div style={{
          textAlign: 'center',
          fontSize: xLabelSize,
          fontWeight: 700,
          color: t.textDim || t.textMuted,
          marginTop: 0,
          letterSpacing: 0.3,
        }}>
          {xLabel}
        </div>
      )}
    </div>
  );
}
