import { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import WorkOrderGantt from './WorkOrderGantt';

export default function WorkOrderOverview({ t, onViewTrackRecord, selectedId }) {
  const [overview, setOverview] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().split('T')[0];
  });
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/work-orders/overview', {
        params: {
          date_from: dateFrom,
          date_to: dateTo,
          search: search || undefined,
          status: statusFilter || undefined,
        },
      });
      setOverview(r.data);
    } catch {
      setOverview({ items: [], date_from: dateFrom, date_to: dateTo, today: new Date().toISOString().split('T')[0] });
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, search, statusFilter]);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  const toggleExpand = (id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => {
    setExpandedIds(new Set((overview?.items || []).map((i) => i.id)));
  };

  const inp = {
    padding: '6px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13,
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <input style={{ ...inp, minWidth: 220 }} placeholder="Search work order, mold…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select style={inp} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All Status</option>
          <option value="draft">Draft</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
        </select>
        <input style={inp} type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <span style={{ color: t.textDim }}>~</span>
        <input style={inp} type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        <button onClick={fetchOverview} style={{ ...inp, cursor: 'pointer', background: t.accent, color: '#fff', border: 'none' }}>
          ↻ Refresh
        </button>
        <button onClick={expandAll} style={{ ...inp, cursor: 'pointer' }}>All Expand</button>
      </div>

      {loading && <p style={{ color: t.textMuted, fontSize: 13 }}>Loading overview…</p>}

      <WorkOrderGantt
        t={t}
        overview={overview}
        expandedIds={expandedIds}
        onToggleExpand={toggleExpand}
        onViewTrackRecord={onViewTrackRecord}
      />

      {overview?.items?.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {overview.items.map((wo) => (
            <button key={wo.id} type="button" onClick={() => onViewTrackRecord?.(wo.id)}
              style={{
                padding: '6px 12px', borderRadius: 6,
                border: `1px solid ${String(wo.id) === String(selectedId) ? t.accent : t.border}`,
                background: String(wo.id) === String(selectedId) ? t.accent + '22' : t.surface2,
                color: t.accent, cursor: 'pointer', fontSize: 12,
              }}>
              {String(wo.id) === String(selectedId) ? '✕ Close' : '📋 Track'}: {wo.work_order_no}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
