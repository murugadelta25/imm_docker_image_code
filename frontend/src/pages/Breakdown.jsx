import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../api/useWebSocket';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { DRAFT_KEYS } from '../utils/formPersistence';
import usePersistedState from '../hooks/usePersistedState';

const STATUS_CONFIG = {
  raised:       { color: '#ef4444', label: 'Raised',       icon: '🔴' },
  acknowledged: { color: '#3b82f6', label: 'Acknowledged', icon: '🔵' },
  in_progress:  { color: '#f59e0b', label: 'In Progress',  icon: '🟡' },
  resolved:     { color: '#10b981', label: 'Resolved',     icon: '🟢' },
};

const MACHINE_STATUS = {
  idle:           { color: '#f5de0b', label: 'Idle' },
  running:        { color: '#10b981', label: 'Running' },
  breakdown:      { color: '#ef4444', label: 'Breakdown' },
  setting_change: { color: '#2482da', label: 'Setting Change' },
  alarm:          { color: '#f472b6', label: 'Alarm' },
  offline:        { color: '#6b7280', label: 'Offline' },
};

const STATUS_STYLE = {
  running:        { color: '#10b981', bg: '#10b98115', label: 'Running' },
  idle:           { color: '#f59e0b', bg: '#f59e0b22', label: 'Idle' },
  'ld/unld':      { color: '#06b6d4', bg: '#06b6d422', label: 'Ld/UnLd' },
  breakdown:      { color: '#ef4444', bg: '#ef444422', label: 'Breakdown' },
  setting_change: { color: '#3b82f6', bg: '#3b82f615', label: 'Setting Change' },
  alarm:          { color: '#f472b6', bg: '#f472b615', label: 'Alarm' },
  offline:        { color: '#6b7280', bg: '#6b728015', label: 'Offline' },
};

const PLANNED_REASONS = [
  'Machine Preventive', 'Meeting', 'RM Change', 'Plant Shutdown', 'No Plan',
  'Mould Change', 'Colour Change', 'Insert Change', 'Mould Trial', 'Power Fail',
];

const UNPLANNED_REASONS = [
  'Machine Maintenance', 'No RM', 'Chiller Maintenance', 'Compressor Maintenance',
  'Mould Maintenance', 'QC Issue', 'No Manpower', 'Hopper Issue', 'Crane Issue',
  'No BOP', 'Machine Breakdown', 'Mould Polish', 'Mould Breakdown', 'RM Predrying',
  'Hrs Problem', 'Barrel Heating Problem', 'No Packing Material', 'Water Leakage',
  'Oil Leakage',
];

function effectiveStatus(status, durationMs) {
  if (status === 'idle' && durationMs < 60000) return 'ld/unld';
  return status;
}

function parseIST(str) {
  if (!str) return null;
  return new Date(str.replace(' IST', '').replace(' ', 'T'));
}

const pad = n => String(n).padStart(2, '0');

function fmtIST(str) {
  if (!str) return '—';
  const d = parseIST(str);
  if (!d || isNaN(d)) return '—';
  return `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} IST`;
}

function durationLabel(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function ReasonButton({ label, selected, onClick, accent, mutedBorder, surface, text }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        width: '100%',
        padding: 0,
        borderRadius: 8,
        border: `1.5px solid ${selected ? accent : mutedBorder}`,
        background: selected ? accent + '18' : surface,
        cursor: 'pointer',
        overflow: 'hidden',
        textAlign: 'left',
      }}
    >
      <div style={{
        height: 5,
        background: selected ? '#22c55e' : '#ef4444',
        opacity: selected ? 1 : 0.85,
      }} />
      <div style={{
        padding: '10px 12px',
        color: selected ? accent : text,
        fontSize: 12,
        fontWeight: selected ? 700 : 600,
        lineHeight: 1.3,
      }}>
        {label}
      </div>
    </button>
  );
}

