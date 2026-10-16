/**
 * Theme selector — icon buttons for Tech Blue, Dark, and Light.
 */
import { useTheme } from '../../context/ThemeContext';
import {
  DARK_MODE_ICON,
  LIGHT_MODE_ICON,
  THEME_ICON,
  renderNavIcon,
} from '../icons/NavIcon';

const THEME_BUTTONS = [
  { id: 'techBlue', label: 'Tech Blue', icon: THEME_ICON, accent: '#22cae7' },
  { id: 'dark', label: 'Dark', icon: DARK_MODE_ICON, accent: '#38bdf8' },
  { id: 'light', label: 'Light', icon: LIGHT_MODE_ICON, accent: '#1588DA' },
];

export default function ThemeModeToggler() {
  const { theme, themeName, setThemeName } = useTheme();

  return (
    <div
      className="titan-theme-icons"
      data-testid="theme-mode-widget"
      role="group"
      aria-label="Application theme"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: 3,
        borderRadius: 'var(--titan-radius-sm)',
        border: `1px solid ${theme.border}`,
        background: theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
      }}
    >
      {THEME_BUTTONS.map((opt) => {
        const active = themeName === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            className="titan-icon-btn titan-theme-icon-btn"
            title={opt.label}
            aria-label={opt.label}
            aria-pressed={active}
            onClick={() => setThemeName(opt.id)}
            style={{
              width: 32,
              height: 32,
              color: active ? opt.accent : theme.textMuted,
              background: active ? `${opt.accent}22` : 'transparent',
              boxShadow: active ? `0 0 0 1px ${opt.accent}55` : 'none',
            }}
          >
            {renderNavIcon(opt.icon)}
          </button>
        );
      })}
    </div>
  );
}
