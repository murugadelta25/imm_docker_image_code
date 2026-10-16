import { useEffect, useId, useRef, useState } from 'react';
import { heatMapColor, HEAT_MAP_LEGEND } from '../../utils/heatMap';

/**
 * Overview HUD donut — cyber/OEE style:
 * thick progress arc, dashed outer orbit + glowing bead, dotted inner orbit,
 * large center % with label inside the ring.
 */
export default function DonutGauge({
  value = 0,
  color,
  trackColor,
  size = 260,
  label = '',
  sublabel = '',
  theme,
  useHeatMap = true,
  showLegend = false,
  metaAlign = 'center',
}) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  // When heat map is off, never fall back to heatMapColor — use explicit color or a
  // stable theme accent so the gauge does not silently re-enable value banding.
  const fillColor = useHeatMap
    ? heatMapColor(pct)
    : (color || theme?.accent || theme?.brand || '#38bdf8');
  const isDark = theme?.isDark !== false && theme?.id !== 'light';
  const track = trackColor
    || (isDark ? (theme?.surface2 || '#1e293b') : '#cbd5e1');
  const dim = theme?.textDim || '#94a3b8';
  const text = theme?.text || (isDark ? '#e2e8f0' : '#1e293b');
  const gid = useId().replace(/:/g, '');
  const [drawn, setDrawn] = useState(false);
  const wrapRef = useRef(null);
  const preferred = Math.max(160, Number(size) || 260);
  const [canvas, setCanvas] = useState(preferred);
  const leftMeta = metaAlign === 'left';

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // Reserve vertical room for sublabel + legend inside the flex column
      const reserveY = (sublabel && !leftMeta ? 28 : 0) + (showLegend ? 36 : 0) + 8;
      // Donut stays centered; left meta is overlaid so don't shrink for it
      const availW = Math.max(120, rect.width - 8);
      const availH = Math.max(120, rect.height - reserveY);
      const next = Math.min(preferred, availW, availH);
      setCanvas(Math.max(140, Math.floor(next)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [preferred, showLegend, sublabel, leftMeta]);

  const stroke = canvas * 0.085;
  const cx = canvas / 2;
  const cy = canvas / 2;
  const r = canvas * 0.30;
  const circ = 2 * Math.PI * r;
  const targetDash = (pct / 100) * circ;
  const outerR = r + stroke * 1.15;
  const innerR = r - stroke * 0.72;

  useEffect(() => {
    setDrawn(false);
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setDrawn(true));
    });
    return () => cancelAnimationFrame(id);
  }, [pct, fillColor]);

  const orbitDots = [0, 60, 120, 180, 240, 300];

  const leftMetaBlock = leftMeta && (label || sublabel) ? (
    <div style={{
      position: 'absolute',
      left: 4,
      top: '50%',
      transform: 'translateY(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      justifyContent: 'center',
      gap: 8,
      maxWidth: 160,
      textAlign: 'left',
      zIndex: 1,
      pointerEvents: 'none',
    }}>
      {label ? (
        <div style={{
          fontSize: Math.max(24, Math.round(canvas * 0.11)),
          fontWeight: 800,
          color: text,
          lineHeight: 1.15,
          textAlign: 'left',
        }}>
          {label}
        </div>
      ) : null}
      {sublabel ? (
        <div style={{
          fontSize: Math.max(18, Math.round(canvas * 0.085)),
          fontWeight: 700,
          color: dim,
          lineHeight: 1.25,
          textAlign: 'left',
        }}>
          {sublabel}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      ref={wrapRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        flex: 1,
        width: '100%',
        minHeight: 0,
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        width: '100%',
        flex: 1,
        minHeight: 0,
      }}>
        {leftMetaBlock}

        <svg
          width={canvas}
          height={canvas}
          viewBox={`0 0 ${canvas} ${canvas}`}
          style={{ overflow: 'visible', flexShrink: 0 }}
          aria-hidden
        >
          <defs>
            <linearGradient id={`${gid}-prog`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={fillColor} stopOpacity="1" />
              <stop offset="55%" stopColor={fillColor} stopOpacity="0.95" />
              <stop offset="100%" stopColor={fillColor} stopOpacity="0.8" />
            </linearGradient>
            <radialGradient id={`${gid}-halo`} cx="50%" cy="50%" r="50%">
              <stop offset="50%" stopColor="transparent" />
              <stop offset="78%" stopColor={fillColor} stopOpacity={isDark ? 0.12 : 0.06} />
              <stop offset="100%" stopColor={fillColor} stopOpacity={isDark ? 0.22 : 0.1} />
            </radialGradient>
            <filter id={`${gid}-glow`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation={isDark ? 3 : 1.8} result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={`${gid}-bead`} x="-120%" y="-120%" width="340%" height="340%">
              <feGaussianBlur stdDeviation="2.8" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <circle cx={cx} cy={cy} r={outerR + 6} fill={`url(#${gid}-halo)`} />

          {/* Outer dashed orbit + cardinal dots (rotating) */}
          <g filter={`url(#${gid}-glow)`}>
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`0 ${cx} ${cy}`}
              to={`360 ${cx} ${cy}`}
              dur="12s"
              repeatCount="indefinite"
            />
            <circle
              cx={cx}
              cy={cy}
              r={outerR}
              fill="none"
              stroke={isDark ? '#ffffff' : fillColor}
              strokeWidth={2}
              strokeDasharray={`${canvas * 0.028} ${canvas * 0.038}`}
              opacity={isDark ? 0.85 : 0.55}
            />
            {orbitDots.map((a) => {
              const rad = (a * Math.PI) / 180;
              return (
                <circle
                  key={`od-${a}`}
                  cx={cx + outerR * Math.cos(rad)}
                  cy={cy + outerR * Math.sin(rad)}
                  r={canvas * 0.012}
                  fill={isDark ? '#ffffff' : fillColor}
                  opacity={0.9}
                />
              );
            })}
          </g>

          {/* Glowing bead on outer orbit */}
          <g filter={`url(#${gid}-bead)`}>
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`0 ${cx} ${cy}`}
              to={`360 ${cx} ${cy}`}
              dur="4.8s"
              repeatCount="indefinite"
            />
            <circle
              cx={cx}
              cy={cy - outerR}
              r={canvas * 0.038}
              fill={fillColor}
              opacity={0.35}
            />
            <circle
              cx={cx}
              cy={cy - outerR}
              r={canvas * 0.022}
              fill={fillColor}
              stroke="#ffffff"
              strokeWidth={2}
            />
            <circle
              cx={cx}
              cy={cy - outerR}
              r={canvas * 0.01}
              fill="#ffffff"
            />
            <circle
              cx={cx}
              cy={cy - outerR}
              r={canvas * 0.055}
              fill="none"
              stroke={fillColor}
              strokeWidth={1.5}
              opacity={0.55}
            >
              <animate attributeName="r" values={`${canvas * 0.045};${canvas * 0.065};${canvas * 0.045}`} dur="1.5s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1.5s" repeatCount="indefinite" />
            </circle>
          </g>

          {/* Inner dotted orbit (counter-rotate) */}
          <g>
            <animateTransform
              attributeName="transform"
              type="rotate"
              from={`360 ${cx} ${cy}`}
              to={`0 ${cx} ${cy}`}
              dur="16s"
              repeatCount="indefinite"
            />
            <circle
              cx={cx}
              cy={cy}
              r={innerR}
              fill="none"
              stroke={isDark ? '#ffffff' : fillColor}
              strokeWidth={2.2}
              strokeDasharray={`1.6 ${canvas * 0.028}`}
              strokeLinecap="round"
              opacity={isDark ? 0.8 : 0.5}
            />
          </g>

          {/* Track */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={track}
            strokeWidth={stroke}
            opacity={isDark ? 0.5 : 0.95}
          />

          {/* Progress fill */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={`url(#${gid}-prog)`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${drawn ? targetDash : 0} ${circ}`}
            transform={`rotate(-90 ${cx} ${cy})`}
            filter={`url(#${gid}-glow)`}
            style={{ transition: 'stroke-dasharray 1.15s cubic-bezier(0.22, 1, 0.36, 1)' }}
          />

          {/* Center % + label */}
          <text
            x={cx}
            y={label && !leftMeta ? cy - canvas * 0.02 : cy}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={fillColor}
            fontSize={canvas * 0.155}
            fontWeight="800"
            style={{ textShadow: isDark ? `0 0 14px ${fillColor}` : undefined }}
          >
            {pct.toFixed(pct % 1 ? 1 : 0)}%
          </text>
          {label && !leftMeta ? (
            <text
              x={cx}
              y={cy + canvas * 0.095}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={dim}
              fontSize={canvas * 0.07}
              fontWeight="700"
            >
              {label}
            </text>
          ) : null}
        </svg>
      </div>

      {!leftMeta && sublabel ? (
        <div style={{
          fontSize: 14,
          fontWeight: 700,
          color: dim,
          textAlign: 'center',
          flexShrink: 0,
        }}>
          {sublabel}
        </div>
      ) : null}

      {showLegend ? (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '8px 14px',
          marginTop: 2,
          flexShrink: 0,
        }}>
          {HEAT_MAP_LEGEND.map((item) => (
            <span
              key={item.label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 700,
                color: text,
              }}
            >
              <span style={{
                width: 11,
                height: 11,
                borderRadius: 3,
                background: item.color,
                boxShadow: isDark ? `0 0 6px ${item.color}` : 'none',
                border: isDark ? 'none' : '1px solid rgba(0,0,0,0.12)',
              }}
              />
              {item.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
