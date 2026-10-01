import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { useConfig } from '../context/ConfigContext';
import { useAuth } from '../context/AuthContext';
import { getFactoryLines } from '../utils/factoryHelpers';
import PageHeader from '../components/PageHeader';

const MACHINE_TYPES = [
  'IMM', 'Taichung Seiki', 'Sumitomo',
  'CNC', 'VMC', 'Lathe', 'Grinding', 'Drilling', 'Milling', 'Inspection', 'Other',
];

const STATUS_CFG = {
  running:        { color: '#10b981', label: 'Running',        icon: '▶' },
  idle:           { color: '#64748b', label: 'Idle',           icon: '⏸' },
  breakdown:      { color: '#ef4444', label: 'Breakdown',      icon: '⚠' },
  setting_change: { color: '#f59e0b', label: 'Setting Change', icon: '🔧' },
};

export default function MachineConfig() {
  const { theme: t } = useTheme();
  const { config } = useConfig();
  const { user } = useAuth();
  const canEdit = ['admin', 'superadmin'].includes(user?.role);
  const factoryLines = useMemo(() => getFactoryLines(config), [config]);
  const [stations, setStations] = useState([]);
  const [machines, setMachines] = useState([]);
  const [msg, setMsg] = useState('');

  const [machineForm, setMachineForm] = useState({
    name: '', station_id: '', machine_type: 'IMM', make: '', model_no: '',
    tonnage: '', features: '', location: ''
  });
  const [editMachineId, setEditMachineId] = useState(null);
  const [showMachineForm, setShowMachineForm] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const fileRef = useRef();

  const fetchStations = useCallback(async () => {
    try {
      const r = await api.get('/api/stations/');
      setStations(r.data);
    } catch (err) {
      setMsg('❌ Failed to fetch stations: ' + (err.response?.data?.detail || err.message));
    }
  }, []);

  const fetchMachines = useCallback(async () => {
    try {
      const r = await api.get('/api/machines/');
      setMachines(r.data);
    } catch (err) {
      setMsg('❌ Failed to fetch machines: ' + (err.response?.data?.detail || err.message));
    }
  }, []);

  useEffect(() => {
    fetchStations();
    fetchMachines();
  }, [fetchStations, fetchMachines]);

  const openAddMachine = () => {
    setMachineForm({
      name: '', station_id: '', machine_type: 'IMM', make: '', model_no: '',
      tonnage: '', features: '', location: ''
    });
    setEditMachineId(null);
    setImageFile(null);
    setImagePreview(null);
    setShowMachineForm(true);
    setMsg('');
  };

  const openEditMachine = (m) => {
    setMachineForm({
      name: m.name, station_id: m.station_id, machine_type: m.machine_type || 'IMM',
      make: m.make || '', model_no: m.model_no || '', tonnage: m.tonnage || '',
      features: m.features || '', location: m.location || ''
    });
    setEditMachineId(m.id);
    setImagePreview(m.image_url ? assetUrl(m.image_url) : null);
    setImageFile(null);
    setShowMachineForm(true);
    setMsg('');
  };

  const handleImageChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setImageFile(f);
    const reader = new FileReader();
    reader.onload = ev => setImagePreview(ev.target.result);
    reader.readAsDataURL(f);
  };

  const saveMachine = async (e) => {
    e.preventDefault();
    try {
      let saved;
      if (editMachineId) {
        const r = await api.put(`/api/machines/${editMachineId}`, {
          ...machineForm,
          station_id: parseInt(machineForm.station_id)
        });
        saved = r.data;
      } else {
        const r = await api.post('/api/machines/', {
          ...machineForm,
          station_id: parseInt(machineForm.station_id)
        });
        saved = r.data;
      }
      if (imageFile) {
        const fd = new FormData();
        fd.append('file', imageFile);
        await api.post(`/api/machines/${saved.id}/image`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
      }
      setMsg(editMachineId ? '✅ Machine updated' : '✅ Machine added');
      setShowMachineForm(false);
      fetchMachines();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const deleteMachine = async (id) => {
    if (!window.confirm('Delete this machine?')) return;
    try {
      await api.delete(`/api/machines/${id}`);
      setMsg('✅ Machine deleted');
      fetchMachines();
    } catch (err) {
      setMsg('❌ ' + (err.response?.data?.detail || err.message));
    }
  };

  const s = getStyles(t);

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader
        title="⚙ MACHINE CONFIGURATION"
        subtitle="Manage machine fleet — use Machine ID when setting up operator tablets"
        onRefresh={() => { fetchStations(); fetchMachines(); }}
      />

      {msg && (
        <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 12,
                      background: msg.startsWith('✅') ? '#10b98122' : '#ef444422',
                      color: msg.startsWith('✅') ? '#10b981' : '#ef4444', fontSize: 13 }}>
          {msg}
        </div>
      )}

      <div style={{
        padding: '10px 14px', borderRadius: 8, marginBottom: 12,
        background: t.accent + '14', border: `1px solid ${t.accent}55`,
        color: t.text, fontSize: 12, lineHeight: 1.45,
      }}>
        Tablet / mobile setup: enter the numeric <strong>Machine ID</strong> (not the name like CN40).
        Example: CN40 → ID <strong>1</strong>, CN41 → ID <strong>2</strong>.
      </div>

      {showMachineForm && canEdit && (
        <div style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <h4 style={{ ...s.cardTitle, marginBottom: 4 }}>
                    {editMachineId ? '✏ Edit Machine' : '➕ Add New Machine'}
                  </h4>
                  {editMachineId && (
                    <div style={{ fontSize: 12, color: t.textMuted }}>
                      Machine ID:{' '}
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 6,
                        background: t.accent + '22', color: t.accent, fontWeight: 700, fontFamily: 'monospace',
                      }}>
                        {editMachineId}
                      </span>
                      <span style={{ marginLeft: 8, color: t.textFaint }}>
                        (use this value on the operator tablet)
                      </span>
                    </div>
                  )}
                </div>
                <button style={s.closeBtn} onClick={() => setShowMachineForm(false)}>✕</button>
              </div>
              <form onSubmit={saveMachine}>
                <div style={s.grid3}>
                  <CF label="Machine Name *" t={t}>
                    <input style={s.inp} value={machineForm.name} required
                      onChange={e => setMachineForm(p => ({ ...p, name: e.target.value }))} />
                  </CF>
                  <CF label="Station *" t={t}>
                    <select style={s.inp} value={machineForm.station_id} required
                      onChange={e => setMachineForm(p => ({ ...p, station_id: e.target.value }))}>
                      <option value="">Select a station</option>
                      {stations.map(s => <option key={s.id} value={s.id}>{s.display_name}</option>)}
                    </select>
                  </CF>
                  <CF label="Machine Type *" t={t}>
                    <select style={s.inp} value={machineForm.machine_type}
                      onChange={e => setMachineForm(p => ({ ...p, machine_type: e.target.value }))}>
                      {MACHINE_TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
                    </select>
                  </CF>
                  <CF label="Make / Brand" t={t}>
                    <input style={s.inp} value={machineForm.make} placeholder="e.g. Taichung Seiki, Sumitomo"
                      onChange={e => setMachineForm(p => ({ ...p, make: e.target.value }))} />
                  </CF>
                  <CF label="Model No" t={t}>
                    <input style={s.inp} value={machineForm.model_no} placeholder="e.g. QT-200"
                      onChange={e => setMachineForm(p => ({ ...p, model_no: e.target.value }))} />
                  </CF>
                  <CF label="Tonnage / Spindle" t={t}>
                    <input style={s.inp} value={machineForm.tonnage} placeholder="e.g. 200T / 6000rpm"
                      onChange={e => setMachineForm(p => ({ ...p, tonnage: e.target.value }))} />
                  </CF>
                  <CF label="Location / Line" t={t}>
                    {factoryLines.length > 0 ? (
                      <select style={s.inp} value={machineForm.location}
                        onChange={e => setMachineForm(p => ({ ...p, location: e.target.value }))}>
                        <option value="">Select line from Factory Setup</option>
                        {factoryLines.map(line => (
                          <option key={line.id} value={line.label}>{line.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input style={s.inp} value={machineForm.location}
                        placeholder="Configure lines in Factory Setup first"
                        onChange={e => setMachineForm(p => ({ ...p, location: e.target.value }))} />
                    )}
                  </CF>
                  <CF label="Features" t={t} wide>
                    <textarea style={{ ...s.inp, resize: 'vertical', minHeight: 60 }} value={machineForm.features}
                      placeholder="e.g. Live tooling, Y-axis, sub-spindle..."
                      onChange={e => setMachineForm(p => ({ ...p, features: e.target.value }))} />
                  </CF>
                </div>

                <div style={{ marginTop: 16, marginBottom: 16 }}>
                  <div style={{ color: t.textDim, fontSize: 11, marginBottom: 8, fontWeight: 600 }}>MACHINE IMAGE</div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ width: 140, height: 100, borderRadius: 8, border: `2px dashed ${t.border}`,
                                  background: t.surface2, display: 'flex', alignItems: 'center',
                                  justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
                      {imagePreview
                        ? <img src={imagePreview} alt="preview"
                               style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        : <span style={{ color: t.textFaint, fontSize: 12 }}>No image</span>}
                    </div>
                    <div>
                      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                        onChange={handleImageChange} />
                      <button type="button" style={s.outlineBtn}
                        onClick={() => fileRef.current.click()}>
                        📷 {imagePreview ? 'Change Image' : 'Upload Image'}
                      </button>
                      {imagePreview && (
                        <button type="button" style={{ ...s.outlineBtn, marginLeft: 8, color: '#ef4444', borderColor: '#ef4444' }}
                          onClick={() => { setImagePreview(null); setImageFile(null); }}>
                          Remove
                        </button>
                      )}
                      <div style={{ color: t.textFaint, fontSize: 11, marginTop: 6 }}>
                        JPG, PNG, WebP — max 5MB
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button style={s.submitBtn} type="submit">
                    {editMachineId ? '💾 Save Changes' : '✓ Add Machine'}
                  </button>
                  <button style={s.cancelBtn} type="button" onClick={() => setShowMachineForm(false)}>Cancel</button>
                </div>
              </form>
            </div>
      )}

      <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h4 style={s.cardTitle}>Machine Fleet ({machines.length})</h4>
              {canEdit && (
                <button style={s.addBtn} onClick={openAddMachine}>+ Add Machine</button>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['ID','Image','Machine','Station','Type','Make / Model','Tonnage','Location','Status','Actions'].map(h =>
                      <th key={h} style={s.th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {machines.length === 0 && (
                    <tr><td colSpan={10} style={{ ...s.td, textAlign: 'center', color: t.textFaint, padding: 32 }}>
                      No machines configured yet. Click "+ Add Machine" to start.
                    </td></tr>
                  )}
                  {machines.map(m => {
                    const sc = STATUS_CFG[m.status] || STATUS_CFG.idle;
                    return (
                      <tr key={m.id}>
                        <td style={s.td}>
                          <span
                            title="Use this Machine ID on the operator tablet"
                            style={{
                              display: 'inline-block', minWidth: 28, textAlign: 'center',
                              padding: '4px 10px', borderRadius: 8, fontSize: 14, fontWeight: 800,
                              fontFamily: 'ui-monospace, Consolas, monospace',
                              background: t.accent + '22', color: t.accent,
                              border: `1px solid ${t.accent}66`,
                            }}
                          >
                            {m.id}
                          </span>
                        </td>
                        <td style={s.td}>
                          <div style={{ width: 56, height: 40, borderRadius: 6, overflow: 'hidden',
                                        background: t.surface2, border: `1px solid ${t.border}`,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {m.image_url
                              ? <img src={assetUrl(m.image_url)} alt={m.name}
                                     style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                              : <span style={{ fontSize: 20 }}>🏭</span>}
                          </div>
                        </td>
                        <td style={s.td}>
                          <div style={{ fontWeight: 600, color: t.text }}>{m.name}</div>
                          {m.features && <div style={{ color: t.textFaint, fontSize: 11 }}>{m.features.slice(0, 40)}{m.features.length > 40 ? '…' : ''}</div>}
                        </td>
                        <td style={s.td}>{m.station_name || '—'}</td>
                        <td style={s.td}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                         background: t.accent + '22', color: t.accent }}>
                            {m.machine_type || 'IMM'}
                          </span>
                        </td>
                        <td style={s.td}>
                          <div>{m.make || '—'}</div>
                          <div style={{ color: t.textFaint, fontSize: 11 }}>{m.model_no || ''}</div>
                        </td>
                        <td style={s.td}>{m.tonnage || '—'}</td>
                        <td style={s.td}>{m.location || '—'}</td>
                        <td style={s.td}>
                          <span style={{ padding: '3px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                                         background: sc.color + '22', color: sc.color }}>
                            {sc.icon} {sc.label}
                          </span>
                        </td>
                        <td style={s.td}>
                          {canEdit ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button style={{ ...s.miniBtn, background: t.accent }} onClick={() => openEditMachine(m)}>✏ Edit</button>
                              <button style={{ ...s.miniBtn, background: '#ef4444' }} onClick={() => deleteMachine(m.id)}>🗑</button>
                            </div>
                          ) : (
                            <span style={{ color: t.textFaint, fontSize: 12 }}>View only</span>
                          )}
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

function CF({ label, children, t, wide }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4,
                  gridColumn: wide ? 'span 3' : 'span 1' }}>
      <label style={{ color: t?.textDim, fontSize: 11, fontWeight: 600 }}>{label}</label>
      {children}
    </div>
  );
}

function getStyles(t) {
  return {
    card: { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 },
    cardTitle: { color: t.accent, margin: '0 0 14px', fontSize: 14, fontWeight: 600 },
    grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 8 },
    grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 8 },
    inp: { padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
           background: t.inp, color: t.text, fontSize: 13, width: '100%', boxSizing: 'border-box' },
    addBtn: { padding: '8px 20px', background: t.accent, color: '#fff', border: 'none',
              borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    submitBtn: { padding: '9px 24px', background: t.brand, color: '#fff', border: 'none',
                 borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    cancelBtn: { padding: '9px 24px', background: 'transparent', color: t.textMuted,
                 border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer', fontSize: 14 },
    outlineBtn: { padding: '7px 14px', background: 'transparent', color: t.accent,
                  border: `1px solid ${t.accent}`, borderRadius: 6, cursor: 'pointer', fontSize: 13 },
    closeBtn: { background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 },
    miniBtn: { padding: '4px 10px', border: 'none', borderRadius: 5, color: '#fff',
               cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { padding: '10px 10px', background: t.surface2, color: t.textDim,
          textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 600 },
    td: { padding: '10px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' },
  };
}
