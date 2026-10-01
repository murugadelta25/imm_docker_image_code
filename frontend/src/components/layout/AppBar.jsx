/**
 * CPLM AppBar pattern — logo, system name, theme toggle, user (layout.md).
 */
import { Link } from 'react-router-dom';
import { useBranding } from '../../context/BrandingContext';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import LogoIcon from '../graphics/LogoIcon';
import { MENU_ICON, renderNavIcon } from '../icons/NavIcon';
import ThemeModeToggler from './ThemeModeToggler';

export default function AppBar({ onMenuClick, isIntegration = false, navVisible = true }) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const { siteTitle, logoUrl } = useBranding();

  const menuTitle = isIntegration
    ? navVisible
      ? 'Hide navigation menu'
      : 'Show navigation menu'
    : 'Toggle navigation';

  return (
    <header
      className="titan-app-bar"
      style={{
        height: 'var(--titan-appbar-height)',
        minHeight: 'var(--titan-appbar-height)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--titan-spacing-md)',
        gap: 'var(--titan-spacing-sm)',
        background: theme.appBarBg || theme.surface,
        borderBottom: `3px solid ${theme.appBarBorder || theme.border}`,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        className="titan-icon-btn"
        onClick={onMenuClick}
        title={menuTitle}
        aria-pressed={navVisible}
        style={{ color: navVisible ? theme.accent : theme.textMuted }}
      >
        {renderNavIcon(MENU_ICON)}
      </button>

      {isIntegration && (
        <button
          type="button"
          onClick={onMenuClick}
          title={menuTitle}
          style={{
            border: `1px solid ${navVisible ? theme.accent : theme.border}`,
            background: navVisible ? `${theme.accent}22` : 'transparent',
            color: navVisible ? theme.accent : theme.textMuted,
            borderRadius: 'var(--titan-radius-sm)',
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Nav {navVisible ? 'On' : 'Off'}
        </button>
      )}

      <Link
        to="/dashboard"
        title={siteTitle}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          textDecoration: 'none',
          minWidth: 0,
        }}
      >
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={siteTitle}
            style={{
              height: 32,
              maxWidth: 120,
              objectFit: 'contain',
              display: 'block',
              flexShrink: 0,
            }}
          />
        ) : (
          <LogoIcon size={32} />
        )}
        <span
          style={{
            color: theme.accent,
            fontWeight: 700,
            fontSize: 14,
            letterSpacing: '0.5px',
            whiteSpace: 'nowrap',
            minWidth: 140,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {siteTitle}
        </span>
      </Link>

      <div style={{ flex: 1 }} />

      <ThemeModeToggler />

      {user && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginLeft: 'var(--titan-spacing-sm)',
            paddingLeft: 'var(--titan-spacing-sm)',
            borderLeft: `1px solid ${theme.border}`,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: theme.accent,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 700,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            {user.username?.[0]?.toUpperCase()}
          </div>
          <div style={{ lineHeight: 1.2, minWidth: 0 }}>
            <div
              style={{
                color: theme.text,
                fontSize: 13,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.username}
            </div>
            <div
              style={{
                color: theme.textDim,
                fontSize: 10,
                textTransform: 'uppercase',
                fontWeight: 700,
                letterSpacing: '0.04em',
              }}
            >
              {user.role}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
