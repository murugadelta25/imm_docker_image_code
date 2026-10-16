import { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../api/useWebSocket';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { formatDateTime } from '../utils/dateFormat';

const STATUS_CFG = {
  raised:       { color: '#ef4444', label: 'Raised',        icon: '🔴', next: 'Acknowledge' },
  acknowledged: { color: '#3b82f6', label: 'Acknowledged',  icon: '🔵', next: 'Start Troubleshoot' },
  in_progress:  { color: '#f59e0b', label: 'In Progress',   icon: '🟡', next: 'Resolve' },
  resolved:     { color: '#10b981', label: 'Resolved',      icon: '🟢', next: null },
};

const MACHINE_STATUS = {
  idle:           { color: '#f5de0b', label: 'Idle' },
  running:        { color: '#10b981', label: 'Running' },
  breakdown:      { color: '#ef4444', label: 'Breakdown' },
  setting_change: { color: '#2482da', label: 'Setting Change' },
  alarm:          { color: '#f472b6', label: 'Alarm' },
  offline:        { color: '#6b7280', label: 'Offline' },
};

export default function MaintenanceDashboard() {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const [machines, setMachines] = useState([]);
  const [stations, setStations] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [resolveForm, setResolveForm] = useState({ id: null, notes: '', serviced_by: '' });
  const [ackForm, setAckForm] = useState({ id: null, serviced_by: '' });
  const [filter, setFilter] = useState('active');

  const fetchData = useCallback(async () => {
    const [p, m, tk] = await Promise.all([api.get('/api/stations/'), api.get('/api/breakdown/machines'), api.get('/api/breakdown/')]);
    setStations(p.data);
    setMachines(m.data);
    setTickets(tk.data);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useWebSocket(useCallback(msg => {
    if (['breakdown_raised','breakdown_acknowledged','breakdown_in_progress','breakdown_resolved'].includes(msg.type))
      fetchData();
    if (msg.type === 'machine_status_updated')
      setMachines(prev => prev.map(m => m.id === msg.id ? { ...m, status: msg.status } : m));
    if (msg.type === 'machine_updated')
      fetchData();
  }, [fetchData]));

  const acknowledge = async id => {
    if (!ackForm.serviced_by.trim()) return alert('Please enter technician ID before acknowledging');
    await api.patch(`/api/breakdown/${id}/acknowledge`);
    setAckForm({ id: null, serviced_by: '' });
    fetchData();
  };
  const startWork   = async id => { await api.patch(`/api/breakdown/${id}/start`); fetchData(); };
  const resolve     = async id => {
    if (!resolveForm.notes.trim()) return alert('Please enter resolution notes');
    if (!resolveForm.serviced_by.trim()) return alert('Please enter Serviced By ID');
    await api.patch(`/api/breakdown/${id}/resolve`, {
      resolution_notes: `[Serviced by: ${resolveForm.serviced_by}] ${resolveForm.notes}`
    });
    setResolveForm({ id: null, notes: '', serviced_by: '' });
    fetchData();
  };
  const beginAcknowledge = (id) => setAckForm({ id, serviced_by: '' });

  const elapsed = (from) => {
    if (!from) return '—';
    const mins = Math.floor((Date.now() - new Date(from).getTime()) / 60000);
    return mins < 60 ? `${mins}m` : `${Math.floor(mins/60)}h ${mins%60}m`;
  };

  const formatDate = value => formatDateTime(value);

  const formatDuration = (from, to) => {
    const f = formatDateTime(from) === '—' ? null : new Date(from);
    const end = to ? new Date(to) : new Date();
    let mins = Math.floor((end.getTime() - f.getTime()) / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins/60)}h ${mins%60}m`;
  };

  const downloadExcel = () => {
    if (!tickets.length) return;
    const rows = tickets.map(tk => ({
      'Ticket #': tk.id,
      Machine: machines.find(m => m.id === tk.machine_id)?.name || tk.machine_id,
      Status: STATUS_CFG[tk.status]?.label || tk.status,
      'Raised By': tk.raised_by_name || tk.raised_by || '',
      'Acknowledged By': tk.acknowledged_by_name || tk.acknowledged_by || '',
      Description: tk.description,
      'Serviced By': tk.resolution_notes?.match(/\[Serviced by: ([^\]]+)\]/)?.[1] || '',
      'Resolution Notes': tk.resolution_notes?.replace(/\[Serviced by: [^\]]+\]\s*/, '') || '',
      'Raised At': tk.created_at ? formatDate(tk.created_at) : '',
      'Acknowledged At': tk.ack_time ? formatDate(tk.ack_time) : '',
      'Work Started At': tk.start_troubleshoot ? formatDate(tk.start_troubleshoot) : '',
      'Resolved At': tk.resolved_time ? formatDate(tk.resolved_time) : '',
      'Service Duration (ack→resolved)': (tk.ack_time && tk.resolved_time) ? formatDuration(tk.ack_time, tk.resolved_time) : '',
      'Issue Duration (raised→resolved)': (tk.created_at && tk.resolved_time) ? formatDuration(tk.created_at, tk.resolved_time) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Maintenance Tickets');
    XLSX.writeFile(wb, `maintenance_report_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const filtered = tickets.filter(tk =>
    filter === 'all' ? true : filter === 'active' ? tk.status !== 'resolved' : tk.status === 'resolved'
  );

  const counts = {
    raised:       tickets.filter(tk => tk.status === 'raised').length,
    acknowledged: tickets.filter(tk => tk.status === 'acknowledged').length,
    in_progress:  tickets.filter(tk => tk.status === 'in_progress').length,
    resolved:     tickets.filter(tk => tk.status === 'resolved').length,
  };

  const inp = { padding: '8px 12px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
                background: t.inp, color: t.text, fontSize: 13 };
  const card = { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 };
  const fBtn = (active) => ({
    padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
    border: `1px solid ${active ? '#0ea5e9' : t.border}`,
    background: active ? '#0ea5e9' : t.surface,
    color: active ? '#fff' : t.textMuted,
  });

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text, transition: 'background 0.2s, color 0.2s' }}>
      <PageHeader
        title="🛠 MAINTENANCE DASHBOARD"
        onRefresh={fetchData}
        extra={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {['active','resolved','all'].map(f => (
                <button key={f} style={fBtn(filter === f)} onClick={() => setFilter(f)}>
                  {f.charAt(0).toUpperCase()+f.slice(1)}
                </button>
              ))}
            </div>
            <button style={{ padding: '6px 16px', background: '#10b981', color: '#fff', border: 'none',
                             borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              onClick={downloadExcel}>⬇ Download Excel</button>
          </div>
        }
      />

      {/* Summary Counters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {Object.entries(STATUS_CFG).map(([k, v]) => (
          <div key={k} style={{ ...card, marginBottom: 0, textAlign: 'center', borderTop: `3px solid ${v.color}` }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: v.color }}>{counts[k]}</div>
            <div style={{ color: t.textMuted, fontSize: 12 }}>{v.icon} {v.label}</div>
          </div>
        ))}
      </div>

      {/* Machine Layout */}
      <div style={card}>
        <h4 style={{ color: t.accent, margin: '0 0 16px', fontSize: 14, fontWeight: 600 }}>Machine Status Layout</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
          {machines.map(m => {
            const activeTickets = tickets.filter(tk => tk.machine_id === m.id && tk.status !== 'resolved');
            const mst = MACHINE_STATUS[m.status] || MACHINE_STATUS.idle;
            const isRunning = m.status === 'running';
            const station = stations.find(s => s.id === m.station_id);
            const stationLabel = station ? (station.display_name || station.name || `Station ${station.id}`) : `Station ${m.station_id || '—'}`;
            return (
              <div key={m.id} style={{ background: t.surface2, borderRadius: 10, padding: 14,
                                       border: `2px solid ${mst.color}`, textAlign: 'center',
                                       transition: 'border-color 0.3s' }}>
                <div style={{ position: 'relative', width: 80, height: 80, margin: '0 auto 10px' }}>
                  {isRunning && (
                    <div style={{ position: 'absolute', inset: -4, borderRadius: '50%',
                                  border: `3px solid ${mst.color}`,
                                  animation: 'pulse-ring 1.8s ease-out infinite', opacity: 0.6 }} />
                  )}
                  <div style={{ width: 80, height: 80, borderRadius: 10, overflow: 'hidden',
                                border: `3px solid ${mst.color}`, background: t.surface,
                                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {m.image_url
                      ? <img src={assetUrl(m.image_url)} alt={m.name}
                             style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      : <span style={{ fontSize: 32 }}>🏭</span>}
                  </div>
                  <div style={{ position: 'absolute', bottom: 2, right: 2, width: 14, height: 14,
                                borderRadius: '50%', background: mst.color,
                                border: `2px solid ${t.surface2}` }} />
                  {activeTickets.length > 0 && (
                    <span style={{ position: 'absolute', top: -4, right: -4, background: '#ef4444',
                                   color: '#fff', borderRadius: '50%', width: 18, height: 18,
                                   fontSize: 11, display: 'flex', alignItems: 'center',
                                   justifyContent: 'center', fontWeight: 700 }}>
                      {activeTickets.length}
                    </span>
                  )}
                </div>
                <div style={{ color: t.text, fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{m.name}</div>
                <div style={{ color: t.textFaint, fontSize: 11, marginBottom: 4 }}>{stationLabel}</div>
                {m.operator_name ? (
                  <div style={{ color: t.accent, fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                    Op: {m.operator_name}
                    {m.operator_code && m.operator_code !== m.operator_name
                      ? ` (${m.operator_code})`
                      : ''}
                  </div>
                ) : (
                  <div style={{ color: t.textFaint, fontSize: 10, marginBottom: 4, fontStyle: 'italic' }}>No operator</div>
                )}
                {m.machine_type && (
                  <div style={{ color: t.textFaint, fontSize: 11, marginBottom: 4 }}>
                    {m.machine_type}{m.make ? ` · ${m.make}` : ''}
                  </div>
                )}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px',
                              borderRadius: 10, background: mst.color + '22', marginBottom: 6 }}>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', background: mst.color }} />
                  <span style={{ color: mst.color, fontSize: 11, fontWeight: 700 }}>{mst.label}</span>
                </div>
                {isRunning && !m.has_plan && (
                  <div style={{ fontSize: 10, color: '#f59e0b', background: '#f59e0b22', border: '1px solid #f59e0b55',
                                borderRadius: 6, padding: '2px 8px', marginBottom: 4 }}>⚠ No Plan Assigned</div>
                )}
                {activeTickets.map(tk => (
                  <div key={tk.id} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, marginTop: 4,
                                            color: t.text, border: `1px solid ${STATUS_CFG[tk.status]?.color}`,
                                            background: STATUS_CFG[tk.status]?.color + '22' }}>
                    {STATUS_CFG[tk.status]?.icon} #{tk.id} {tk.status}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Tickets */}
      <div style={card}>
        <h4 style={{ color: t.accent, margin: '0 0 16px', fontSize: 14, fontWeight: 600 }}>Tickets ({filtered.length})</h4>
        {filtered.length === 0 && <p style={{ color: t.textFaint }}>No tickets in this view.</p>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {filtered.map(tk => {
            const cfg = STATUS_CFG[tk.status];
            const machine = machines.find(m => m.id === tk.machine_id);
            const machineName = machine?.name || `Machine ${tk.machine_id}`;
            const station = stations.find(s => s.id === machine?.station_id);
            const stationLabel = station ? (station.display_name || station.name || `Station ${station.id}`) : `Station ${machine?.station_id || '—'}`;
            const servicedBy = tk.resolution_notes?.match(/\[Serviced by: ([^\]]+)\]/)?.[1] || '';
            const cleanNotes = tk.resolution_notes?.replace(/\[Serviced by: [^\]]+\]\s*/, '') || '';
            return (
              <div key={tk.id} style={{ background: t.surface2, borderRadius: 8, padding: 14,
                                        borderLeft: `4px solid ${cfg?.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ color: t.text, fontWeight: 700 }}>{cfg?.icon} Ticket #{tk.id}</span>
                  <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, color: '#fff',
                                 fontWeight: 600, background: cfg?.color }}>{cfg?.label}</span>
                </div>
                <div style={{ color: t.accent, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>🏭 {machineName}</div>
                <div style={{ color: t.textFaint, fontSize: 11, marginBottom: 4 }}>{stationLabel}</div>
                {tk.raised_by && (
                  <div style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>
                    👤 Raised by: <b>{tk.raised_by_name || tk.raised_by}</b>
                  </div>
                )}
                <div style={{ color: t.textMuted, fontSize: 13, marginBottom: 8 }}>{tk.description}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, color: t.textFaint, fontSize: 11, marginBottom: 8 }}>
                  <span>🕐 Raised: {tk.created_at ? formatDate(tk.created_at) : '—'}</span>
                  {tk.ack_time && <span>✅ Ack: {formatDate(tk.ack_time)}</span>}
                  {tk.start_troubleshoot && (
                    tk.resolved_time ? (
                      <span>🔧 Service Duration: <b style={{ color: '#f59e0b' }}>{formatDuration(tk.ack_time, tk.resolved_time)}</b></span>
                    ) : (
                      <span>🔧 Working for: <b style={{ color: '#f59e0b' }}>{formatDuration(tk.start_troubleshoot)}</b></span>
                    )
                  )}
                  {tk.resolved_time && (
                    <>
                      <span>🟢 Resolved: {formatDate(tk.resolved_time)}</span>
                      <span>⏱ Issue Duration: <b style={{ color: '#10b981' }}>{formatDuration(tk.created_at, tk.resolved_time)}</b></span>
                    </>
                  )}
                </div>
                {servicedBy && (
                  <div style={{ background: t.bg, border: `1px solid ${t.border}`, borderRadius: 6,
                                padding: '4px 10px', color: '#0ea5e9', fontSize: 12, marginBottom: 6 }}>
                    🔧 Serviced by: <b>{servicedBy}</b>
                  </div>
                )}
                {cleanNotes && (
                  <div style={{ background: t.bg, border: `1px solid #10b98133`, borderRadius: 6,
                                padding: '6px 10px', color: '#10b981', fontSize: 12, marginBottom: 8 }}>
                    📋 {cleanNotes}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {tk.status === 'raised' && (
                    ackForm.id === tk.id ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input style={{ ...inp, minWidth: 160 }} placeholder="Technician ID"
                          value={ackForm.serviced_by}
                          onChange={e => setAckForm(f => ({ ...f, serviced_by: e.target.value }))} />
                        <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                         cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#10b981' }}
                          onClick={() => acknowledge(tk.id)}>Confirm</button>
                        <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                         cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#475569' }}
                          onClick={() => setAckForm({ id: null, serviced_by: '' })}>Cancel</button>
                      </div>
                    ) : (
                      <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                       cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#3b82f6' }}
                        onClick={() => beginAcknowledge(tk.id)}>🔵 Acknowledge</button>
                    )
                  )}
                  {tk.status === 'acknowledged' && (
                    <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                     cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#f59e0b' }}
                      onClick={() => startWork(tk.id)}>🟡 Start Troubleshoot</button>
                  )}
                  {tk.status === 'in_progress' && (
                    resolveForm.id === tk.id ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
                        <input style={{ ...inp, width: '100%', boxSizing: 'border-box' }}
                          placeholder="Serviced By ID *"
                          value={resolveForm.serviced_by}
                          onChange={e => setResolveForm(p => ({ ...p, serviced_by: e.target.value }))} />
                        <textarea style={{ ...inp, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                          rows={2} placeholder="Describe what was fixed..."
                          value={resolveForm.notes}
                          onChange={e => setResolveForm(p => ({ ...p, notes: e.target.value }))} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                           cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#10b981', flex: 1 }}
                            onClick={() => resolve(tk.id)}>🟢 Submit & Close</button>
                          <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                           cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#475569' }}
                            onClick={() => setResolveForm({ id: null, notes: '', serviced_by: '' })}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button style={{ padding: '7px 14px', border: 'none', borderRadius: 6, color: '#fff',
                                       cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#10b981' }}
                        onClick={() => setResolveForm({ id: tk.id, notes: '', serviced_by: '' })}>
                        🟢 Resolve Ticket
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
