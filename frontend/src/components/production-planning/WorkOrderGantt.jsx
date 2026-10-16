import { useMemo } from 'react';

// Vertical gradient stops [light top, base, dark bottom] for a 3D glossy bar.
const GANTT_GRADIENTS = {
  schedule: ['#bfdbfe', '#60a5fa', '#2563eb'],   // light blue
  running: ['#fde68a', '#f59e0b', '#d97706'],    // orangish yellow
  completed: ['#86efac', '#22c55e', '#15803d'], // green
  delay: ['#fca5a5', '#ef4444', '#dc2626'],      // red
  estimate: ['#bfdbfe', '#60a5fa', '#2563eb'],
  exact: ['#d9f99d', '#a3e635', '#65a30d'],
};

function bar3dBackground(status) {
  const [top, base, bottom] = GANTT_GRADIENTS[status] || GANTT_GRADIENTS.schedule;
  return `linear-gradient(180deg, ${top} 0%, ${base} 45%, ${base} 55%, ${bottom} 100%)`;
}

// Glossy top sheen + depth shadow beneath the bar.
function bar3dDecor(base) {
  return {
    background: bar3dBackground(base),
    boxShadow: [
      'inset 0 1px 0 rgba(255,255,255,0.55)',
      'inset 0 -2px 3px rgba(0,0,0,0.28)',
      '0 2px 4px rgba(0,0,0,0.35)',
    ].join(', '),
  };
}

function daysBetween(a, b) {
  const ms = new Date(b) - new Date(a);
  return Math.max(Math.ceil(ms / (1000 * 60 * 60 * 24)) + 1, 1);
}

