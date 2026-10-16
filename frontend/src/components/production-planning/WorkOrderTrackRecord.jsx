import { useState, useEffect } from 'react';
import api from '../../api/client';

export default function WorkOrderTrackRecord({ t, workOrderId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workOrderId) return;
    setLoading(true);
    api.get(`/api/work-orders/${workOrderId}/track-record`)
      .then((r) => setData(r.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [workOrderId]);

  if (!workOrderId) return null;

  const wo = data?.work_order;
  const summary = data?.summary;
  const records = data?.records || [];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1001,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: t.surface, borderRadius: 12, padding: 24, width: '100%', maxWidth: 900,
        maxHeight: '90vh', overflow: 'auto', border: `1px solid ${t.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, color: t.accent }}>
            Work Order Track Record {wo ? `— ${wo.work_order_no}` : ''}
          </h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {loading && <p style={{ color: t.textMuted }}>Loading…</p>}

        {wo && summary && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Target Qty', value: wo.target_qty, color: '#0ea5e9' },
                { label: 'Completed', value: summary.completed_qty, color: '#10b981' },
                { label: 'Remaining', value: summary.remaining_qty, color: '#f59e0b' },
                { label: 'Planned', value: summary.planned_qty, color: '#8b5cf6' },
                { label: 'Unplanned', value: summary.unplanned_qty, color: '#64748b' },
                { label: 'Complete %', value: `${summary.complete_pct}%`, color: t.brand },
              ].map((k) => (
                <div key={k.label} style={{ background: t.surface2, borderRadius: 8, padding: 12, borderTop: `3px solid ${k.color}` }}>
                  <div style={{ color: k.color, fontSize: 18, fontWeight: 700 }}>{k.value}</div>
                  <div style={{ color: t.textMuted, fontSize: 11 }}>{k.label}</div>
                </div>
              ))}
            </div>

            {wo.spares_tools?.length > 0 && (
              <div style={{ marginBottom: 16, padding: 10, background: t.surface2, borderRadius: 8, fontSize: 12 }}>
                <div style={{ color: t.textDim, marginBottom: 6 }}>Spares / Tools</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Name', 'Tool No', 'Stock', 'Required', 'Remaining'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 6px', color: t.textDim, fontWeight: 500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {wo.spares_tools.map((s, i) => (
                      <tr key={i}>
                        <td style={{ padding: '4px 6px', color: t.textMuted }}>{s.name}</td>
                        <td style={{ padding: '4px 6px', color: t.textMuted }}>{s.tool_no || '—'}</td>
                        <td style={{ padding: '4px 6px', color: t.textMuted }}>{s.stock_available != null ? s.stock_available : '—'}</td>
                        <td style={{ padding: '4px 6px', color: t.textMuted }}>{s.qty != null ? `${s.qty} ${s.unit || 'pcs'}` : '—'}</td>
                        <td style={{
                          padding: '4px 6px',
                          fontWeight: 600,
                          color: s.remaining_qty != null && s.remaining_qty < 0 ? '#ef4444' : t.textMuted,
                        }}>
                          {s.remaining_qty != null ? s.remaining_qty : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    {['Date', 'Shift', 'Station', 'Machine', 'Planned', 'Actual', '%', 'Status', 'Operation'].map((h) => (
                      <th key={h} style={{ padding: '8px', background: t.surface2, color: t.textDim, textAlign: 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.plan_id}>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.run_date}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.shift}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.station_no}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.text }}>{r.machine_name}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.planned_qty}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.actual_qty}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.complete_pct}%</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.status}</td>
                      <td style={{ padding: 8, borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{r.current_operation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {records.length === 0 && (
                <p style={{ color: t.textFaint, textAlign: 'center', padding: 20 }}>No production runs linked yet.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
