import Donut3D, { DONUT_CANVAS } from './Donut3D';

const wrapStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
};

const ringStyle = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: DONUT_CANVAS,
  height: DONUT_CANVAS,
  flexShrink: 0,
};

const centerStyle = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
  textAlign: 'center',
};

/**
 * Donut gauge: percentage centered inside the ring; status/label below (outside).
 */
export default function DonutGauge({
  value = 0,
  color = '#0ea5e9',
  trackColor = '#1e293b',
  label,
  valueText,
  theme,
  valueSize = 22,
  labelSize = 14,
}) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0));
  const displayValue = valueText ?? `${Number.isInteger(pct) ? Math.round(pct) : pct.toFixed(1)}%`;
  const labelColor = theme?.textDim || theme?.textMuted || '#94a3b8';

  return (
    <div style={wrapStyle}>
      <div style={ringStyle}>
        <Donut3D value={pct} color={color} trackColor={trackColor} />
        <div style={centerStyle}>
          <span style={{ color, fontSize: valueSize, fontWeight: 700, lineHeight: 1.1 }}>
            {displayValue}
          </span>
        </div>
      </div>
      {label ? (
        <span style={{
          color: labelColor,
          fontSize: labelSize,
          fontWeight: 600,
          marginTop: 2,
          textAlign: 'center',
        }}>
          {label}
        </span>
      ) : null}
    </div>
  );
}

export { DONUT_CANVAS };
