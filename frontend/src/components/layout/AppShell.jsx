/**
 * App shell — CPLM Root.tsx layout (Main > AppBar + Lower > Navigator + Outlet).
 */
import { useState } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useEmbed } from '../../context/EmbedContext';
import { useTheme } from '../../context/ThemeContext';
import { useConfig } from '../../context/ConfigContext';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';
import { contentAreaStyle } from '../../themes/pmsThemes';
import Sidebar from '../Sidebar';
import AppBar from './AppBar';

export default function AppShell() {
  const { theme } = useTheme();
  const { config, ready: configReady } = useConfig();
  const { isIntegration, navHidden, toggleNav } = useEmbed();
  const [navOpen, setNavOpen] = useState(true);
  const { isEnabled } = useFeatureFlags();
  const needsFactorySetup =
    configReady &&
    config?.factory?.configured !== true &&
    isEnabled('settings.factory_setup');

  const sidebarExpanded = isIntegration ? !navHidden : navOpen;
  const onMenuClick = isIntegration ? toggleNav : () => setNavOpen((value) => !value);

  return (
    <div
      className="titan-app-shell"
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        maxWidth: '100vw',
        maxHeight: '100vh',
        overflow: 'hidden',
        background: theme.bg,
        transition: 'background 0.2s',
      }}
    >
      <AppBar
        onMenuClick={onMenuClick}
        isIntegration={isIntegration}
        navVisible={sidebarExpanded}
      />

      <div
        className="titan-lower"
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflow: 'hidden',
        }}
      >
        <Sidebar expanded={sidebarExpanded} />
        <main
          className="titan-app-content"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            ...contentAreaStyle(theme),
          }}
        >
          {/* Overlay — must not push LCP content (avoids CLS when config loads) */}
          {needsFactorySetup && !isIntegration && (
            <div
              className="titan-factory-banner"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 40,
                padding: '10px 16px',
                background: theme.surface || '#0f172a',
                borderBottom: `1px solid ${theme.border}`,
                color: theme.text,
                fontSize: 13,
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              }}
            >
              <span style={{ color: '#f59e0b', fontWeight: 700 }}>Plant setup incomplete. </span>
              Complete your plant setup:{' '}
              <Link to="/factory-setup" style={{ color: theme.accent, fontWeight: 600 }}>
                Factory Setup
              </Link>
            </div>
          )}
          <div
            className="titan-page-outlet"
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              WebkitOverflowScrolling: 'touch',
              scrollbarGutter: 'stable',
            }}
          >
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
