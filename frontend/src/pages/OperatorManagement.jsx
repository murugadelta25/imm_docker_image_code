import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { useTheme } from '../context/ThemeContext';
import { pageClass } from '../themes/tileHelpers';
import PageHeader from '../components/PageHeader';

const SHIFTS = ['A', 'B', 'C'];
const STATUSES = ['Present', 'Absent', 'Leave', 'Week Off'];
const TABS = [
  { id: 'directory', label: 'Operator Directory' },
  { id: 'roster', label: 'Roster' },
  { id: 'allocation', label: 'Machine Allocation' },
  { id: 'reports', label: 'Reports' },
];

function mondayIso(d = new Date()) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

/** FastAPI may return detail as string or [{msg, loc, type, input}, ...] */
function apiErrorMessage(e) {
  const d = e?.response?.data?.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((x) => (typeof x === 'string' ? x : (x?.msg || JSON.stringify(x)))).join('; ');
  }
  if (d && typeof d === 'object') return d.msg || d.message || JSON.stringify(d);
  return e?.message || 'Request failed';
}

function statusColor(status, t) {
  switch (status) {
    case 'Present': return '#10b981';
    case 'Absent': return '#ef4444';
    case 'Leave': return '#f59e0b';
    case 'Week Off': return '#64748b';
    case 'assigned': return '#f59e0b';
    case 'acknowledged': return '#0ea5e9';
    case 'active': return '#10b981';
    default: return t.textMuted;
  }
}

function opLabel(op) {
  if (!op) return '—';
  const code = op.employee_code || op.username;
  const name = op.name;
  if (name && name !== code) return `${code} — ${name}`;
  return code || name || '—';
}

export default function OperatorManagement() {
  const { theme: t } = useTheme();
  const s = getStyles(t);
  const [tab, setTab] = useState('directory');
  const [msg, setMsg] = useState({ text: '', ok: true });
  const [detailOpId, setDetailOpId] = useState(null);

  const flash = (text, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg({ text: '', ok: true }), 4000);
  };

  const openOperatorDetail = (operatorId) => {
    if (operatorId != null) setDetailOpId(Number(operatorId));
  };

  return (
    <div className={pageClass(t)} style={{ padding: 20, background: t.bg, minHeight: 'calc(100vh - 52px)', color: t.text }}>
      <PageHeader title="OPERATOR MANAGEMENT" />
      <p style={{ color: t.textMuted, fontSize: 13, marginTop: -8, marginBottom: 12 }}>
        Shop-floor operators are managed here (separate from User Management). Temporary and large operator lists do not load into Users.
        Click an operator code / ID to view details and photo.
      </p>
      {msg.text && (
        <div style={{
          padding: '10px 16px', borderRadius: 8, marginBottom: 12,
          background: msg.ok ? '#10b98122' : '#ef444422',
          color: msg.ok ? '#10b981' : '#ef4444', fontSize: 13,
        }}>
          {msg.text}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            style={{
              ...s.tabBtn,
              background: tab === tb.id ? t.accent : 'transparent',
              color: tab === tb.id ? '#fff' : t.text,
              borderColor: tab === tb.id ? t.accent : t.border,
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>
      {tab === 'directory' && <DirectoryPanel s={s} t={t} flash={flash} onOpenDetail={openOperatorDetail} />}
      {tab === 'roster' && <RosterPanel s={s} t={t} flash={flash} onOpenDetail={openOperatorDetail} />}
      {tab === 'allocation' && <AllocationPanel s={s} t={t} flash={flash} onOpenDetail={openOperatorDetail} />}
      {tab === 'reports' && <ReportsPanel s={s} t={t} flash={flash} />}
      {detailOpId != null && (
        <OperatorDetailModal
          operatorId={detailOpId}
          s={s}
          t={t}
          onClose={() => setDetailOpId(null)}
          onEdit={(op) => {
            setDetailOpId(null);
            setTab('directory');
            // Directory will pick up via sessionStorage flag
            try {
              sessionStorage.setItem('pms_edit_operator_id', String(op.id));
            } catch { /* ignore */ }
          }}
        />
      )}
    </div>
  );
}

function OperatorDetailModal({ operatorId, s, t, onClose, onEdit }) {
  const [op, setOp] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const r = await api.get(`/api/operators/${operatorId}`);
        if (!cancelled) setOp(r.data);
      } catch (e) {
        if (!cancelled) setErr(apiErrorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [operatorId]);

  const photo = op?.reference_photo_url ? assetUrl(op.reference_photo_url) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          background: t.surface,
          borderRadius: 12,
          border: `1px solid ${t.border}`,
          boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: `1px solid ${t.border}`,
        }}>
          <h3 style={{ margin: 0, fontSize: 15, color: t.accent }}>Operator details</h3>
          <button type="button" style={s.outlineBtn} onClick={onClose}>Close</button>
        </div>
        <div style={{ padding: 16 }}>
          {loading && <div style={{ color: t.textFaint }}>Loading…</div>}
          {err && <div style={{ color: '#ef4444', fontSize: 13 }}>{err}</div>}
          {!loading && !err && op && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{
                width: 140, height: 140, borderRadius: 10, overflow: 'hidden',
                background: t.surface2 || t.bg, border: `1px solid ${t.border}`,
                flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {photo ? (
                  <img src={photo} alt={op.name || op.employee_code} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ color: t.textFaint, fontSize: 12, textAlign: 'center', padding: 8 }}>No photo</span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <DetailRow label="Operator ID" value={op.id} t={t} />
                <DetailRow label="Employee code" value={op.employee_code} t={t} accent />
                <DetailRow label="Name" value={op.name} t={t} />
                <DetailRow label="Type" value={op.is_temporary ? 'Temporary' : 'Regular'} t={t} />
                <DetailRow label="Status" value={op.is_active ? 'Active' : 'Inactive'} t={t} />
                <DetailRow label="PIN set" value={op.has_pin ? 'Yes' : 'No'} t={t} />
                <DetailRow label="Web login" value={op.has_web_login ? `Yes (user: ${op.employee_code})` : 'No — set password in Edit'} t={t} />
                <DetailRow label="Reference photo" value={op.has_reference_photo ? 'Yes' : 'No'} t={t} />
                {op.notes ? <DetailRow label="Notes" value={op.notes} t={t} /> : null}
                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <button type="button" style={s.submitBtn} onClick={() => onEdit?.(op)}>Edit</button>
                  <button type="button" style={s.outlineBtn} onClick={onClose}>Close</button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, t, accent }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textDim, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: accent ? 700 : 500, color: accent ? t.accent : t.text }}>{value ?? '—'}</div>
    </div>
  );
}

