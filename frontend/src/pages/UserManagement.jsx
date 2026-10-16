import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import PageHeader from '../components/PageHeader';
import FeatureAccessMatrix from '../components/FeatureAccessMatrix';

const ROLES = ['superadmin', 'admin', 'supervisor', 'operator', 'maintenance', 'quality'];

const ROLE_CFG = {
  superadmin:  { color: '#dc2626', label: 'Super Admin', icon: '🛡', desc: 'Full access + factory setup, data backup & archive' },
  admin:       { color: '#ef4444', label: 'Admin',       icon: '⚙', desc: 'Full access to all features except factory setup & backup' },
  supervisor:  { color: '#f59e0b', label: 'Supervisor',  icon: '📋', desc: 'Planning, data entry, QC incharge approval' },
  operator:    { color: '#0ea5e9', label: 'Operator (web login)', icon: '🔧', desc: 'Optional web/tablet login account — shop-floor roster lives in Operator Management' },
  maintenance: { color: '#10b981', label: 'Maintenance', icon: '🛠', desc: 'Acknowledge and resolve breakdown tickets' },
  quality:     { color: '#8b5cf6', label: 'Quality',     icon: '✓', desc: 'QC inspection sheet — inspector approval' },
};

const INIT_FORM = { username: '', password: '', role: 'supervisor' };

function PasswordInput({ value, onChange, placeholder = '', required = false, style = {} }) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        style={{ ...style, paddingRight: 36 }}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        style={{ position: 'absolute', right: 8, background: 'none', border: 'none',
                 cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0, opacity: 0.6 }}
        title={visible ? 'Hide password' : 'Show password'}>
        {visible ? '🚫' : '👁'}
      </button>
    </div>
  );
}

