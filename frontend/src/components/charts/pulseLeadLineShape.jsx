import { Curve } from 'recharts';

/** Build an SVG path string from Recharts line points (polyline for pulse motion). */
function pointsToPath(points) {
  const pts = (points || []).filter((p) => p != null && p.x != null && p.y != null);
  if (pts.length < 2) return '';
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join('');
}

const PATH_LEN = 1000;

/**
 * Factory for a Recharts Line `shape` with a continuous traveling pulse along the curve.
 *
 * @param {{ dur?: string, begin?: string, uid?: string }} [opts]
 */
export function createPulseLeadShape(opts = {}) {
  const dur = opts.dur || '4s';
  const begin = opts.begin || '0s';
  const uid = String(opts.uid || 'pulse').replace(/[^a-zA-Z0-9_-]/g, '');

  return function PulseLeadShape(props) {
    const { points, stroke, strokeWidth = 2, pathRef } = props;
    const motionPath = pointsToPath(points);
    if (!motionPath) {
      return <Curve {...props} fill="none" />;
    }

    const glowId = `line-pulse-glow-${uid}`;
    const sw = Number(strokeWidth) || 2;
    const tailLen = Math.round(PATH_LEN * 0.18);
    const headLen = Math.round(PATH_LEN * 0.05);
    const tailGap = PATH_LEN - tailLen;
    const headGap = PATH_LEN - headLen;

    return (
      <g className="recharts-line-pulse-lead">
        <defs>
          <filter id={glowId} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <Curve {...props} fill="none" pathRef={pathRef} />

        {/* Soft continuous comet tail */}
        <path
          d={motionPath}
          pathLength={PATH_LEN}
          fill="none"
          stroke={stroke}
          strokeWidth={sw + 4}
          strokeOpacity={0.32}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${tailLen} ${tailGap}`}
          filter={`url(#${glowId})`}
          pointerEvents="none"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to={-PATH_LEN}
            dur={dur}
            begin={begin}
            repeatCount="indefinite"
            calcMode="linear"
          />
        </path>

        {/* Bright pulse head */}
        <path
          d={motionPath}
          pathLength={PATH_LEN}
          fill="none"
          stroke="#ffffff"
          strokeWidth={Math.max(2.5, sw + 0.5)}
          strokeOpacity={0.92}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${headLen} ${headGap}`}
          filter={`url(#${glowId})`}
          pointerEvents="none"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to={-PATH_LEN}
            dur={dur}
            begin={begin}
            repeatCount="indefinite"
            calcMode="linear"
          />
        </path>

        {/* Leading dot — smooth continuous motion along path */}
        <circle r={4} fill="#ffffff" stroke={stroke} strokeWidth={2} pointerEvents="none">
          <animateMotion
            dur={dur}
            begin={begin}
            repeatCount="indefinite"
            path={motionPath}
            rotate="auto"
            calcMode="linear"
          />
        </circle>
        <circle r={7} fill={stroke} opacity={0.35} filter={`url(#${glowId})`} pointerEvents="none">
          <animateMotion
            dur={dur}
            begin={begin}
            repeatCount="indefinite"
            path={motionPath}
            rotate="auto"
            calcMode="linear"
          />
          <animate
            attributeName="opacity"
            values="0.2;0.5;0.2"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </circle>
      </g>
    );
  };
}

/** Shared default shape (single series). */
export const pulseLeadShape = createPulseLeadShape({ uid: 'default', dur: '4s' });
