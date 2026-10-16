import { useState, useEffect } from 'react';
import api from '../../api/client';

export default function MachineSuggestions({
  t, partId, modelVariant, enabled, onSelectMachine, machines,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || (!partId && !modelVariant)) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    api.get('/api/work-orders/suggest-machines', {
      params: {
        part_id: partId || undefined,
        model_variant: modelVariant || undefined,
        smart: true,
        limit: 5,
      },
    })
      .then((r) => setSuggestions(r.data.suggestions || []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoading(false));
  }, [enabled, partId, modelVariant]);

  if (!enabled) return null;

  return (
    <div style={{
      marginTop: 8, padding: 12, background: t.surface2, borderRadius: 8,
      border: `1px solid ${t.border}`,
    }}>
      <div style={{ color: t.accent, fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
        💡 Suggested Machines {loading && '(loading…)'}
      </div>
      {suggestions.length === 0 && !loading && (
        <div style={{ color: t.textFaint, fontSize: 12 }}>
          No smart suggestions — machine idle or near-completion history not found for this part.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {suggestions.map((s) => {
          const machine = machines?.find((m) => m.id === s.machine_id);
          return (
            <div key={s.machine_id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 10px', background: t.surface, borderRadius: 6, fontSize: 12,
            }}>
              <div>
                <div style={{ color: t.text, fontWeight: 600 }}>{s.machine_name}</div>
                <div style={{ color: t.textMuted, fontSize: 11 }}>{s.reason}</div>
                <div style={{ color: t.textDim, fontSize: 10 }}>
                  Last run: {s.last_run_date || '—'} · Produced: {s.total_qty_produced || 0} pcs
                  {s.current_plan_remaining > 0 ? ` · ${s.current_plan_remaining} left on current job` : ''}
                </div>
              </div>
              {onSelectMachine && machine && (
                <button type="button" onClick={() => onSelectMachine(s.machine_id, machine.station_id)}
                  style={{
                    padding: '4px 10px', background: t.accent, color: '#fff', border: 'none',
                    borderRadius: 4, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap',
                  }}>
                  Use
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
