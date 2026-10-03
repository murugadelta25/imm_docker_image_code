import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { shadeHex } from './chart3dUtils';

/**
 * 3D segmented horseshoe gauge.
 * Max: dynamic (nice ceiling) or fixed, hard-capped at 9999.
 * Markers at 0% / 25% / 50% / 75% / 100% of the active limit.
 * Colours by position: green (low) → yellow (mid) → red (high).
 */

const MAX_CAP = 9999;
const SEGMENTS = 40;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return { r: 34, g: 197, b: 94 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function colorAt(t) {
  const x = Math.max(0, Math.min(1, t));
  const green = hexToRgb('#22c55e');
  const yellow = hexToRgb('#eab308');
  const red = hexToRgb('#ef4444');
  if (x <= 0.5) {
    const u = x / 0.5;
    return rgbToHex({
      r: lerp(green.r, yellow.r, u),
      g: lerp(green.g, yellow.g, u),
      b: lerp(green.b, yellow.b, u),
    });
  }
  const u = (x - 0.5) / 0.5;
  return rgbToHex({
    r: lerp(yellow.r, red.r, u),
    g: lerp(yellow.g, red.g, u),
    b: lerp(yellow.b, red.b, u),
  });
}

function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, endAngle);
  const delta = endAngle - startAngle;
  const large = Math.abs(delta) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

/**
 * Dynamic ceiling from the live reading (always >= value), hard-capped at 9999.
 * Empty (0) uses full 9999 so a later 1200 reading is never stuck under a 1000 max.
 */
export function resolveGaugeMax(value, fixedMax) {
  const v = Math.max(0, Number(value) || 0);
  if (fixedMax != null && Number(fixedMax) > 0) {
    // Fixed scale (e.g. PF=1) but never below the actual value
    return Math.min(MAX_CAP, Math.max(Number(fixedMax), v));
  }
  if (v <= 0) return MAX_CAP;
  const withHeadroom = Math.min(MAX_CAP, v * 1.15);
  const steps = [
    100, 200, 400, 500, 800, 1000, 1200, 1600, 2000, 2500,
    3000, 4000, 5000, 6000, 8000, MAX_CAP,
  ];
  const nice = steps.find((s) => s >= withHeadroom) || MAX_CAP;
  // Guarantee the needle can reach the true reading (e.g. 1200 never capped by 1000)
  return Math.min(MAX_CAP, Math.max(nice, v));
}

