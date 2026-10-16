import { useId, useMemo } from 'react';
import { polarToCartesian, shadeHex } from './chart3dUtils';

/** Fixed canvas — all four gauges share the same box for row alignment. */
export const DONUT_CANVAS = 150;

function describeArcStroke(cx, cy, r, startAngle, endAngle) {
  if (endAngle <= startAngle) return '';
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

function segmentArcs(cx, cy, r, count, spanDeg, startOffset = 0) {
  const gap = (360 - count * spanDeg) / count;
  return Array.from({ length: count }, (_, i) => {
    const a0 = startOffset + i * (spanDeg + gap);
    return describeArcStroke(cx, cy, r, a0, a0 + spanDeg);
  }).filter(Boolean);
}

/**
 * Animated HUD-style donut gauge — 150×150 upright circle with rotating orbit rings.
 */
export default function Donut3D({
  value = 0,
  color = '#0ea5e9',
  trackColor = '#1e293b',
}) {
  const gid = useId().replace(/:/g, '');
  const pct = Math.min(100, Math.max(0, value));
  const canvas = DONUT_CANVAS;
  const cx = canvas / 2;
  const cy = canvas / 2;
  const radius = canvas * 0.28;
  const strokeW = canvas * 0.052;
  const circumference = 2 * Math.PI * radius;
  const arcLen = (pct / 100) * circumference;
  const glow = shadeHex(color, 0.35);

  const orbitOuter = useMemo(() => segmentArcs(cx, cy, radius + strokeW * 1.35, 6, 22, 4), [cx, cy, radius, strokeW]);
  const orbitMid = useMemo(() => segmentArcs(cx, cy, radius + strokeW * 1.85, 8, 14, 18), [cx, cy, radius, strokeW]);
  const orbitInner = useMemo(() => segmentArcs(cx, cy, radius + strokeW * 0.45, 4, 38, 10), [cx, cy, radius, strokeW]);
  const outerRingR = radius + strokeW * 1.35;
  const shineArc = describeArcStroke(cx, cy, outerRingR, -6, 38);
  const shineCore = describeArcStroke(cx, cy, outerRingR, 8, 22);

  return (
    <svg
      width={canvas}
      height={canvas}
      viewBox={`0 0 ${canvas} ${canvas}`}
      overflow="visible"
      aria-hidden
      className="donut-gauge"
      style={{ overflow: 'visible', display: 'block' }}
    >
      <defs>
        <linearGradient id={`${gid}-prog`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={glow} />
          <stop offset="50%" stopColor={color} />
          <stop offset="100%" stopColor={shadeHex(color, -0.2)} />
        </linearGradient>
        <filter id={`${gid}-glow`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id={`${gid}-halo`} cx="50%" cy="50%" r="50%">
          <stop offset="55%" stopColor="transparent" />
          <stop offset="78%" stopColor={color} stopOpacity="0.08" />
          <stop offset="100%" stopColor={color} stopOpacity="0.2" />
        </radialGradient>
        <linearGradient id={`${gid}-shine-grad`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(255,255,255,0)" />
          <stop offset="35%" stopColor={glow} stopOpacity="0.5" />
          <stop offset="55%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="75%" stopColor={glow} stopOpacity="0.6" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
        <filter id={`${gid}-shine-filter`} x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.8" result="core" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="core" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <circle cx={cx} cy={cy} r={radius + strokeW * 2.1} fill={`url(#${gid}-halo)`} />

      <g filter={`url(#${gid}-glow)`} opacity="0.85">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${cx} ${cy}`}
          to={`360 ${cx} ${cy}`}
          dur="18s"
          repeatCount="indefinite"
        />
        {orbitOuter.map((d, i) => (
          <path
            key={`o-${i}`}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.55 + (i % 3) * 0.12}
          />
        ))}
      </g>

      {/* Shining light sweeping the outer orbit ring */}
      <g filter={`url(#${gid}-shine-filter)`}>
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${cx} ${cy}`}
          to={`360 ${cx} ${cy}`}
          dur="5.5s"
          repeatCount="indefinite"
        />
        {shineArc && (
          <path
            d={shineArc}
            fill="none"
            stroke={`url(#${gid}-shine-grad)`}
            strokeWidth={4}
            strokeLinecap="round"
            opacity={0.95}
          />
        )}
        {shineCore && (
          <path
            d={shineCore}
            fill="none"
            stroke="#ffffff"
            strokeWidth={1.8}
            strokeLinecap="round"
            opacity={0.9}
          />
        )}
        <circle
          cx={polarToCartesian(cx, cy, outerRingR, 16).x}
          cy={polarToCartesian(cx, cy, outerRingR, 16).y}
          r={2.2}
          fill="#ffffff"
          opacity={0.95}
        >
          <animate attributeName="opacity" values="0.7;1;0.7" dur="1.2s" repeatCount="indefinite" />
        </circle>
      </g>

      <g opacity="0.7">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`360 ${cx} ${cy}`}
          to={`0 ${cx} ${cy}`}
          dur="24s"
          repeatCount="indefinite"
        />
        {orbitMid.map((d, i) => (
          <path
            key={`m-${i}`}
            d={d}
            fill="none"
            stroke={glow}
            strokeWidth={1.2}
            strokeLinecap="round"
            opacity={0.45 + (i % 2) * 0.2}
          />
        ))}
      </g>

      <g opacity="0.9">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${cx} ${cy}`}
          to={`360 ${cx} ${cy}`}
          dur="10s"
          repeatCount="indefinite"
        />
        {orbitInner.map((d, i) => (
          <path
            key={`i-${i}`}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={2.4}
            strokeLinecap="round"
            opacity={0.75}
          />
        ))}
      </g>

      <circle
        cx={cx}
        cy={cy}
        r={radius - strokeW * 0.35}
        fill="none"
        stroke={trackColor}
        strokeWidth={1}
        opacity="0.6"
      />

      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={strokeW}
        opacity="0.45"
      />

      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={`url(#${gid}-prog)`}
        strokeWidth={strokeW}
        strokeLinecap="round"
        strokeDasharray={`${arcLen} ${circumference}`}
        transform={`rotate(-90 ${cx} ${cy})`}
        filter={`url(#${gid}-glow)`}
      >
        <animate
          attributeName="stroke-dasharray"
          from={`0 ${circumference}`}
          to={`${arcLen} ${circumference}`}
          dur="1.4s"
          fill="freeze"
          calcMode="spline"
          keySplines="0.4 0 0.2 1"
          keyTimes="0;1"
        />
      </circle>

      {pct > 0 && (
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={glow}
          strokeWidth={1}
          opacity="0"
          transform={`rotate(-90 ${cx} ${cy})`}
        >
          <animate attributeName="opacity" values="0;0.5;0" dur="2.5s" repeatCount="indefinite" />
          <animate
            attributeName="stroke-dasharray"
            values={`0 ${circumference};${circumference * 0.15} ${circumference};0 ${circumference}`}
            dur="2.5s"
            repeatCount="indefinite"
          />
        </circle>
      )}
    </svg>
  );
}
