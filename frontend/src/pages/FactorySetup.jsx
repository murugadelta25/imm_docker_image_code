import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import { useConfig } from '../context/ConfigContext';
import { useBranding } from '../context/BrandingContext';
import { DEFAULT_APP_NAME } from '../config/branding';
import PageHeader from '../components/PageHeader';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { applySiteBranding } from '../utils/siteBranding';

function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

const EMPTY_FACTORY = {
  name: '',
  logoUrl: '',
  location: { address: '', lat: '', lng: '' },
  departments: [],
};

function newDepartment() {
  return { id: uid(), name: '', lines: [] };
}

function newLine() {
  return { id: uid(), name: '', stationIds: [] };
}

export default function FactorySetup() {
  const { config, reload } = useConfig();
  const { reload: reloadBranding } = useBranding();
  const { theme: t } = useTheme();
  const [siteTitle, setSiteTitle] = useState(DEFAULT_APP_NAME);
  const [faviconFactoryId, setFaviconFactoryId] = useState(null);
  const [factories, setFactories] = useState([]);
  const [stations, setStations] = useState([]);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const [logoFiles, setLogoFiles] = useState({});
  const [logoPreviews, setLogoPreviews] = useState({});
  const [editingFactoryId, setEditingFactoryId] = useState(null);
  const [showFactoryForm, setShowFactoryForm] = useState(false);
  const [draftFactory, setDraftFactory] = useState(null);
  const [loginImageEnabled, setLoginImageEnabled] = useState(false);
  const [loginImageUrl, setLoginImageUrl] = useState('');
  const [loginImageUploading, setLoginImageUploading] = useState(false);

  const [stationForm, setStationForm] = useState({ name: '', display_name: '' });
  const [editStationId, setEditStationId] = useState(null);
  const [showStationForm, setShowStationForm] = useState(false);
  const [stationMsg, setStationMsg] = useState('');

  useEffect(() => {
    const fc = config?.factory;
    if (!fc) return;
    setSiteTitle(fc.siteTitle || DEFAULT_APP_NAME);
    setLoginImageEnabled(!!fc.loginImageEnabled);
    setLoginImageUrl(fc.loginImageUrl || '');
    // While the editor is open, keep local draft/favicon — logo upload must not wipe them.
    if (showFactoryForm) return;
    setFaviconFactoryId(fc.faviconFactoryId || null);
    const serverFactories = (fc.factories || []).filter((f) => String(f?.name || '').trim());
    setFactories((prev) => {
      const prevById = Object.fromEntries((prev || []).map((f) => [f.id, f]));
      return serverFactories.map((f) => {
        const local = prevById[f.id];
        if (local?.logoUrl && !f.logoUrl) return { ...f, logoUrl: local.logoUrl };
        return f;
      });
    });
  }, [config, showFactoryForm]);

  const fetchStations = useCallback(async () => {
    const r = await api.get('/api/stations/');
    setStations(r.data);
  }, []);

  useEffect(() => { fetchStations(); }, [fetchStations]);

  const uploadLogoFile = async (file, factoryId) => {
    const fd = new FormData();
    fd.append('file', file);
    // Do NOT set Content-Type manually — axios must add the multipart boundary.
    const up = await api.post('/api/config/factory-logo', fd, {
      params: {
        factory_id: factoryId || undefined,
        set_as_favicon: true,
      },
    });
    return up.data.logoUrl;
  };

  const persistFactories = async (
    nextFactories,
    nextFaviconId = faviconFactoryId,
    nextTitle = siteTitle,
    nextLogin = { enabled: loginImageEnabled, url: loginImageUrl },
  ) => {
    const named = (nextFactories || []).filter((f) => String(f?.name || '').trim());
    let fav = nextFaviconId;
    if (fav && !named.some((f) => f.id === fav)) {
      fav = named.find((f) => f.logoUrl)?.id || null;
    }
    const payload = {
      ...config,
      factory: {
        ...(config?.factory || {}),
        configured: true,
        siteTitle: (nextTitle || '').trim() || DEFAULT_APP_NAME,
        faviconFactoryId: fav,
        factories: named,
        loginImageEnabled: !!nextLogin.enabled,
        loginImageUrl: nextLogin.url || null,
      },
    };
    await api.put('/api/config/', { config: payload });
    setFactories(named);
    setFaviconFactoryId(fav);
    setLoginImageEnabled(!!nextLogin.enabled);
    setLoginImageUrl(nextLogin.url || '');
    await reload();
    await reloadBranding();
    applySiteBranding({
      siteTitle: payload.factory.siteTitle,
      factories: named,
      faviconFactoryId: fav,
    });
    return payload;
  };

  const uploadLoginImage = async (file) => {
    if (!file) return;
    setLoginImageUploading(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const up = await api.post('/api/config/login-image', fd, {
        params: { enable: true },
      });
      const url = up.data?.loginImageUrl || '';
      setLoginImageUrl(url);
      setLoginImageEnabled(true);
      await persistFactories(factories, faviconFactoryId, siteTitle, { enabled: true, url });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Login image upload failed');
    } finally {
      setLoginImageUploading(false);
    }
  };

  const saveLoginImageSettings = async (enabled = loginImageEnabled) => {
    try {
      await persistFactories(factories, faviconFactoryId, siteTitle, {
        enabled,
        url: loginImageUrl,
      });
      setSaved(true);
      setErr('');
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to save login image settings');
    }
  };

  const openAddFactory = () => {
    setDraftFactory({
      ...EMPTY_FACTORY,
      id: uid(),
      departments: [],
      location: { address: '', lat: '', lng: '' },
    });
    setEditingFactoryId(null);
    setShowFactoryForm(true);
    setErr('');
    setSaved(false);
  };

  const openEditFactory = (factory) => {
    setDraftFactory(JSON.parse(JSON.stringify(factory)));
    setEditingFactoryId(factory.id);
    setShowFactoryForm(true);
    setErr('');
    setSaved(false);
  };

  const updateDraft = (patch) => {
    setDraftFactory((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const commitDraftFactory = async () => {
    const draft = draftFactory;
    if (!draft?.name?.trim()) {
      setErr('Factory name is required');
      return false;
    }
    const normalized = {
      ...draft,
      name: draft.name.trim(),
      logoUrl: draft.logoUrl || '',
      location: {
        address: draft.location?.address || '',
        lat: draft.location?.lat || '',
        lng: draft.location?.lng || '',
      },
      departments: draft.departments || [],
    };
    // Apply any pending local file that did not finish upload yet.
    if (!normalized.logoUrl && logoFiles[normalized.id]) {
      try {
        normalized.logoUrl = await uploadLogoFile(logoFiles[normalized.id], normalized.id);
      } catch (uploadErr) {
        setErr(uploadErr.response?.data?.detail || uploadErr.message || 'Logo upload failed');
        return false;
      }
    }
    const exists = factories.some((f) => f.id === normalized.id);
    const next = exists
      ? factories.map((f) => (f.id === normalized.id ? normalized : f))
      : [...factories, normalized];
    const nextFav = faviconFactoryId || (normalized.logoUrl ? normalized.id : null);

    setFactories(next);
    setErr('');
    try {
      await persistFactories(next, nextFav);
      setShowFactoryForm(false);
      setDraftFactory(null);
      setEditingFactoryId(null);
      setLogoFiles((p) => {
        const copy = { ...p };
        delete copy[normalized.id];
        return copy;
      });
      setLogoPreviews((p) => {
        if (p[normalized.id]) {
          try { URL.revokeObjectURL(p[normalized.id]); } catch { /* ignore */ }
        }
        const copy = { ...p };
        delete copy[normalized.id];
        return copy;
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to save factory');
      setDraftFactory(normalized);
      setEditingFactoryId(exists ? normalized.id : null);
      setShowFactoryForm(true);
      return false;
    }
  };

  const removeFactory = async (id) => {
    if (!window.confirm('Remove this factory from configuration?')) return;
    const next = factories.filter((f) => f.id !== id);
    const nextFav = faviconFactoryId === id ? null : faviconFactoryId;
    setFactories(next);
    if (faviconFactoryId === id) setFaviconFactoryId(null);
    if (draftFactory?.id === id) {
      setShowFactoryForm(false);
      setDraftFactory(null);
      setEditingFactoryId(null);
    }
    try {
      await persistFactories(next, nextFav);
      setSaved(true);
      setErr('');
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to remove factory');
      await reload();
    }
  };

  const save = async () => {
    try {
      let workingFactories = factories;
      if (showFactoryForm && draftFactory) {
        const ok = await commitDraftFactory();
        if (!ok) return;
        return; // commitDraftFactory already persisted
      }

      const updatedFactories = [];
      for (const f of workingFactories) {
        if (!String(f?.name || '').trim()) continue;
        let logoUrl = f.logoUrl || '';
        if (!logoUrl && logoFiles[f.id]) {
          logoUrl = await uploadLogoFile(logoFiles[f.id], f.id);
        }
        updatedFactories.push({ ...f, logoUrl });
      }

      await persistFactories(updatedFactories, faviconFactoryId, siteTitle, {
        enabled: loginImageEnabled,
        url: loginImageUrl,
      });
      Object.values(logoPreviews).forEach((url) => {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      });
      setLogoFiles({});
      setLogoPreviews({});
      setSaved(true);
      setErr('');
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Failed to save factory setup');
    }
  };

  const openAddStation = () => {
    setStationForm({ name: '', display_name: '' });
    setEditStationId(null);
    setShowStationForm(true);
    setStationMsg('');
  };

  const openEditStation = (station) => {
    setStationForm({ name: station.name, display_name: station.display_name });
    setEditStationId(station.id);
    setShowStationForm(true);
    setStationMsg('');
  };

  const saveStation = async (e) => {
    e.preventDefault();
    try {
      if (editStationId) {
        await api.put(`/api/stations/${editStationId}`, { display_name: stationForm.display_name });
        setStationMsg('Station updated');
      } else {
        await api.post('/api/stations/', stationForm);
        setStationMsg('Station added');
      }
      setShowStationForm(false);
      fetchStations();
    } catch (err) {
      setStationMsg(err.response?.data?.detail || err.message);
    }
  };

  const deleteStation = async (id) => {
    if (!window.confirm('Delete this station?')) return;
    try {
      await api.delete(`/api/stations/${id}`);
      setStationMsg('Station deleted');
      fetchStations();
    } catch (err) {
      setStationMsg(err.response?.data?.detail || err.message);
    }
  };

  const deptCount = (f) => (f.departments || []).length;
  const lineCount = (f) => (f.departments || []).reduce((n, d) => n + (d.lines || []).length, 0);

  const s = {
    page: { padding: 24, maxWidth: 1200, margin: '0 auto' },
    card: { background: t.surface, border: `1px solid ${t.border}`, borderRadius: 10, padding: 20, marginBottom: 16 },
    title: { color: t.accent, fontSize: 14, fontWeight: 600, margin: '0 0 12px' },
    inp: { width: '100%', padding: '8px 10px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2, color: t.text, boxSizing: 'border-box' },
    btn: { padding: '10px 18px', borderRadius: 6, border: 'none', background: t.accent, color: '#fff', cursor: 'pointer', fontWeight: 600 },
    subBtn: { padding: '6px 12px', borderRadius: 6, border: `1px solid ${t.border}`, background: t.surface2, color: t.text, cursor: 'pointer', fontSize: 12 },
    label: { fontSize: 12, color: t.textMuted, marginBottom: 4, display: 'block' },
    grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { padding: '10px 8px', background: t.surface2, color: t.textDim, textAlign: 'left', fontWeight: 600 },
    td: { padding: '10px 8px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' },
    miniBtn: { padding: '4px 10px', border: 'none', borderRadius: 5, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 },
  };

  const renderFactoryEditor = () => {
    if (!draftFactory) return null;
    const fi = draftFactory;
    const setDept = (di, patch) => {
      const departments = [...(fi.departments || [])];
      departments[di] = { ...departments[di], ...patch };
      updateDraft({ departments });
    };

    return (
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={s.title}>{editingFactoryId ? 'Edit Factory' : 'Add Factory'}</h3>
          <button type="button" style={s.subBtn} onClick={() => { setShowFactoryForm(false); setDraftFactory(null); setEditingFactoryId(null); }}>✕</button>
        </div>
        <div style={s.grid2}>
          <div>
            <label style={s.label}>Factory Name</label>
            <input style={s.inp} value={fi.name}
              onChange={e => updateDraft({ name: e.target.value })} />
          </div>
          <div>
            <label style={s.label}>Factory Logo</label>
            <input type="file" accept="image/*"
              onChange={async (e) => {
                const file = e.target.files?.[0] || null;
                if (!file) return;
                setErr('');
                setLogoFiles((p) => ({ ...p, [fi.id]: file }));
                setLogoPreviews((p) => {
                  if (p[fi.id]) {
                    try { URL.revokeObjectURL(p[fi.id]); } catch { /* ignore */ }
                  }
                  return { ...p, [fi.id]: URL.createObjectURL(file) };
                });
                try {
                  const logoUrl = await uploadLogoFile(file, fi.id);
                  updateDraft({ logoUrl });
                  setFaviconFactoryId(fi.id);
                  setFactories((prev) => {
                    const exists = prev.some((f) => f.id === fi.id);
                    if (exists) {
                      return prev.map((f) => (f.id === fi.id ? { ...f, logoUrl } : f));
                    }
                    return prev;
                  });
                  setLogoFiles((p) => {
                    const next = { ...p };
                    delete next[fi.id];
                    return next;
                  });
                  // Update header/favicon only — do NOT reload full config while the form is open
                  // (reload used to wipe unsaved Add Factory drafts).
                  await reloadBranding();
                  applySiteBranding({
                    siteTitle: siteTitle.trim() || DEFAULT_APP_NAME,
                    faviconUrl: logoUrl,
                    factories: [{ id: fi.id, logoUrl }],
                    faviconFactoryId: fi.id,
                  });
                } catch (uploadErr) {
                  setErr(uploadErr.response?.data?.detail || uploadErr.message || 'Logo upload failed');
                }
              }} />
            {(logoPreviews[fi.id] || fi.logoUrl) && (
              <img
                src={logoPreviews[fi.id] || assetUrl(fi.logoUrl)}
                alt="logo"
                style={{ height: 48, marginTop: 8, maxWidth: 160, objectFit: 'contain', display: 'block', background: '#fff', borderRadius: 4, padding: 4 }}
              />
            )}
            {fi.logoUrl && !logoFiles[fi.id] && (
              <p style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
                Logo uploaded — click {editingFactoryId ? 'Update Factory' : 'Add Factory'} to save
              </p>
            )}
            {logoFiles[fi.id] && (
              <p style={{ fontSize: 11, color: t.textMuted, marginTop: 4 }}>
                Uploading logo…
              </p>
            )}
            <label style={{ ...s.label, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={faviconFactoryId === fi.id}
                onChange={e => setFaviconFactoryId(e.target.checked ? fi.id : null)} />
              Use as browser tab icon and app header logo
            </label>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label style={s.label}>Location (address)</label>
          <input style={s.inp} value={fi.location?.address || ''}
            placeholder="Full address for Google Maps"
            onChange={e => updateDraft({ location: { ...fi.location, address: e.target.value } })} />
        </div>
        <div style={{ ...s.grid2, marginTop: 12 }}>
          <div>
            <label style={s.label}>Latitude</label>
            <input style={s.inp} value={fi.location?.lat || ''}
              onChange={e => updateDraft({ location: { ...fi.location, lat: e.target.value } })} />
          </div>
          <div>
            <label style={s.label}>Longitude</label>
            <input style={s.inp} value={fi.location?.lng || ''}
              onChange={e => updateDraft({ location: { ...fi.location, lng: e.target.value } })} />
          </div>
        </div>

        <div style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 style={s.title}>Departments & Zones</h4>
            <button type="button" style={s.subBtn}
              onClick={() => updateDraft({ departments: [...(fi.departments || []), newDepartment()] })}>
              + Department
            </button>
          </div>
          <p style={{ fontSize: 12, color: t.textMuted, margin: '6px 0 10px' }}>
            Zone names here appear on the IMM Zone Dashboard. Assign stations to each zone.
          </p>
          {(fi.departments || []).map((dept, di) => (
            <div key={dept.id} style={{ border: `1px solid ${t.border}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <label style={s.label}>Department Name</label>
              <input style={s.inp} value={dept.name}
                onChange={e => setDept(di, { name: e.target.value })} />
              <div style={{ marginTop: 10 }}>
                <button type="button" style={s.subBtn}
                  onClick={() => {
                    const departments = [...fi.departments];
                    departments[di] = { ...dept, lines: [...(dept.lines || []), newLine()] };
                    updateDraft({ departments });
                  }}>+ Zone</button>
              </div>
              {(dept.lines || []).map((line, li) => (
                <div key={line.id} style={{ marginTop: 10, paddingLeft: 12, borderLeft: `3px solid ${t.accent}` }}>
                  <label style={s.label}>Zone Name</label>
                  <input style={s.inp} value={line.name} placeholder="e.g. Molding A, Assembly"
                    onChange={e => {
                      const departments = [...fi.departments];
                      const lines = [...dept.lines];
                      lines[li] = { ...line, name: e.target.value };
                      departments[di] = { ...dept, lines };
                      updateDraft({ departments });
                    }} />
                    <label style={{ ...s.label, marginTop: 8 }}>Stations in this zone</label>
                  {stations.length === 0 ? (
                    <p style={{ fontSize: 12, color: t.textFaint }}>No stations yet — create them in Station Management first.</p>
                  ) : (
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: 6,
                      border: `1px solid ${t.border}`, borderRadius: 8, padding: 10,
                      maxHeight: 160, overflow: 'auto', background: t.surface2 || t.bg,
                    }}>
                      {stations.map((st) => {
                        const sid = Number(st.id);
                        const checked = (line.stationIds || []).map(Number).includes(sid);
                        return (
                          <label key={st.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: t.text, fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const prev = (line.stationIds || []).map(Number).filter((n) => !Number.isNaN(n));
                                const next = e.target.checked
                                  ? [...new Set([...prev, sid])]
                                  : prev.filter((n) => n !== sid);
                                const departments = [...fi.departments];
                                const lines = [...dept.lines];
                                lines[li] = { ...line, stationIds: next };
                                departments[di] = { ...dept, lines };
                                updateDraft({ departments });
                              }}
                            />
                            {st.display_name || st.name}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <p style={{ fontSize: 11, color: t.textFaint }}>
                    Machines on these stations (and machines whose Location is this zone path) appear on the Zone Dashboard.
                  </p>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button type="button" style={s.btn} onClick={() => commitDraftFactory()}>
            {editingFactoryId ? 'Update Factory' : 'Add Factory'}
          </button>
          <button type="button" style={s.subBtn} onClick={() => { setShowFactoryForm(false); setDraftFactory(null); setEditingFactoryId(null); }}>Cancel</button>
        </div>
      </div>
    );
  };

  return (
    <div className={pageClass(t)} style={s.page}>
      <PageHeader title="Factory Setup" subtitle="Site branding, stations, factories, departments, and zone mapping" />

      <div style={s.card}>
        <h3 style={s.title}>Site Branding</h3>
        <div style={s.grid2}>
          <div>
            <label style={s.label}>Browser Tab Title</label>
            <input style={s.inp} value={siteTitle}
              placeholder="DELTA-EAP-PMS"
              onChange={e => setSiteTitle(e.target.value)} />
            <p style={{ fontSize: 11, color: t.textFaint, marginTop: 4 }}>
              Shown in the browser tab and window title bar
            </p>
          </div>
        </div>
      </div>

      <div style={s.card}>
        <h3 style={s.title}>Login Screen Image</h3>
        <p style={{ fontSize: 12, color: t.textMuted, margin: '0 0 12px', lineHeight: 1.45 }}>
          Separate from factory logos. Upload a full company image for the login page.
          When turned off, the default <code>din_pms.png</code> is shown.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, color: t.text, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={loginImageEnabled}
            onChange={async (e) => {
              const on = e.target.checked;
              setLoginImageEnabled(on);
              await saveLoginImageSettings(on);
            }}
          />
          Use custom login image
        </label>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{
            width: 220, height: 120, border: `1px solid ${t.border}`, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: t.surface2 || t.bg, overflow: 'hidden',
          }}>
            <img
              src={assetUrl(loginImageEnabled && loginImageUrl ? loginImageUrl : '/din_pms.png') || '/din_pms.png'}
              alt="Login preview"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="file"
              accept="image/*"
              disabled={loginImageUploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLoginImage(file);
                e.target.value = '';
              }}
            />
            <p style={{ fontSize: 11, color: t.textFaint, margin: 0 }}>
              {loginImageUploading ? 'Uploading…' : 'PNG / JPG / WEBP. Factory logos stay unchanged.'}
            </p>
            {loginImageUrl && (
              <button
                type="button"
                style={s.subBtn}
                onClick={async () => {
                  setLoginImageUrl('');
                  setLoginImageEnabled(false);
                  await persistFactories(factories, faviconFactoryId, siteTitle, { enabled: false, url: null });
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                }}
              >
                Clear custom image
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={s.title}>Factories ({factories.length})</h3>
          <button type="button" style={s.subBtn} onClick={openAddFactory}>+ Add Factory</button>
        </div>

        {showFactoryForm && renderFactoryEditor()}

        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Logo', 'Factory Name', 'Location', 'Departments', 'Zones', 'Favicon', 'Actions'].map(h => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {factories.length === 0 ? (
                <tr><td colSpan={7} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>No factories configured</td></tr>
              ) : factories.map(f => (
                <tr key={f.id}>
                  <td style={s.td}>
                    {(logoPreviews[f.id] || f.logoUrl)
                      ? <img src={logoPreviews[f.id] || assetUrl(f.logoUrl)} alt="" style={{ height: 32, maxWidth: 96, objectFit: 'contain' }} />
                      : '—'}
                  </td>
                  <td style={s.td}>{f.name || '—'}</td>
                  <td style={s.td}>{f.location?.address || '—'}</td>
                  <td style={s.td}>{deptCount(f)}</td>
                  <td style={s.td}>{lineCount(f)}</td>
                  <td style={s.td}>{faviconFactoryId === f.id ? '✓' : '—'}</td>
                  <td style={s.td}>
                    <button type="button" style={{ ...s.miniBtn, background: t.accent, marginRight: 6 }}
                      onClick={() => openEditFactory(f)}>Edit</button>
                    <button type="button" style={{ ...s.miniBtn, background: '#ef4444' }}
                      onClick={() => removeFactory(f.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={s.title}>Stations ({stations.length})</h3>
          <button type="button" style={s.subBtn} onClick={openAddStation}>+ Add Station</button>
        </div>
        {stationMsg && (
          <p style={{ fontSize: 12, color: stationMsg.includes('deleted') || stationMsg.includes('updated') || stationMsg.includes('added') ? t.brand : '#ef4444', marginBottom: 8 }}>
            {stationMsg}
          </p>
        )}
        {showStationForm && (
          <form onSubmit={saveStation} style={{ marginBottom: 16, padding: 12, border: `1px solid ${t.border}`, borderRadius: 8 }}>
            <div style={s.grid2}>
              <div>
                <label style={s.label}>Station Name *</label>
                <input style={s.inp} value={stationForm.name} required disabled={!!editStationId}
                  onChange={e => setStationForm(p => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <label style={s.label}>Display Name *</label>
                <input style={s.inp} value={stationForm.display_name} required
                  onChange={e => setStationForm(p => ({ ...p, display_name: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="submit" style={s.subBtn}>{editStationId ? 'Save' : 'Add'}</button>
              <button type="button" style={s.subBtn} onClick={() => setShowStationForm(false)}>Cancel</button>
            </div>
          </form>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Name', 'Display Name', 'Machines', 'Actions'].map(h => <th key={h} style={s.th}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {stations.length === 0 ? (
                <tr><td colSpan={4} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>No stations yet</td></tr>
              ) : stations.map(st => (
                <tr key={st.id}>
                  <td style={s.td}>{st.name}</td>
                  <td style={s.td}>{st.display_name}</td>
                  <td style={s.td}>{st.machine_count ?? 0}</td>
                  <td style={s.td}>
                    <button type="button" style={{ ...s.miniBtn, background: t.accent, marginRight: 6 }}
                      onClick={() => openEditStation(st)}>Edit</button>
                    <button type="button" style={{ ...s.miniBtn, background: '#ef4444' }}
                      onClick={() => deleteStation(st.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: t.textFaint, marginTop: 8 }}>
          Stations created here appear on the Machines page for machine assignment.
        </p>
      </div>

      {err && <p style={{ color: '#ef4444' }}>{err}</p>}
      {saved && <p style={{ color: t.brand }}>Factory configuration saved.</p>}
      <button type="button" style={s.btn} onClick={save}>Save Site Branding</button>
      <p style={{ fontSize: 11, color: t.textFaint, marginTop: 8 }}>
        Factory add/update/remove saves immediately. Use this button to save the browser tab title.
      </p>
    </div>
  );
}
