import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFeatureFlags } from '../context/FeatureFlagsContext';
import { useBranding } from '../context/BrandingContext';
import { useTheme } from '../context/ThemeContext';
import ThemeModeToggler from '../components/layout/ThemeModeToggler';
import api from '../api/client';
import { SESSION_EXPIRED_KEY } from '../components/IdleTimeoutGuard';
import { isFeatureEnabled } from '../config/featureRegistry';

const EMPTY_RESET = {
  username: '',
  newPassword: '',
  confirmPassword: '',
  approverUsername: '',
  approverPassword: '',
};

export default function Login() {
  const [creds, setCreds] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [sessionNotice, setSessionNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [networkUrls, setNetworkUrls] = useState([]);
  const [showForgot, setShowForgot] = useState(false);
  const [resetForm, setResetForm] = useState(EMPTY_RESET);
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const { login } = useAuth();
  const { modules } = useFeatureFlags();
  const nav = useNavigate();
  const { theme: t } = useTheme();
  const { loginHeroUrl } = useBranding();

  useEffect(() => {
    const reason = sessionStorage.getItem(SESSION_EXPIRED_KEY);
    if (reason === 'idle') {
      setSessionNotice('Your session ended after 60 minutes of inactivity. Please sign in again.');
      sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    }
  }, []);

  useEffect(() => {
    api.get('/api/config/network')
      .then(r => {
        const urls = r.data?.access_urls;
        if (Array.isArray(urls) && urls.length) setNetworkUrls(urls);
      })
      .catch(() => {});
  }, []);

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    marginBottom: 12,
    borderRadius: 6,
    border: `1px solid ${t.inpBorder}`,
    background: t.inp,
    color: t.text,
    fontSize: 14,
    boxSizing: 'border-box',
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const role = await login(creds.username, creds.password);
      if (role === 'maintenance' && isFeatureEnabled('maintenance.dashboard', modules)) {
        nav('/maintenance');
      } else {
        nav('/dashboard');
      }
    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout') || err.code === 'ERR_NETWORK') {
        setError('Cannot reach the server. Make sure the backend is running on port 8040.');
      } else if (err.response?.status === 401) {
        setError('Invalid username or password.');
      } else if (err.response?.status >= 500) {
        setError('Server error — database may be misconfigured. Check backend logs and DATABASE_URL in backend/.env.');
      } else {
        setError('Cannot connect to server. Check that the backend is running.');
      }
    } finally {
      setLoading(false);
    }
  };

  const openForgot = () => {
    setShowForgot(true);
    setResetError('');
    setResetSuccess('');
    setResetForm({ ...EMPTY_RESET, username: creds.username || '' });
    setError('');
  };

  const closeForgot = () => {
    setShowForgot(false);
    setResetError('');
    setResetSuccess('');
    setResetForm(EMPTY_RESET);
  };

  const handleResetPassword = async e => {
    e.preventDefault();
    setResetError('');
    setResetSuccess('');

    if (resetForm.newPassword !== resetForm.confirmPassword) {
      setResetError('New password and confirmation do not match.');
      return;
    }
    if (resetForm.newPassword.length < 4) {
      setResetError('New password must be at least 4 characters.');
      return;
    }

    setResetLoading(true);
    try {
      const r = await api.post('/api/auth/forgot-password', {
        username: resetForm.username.trim(),
        new_password: resetForm.newPassword,
        approver_username: resetForm.approverUsername.trim(),
        approver_password: resetForm.approverPassword,
      });
      setResetSuccess(r.data?.message || 'Password reset. You can sign in now.');
      setCreds(p => ({ ...p, username: resetForm.username.trim(), password: '' }));
      setResetForm(f => ({ ...f, newPassword: '', confirmPassword: '', approverPassword: '' }));
    } catch (err) {
      const detail = err.response?.data?.detail;
      setResetError(typeof detail === 'string' ? detail : 'Password reset failed. Check details and try again.');
    } finally {
      setResetLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.bg, transition: 'background 0.2s' }}>
      <div style={{ background: t.surface, padding: 40, borderRadius: 12, width: 400, boxShadow: '0 4px 24px #0008', border: `1px solid ${t.border}` }}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          marginBottom: 8,
          gap: 12,
        }}>
          <img
            src={loginHeroUrl || '/din_pms.png'}
            alt="Production Monitoring System"
            style={{
              height: 100,
              maxWidth: 300,
              width: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
            onError={(e) => {
              if (!e.currentTarget.src.includes('/din_pms.png')) {
                e.currentTarget.src = '/din_pms.png';
              }
            }}
          />
          <h2 style={{
            color: t.accent,
            margin: 0,
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: '0.3px',
            lineHeight: 1.35,
          }}>
            Production Monitoring System (PMS)
          </h2>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
          <ThemeModeToggler />
        </div>

        {!showForgot ? (
          <form onSubmit={handleSubmit}>
            <input
              style={inputStyle}
              placeholder="Username"
              value={creds.username}
              autoFocus
              onChange={e => setCreds(p => ({ ...p, username: e.target.value }))}
            />
            <input
              style={inputStyle}
              type="password"
              placeholder="Password"
              value={creds.password}
              onChange={e => setCreds(p => ({ ...p, password: e.target.value }))}
            />
            {sessionNotice && (
              <div style={{ background: '#f59e0b22', border: '1px solid #f59e0b', borderRadius: 6,
                            padding: '8px 12px', marginBottom: 12 }}>
                <p style={{ color: '#d97706', fontSize: 13, margin: 0 }}>{sessionNotice}</p>
              </div>
            )}
            {error && (
              <div style={{ background: '#ef444422', border: '1px solid #ef4444', borderRadius: 6,
                            padding: '8px 12px', marginBottom: 12 }}>
                <p style={{ color: '#ef4444', fontSize: 13, margin: 0 }}>⚠ {error}</p>
              </div>
            )}
            <button
              style={{ width: '100%', padding: '11px', background: loading ? t.textFaint : t.accent,
                       color: '#fff', border: 'none', borderRadius: 6, fontSize: 15,
                       fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer' }}
              type="submit"
              disabled={loading}
            >
              {loading ? 'Connecting...' : 'Login'}
            </button>
            <button
              type="button"
              onClick={openForgot}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 14,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: t.accent,
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'center',
                textDecoration: 'underline',
              }}
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleResetPassword}>
            <h3 style={{ color: t.text, margin: '0 0 6px', fontSize: 16 }}>Reset password</h3>
            <p style={{ color: t.textMuted, margin: '0 0 14px', fontSize: 12, lineHeight: 1.4 }}>
              Works for all roles (operator → superadmin). An <strong>admin</strong> or <strong>superadmin</strong> must authorize the reset.
            </p>
            <input
              style={inputStyle}
              placeholder="Username to reset"
              value={resetForm.username}
              autoFocus
              required
              onChange={e => setResetForm(p => ({ ...p, username: e.target.value }))}
            />
            <input
              style={inputStyle}
              type="password"
              placeholder="New password"
              value={resetForm.newPassword}
              required
              onChange={e => setResetForm(p => ({ ...p, newPassword: e.target.value }))}
            />
            <input
              style={inputStyle}
              type="password"
              placeholder="Confirm new password"
              value={resetForm.confirmPassword}
              required
              onChange={e => setResetForm(p => ({ ...p, confirmPassword: e.target.value }))}
            />
            <div style={{ height: 1, background: t.border, margin: '4px 0 14px' }} />
            <p style={{ color: t.textMuted, margin: '0 0 10px', fontSize: 12 }}>
              Approver (admin / superadmin)
            </p>
            <input
              style={inputStyle}
              placeholder="Approver username"
              value={resetForm.approverUsername}
              required
              onChange={e => setResetForm(p => ({ ...p, approverUsername: e.target.value }))}
            />
            <input
              style={inputStyle}
              type="password"
              placeholder="Approver password"
              value={resetForm.approverPassword}
              required
              onChange={e => setResetForm(p => ({ ...p, approverPassword: e.target.value }))}
            />
            {resetError && (
              <div style={{ background: '#ef444422', border: '1px solid #ef4444', borderRadius: 6,
                            padding: '8px 12px', marginBottom: 12 }}>
                <p style={{ color: '#ef4444', fontSize: 13, margin: 0 }}>⚠ {resetError}</p>
              </div>
            )}
            {resetSuccess && (
              <div style={{ background: '#10b98122', border: '1px solid #10b981', borderRadius: 6,
                            padding: '8px 12px', marginBottom: 12 }}>
                <p style={{ color: '#059669', fontSize: 13, margin: 0 }}>✓ {resetSuccess}</p>
              </div>
            )}
            <button
              style={{ width: '100%', padding: '11px', background: resetLoading ? t.textFaint : t.accent,
                       color: '#fff', border: 'none', borderRadius: 6, fontSize: 15,
                       fontWeight: 600, cursor: resetLoading ? 'not-allowed' : 'pointer' }}
              type="submit"
              disabled={resetLoading}
            >
              {resetLoading ? 'Resetting...' : 'Reset password'}
            </button>
            <button
              type="button"
              onClick={closeForgot}
              style={{
                display: 'block',
                width: '100%',
                marginTop: 14,
                padding: 0,
                border: 'none',
                background: 'transparent',
                color: t.textMuted,
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              ← Back to login
            </button>
          </form>
        )}

        {networkUrls.length > 0 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${t.border}` }}>
            <p style={{ color: t.textMuted, fontSize: 12, margin: '0 0 8px' }}>
              LAN access (Windows, Ubuntu, Android):
            </p>
            {networkUrls.map(url => (
              <a
                key={url}
                href={url}
                style={{ display: 'block', color: t.accent, fontSize: 12, marginBottom: 4, wordBreak: 'break-all' }}
              >
                {url}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
