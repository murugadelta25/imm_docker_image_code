import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import PageHeader from '../components/PageHeader';
import api from '../api/client';

export default function DatabaseManagement() {
  const { theme: t } = useTheme();
  const s = getStyles(t);

  const [backupCfg, setBackupCfg] = useState({ enabled: false, interval_days: 15, max_backups: 10 });
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [restoring, setRestoring] = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(null);

  const flash = (text, isErr = false) => {
    if (isErr) { setErr(text); setMsg(''); }
    else { setMsg(text); setErr(''); }
    setTimeout(() => { setMsg(''); setErr(''); }, 4000);
  };

  const fetchConfig = useCallback(async () => {
    try {
      const res = await api.get('/api/archive/config');
      setBackupCfg({
        enabled: res.data.enabled ?? false,
        interval_days: res.data.interval_days ?? 15,
        max_backups: res.data.max_backups ?? 10,
      });
    } catch { /* ignore — defaults remain */ }
    setConfigLoading(false);
  }, []);

  const fetchBackups = useCallback(async () => {
    try {
      const res = await api.get('/api/archive/list');
      setBackups(res.data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchConfig(); fetchBackups(); }, [fetchConfig, fetchBackups]);

  const saveConfig = async () => {
    try {
      await api.put('/api/archive/config', backupCfg);
      flash('Backup schedule saved');
    } catch (e) {
      flash(e.response?.data?.detail || 'Failed to save', true);
    }
  };

  const triggerBackup = async () => {
    setLoading(true);
    try {
      const res = await api.post('/api/archive/backup');
      flash(`Backup created: ${res.data.filename} (${res.data.size_display})`);
      fetchBackups();
    } catch (e) {
      flash(e.response?.data?.detail || 'Backup failed', true);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (filename) => {
    if (!window.confirm(`Delete backup "${filename}"?`)) return;
    try {
      await api.delete(`/api/archive/${filename}`);
      flash(`Deleted: ${filename}`);
      fetchBackups();
    } catch (e) {
      flash(e.response?.data?.detail || 'Delete failed', true);
    }
  };

  const handleRestore = async (filename) => {
    setConfirmRestore(null);
    setRestoring(filename);
    try {
      await api.post(`/api/archive/restore/${filename}`);
      flash(`Database restored from: ${filename}`);
    } catch (e) {
      flash(e.response?.data?.detail || 'Restore failed', true);
    } finally {
      setRestoring(null);
    }
  };

  const downloadBackup = (filename) => {
    const token = localStorage.getItem('token');
    const base = api.defaults.baseURL || '';
    const url = `${base}/api/archive/download/${filename}`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const u = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = u;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(u);
      });
  };

  const totalSize = backups.reduce((sum, b) => sum + (b.size_bytes || 0), 0);

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader title="🗄  DATABASE MANAGEMENT" />

      {/* ── Stats ── */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatCard t={t} label="Total Backups" value={backups.length} accent="#2563eb" />
        <StatCard t={t} label="Storage Used" value={humanSize(totalSize)} accent="#7c3aed" />
        <StatCard t={t} label="Auto Backup"
          value={backupCfg.enabled ? `Every ${backupCfg.interval_days} day(s)` : 'Disabled'}
          accent={backupCfg.enabled ? '#16a34a' : '#94a3b8'} />
        <StatCard t={t} label="Latest Backup"
          value={backups.length > 0 ? new Date(backups[0].created_at).toLocaleDateString() : 'None'}
          accent="#ea580c" />
      </div>

      {/* ── Schedule Settings ── */}
      <Section title="Backup Schedule" t={t}>
        {configLoading ? (
          <p style={{ color: t.textFaint, fontSize: 13 }}>Loading settings...</p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={s.label}>Automatic Backup:</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={backupCfg.enabled}
                    onChange={e => setBackupCfg(prev => ({ ...prev, enabled: e.target.checked }))} />
                  <span style={{ color: t.text, fontSize: 13, fontWeight: 600 }}>
                    {backupCfg.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={s.label}>Run every:</label>
                <input style={{ ...s.inp, width: 70 }} type="number" min="1" max="90"
                  value={backupCfg.interval_days}
                  onChange={e => setBackupCfg(prev => ({
                    ...prev, interval_days: Math.max(1, Math.min(90, parseInt(e.target.value) || 15)),
                  }))} />
                <span style={{ color: t.textDim, fontSize: 12 }}>days</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={s.label}>Max backups to keep:</label>
                <input style={{ ...s.inp, width: 70 }} type="number" min="1" max="100"
                  value={backupCfg.max_backups}
                  onChange={e => setBackupCfg(prev => ({
                    ...prev, max_backups: Math.max(1, Math.min(100, parseInt(e.target.value) || 10)),
                  }))} />
              </div>
            </div>

            <p style={{ color: t.textFaint, fontSize: 11, margin: '0 0 12px' }}>
              When enabled, the system creates a compressed database backup every N days and auto-deletes
              the oldest backups beyond the maximum count.
            </p>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button style={s.btn} onClick={saveConfig}>Save Schedule</button>
              <button style={{ ...s.btn, background: '#16a34a' }} onClick={triggerBackup} disabled={loading}>
                {loading ? 'Creating Backup...' : 'Create Backup Now'}
              </button>
              {msg && <span style={{ color: '#16a34a', fontSize: 12, fontWeight: 500 }}>✓ {msg}</span>}
              {err && <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 500 }}>✗ {err}</span>}
            </div>
          </>
        )}
      </Section>

      {/* ── Backup History ── */}
      <Section title="Backup History" t={t}>
        {backups.length === 0 ? (
          <div style={{ color: t.textFaint, fontSize: 13, textAlign: 'center', padding: '30px 0' }}>
            No backups yet. Click "Create Backup Now" to create your first backup.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['Backup File', 'Format', 'Created', 'Size', 'Trigger', 'Actions'].map(h =>
                    <th key={h} style={s.th}>{h}</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {backups.map(b => (
                  <tr key={b.filename} style={{ transition: 'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background = t.surface2}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={s.td}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{b.filename}</span>
                    </td>
                    <td style={s.td}>
                      <Badge bg={b.method === 'sql' ? '#2563eb' : '#7c3aed'}
                        label={b.method === 'sql' ? 'SQL Dump' : 'JSON'} />
                    </td>
                    <td style={s.td}>{new Date(b.created_at).toLocaleString()}</td>
                    <td style={s.td}>{b.size_display}</td>
                    <td style={s.td}>
                      <Badge bg={b.triggered_by === 'scheduled' ? '#16a34a' : '#ea580c'}
                        label={b.triggered_by} />
                    </td>
                    <td style={s.td}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <ActionBtn color="#2563eb" onClick={() => downloadBackup(b.filename)}>
                          ⬇ Download
                        </ActionBtn>
                        <ActionBtn color="#16a34a"
                          onClick={() => setConfirmRestore(b.filename)}
                          disabled={restoring === b.filename}>
                          {restoring === b.filename ? '...' : '🔄 Restore'}
                        </ActionBtn>
                        <ActionBtn color="#ef4444" onClick={() => handleDelete(b.filename)}>
                          🗑 Delete
                        </ActionBtn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Info ── */}
      <Section title="About Database Backups" t={t}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          <InfoCard t={t} title="Backup Method"
            text="Uses mysqldump (SQL) when available for full-fidelity database dumps. Falls back to JSON export if mysqldump is not installed." />
          <InfoCard t={t} title="What's Included"
            text="All 22+ tables: machines, production plans, OEE entries, work orders, QC reports, configurations, email logs, and more." />
          <InfoCard t={t} title="Storage"
            text="Backups are gzip-compressed and stored on the server. Use the Download button to save copies to external drives for off-site safety." />
          <InfoCard t={t} title="Restore"
            text="Restoring a backup will overwrite ALL current data with the backup snapshot. Always create a fresh backup before restoring an older one." />
        </div>
      </Section>

      {/* ── Restore Confirmation Modal ── */}
      {confirmRestore && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{
            background: t.surface, borderRadius: 12, padding: 24, maxWidth: 440, width: '90%',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          }}>
            <h4 style={{ color: '#ef4444', margin: '0 0 12px', fontSize: 16 }}>
              Confirm Database Restore
            </h4>
            <p style={{ color: t.text, fontSize: 13, lineHeight: 1.5, margin: '0 0 8px' }}>
              This will <strong>overwrite all current data</strong> with the backup:
            </p>
            <p style={{ color: t.accent, fontSize: 13, fontWeight: 600, fontFamily: 'monospace', margin: '0 0 16px' }}>
              {confirmRestore}
            </p>
            <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 20px' }}>
              This action cannot be undone. Create a backup of current data first.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                style={{ padding: '8px 20px', background: t.surface2, color: t.text, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                onClick={() => setConfirmRestore(null)}>
                Cancel
              </button>
              <button
                style={{ padding: '8px 20px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                onClick={() => handleRestore(confirmRestore)}>
                Restore Database
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, t, children }) {
  return (
    <div style={{ background: t.surface, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <h4 style={{ color: t.accent, margin: '0 0 12px', fontSize: 14 }}>{title}</h4>
      {children}
    </div>
  );
}

function StatCard({ t, label, value, accent }) {
  return (
    <div style={{
      background: t.surface, borderRadius: 10, padding: '14px 20px', minWidth: 160, flex: 1,
      borderLeft: `4px solid ${accent}`,
    }}>
      <div style={{ color: t.textDim, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ color: t.text, fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Badge({ bg, label }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
      background: `${bg}18`, color: bg,
    }}>
      {label}
    </span>
  );
}

function ActionBtn({ color, onClick, disabled, children }) {
  return (
    <button
      style={{
        padding: '4px 10px', background: color, color: '#fff', border: 'none',
        borderRadius: 5, cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 11, fontWeight: 500, opacity: disabled ? 0.5 : 1,
      }}
      onClick={onClick}
      disabled={disabled}>
      {children}
    </button>
  );
}

function InfoCard({ t, title, text }) {
  return (
    <div style={{ background: t.surface2 || t.bg, borderRadius: 8, padding: 14 }}>
      <div style={{ color: t.accent, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <p style={{ color: t.textMuted, fontSize: 12, lineHeight: 1.5, margin: 0 }}>{text}</p>
    </div>
  );
}

function humanSize(b) {
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (b < 1024) return `${b.toFixed(1)} ${unit}`;
    b /= 1024;
  }
  return `${b.toFixed(1)} TB`;
}

function getStyles(t) {
  return {
    page: { padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text },
    label: { color: t.textMuted, fontSize: 13 },
    inp: {
      padding: '6px 8px', borderRadius: 6, border: `1px solid ${t.inpBorder}`, background: t.inp,
      color: t.text, fontSize: 13, boxSizing: 'border-box',
    },
    btn: {
      padding: '8px 20px', background: t.accent, color: '#fff', border: 'none',
      borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
    th: { padding: '8px 10px', background: t.surface2, color: t.textDim, textAlign: 'left', fontSize: 11, fontWeight: 600 },
    td: { padding: '8px 10px', borderBottom: `1px solid ${t.surface2}`, color: t.text, fontSize: 12 },
  };
}
