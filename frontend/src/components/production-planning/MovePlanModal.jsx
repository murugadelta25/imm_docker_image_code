import { useState, useEffect } from 'react';
import api from '../../api/client';

const todayStr = () => new Date().toISOString().split('T')[0];

function addDaysStr(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export default function MovePlanModal({
  t, plan, enabledShifts, machines = [], stations = [], onClose, onMoved,
}) {
  const [mode, setMode] = useState('next_week');
  const [newDate, setNewDate] = useState(todayStr());
  const [newShift, setNewShift] = useState(plan?.shift || '');
  const [changeMachine, setChangeMachine] = useState(false);
  const [newStationNo, setNewStationNo] = useState(plan?.station_no || '');
  const [newMachineId, setNewMachineId] = useState('');
  const [splitRemaining, setSplitRemaining] = useState(
    () => (plan?.actual_qty > 0 && plan?.actual_qty < plan?.planned_qty),
  );
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setNewShift(plan.shift || '');
    setNewStationNo(plan.station_no || '');
    setNewMachineId(plan.machine_id ? String(plan.machine_id) : '');
  }, [plan]);

  if (!plan) return null;

  const hasPartial = plan.actual_qty > 0 && plan.actual_qty < plan.planned_qty;
  const remaining = plan.planned_qty - plan.actual_qty;
  const minDate = todayStr();
  const nextWeekDate = addDaysStr(plan.plan_date, 7);
  const nextWeekValid = nextWeekDate >= minDate;
  const currentMachine = machines.find((m) => m.id === plan.machine_id);

  const stationMachines = machines.filter(
    (m) => !newStationNo || m.station_id === parseInt(newStationNo, 10),
  );

  const inp = {
    padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13, width: '100%',
  };

  const useMachineOnly = () => {
    setMode('custom');
    setNewDate(plan.plan_date);
    setChangeMachine(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMsg('');
    try {
      const targetDate = mode === 'next_week' ? nextWeekDate : (mode === 'same_date' ? plan.plan_date : newDate);
      if (targetDate < minDate) {
        setMsg(`Cannot move to a past date. Earliest allowed date is ${minDate}.`);
        setSaving(false);
        return;
      }

      const payload = {
        mode: mode === 'next_week' ? 'next_week' : 'custom',
        split_remaining: splitRemaining,
      };
      if (mode === 'custom' || mode === 'same_date') {
        payload.new_date = targetDate;
      }
      if (newShift && newShift !== plan.shift) {
        payload.new_shift = newShift;
      }
      if (changeMachine && newMachineId && String(newMachineId) !== String(plan.machine_id || '')) {
        payload.new_machine_id = parseInt(newMachineId, 10);
        payload.new_station_no = parseInt(newStationNo, 10);
      }

      const r = await api.post(`/api/plans/${plan.id}/reschedule`, payload);
      onMoved?.(r.data);
      onClose();
    } catch (err) {
      setMsg(err.response?.data?.detail || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1002,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: t.surface, borderRadius: 12, padding: 24, width: '100%', maxWidth: 520,
        maxHeight: '90vh', overflow: 'auto', border: `1px solid ${t.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: t.accent, fontSize: 15 }}>Move Plan</h3>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
          <div><strong>{plan.current_operation}</strong> · {plan.plan_date} · Shift {plan.shift}</div>
          <div>
            Planned: {plan.planned_qty} · Actual: {plan.actual_qty} · Status: {plan.status}
          </div>
          <div>
            Machine: <strong>{currentMachine?.name || '—'}</strong>
            {currentMachine?.status === 'breakdown' && (
              <span style={{ color: '#ef4444', marginLeft: 8 }}>⚠ Breakdown — relocate to another machine</span>
            )}
          </div>
          {hasPartial && (
            <div style={{ color: '#f59e0b', marginTop: 4 }}>
              {remaining} pcs not yet produced — can split and move remainder.
            </div>
          )}
        </div>

        <form onSubmit={submit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ color: t.textDim, fontSize: 11 }}>Schedule</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { id: 'next_week', label: `Next week (+7 days → ${nextWeekDate})` },
                { id: 'same_date', label: 'Keep same date' },
                { id: 'custom', label: 'Pick date' },
              ].map((opt) => (
                <button key={opt.id} type="button"
                  disabled={opt.id === 'next_week' && !nextWeekValid}
                  onClick={() => setMode(opt.id)}
                  style={{
                    padding: '8px 12px', borderRadius: 6,
                    cursor: opt.id === 'next_week' && !nextWeekValid ? 'not-allowed' : 'pointer',
                    fontSize: 12,
                    border: `1px solid ${mode === opt.id ? t.accent : t.border}`,
                    background: mode === opt.id ? t.accent : t.surface2,
                    color: mode === opt.id ? '#fff' : t.textMuted,
                    opacity: opt.id === 'next_week' && !nextWeekValid ? 0.5 : 1,
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
            {mode === 'next_week' && !nextWeekValid && (
              <div style={{ fontSize: 11, color: '#ef4444' }}>
                Next week ({nextWeekDate}) is before today — use Pick date and choose {minDate} or later.
              </div>
            )}
            {mode === 'custom' && (
              <input style={inp} type="date" value={newDate} min={minDate}
                onChange={(e) => setNewDate(e.target.value)} required />
            )}
            <div style={{ fontSize: 11, color: t.textFaint }}>Moves to dates before today are not allowed.</div>

            <label style={{ color: t.textDim, fontSize: 11 }}>Shift</label>
            <select style={inp} value={newShift} onChange={(e) => setNewShift(e.target.value)}>
              {enabledShifts.map((sh) => (
                <option key={sh.id} value={sh.id}>{sh.name} ({sh.start}–{sh.end})</option>
              ))}
            </select>

            <div style={{ marginTop: 4, padding: 12, background: t.surface2, borderRadius: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ color: t.accent, fontSize: 12, fontWeight: 600 }}>
                  Alternate machine
                </label>
                <button type="button" onClick={useMachineOnly}
                  style={{ background: 'none', border: 'none', color: t.accent, cursor: 'pointer', fontSize: 11 }}>
                  Machine only →
                </button>
              </div>
              <p style={{ margin: '0 0 8px', fontSize: 11, color: t.textDim }}>
                Use when the assigned machine has a breakdown — e.g. move from CN40 to CN25 on the same or a new date.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.textMuted, cursor: 'pointer', marginBottom: 8 }}>
                <input type="checkbox" checked={changeMachine}
                  onChange={(e) => setChangeMachine(e.target.checked)} />
                Transfer to a different machine
              </label>
              {changeMachine && (
                <>
                  <label style={{ color: t.textDim, fontSize: 11, display: 'block', marginBottom: 4 }}>Station</label>
                  <select style={{ ...inp, marginBottom: 8 }} value={newStationNo}
                    onChange={(e) => {
                      setNewStationNo(e.target.value);
                      setNewMachineId('');
                    }}>
                    {stations.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.display_name || st.name || `Station ${st.id}`}
                      </option>
                    ))}
                  </select>
                  <label style={{ color: t.textDim, fontSize: 11, display: 'block', marginBottom: 4 }}>Machine</label>
                  <select style={inp} value={newMachineId} required={changeMachine}
                    onChange={(e) => setNewMachineId(e.target.value)}>
                    <option value="">— Select machine —</option>
                    {stationMachines.map((m) => (
                      <option key={m.id} value={m.id} disabled={m.status === 'breakdown'}>
                        {m.name}{m.status === 'breakdown' ? ' (breakdown)' : ''}{m.id === plan.machine_id ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {hasPartial && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.textMuted, cursor: 'pointer' }}>
                <input type="checkbox" checked={splitRemaining} onChange={(e) => setSplitRemaining(e.target.checked)} />
                Split: keep {plan.actual_qty} pcs on {plan.plan_date}, move {remaining} pcs to new schedule
              </label>
            )}
          </div>

          {msg && <p style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>{msg}</p>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" onClick={onClose}
              style={{ padding: '8px 16px', background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer', color: t.text }}>
              Cancel
            </button>
            <button type="submit"
              disabled={saving || (mode === 'next_week' && !nextWeekValid) || (changeMachine && !newMachineId)}
              style={{ padding: '8px 20px', background: t.brand, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              {saving ? 'Moving…' : 'Move Plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
