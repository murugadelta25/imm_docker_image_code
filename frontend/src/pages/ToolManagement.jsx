import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { pageClass, surfaceClass } from '../themes/tileHelpers';

const EMPTY_FORM = {
  tool_code: '',
  tool_name: '',
  unit: 'pcs',
  stock_qty: '0',
  min_stock: '0',
  sap_material_no: '',
  stock_source: 'manual',
  life_cycles_limit: '',
  cycles_used: '0',
  life_warning_pct: '90',
  cycles_per_part: '1',
  qr_code: '',
  notes: '',
  part_no: '',
  standard_cavity: '1',
  running_cavity: '1',
  customer_name: '',
  rm_grade: '',
  standard_cycle_time: '',
  std_shot_weight: '',
  std_part_weight: '',
  std_runner_weight: '',
  colour: '',
  target_per_shift: '',
  cavities: [{ id: 'c1', name: '', enabled: true, part_no: '' }],
};

function newCavityId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const EMPTY_SAP = {
  sap_material_no: '',
  tool_code: '',
  tool_name: '',
  stock_qty: '',
  unit: 'pcs',
};

const STATUS_STYLE = {
  ok: { color: '#10b981', label: 'OK' },
  near_eol: { color: '#f59e0b', label: 'Near EOL' },
  eol: { color: '#ef4444', label: 'End of Life' },
  correction_ack: { color: '#8b5cf6', label: 'Correction Ack' },
  blocked: { color: '#ef4444', label: 'Blocked' },
};

