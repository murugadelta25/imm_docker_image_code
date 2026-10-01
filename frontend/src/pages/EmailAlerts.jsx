import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import PageHeader from '../components/PageHeader';

const REPORT_OPTIONS = [
  { key: 'oee',          label: 'OEE / Production' },
  { key: 'planning',     label: 'Planning' },
  { key: 'breakdown',    label: 'Breakdown' },
  { key: 'maintenance',  label: 'Maintenance' },
  { key: 'data_entry',   label: 'Data Entry' },
  { key: 'loss_tracker', label: 'LOSS TRACKER' },
  { key: 'tools',        label: 'Mold Management' },
  { key: 'deviation_alerts', label: 'Deviation Alerts (real-time)' },
];
const REPORT_DEFAULTS_BY_NAME = {
  management: ['oee','planning','breakdown','maintenance','tools','deviation_alerts'],
  production:  ['oee','planning','breakdown','tools','deviation_alerts'],
  maintenance: ['breakdown','maintenance','tools','deviation_alerts'],
};

const GROUP_COLORS = { production: '#0ea5e9', maintenance: '#f59e0b', management: '#8b5cf6' };
const GROUP_ICONS  = { production: '🏭', maintenance: '🔧', management: '👔' };

const TABS = ['SMTP Settings', 'Email Groups', 'Schedules', 'Send Now', 'Deviation Alerts'];

