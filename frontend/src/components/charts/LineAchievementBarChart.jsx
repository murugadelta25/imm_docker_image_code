import { useEffect, useMemo, useState } from 'react';

const METRICS = [
  { key: 'planned', label: 'Planned', color: '#a855f7' },
  { key: 'actual', label: 'Actual', color: '#0ea5e9' },
  { key: 'pct', label: 'Achievement %', color: '#22c55e', isPct: true },
];

function fmtVal(v, isPct) {
  const n = Math.round(Number(v) || 0);
  if (isPct) return `${n}%`;
  return `${n}`;
}

/**
 * Grouped bars per line: Planned, Actual, Achievement % (in that order).
 * Value labels sit on top of each bar.
 * items: [{ id, name, planned, actual, pct }]
 */
export default function LineAchievementBarChart({
  items = [],
  theme,
  height = '100%',
  trackColor,
  xLabel = 'Line',
  yLabel = 'Qty / %',
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

  const maxQty = useMemo(() => {
    let m = 0;
    for (const it of items) {
      m = Math.max(m, Number(it.planned) || 0, Number(it.actual) || 0);
    }
    return m > 0 ? m : 1;
  }, [items]);

  const yTicks = useMemo(() => {
    const step = maxQty / 4;
    return [0, 1, 2, 3, 4].map((i) => Math.round(step * i));
  }, [maxQty]);

  if (!items.length) {
    return (
      <div style={{ height, display: 'grid', placeItems: 'center', color: dim, fontSize: 13 }}>
        No line achievement data
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
            const planned = Math.max(0, Number(item.planned) || 0);
            const actual = Math.max(0, Number(item.actual) || 0);
            const pct = Math.max(0, Math.min(100, Number(item.pct) || 0));
            const bars = [
              {
                key: 'planned',
                label: 'Planned',
                color: METRICS[0].color,
                h: (planned / maxQty) * 100,
                display: fmtVal(planned, false),
                tip: `${planned} qty`,
              },
              {
                key: 'actual',
                label: 'Actual',
                color: METRICS[1].color,
                h: (actual / maxQty) * 100,
                display: fmtVal(actual, false),
                tip: `${actual} qty`,
              },
              {
                key: 'pct',
                label: 'Achievement %',
                color: METRICS[2].color,
                h: pct,
                display: fmtVal(pct, true),
                tip: `${pct}%`,
              },
            ];
            return (
              <button
                key={item.id ?? label}
                type="button"
                onClick={() => onBarClick?.(item)}
                title={`${label}: Planned ${planned} · Actual ${actual} · ${pct}%`}
                style={{
                  flex: 1,
                  minWidth: 80,
                  maxWidth: 168,
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
                  gap: 3,
                }}>
                  {bars.map((bar, bi) => (
                    <div
                      key={bar.key}
                      style={{
                        flex: 1,
                        maxWidth: 26,
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: 2,
                      }}
                      title={`${bar.label}: ${bar.tip}`}
                    >
                      <span style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: bar.color,
                        fontVariantNumeric: 'tabular-nums',
                        lineHeight: 1,
                        whiteSpace: 'nowrap',
                      }}>
                        {bar.display}
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
                          height: ready ? `${bar.h}%` : '0%',
                          borderRadius: 6,
                          background: `linear-gradient(180deg, ${bar.color} 0%, ${bar.color}aa 100%)`,
                          transition: 'height 0.9s cubic-bezier(0.16, 1, 0.3, 1)',
                          transitionDelay: `${idx * 70 + bi * 35}ms`,
                        }}
                        />
                      </div>
                    </div>
                  ))}
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
