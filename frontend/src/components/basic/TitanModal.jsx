import { useTheme } from '../../context/ThemeContext';
import { surfaceClass } from '../../themes/tileHelpers';

/**
 * Theme-aware modal overlay — matches Titan page chrome (no raw MUI Dialog).
 */
export default function TitanModal({
  title, subtitle, onClose, children, footer, wide = false, maxWidth,
}) {
  const { theme: t } = useTheme();
  const width = maxWidth || (wide ? 1120 : 720);

  return (
    <div
      className="titan-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'var(--titan-spacing-md, 16px)',
        overflow: 'auto',
      }}
    >
      <div
        className={surfaceClass(t, 'main') || undefined}
        style={{
          width: '100%',
          maxWidth: width,
          margin: 'auto',
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 10,
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
          overflow: 'hidden',
          color: t.text,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            borderBottom: `1px solid ${t.border}`,
            background: t.surface2,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: t.accent }}>{title}</h2>
            {subtitle && (
              <p style={{ margin: '4px 0 0', fontSize: 12, color: t.textDim }}>{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            className="titan-icon-btn"
            onClick={onClose}
            aria-label="Close"
            style={{ color: t.textMuted, fontSize: 22, lineHeight: 1 }}
          >
            ×
          </button>
        </header>
        <div style={{ padding: '16px 20px', maxHeight: 'calc(100vh - 120px)', overflow: 'auto' }}>{children}</div>
        {footer && (
          <footer
            style={{
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
              flexWrap: 'wrap',
              padding: '12px 16px',
              borderTop: `1px solid ${t.border}`,
              background: t.surface2,
            }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
