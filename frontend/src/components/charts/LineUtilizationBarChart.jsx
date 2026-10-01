import { useEffect, useMemo, useState } from 'react';

const METRICS = [
  { key: 'uptime_min', label: 'Uptime', color: '#22c55e' },
  { key: 'downtime_min', label: 'Downtime', color: '#ef4444' },
  { key: 'mttr_min', label: 'MTTR', color: '#f59e0b' },
  { key: 'mtbf_min', label: 'MTBF', color: '#38bdf8' },
];

function fmtMin(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Math.round(Number(v))}`;
}

/**
 * Grouped bar chart: per line shows Uptime, Downtime, MTTR, MTBF (minutes).
 * Value labels sit on top of each bar.
 * items: [{ id, name, uptime_min, downtime_min, mttr_min, mtbf_min }]
 */
export default function LineUtilizationBarChart({
  items = [],
  theme,
  height = '100%',
  trackColor,
  xLabel = 'Line',
  yLabel = 'Minutes',
  onBarClick,
}) {
  const text = theme?.text || '#111';
  const dim = theme?.textDim || '#6b7280';
  const track = trackColor || (theme?.surface2 || '#e5e7eb');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setReady(true));
    });
    return () => cancelAnimationFrame(id);
  }, [items]);

  const maxVal = useMemo(() => {
    let m = 0;
    for (const it of items) {
      for (const met of METRICS) {
        m = Math.max(m, Number(it[met.key]) || 0);
      }
    }
    return m > 0 ? m : 1;
  }, [items]);

  const yTicks = useMemo(() => {
    const step = maxVal / 4;
    return [0, 1, 2, 3, 4].map((i) => Math.round(step * i));
  }, [maxVal]);

  if (!items.length) {
    return (
      <div style={{ height, display: 'grid', placeItems: 'center', color: dim, fontSize: 13 }}>
        No line utilization data
      </div>
    );
  }

  return (
    <div style={{
      height: height || '100%',
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      boxSizing: 'border-box',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 12,
        flexWrap: 'wrap',
        paddingRight: 4,
      }}>
        {METRICS.map((met) => (
          <span key={met.key} style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 13,
            fontWeight: 700,
            color: text,
          }}>
            <span style={{
              width: 11,
              height: 11,
              borderRadius: 3,
              background: met.color,
            }}
            />
            {met.label}
          </span>
        ))}
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, gap: 8 }}>
        <div style={{
          width: 46,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          paddingBottom: 28,
          paddingTop: 22,
          position: 'relative',
        }}>
          <span style={{
            position: 'absolute',
            left: 0,
            top: '42%',
            transform: 'rotate(-90deg) translateX(-50%)',
            transformOrigin: 'left center',
            fontSize: 13,
            fontWeight: 700,
            color: dim,
            whiteSpace: 'nowrap',
          }}>
            {yLabel}
          </span>
          {[...yTicks].reverse().map((tick) => (
            <span key={tick} style={{
              fontSize: 12,
              color: dim,
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 600,
            }}>
              {tick}
            </span>
          ))}
        </div>

        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-around',
          gap: 8,
          borderLeft: `1.5px solid ${dim}66`,
          borderBottom: `1.5px solid ${dim}66`,
          paddingTop: 4,
          minWidth: 0,
          overflowX: 'auto',
        }}>
          {items.map((item, idx) => {
            const label = item.name || `Line ${idx + 1}`;
            const vals = METRICS.map((met) => {
              const raw = item[met.key];
              const numeric = raw == null || raw === '' ? null : Number(raw);
              return {
                ...met,
                raw,
                val: numeric != null && Number.isFinite(numeric) ? Math.max(0, numeric) : null,
              };
            });
            const tip = vals.map((v) => (
              v.val == null ? `${v.label} —` : `${v.label} ${v.val} min`
            )).join(' · ');
            return (
              <button
                key={item.id ?? label}
                type="button"
                onClick={() => onBarClick?.(item)}
                title={`${label}: ${tip}`}
                style={{
                  flex: 1,
                  minWidth: 84,
                  maxWidth: 176,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 4,
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  cursor: onBarClick ? 'pointer' : 'default',
                  color: text,
                }}
              >
                <div style={{
                  flex: 1,
                  minHeight: 88,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  gap: 2,
                }}>
                  {vals.map((bar, bi) => {
                    const h = bar.val == null ? 0 : (bar.val / maxVal) * 100;
                    return (
                      <div
                        key={bar.key}
                        style={{
                          flex: 1,
                          maxWidth: 22,
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          gap: 2,
                        }}
                        title={bar.val == null ? `${bar.label}: —` : `${bar.label}: ${bar.val} min`}
                      >
                        <span style={{
                          fontSize: 12,
                          fontWeight: 800,
                          color: bar.color,
                          fontVariantNumeric: 'tabular-nums',
                          lineHeight: 1,
                          whiteSpace: 'nowrap',
                        }}>
                          {fmtMin(bar.val)}
                        </span>
                        <div style={{
                          width: '100%',
                          flex: 1,
                          minHeight: 48,
                          borderRadius: 6,
                          background: track,
                          display: 'flex',
                          alignItems: 'flex-end',
                          overflow: 'hidden',
                          boxShadow: `inset 0 0 0 1px ${bar.color}33`,
                        }}>
                          <div style={{
                            width: '100%',
                            height: ready ? `${h}%` : '0%',
                            borderRadius: 6,
                            background: `linear-gradient(180deg, ${bar.color} 0%, ${bar.color}aa 100%)`,
                            transition: 'height 0.9s cubic-bezier(0.16, 1, 0.3, 1)',
                            transitionDelay: `${idx * 70 + bi * 30}ms`,
                          }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <span style={{
                  fontSize: 14,
                  fontWeight: 700,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '100%',
                  color: text,
                  lineHeight: 1.15,
                }}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: dim }}>
        {xLabel}
      </div>
    </div>
  );
}
