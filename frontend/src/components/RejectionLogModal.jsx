import { useEffect, useMemo, useState } from 'react';
import {
  REJECTION_REASONS,
  emptyRejectionQty,
  parseRejectionJson,
  sumRejectionQty,
} from '../constants/rejectionReasons';

/**
 * Rejection Log — reason × qty entry (QC / zone bad-parts).
 */
export default function RejectionLogModal({
  open,
  theme: t,
  title = 'Rejection Log',
  subtitle = '',
  initialQty = null,
  initialJson = null,
  maxTotal = null,
  busy = false,
  error = '',
  onClose,
  onSave,
}) {
  const [qty, setQty] = useState(() => emptyRejectionQty());

  useEffect(() => {
    if (!open) return;
    if (initialQty && typeof initialQty === 'object') {
      setQty({ ...emptyRejectionQty(), ...initialQty });
    } else {
      setQty(parseRejectionJson(initialJson));
    }
  }, [open, initialQty, initialJson]);

  const total = useMemo(() => sumRejectionQty(qty), [qty]);
  const overMax = maxTotal != null && total > maxTotal;

  if (!open) return null;

  const setReason = (reason, value) => {
    const n = value === '' ? 0 : Math.max(0, parseInt(value, 10) || 0);
    setQty((p) => ({ ...p, [reason]: n }));
  };

  const handleSave = (e) => {
    e.preventDefault();
    if (busy || overMax) return;
    onSave?.({ quantities: qty, total });
  };

  const inp = {
    width: 72,
    padding: '6px 8px',
    borderRadius: 4,
    border: `1px solid ${t.inpBorder || t.border}`,
    background: t.isDark === false || t.id === 'light' ? '#fff' : (t.inp || '#0b1220'),
    color: t.text,
    fontSize: 13,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, 100%)',
          maxHeight: '92vh',
          overflow: 'auto',
          background: t.surface || '#e5e7eb',
          borderRadius: 10,
          border: `1px solid ${t.border}`,
          boxShadow: '0 20px 50px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 14px',
          background: t.surface2 || '#d1d5db',
          borderBottom: `1px solid ${t.border}`,
          position: 'sticky', top: 0, zIndex: 1,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.text, textAlign: 'center' }}>{title}</div>
            {subtitle ? (
              <div style={{ fontSize: 11, color: t.accent || t.textMuted, marginTop: 2 }}>{subtitle}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none', border: `1px solid ${t.border}`, borderRadius: 6,
              color: t.textMuted, cursor: 'pointer', padding: '2px 8px', fontSize: 13,
            }}
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSave} style={{ padding: '10px 14px 14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {REJECTION_REASONS.map((reason) => (
              <div
                key={reason}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignItems: 'center',
                  gap: 10,
                  padding: '4px 0',
                  borderBottom: `1px solid ${t.border}55`,
                }}
              >
                <label style={{ fontSize: 13, fontWeight: 600, color: t.text }} htmlFor={`rej-${reason}`}>
                  {reason}
                </label>
                <input
                  id={`rej-${reason}`}
                  type="number"
                  min="0"
                  style={inp}
                  value={qty[reason] ?? 0}
                  onChange={(e) => setReason(reason, e.target.value)}
                />
              </div>
            ))}
          </div>

          <div style={{
            marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 13, fontWeight: 700, color: overMax ? '#ef4444' : t.text,
          }}>
            <span>Total bad parts</span>
            <span>
              {total}
              {maxTotal != null ? ` / ${maxTotal}` : ''}
            </span>
          </div>
          {overMax && (
            <div style={{ color: '#ef4444', fontSize: 12, marginTop: 4 }}>
              Total cannot exceed actual production ({maxTotal}).
            </div>
          )}
          {error && (
            <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{error}</div>
          )}

          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
            <button
              type="submit"
              disabled={busy || overMax}
              style={{
                minWidth: 120,
                padding: '8px 24px',
                borderRadius: 6,
                border: `1px solid ${t.border}`,
                background: busy || overMax ? (t.surface2 || '#9ca3af') : (t.brand || '#77AF46'),
                color: '#fff',
                fontWeight: 800,
                fontSize: 13,
                cursor: busy || overMax ? 'not-allowed' : 'pointer',
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