export default function SegmentedArcGauge({
  value = 0,
  max,
  dynamic = true,
  label = '',
  valueText,
  width = 140,
  height = 108,
}) {
  const gid = useId().replace(/:/g, '');
  const n = Math.max(0, Number(value) || 0);
  const scaleMax = useMemo(
    () => (dynamic ? resolveGaugeMax(n, max) : resolveGaugeMax(n, max ?? MAX_CAP)),
    [dynamic, max, n],
  );

  // Fill against dynamic max; never clip the reading below its true value for display %
  const target = Math.min(n, scaleMax);
  const [animated, setAnimated] = useState(0);
  const animRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    const from = animRef.current;
    const to = target;
    const start = performance.now();
    const dur = 900;
    const tick = (now) => {
      const u = Math.min(1, (now - start) / dur);
      const e = 1 - (1 - u) ** 3;
      const next = from + (to - from) * e;
      animRef.current = next;
      setAnimated(next);
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, scaleMax]);

  const lit = Math.round((animated / scaleMax) * SEGMENTS);

  const cx = width / 2;
  const cy = height * 0.6;
  const rOuter = Math.min(width, height) * 0.48;
  const rInner = rOuter - 14;
  const rMid = (rOuter + rInner) / 2;
  const strokeW = rOuter - rInner;

  const startAngle = 225;
  const endAngle = 495;
  const span = endAngle - startAngle;
  const segSpan = span / SEGMENTS;
  const gap = segSpan * 0.18;
  const activeSpan = segSpan - gap;

  const quarterMarks = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const ang = startAngle + p * span;
    const a = polar(cx, cy, rOuter + 1, ang);
    const b = polar(cx, cy, rOuter + 8, ang);
    const labelPt = polar(cx, cy, rOuter + 16, ang);
    const pctLabel = `${Math.round(p * 100)}%`;
    return { p, a, b, labelPt, pctLabel };
  });

  const display = valueText ?? String(Math.round(n * 100) / 100);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      width,
      flexShrink: 0,
      filter: 'drop-shadow(0 3px 6px rgba(15,23,42,0.18))',
    }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
        <defs>
          {/* Transparent trough */}
          <linearGradient id={`trough-${gid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(148,163,184,0.35)" />
            <stop offset="40%" stopColor="rgba(148,163,184,0.22)" />
            <stop offset="100%" stopColor="rgba(148,163,184,0.15)" />
          </linearGradient>
          <linearGradient id={`face-${gid}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="55%" stopColor="rgba(255,255,255,0.04)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.02)" />
          </linearGradient>
          {/* Specular sheen across rim */}
          <linearGradient id={`sheen-${gid}`} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.85)" />
            <stop offset="40%" stopColor="rgba(255,255,255,0.15)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.55)" />
          </linearGradient>
          {/* Per-segment 3D bevels */}
          {Array.from({ length: SEGMENTS }, (_, i) => {
            const t = (i + 0.5) / SEGMENTS;
            const base = colorAt(t);
            const hi = shadeHex(base, 0.45);
            const lo = shadeHex(base, -0.35);
            return (
              <linearGradient key={i} id={`seg-${gid}-${i}`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={hi} />
                <stop offset="45%" stopColor={base} />
                <stop offset="100%" stopColor={lo} />
              </linearGradient>
            );
          })}
          <filter id={`glow-${gid}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="1.8" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Deep trough (3D channel) */}
        <path
          d={describeArc(cx, cy, rMid, startAngle, endAngle)}
          fill="none"
          stroke={`url(#trough-${gid})`}
          strokeWidth={strokeW + 8}
          strokeLinecap="butt"
        />
        {/* Inner / outer rims — light chrome */}
        <path
          d={describeArc(cx, cy, rInner - 1, startAngle, endAngle)}
          fill="none"
          stroke="rgba(255,255,255,0.95)"
          strokeWidth={1.5}
        />
        <path
          d={describeArc(cx, cy, rOuter + 1, startAngle, endAngle)}
          fill="none"
          stroke="rgba(148,163,184,0.85)"
          strokeWidth={2}
        />
        <path
          d={describeArc(cx, cy, rOuter + 0.5, startAngle, endAngle)}
          fill="none"
          stroke="rgba(255,255,255,0.9)"
          strokeWidth={1}
        />

        {/* Segment blocks — shadow layer + lit 3D face */}
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const a0 = startAngle + i * segSpan + gap / 2;
          const a1 = a0 + activeSpan;
          const litSeg = i < lit;
          const t = (i + 0.5) / SEGMENTS;
          const base = colorAt(t);
          return (
            <g key={i} filter={litSeg ? `url(#glow-${gid})` : undefined}>
              <path
                d={describeArc(cx + 0.6, cy + 0.9, rMid, a0, a1)}
                fill="none"
                stroke="rgba(100,116,139,0.35)"
                strokeWidth={strokeW}
                strokeLinecap="butt"
                opacity={litSeg ? 0.8 : 0.2}
              />
              <path
                d={describeArc(cx, cy, rMid, a0, a1)}
                fill="none"
                stroke={litSeg ? `url(#seg-${gid}-${i})` : 'rgba(148,163,184,0.28)'}
                strokeWidth={strokeW - 1}
                strokeLinecap="butt"
                style={{ transition: 'stroke 0.2s ease, opacity 0.2s ease' }}
              />
              {litSeg ? (
                <path
                  d={describeArc(cx, cy, rOuter - 2.5, a0, a1)}
                  fill="none"
                  stroke={shadeHex(base, 0.55)}
                  strokeWidth={1.4}
                  strokeLinecap="butt"
                  opacity={0.9}
                />
              ) : null}
            </g>
          );
        })}

        {/* Moving sheen over lit arc */}
        {lit > 0 ? (
          <path
            d={describeArc(
              cx,
              cy,
              rMid,
              startAngle,
              startAngle + (lit / SEGMENTS) * span,
            )}
            fill="none"
            stroke={`url(#sheen-${gid})`}
            strokeWidth={Math.max(2, strokeW * 0.35)}
            strokeLinecap="butt"
            opacity={0.55}
            style={{ mixBlendMode: 'screen' }}
          >
            <animate
              attributeName="opacity"
              values="0.25;0.65;0.25"
              dur="2.4s"
              repeatCount="indefinite"
            />
          </path>
        ) : null}

        {/* 25 / 50 / 75 / 100 markers */}
        {quarterMarks.map((tk) => (
          <g key={tk.p}>
            <line
              x1={tk.a.x}
              y1={tk.a.y}
              x2={tk.b.x}
              y2={tk.b.y}
              stroke={tk.p === 0.5 ? 'rgba(226,232,240,0.85)' : 'rgba(148,163,184,0.55)'}
              strokeWidth={tk.p === 0.5 ? 2 : 1.2}
            />
            <text
              x={tk.labelPt.x}
              y={tk.labelPt.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="rgba(226,232,240,0.75)"
              fontSize="7"
              fontWeight="700"
            >
              {tk.pctLabel}
            </text>
          </g>
        ))}

        {/* Center dial — transparent */}
        <circle cx={cx} cy={cy - 4} r={22} fill="transparent" stroke="rgba(148,163,184,0.35)" strokeWidth={1} />
        <circle cx={cx} cy={cy - 4} r={20} fill={`url(#face-${gid})`} />
        <text
          x={cx}
          y={cy - 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#f8fafc"
          fontSize="13"
          fontWeight="800"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {display}
        </text>
      </svg>
      {label ? (
        <span style={{
          marginTop: -2,
          fontSize: 11,
          fontWeight: 700,
          color: '#94a3b8',
          textAlign: 'center',
        }}>
          {label}
        </span>
      ) : null}
    </div>
  );
}

export { MAX_CAP as ARC_GAUGE_MAX };