export default function ToolManagement() {
  const { theme: t } = useTheme();
  const { user } = useAuth();
  const canEdit = ['admin', 'superadmin', 'supervisor'].includes(user?.role);
  const canDelete = ['admin', 'superadmin'].includes(user?.role);

  const [tab, setTab] = useState('inventory');
  const [tools, setTools] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [nearEolOnly, setNearEolOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [showSap, setShowSap] = useState(false);
  const [sapRows, setSapRows] = useState([{ ...EMPTY_SAP }]);
  const [sapBusy, setSapBusy] = useState(false);
  const [historyTool, setHistoryTool] = useState(null);
  const [historyEvents, setHistoryEvents] = useState([]);
  const [qrPreview, setQrPreview] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const inp = {
    padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
    background: t.inp, color: t.text, fontSize: 13,
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [toolsRes, alertsRes] = await Promise.all([
        api.get('/api/tools/', {
          params: {
            search: search || undefined,
            low_stock_only: lowOnly || undefined,
            near_eol_only: nearEolOnly || undefined,
            active_only: true,
            limit: 1000,
          },
        }),
        api.get('/api/tools/alerts', { params: { include_suppressed: false, include_acked: false } }),
      ]);
      setTools(toolsRes.data || []);
      setAlerts(alertsRes.data || []);
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    } finally {
      setLoading(false);
    }
  }, [search, lowOnly, nearEolOnly]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (row) => {
    setEditingId(row.id);
    const cavities = Array.isArray(row.cavities) && row.cavities.length
      ? row.cavities.map((c, i) => ({
        id: c.id || `c${i + 1}`,
        name: c.name || '',
        enabled: !!c.enabled,
        part_no: c.part_no || '',
      }))
      : [{ id: 'c1', name: '', enabled: true, part_no: '' }];
    setForm({
      tool_code: row.tool_code || '',
      tool_name: row.tool_name || '',
      unit: row.unit || 'pcs',
      stock_qty: String(row.stock_qty ?? 0),
      min_stock: String(row.min_stock ?? 0),
      sap_material_no: row.sap_material_no || '',
      stock_source: row.stock_source || 'manual',
      life_cycles_limit: row.life_cycles_limit != null ? String(row.life_cycles_limit) : '',
      cycles_used: String(row.cycles_used ?? 0),
      life_warning_pct: String(row.life_warning_pct ?? 90),
      cycles_per_part: String(row.cycles_per_part ?? 1),
      qr_code: row.qr_code || '',
      notes: row.notes || '',
      part_no: row.part_no || '',
      standard_cavity: row.standard_cavity != null ? String(row.standard_cavity) : '1',
      running_cavity: row.running_cavity != null ? String(row.running_cavity) : '1',
      customer_name: row.customer_name || '',
      rm_grade: row.rm_grade || '',
      standard_cycle_time: row.standard_cycle_time != null ? String(row.standard_cycle_time) : '',
      std_shot_weight: row.std_shot_weight != null ? String(row.std_shot_weight) : '',
      std_part_weight: row.std_part_weight != null ? String(row.std_part_weight) : '',
      std_runner_weight: row.std_runner_weight != null ? String(row.std_runner_weight) : '',
      colour: row.colour || '',
      target_per_shift: row.target_per_shift != null ? String(row.target_per_shift) : '',
      cavities,
    });
    setShowForm(true);
  };

  const setCavityActive = (cavityId) => {
    setForm((p) => ({
      ...p,
      cavities: (p.cavities || []).map((c) => ({
        ...c,
        enabled: c.id === cavityId,
      })),
    }));
  };

  const saveTool = async (e) => {
    e.preventDefault();
    if (!form.tool_code.trim() || !form.tool_name.trim()) {
      setMsg('❌ Mold code and Mold name are required');
      return;
    }
    const requiredImm = [
      ['part_no', 'Part No.'],
      ['customer_name', 'Customer Name'],
      ['rm_grade', 'RM Grade'],
      ['colour', 'Colour'],
      ['standard_cavity', 'Standard Cavity'],
      ['running_cavity', 'Running Cavity'],
      ['standard_cycle_time', 'Standard Cycle Time'],
      ['std_shot_weight', 'Std. Shot Weight'],
      ['std_part_weight', 'Std. Part Weight'],
      ['std_runner_weight', 'Std. Runner Weight'],
      ['target_per_shift', 'Target / Shift'],
    ];
    for (const [key, label] of requiredImm) {
      if (form[key] === '' || form[key] == null) {
        setMsg(`❌ ${label} is required`);
        return;
      }
    }
    const toolCode = form.tool_code.trim();
    const cavities = (form.cavities || [])
      .map((c, i) => ({
        id: c.id || `c${i + 1}`,
        name: (c.name || '').trim(),
        enabled: !!c.enabled,
        part_no: (c.part_no || '').trim() || null,
      }))
      .filter((c) => c.name);
    if (!cavities.length) {
      setMsg('❌ At least one Cavity Name is required (e.g. Base, Cover)');
      return;
    }
    if (!cavities.some((c) => c.enabled)) {
      cavities[0].enabled = true;
    }
    const payload = {
      tool_name: form.tool_name.trim(),
      unit: form.unit || 'pcs',
      stock_qty: parseFloat(form.stock_qty) || 0,
      min_stock: parseFloat(form.min_stock) || 0,
      sap_material_no: form.sap_material_no.trim() || null,
      stock_source: form.stock_source || 'manual',
      life_cycles_limit: form.life_cycles_limit === '' ? null : parseInt(form.life_cycles_limit, 10),
      cycles_used: parseFloat(form.cycles_used) || 0,
      life_warning_pct: parseInt(form.life_warning_pct, 10) || 90,
      cycles_per_part: parseFloat(form.cycles_per_part) || 1,
      qr_code: form.qr_code.trim() || toolCode || null,
      notes: form.notes || null,
      part_no: form.part_no.trim() || null,
      standard_cavity: numOrNull(form.standard_cavity),
      running_cavity: numOrNull(form.running_cavity),
      customer_name: form.customer_name.trim() || null,
      rm_grade: form.rm_grade.trim() || null,
      standard_cycle_time: numOrNull(form.standard_cycle_time),
      std_shot_weight: numOrNull(form.std_shot_weight),
      std_part_weight: numOrNull(form.std_part_weight),
      std_runner_weight: numOrNull(form.std_runner_weight),
      colour: form.colour.trim() || null,
      target_per_shift: numOrNull(form.target_per_shift),
      cavities,
    };
    try {
      if (editingId) {
        await api.put(`/api/tools/${editingId}`, payload);
        setMsg('✅ Mold updated');
      } else {
        await api.post('/api/tools/', { ...payload, tool_code: toolCode });
        setMsg('✅ Mold created — QR generated from mold code');
      }
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      load();
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const removeTool = async (id) => {
    if (!window.confirm('Deactivate this mold from inventory?')) return;
    try {
      await api.delete(`/api/tools/${id}`);
      setMsg('✅ Mold deactivated');
      load();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const openHistory = async (row) => {
    try {
      const { data } = await api.get(`/api/tools/${row.id}/history`);
      setHistoryTool(data.tool);
      setHistoryEvents(data.events || []);
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const doCorrection = async (id) => {
    if (!window.confirm('Acknowledge tool correction? (QR scan suppressed for now)')) return;
    try {
      const { data } = await api.post(`/api/tools/${id}/correction`, {
        notes: 'Correction acknowledged from Mold Management',
      });
      setMsg(`✅ ${data.message}`);
      load();
      if (historyTool?.id === id) openHistory({ id });
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const doReplace = async (id) => {
    if (!window.confirm('Replace tool and reset life cycles? Consumes 1 from stock. (QR suppressed)')) return;
    try {
      const { data } = await api.post(`/api/tools/${id}/replace`, {
        notes: 'Replaced from Mold Management',
        consume_stock: true,
      });
      setMsg(`✅ ${data.message}`);
      load();
      if (historyTool?.id === id) openHistory({ id });
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const suppressAlert = async (id) => {
    try {
      await api.post(`/api/tools/alerts/${id}/suppress`);
      setMsg('✅ Alert suppressed');
      load();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const ackAlert = async (id) => {
    try {
      await api.post(`/api/tools/alerts/${id}/acknowledge`);
      setMsg('✅ Alert acknowledged');
      load();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const downloadReport = async () => {
    setDownloading(true);
    try {
      const r = await api.get('/api/tools/download-report', { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tool_management_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg('✅ Tool report downloaded');
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg('❌ Download failed: ' + (err.response?.data?.detail || err.message));
    } finally {
      setDownloading(false);
    }
  };

  const runSapSync = async (dryRun) => {
    const items = sapRows
      .map((r) => ({
        sap_material_no: r.sap_material_no.trim(),
        tool_code: r.tool_code.trim() || undefined,
        tool_name: r.tool_name.trim() || undefined,
        stock_qty: parseFloat(r.stock_qty),
        unit: r.unit || 'pcs',
      }))
      .filter((r) => r.sap_material_no && !Number.isNaN(r.stock_qty));
    if (!items.length) {
      setMsg('❌ Add at least one SAP material with stock qty');
      return;
    }
    setSapBusy(true);
    try {
      const { data } = await api.post('/api/tools/sync-sap', { items, dry_run: dryRun, create_missing: true });
      setMsg(`✅ ${data.message} — updated ${data.updated_count}, created ${data.created_count}`);
      if (!dryRun) {
        setShowSap(false);
        setSapRows([{ ...EMPTY_SAP }]);
        load();
      }
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    } finally {
      setSapBusy(false);
    }
  };

  const th = {
    textAlign: 'left', padding: '8px 10px', fontSize: 11, color: t.textDim,
    borderBottom: `1px solid ${t.border}`, whiteSpace: 'nowrap',
  };
  const td = { padding: '8px 10px', fontSize: 13, borderBottom: `1px solid ${t.border}` };

  const lowCount = tools.filter((x) => x.below_min).length;
  const eolCount = tools.filter((x) => ['near_eol', 'eol', 'blocked', 'correction_ack'].includes(x.tool_status)).length;

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader
        title="MOLD MANAGEMENT"
        onRefresh={load}
        extra={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={downloadReport} disabled={downloading}
              style={{
                padding: '8px 14px', background: t.brand, color: '#fff', border: 'none',
                borderRadius: 8, cursor: downloading ? 'wait' : 'pointer', fontWeight: 600,
                opacity: downloading ? 0.75 : 1,
              }}
              title="Download inventory, alerts, and consumption Excel">
              {downloading ? 'Downloading…' : '⬇ Download Report'}
            </button>
            {canEdit && (
              <>
                <button type="button" onClick={() => setShowSap(true)}
                  style={{ padding: '8px 14px', background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                  Sync from SAP
                </button>
                <button type="button" onClick={openCreate}
                  style={{ padding: '8px 14px', background: t.accent, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                  + Add Mold
                </button>
              </>
            )}
          </div>
        }
      />

      {msg && (
        <p style={{ color: msg.startsWith('❌') ? '#ef4444' : t.brand, fontSize: 13, marginBottom: 12 }}>{msg}</p>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatCard t={t} label="Molds" value={tools.length} />
        <StatCard t={t} label="Below Min" value={lowCount} alert={lowCount > 0} />
        <StatCard t={t} label="Life Watch" value={eolCount} alert={eolCount > 0} />
        <StatCard t={t} label="Open Alerts" value={alerts.length} alert={alerts.length > 0} />
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          { id: 'inventory', label: 'Inventory & Life' },
          { id: 'alerts', label: `Alerts (${alerts.length})` },
          { id: 'monitor', label: 'Monitoring Help' },
        ].map((x) => (
          <button key={x.id} type="button" onClick={() => setTab(x.id)}
            style={{
              padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
              border: `1px solid ${t.border}`,
              background: tab === x.id ? t.accent : t.surface2,
              color: tab === x.id ? '#fff' : t.text,
            }}>
            {x.label}
          </button>
        ))}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        marginBottom: 12, padding: '8px 12px', borderRadius: 8,
        background: t.surface, border: `1px solid ${t.border}`, fontSize: 12,
      }}>
        <span style={{ color: t.textDim, fontWeight: 600 }}>Status:</span>
        <LegendStep color={STATUS_STYLE.ok.color} label="OK" />
        <span style={{ color: t.textDim }}>→</span>
        <LegendStep color={STATUS_STYLE.near_eol.color} label="Near EOL" />
        <span style={{ color: t.textDim }}>→</span>
        <LegendStep color={STATUS_STYLE.eol.color} label="EOL" />
        <span style={{ color: t.textDim }}>/</span>
        <LegendStep color={STATUS_STYLE.blocked.color} label="Blocked" />
        <span style={{ color: t.textDim }}>(or</span>
        <LegendStep color={STATUS_STYLE.correction_ack.color} label="Correction Ack" />
        <span style={{ color: t.textDim }}>)</span>
      </div>

      {tab === 'alerts' && (
        <div className={surfaceClass(t)} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 12, color: t.textDim, marginTop: 0 }}>
            Low stock and near/end-of-life raise header-bell notifications. Use Acknowledge to clear, or Suppress to hide from the bell.
          </p>
          {!alerts.length && <div style={{ color: t.textDim, fontSize: 13 }}>No open alerts.</div>}
          {alerts.map((a) => (
            <div key={a.id} style={{
              display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
              padding: '10px 0', borderBottom: `1px solid ${t.border}`,
            }}>
              <div>
                <div style={{ fontWeight: 600, color: a.severity === 'alert' ? '#ef4444' : '#f59e0b' }}>
                  {a.tool_code} · {a.alert_type}
                </div>
                <div style={{ fontSize: 12, color: t.textMuted }}>{a.message}</div>
              </div>
              {canEdit && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" onClick={() => ackAlert(a.id)}
                    style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2, color: t.text, cursor: 'pointer' }}>
                    Acknowledge
                  </button>
                  <button type="button" onClick={() => suppressAlert(a.id)}
                    style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2, color: t.textDim, cursor: 'pointer' }}>
                    Suppress
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'monitor' && (
        <div className={surfaceClass(t)} style={{ background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 16, fontSize: 13, color: t.textMuted, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, color: t.accent, marginBottom: 8 }}>How mold monitoring works</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Set <strong>Life cycles limit</strong> (e.g. 50000 / 100000) and IMM fields (Part No., cavities, shot/part/runner weights, target/shift).</li>
            <li>Add multiple <strong>Cavity Names</strong> (e.g. Base, Cover) and enable only the one in use — remaining production logs against that cavity/part.</li>
            <li>Production actual qty on a work-order plan adds cycles to mapped molds and records cavity + location.</li>
            <li>Each IMM shot also increments Mold Monitoring <strong>Uses</strong> and this mold&apos;s life (History shows event type <strong>shot</strong>).</li>
            <li>Below min stock or near EOL → alert in this page + header notification (can suppress).</li>
            <li>At EOL the mold is blocked for planning until <strong>Correction</strong> (temp continue) or <strong>Replace</strong> (reset life, consume 1 stock).</li>
            <li><strong>Download Report</strong> exports Excel (inventory / alerts / consumption).</li>
            <li>Auto schedule: Alerts → Email → group report types → enable <strong>Mold Management</strong>, then add a schedule.</li>
          </ul>
        </div>
      )}

      {tab === 'inventory' && (
        <div className={surfaceClass(t)} style={{
          background: t.surface, border: `1px solid ${t.border}`, borderRadius: 12, padding: 16, marginBottom: 16,
        }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <input style={{ ...inp, minWidth: 220 }} placeholder="Search code, name, SAP, QR…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load()} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: t.textDim }}>
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low stock
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: t.textDim }}>
              <input type="checkbox" checked={nearEolOnly} onChange={(e) => setNearEolOnly(e.target.checked)} /> Life watch
            </label>
            <button type="button" onClick={load}
              style={{ ...inp, cursor: 'pointer', background: t.accent, color: '#fff', border: 'none' }}>
              {loading ? 'Loading…' : 'Load'}
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
              <thead>
                <tr>
                  {['Code', 'Mold Name', 'Part No.', 'Customer', 'Active Cavity', 'Stock', 'Life Used', 'Status', 'QR', 'Actions'].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!tools.length && (
                  <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: t.textDim }}>No molds.</td></tr>
                )}
                {tools.map((row) => {
                  const st = STATUS_STYLE[row.tool_status] || STATUS_STYLE.ok;
                  const used = Number(row.cycles_used ?? 0);
                  const limit = row.life_cycles_limit != null ? Number(row.life_cycles_limit) : null;
                  const pct = limit && limit > 0
                    ? (row.life_used_pct != null ? row.life_used_pct : Math.round((used / limit) * 1000) / 10)
                    : null;
                  const activeCav = row.active_cavity_name
                    || row.active_cavity?.name
                    || (Array.isArray(row.cavities) && row.cavities.find((c) => c.enabled)?.name)
                    || '—';
                  return (
                    <tr key={row.id}>
                      <td style={{ ...td, fontWeight: 600 }}>{row.tool_code}</td>
                      <td style={td}>{row.tool_name}</td>
                      <td style={td}>{row.effective_part_no || row.part_no || '—'}</td>
                      <td style={td}>{row.customer_name || '—'}</td>
                      <td style={{ ...td, fontWeight: 600, color: activeCav !== '—' ? (t.accent || '#38bdf8') : t.textDim }}>
                        {activeCav}
                      </td>
                      <td style={{ ...td, fontWeight: 600, color: row.below_min ? '#ef4444' : t.text }}>{row.stock_qty}</td>
                      <td style={{
                        ...td,
                        fontWeight: 600,
                        color: pct != null && pct >= (row.life_warning_pct || 90) ? '#f59e0b' : t.text,
                      }}>
                        {used.toLocaleString()}
                        {pct != null && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: t.textDim }}>({pct}%)</span>
                        )}
                        {limit != null && limit > 0 && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: t.textDim }}>/ {limit.toLocaleString()}</span>
                        )}
                      </td>
                      <td style={{ ...td, color: st.color, fontWeight: 600 }}>{st.label}</td>
                      <td style={td}>
                        <ToolQrCell
                          value={row.qr_code || row.tool_code}
                          label={row.qr_code || row.tool_code}
                          t={t}
                          onExpand={() => setQrPreview({
                            code: row.tool_code,
                            name: row.tool_name,
                            value: row.qr_code || row.tool_code,
                          })}
                        />
                      </td>
                      <td style={td}>
                        <button type="button" onClick={() => openHistory(row)}
                          style={{ background: 'none', border: 'none', color: t.accent, cursor: 'pointer', marginRight: 6 }}>History</button>
                        {canEdit && (
                          <>
                            <button type="button" onClick={() => openEdit(row)}
                              style={{ background: 'none', border: 'none', color: t.accent, cursor: 'pointer', marginRight: 6 }}>Edit</button>
                            {(row.tool_status === 'eol' || row.tool_status === 'near_eol' || row.tool_status === 'blocked') && (
                              <button type="button" onClick={() => doCorrection(row.id)}
                                style={{ background: 'none', border: 'none', color: '#8b5cf6', cursor: 'pointer', marginRight: 6 }}>Correct</button>
                            )}
                            <button type="button" onClick={() => doReplace(row.id)}
                              style={{ background: 'none', border: 'none', color: '#f59e0b', cursor: 'pointer', marginRight: 6 }}>Replace</button>
                            {canDelete && (
                              <button type="button" onClick={() => removeTool(row.id)}
                                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>Delete</button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {qrPreview && (
        <ModalShell t={t} title={`QR — ${qrPreview.code}`} onClose={() => setQrPreview(null)}>
          <div style={{ textAlign: 'center' }}>
            <img
              src={qrImageUrl(qrPreview.value, 220)}
              alt={`QR ${qrPreview.value}`}
              width={220}
              height={220}
              style={{
                background: '#fff', padding: 12, borderRadius: 8,
                border: `1px solid ${t.border}`,
              }}
            />
            <div style={{ marginTop: 10, fontWeight: 700, color: t.text }}>{qrPreview.name}</div>
            <div style={{ fontSize: 13, color: t.textDim, marginTop: 4 }}>{qrPreview.value}</div>
            <div style={{ fontSize: 11, color: t.textMuted, marginTop: 8 }}>
              Scan acknowledgment is suppressed for testing — QR is mapped for display/print.
            </div>
          </div>
        </ModalShell>
      )}

      {historyTool && (
        <ModalShell t={t} title={`History — ${historyTool.tool_code}`} onClose={() => setHistoryTool(null)} wide>
          <div style={{ fontSize: 12, color: t.textDim, marginBottom: 10 }}>
            Status: <strong style={{ color: (STATUS_STYLE[historyTool.tool_status] || STATUS_STYLE.ok).color }}>
              {(STATUS_STYLE[historyTool.tool_status] || STATUS_STYLE.ok).label}
            </strong>
            {' · '}Life {historyTool.cycles_used}/{historyTool.life_cycles_limit || '—'}
            {' · '}QR scan {historyTool.qr_scan_enabled ? 'enabled' : 'suppressed'}
          </div>
          <div style={{ overflowX: 'auto', maxHeight: 360 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['When', 'Type', 'Cycles Δ', 'Location', 'Notes'].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!historyEvents.length && (
                  <tr><td colSpan={5} style={{ ...td, color: t.textDim }}>No events yet.</td></tr>
                )}
                {historyEvents.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...td, fontSize: 11 }}>{e.created_at ? String(e.created_at).replace('T', ' ').slice(0, 19) : '—'}</td>
                    <td style={td}>{e.event_type}</td>
                    <td style={td}>{e.cycles_delta != null ? e.cycles_delta : '—'}{e.cycles_after != null ? ` → ${e.cycles_after}` : ''}</td>
                    <td style={{ ...td, fontSize: 11 }}>{e.location || e.machine_name || '—'}</td>
                    <td style={{ ...td, fontSize: 11 }}>{e.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ModalShell>
      )}

      {showForm && (
        <ModalShell t={t} title={editingId ? 'Edit Mold' : 'Add Mold'} onClose={() => setShowForm(false)} wide>
          <form onSubmit={saveTool}>
            <div style={{ fontSize: 12, fontWeight: 700, color: t.textDim, marginBottom: 6 }}>Inventory / life</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Mold Code *" t={t}>
                <input style={inp} required disabled={!!editingId} value={form.tool_code}
                  onChange={(e) => setForm((p) => ({ ...p, tool_code: e.target.value }))} />
              </Field>
              <Field label="Mold Name *" t={t}>
                <input style={inp} required value={form.tool_name}
                  onChange={(e) => setForm((p) => ({ ...p, tool_name: e.target.value }))} />
              </Field>
              <Field label="Stock Qty" t={t}>
                <input style={inp} type="number" step="any" value={form.stock_qty}
                  onChange={(e) => setForm((p) => ({ ...p, stock_qty: e.target.value }))} />
              </Field>
              <Field label="Min Stock" t={t}>
                <input style={inp} type="number" step="any" value={form.min_stock}
                  onChange={(e) => setForm((p) => ({ ...p, min_stock: e.target.value }))} />
              </Field>
              <Field label="Life Cycles Limit (e.g. 50000)" t={t}>
                <input style={inp} type="number" value={form.life_cycles_limit}
                  onChange={(e) => setForm((p) => ({ ...p, life_cycles_limit: e.target.value }))} />
              </Field>
              <Field label="Cycles Used" t={t}>
                <input style={inp} type="number" step="any" value={form.cycles_used}
                  onChange={(e) => setForm((p) => ({ ...p, cycles_used: e.target.value }))} />
              </Field>
              <Field label="Warn at % of life" t={t}>
                <input style={inp} type="number" value={form.life_warning_pct}
                  onChange={(e) => setForm((p) => ({ ...p, life_warning_pct: e.target.value }))} />
              </Field>
              <Field label="Cycles per part" t={t}>
                <input style={inp} type="number" step="any" value={form.cycles_per_part}
                  onChange={(e) => setForm((p) => ({ ...p, cycles_per_part: e.target.value }))} />
              </Field>
              <Field label="QR Code (scan suppressed)" t={t}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input style={{ ...inp, flex: 1 }} value={form.qr_code} placeholder="Defaults to mold code if empty"
                    onChange={(e) => setForm((p) => ({ ...p, qr_code: e.target.value }))} />
                  {(form.qr_code || form.tool_code) && (
                    <img
                      src={qrImageUrl(form.qr_code || form.tool_code, 48)}
                      alt="QR preview"
                      width={48}
                      height={48}
                      style={{ background: '#fff', borderRadius: 4, border: `1px solid ${t.border}`, padding: 2 }}
                    />
                  )}
                </div>
              </Field>
              <Field label="Stock Source" t={t}>
                <select style={inp} value={form.stock_source}
                  onChange={(e) => setForm((p) => ({ ...p, stock_source: e.target.value }))}>
                  <option value="manual">Manual</option>
                  <option value="sap">SAP</option>
                </select>
              </Field>
              <Field label="SAP Material No" t={t}>
                <input style={inp} value={form.sap_material_no}
                  onChange={(e) => setForm((p) => ({ ...p, sap_material_no: e.target.value }))} />
              </Field>
              <Field label="Notes" t={t}>
                <input style={inp} value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} />
              </Field>
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: t.textDim, margin: '16px 0 6px' }}>IMM production master</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Part No. *" t={t}>
                <input style={inp} required value={form.part_no}
                  onChange={(e) => setForm((p) => ({ ...p, part_no: e.target.value }))} />
              </Field>
              <Field label="Customer Name *" t={t}>
                <input style={inp} required value={form.customer_name}
                  onChange={(e) => setForm((p) => ({ ...p, customer_name: e.target.value }))} />
              </Field>
              <Field label="RM Grade *" t={t}>
                <input style={inp} required value={form.rm_grade} placeholder="Raw material grade"
                  onChange={(e) => setForm((p) => ({ ...p, rm_grade: e.target.value }))} />
              </Field>
              <Field label="Colour *" t={t}>
                <input style={inp} required value={form.colour}
                  onChange={(e) => setForm((p) => ({ ...p, colour: e.target.value }))} />
              </Field>
              <Field label="Standard Cavity *" t={t}>
                <input style={inp} required type="number" value={form.standard_cavity}
                  onChange={(e) => setForm((p) => ({ ...p, standard_cavity: e.target.value }))} />
              </Field>
              <Field label="Running Cavity *" t={t}>
                <input style={inp} required type="number" value={form.running_cavity}
                  onChange={(e) => setForm((p) => ({ ...p, running_cavity: e.target.value }))} />
              </Field>
              <Field label="Standard Cycle Time *" t={t}>
                <input style={inp} required type="number" step="any" value={form.standard_cycle_time}
                  onChange={(e) => setForm((p) => ({ ...p, standard_cycle_time: e.target.value }))} />
              </Field>
              <Field label="Target / Shift *" t={t}>
                <input style={inp} required type="number" value={form.target_per_shift}
                  onChange={(e) => setForm((p) => ({ ...p, target_per_shift: e.target.value }))} />
              </Field>
              <Field label="Std. Shot Weight *" t={t}>
                <input style={inp} required type="number" step="any" value={form.std_shot_weight}
                  onChange={(e) => setForm((p) => ({ ...p, std_shot_weight: e.target.value }))} />
              </Field>
              <Field label="Std. Part Weight *" t={t}>
                <input style={inp} required type="number" step="any" value={form.std_part_weight}
                  onChange={(e) => setForm((p) => ({ ...p, std_part_weight: e.target.value }))} />
              </Field>
              <Field label="Std. Runner Weight *" t={t}>
                <input style={inp} required type="number" step="any" value={form.std_runner_weight}
                  onChange={(e) => setForm((p) => ({ ...p, std_runner_weight: e.target.value }))} />
              </Field>
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: t.textDim }}>
                  Cavity Name * (fixtures) — enable one for production logging
                </div>
                <button
                  type="button"
                  onClick={() => setForm((p) => ({
                    ...p,
                    cavities: [...(p.cavities || []), { id: newCavityId(), name: '', enabled: false, part_no: '' }],
                  }))}
                  style={{
                    padding: '4px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 6,
                  }}
                >
                  + Add cavity
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(form.cavities || []).map((cav, idx) => (
                  <div
                    key={cav.id || idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1.2fr 1fr auto auto',
                      gap: 8,
                      alignItems: 'center',
                      padding: 8,
                      borderRadius: 8,
                      border: `1px solid ${cav.enabled ? (t.accent || '#38bdf8') : t.border}`,
                      background: cav.enabled ? 'rgba(56,189,248,0.08)' : (t.surface2 || t.bg),
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: t.text, whiteSpace: 'nowrap' }}>
                      <input
                        type="radio"
                        name="active-cavity"
                        checked={!!cav.enabled}
                        onChange={() => setCavityActive(cav.id)}
                      />
                      Active
                    </label>
                    <input
                      style={inp}
                      placeholder="Cavity name (e.g. Base, Cover)"
                      value={cav.name}
                      onChange={(e) => setForm((p) => ({
                        ...p,
                        cavities: p.cavities.map((c, i) => (i === idx ? { ...c, name: e.target.value } : c)),
                      }))}
                    />
                    <input
                      style={inp}
                      placeholder="Part No. for this cavity"
                      value={cav.part_no || ''}
                      onChange={(e) => setForm((p) => ({
                        ...p,
                        cavities: p.cavities.map((c, i) => (i === idx ? { ...c, part_no: e.target.value } : c)),
                      }))}
                    />
                    <button
                      type="button"
                      title={cav.enabled ? 'Disable cavity' : 'Enable for production'}
                      onClick={() => {
                        if (cav.enabled) {
                          setForm((p) => ({
                            ...p,
                            cavities: p.cavities.map((c, i) => (i === idx ? { ...c, enabled: false } : c)),
                          }));
                        } else {
                          setCavityActive(cav.id);
                        }
                      }}
                      style={{
                        padding: '6px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', borderRadius: 6,
                        border: `1px solid ${t.border}`,
                        background: cav.enabled ? (t.accent || '#38bdf8') : t.surface,
                        color: cav.enabled ? '#fff' : t.textMuted,
                      }}
                    >
                      {cav.enabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((p) => ({
                        ...p,
                        cavities: p.cavities.length <= 1
                          ? [{ id: newCavityId(), name: '', enabled: true, part_no: '' }]
                          : p.cavities.filter((_, i) => i !== idx),
                      }))}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontWeight: 700 }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: t.textDim, marginTop: 6 }}>
                Only the active cavity receives remaining production logging for this mold.
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setShowForm(false)}
                style={{ padding: '8px 16px', background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer' }}>
                Cancel
              </button>
              <button type="submit"
                style={{ padding: '8px 20px', background: t.accent, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Save
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {showSap && (
        <ModalShell t={t} title="Sync Stock from SAP" onClose={() => setShowSap(false)} wide>
          <p style={{ fontSize: 12, color: t.textDim, marginTop: 0 }}>
            Post SAP material stock here (middleware / OData). Dry-run validates without writing.
          </p>
          {sapRows.map((row, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <input style={{ ...inp, flex: 1, minWidth: 120 }} placeholder="SAP Material No *"
                value={row.sap_material_no}
                onChange={(e) => setSapRows((rows) => rows.map((r, i) => i === idx ? { ...r, sap_material_no: e.target.value } : r))} />
              <input style={{ ...inp, width: 110 }} placeholder="Tool Code"
                value={row.tool_code}
                onChange={(e) => setSapRows((rows) => rows.map((r, i) => i === idx ? { ...r, tool_code: e.target.value } : r))} />
              <input style={{ ...inp, width: 90 }} type="number" placeholder="Stock *"
                value={row.stock_qty}
                onChange={(e) => setSapRows((rows) => rows.map((r, i) => i === idx ? { ...r, stock_qty: e.target.value } : r))} />
              <button type="button"
                onClick={() => setSapRows((rows) => rows.length === 1 ? [{ ...EMPTY_SAP }] : rows.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}>✕</button>
            </div>
          ))}
          <button type="button" onClick={() => setSapRows((rows) => [...rows, { ...EMPTY_SAP }])}
            style={{ padding: '6px 12px', background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 6, color: t.text, cursor: 'pointer', marginBottom: 12 }}>
            + Row
          </button>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" disabled={sapBusy} onClick={() => runSapSync(true)}
              style={{ padding: '8px 16px', background: t.surface2, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer' }}>
              Dry Run
            </button>
            <button type="button" disabled={sapBusy} onClick={() => runSapSync(false)}
              style={{ padding: '8px 20px', background: t.accent, color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
              {sapBusy ? 'Syncing…' : 'Apply SAP Stock'}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function StatCard({ t, label, value, alert }) {
  return (
    <div style={{
      background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10,
      padding: '12px 18px', minWidth: 120,
    }}>
      <div style={{ fontSize: 11, color: t.textDim }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: alert ? '#ef4444' : t.accent }}>{value}</div>
    </div>
  );
}

function LegendStep({ color, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color,
      }} />
      <span style={{ color, fontWeight: 600 }}>{label}</span>
    </span>
  );
}

function qrImageUrl(value, size = 64) {
  const data = encodeURIComponent(String(value || ''));
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=1&data=${data}`;
}

function ToolQrCell({ value, label, t, onExpand }) {
  if (!value) {
    return <span style={{ color: t.textDim }}>—</span>;
  }
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Show QR: ${label}`}
      style={{
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: t.text,
      }}
    >
      <img
        src={qrImageUrl(value, 56)}
        alt={`QR ${label}`}
        width={56}
        height={56}
        style={{
          display: 'block', background: '#fff', borderRadius: 4,
          border: `1px solid ${t.border}`, padding: 2,
        }}
      />
      <span style={{ fontSize: 10, color: t.textMuted, maxWidth: 72, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </span>
    </button>
  );
}

function Field({ label, children, t }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ color: t.textDim, fontSize: 11 }}>{label}</label>
      {children}
    </div>
  );
}

function ModalShell({ t, title, onClose, children, wide }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: t.surface, borderRadius: 12, padding: 24, width: '100%',
        maxWidth: wide ? 960 : 560, maxHeight: '90vh', overflow: 'auto',
        border: `1px solid ${t.border}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, color: t.accent, fontSize: 16 }}>{title}</h3>
          <button type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