function OperatorIdLink({ id, label, t, onOpenDetail }) {
  if (id == null) return <span>{label || '—'}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenDetail?.(id)}
      title="View operator details"
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        color: t.accent, fontWeight: 700, fontSize: 'inherit', textDecoration: 'underline',
        textUnderlineOffset: 2,
      }}
    >
      {label || id}
    </button>
  );
}

const EMPTY_FORM = {
  employee_code: '',
  name: '',
  is_temporary: false,
  is_active: true,
  password: '',
  pin: '',
  notes: '',
};

/** Webcam / file capture for operator reference photo (add / edit form). */
function OperatorPhotoCapture({ s, t, existingUrl, photoBlob, photoPreview, onCaptured, onCleared }) {
  const videoRef = useRef(null);
  const uploadRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [camError, setCamError] = useState('');
  const [ready, setReady] = useState(false);

  const canUseCamera = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function';

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraOn(false);
    setReady(false);
    setStarting(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // Attach stream AFTER <video> is mounted (fixes black screen)
  useEffect(() => {
    if (!cameraOn || !streamRef.current || !videoRef.current) return undefined;
    const video = videoRef.current;
    video.srcObject = streamRef.current;
    video.muted = true;
    video.setAttribute('playsinline', 'true');
    let cancelled = false;
    const play = async () => {
      try {
        await video.play();
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setCamError(e.message || 'Could not start video preview');
      }
    };
    play();
    return () => { cancelled = true; };
  }, [cameraOn]);

  const startCamera = async () => {
    setCamError('');
    setReady(false);
    if (!canUseCamera) {
      setCamError('Live camera is not available here. Use Upload photo, or open via http://localhost.');
      return;
    }
    setStarting(true);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true); // video mounts; effect binds stream
    } catch (e) {
      setCamError(e.message || 'Camera access denied. Allow camera permission, or use Upload photo.');
      setCameraOn(false);
    } finally {
      setStarting(false);
    }
  };

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setCamError('Camera not ready yet — wait for the live preview, then capture.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    // Mirror-correct if preview is mirrored
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        setCamError('Failed to capture frame');
        return;
      }
      const url = URL.createObjectURL(blob);
      onCaptured(blob, url);
      setCamError('');
      stopCamera();
    }, 'image/jpeg', 0.92);
  };

  /** Capture = open live camera if needed, otherwise snap the frame (never opens file dialog). */
  const onCaptureClick = async () => {
    if (cameraOn && ready) {
      takePhoto();
      return;
    }
    if (cameraOn && !ready) {
      setCamError('Wait for the live preview, then click Capture photo again.');
      return;
    }
    await startCamera();
  };

  const onFilePicked = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    onCaptured(file, url);
    setCamError('');
    stopCamera();
  };

  const preview = photoPreview || existingUrl || null;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={s.label}>Reference photo (face)</div>
      <div style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: 10,
        background: t.surface2 || t.bg,
      }}>
        {/* Keep video in DOM so ref is ready when stream binds */}
        <div style={{ position: 'relative', width: '100%', minHeight: cameraOn || preview ? 0 : 140 }}>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{
              width: '100%',
              maxHeight: 220,
              borderRadius: 6,
              background: '#000',
              objectFit: 'cover',
              display: cameraOn ? 'block' : 'none',
              transform: 'scaleX(-1)',
            }}
          />
          {!cameraOn && preview && (
            <img
              src={preview}
              alt="Operator reference"
              style={{ width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: 6, display: 'block' }}
            />
          )}
          {!cameraOn && !preview && (
            <div style={{
              height: 140, borderRadius: 6, background: t.bg,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: t.textFaint, fontSize: 12, textAlign: 'center', padding: 12,
            }}>
              Open live camera to capture, or upload a photo from disk
            </div>
          )}
          {cameraOn && !ready && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 12, background: 'rgba(0,0,0,0.45)', borderRadius: 6,
            }}>
              Starting camera…
            </div>
          )}
        </div>
        {camError && (
          <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{camError}</div>
        )}
        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          hidden
          onChange={onFilePicked}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {!cameraOn ? (
            <>
              <button type="button" style={s.outlineBtn} onClick={startCamera} disabled={starting}>
                {starting ? 'Starting…' : (preview ? 'Retake (live camera)' : 'Open live camera')}
              </button>
              <button type="button" style={s.submitBtn} onClick={onCaptureClick} disabled={starting}>
                Capture photo
              </button>
              <button type="button" style={s.outlineBtn} onClick={() => uploadRef.current?.click()}>
                Upload photo
              </button>
            </>
          ) : (
            <>
              <button type="button" style={s.submitBtn} onClick={takePhoto} disabled={!ready}>
                {ready ? 'Capture photo' : 'Wait for preview…'}
              </button>
              <button type="button" style={s.outlineBtn} onClick={() => uploadRef.current?.click()}>
                Upload photo
              </button>
              <button type="button" style={s.outlineBtn} onClick={stopCamera}>Cancel camera</button>
            </>
          )}
          {(photoBlob || photoPreview) && (
            <button
              type="button"
              style={{ ...s.outlineBtn, borderColor: '#ef4444', color: '#ef4444' }}
              onClick={() => { onCleared(); stopCamera(); setCamError(''); }}
            >
              Clear new photo
            </button>
          )}
        </div>
        {photoBlob && (
          <div style={{ marginTop: 6, fontSize: 11, color: '#10b981' }}>New photo ready — will save with the operator</div>
        )}
        {cameraOn && ready && (
          <div style={{ marginTop: 6, fontSize: 11, color: t.textMuted }}>
            Live preview ready — click Capture photo to save this frame.
          </div>
        )}
      </div>
    </div>
  );
}

