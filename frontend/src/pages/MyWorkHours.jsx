import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import PageHeader from '../components/PageHeader';

function mondayIso(d = new Date()) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

function apiErrorMessage(e) {
  const d = e?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((x) => (typeof x === 'string' ? x : (x?.msg || JSON.stringify(x)))).join('; ');
  }
  if (d && typeof d === 'object') return d.msg || d.message || JSON.stringify(d);
  return e?.message || 'Request failed';
}

function fmtPunch(iso, missing) {
  if (missing) return 'missing';
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

/** Flatten day → one row per shift segment (cross-shift A/C splits). */
function flattenDayRows(days) {
  const rows = [];
  for (const day of days || []) {
    const sums = Array.isArray(day.shift_summaries) && day.shift_summaries.length
      ? day.shift_summaries
      : [day];
    for (const s of sums) {
      const complete = !!(s.complete && s.punch_in && s.punch_out && !s.in_missing && !s.out_missing);
      rows.push({
        key: `${day.date}-${s.shift_id || s.shift_span || 'x'}-${s.punch_in || ''}`,
        date: day.date,
        weekday: day.weekday,
        roster: day.roster,
        allocations: day.allocations,
        punches: day.punches,
        shift_id: s.shift_id || s.shift_span || day.shift_id,
        punch_in: s.in_missing ? null : s.punch_in,
        punch_out: s.out_missing ? null : s.punch_out,
        in_missing: !!s.in_missing,
        out_missing: !!s.out_missing,
        complete,
        worked_mins: complete ? Number(s.worked_mins || 0) : 0,
      });
    }
  }
  return rows;
}

function segmentWorkedMins(row) {
  return row?.complete ? Number(row.worked_mins || 0) : 0;
}

export default function MyWorkHours() {
  const { theme: t } = useTheme();
  const { user } = useAuth();
  const [weekStart, setWeekStart] = useState(mondayIso());
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api.get('/api/operators/me/work-hours', { params: { week_start: weekStart } });
      setData(r.data);
      setMsg('');
    } catch (e) {
      setMsg(apiErrorMessage(e));
    }
  }, [weekStart]);

  useEffect(() => { load(); }, [load]);

  const shiftWeek = (delta) => {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(d.toISOString().slice(0, 10));
  };

  const photo = data?.user?.reference_photo_url ? assetUrl(data.user.reference_photo_url) : null;

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader title="MY WORK HOURS" onRefresh={load} />
      {msg && <div style={{ color: '#ef4444', marginBottom: 12 }}>{msg}</div>}
      {data?.message && !msg && (
        <div style={{ color: '#f59e0b', marginBottom: 12, fontSize: 13 }}>{data.message}</div>
      )}

      <div style={{ background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {photo ? (
          <img src={photo} alt="" style={{ width: 64, height: 64, borderRadius: 32, objectFit: 'cover', background: t.surface2 }} />
        ) : (
          <div style={{
            width: 64, height: 64, borderRadius: 32, background: (t.accent || '#0ea5e9') + '33',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 24, color: t.accent,
          }}>
            {(user?.username || '?')[0].toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{data?.user?.username || user?.username}</div>
          <div style={{ color: t.textMuted, fontSize: 13 }}>
            Role: {data?.user?.role || user?.role}
            {data?.user?.has_reference_photo ? ' · Master photo on file' : ' · No master photo'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: t.textDim, fontSize: 11, fontWeight: 600 }}>WEEK TOTAL</div>
          <div style={{ color: t.accent, fontSize: 28, fontWeight: 800 }}>
            {data?.total_worked_hrs != null
              ? `${data.total_worked_hrs} h`
              : data?.days
                ? `${(flattenDayRows(data.days).reduce((s, r) => s + segmentWorkedMins(r), 0) / 60).toFixed(2)} h`
                : '—'}
          </div>
        </div>
      </div>

      <div style={{ background: t.surface, borderRadius: 10, padding: 20 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
          <button type="button" onClick={() => shiftWeek(-1)} style={btn(t)}>← Prev week</button>
          <input
            type="date"
            value={weekStart}
            onChange={(e) => setWeekStart(mondayIso(e.target.value))}
            style={{
              padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
              background: t.inp, color: t.text, fontSize: 13,
            }}
          />
          <button type="button" onClick={() => shiftWeek(1)} style={btn(t)}>Next week →</button>
          <button type="button" onClick={() => setWeekStart(mondayIso())} style={btn(t)}>This week</button>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Day', 'Date', 'Shift', 'Roster', 'Machine', 'Punch in', 'Punch out', 'Worked'].map((h) => (
                  <th key={h} style={{ padding: 10, background: t.surface2, color: t.textDim, textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flattenDayRows(data?.days).map((row) => {
                const alloc = row.allocations?.[0];
                const rost = row.roster?.map((r) => `${r.shift_id}:${r.status}`).join(', ') || '—';
                const worked = segmentWorkedMins(row);
                const inLabel = fmtPunch(row.punch_in, row.in_missing);
                const outLabel = fmtPunch(row.punch_out, row.out_missing);
                const missingStyle = { color: '#f59e0b', fontWeight: 700 };
                return (
                  <tr key={row.key}>
                    <td style={td(t)}>{row.weekday}</td>
                    <td style={td(t)}>{row.date}</td>
                    <td style={td(t)}>{row.shift_id || '—'}</td>
                    <td style={td(t)}>{rost}</td>
                    <td style={td(t)}>{alloc?.machine_name || row.punches?.[0]?.machine_name || '—'}</td>
                    <td style={{ ...td(t), ...(row.in_missing ? missingStyle : {}) }}>{inLabel}</td>
                    <td style={{ ...td(t), ...(row.out_missing ? missingStyle : {}) }}>{outLabel}</td>
                    <td style={{ ...td(t), fontWeight: 700, color: t.accent }}>
                      {row.complete && worked > 0 ? `${(worked / 60).toFixed(1)} h` : '0 h'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function btn(t) {
  return {
    padding: '8px 14px', background: 'transparent', color: t.accent,
    border: `1px solid ${t.accent}`, borderRadius: 8, cursor: 'pointer', fontSize: 13,
  };
}

function td(t) {
  return { padding: '10px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' };
}
