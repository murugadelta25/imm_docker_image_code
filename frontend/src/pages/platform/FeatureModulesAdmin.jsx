import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import platformApi from '../../api/platformClient';
import { usePlatformAuth } from '../../context/PlatformAuthContext';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { useTheme } from '../../context/ThemeContext';
import {
  getDefaultFeatureModules,
  getRegistryGroups,
  isGroupFullyEnabled,
  isGroupPartiallyEnabled,
  setGroupItemsEnabled,
} from '../../config/featureRegistry';

export default function FeatureModulesAdmin() {
  const { admin, logout } = usePlatformAuth();
  const { reload: reloadPublicFlags } = useFeatureFlags();
  const { theme: t } = useTheme();
  const nav = useNavigate();
  const [modules, setModules] = useState(getDefaultFeatureModules);
  const [registry, setRegistry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [openGroups, setOpenGroups] = useState({});
  const [passwordFromEnv, setPasswordFromEnv] = useState(true);
  const [pwdForm, setPwdForm] = useState({
    current: '', newPwd: '', confirm: '',
  });
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdMessage, setPwdMessage] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [showPwdSection, setShowPwdSection] = useState(false);

  useEffect(() => {
    if (!admin) return;
    platformApi.get('/api/platform/features')
      .then(r => {
        setModules({ ...getDefaultFeatureModules(), ...(r.data?.modules || {}) });
        setRegistry(r.data?.registry || null);
        setPasswordFromEnv(r.data?.password_from_env !== false);
        const groups = r.data?.registry?.groups || getRegistryGroups();
        setOpenGroups(Object.fromEntries(groups.map(g => [g.id, true])));
      })
      .catch(() => setError('Could not load feature modules.'))
      .finally(() => setLoading(false));
  }, [admin]);

  if (!admin) return <Navigate to="/platform/login" replace />;

  const groups = registry?.groups || getRegistryGroups();

  const toggleItem = id => {
    setModules(prev => ({ ...prev, [id]: !prev[id] }));
    setMessage('');
  };

  const toggleGroup = groupId => {
    const enable = !isGroupFullyEnabled(modules, groupId);
    setModules(prev => setGroupItemsEnabled(prev, groupId, enable));
    setMessage('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await platformApi.put('/api/platform/features', { modules });
      await reloadPublicFlags();
      setMessage('Saved. Customer navigation updated for all users.');
    } catch {
      setError('Save failed. Check platform session and backend.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    logout();
    nav('/platform/login', { replace: true });
  };

  const handlePasswordChange = async e => {
    e.preventDefault();
    setPwdSaving(true);
    setPwdError('');
    setPwdMessage('');
    if (pwdForm.newPwd !== pwdForm.confirm) {
      setPwdError('New password and confirmation do not match.');
      setPwdSaving(false);
      return;
    }
    if (pwdForm.newPwd.length < 8) {
      setPwdError('New password must be at least 8 characters.');
      setPwdSaving(false);
      return;
    }
    try {
      await platformApi.post('/api/platform/change-password', {
        current_password: pwdForm.current,
        new_password: pwdForm.newPwd,
        confirm_password: pwdForm.confirm,
      });
      setPwdMessage('Platform password updated. Use the new password on next sign-in.');
      setPasswordFromEnv(false);
      setPwdForm({ current: '', newPwd: '', confirm: '' });
    } catch (err) {
      const detail = err.response?.data?.detail;
      setPwdError(typeof detail === 'string' ? detail : 'Password change failed.');
    } finally {
      setPwdSaving(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px', marginBottom: 10, borderRadius: 6,
    border: `1px solid ${t.inpBorder}`, background: t.inp, color: t.text,
    fontSize: 14, boxSizing: 'border-box',
  };

  const groupHeaderStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px',
    borderRadius: 8,
    border: `1px solid ${t.border}`,
    background: t.surface,
    cursor: 'pointer',
  };

  const itemRowStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px 10px 28px',
    borderBottom: `1px solid ${t.border}`,
    background: t.bg,
    cursor: 'pointer',
  };

  return (
    <div style={{ minHeight: '100vh', background: t.bg, color: t.text, padding: 24 }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <header style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 24, paddingBottom: 16, borderBottom: `1px solid ${t.border}`,
        }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 22, color: t.accent }}>Feature modules</h1>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: t.textMuted }}>
              Signed in as {admin.username} · per-menu item control
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            style={{
              padding: '8px 14px', borderRadius: 6, border: `1px solid ${t.border}`,
              background: t.surface, color: t.text, cursor: 'pointer', fontSize: 13,
            }}
          >
            Sign out
          </button>
        </header>

        <p style={{ fontSize: 13, color: t.textMuted, lineHeight: 1.55, marginBottom: 20 }}>
          Enable or disable each menu item individually. New pages added to
          {' '}
          <code style={{ fontSize: 12 }}>feature-registry.json</code>
          {' '}
          appear here automatically. Dashboard is always on.
        </p>

        {loading ? (
          <p style={{ color: t.textMuted }}>Loading…</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map(group => {
              const expanded = openGroups[group.id] !== false;
              const allOn = isGroupFullyEnabled(modules, group.id);
              const partial = isGroupPartiallyEnabled(modules, group.id);

              return (
                <div
                  key={group.id}
                  style={{ borderRadius: 8, border: `1px solid ${t.border}`, overflow: 'hidden' }}
                >
                  <div style={groupHeaderStyle}>
                    <button
                      type="button"
                      onClick={() => setOpenGroups(p => ({ ...p, [group.id]: !expanded }))}
                      style={{
                        flex: 1, display: 'flex', alignItems: 'center', gap: 10,
                        border: 'none', background: 'transparent', color: t.text,
                        cursor: 'pointer', textAlign: 'left', padding: 0,
                      }}
                    >
                      <span style={{ fontSize: 12, color: t.textMuted }}>{expanded ? '▼' : '▶'}</span>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>{group.label}</span>
                      <span style={{ fontSize: 11, color: t.textMuted }}>
                        ({(group.items || []).filter(i => modules[i.id] !== false).length}
                        /{(group.items || []).length} on)
                      </span>
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                      <span style={{ color: t.textMuted }}>All</span>
                      <input
                        type="checkbox"
                        checked={allOn}
                        ref={el => {
                          if (el) el.indeterminate = partial;
                        }}
                        onChange={() => toggleGroup(group.id)}
                        style={{ width: 18, height: 18, cursor: 'pointer' }}
                      />
                    </label>
                  </div>

                  {expanded && (group.items || []).map(item => (
                    <label key={item.id} style={itemRowStyle}>
                      <span style={{ fontSize: 14 }}>{item.label}</span>
                      <input
                        type="checkbox"
                        checked={modules[item.id] !== false}
                        onChange={() => toggleItem(item.id)}
                        style={{ width: 18, height: 18, cursor: 'pointer' }}
                      />
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {message && (
          <p style={{ marginTop: 16, color: '#16a34a', fontSize: 13 }}>{message}</p>
        )}
        {error && (
          <p style={{ marginTop: 16, color: '#ef4444', fontSize: 13 }}>{error}</p>
        )}

        <div style={{ marginTop: 24, display: 'flex', gap: 12 }}>
          <button
            type="button"
            disabled={saving || loading}
            onClick={handleSave}
            style={{
              padding: '10px 20px', borderRadius: 6, border: 'none',
              background: saving ? t.textFaint : t.accent, color: '#fff',
              fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <a href="/login" style={{ alignSelf: 'center', color: t.accent, fontSize: 13 }}>
            Open customer app
          </a>
        </div>

        <section style={{
          marginTop: 32, paddingTop: 24, borderTop: `1px solid ${t.border}`,
        }}
        >
          <button
            type="button"
            onClick={() => setShowPwdSection(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              border: 'none', background: 'transparent', color: t.accent,
              cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0,
            }}
          >
            <span>{showPwdSection ? '▼' : '▶'}</span>
            Change platform password
          </button>

          {passwordFromEnv && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: '#d97706' }}>
              Password is still from backend/.env — set a new password below to store it securely in the database.
            </p>
          )}

          {showPwdSection && (
            <form onSubmit={handlePasswordChange} style={{ marginTop: 16 }}>
              <input
                style={inputStyle}
                type="password"
                placeholder="Current password"
                value={pwdForm.current}
                onChange={e => setPwdForm(p => ({ ...p, current: e.target.value }))}
                autoComplete="current-password"
              />
              <input
                style={inputStyle}
                type="password"
                placeholder="New password (min 8 characters)"
                value={pwdForm.newPwd}
                onChange={e => setPwdForm(p => ({ ...p, newPwd: e.target.value }))}
                autoComplete="new-password"
              />
              <input
                style={inputStyle}
                type="password"
                placeholder="Confirm new password"
                value={pwdForm.confirm}
                onChange={e => setPwdForm(p => ({ ...p, confirm: e.target.value }))}
                autoComplete="new-password"
              />
              {pwdMessage && (
                <p style={{ color: '#16a34a', fontSize: 13, marginBottom: 8 }}>{pwdMessage}</p>
              )}
              {pwdError && (
                <p style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>{pwdError}</p>
              )}
              <button
                type="submit"
                disabled={pwdSaving}
                style={{
                  padding: '9px 18px', borderRadius: 6, border: `1px solid ${t.border}`,
                  background: t.surface, color: t.text, fontWeight: 600,
                  cursor: pwdSaving ? 'not-allowed' : 'pointer',
                }}
              >
                {pwdSaving ? 'Updating…' : 'Update password'}
              </button>
            </form>
          )}
        </section>

        <p style={{ marginTop: 32, fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
          Registry: frontend/src/config/feature-registry.json
          <br />
          Platform: /platform/modules · Initial credentials: PLATFORM_ADMIN_* in backend/.env
        </p>
      </div>
    </div>
  );
}