export default function EmailAlerts() {
  const { user } = useAuth();
  const [tab, setTab]           = useState(0);
  const [groups, setGroups]     = useState([]);
  const [schedules, setSchedules] = useState([]);
  const { theme: t } = useTheme();
  const s = getStyles(t);
  const [smtp, setSmtp]         = useState({ smtp_server:'smtp.gmail.com', smtp_port:587, email_address:'', email_password:'' });
  const [smtpMsg, setSmtpMsg]   = useState('');
  const [newGroup, setNewGroup] = useState({ name:'', description:'', report_types:[] });
  const [groupMsg, setGroupMsg] = useState('');
  const [editGroup, setEditGroup] = useState(null); // { id, name, description, report_types[] }
  const [editRecip, setEditRecip] = useState(null); // { id, group_id, name, email, active }
  const [newRecip, setNewRecip] = useState({ group_id:'', name:'', email:'' });
  const [recipMsg, setRecipMsg] = useState('');
  const [newSched, setNewSched] = useState({ name:'', group_ids:'', report_type:'daily', send_hour:18, send_minute:0, attach_report:1, active:1 });
  const [schedMsg, setSchedMsg] = useState('');
  const [sendForm, setSendForm] = useState({
    group_ids:[], subject:'', body:'', attach_report:false, report_type:'daily',
    report_date: new Date(Date.now() - 86400000).toISOString().slice(0,10) // yesterday
  });
  const [sendMsg, setSendMsg]   = useState('');
  const [sendResult, setSendResult] = useState(null);
  const [selectedGroups, setSelectedGroups] = useState({});
  const [deviationConfig, setDeviationConfig] = useState(null);
  const [deviationAlerts, setDeviationAlerts] = useState([]);
  const [deviationSummary, setDeviationSummary] = useState(null);
  const [deviationMsg, setDeviationMsg] = useState('');
  const [escalationDraft, setEscalationDraft] = useState(null);
  const [escalationMsg, setEscalationMsg] = useState('');
  const isAdmin = user?.role === 'admin';

  const fetchDeviationAlerts = useCallback(async () => {
    try {
      const [cfg, alerts, summary] = await Promise.all([
        api.get('/api/deviation-alerts/config'),
        api.get('/api/deviation-alerts/'),
        api.get('/api/deviation-alerts/summary'),
      ]);
      setDeviationConfig(cfg.data);
      setDeviationAlerts(alerts.data.alerts || []);
      setDeviationSummary(summary.data);
      setEscalationDraft(cfg.data.escalation || null);
    } catch {
      setDeviationConfig(null);
      setDeviationAlerts([]);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    const [g, s] = await Promise.all([api.get('/api/email/groups'), api.get('/api/email/schedules')]);
    setGroups(g.data);
    setSchedules(s.data);
  }, []);

  useEffect(() => {
    fetchAll();
    api.get('/api/email/smtp').then(r => {
      if (r.data.email_address) setSmtp(p => ({ ...p, ...r.data, email_password: '' }));
    }).catch(() => {});
  }, [fetchAll]);

  useEffect(() => {
    if (tab === 4) fetchDeviationAlerts();
  }, [tab, fetchDeviationAlerts]);

  // SMTP
  const saveSmtp = async e => {
    e.preventDefault();
    try {
      await api.post('/api/email/smtp', smtp);
      setSmtpMsg('✓ SMTP settings saved');
    } catch (err) { setSmtpMsg('✗ ' + (err.response?.data?.detail || 'Error')); }
  };
  const testSmtp = async () => {
    try {
      const r = await api.post('/api/email/smtp/test');
      setSmtpMsg('✓ ' + r.data.message);
    } catch (err) { setSmtpMsg('✗ ' + (err.response?.data?.detail || 'Connection failed')); }
  };

  // Groups
  const createGroup = async e => {
    e.preventDefault();
    const rts = newGroup.report_types.length
      ? newGroup.report_types.join(',')
      : (REPORT_DEFAULTS_BY_NAME[newGroup.name.toLowerCase()] || ['oee','planning','breakdown']).join(',');
    try {
      await api.post('/api/email/groups', { ...newGroup, report_types: rts });
      setNewGroup({ name:'', description:'', report_types:[] });
      setGroupMsg('✓ Group created');
      fetchAll();
    } catch (err) { setGroupMsg('✗ ' + (err.response?.data?.detail || 'Error')); }
  };
  const toggleGroupReport = key =>
    setNewGroup(p => ({
      ...p,
      report_types: p.report_types.includes(key)
        ? p.report_types.filter(r => r !== key)
        : [...p.report_types, key]
    }));
  const deleteGroup = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Delete this group and all its recipients?')) return;
    try {
      await api.delete(`/api/email/groups/${id}`);
      fetchAll();
    } catch (err) { setGroupMsg('✗ ' + (err.response?.data?.detail || 'Delete failed')); }
  };

  const startEditGroup = (g) => setEditGroup({
    id: g.id, name: g.name, description: g.description || '',
    report_types: (g.report_types || '').split(',').map(r => r.trim()).filter(Boolean)
  });

  const saveEditGroup = async () => {
    try {
      await api.patch(`/api/email/groups/${editGroup.id}`, {
        name: editGroup.name,
        description: editGroup.description,
        report_types: editGroup.report_types.join(',')
      });
      setEditGroup(null);
      setGroupMsg('✓ Group updated');
      fetchAll();
    } catch (err) { setGroupMsg('✗ ' + (err.response?.data?.detail || 'Update failed')); }
  };

  const toggleEditGroupReport = key =>
    setEditGroup(p => ({
      ...p,
      report_types: p.report_types.includes(key)
        ? p.report_types.filter(r => r !== key)
        : [...p.report_types, key]
    }));

  const saveEditRecip = async () => {
    try {
      await api.patch(`/api/email/recipients/${editRecip.id}`, editRecip);
      setEditRecip(null);
      fetchAll();
    } catch (err) { setGroupMsg('✗ ' + (err.response?.data?.detail || 'Update failed')); }
  };

  // Recipients
  const addRecipient = async e => {
    e.preventDefault();
    try {
      await api.post('/api/email/recipients', newRecip);
      setNewRecip({ group_id:'', name:'', email:'' });
      setRecipMsg('✓ Recipient added');
      fetchAll();
    } catch (err) { setRecipMsg('✗ ' + (err.response?.data?.detail || 'Error')); }
  };
  const deleteRecipient = async id => {
    await api.delete(`/api/email/recipients/${id}`);
    fetchAll();
  };
  const toggleActive = async (r) => {
    await api.patch(`/api/email/recipients/${r.id}`, { ...r, active: r.active ? 0 : 1 });
    fetchAll();
  };

  // Schedules
  const saveSchedule = async e => {
    e.preventDefault();
    const gids = Object.entries(selectedGroups).filter(([,v])=>v).map(([k])=>k).join(',');
    if (!gids) { setSchedMsg('✗ Select at least one group'); return; }
    try {
      await api.post('/api/email/schedules', { ...newSched, group_ids: gids });
      setNewSched({ name:'', group_ids:'', report_type:'daily', send_hour:18, send_minute:0, attach_report:1, active:1 });
      setSelectedGroups({});
      setSchedMsg('✓ Schedule saved');
      fetchAll();
    } catch (err) { setSchedMsg('✗ ' + (err.response?.data?.detail || 'Error')); }
  };
  const deleteSchedule = async id => {
    await api.delete(`/api/email/schedules/${id}`);
    fetchAll();
  };
  const toggleSchedule = async s => {
    await api.patch(`/api/email/schedules/${s.id}`, { ...s, active: s.active ? 0 : 1 });
    fetchAll();
  };

  // Manual Send
  const sendNow = async e => {
    e.preventDefault();
    if (sendForm.group_ids.length === 0) { setSendMsg('✗ Select at least one group'); return; }
    setSendResult(null);
    try {
      const r = await api.post('/api/email/send', sendForm);
      setSendMsg('');
      setSendResult({ ...r.data, sent_at: (() => { const d = new Date(); const p = n => String(n).padStart(2,'0'); return `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })() });
    } catch (err) { setSendMsg('✗ ' + (err.response?.data?.detail || 'Error')); }
  };
  const toggleSendGroup = id => {
    setSendForm(p => ({
      ...p,
      group_ids: p.group_ids.includes(id) ? p.group_ids.filter(x => x !== id) : [...p.group_ids, id]
    }));
  };

  const groupName = id => groups.find(g => g.id === parseInt(id))?.name || id;

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader title="ALERTS & EMAIL CONFIGURATION" onRefresh={fetchAll} />

      {/* Tabs */}
      <div style={s.tabs}>
        {TABS.map((t, i) => (
          <button key={i} style={{ ...s.tab, ...(tab === i ? s.tabActive : {}) }} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {/* ── Tab 0: SMTP ── */}
      {tab === 0 && (
        <div style={s.card}>
          <h4 style={s.cardTitle}>SMTP Email Server Configuration</h4>
          <form onSubmit={saveSmtp} style={s.formGrid}>
            <FField label="SMTP Server">
              <input style={s.inp} value={smtp.smtp_server} onChange={e => setSmtp(p=>({...p,smtp_server:e.target.value}))} />
            </FField>
            <FField label="SMTP Port">
              <input style={s.inp} type="number" value={smtp.smtp_port} onChange={e => setSmtp(p=>({...p,smtp_port:parseInt(e.target.value)}))} />
            </FField>
            <FField label="From Email Address">
              <input style={s.inp} type="email" value={smtp.email_address} onChange={e => setSmtp(p=>({...p,email_address:e.target.value}))} required />
            </FField>
            <FField label="App Password">
              <input style={s.inp} type="password" value={smtp.email_password} placeholder="Google App Password"
                onChange={e => setSmtp(p=>({...p,email_password:e.target.value}))} />
            </FField>
            <div style={{ gridColumn:'span 2', display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
              <button style={s.btn} type="submit">Save Settings</button>
              <button style={{ ...s.btn, background:t.surface2, color:t.text }} type="button" onClick={testSmtp}>Test Connection</button>
              {smtpMsg && <span style={{ color: smtpMsg.startsWith('✓') ? '#10b981':'#ef4444', fontSize:13 }}>{smtpMsg}</span>}
            </div>
          </form>
          <div style={s.infoBox}>
            <b style={{ color:t.accent }}>Gmail Setup:</b> Enable 2FA → Google Account → Security → App Passwords → Generate password for "Mail"
          </div>
        </div>
      )}

      {/* ── Tab 1: Groups & Recipients ── */}
      {tab === 1 && (
        <div>
          {/* Create Group */}
          <div style={s.card}>
            <h4 style={s.cardTitle}>Create Email Group</h4>
            <form onSubmit={createGroup} style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'flex-end' }}>
              <FField label="Group Name">
                <input style={s.inp} value={newGroup.name} onChange={e=>setNewGroup(p=>({...p,name:e.target.value}))} placeholder="e.g. Management" required />
              </FField>
              <FField label="Description">
                <input style={s.inp} value={newGroup.description} onChange={e=>setNewGroup(p=>({...p,description:e.target.value}))} placeholder="Optional description" />
              </FField>
              <FField label="Reports to attach" wide>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {REPORT_OPTIONS.map(r => {
                    const checked = newGroup.report_types.includes(r.key);
                    return (
                      <label key={r.key} style={{ ...s.checkLabel, borderColor: checked ? t.accent : t.surface2,
                                                  background: checked ? t.accent+'22' : 'transparent', fontSize:12 }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleGroupReport(r.key)}
                          style={{ accentColor: t.accent }} />
                        <span style={{ color: checked ? t.accent : t.textMuted }}>{r.label}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ color:t.textDim, fontSize:11, marginTop:4 }}>Leave unchecked to use default for group name</div>
              </FField>
              <button style={s.btn} type="submit">+ Create Group</button>
              {groupMsg && <span style={{ color:groupMsg.startsWith('✓')?'#10b981':'#ef4444', fontSize:13 }}>{groupMsg}</span>}
            </form>
          </div>

          {/* Add Recipient */}
          <div style={s.card}>
            <h4 style={s.cardTitle}>Add Recipient</h4>
            <form onSubmit={addRecipient} style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'flex-end' }}>
              <FField label="Group">
                <select style={s.inp} value={newRecip.group_id} onChange={e=>setNewRecip(p=>({...p,group_id:parseInt(e.target.value)}))} required>
                  <option value="">Select Group</option>
                  {groups.map(g=><option key={g.id} value={g.id}>{GROUP_ICONS[g.name]||'👤'} {g.name}</option>)}
                </select>
              </FField>
              <FField label="Name">
                <input style={s.inp} value={newRecip.name} onChange={e=>setNewRecip(p=>({...p,name:e.target.value}))} required />
              </FField>
              <FField label="Email">
                <input style={s.inp} type="email" value={newRecip.email} onChange={e=>setNewRecip(p=>({...p,email:e.target.value}))} required />
              </FField>
              <button style={s.btn} type="submit">Add</button>
              {recipMsg && <span style={{ color:recipMsg.startsWith('✓')?'#10b981':'#ef4444', fontSize:13 }}>{recipMsg}</span>}
            </form>
          </div>

          {/* Groups with members */}
          <div style={s.groupGrid}>
            {groups.length === 0 && (
              <p style={{ color:t.textMuted, gridColumn:'1/-1' }}>No groups yet. Create one above to get started.</p>
            )}
            {groups.map(g => {
              const color = GROUP_COLORS[g.name] || t.textMuted;
              const icon  = GROUP_ICONS[g.name]  || '👤';
              const isEditing = editGroup?.id === g.id;
              return (
                <div key={g.id} style={{ ...s.groupCard, borderTop:`3px solid ${color}` }}>
                  <div style={s.groupHeader2}>
                    <span style={{ color, fontWeight:700, fontSize:15 }}>{icon} {g.name}</span>
                    <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                      <span style={{ ...s.badge, background:color+'22', color }}>{g.count} active</span>
                      <button style={{ ...s.miniBtn, background: isEditing ? t.surface2 : '#0ea5e9' }}
                        onClick={() => isEditing ? setEditGroup(null) : startEditGroup(g)}
                        title={isEditing ? 'Cancel edit' : 'Edit group'}>
                        {isEditing ? '✕' : '✏'}
                      </button>
                      <button style={{ ...s.miniBtn, background:'#ef4444' }} onClick={e => deleteGroup(e, g.id)} title="Delete group">🗑</button>
                    </div>
                  </div>

                  {/* ── Inline Edit Form ── */}
                  {isEditing ? (
                    <div style={{ marginBottom:12 }}>
                      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:8 }}>
                        <div style={{ flex:1, minWidth:120 }}>
                          <label style={{ color:t.textDim, fontSize:11 }}>Group Name</label>
                          <input style={{ ...s.inp, marginTop:3 }} value={editGroup.name}
                            onChange={e => setEditGroup(p=>({...p, name:e.target.value}))} />
                        </div>
                        <div style={{ flex:2, minWidth:160 }}>
                          <label style={{ color:t.textDim, fontSize:11 }}>Description</label>
                          <input style={{ ...s.inp, marginTop:3 }} value={editGroup.description}
                            onChange={e => setEditGroup(p=>({...p, description:e.target.value}))} />
                        </div>
                      </div>
                      <label style={{ color:t.textDim, fontSize:11, display:'block', marginBottom:6 }}>Reports to attach</label>
                      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
                        {REPORT_OPTIONS.map(r => {
                          const checked = editGroup.report_types.includes(r.key);
                          return (
                            <label key={r.key} style={{ ...s.checkLabel, fontSize:11,
                              borderColor: checked ? color : t.surface2,
                              background: checked ? color+'22' : 'transparent' }}>
                              <input type="checkbox" checked={checked}
                                onChange={() => toggleEditGroupReport(r.key)}
                                style={{ accentColor: color }} />
                              <span style={{ color: checked ? color : t.textMuted }}>{r.label}</span>
                            </label>
                          );
                        })}
                      </div>
                      <button style={{ ...s.btn, fontSize:12, padding:'6px 14px' }} onClick={saveEditGroup}>💾 Save Group</button>
                    </div>
                  ) : (
                    <>
                      <p style={{ color:t.textMuted, fontSize:12, margin:'0 0 6px' }}>{g.description}</p>
                      <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:10 }}>
                        {(g.report_types||'').split(',').filter(Boolean).map(r => (
                          <span key={r} style={{ padding:'2px 7px', borderRadius:8, fontSize:10, fontWeight:600,
                            background: color+'22', color, border:`1px solid ${color}44` }}>
                            {REPORT_OPTIONS.find(o=>o.key===r.trim())?.label || r}
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {g.members.length === 0 && <p style={{ color:t.textDim, fontSize:12 }}>No recipients yet</p>}
                  {g.members.map(m => (
                    <div key={m.id}>
                      {editRecip?.id === m.id ? (
                        <div style={{ display:'flex', gap:6, flexWrap:'wrap', alignItems:'center',
                                      padding:'6px 0', borderBottom:`1px solid ${t.surface2}` }}>
                          <input style={{ ...s.inp, flex:1, minWidth:80 }} placeholder="Name"
                            value={editRecip.name} onChange={e => setEditRecip(p=>({...p, name:e.target.value}))} />
                          <input style={{ ...s.inp, flex:2, minWidth:140 }} placeholder="Email"
                            value={editRecip.email} onChange={e => setEditRecip(p=>({...p, email:e.target.value}))} />
                          <button style={{ ...s.miniBtn, background:'#10b981' }} onClick={saveEditRecip}>💾</button>
                          <button style={{ ...s.miniBtn, background:t.surface2, color:t.text }} onClick={() => setEditRecip(null)}>✕</button>
                        </div>
                      ) : (
                        <div style={{ ...s.memberRow, opacity: m.active ? 1 : 0.4 }}>
                          <div style={{ flex:1 }}>
                            <div style={{ color:t.text, fontSize:13 }}>{m.name}</div>
                            <div style={{ color:t.textMuted, fontSize:11 }}>{m.email}</div>
                          </div>
                          <button style={{ ...s.miniBtn, background:'#0ea5e9' }}
                            onClick={() => setEditRecip({ id:m.id, group_id:m.group_id || g.id, name:m.name, email:m.email, active:m.active })}
                            title="Edit recipient">✏</button>
                          <button style={{ ...s.miniBtn, background: m.active ? '#f59e0b' : t.surface2 }}
                            onClick={() => toggleActive(m)} title={m.active?'Disable':'Enable'}>
                            {m.active ? '✓' : '✗'}
                          </button>
                          <button style={{ ...s.miniBtn, background:'#ef4444' }}
                            onClick={() => deleteRecipient(m.id)}>🗑</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Tab 2: Schedules ── */}
      {tab === 2 && (
        <div>
          <div style={s.card}>
            <h4 style={s.cardTitle}>Create Automatic Schedule</h4>
            <form onSubmit={saveSchedule}>
              <div style={s.formGrid}>
                <FField label="Schedule Name">
                  <input style={s.inp} value={newSched.name} onChange={e=>setNewSched(p=>({...p,name:e.target.value}))} required />
                </FField>
                <FField label="Report Type">
                  <select style={s.inp} value={newSched.report_type} onChange={e=>setNewSched(p=>({...p,report_type:e.target.value}))}>
                    <option value="daily">Daily</option>
                    <option value="shift">Shift</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </FField>
                <FField label="Send Hour (0-23)">
                  <input style={s.inp} type="number" min="0" max="23" value={newSched.send_hour}
                    onChange={e=>setNewSched(p=>({...p,send_hour:parseInt(e.target.value)||0}))} />
                </FField>
                <FField label="Send Minute (0-59)">
                  <input style={s.inp} type="number" min="0" max="59" value={newSched.send_minute}
                    onChange={e=>setNewSched(p=>({...p,send_minute:parseInt(e.target.value)||0}))} />
                </FField>
              </div>

              {/* Group checkboxes */}
              <div style={{ marginBottom:14 }}>
                <label style={{ color:t.textDim, fontSize:11, display:'block', marginBottom:8 }}>Send To Groups</label>
                <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                  {groups.map(g => {
                    const color = GROUP_COLORS[g.name] || t.textMuted;
                    const checked = !!selectedGroups[g.id];
                    return (
                      <label key={g.id} style={{ ...s.checkLabel, borderColor: checked ? color : t.surface2,
                                                  background: checked ? color+'22' : 'transparent' }}>
                        <input type="checkbox" checked={checked}
                          onChange={() => setSelectedGroups(p=>({...p,[g.id]:!p[g.id]}))}
                          style={{ accentColor: color }} />
                        <span style={{ color: checked ? color : t.textMuted }}>
                          {GROUP_ICONS[g.name]||'👤'} {g.name} ({g.count})
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <label style={s.checkLabel2}>
                <input type="checkbox" checked={!!newSched.attach_report}
                  onChange={e=>setNewSched(p=>({...p,attach_report:e.target.checked?1:0}))} />
                <span style={{ color:t.textMuted, fontSize:13 }}>Attach CSV Reports</span>
              </label>

              <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center' }}>
                <button style={s.btn} type="submit">Save Schedule</button>
                {schedMsg && <span style={{ color:schedMsg.startsWith('✓')?'#10b981':'#ef4444', fontSize:13 }}>{schedMsg}</span>}
              </div>
            </form>
          </div>

          {/* Existing schedules */}
          <div style={s.card}>
            <h4 style={s.cardTitle}>Active Schedules</h4>
            {schedules.length === 0 && <p style={{ color:t.textMuted }}>No schedules configured.</p>}
            {schedules.map(s2 => (
              <div key={s2.id} style={{ ...s.schedRow, opacity: s2.active ? 1 : 0.5 }}>
                <div style={{ flex:1 }}>
                  <div style={{ color:t.text, fontWeight:600, fontSize:14 }}>{s2.name}</div>
                  <div style={{ color:t.textMuted, fontSize:12, marginTop:2 }}>
                    🕐 {String(s2.send_hour).padStart(2,'0')}:{String(s2.send_minute).padStart(2,'0')} daily &nbsp;|&nbsp;
                    📋 {s2.report_type} &nbsp;|&nbsp;
                    👥 {s2.group_ids.split(',').map(id=>groupName(id)).join(', ')} &nbsp;|&nbsp;
                    📎 {s2.attach_report ? 'With reports' : 'No attachment'}
                  </div>
                  {s2.last_sent && (() => {
                    const d = new Date(s2.last_sent.replace(' IST','').replace(' ','T'));
                    const p = n => String(n).padStart(2,'0');
                    const fmt = isNaN(d) ? s2.last_sent : `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} IST`;
                    return <div style={{ color:'#e6b83b', fontSize:11 }}>Last sent: {fmt}</div>;
                  })()}
                </div>
                <button style={{ ...s.miniBtn, background: s2.active ? '#f59e0b' : t.surface2 }}
                  onClick={() => toggleSchedule(s2)}>{s2.active ? 'Disable' : 'Enable'}</button>
                <button style={{ ...s.miniBtn, background:'#ef4444' }} onClick={() => deleteSchedule(s2.id)}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Tab 3: Send Now ── */}
      {tab === 3 && (
        <div style={s.card}>
          <h4 style={s.cardTitle}>Send Email Now</h4>
          <form onSubmit={sendNow}>
            {/* Group selection */}
            <div style={{ marginBottom:14 }}>
              <label style={{ color:t.textDim, fontSize:11, display:'block', marginBottom:8 }}>Select Recipient Groups</label>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                {groups.map(g => {
                  const color = GROUP_COLORS[g.name] || t.textMuted;
                  const checked = sendForm.group_ids.includes(g.id);
                  return (
                    <label key={g.id} style={{ ...s.checkLabel, borderColor: checked ? color : t.surface2,
                                               background: checked ? color+'22' : 'transparent' }}>
                      <input type="checkbox" checked={checked} onChange={() => toggleSendGroup(g.id)}
                        style={{ accentColor: color }} />
                      <span style={{ color: checked ? color : t.textMuted }}>
                        {GROUP_ICONS[g.name]||'👤'} {g.name} ({g.count} recipients)
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div style={s.formGrid}>
              <FField label="Report Date (data to attach)">
                <input style={s.inp} type="date" value={sendForm.report_date}
                  onChange={e => setSendForm(p => ({ ...p, report_date: e.target.value }))}
                  max={new Date().toISOString().slice(0,10)} />
                <span style={{ color: t.textFaint, fontSize: 11, marginTop: 2 }}>Defaults to yesterday — change to send any past date's data</span>
              </FField>
              <FField label="Subject" wide>
                <input style={s.inp} value={sendForm.subject}
                  onChange={e=>setSendForm(p=>({...p,subject:e.target.value}))} required
                  placeholder="e.g. Daily Production Report - 02-03-2026" />
              </FField>
              <FField label="Message Body" wide>
                <textarea style={{ ...s.inp, minHeight:80, resize:'vertical' }} value={sendForm.body}
                  onChange={e=>setSendForm(p=>({...p,body:e.target.value}))} required
                  placeholder="Email body text..." />
              </FField>
            </div>

            <label style={s.checkLabel2}>
              <input type="checkbox" checked={sendForm.attach_report}
                onChange={e=>setSendForm(p=>({...p,attach_report:e.target.checked}))} />
              <span style={{ color:t.textMuted, fontSize:13 }}>Attach OEE + Planning + Breakdown CSV reports</span>
            </label>

            <div style={{ marginTop:14, display:'flex', gap:10, alignItems:'center' }}>
              <button style={{ ...s.btn, background:t.accent }} type="submit">📧 Send Now</button>
              {sendMsg && <span style={{ color:'#ef4444', fontSize:13 }}>{sendMsg}</span>}
            </div>
          </form>

          {/* Send confirmation panel */}
          {sendResult && (
            <div style={{ marginTop:16, background:'#10b98118', border:'1px solid #10b981', borderRadius:8, padding:14 }}>
              <div style={{ color:'#10b981', fontWeight:700, fontSize:13, marginBottom:10 }}>
                ✓ Email sent successfully — {sendResult.sent_at} IST
              </div>
              <div style={{ color:t.textMuted, fontSize:12, marginBottom:6 }}>
                <b style={{ color:t.text }}>📧 Sent to {sendResult.recipients} recipient(s):</b>
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:3, marginBottom:10 }}>
                {(sendResult.to || []).map(email => (
                  <span key={email} style={{ color:t.text, fontSize:12, paddingLeft:8 }}>• {email}</span>
                ))}
              </div>
              {sendResult.reports?.length > 0 && (
                <div style={{ color:t.textMuted, fontSize:12 }}>
                  <b style={{ color:t.text }}>📎 Attachments:</b>{' '}
                  {sendResult.reports.map(r => (
                    <span key={r} style={{ marginLeft:6, padding:'1px 7px', borderRadius:6, background:t.surface2,
                      color:t.textMuted, fontSize:11 }}>{r}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Tab 4: Deviation Alerts ── */}
      {tab === 4 && (
        <div>
          <div style={s.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              <h4 style={{ ...s.cardTitle, margin: 0 }}>Loss Tracker Deviation Alerts</h4>
              <div style={{ display: 'flex', gap: 8 }}>
                <button style={{ ...s.btn, fontSize: 12, padding: '6px 14px' }} type="button"
                  onClick={fetchDeviationAlerts}>Refresh</button>
                <button style={{ ...s.btn, fontSize: 12, padding: '6px 14px', background: t.brand }} type="button"
                  onClick={async () => {
                    setDeviationMsg('');
                    try {
                      const r = await api.post('/api/deviation-alerts/scan');
                      setDeviationMsg('✓ ' + r.data.message);
                      fetchDeviationAlerts();
                    } catch (err) {
                      setDeviationMsg('✗ ' + (err.response?.data?.detail || 'Scan failed'));
                    }
                  }}>
                  Run Scan Now
                </button>
              </div>
            </div>
            <p style={{ color: t.textDim, fontSize: 13, margin: '0 0 12px' }}>
              Automatic emails when Loss Tracker thresholds are exceeded (idle, breakdown, alarm, offline, setting change),
              when a breakdown ticket is raised, or when an alarm status is detected. Threshold limits shown below are
              read from <b style={{ color: t.accent }}>Loss Tracker → Thresholds</b> (shared with scheduled loss tracker reports).
              With escalation enabled, Level 1 (production) is notified first; if no action is taken within the configured
              delay, alerts escalate to supervisor then manager. Ongoing breaches and escalations are re-checked every 5 minutes.
            </p>
            {deviationConfig && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                <div style={{ ...s.kpi, minWidth: 120, padding: '10px 14px' }}>
                  <div style={{ color: t.accent, fontSize: 18, fontWeight: 700 }}>{deviationConfig.recipient_count}</div>
                  <div style={{ color: t.textMuted, fontSize: 11 }}>Active recipients</div>
                </div>
                {deviationSummary && (
                  <div style={{ ...s.kpi, minWidth: 120, padding: '10px 14px' }}>
                    <div style={{ color: '#f59e0b', fontSize: 18, fontWeight: 700 }}>{deviationSummary.total_alerts_sent}</div>
                    <div style={{ color: t.textMuted, fontSize: 11 }}>Alerts sent today</div>
                  </div>
                )}
                {Object.entries(deviationConfig.thresholds_minutes || {}).map(([key, mins]) => (
                  <div key={key} style={{ ...s.kpi, minWidth: 100, padding: '10px 14px' }}>
                    <div style={{ color: t.text, fontSize: 14, fontWeight: 700 }}>{mins}m</div>
                    <div style={{ color: t.textMuted, fontSize: 11 }}>{key.replace('_', ' ')} limit</div>
                  </div>
                ))}
              </div>
            )}
            {deviationConfig?.subscribed_groups?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <span style={{ color: t.textDim, fontSize: 12, fontWeight: 600 }}>Subscribed groups: </span>
                {deviationConfig.subscribed_groups.map(g => (
                  <span key={g.id} style={{ marginRight: 8, padding: '2px 8px', borderRadius: 8, fontSize: 11,
                    background: t.surface2, color: t.textMuted }}>{g.name}</span>
                ))}
              </div>
            )}
            {deviationMsg && (
              <p style={{ color: deviationMsg.startsWith('✓') ? '#10b981' : '#ef4444', fontSize: 13 }}>{deviationMsg}</p>
            )}
          </div>

          {escalationDraft && (
            <div style={s.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                <h4 style={{ ...s.cardTitle, margin: 0 }}>Multi-Level Escalation Matrix</h4>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: t.textDim, cursor: isAdmin ? 'pointer' : 'default' }}>
                  <input
                    type="checkbox"
                    checked={!!escalationDraft.enabled}
                    disabled={!isAdmin}
                    onChange={e => setEscalationDraft(p => ({ ...p, enabled: e.target.checked }))}
                  />
                  Escalation enabled
                </label>
              </div>
              <p style={{ color: t.textMuted, fontSize: 12, margin: '0 0 12px' }}>
                Level 1 notifies production/operators immediately. If deviation reason is not recorded and the machine
                status is unchanged, Level 2 (supervisor) is notified after the delay, then Level 3 (manager).
                Action taken = deviation reason saved, breakdown acknowledged, or status cleared.
              </p>
              <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Level', 'Role / Label', 'Email Groups', 'Escalate After (min)', ''].map(h => (
                        <th key={h} style={{ padding: '8px', background: t.surface2, color: t.textDim, textAlign: 'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(escalationDraft.levels || []).map((lvl, idx) => (
                      <tr key={lvl.level ?? idx}>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, fontWeight: 700, color: t.accent }}>
                          L{lvl.level}
                        </td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>
                          {isAdmin ? (
                            <input
                              value={lvl.label || ''}
                              onChange={e => {
                                const levels = [...escalationDraft.levels];
                                levels[idx] = { ...levels[idx], label: e.target.value };
                                setEscalationDraft(p => ({ ...p, levels }));
                              }}
                              style={{ width: '100%', padding: '4px 8px', background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 6, color: t.text }}
                            />
                          ) : (lvl.label || `Level ${lvl.level}`)}
                        </td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>
                          {isAdmin ? (
                            <input
                              value={(lvl.group_names || []).join(', ')}
                              onChange={e => {
                                const levels = [...escalationDraft.levels];
                                levels[idx] = {
                                  ...levels[idx],
                                  group_names: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                                };
                                setEscalationDraft(p => ({ ...p, levels }));
                              }}
                              placeholder="production, maintenance"
                              style={{ width: '100%', padding: '4px 8px', background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 6, color: t.text }}
                            />
                          ) : (lvl.group_names || []).join(', ')}
                        </td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>
                          {isAdmin ? (
                            <input
                              type="number"
                              min={0}
                              value={lvl.delay_minutes ?? 0}
                              onChange={e => {
                                const levels = [...escalationDraft.levels];
                                levels[idx] = { ...levels[idx], delay_minutes: parseInt(e.target.value, 10) || 0 };
                                setEscalationDraft(p => ({ ...p, levels }));
                              }}
                              style={{ width: 80, padding: '4px 8px', background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 6, color: t.text }}
                            />
                          ) : (lvl.delay_minutes ?? 0)}
                        </td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted, fontSize: 11 }}>
                          {idx === 0 ? 'Immediate' : `From alert open`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {isAdmin && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    type="button"
                    style={{ ...s.btn, fontSize: 12, padding: '6px 14px', background: t.brand }}
                    onClick={async () => {
                      setEscalationMsg('');
                      try {
                        await api.put('/api/deviation-alerts/escalation', escalationDraft);
                        setEscalationMsg('✓ Escalation matrix saved');
                        fetchDeviationAlerts();
                      } catch (err) {
                        setEscalationMsg('✗ ' + (err.response?.data?.detail || 'Save failed'));
                      }
                    }}
                  >
                    Save Escalation Matrix
                  </button>
                  {escalationMsg && (
                    <span style={{ color: escalationMsg.startsWith('✓') ? '#10b981' : '#ef4444', fontSize: 13 }}>
                      {escalationMsg}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {deviationConfig?.open_escalation_cases?.length > 0 && (
            <div style={s.card}>
              <h4 style={s.cardTitle}>Open Escalation Cases</h4>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Opened', 'Machine', 'Station', 'Parameter', 'Current Level', 'Minutes Open', 'Pending Action'].map(h => (
                        <th key={h} style={{ padding: '8px', background: t.surface2, color: t.textDim, textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {deviationConfig.open_escalation_cases.map(c => (
                      <tr key={c.id}>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{c.opened_at}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{c.machine_name}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{c.station_name}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.accent, fontWeight: 600 }}>{c.status_label}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{c.current_level_label}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{c.minutes_open}m</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`,
                          color: c.action_pending ? '#f59e0b' : '#10b981' }}>
                          {c.action_pending ? 'Yes' : 'No'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={s.card}>
            <h4 style={s.cardTitle}>Recent Deviation Alert Emails</h4>
            {deviationAlerts.length === 0 ? (
              <p style={{ color: t.textMuted }}>No deviation alerts sent yet.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {['Sent At', 'Type', 'Level', 'Parameter', 'Machine', 'Station', 'Duration', 'Count', 'Reason', 'Status'].map(h => (
                        <th key={h} style={{ padding: '8px', background: t.surface2, color: t.textDim, textAlign: 'left', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {deviationAlerts.map(a => (
                      <tr key={a.id}>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>{a.sent_at}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.text }}>{a.alert_type}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.textMuted }}>
                          {a.escalation_level > 0 ? `L${a.escalation_level}` : 'All'}
                        </td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, color: t.accent, fontWeight: 600 }}>{a.status_label}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{a.machine_name}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{a.station_name}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{a.duration_display || '—'}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}` }}>{a.breach_count}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`, maxWidth: 180 }}>{a.deviation_reason || '—'}</td>
                        <td style={{ padding: '8px', borderBottom: `1px solid ${t.border}`,
                          color: a.delivery_status === 'sent' ? '#10b981' : '#ef4444' }}>{a.delivery_status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FField({ label, children, wide }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4, gridColumn: wide ? 'span 2' : 'span 1' }}>
      <label style={{ color:t.textDim, fontSize:11 }}>{label}</label>
      {children}
    </div>
  );
}

function getStyles(t) {
  return {
    page: { padding:20, background:t.bg, minHeight:'100vh', color:t.text },
    title: { color:t.text, fontSize:20, margin:'0 0 16px' },
    tabs: { display:'flex', gap:4, marginBottom:20, borderBottom:`1px solid ${t.surface2}`, paddingBottom:0 },
    tab: { padding:'8px 18px', background:'none', border:'none', color:t.textDim, cursor:'pointer',
           fontSize:13, borderBottom:'2px solid transparent', marginBottom:-1 },
    tabActive: { color:t.accent, borderBottom:`2px solid ${t.accent}`, fontWeight:600 },
    card: { background:t.surface, borderRadius:10, padding:20, marginBottom:16 },
    cardTitle: { color:t.accent, margin:'0 0 14px', fontSize:14, fontWeight:600 },
    formGrid: { display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px,1fr))', gap:12, marginBottom:14 },
    inp: { padding:'8px 10px', borderRadius:6, border:`1px solid ${t.inpBorder}`, background:t.inp,
           color:t.text, fontSize:13, width:'100%', boxSizing:'border-box' },
    btn: { padding:'8px 20px', background:t.accent, color:'#fff', border:'none', borderRadius:6,
           cursor:'pointer', fontWeight:600, fontSize:13 },
    infoBox: { background:t.surface2, border:`1px solid ${t.surface2}`, borderRadius:6, padding:'10px 14px',
               color:t.textMuted, fontSize:12, marginTop:12 },
    groupGrid: { display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px,1fr))', gap:14 },
    groupCard: { background:t.surface, borderRadius:10, padding:16 },
    groupHeader2: { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 },
    badge: { padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600 },
    memberRow: { display:'flex', alignItems:'center', gap:8, padding:'6px 0',
                 borderBottom:`1px solid ${t.surface2}` },
    miniBtn: { padding:'3px 8px', border:'none', borderRadius:4, color:'#fff',
               cursor:'pointer', fontSize:12, fontWeight:600, flexShrink:0 },
    checkLabel: { display:'flex', alignItems:'center', gap:8, padding:'8px 12px', borderRadius:8,
                  border:`1px solid ${t.surface2}`, cursor:'pointer', fontSize:13, userSelect:'none' },
    checkLabel2: { display:'flex', alignItems:'center', gap:8, cursor:'pointer', marginTop:8 },
    schedRow: { display:'flex', alignItems:'center', gap:10, padding:'12px 0',
                borderBottom:`1px solid ${t.surface2}` },
    kpi: { background:t.surface, borderRadius:10, padding:'14px 18px', flex:1, minWidth:100 },
  };
}
