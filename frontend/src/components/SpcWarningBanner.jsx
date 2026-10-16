import { useTheme } from '../context/ThemeContext';

export default function SpcWarningBanner({ warnings, title = 'SPC process warning' }) {
  const { theme: t } = useTheme();
  if (!warnings?.length) return null;

  const warnColor = t.warning || '#ed6c02';
  const bg = t.isDark ? 'rgba(237, 108, 2, 0.15)' : '#fff3e0';

  return (
    <div style={{
      marginBottom: 12,
      padding: '10px 14px',
      borderRadius: 8,
      border: `1px solid ${warnColor}`,
      background: bg,
    }}
    >
      <div style={{
        fontWeight: 700, fontSize: 13, color: warnColor, marginBottom: 6,
      }}
      >
        ⚠ {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: t.text }}>
        {warnings.map((w, i) => (
          <li key={`${w.code}-${w.parameter}-${i}`} style={{ marginBottom: 4 }}>
            {w.parameter && (
              <strong style={{ color: t.text }}>{w.parameter}: </strong>
            )}
            {w.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
