import { useState, useEffect } from 'react';
import { surfaceClass } from '../../themes/tileHelpers';
import api from '../../api/client';

export default function WorkOrderDetailPanel({
  t, detail, loading, onClose, upcomingPlans, scheduleOnly, onSaveActual,
  canManage = false, onEdit, onDelete, onPause, onAbort, deleting = false, actionBusy = false,
}) {
  const [actualEdit, setActualEdit] = useState({ id: null, qty: '' });
  const [saving, setSaving] = useState(false);
  const [toolMonitor, setToolMonitor] = useState(null);

  const woId = detail?.work_order?.id;
  useEffect(() => {
    if (!woId) {
      setToolMonitor(null);
      return undefined;
    }
    let cancelled = false;
    api.get(`/api/tools/work-order/${woId}/monitor`)
      .then((r) => { if (!cancelled) setToolMonitor(r.data); })
      .catch(() => { if (!cancelled) setToolMonitor(null); });
    return () => { cancelled = true; };
  }, [woId]);

  if (!loading && !detail) return null;

  const table = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
  const th = {
    padding: '9px 8px', background: t.surface2, color: t.textDim, textAlign: 'left', whiteSpace: 'nowrap',
  };
  const td = {
    padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted, whiteSpace: 'nowrap',
  };
  const miniBtn = {
    padding: '2px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', color: '#fff', fontSize: 12,
  };

  const saveActual = async (planId) => {
    if (!onSaveActual) return;
    const qty = parseInt(actualEdit.qty, 10);
    if (Number.isNaN(qty) || qty < 0) return;
    setSaving(true);
    try {
      await onSaveActual(planId, qty);
      setActualEdit({ id: null, qty: '' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={surfaceClass(t)} style={{ borderRadius: 10, padding: 20, marginTop: 16 }}>
      {loading && !detail && (
        <p style={{ color: t.textMuted, fontSize: 13, margin: 0 }}>Loading track record…</p>
      )}
      {detail && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12, gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <h4 style={{ color: t.accent, margin: 0, fontSize: 14, fontWeight: 600 }}>
                {detail.work_order?.work_order_no} — Details
              </h4>
              {canManage && (
                <>
                  <button type="button" onClick={() => onEdit?.(detail.work_order)}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                    Edit
                  </button>
                  <button type="button" disabled={actionBusy}
                    onClick={() => onPause?.(detail.work_order)}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, cursor: actionBusy ? 'wait' : 'pointer' }}>
                    Pause
                  </button>
                  <button type="button" disabled={actionBusy}
                    onClick={() => onAbort?.(detail.work_order)}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: '#9f1239', color: '#fff', border: 'none', borderRadius: 6, cursor: actionBusy ? 'wait' : 'pointer' }}>
                    Abort
                  </button>
                  <button type="button" disabled={deleting}
                    onClick={() => onDelete?.(detail.work_order)}
                    style={{ padding: '5px 12px', fontSize: 12, fontWeight: 600, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: 6, cursor: deleting ? 'wait' : 'pointer', opacity: deleting ? 0.6 : 1 }}>
                    {deleting ? 'Deleting…' : 'Delete'}
                  </button>
                </>
              )}
            </div>
            {onClose && (
              <button type="button" onClick={onClose}
                style={{ background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', flexShrink: 0 }}>✕</button>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8, marginBottom: 16 }}>
            {[
              { label: 'Target', value: detail.work_order?.target_qty, color: '#0ea5e9' },
              { label: 'Completed', value: detail.summary?.completed_qty, color: '#10b981' },
              { label: 'Remaining', value: detail.summary?.remaining_qty, color: '#f59e0b' },
              { label: 'Planned', value: detail.summary?.planned_qty, color: '#8b5cf6' },
              { label: 'Complete %', value: `${detail.summary?.complete_pct}%`, color: t.brand },
            ].map((k) => (
              <div key={k.label} style={{ background: t.surface2, borderRadius: 8, padding: 10, borderTop: `3px solid ${k.color}` }}>
                <div style={{ color: k.color, fontWeight: 700, fontSize: 16 }}>{k.value}</div>
                <div style={{ color: t.textMuted, fontSize: 10 }}>{k.label}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 12 }}>
            <div><strong>Mold:</strong> {detail.work_order?.mold_label || detail.work_order?.model_variant || detail.work_order?.mold_name || detail.work_order?.part_no || '—'}</div>
            <div><strong>Period:</strong> {detail.work_order?.start_date || '—'} → {detail.work_order?.end_date || '—'}</div>
            {detail.work_order?.description && <div><strong>Description:</strong> {detail.work_order.description}</div>}
            {detail.work_order?.spares_tools?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <strong>Spares / Tools:</strong>
                <div style={{ overflowX: 'auto', marginTop: 4 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr>
                        {['Name', 'Tool No', 'Stock', 'Required', 'Remaining', 'Life', 'Status', 'Unit'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', padding: '4px 6px', color: t.textDim }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(toolMonitor?.tools?.length
                        ? toolMonitor.tools
                        : detail.work_order.spares_tools.map((s) => ({
                          tool_name: s.name,
                          tool_code: s.tool_no,
                          stock_available: s.stock_available,
                          required_qty: s.qty,
                          remaining_after: s.remaining_qty,
                          unit: s.unit,
                        }))
                      ).map((s, i) => (
                        <tr key={i}>
                          <td style={{ padding: '4px 6px' }}>{s.tool_name || s.name || '—'}</td>
                          <td style={{ padding: '4px 6px' }}>{s.tool_code || s.tool_no || '—'}</td>
                          <td style={{ padding: '4px 6px' }}>{s.stock_available != null ? s.stock_available : '—'}</td>
                          <td style={{ padding: '4px 6px' }}>{s.required_qty != null ? s.required_qty : (s.qty ?? '—')}</td>
                          <td style={{
                            padding: '4px 6px',
                            color: (s.remaining_after ?? s.remaining_qty) != null && (s.remaining_after ?? s.remaining_qty) < 0 ? '#ef4444' : undefined,
                            fontWeight: 600,
                          }}>
                            {s.remaining_after != null ? s.remaining_after : (s.remaining_qty ?? '—')}
                          </td>
                          <td style={{ padding: '4px 6px' }}>
                            {s.life_cycles_limit
                              ? `${s.cycles_used ?? 0}/${s.life_cycles_limit} (${s.life_used_pct ?? 0}%)`
                              : '—'}
                          </td>
                          <td style={{ padding: '4px 6px' }}>{s.tool_status || '—'}</td>
                          <td style={{ padding: '4px 6px' }}>{s.unit || 'pcs'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {toolMonitor?.history?.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <strong>Tool usage history</strong>
                    <div style={{ maxHeight: 140, overflow: 'auto', marginTop: 4 }}>
                      {toolMonitor.history.slice(0, 20).map((e) => (
                        <div key={e.id} style={{ fontSize: 11, color: t.textMuted, padding: '2px 0' }}>
                          {e.event_type}
                          {e.cycles_delta != null ? ` · Δ${e.cycles_delta} cycles` : ''}
                          {e.location ? ` · ${e.location}` : ''}
                          {e.notes ? ` — ${e.notes}` : ''}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {(scheduleOnly && !upcomingPlans?.length) && (
            <div style={{
              marginBottom: 16, padding: 12, borderRadius: 8,
              background: '#8b5cf622', border: `1px solid ${t.border}`,
              fontSize: 12, color: t.textMuted,
            }}>
              <strong style={{ color: '#8b5cf6' }}>Future work order — no production plans yet</strong>
              <div style={{ marginTop: 6 }}>
                Scheduled period: {scheduleOnly.start || '—'} → {scheduleOnly.end || '—'}
              </div>
              <div>Target qty: {scheduleOnly.target_qty} · Unplanned: {scheduleOnly.unplanned_qty} pcs</div>
              <div style={{ marginTop: 4, color: t.textDim }}>
                Link this work order when creating production plans in Production Planning.
              </div>
            </div>
          )}

          {(upcomingPlans?.length > 0) && (
            <>
              <h5 style={{ color: '#8b5cf6', fontSize: 13, margin: '0 0 8px' }}>Upcoming Planned Runs</h5>
              <div style={{ overflowX: 'auto', maxHeight: 280, marginBottom: 16 }}>
                <table style={table}>
                  <thead>
                    <tr>
                      {['Date', 'Shift', 'Machine', 'Operation', 'Planned', 'Remaining', 'Status'].map((h) => (
                        <th key={h} style={th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {upcomingPlans.map((p) => (
                      <tr key={p.id || `${p.plan_date}-${p.shift}-${p.machine_name}`}>
                        <td style={td}>{p.plan_date}</td>
                        <td style={td}>{p.shift}</td>
                        <td style={td}>{p.machine_name || `Stn ${p.station_no}`}</td>
                        <td style={td}>{p.current_operation} → {p.next_operation}</td>
                        <td style={td}>{p.planned_qty}</td>
                        <td style={td}>{Math.max((p.planned_qty || 0) - (p.actual_qty || 0), 0)}</td>
                        <td style={td}>{p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h5 style={{ color: t.accent, fontSize: 13, margin: '0 0 8px' }}>Production Track Record</h5>
          <p style={{ color: t.textDim, fontSize: 11, margin: '0 0 8px' }}>
            Actual updates automatically from machine running count. Click a value to edit manually.
          </p>
          <div style={{ overflowX: 'auto', maxHeight: 360 }}>
            <table style={table}>
              <thead>
                <tr>
                  {['Date', 'Shift', 'Machine', 'Planned', 'Actual', '%', 'Status'].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(detail.records || []).map((r) => {
                  const pct = r.complete_pct ?? (
                    r.planned_qty > 0 ? Math.round((r.actual_qty / r.planned_qty) * 1000) / 10 : 0
                  );
                  const editing = actualEdit.id === r.plan_id;
                  return (
                    <tr key={r.plan_id}>
                      <td style={td}>{r.run_date}</td>
                      <td style={td}>{r.shift}</td>
                      <td style={td}>{r.machine_name}</td>
                      <td style={td}>{r.planned_qty}</td>
                      <td style={td}>
                        {editing ? (
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input
                              type="number"
                              min="0"
                              value={actualEdit.qty}
                              disabled={saving}
                              onChange={(e) => setActualEdit((v) => ({ ...v, qty: e.target.value }))}
                              style={{
                                width: 70, padding: '3px 6px', borderRadius: 4,
                                border: `1px solid ${t.border}`, background: t.inp, color: t.text, fontSize: 12,
                              }}
                            />
                            <button
                              type="button"
                              disabled={saving}
                              style={{ ...miniBtn, background: t.brand }}
                              onClick={() => saveActual(r.plan_id)}
                            >✓</button>
                            <button
                              type="button"
                              disabled={saving}
                              style={{ ...miniBtn, background: t.textFaint }}
                              onClick={() => setActualEdit({ id: null, qty: '' })}
                            >✕</button>
                          </div>
                        ) : (
                          <span
                            title={onSaveActual ? 'Click to edit actual qty' : undefined}
                            style={{
                              cursor: onSaveActual ? 'pointer' : 'default',
                              color: t.text,
                              fontWeight: 600,
                              borderBottom: onSaveActual ? `1px dashed ${t.border}` : 'none',
                            }}
                            onClick={() => onSaveActual && setActualEdit({ id: r.plan_id, qty: String(r.actual_qty ?? 0) })}
                          >
                            {r.actual_qty}
                          </span>
                        )}
                      </td>
                      <td style={td}>{pct}%</td>
                      <td style={td}>{r.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!detail.records?.length && (
              <p style={{ color: t.textFaint, fontSize: 12, textAlign: 'center', padding: 16 }}>No linked production runs yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