function DowntimeModal({ machine, users, user, theme: t, onClose, onSubmit, busy, msg }) {
  const [downtimeType, setDowntimeType] = useState(null);
  const [reason, setReason] = useState('');
  const [raisedMode, setRaisedMode] = useState(
    user && ['operator', 'supervisor'].includes(user.role) ? 'select' : 'select'
  );
  const [raisedBy, setRaisedBy] = useState(
    user && ['operator', 'supervisor'].includes(user.role) ? String(user.id) : ''
  );
  const [raisedByName, setRaisedByName] = useState(user?.username || '');
  const [notes, setNotes] = useState('');

  const selectReason = (type, value) => {
    setDowntimeType(type);
    setReason(value);
  };

  const canSubmit = reason && downtimeType && (
    (raisedMode === 'select' && raisedBy) ||
    (raisedMode === 'enter' && raisedByName.trim())
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit || busy) return;
    onSubmit({
      machine_id: machine.id,
      downtime_type: downtimeType,
      downtime_reason: reason,
      raised_by: raisedMode === 'select' ? parseInt(raisedBy, 10) : (user?.id || null),
      raised_by_name: raisedMode === 'enter' ? raisedByName.trim() : null,
      description: notes.trim() || undefined,
    });
  };

  const inp = {
    padding: '8px 12px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13, width: '100%',
  };

  const unplannedLeft = UNPLANNED_REASONS.slice(0, 10);
  const unplannedRight = UNPLANNED_REASONS.slice(10);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Log downtime"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(960px, 100%)',
          maxHeight: '92vh',
          overflow: 'auto',
          background: t.surface,
          borderRadius: 12,
          border: `1px solid ${t.border}`,
          boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 18px', borderBottom: `1px solid ${t.border}`,
          background: t.surface2, position: 'sticky', top: 0, zIndex: 1,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: t.text }}>Downtime</div>
            <div style={{ fontSize: 12, color: t.accent, marginTop: 2 }}>
              {machine.name}
              {machine.machine_type ? ` · ${machine.machine_type}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none', border: `1px solid ${t.border}`, borderRadius: 6,
              color: t.textMuted, cursor: 'pointer', padding: '4px 10px', fontSize: 13,
            }}
          >
            ✕ Close
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: 18 }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 16,
          }}>
            {/* Planned */}
            <section style={{
              background: t.surface2, borderRadius: 10, padding: 14,
              border: `1px solid ${t.border}`,
            }}>
              <h4 style={{
                margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#2482da',
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>
                Planned Downtime
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {PLANNED_REASONS.map(r => (
                  <ReasonButton
                    key={r}
                    label={r}
                    selected={downtimeType === 'planned' && reason === r}
                    onClick={() => selectReason('planned', r)}
                    accent="#2482da"
                    mutedBorder={t.border}
                    surface={t.surface}
                    text={t.text}
                  />
                ))}
              </div>
            </section>

            {/* Unplanned */}
            <section style={{
              background: t.surface2, borderRadius: 10, padding: 14,
              border: `1px solid ${t.border}`,
            }}>
              <h4 style={{
                margin: '0 0 12px', fontSize: 13, fontWeight: 700, color: '#ef4444',
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>
                Unplanned Downtime
              </h4>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 8,
                alignItems: 'start',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {unplannedLeft.map(r => (
                    <ReasonButton
                      key={r}
                      label={r}
                      selected={downtimeType === 'unplanned' && reason === r}
                      onClick={() => selectReason('unplanned', r)}
                      accent="#ef4444"
                      mutedBorder={t.border}
                      surface={t.surface}
                      text={t.text}
                    />
                  ))}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {unplannedRight.map(r => (
                    <ReasonButton
                      key={r}
                      label={r}
                      selected={downtimeType === 'unplanned' && reason === r}
                      onClick={() => selectReason('unplanned', r)}
                      accent="#ef4444"
                      mutedBorder={t.border}
                      surface={t.surface}
                      text={t.text}
                    />
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* Selected summary */}
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: 8,
            background: reason ? (downtimeType === 'planned' ? '#2482da18' : '#ef444418') : t.surface2,
            border: `1px solid ${reason ? (downtimeType === 'planned' ? '#2482da55' : '#ef444455') : t.border}`,
            fontSize: 13, color: t.text,
          }}>
            {reason
              ? <>Selected: <b>{downtimeType === 'planned' ? 'Planned' : 'Unplanned'}</b> — {reason}</>
              : 'Select a downtime reason above'}
          </div>

          {/* Raised by */}
          <div style={{
            marginTop: 16, padding: 14, borderRadius: 10,
            border: `1px solid ${t.border}`, background: t.surface2,
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 10, flexWrap: 'wrap', gap: 8,
            }}>
              <h4 style={{ margin: 0, fontSize: 13, color: t.accent }}>Raised By</h4>
              <div style={{ display: 'flex', gap: 6 }}>
                {[
                  ['select', 'Select user'],
                  ['enter', 'Enter name'],
                ].map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRaisedMode(mode)}
                    style={{
                      padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                      border: `1px solid ${raisedMode === mode ? t.accent : t.border}`,
                      background: raisedMode === mode ? t.accent + '22' : t.surface,
                      color: raisedMode === mode ? t.accent : t.textMuted,
                      fontWeight: raisedMode === mode ? 700 : 500,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {raisedMode === 'select' ? (
              <select
                style={inp}
                value={raisedBy}
                onChange={e => setRaisedBy(e.target.value)}
                required
              >
                <option value="">Select raised by…</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.username} ({u.role})</option>
                ))}
              </select>
            ) : (
              <input
                style={inp}
                placeholder="Enter name of person raising the downtime"
                value={raisedByName}
                onChange={e => setRaisedByName(e.target.value)}
                required
              />
            )}

            <input
              style={{ ...inp, marginTop: 10 }}
              placeholder="Optional notes…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          <div style={{
            display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
            gap: 10, marginTop: 16, flexWrap: 'wrap',
          }}>
            {msg && (
              <span style={{
                color: msg.startsWith('✓') ? '#10b981' : '#ef4444',
                fontSize: 13, marginRight: 'auto',
              }}>
                {msg}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                border: `1px solid ${t.border}`, background: t.surface, color: t.textMuted,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || busy}
              style={{
                padding: '8px 20px', borderRadius: 6, cursor: canSubmit && !busy ? 'pointer' : 'not-allowed',
                border: 'none', fontWeight: 700, fontSize: 13, color: '#fff',
                background: canSubmit && !busy
                  ? (downtimeType === 'planned' ? '#2482da' : '#ef4444')
                  : t.border,
                opacity: canSubmit && !busy ? 1 : 0.7,
              }}
            >
              {busy ? 'Logging…' : 'Log Downtime'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Breakdown() {
  const { user } = useAuth();
  const { theme: t } = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkHandled = useRef(false);
  const [tab, setTab] = useState('breakdown');
  const [machines, setMachines] = useState([]);
  const [stations, setStations] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [users, setUsers] = useState([]);
  const [form, setForm] = usePersistedState(DRAFT_KEYS.breakdown, {
    station_id: '', machine_id: '', raised_by: '', description: '',
  });
  const [msg, setMsg] = useState('');
  const [modalMsg, setModalMsg] = useState('');
  const [statusLog, setStatusLog] = useState([]);
  const [logMachineId, setLogMachineId] = useState('');
  const [logFilter, setLogFilter] = useState('');
  const [selectedMachine, setSelectedMachine] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    const [p, m, tk, us] = await Promise.all([
      api.get('/api/stations/'),
      api.get('/api/breakdown/machines'),
      api.get('/api/breakdown/'),
      api.get('/api/breakdown/users')
    ]);
    setStations(p.data);
    setMachines(m.data);
    setTickets(tk.data);
    setUsers(us.data);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (user && ['operator', 'supervisor'].includes(user.role))
      setForm(f => ({ ...f, raised_by: String(user.id) }));
  }, [user, setForm]);

  // Deep-link from Zone Dashboard: /breakdown?machineId=…
  useEffect(() => {
    const mid = parseInt(searchParams.get('machineId') || searchParams.get('machine_id') || '', 10);
    if (!mid) {
      deepLinkHandled.current = false;
      return;
    }
    if (deepLinkHandled.current || !machines.length) return;
    const m = machines.find((x) => x.id === mid);
    if (!m) return;
    deepLinkHandled.current = true;
    setTab('breakdown');
    const active = tickets.filter((tk) => tk.machine_id === mid && tk.status !== 'resolved');
    if (active.length > 0) {
      setMsg(`✗ ${m.name} already has an active downtime ticket (#${active[0].id})`);
    } else if (user?.role === 'operator' || user?.role === 'admin' || user?.role === 'supervisor') {
      setModalMsg('');
      setSelectedMachine(m);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('machineId');
    next.delete('machine_id');
    setSearchParams(next, { replace: true });
  }, [machines, tickets, searchParams, setSearchParams, user]);

  useWebSocket(useCallback(msg => {
    if (['breakdown_raised','breakdown_acknowledged','breakdown_in_progress','breakdown_resolved'].includes(msg.type))
      fetchData();
    if (msg.type === 'machine_status_updated')
      setMachines(prev => prev.map(m => m.id === msg.id ? { ...m, status: msg.status } : m));
    if (msg.type === 'machine_updated')
      fetchData();
  }, [fetchData]));

  const fetchStatusLog = useCallback(async (machineId) => {
    if (!machineId) return;
    const r = await api.get(`/api/machines/${machineId}/status-log`);
    setStatusLog(r.data);
  }, []);

  useEffect(() => {
    if (tab === 'log' && logMachineId) fetchStatusLog(logMachineId);
  }, [tab, logMachineId, fetchStatusLog]);

  const machineTickets = (machineId) => tickets.filter(t => t.machine_id === machineId && t.status !== 'resolved');

  const openDowntimeModal = (machine) => {
    if (!(user?.role === 'operator' || user?.role === 'admin' || user?.role === 'supervisor')) return;
    const active = machineTickets(machine.id);
    if (active.length > 0) {
      setMsg(`✗ ${machine.name} already has an active downtime ticket (#${active[0].id})`);
      return;
    }
    setModalMsg('');
    setSelectedMachine(machine);
  };

  const logDowntime = async (payload) => {
    setSubmitting(true);
    setModalMsg('');
    try {
      await api.post('/api/breakdown/', payload);
      setModalMsg('✓ Downtime logged');
      setMsg(`✓ Downtime logged for ${selectedMachine?.name || 'machine'}`);
      setTimeout(() => {
        setSelectedMachine(null);
        setModalMsg('');
      }, 600);
      fetchData();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setModalMsg(`✗ ${typeof detail === 'string' ? detail : 'Error logging downtime'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const raiseTicket = async e => {
    e.preventDefault();
    try {
      await api.post('/api/breakdown/', {
        machine_id: parseInt(form.machine_id, 10),
        raised_by: parseInt(form.raised_by, 10),
        description: form.description,
        downtime_type: 'unplanned',
        downtime_reason: 'Machine Breakdown',
      });
      setMsg('✓ Ticket raised');
      setForm({
        station_id: stations[0]?.id || '',
        machine_id: '',
        raised_by: String(user?.id || ''),
        description: '',
      });
      fetchData();
    } catch { setMsg('✗ Error raising ticket'); }
  };

  const filteredMachines = form.station_id ? machines.filter(m => m.station_id === parseInt(form.station_id, 10)) : machines;

  const formatDate = value => {
    if (!value) return '—';
    const d = new Date(String(value).replace(' IST','').replace(' ','T'));
    if (isNaN(d)) return '—';
    const p = n => String(n).padStart(2,'0');
    return `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const raisedByLabel = (tk) =>
    tk.raised_by_name || tk.raised_by_username || tk.raised_by || '';

  const downloadExcel = () => {
    if (!tickets.length) return;
    const rows = tickets.map(tk => ({
      'Ticket #': tk.id,
      'Raised By': raisedByLabel(tk),
      'Acknowledged By': tk.acknowledged_by_username || tk.acknowledged_by || '',
      Machine: machines.find(m => m.id === tk.machine_id)?.name || tk.machine_id,
      Type: tk.downtime_type || '',
      Reason: tk.downtime_reason || '',
      Status: tk.status, Description: tk.description,
      'Resolution Notes': tk.resolution_notes || '',
      'Raised At': tk.created_at ? formatDate(tk.created_at) : '',
      'Acknowledged At': tk.ack_time ? formatDate(tk.ack_time) : '',
      'Work Started At': tk.start_troubleshoot ? formatDate(tk.start_troubleshoot) : '',
      'Resolved At': tk.resolved_time ? formatDate(tk.resolved_time) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Breakdown Tickets');
    XLSX.writeFile(wb, `breakdown_report_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const inp = { padding: '8px 12px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
                background: t.inp, color: t.text, fontSize: 13 };
  const card = { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 };
  const tabBtn = (key) => ({
    padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
    borderBottom: tab === key ? `3px solid ${t.accent}` : '3px solid transparent',
    color: tab === key ? t.accent : t.textMuted, fontWeight: tab === key ? 600 : 400,
  });

  const canLog = user?.role === 'operator' || user?.role === 'admin' || user?.role === 'supervisor';

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader title="BREAKDOWN MANAGEMENT" onRefresh={fetchData}
        extra={<button style={{ padding: '6px 16px', background: t.brand, color: '#fff', border: 'none',
                                borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                 onClick={downloadExcel}>⬇ Download Excel</button>} />

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: `2px solid ${t.border}` }}>
        <button style={tabBtn('breakdown')} onClick={() => setTab('breakdown')}>🔴 Breakdown</button>
        <button style={tabBtn('log')} onClick={() => {
          setTab('log');
          if (machines.length && !logMachineId) setLogMachineId(String(machines[0].id));
        }}>📋 Status Log</button>
      </div>

      {tab === 'breakdown' && (<>
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <h4 style={{ color: t.accent, margin: 0, fontSize: 14 }}>Machine Status Layout</h4>
            {canLog && (
              <span style={{ fontSize: 12, color: t.textMuted }}>
                Click a machine to log planned / unplanned downtime
              </span>
            )}
          </div>
          {msg && (
            <div style={{
              marginBottom: 12, fontSize: 13,
              color: msg.startsWith('✓') ? '#10b981' : '#ef4444',
            }}>
              {msg}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
            {machines.map(m => {
              const activeTickets = machineTickets(m.id);
              const mStatus = MACHINE_STATUS[m.status] || MACHINE_STATUS.idle;
              const isRunning = m.status === 'running';
              const station = stations.find(s => s.id === m.station_id);
              const stationLabel = station ? (station.display_name || station.name || `Station ${station.id}`) : `Station ${m.station_id || '—'}`;
              return (
                <div
                  key={m.id}
                  onClick={() => openDowntimeModal(m)}
                  title={canLog ? (activeTickets.length ? 'Active downtime ticket exists' : 'Click to log downtime') : undefined}
                  style={{
                    background: t.surface2, borderRadius: 10, padding: 14,
                    border: `2px solid ${mStatus.color}`, textAlign: 'center',
                    position: 'relative', transition: 'border-color 0.3s, transform 0.15s',
                    cursor: canLog ? 'pointer' : 'default',
                  }}
                  onMouseEnter={e => { if (canLog) e.currentTarget.style.transform = 'translateY(-2px)'; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  <div style={{ position: 'relative', width: 80, height: 80, margin: '0 auto 10px' }}>
                    {isRunning && (
                      <div style={{ position: 'absolute', inset: -4, borderRadius: '50%',
                                    border: `3px solid ${mStatus.color}`,
                                    animation: 'pulse-ring 1.8s ease-out infinite', opacity: 0.6 }} />
                    )}
                    <div style={{ width: 80, height: 80, borderRadius: 10, overflow: 'hidden',
                                  border: `3px solid ${mStatus.color}`, background: t.surface,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {m.image_url
                        ? <img src={assetUrl(m.image_url)} alt={m.name}
                               style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        : <span style={{ fontSize: 32 }}>🏭</span>}
                    </div>
                    <div style={{ position: 'absolute', bottom: 2, right: 2, width: 14, height: 14,
                                  borderRadius: '50%', background: mStatus.color,
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
                    <div style={{ color: t.textFaint, fontSize: 11, marginBottom: 4 }}>{m.machine_type}{m.make ? ` · ${m.make}` : ''}</div>
                  )}
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 10px',
                                borderRadius: 10, background: mStatus.color + '22', marginBottom: 6 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: mStatus.color }} />
                    <span style={{ color: mStatus.color, fontSize: 11, fontWeight: 700 }}>{mStatus.label}</span>
                  </div>
                  {isRunning && !m.has_plan && (
                    <div style={{ fontSize: 10, color: '#f59e0b', background: '#f59e0b22', border: '1px solid #f59e0b55',
                                  borderRadius: 6, padding: '2px 8px', marginBottom: 4 }}>⚠ No Plan Assigned</div>
                  )}
                  {m.plc_source && m.plc_source !== 'manual' && (
                    <div style={{ color: t.textFaint, fontSize: 10, marginBottom: 4 }}>📡 {m.plc_source.toUpperCase()}</div>
                  )}
                  {canLog && activeTickets.length === 0 && (
                    <div style={{
                      marginTop: 6, fontSize: 11, fontWeight: 600, color: t.accent,
                      background: t.accent + '15', borderRadius: 6, padding: '4px 8px',
                    }}>
                      + Log Downtime
                    </div>
                  )}
                  {activeTickets.map(tk => (
                    <div key={tk.id} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, marginTop: 4,
                                              color: t.text, border: `1px solid ${STATUS_CONFIG[tk.status]?.color}`,
                                              background: STATUS_CONFIG[tk.status]?.color + '22' }}>
                      {STATUS_CONFIG[tk.status]?.icon} #{tk.id} {tk.downtime_reason || tk.status}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {canLog && (
          <div style={card}>
            <h4 style={{ color: t.accent, margin: '0 0 8px', fontSize: 14 }}>Quick Raise (legacy)</h4>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: t.textMuted }}>
              Prefer clicking a machine above to pick a planned/unplanned reason. This form raises a generic unplanned Machine Breakdown ticket.
            </p>
            <form onSubmit={raiseTicket} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select style={inp} value={form.station_id}
                onChange={e => setForm(p => ({ ...p, station_id: e.target.value, machine_id: '' }))} required>
                <option value="">Select Station</option>
                {stations.map(station => (
                  <option key={station.id} value={station.id}>{station.display_name || station.name || `Station ${station.id}`}</option>
                ))}
              </select>
              <select style={inp} value={form.machine_id}
                onChange={e => setForm(p => ({ ...p, machine_id: e.target.value }))}
                required disabled={!form.station_id || filteredMachines.length === 0}>
                <option value="">Select Machine</option>
                {filteredMachines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <select style={{ ...inp, width: 160 }} value={form.raised_by}
                onChange={e => setForm(p => ({ ...p, raised_by: e.target.value }))} required>
                <option value="">Raised by</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.username} ({u.role})</option>)}
              </select>
              <input style={{ ...inp, flex: 1, minWidth: 200 }} placeholder="Describe the breakdown..."
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} required />
              <button style={{ padding: '8px 20px', background: '#ef4444', color: '#fff', border: 'none',
                               borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13 }} type="submit">
                Raise Ticket
              </button>
            </form>
          </div>
        )}

        <div style={card}>
          <h4 style={{ color: t.accent, margin: '0 0 16px', fontSize: 14 }}>All Tickets</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {tickets.map(tk => {
              const cfg = STATUS_CONFIG[tk.status];
              const typeColor = tk.downtime_type === 'planned' ? '#2482da' : '#ef4444';
              return (
                <div key={tk.id} style={{ background: t.surface2, borderRadius: 8, padding: 14,
                                          borderLeft: `4px solid ${cfg?.color}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ color: t.text, fontWeight: 600 }}>{cfg?.icon} Ticket #{tk.id}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, color: '#fff',
                                   fontWeight: 600, background: cfg?.color }}>{tk.status}</span>
                  </div>
                  <div style={{ color: t.accent, fontSize: 13, marginBottom: 4 }}>
                    Machine: {machines.find(m => m.id === tk.machine_id)?.name || tk.machine_id}
                  </div>
                  {(tk.downtime_type || tk.downtime_reason) && (
                    <div style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontSize: 11, fontWeight: 700, marginBottom: 6,
                      padding: '2px 8px', borderRadius: 8,
                      color: typeColor, background: typeColor + '18',
                      border: `1px solid ${typeColor}44`,
                    }}>
                      {(tk.downtime_type || 'unplanned').toUpperCase()}
                      {tk.downtime_reason ? ` · ${tk.downtime_reason}` : ''}
                    </div>
                  )}
                  {raisedByLabel(tk) && (
                    <div style={{ color: t.textMuted, fontSize: 12, marginBottom: 4 }}>
                      👤 Raised by: <b>{raisedByLabel(tk)}</b>
                    </div>
                  )}
                  <div style={{ color: t.textMuted, fontSize: 13, marginBottom: 8 }}>{tk.description}</div>
                  {tk.resolution_notes && (
                    <div style={{ color: '#10b981', fontSize: 12, marginBottom: 8 }}>Resolution: {tk.resolution_notes}</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, color: t.textFaint, fontSize: 11 }}>
                    {tk.created_at && <span>Raised: {formatDate(tk.created_at)}</span>}
                    {tk.ack_time && <span>Ack: {formatDate(tk.ack_time)}</span>}
                    {tk.start_troubleshoot && <span>Started: {formatDate(tk.start_troubleshoot)}</span>}
                    {tk.resolved_time && <span>Resolved: {formatDate(tk.resolved_time)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </>)}

      {tab === 'log' && (() => {
        const IDLE_LIMIT_MS      = 1   * 60 * 1000;
        const BREAKDOWN_LIMIT_MS = 90  * 60 * 1000;
        const ALARM_LIMIT_MS     = 30  * 60 * 1000;
        const OFFLINE_LIMIT_MS   = 30  * 60 * 1000;
        const SC_LIMIT_MS        = 120 * 60 * 1000;

        const limitFor = s => ({
          idle: IDLE_LIMIT_MS, breakdown: BREAKDOWN_LIMIT_MS,
          alarm: ALARM_LIMIT_MS, offline: OFFLINE_LIMIT_MS,
          setting_change: SC_LIMIT_MS,
        }[s] ?? null);

        const rows = statusLog.map((log, i) => {
          const from = new Date(log.changed_at);
          const to   = i === 0 ? new Date() : new Date(statusLog[i - 1].changed_at);
          const durationMs = to.getTime() - from.getTime();
          const effStatus = effectiveStatus(log.status, durationMs);
          const limit = limitFor(log.status);
          const breached = limit !== null && durationMs > limit;
          return { ...log, durationMs, effStatus, breached, isOngoing: i === 0 };
        });

        const breachCounts = {};
        rows.forEach(r => { if (r.breached) breachCounts[r.status] = (breachCounts[r.status] || 0) + 1; });

        const displayRows = logFilter
          ? [...rows]
              .filter(r => r.status === logFilter)
              .sort((a, b) => b.durationMs - a.durationMs)
          : rows;

        const summaryStatuses = ['idle','breakdown','alarm','offline','setting_change'];
        const maxDurationMs = Math.max(...displayRows.map(r => r.durationMs), 1);

        const td = { padding: '10px', borderBottom: `1px solid ${t.border}` };
        const thStyle = { padding: '10px', background: t.surface2, color: t.textDim,
                          textAlign: 'left', whiteSpace: 'nowrap' };

        return (
          <div style={card}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
              <h4 style={{ color: t.accent, margin: 0, fontSize: 14 }}>Machine Status Log</h4>
              <select style={{ ...inp, width: 200 }} value={logMachineId}
                onChange={e => { setLogMachineId(e.target.value); setLogFilter(''); fetchStatusLog(e.target.value); }}>
                <option value="">Select Machine</option>
                {machines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <button style={{ padding: '6px 14px', background: t.accent, color: '#fff', border: 'none',
                               borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                onClick={() => fetchStatusLog(logMachineId)}>↻ Refresh</button>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 8 }}>
                {summaryStatuses.map(s => {
                  const st  = STATUS_STYLE[s];
                  const cnt = machines.filter(m => m.status === s).length;
                  const bc  = breachCounts[s] || 0;
                  const active = logFilter === s;
                  return (
                    <button key={s} onClick={() => setLogFilter(active ? '' : s)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '5px 10px', borderRadius: 8, fontSize: 12,
                        background: active ? st.color + '33' : cnt > 0 ? st.bg : t.surface2,
                        border: `1.5px solid ${active ? st.color : cnt > 0 ? st.color + '66' : t.border}`,
                        opacity: cnt > 0 ? 1 : 0.4,
                        cursor: 'pointer', outline: 'none',
                      }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                      <span style={{ color: active ? st.color : cnt > 0 ? st.color : t.textFaint, fontWeight: 600 }}>{st.label}</span>
                      <span style={{ background: cnt > 0 ? st.color : t.border, color: '#fff',
                                     borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 700,
                                     minWidth: 18, textAlign: 'center' }}>{cnt}</span>
                      {bc > 0 && (
                        <span title={`${bc} record(s) exceeded limit`}
                          style={{ background: '#ef4444', color: '#fff', borderRadius: 10,
                                   padding: '0 5px', fontSize: 10, fontWeight: 700 }}>⚠{bc}</span>
                      )}
                    </button>
                  );
                })}
                {logFilter && (
                  <button onClick={() => setLogFilter('')}
                    style={{ padding: '5px 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                             background: t.surface2, border: `1px solid ${t.border}`, color: t.textMuted }}>
                    ✕ Clear filter
                  </button>
                )}
              </div>
            </div>

            {statusLog.length === 0 ? (
              <div style={{ color: t.textFaint, textAlign: 'center', padding: 32, fontSize: 13 }}>
                {logMachineId ? 'No status changes recorded yet.' : 'Select a machine to view its status log.'}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {['#', 'Status', 'Changed At (IST)', 'Duration', 'Bar', 'Source'].map(h => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((log, i) => {
                      const st = STATUS_STYLE[log.effStatus] || STATUS_STYLE[log.status] || { color: t.textMuted, bg: 'transparent', label: log.status };
                      const rowBg   = log.breached ? '#ef444418' : (['idle','ld/unld','breakdown','alarm','offline','setting_change'].includes(log.effStatus) ? st.bg : 'transparent');
                      const durColor = log.breached ? '#ef4444' : (log.isOngoing ? t.accent : (['idle','ld/unld','breakdown','alarm','offline','setting_change'].includes(log.effStatus) ? st.color : t.textMuted));
                      return (
                        <tr key={`${log.id}-${i}`} style={{
                          background: rowBg,
                          borderLeft: log.breached ? '3px solid #ef4444' : '3px solid transparent',
                        }}>
                          <td style={{ ...td, color: t.textFaint, fontSize: 11 }}>{statusLog.length - statusLog.findIndex(l => l.id === log.id)}</td>
                          <td style={td}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                                             padding: '3px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                                             background: st.bg, color: st.color,
                                             border: `1px solid ${st.color}44` }}>
                                <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                                {st.label}
                              </span>
                              {log.breached && (
                                <span style={{ fontSize: 10, background: '#ef4444', color: '#fff',
                                               borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>EXCEEDED</span>
                              )}
                            </div>
                          </td>
                          <td style={{ ...td, fontVariantNumeric: 'tabular-nums', fontSize: 12, color: t.text }}>
                            {fmtIST(log.changed_at)}
                          </td>
                          <td style={{ ...td, fontWeight: log.breached ? 700 : 400, color: durColor, fontSize: 12 }}>
                            {log.isOngoing
                              ? <>{durationLabel(log.durationMs)} <span style={{ fontSize: 10, color: t.accent }}>(ongoing)</span></>
                              : durationLabel(log.durationMs)}
                            {log.breached && limitFor(log.status) && (
                              <div style={{ fontSize: 10, color: '#ef4444', marginTop: 2 }}>
                                limit: {durationLabel(limitFor(log.status))}
                              </div>
                            )}
                          </td>
                          <td style={{ ...td, minWidth: 120 }}>
                            {(() => {
                              const pct = Math.min((log.durationMs / maxDurationMs) * 100, 100);
                              const barColor = log.breached ? '#ef4444' : st.color;
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <div style={{ flex: 1, height: 8, background: t.surface2, borderRadius: 4, overflow: 'hidden', minWidth: 80 }}>
                                    <div style={{ width: `${pct}%`, height: '100%', background: barColor,
                                                  borderRadius: 4, transition: 'width 0.3s' }} />
                                  </div>
                                  <span style={{ fontSize: 10, color: t.textFaint, minWidth: 32, textAlign: 'right' }}>
                                    {Math.round(pct)}%
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                          <td style={{ ...td, color: t.textFaint, fontSize: 11 }}>{log.source}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {selectedMachine && (
        <DowntimeModal
          machine={selectedMachine}
          users={users}
          user={user}
          theme={t}
          busy={submitting}
          msg={modalMsg}
          onClose={() => { setSelectedMachine(null); setModalMsg(''); }}
          onSubmit={logDowntime}
        />
      )}
    </div>
  );
}
