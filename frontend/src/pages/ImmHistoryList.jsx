import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { historySelectStyle, historyChipStyle } from '../components/ImmHistoryTabs';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';

const stripCjk = (v) =>
  String(v ?? '').replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');

export default function ImmHistoryList() {
  const { theme: t } = useTheme();
  const navigate = useNavigate();
  const [tab, setTab] = useState('kpiv');
  const [machines, setMachines] = useState([]);
  const [machineId, setMachineId] = useState('');
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/api/machines/').then((r) => setMachines(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'kpiv') {
        const r = await api.get('/api/imm/history/kpiv', {
          params: {
            machine_id: machineId || undefined,
            tag: tag || undefined,
            limit: 300,
          },
        });
        setRows(r.data || []);
      } else {
        const r = await api.get('/api/imm/history/components', {
          params: {
            machine_id: machineId || undefined,
            q: search || undefined,
          },
        });
        setRows(r.data || []);
      }
    } catch (err) {
      console.error(err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, machineId, tag, search]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const s = {
    page: { padding: 16 },
    bar: {
      display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
      marginBottom: 14, background: t.surface, border: `1px solid ${t.border}`,
      borderRadius: 12, padding: 12,
    },
    tableWrap: {
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, overflow: 'auto',
    },
    th: { padding: '10px 12px', textAlign: 'left', color: t.textDim, background: t.surface2 || t.bg, fontSize: 12, whiteSpace: 'nowrap' },
    td: { padding: '9px 12px', borderTop: `1px solid ${t.border}`, color: t.text, fontSize: 13 },
  };
  const input = historySelectStyle(t);

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader title="IMM History Records" subtitle="KPIV & component records" onRefresh={fetchRows} extra={(
        <button type="button" style={historyChipStyle(t)} onClick={() => navigate('/imm/equipment')}>← Equipment</button>
      )} />

      <div style={s.bar}>
        <button type="button" style={historyChipStyle(t, tab === 'kpiv')} onClick={() => setTab('kpiv')}>
          KPIV Parameter List
        </button>
        <button type="button" style={historyChipStyle(t, tab === 'components')} onClick={() => setTab('components')}>
          Key Component Operations
        </button>
        <select style={input} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
          <option value="">All machines</option>
          {machines.map((m) => <option key={m.id} value={m.id}>{stripCjk(m.name)}</option>)}
        </select>
        {tab === 'kpiv' ? (
          <select style={input} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All KPIV tags</option>
            <option value="injection_end">Injection End Point</option>
            <option value="max_pressure">Max Injection Pressure</option>
            <option value="nozzle_temp">Nozzle Temperature</option>
            <option value="barrel_temp">Barrel 1 Temperature</option>
            <option value="charge_time">Feeding / Charge Time</option>
          </select>
        ) : (
          <input style={input} placeholder="Search component / machine" value={search}
            onChange={(e) => setSearch(e.target.value)} />
        )}
      </div>

      <div style={s.tableWrap}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {tab === 'kpiv'
                ? ['Time', 'Machine', 'KPIV', 'Value', 'Unit'].map((h) => <th key={h} style={s.th}>{h}</th>)
                : ['Machine', 'Component', 'Spec', 'Start', 'Expected days', 'Remaining', 'Active', 'Updated'].map((h) => <th key={h} style={s.th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>No records</td></tr>
            )}
            {!loading && tab === 'kpiv' && rows.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/imm/equipment/${r.machine_id}`)}>
                <td style={s.td}>{(r.recorded_at || '').replace('T', ' ').slice(0, 19)}</td>
                <td style={s.td}>{stripCjk(r.machine_name)}</td>
                <td style={s.td}>{stripCjk(r.label)}</td>
                <td style={{ ...s.td, fontWeight: 700, color: t.accent }}>{r.value}</td>
                <td style={s.td}>{r.unit}</td>
              </tr>
            ))}
            {!loading && tab === 'components' && rows.map((r) => (
              <tr key={`${r.id}-${r.is_active}`} style={{ cursor: 'pointer' }} onClick={() => navigate(`/imm/equipment/${r.machine_id}`)}>
                <td style={s.td}>{stripCjk(r.machine_name)}</td>
                <td style={s.td}>{stripCjk(r.label)}</td>
                <td style={s.td}>{stripCjk(r.spec_display || '—')}</td>
                <td style={s.td}>{r.start_date || '—'}</td>
                <td style={s.td}>{r.expect_days}</td>
                <td style={{ ...s.td, color: '#22d3ee', fontWeight: 700 }}>{r.remaining_label}</td>
                <td style={s.td}>{r.is_active ? 'Yes' : 'History'}</td>
                <td style={s.td}>{(r.updated_at || '').replace('T', ' ').slice(0, 19)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
