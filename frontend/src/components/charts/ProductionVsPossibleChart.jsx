import { useId, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts';

const BAR_SERIES = [
  {
    key: 'Possible',
    label: 'Possible',
    stops: [
      { offset: '0%', color: '#7dd3fc' },
      { offset: '42%', color: '#38bdf8' },
      { offset: '100%', color: '#0369a1' },
    ],
    light: ['#e0f2fe', '#ffffff', '#bae6fd'],
    dur: '2.8s',
  },
  {
    key: 'Actual',
    label: 'Actual',
    stops: [
      { offset: '0%', color: '#fde68a' },
      { offset: '42%', color: '#f8bf05' },
      { offset: '100%', color: '#c2410c' },
    ],
    light: ['#fef9c3', '#ffffff', '#fde047'],
    dur: '3.2s',
  },
  {
    key: 'Accepted',
    label: 'Accepted',
    stops: [
      { offset: '0%', color: '#6ee7b7' },
      { offset: '42%', color: '#10b981' },
      { offset: '100%', color: '#047857' },
    ],
    light: ['#d1fae5', '#ffffff', '#6ee7b7'],
    dur: '3s',
  },
];

function ChartDefs({ prefix }) {
  return (
    <defs>
      {BAR_SERIES.map((s) => (
        <linearGradient key={`fill-${s.key}`} id={`${prefix}-fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
          {s.stops.map((stop) => (
            <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </linearGradient>
      ))}
      {BAR_SERIES.map((s) => (
        <linearGradient key={`light-${s.key}`} id={`${prefix}-light-${s.key}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={s.light[0]} stopOpacity="0" />
          <stop offset="44%" stopColor={s.light[1]} stopOpacity="0.85" />
          <stop offset="52%" stopColor={s.light[1]} stopOpacity="0.85" />
          <stop offset="60%" stopColor={s.light[2]} stopOpacity="0.25" />
          <stop offset="100%" stopColor={s.light[0]} stopOpacity="0" />
        </linearGradient>
      ))}
      <filter id={`${prefix}-bar-glow`} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="0.6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

/** Custom bar with a bright band that travels bottom → top (like donut outer shine). */
function createRisingBarShape(prefix, series) {
  const fillUrl = `url(#${prefix}-fill-${series.key})`;
  const lightUrl = `url(#${prefix}-light-${series.key})`;

  return function RisingBarShape(props) {
    const { x, y, width, height, index = 0 } = props;
    if (height == null || height <= 0 || width == null || x == null || y == null) return null;

    const bx = x;
    const by = y;
    const bw = width;
    const bh = height;
    const bandH = Math.max(7, bh * 0.16);
    const trailH = Math.max(5, bh * 0.1);
    const clipId = `${prefix}-clip-${series.key}-${index}`;
    const yFrom = by + bh + 2;
    const yTo = by - bandH - 2;
    const trailFrom = by + bh + trailH * 0.4;
    const trailTo = by - trailH;
    const coreH = Math.max(1.2, bandH * 0.22);
    const coreYFrom = yFrom + bandH * 0.42;
    const coreYTo = yTo + bandH * 0.42;
    const begin = `${(index * 0.4) % 2}s`;

    return (
      <g>
        <defs>
          <clipPath id={clipId}>
            <rect x={bx} y={by} width={bw} height={bh} rx={4} ry={4} />
          </clipPath>
        </defs>

        <rect x={bx} y={by} width={bw} height={bh} fill={fillUrl} rx={4} ry={4} />

        <g clipPath={`url(#${clipId})`}>
          <rect
            x={bx}
            y={trailFrom}
            width={bw}
            height={trailH}
            fill={lightUrl}
            opacity={0.28}
          >
            <animate
              attributeName="y"
              from={trailFrom}
              to={trailTo}
              dur={series.dur}
              begin={begin}
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;1"
              keySplines="0.42 0 0.58 1"
            />
          </rect>

          <rect
            x={bx}
            y={yFrom}
            width={bw}
            height={bandH}
            fill={lightUrl}
            filter={`url(#${prefix}-bar-glow)`}
            opacity={0.78}
          >
            <animate
              attributeName="y"
              from={yFrom}
              to={yTo}
              dur={series.dur}
              begin={begin}
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;1"
              keySplines="0.42 0 0.58 1"
            />
          </rect>

          <rect
            x={bx + bw * 0.28}
            y={coreYFrom}
            width={bw * 0.44}
            height={coreH}
            fill="#ffffff"
            opacity={0.72}
            rx={1}
          >
            <animate
              attributeName="y"
              from={coreYFrom}
              to={coreYTo}
              dur={series.dur}
              begin={begin}
              repeatCount="indefinite"
              calcMode="spline"
              keyTimes="0;1"
              keySplines="0.42 0 0.58 1"
            />
            <animate
              attributeName="opacity"
              values="0.55;0.95;0.55"
              dur="1.4s"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      </g>
    );
  };
}

/**
 * Production vs Possible — multigradient bars with visible rising light sweep.
 */
export default function ProductionVsPossibleChart({ data, theme }) {
  const uid = useId().replace(/:/g, '');
  const t = theme;

  const shapes = useMemo(
    () => Object.fromEntries(
      BAR_SERIES.map((s) => [s.key, createRisingBarShape(uid, s)]),
    ),
    [uid],
  );

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }} barCategoryGap="18%" barGap={4}>
        <ChartDefs prefix={uid} />
        <CartesianGrid strokeDasharray="3 3" stroke={t.border} vertical={false} />
        <XAxis dataKey="label" tick={{ fill: t.textDim, fontSize: 10 }} />
        <YAxis tick={{ fill: t.textDim, fontSize: 10 }} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.06)' }}
          contentStyle={{
            background: t.surface,
            border: `1px solid ${t.border}`,
            color: t.text,
            borderRadius: 6,
          }}
          formatter={(value) => value.toLocaleString()}
          labelFormatter={(label) => `${label}`}
        />
        <Legend
          formatter={(value) => {
            const series = BAR_SERIES.find((s) => s.key === value);
            const legendColor = series?.stops[1]?.color ?? t.text;
            return <span style={{ color: legendColor }}>{value}</span>;
          }}
        />
        {BAR_SERIES.map((s) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={`url(#${uid}-fill-${s.key})`}
            shape={shapes[s.key]}
            maxBarSize={36}
            legendType="square"
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
