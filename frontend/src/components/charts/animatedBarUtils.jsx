import { shadeHex } from './chart3dUtils';

/** Build gradient + light-band config from a base hex color (OEE-style bars). */
export function colorToBarSeries(key, label, color, dur = '3s') {
  const base = color || '#38bdf8';
  return {
    key,
    label: label || key,
    stops: [
      { offset: '0%', color: shadeHex(base, 0.35) },
      { offset: '42%', color: base },
      { offset: '100%', color: shadeHex(base, -0.35) },
    ],
    light: [shadeHex(base, 0.5), '#ffffff', shadeHex(base, 0.2)],
    dur,
  };
}

export function AnimatedBarDefs({ prefix, seriesList }) {
  return (
    <defs>
      {seriesList.map((s) => (
        <linearGradient key={`fill-${s.key}`} id={`${prefix}-fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
          {s.stops.map((stop) => (
            <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </linearGradient>
      ))}
      {seriesList.map((s) => (
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

/** Custom bar with a bright band that travels bottom → top (OEE Production vs Possible style). */
export function createRisingBarShape(prefix, series) {
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
    const rx = bw > 20 ? 4 : 3;

    return (
      <g>
        <defs>
          <clipPath id={clipId}>
            <rect x={bx} y={by} width={bw} height={bh} rx={rx} ry={rx} />
          </clipPath>
        </defs>

        <rect x={bx} y={by} width={bw} height={bh} fill={fillUrl} rx={rx} ry={rx} />

        <g clipPath={`url(#${clipId})`}>
          <rect x={bx} y={trailFrom} width={bw} height={trailH} fill={lightUrl} opacity={0.28}>
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