export default function WorkOrderGantt({ t, overview, expandedIds, onToggleExpand, onViewTrackRecord }) {
  const { date_from, date_to, today, items } = overview || { items: [] };
  const totalDays = useMemo(() => daysBetween(date_from, date_to), [date_from, date_to]);

  const dayLabels = useMemo(() => {
    const labels = [];
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(date_from);
      d.setDate(d.getDate() + i);
      labels.push({
        date: d.toISOString().split('T')[0],
        day: d.getDate(),
        month: d.toLocaleString('en', { month: 'short' }),
      });
    }
    return labels;
  }, [date_from, totalDays]);

  const todayOffset = useMemo(() => {
    const idx = dayLabels.findIndex((d) => d.date === today);
    return idx >= 0 ? ((idx + 0.5) / totalDays) * 100 : null;
  }, [dayLabels, today, totalDays]);

  const barStyle = (start, end, status) => {
    const startIdx = dayLabels.findIndex((d) => d.date >= start);
    const endIdx = dayLabels.findIndex((d) => d.date >= end);
    const s = startIdx >= 0 ? startIdx : 0;
    const e = endIdx >= 0 ? endIdx : totalDays - 1;
    const left = (s / totalDays) * 100;
    const width = Math.max(((e - s + 1) / totalDays) * 100, 2);
    return {
      left: `${left}%`,
      width: `${width}%`,
      ...bar3dDecor(status),
    };
  };

  const statusBadge = (status) => {
    const colors = {
      draft: '#64748b', in_progress: '#0ea5e9', completed: '#10b981', cancelled: '#ef4444',
    };
    const labels = {
      draft: 'Draft', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled',
    };
    return (
      <span style={{
        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
        background: (colors[status] || '#64748b') + '22',
        color: colors[status] || '#64748b',
      }}>
        {labels[status] || status}
      </span>
    );
  };

  const timelineMinWidth = Math.max(totalDays * 28, 400);

  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: 8, overflow: 'hidden', minHeight: 280 }}>
      {/* Scrollable wrapper */}
      <div style={{ overflowX: 'auto' }}>
        <div style={{ display: 'flex', minWidth: 340 + timelineMinWidth }}>
          {/* Left header */}
          <div style={{
            width: 220, minWidth: 220, flexShrink: 0,
            borderRight: `1px solid ${t.border}`, background: t.surface2,
            display: 'flex', alignItems: 'center', padding: '8px 10px',
            borderBottom: `1px solid ${t.border}`, fontSize: 11, color: t.textDim, fontWeight: 600,
          }}>
            Work Order Infos
          </div>
          {/* Day header */}
          <div style={{ flex: 1, display: 'flex', borderBottom: `1px solid ${t.border}`, background: t.surface2 }}>
            {dayLabels.map((d, i) => (
              <div key={d.date} style={{
                flex: 1, minWidth: 28, textAlign: 'center', padding: '4px 0', fontSize: 10, color: t.textDim,
                borderLeft: i > 0 && d.day === 1 ? `2px solid ${t.border}` : `1px solid ${t.border}`,
              }}>
                {d.day === 1 || i === 0 ? <div style={{ fontWeight: 600, color: t.textMuted }}>{d.month}</div> : null}
                <div>{d.day}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Rows — each WO is one flex row spanning info + timeline */}
        <div style={{ position: 'relative', minWidth: 340 + timelineMinWidth }}>
          {items.map((wo) => {
            const expanded = expandedIds?.has(wo.id);
            const planRows = expanded ? (wo.plans || []) : [];
            const segRows = expanded ? (wo.segments || []) : [];
            return (
              <div key={wo.id} style={{ display: 'flex', borderBottom: `1px solid ${t.border}` }}>
                {/* Info cell */}
                <div style={{ width: 220, minWidth: 220, flexShrink: 0, borderRight: `1px solid ${t.border}`, background: t.surface2 }}>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '22px 1fr', gap: 4, padding: '8px 8px 4px', alignItems: 'center',
                    cursor: 'pointer', fontSize: 12,
                  }} onClick={() => onViewTrackRecord?.(wo.id) ?? onToggleExpand?.(wo.id)}>
                    <span style={{ color: t.accent, fontSize: 11 }} onClick={(e) => { e.stopPropagation(); onToggleExpand?.(wo.id); }}>
                      {expanded ? '▼' : '▶'}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: t.text, fontWeight: 700, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wo.work_order_no}</div>
                      <div style={{ color: t.textMuted, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {wo.part_label}
                      </div>
                    </div>
                  </div>
                  <div style={{ padding: '2px 8px 6px 30px', fontSize: 10, lineHeight: 1.5 }}>
                    {statusBadge(wo.status)}
                    <div style={{ color: t.textMuted, marginTop: 2 }}>
                      {wo.complete_pct}% ({wo.completed_qty} / {wo.target_qty})
                    </div>
                    <div style={{ color: t.textDim }}>Remaining: {wo.remaining_qty} pcs</div>
                  </div>
                  {planRows.map((p) => (
                    <div key={p.id} style={{ padding: '3px 8px 3px 30px', fontSize: 10, color: t.textMuted, borderTop: `1px dashed ${t.border}` }}>
                      {p.plan_date} · {p.machine_name || `Stn ${p.station_no}`} · {p.actual_qty}/{p.planned_qty}
                    </div>
                  ))}
                </div>

                {/* Bar cell */}
                <div style={{ flex: 1, position: 'relative', minHeight: 60 }}>
                  {/* Today line */}
                  {todayOffset != null && (
                    <div style={{
                      position: 'absolute', top: 0, bottom: 0,
                      left: `${todayOffset}%`, width: 2,
                      background: '#ef4444', zIndex: 3, pointerEvents: 'none',
                    }} />
                  )}
                  {/* Main bar — vertically centred in the info area */}
                  <div style={{ position: 'absolute', top: 12, left: 0, right: 0, height: 20, padding: '0 2px' }}>
                    <div style={{
                      position: 'absolute', height: '100%', borderRadius: 5,
                      ...barStyle(wo.bar_start, wo.bar_end, wo.gantt_status),
                    }} title={`${wo.work_order_no}: ${wo.bar_start} → ${wo.bar_end}`} />
                  </div>
                  {/* Segment bars for expanded plans */}
                  {expanded && segRows.map((seg, i) => (
                    <div key={seg.plan_id || i} style={{ position: 'absolute', top: 36 + i * 20, left: 0, right: 0, height: 14, padding: '0 2px' }}>
                      <div style={{
                        position: 'absolute', height: '100%', borderRadius: 4,
                        ...barStyle(seg.start, seg.end, seg.status),
                      }} title={`${seg.machine_name || 'Plan'}: ${seg.actual_qty}/${seg.planned_qty}`} />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: t.textFaint, fontSize: 13 }}>No work orders in range</div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, padding: '8px 12px', fontSize: 11, color: t.textMuted, flexWrap: 'wrap', borderTop: `1px solid ${t.border}` }}>
        {Object.entries({ Schedule: 'schedule', Running: 'running', Completed: 'completed', Delay: 'delay' }).map(([label, key]) => (
          <span key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 14, height: 10, borderRadius: 3,
              background: bar3dBackground(key),
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 2px rgba(0,0,0,0.3)',
            }} />
            {label}
          </span>
        ))}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 2, height: 12, background: '#ef4444' }} /> Current
        </span>
      </div>
    </div>
  );
}