function DirectoryPanel({ s, t, flash, onOpenDetail }) {
  const [ops, setOps] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [existingPhotoUrl, setExistingPhotoUrl] = useState(null);
  const [photoBlob, setPhotoBlob] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/api/operators/', {
        params: {
          active_only: !showInactive,
          include_temporary: true,
          q: q.trim() || undefined,
          limit: 1000,
        },
      });
      setOps(r.data.operators || []);
      setTotal(r.data.total || 0);
    } catch (e) {
      flash(apiErrorMessage(e), false);
    }
  }, [q, showInactive]);

  useEffect(() => { load(); }, [load]);

  const clearPhotoDraft = () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoBlob(null);
    setPhotoPreview(null);
  };

  const resetForm = () => {
    clearPhotoDraft();
    setForm(EMPTY_FORM);
    setEditingId(null);
    setExistingPhotoUrl(null);
  };

  const startEdit = (op) => {
    clearPhotoDraft();
    setEditingId(op.id);
    setExistingPhotoUrl(op.reference_photo_url || null);
    setForm({
      employee_code: op.employee_code,
      name: op.name || '',
      is_temporary: !!op.is_temporary,
      is_active: !!op.is_active,
      password: '',
      pin: '',
      notes: op.notes || '',
    });
  };

  // Open edit form when detail modal requests Edit
  useEffect(() => {
    let raw = null;
    try {
      raw = sessionStorage.getItem('pms_edit_operator_id');
      if (raw) sessionStorage.removeItem('pms_edit_operator_id');
    } catch { /* ignore */ }
    if (!raw || !ops.length) return;
    const op = ops.find((o) => String(o.id) === String(raw));
    if (op) startEdit(op);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ops]);

  const uploadPhoto = async (operatorId, blob) => {
    const fd = new FormData();
    fd.append('file', blob, `op_${operatorId}_ref.jpg`);
    await api.post(`/api/operators/${operatorId}/reference-photo`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  };

  const save = async () => {
    if (!form.employee_code.trim() || !form.name.trim()) {
      flash('Employee code and name are required', false);
      return;
    }
    if (!editingId && form.password.trim().length < 4) {
      flash('Password is required (min 4 characters) for PMS web login', false);
      return;
    }
    if (editingId && form.password.trim() && form.password.trim().length < 4) {
      flash('Password must be at least 4 characters', false);
      return;
    }
    setSaving(true);
    try {
      let operatorId = editingId;
      if (editingId) {
        const body = {
          name: form.name.trim(),
          is_temporary: form.is_temporary,
          is_active: form.is_active,
          notes: form.notes || null,
        };
        if (form.password.trim()) body.password = form.password.trim();
        if (form.pin.trim()) body.pin = form.pin.trim();
        await api.put(`/api/operators/${editingId}`, body);
      } else {
        const r = await api.post('/api/operators/', {
          employee_code: form.employee_code.trim(),
          name: form.name.trim(),
          is_temporary: form.is_temporary,
          is_active: form.is_active,
          password: form.password.trim(),
          pin: form.pin.trim() || null,
          notes: form.notes || null,
        });
        operatorId = r.data.id || r.data.operator_id;
      }
      if (photoBlob && operatorId) {
        await uploadPhoto(operatorId, photoBlob);
      }
      flash(editingId ? 'Operator updated' : 'Operator added — can login with employee code + password');
      resetForm();
      load();
    } catch (e) {
      flash(apiErrorMessage(e), false);
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (op) => {
    if (!window.confirm(`Deactivate ${op.employee_code}? They will leave roster lists.`)) return;
    try {
      await api.delete(`/api/operators/${op.id}`);
      flash('Operator deactivated');
      load();
    } catch (e) {
      flash(apiErrorMessage(e), false);
    }
  };

  return (
    <div style={s.card}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: 20 }}>
        <div>
          <h4 style={s.cardTitle}>{editingId ? 'Edit operator' : 'Add operator'}</h4>
          {!editingId && (
            <>
              <div style={s.label}>Employee code *</div>
              <input
                style={{ ...s.inp, width: '100%', minWidth: 0, marginBottom: 10 }}
                value={form.employee_code}
                onChange={(e) => setForm((f) => ({ ...f, employee_code: e.target.value }))}
                placeholder="e.g. OP001"
              />
            </>
          )}
          {editingId && (
            <div style={{ marginBottom: 10, fontSize: 13, color: t.textDim }}>
              Code: <strong style={{ color: t.text }}>{form.employee_code}</strong>
            </div>
          )}
          <div style={s.label}>Name *</div>
          <input
            style={{ ...s.inp, width: '100%', minWidth: 0, marginBottom: 10 }}
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Display name"
          />
          <div style={s.label}>
            PMS login password {editingId ? '(leave blank to keep)' : '*'}
          </div>
          <input
            type="password"
            style={{ ...s.inp, width: '100%', minWidth: 0, marginBottom: 6 }}
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder={editingId ? 'Set/change web login password' : 'Min 4 characters'}
            autoComplete="new-password"
          />
          <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 10 }}>
            Login username = employee code (e.g. OP001). Role: operator. Creates User Management login automatically.
          </div>
          <div style={s.label}>Tablet PIN {editingId ? '(leave blank to keep)' : '(optional — defaults to password)'}</div>
          <input
            type="password"
            style={{ ...s.inp, width: '100%', minWidth: 0, marginBottom: 10 }}
            value={form.pin}
            onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))}
            placeholder="Min 4 digits"
            autoComplete="new-password"
          />
          <div style={s.label}>Notes</div>
          <input
            style={{ ...s.inp, width: '100%', minWidth: 0, marginBottom: 10 }}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Temp contractor, line, etc."
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.is_temporary}
              onChange={(e) => setForm((f) => ({ ...f, is_temporary: e.target.checked }))}
            />
            Temporary operator
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
            />
            Active
          </label>

          <OperatorPhotoCapture
            s={s}
            t={t}
            existingUrl={existingPhotoUrl}
            photoBlob={photoBlob}
            photoPreview={photoPreview}
            onCaptured={(blob, url) => {
              if (photoPreview) URL.revokeObjectURL(photoPreview);
              setPhotoBlob(blob);
              setPhotoPreview(url);
            }}
            onCleared={clearPhotoDraft}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={s.submitBtn} onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Update' : 'Add operator'}
            </button>
            {editingId && (
              <button type="button" style={s.outlineBtn} onClick={resetForm}>Cancel</button>
            )}
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={s.label}>Search</div>
              <input
                style={{ ...s.inp, width: '100%', minWidth: 0 }}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Code or name"
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: t.textDim }}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <button type="button" style={s.outlineBtn} onClick={load}>Refresh</button>
          </div>
          <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 8 }}>
            {total} operator{total === 1 ? '' : 's'} (page shows up to 1000)
          </div>
          <div style={{ overflowX: 'auto', maxHeight: '58vh' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['Code', 'Name', 'Type', 'PIN', 'Web login', 'Photo', 'Status', ''].map((h) => (
                    <th key={h || 'a'} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ops.map((op) => (
                  <tr key={op.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>
                      <OperatorIdLink id={op.id} label={op.employee_code} t={t} onOpenDetail={onOpenDetail} />
                      <span style={{ color: t.textFaint, fontWeight: 500, marginLeft: 6, fontSize: 11 }}>#{op.id}</span>
                    </td>
                    <td style={s.td}>
                      <OperatorIdLink id={op.id} label={op.name} t={t} onOpenDetail={onOpenDetail} />
                    </td>
                    <td style={s.td}>
                      {op.is_temporary ? (
                        <span style={{ color: '#f59e0b', fontWeight: 600 }}>Temp</span>
                      ) : 'Regular'}
                    </td>
                    <td style={s.td}>{op.has_pin ? 'Yes' : '—'}</td>
                    <td style={s.td}>
                      {op.has_web_login ? (
                        <span style={{ color: '#10b981', fontWeight: 600 }}>Yes</span>
                      ) : (
                        <span style={{ color: '#f59e0b' }}>No</span>
                      )}
                    </td>
                    <td style={s.td}>
                      {op.has_reference_photo ? (
                        <span style={{ color: '#10b981', fontWeight: 600 }}>Yes</span>
                      ) : (
                        <span style={{ color: t.textFaint }}>No</span>
                      )}
                    </td>
                    <td style={s.td}>
                      <span style={{ color: op.is_active ? '#10b981' : '#ef4444', fontWeight: 600 }}>
                        {op.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={s.td}>
                      <button type="button" style={{ ...s.outlineBtn, padding: '4px 10px', marginRight: 6 }} onClick={() => startEdit(op)}>
                        Edit
                      </button>
                      {op.is_active && (
                        <button type="button" style={{ ...s.outlineBtn, padding: '4px 10px', borderColor: '#ef4444', color: '#ef4444' }} onClick={() => deactivate(op)}>
                          Deactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {ops.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>
                      No operators yet. Add them here — a PMS login (operator role) is created automatically.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function RosterPanel({ s, t, flash, onOpenDetail }) {
  const [weekStart, setWeekStart] = useState(mondayIso());
  const [shift, setShift] = useState('A');
  const [data, setData] = useState(null);
  const [dirty, setDirty] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/api/operators/roster', { params: { week_start: weekStart, shift_id: shift } });
      setData(r.data);
      setDirty({});
    } catch (e) {
      flash(apiErrorMessage(e), false);
    }
  }, [weekStart, shift]);

  useEffect(() => { load(); }, [load]);

  const setCell = (operatorId, username, dateStr, status) => {
    setDirty((prev) => ({
      ...prev,
      [`${operatorId}|${dateStr}`]: { operator_id: operatorId, username, entry_date: dateStr, status },
    }));
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        operators: prev.operators.map((op) =>
          (op.operator_id || op.user_id) === operatorId
            ? { ...op, days: { ...op.days, [dateStr]: status } }
            : op,
        ),
      };
    });
  };

  const save = async () => {
    const cells = Object.values(dirty);
    if (!cells.length) { flash('No changes to save'); return; }
    setSaving(true);
    try {
      await api.put('/api/operators/roster', { week_start: weekStart, shift_id: shift, cells });
      flash(`Saved ${cells.length} roster cells`);
      load();
    } catch (e) {
      flash(apiErrorMessage(e), false);
    } finally {
      setSaving(false);
    }
  };

  const shiftWeek = (delta) => {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(d.toISOString().slice(0, 10));
  };

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div style={s.label}>Week starting (Mon)</div>
          <input type="date" style={s.inp} value={weekStart} onChange={(e) => setWeekStart(mondayIso(e.target.value))} />
        </div>
        <div>
          <div style={s.label}>Shift</div>
          <select style={s.inp} value={shift} onChange={(e) => setShift(e.target.value)}>
            {SHIFTS.map((sh) => <option key={sh} value={sh}>Shift {sh}</option>)}
          </select>
        </div>
        <button type="button" style={s.outlineBtn} onClick={() => shiftWeek(-1)}>← Prev</button>
        <button type="button" style={s.outlineBtn} onClick={() => shiftWeek(1)}>Next →</button>
        <button type="button" style={s.submitBtn} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : `Save roster (${Object.keys(dirty).length})`}
        </button>
        <button type="button" style={s.outlineBtn} onClick={load}>Refresh</button>
      </div>
      <p style={{ color: t.textMuted, fontSize: 12, marginTop: 0 }}>
        Plan availability for operators from the Directory. Mark Present to allow machine allocation.
      </p>
      {!data ? <div style={{ color: t.textFaint }}>Loading…</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Operator</th>
                {(data.dates || []).map((d) => (
                  <th key={d} style={s.th}>
                    {new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data.operators || []).map((op) => {
                const oid = op.operator_id || op.user_id;
                return (
                  <tr key={oid}>
                    <td style={{ ...s.td, fontWeight: 600 }}>
                      <OperatorIdLink
                        id={oid}
                        label={opLabel(op)}
                        t={t}
                        onOpenDetail={onOpenDetail}
                      />
                      {op.is_temporary ? (
                        <span style={{ marginLeft: 6, color: '#f59e0b', fontSize: 11 }}>TEMP</span>
                      ) : null}
                    </td>
                    {(data.dates || []).map((d) => {
                      const st = op.days?.[d] || 'Present';
                      return (
                        <td key={d} style={s.td}>
                          <select
                            style={{ ...s.inp, minWidth: 100, borderColor: statusColor(st, t), color: statusColor(st, t), fontWeight: 600 }}
                            value={st}
                            onChange={(e) => setCell(oid, op.employee_code || op.username, d, e.target.value)}
                          >
                            {STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {(data.operators || []).length === 0 && (
                <tr>
                  <td colSpan={8} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>
                    No operators found. Add them in the Operator Directory tab.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AllocationPanel({ s, t, flash, onOpenDetail }) {
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [shift, setShift] = useState('A');
  const [data, setData] = useState(null);
  const [available, setAvailable] = useState([]);
  const [picks, setPicks] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [alloc, avail] = await Promise.all([
        api.get('/api/operators/allocation', { params: { entry_date: entryDate, shift_id: shift } }),
        api.get('/api/operators/roster/available', { params: { entry_date: entryDate, shift_id: shift } }),
      ]);
      setData(alloc.data);
      setAvailable(avail.data || []);
      const init = {};
      (alloc.data.machines || []).forEach((m) => {
        init[m.machine_id] = m.allocation?.operator_id || m.allocation?.user_id || '';
      });
      setPicks(init);
    } catch (e) {
      flash(apiErrorMessage(e), false);
    }
  }, [entryDate, shift]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const assignments = Object.entries(picks).map(([machine_id, operator_id]) => ({
        machine_id: Number(machine_id),
        operator_id: operator_id === '' || operator_id == null ? null : Number(operator_id),
      }));
      await api.put('/api/operators/allocation', { entry_date: entryDate, shift_id: shift, assignments });
      flash('Machine allocations saved — tablets will show assigned operator for acknowledgment');
      load();
    } catch (e) {
      flash(apiErrorMessage(e), false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div style={s.label}>Date</div>
          <input type="date" style={s.inp} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
        </div>
        <div>
          <div style={s.label}>Shift</div>
          <select style={s.inp} value={shift} onChange={(e) => setShift(e.target.value)}>
            {SHIFTS.map((sh) => <option key={sh} value={sh}>Shift {sh}</option>)}
          </select>
        </div>
        <button type="button" style={s.submitBtn} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save allocations'}
        </button>
        <button type="button" style={s.outlineBtn} onClick={load}>Refresh</button>
      </div>
      <p style={{ color: t.textMuted, fontSize: 12 }}>
        Assign Present operators to machines. Tablets show the employee code; the operator acknowledges with PIN (or linked login).
      </p>
      <div style={{ marginBottom: 12, color: t.textDim, fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span>Available (Present):</span>
        {available.length === 0 ? '—' : available.map((a, i) => (
          <span key={a.operator_id || a.user_id}>
            <OperatorIdLink
              id={a.operator_id || a.user_id}
              label={opLabel(a)}
              t={t}
              onOpenDetail={onOpenDetail}
            />
            {i < available.length - 1 ? ',' : ''}
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {(data?.machines || []).map((m) => {
          const st = m.allocation?.status;
          const allocOid = m.allocation?.operator_id || m.allocation?.user_id;
          return (
            <div key={m.machine_id} style={{ background: t.surface2, borderRadius: 8, padding: 14, borderLeft: `3px solid ${statusColor(st || 'none', t)}` }}>
              <div style={{ fontWeight: 700, color: t.accent, marginBottom: 4 }}>
                {m.machine_name} <span style={{ color: t.textFaint, fontWeight: 500 }}>(ID {m.machine_id})</span>
              </div>
              <div style={{ fontSize: 12, color: t.textMuted, marginBottom: 8 }}>{m.station_name || '—'}</div>
              <select
                style={{ ...s.inp, width: '100%', minWidth: 0 }}
                value={picks[m.machine_id] ?? ''}
                onChange={(e) => setPicks((p) => ({ ...p, [m.machine_id]: e.target.value }))}
              >
                <option value="">— Unassigned —</option>
                {available.map((a) => {
                  const oid = a.operator_id || a.user_id;
                  return <option key={oid} value={oid}>{opLabel(a)}</option>;
                })}
                {m.allocation && !available.find((a) => (a.operator_id || a.user_id) === allocOid) && (
                  <option value={allocOid}>{m.allocation.username}</option>
                )}
              </select>
              {m.allocation && (
                <div style={{ marginTop: 8, fontSize: 11, color: statusColor(m.allocation.status, t), fontWeight: 600 }}>
                  Status: {m.allocation.status}
                  {m.allocation.acknowledged_via ? ` · via ${m.allocation.acknowledged_via}` : ''}
                  {allocOid ? (
                    <>
                      {' · '}
                      <OperatorIdLink id={allocOid} label={m.allocation.username} t={t} onOpenDetail={onOpenDetail} />
                    </>
                  ) : null}
                </div>
              )}
              {m.live_session && (
                <div style={{ marginTop: 6, fontSize: 11, color: '#10b981' }}>
                  Live:{' '}
                  <OperatorIdLink
                    id={m.live_session.operator_id || m.live_session.user_id}
                    label={m.live_session.username}
                    t={t}
                    onOpenDetail={onOpenDetail}
                  />
                  {' '}(running now)
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReportsPanel({ s, t, flash }) {
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState('attendance');
  const [rows, setRows] = useState([]);
  const [run, setRun] = useState(null);

  const load = useCallback(async () => {
    try {
      if (mode === 'attendance') {
        const r = await api.get('/api/operators/reports/attendance', { params: { from_date: fromDate, to_date: toDate } });
        setRows(r.data.rows || []);
        setRun(null);
      } else {
        const r = await api.get('/api/operators/reports/machine-run', { params: { from_date: fromDate, to_date: toDate } });
        setRun(r.data);
        setRows([]);
      }
    } catch (e) {
      flash(apiErrorMessage(e), false);
    }
  }, [fromDate, toDate, mode]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div style={s.label}>From</div>
          <input type="date" style={s.inp} value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div>
          <div style={s.label}>To</div>
          <input type="date" style={s.inp} value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div>
          <div style={s.label}>Report</div>
          <select style={s.inp} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="attendance">Attendance</option>
            <option value="machine">Who ran machine</option>
          </select>
        </div>
        <button type="button" style={s.outlineBtn} onClick={load}>Refresh</button>
      </div>

      {mode === 'attendance' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Date', 'Operator', 'Shift', 'Machine', 'In', 'Out', 'Mins', 'Status', 'Allocation'].map((h) => (
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={s.td}>{r.date}</td>
                  <td style={s.td}>{r.username}</td>
                  <td style={s.td}>{r.shift_id || '—'}</td>
                  <td style={s.td}>{r.machine_name || '—'}</td>
                  <td style={s.td}>{fmtTime(r.time_in)}</td>
                  <td style={s.td}>{fmtTime(r.time_out)}</td>
                  <td style={s.td}>{r.duration_mins ?? '—'}</td>
                  <td style={s.td}>{r.status}</td>
                  <td style={s.td}>{r.allocation_status || '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9} style={{ ...s.td, textAlign: 'center', color: t.textFaint }}>No attendance rows</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {mode === 'machine' && run && (
        <>
          <h4 style={s.cardTitle}>Allocations</h4>
          <div style={{ overflowX: 'auto', marginBottom: 20 }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['Date', 'Shift', 'Machine', 'Operator', 'Status', 'Source', 'Ack'].map((h) => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(run.allocations || []).map((a) => (
                  <tr key={a.id}>
                    <td style={s.td}>{a.entry_date}</td>
                    <td style={s.td}>{a.shift_id}</td>
                    <td style={s.td}>{a.machine_name || a.machine_id}</td>
                    <td style={s.td}>{a.username}</td>
                    <td style={{ ...s.td, color: statusColor(a.status, t), fontWeight: 600 }}>{a.status}</td>
                    <td style={s.td}>{a.source}</td>
                    <td style={s.td}>{a.acknowledged_via || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4 style={s.cardTitle}>Live / history sessions</h4>
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {['Operator', 'Machine', 'Shift', 'Started', 'Ended', 'Status'].map((h) => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(run.sessions || []).map((sess) => (
                  <tr key={sess.id}>
                    <td style={s.td}>{sess.username}</td>
                    <td style={s.td}>{sess.machine_name || sess.machine_id}</td>
                    <td style={s.td}>{sess.shift_id || '—'}</td>
                    <td style={s.td}>{fmtTime(sess.started_at)}</td>
                    <td style={s.td}>{fmtTime(sess.ended_at)}</td>
                    <td style={s.td}>{sess.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

function getStyles(t) {
  return {
    card: { background: t.surface, borderRadius: 10, padding: 20, marginBottom: 16 },
    cardTitle: { color: t.accent, margin: '0 0 14px', fontSize: 14, fontWeight: 600 },
    label: { color: t.textDim, fontSize: 11, fontWeight: 600, marginBottom: 4 },
    inp: {
      padding: '7px 10px', borderRadius: 6, border: `1px solid ${t.inpBorder}`,
      background: t.inp, color: t.text, fontSize: 13, minWidth: 140,
    },
    tabBtn: {
      padding: '8px 16px', borderRadius: 8, border: '1px solid', cursor: 'pointer',
      fontWeight: 600, fontSize: 13,
    },
    submitBtn: {
      padding: '8px 18px', background: t.brand || t.accent, color: '#fff', border: 'none',
      borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13,
    },
    outlineBtn: {
      padding: '8px 14px', background: 'transparent', color: t.accent,
      border: `1px solid ${t.accent}`, borderRadius: 8, cursor: 'pointer', fontSize: 13,
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: {
      padding: '10px', background: t.surface2, color: t.textDim,
      textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 600,
    },
    td: { padding: '8px 10px', borderBottom: `1px solid ${t.border}`, verticalAlign: 'middle' },
  };
}
