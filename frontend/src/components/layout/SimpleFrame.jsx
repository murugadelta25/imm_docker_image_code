/**
 * SimpleFrame — CPLM page shell (dev-guide layout.md).
 *
 * Wraps page content with consistent padding and optional title/actions.
 * Use inside pages for UI consistency without changing business logic.
 */
import { useTheme } from '../../context/ThemeContext';

/**
 * @param {{ title?: string, actions?: import('react').ReactNode, children: import('react').ReactNode, fillBody?: boolean }} props
 */
export default function SimpleFrame({ title, actions, children, fillBody = false }) {
  const { theme: t } = useTheme();

  return (
    <section
      className="titan-simple-frame"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: fillBody ? 1 : undefined,
        minHeight: fillBody ? 0 : undefined,
        padding: '16px 20px',
        gap: 12,
      }}
    >
      {(title || actions) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            borderBottom: `1px solid ${t.border}`,
            paddingBottom: 12,
            flexShrink: 0,
          }}
        >
          {title && (
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: t.text }}>
              {title}
            </h2>
          )}
          {actions && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {actions}
            </div>
          )}
        </header>
      )}
      <div
        style={{
          flex: fillBody ? 1 : undefined,
          minHeight: fillBody ? 0 : undefined,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </section>
  );
}