export default function UserManagement() {
  const { theme: t } = useTheme();
  const { user: me } = useAuth();
  const [users, setUsers]       = useState([]);
  const [form, setForm]         = useState(INIT_FORM);
  const [editId, setEditId]     = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [pwForm, setPwForm]     = useState({ id: null, current: '', next: '', confirm: '' });
  const [showPwForm, setShowPwForm] = useState(false);
  const [msg, setMsg]           = useState({ text: '', ok: true });
  const [photoUploadId, setPhotoUploadId] = useState(null);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg({ text: '', ok: true }), 4000);
  };

  const fetchUsers = useCallback(async () => {
    try {
      const r = await api.get('/api/users/');
      setUsers(r.data);
    } catch { flash('Failed to load users', false); }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const openAdd = () => {
    setForm(INIT_FORM); setEditId(null); setShowForm(true);
  };

  const openEdit = (u) => {
    setForm({ username: u.username, password: '', role: u.role });
    setEditId(u.id); setShowForm(true);
  };

  const save = async (e) => {
    e.preventDefault();
    try {
      if (editId) {
        const payload = {};
        if (editId !== me?.id) payload.role = form.role;
        if (form.password) payload.password = form.password;
        await api.put(`/api/users/${editId}`, payload);
        flash('✅ User updated');
      } else {
        await api.post('/api/users/', form);
        flash('✅ User created');
      }
      setShowForm(false);
      fetchUsers();
    } catch (err) {
      flash('❌ ' + (err.response?.data?.detail || err.message), false);
    }
  };

  const deleteUser = async (id, username) => {
    if (!window.confirm(
      `Delete login user "${username}"?\n\n`
      + 'Shop-floor Operator Directory records are kept. History is unlinked from this login.\n'
      + 'Tickets raised by this user are reassigned to you.',
    )) return;
    try {
      await api.delete(`/api/users/${id}`);
      flash('✅ User deleted');
      fetchUsers();
    } catch (err) {
      const d = err.response?.data?.detail;
      const msg = typeof d === 'string' ? d : (Array.isArray(d) ? d.map((x) => x.msg || x).join('; ') : err.message);
      flash('❌ ' + msg, false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (pwForm.next !== pwForm.confirm) {
      flash('❌ New passwords do not match', false); return;
    }
    try {
      await api.post('/api/users/me/change-password', {
        current_password: pwForm.current,
        new_password: pwForm.next,
      });
      flash('✅ Password changed successfully');
      setShowPwForm(false);
      setPwForm({ id: null, current: '', next: '', confirm: '' });
    } catch (err) {
      flash('❌ ' + (err.response?.data?.detail || err.message), false);
    }
  };

  const uploadReferencePhoto = async (userId, file) => {
    if (!file) return;
    setPhotoUploadId(userId);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/api/users/${userId}/reference-photo`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      flash('✅ Reference photo uploaded for mobile face verification');
      fetchUsers();
    } catch (err) {
      flash('❌ ' + (err.response?.data?.detail || err.message), false);
    } finally {
      setPhotoUploadId(null);
    }
  };

  const s = getStyles(t);
  const byRole = ROLES.reduce((acc, r) => {
    acc[r] = users.filter(u => u.role === r);
    return acc;
  }, {});

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader
        title="USER MANAGEMENT"
        onRefresh={fetchUsers}
        extra={
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={s.outlineBtn} onClick={() => setShowPwForm(v => !v)}>
              🔑 Change My Password
            </button>
            <button style={s.addBtn} onClick={openAdd}>+ Add User</button>
          </div>
        }
      />
      <p style={{ color: t.textMuted, fontSize: 13, marginTop: -4, marginBottom: 12 }}>
        Login accounts for web/admin roles. Shop-floor operators (roster, temp staff, large headcount) are managed under{' '}
        <strong style={{ color: t.accent }}>Operator Management → Operator Directory</strong>.
      </p>
      {msg.text && (
        <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 12,
                      background: msg.ok ? '#10b98122' : '#ef444422',
                      color: msg.ok ? '#10b981' : '#ef4444', fontSize: 13 }}>
          {msg.text}
        </div>
      )}

      {/* Change My Password */}
      {showPwForm && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h4 style={s.cardTitle}>🔑 Change My Password ({me?.username})</h4>
            <button style={s.closeBtn} onClick={() => setShowPwForm(false)}>✕</button>
          </div>
          <form onSubmit={changePassword} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={s.label}>Current Password</label>
              <PasswordInput style={s.inp} required value={pwForm.current}
                onChange={e => setPwForm(p => ({ ...p, current: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={s.label}>New Password</label>
              <PasswordInput style={s.inp} required value={pwForm.next}
                onChange={e => setPwForm(p => ({ ...p, next: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={s.label}>Confirm New Password</label>
              <PasswordInput style={s.inp} required value={pwForm.confirm}
                onChange={e => setPwForm(p => ({ ...p, confirm: e.target.value }))} />
            </div>
            <button style={s.submitBtn} type="submit">Update Password</button>
          </form>
        </div>
      )}

      {/* Add / Edit Form */}
      {showForm && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h4 style={s.cardTitle}>{editId ? '✏ Edit User' : '➕ Add New User'}</h4>
            <button style={s.closeBtn} onClick={() => setShowForm(false)}>✕</button>
          </div>
          <form onSubmit={save}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={s.label}>Username *</label>
                <input style={{ ...s.inp, background: editId ? t.surface2 : t.inp }}
                  value={form.username} required readOnly={!!editId}
                  onChange={e => setForm(p => ({ ...p, username: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={s.label}>{editId ? 'New Password (leave blank to keep)' : 'Password *'}</label>
                <PasswordInput style={s.inp} value={form.password}
                  required={!editId} placeholder={editId ? 'Leave blank to keep current' : ''}
                  onChange={e => setForm(p => ({ ...p, password: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={s.label}>Role *</label>
                <select style={{ ...s.inp, background: editId === me?.id ? t.surface2 : t.inp }}
                  value={form.role} disabled={editId === me?.id}
                  onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                  {ROLES.map(r => (
                    <option key={r} value={r}>{ROLE_CFG[r].icon} {ROLE_CFG[r].label}</option>
                  ))}
                </select>
                {editId === me?.id && (
                  <span style={{ color: t.textFaint, fontSize: 10 }}>Cannot change your own role</span>
                )}
              </div>
              <button style={s.submitBtn} type="submit">
                {editId ? '💾 Save Changes' : '✓ Create User'}
              </button>
              <button style={s.cancelBtn} type="button" onClick={() => setShowForm(false)}>Cancel</button>
            </div>

            {/* Role description preview */}
            {form.role && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: t.surface2,
                            borderLeft: `3px solid ${ROLE_CFG[form.role]?.color}`, fontSize: 13 }}>
                <span style={{ color: ROLE_CFG[form.role]?.color, fontWeight: 600 }}>
                  {ROLE_CFG[form.role]?.icon} {ROLE_CFG[form.role]?.label}
                </span>
                <span style={{ color: t.textMuted, marginLeft: 8 }}>{ROLE_CFG[form.role]?.desc}</span>
              </div>
            )}
          </form>
        </div>
      )}

      {/* Role Access Summary */}
      <div style={s.card}>
        <h4 style={s.cardTitle}>🔐 Role Access Summary</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {ROLES.map(r => {
            const cfg = ROLE_CFG[r];
            const count = byRole[r]?.length || 0;
            return (
              <div key={r} style={{ background: t.surface2, borderRadius: 8, padding: '12px 14px',
                                    borderLeft: `3px solid ${cfg.color}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ color: cfg.color, fontWeight: 700, fontSize: 14 }}>
                    {cfg.icon} {cfg.label}
                  </span>
                  <span style={{ background: cfg.color + '33', color: cfg.color, borderRadius: 10,
                                 padding: '1px 8px', fontSize: 12, fontWeight: 700 }}>
                    {count} user{count !== 1 ? 's' : ''}
                  </span>
                </div>
                <div style={{ color: t.textMuted, fontSize: 12 }}>{cfg.desc}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Users Table */}
      <div style={s.card}>
        <h4 style={s.cardTitle}>All Users ({users.length})</h4>
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                {['#', 'Username', 'Role', 'Face ID', 'Access Level', 'Actions'].map(h =>
                  <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={6} style={{ ...s.td, textAlign: 'center', color: t.textFaint, padding: 32 }}>
                  No users found.
                </td></tr>
              )}
              {users.map(u => {
                const cfg = ROLE_CFG[u.role] || ROLE_CFG.operator;
                const isMe = u.username === me?.username;
                return (
                  <tr key={u.id} style={{ background: isMe ? t.accent + '11' : 'transparent' }}>
                    <td style={s.td}>{u.id}</td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ width: 30, height: 30, borderRadius: '50%',
                                      background: cfg.color + '33', color: cfg.color,
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                          {u.username[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, color: t.text }}>{u.username}</div>
                          {isMe && <div style={{ color: t.accent, fontSize: 10, fontWeight: 600 }}>YOU</div>}
                        </div>
                      </div>
                    </td>
                    <td style={s.td}>
                      <span style={{ padding: '3px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                                     background: cfg.color + '22', color: cfg.color }}>
                        {cfg.icon} {cfg.label}
                      </span>
                    </td>
                    <td style={s.td}>
                      {u.role === 'operator' ? (
                        u.has_reference_photo ? (
                          <span style={{ color: '#10b981', fontSize: 12, fontWeight: 600 }}>✓ Master photo</span>
                        ) : (
                          <span style={{ color: '#f59e0b', fontSize: 12, fontWeight: 600 }}>Not set</span>
                        )
                      ) : (
                        <span style={{ color: t.textFaint, fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={s.td}>
                      <span style={{ color: t.textMuted, fontSize: 12 }}>{cfg.desc}</span>
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {u.role === 'operator' && (
                          <label style={{ ...s.miniBtn, background: '#6366f1', cursor: 'pointer', display: 'inline-block' }}>
                            {photoUploadId === u.id ? '…' : '📷 Ref photo'}
                            <input
                              type="file"
                              accept="image/*"
                              style={{ display: 'none' }}
                              disabled={photoUploadId === u.id}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) uploadReferencePhoto(u.id, f);
                                e.target.value = '';
                              }}
                            />
                          </label>
                        )}
                        <button style={{ ...s.miniBtn, background: t.accent }}
                          onClick={() => openEdit(u)}>✏ Edit</button>
                        <button
                          style={{ ...s.miniBtn, background: isMe ? t.textFaint : '#ef4444',
                                   cursor: isMe ? 'not-allowed' : 'pointer' }}
                          onClick={() => !isMe && deleteUser(u.id, u.username)}
                          title={isMe ? 'Cannot delete your own account' : 'Delete user'}
                          disabled={isMe}>
                          🗑 Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Access Matrix — editable (PMS parity) */}
      <FeatureAccessMatrix onFlash={flash} />
    </div>
  );
}

function getStyles(t) {
  return {
    card:      { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 },
    cardTitle: { color: t.accent, margin: '0 0 14px', fontSize: 14, fontWeight: 600 },
    label:     { color: t.textDim, fontSize: 11, fontWeight: 600 },
    inp:       { padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
                 background: t.inp, color: t.text, fontSize: 13, minWidth: 160 },
    addBtn:    { padding: '8px 20px', background: t.accent, color: '#fff', border: 'none',
                 borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    outlineBtn:{ padding: '8px 16px', background: 'transparent', color: t.accent,
                 border: `1px solid ${t.accent}`, borderRadius: 8, cursor: 'pointer', fontSize: 13 },
    submitBtn: { padding: '8px 22px', background: t.brand, color: '#fff', border: 'none',
                 borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    cancelBtn: { padding: '8px 18px', background: 'transparent', color: t.textMuted,
                 border: `1px solid ${t.border}`, borderRadius: 8, cursor: 'pointer', fontSize: 13 },
    closeBtn:  { background: 'none', border: 'none', color: t.textDim, cursor: 'pointer', fontSize: 18 },
    miniBtn:   { padding: '4px 10px', border: 'none', borderRadius: 5, color: '#fff',
                 cursor: 'pointer', fontSize: 12, fontWeight: 600 },
    table:     { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th:        { padding: '10px', background: t.surface2, color: t.textDim,
                 textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 600 },
    td:        { padding: '10px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' },
  };
}
