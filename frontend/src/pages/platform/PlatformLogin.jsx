import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePlatformAuth } from '../../context/PlatformAuthContext';
import { useTheme } from '../../context/ThemeContext';
import ThemeModeToggler from '../../components/layout/ThemeModeToggler';

export default function PlatformLogin() {
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = usePlatformAuth();
  const nav = useNavigate();
  const { theme: t } = useTheme();

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(creds.username, creds.password);
      nav('/platform/modules', { replace: true });
    } catch {
      setError('Invalid platform credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: t.bg,
    }}
    >
      <div style={{
        background: t.surface, padding: 40, borderRadius: 12, width: 400,
        boxShadow: '0 4px 24px #0008', border: `1px solid ${t.border}`,
      }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <div>
            <h2 style={{ color: t.accent, margin: 0, fontSize: 20 }}>Platform Admin</h2>
            <p style={{ color: t.textMuted, margin: '6px 0 0', fontSize: 13 }}>
              Customer feature modules — not customer login
            </p>
          </div>
          <ThemeModeToggler />
        </div>
        <p style={{ color: t.textMuted, fontSize: 12, marginBottom: 20, lineHeight: 1.5 }}>
          Enable or disable Production, QC, Maintenance, Alerts, and Settings per deployment.
          Uses separate credentials from operator/admin users.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            style={{
              width: '100%', padding: '10px 12px', marginBottom: 12, borderRadius: 6,
              border: `1px solid ${t.inpBorder}`, background: t.inp, color: t.text,
              fontSize: 14, boxSizing: 'border-box',
            }}
            placeholder="Platform username"
            value={creds.username}
            autoFocus
            onChange={e => setCreds(p => ({ ...p, username: e.target.value }))}
          />
          <input
            style={{
              width: '100%', padding: '10px 12px', marginBottom: 12, borderRadius: 6,
              border: `1px solid ${t.inpBorder}`, background: t.inp, color: t.text,
              fontSize: 14, boxSizing: 'border-box',
            }}
            type="password"
            placeholder="Platform password"
            value={creds.password}
            onChange={e => setCreds(p => ({ ...p, password: e.target.value }))}
          />
          {error && (
            <div style={{
              background: '#ef444422', border: '1px solid #ef4444', borderRadius: 6,
              padding: '8px 12px', marginBottom: 12, color: '#ef4444', fontSize: 13,
            }}
            >
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '11px', background: loading ? t.textFaint : t.accent,
              color: '#fff', border: 'none', borderRadius: 6, fontSize: 15, fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Signing in…' : 'Platform sign in'}
          </button>
        </form>
        <p style={{ marginTop: 16, fontSize: 12, color: t.textMuted, textAlign: 'center' }}>
          <a href="/login" style={{ color: t.accent }}>Customer app login</a>
        </p>
      </div>
    </div>
  );
}
