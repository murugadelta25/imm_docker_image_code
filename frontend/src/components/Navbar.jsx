import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { NAV_ICONS, renderNavIcon } from './icons/NavIcon';

const NAV_LINKS = {
  admin:       ['/dashboard', '/planning', '/entry', '/model-change', '/breakdown', '/maintenance'],
  supervisor:  ['/dashboard', '/planning', '/entry', '/model-change', '/breakdown'],
  operator:    ['/dashboard', '/planning', '/entry', '/model-change', '/breakdown'],
  maintenance: ['/maintenance'],
};

const LABELS = {
  '/dashboard':    { label: 'Dashboard',    icon: NAV_ICONS.dashboard },
  '/planning':     { label: 'Planning',     icon: NAV_ICONS.planning },
  '/entry':        { label: 'Data Entry',   icon: NAV_ICONS.entry },
  '/model-change': { label: 'Model Change', icon: NAV_ICONS.modelChange },
  '/breakdown':    { label: 'Breakdown',    icon: NAV_ICONS.breakdown },
  '/maintenance':  { label: 'Maintenance',  icon: NAV_ICONS.maintenance },
};

export default function Navbar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const { theme: t } = useTheme();

  const links = NAV_LINKS[user?.role] || [];

  return (
    <nav style={{ ...s.nav, background: t.surface, borderBottom: `1px solid ${t.border}` }}>
      <span style={{ ...s.brand, color: t.brand }}>⚙ PRODUCTION MONITORING SOLUTION</span>
      <div style={s.links}>
        {links.map(path => {
          const active = pathname === path;
          const { label, icon } = LABELS[path] || {};
          return (
            <Link key={path} to={path}
              style={{ ...s.link, color: active ? t.accent : t.textMuted,
                       background: active ? t.bg : 'transparent', fontWeight: active ? 600 : 400 }}>
              {renderNavIcon(icon)}
              {label}
            </Link>
          );
        })}
      </div>
      <div style={s.right}>
        <span style={{ ...s.roleBadge, background: t.bg, color: t.brand }}>{user?.role}</span>
        <span style={{ ...s.user, color: t.textMuted }}>{user?.username}</span>
        <button style={{ ...s.logout, background: t.accent, color: '#fff' }} onClick={() => { logout(); nav('/login'); }}>Logout</button>
      </div>
    </nav>
  );
}

const s = {
  nav:       { display: 'flex', alignItems: 'center', padding: '0 24px', height: 52, gap: 8 },
  brand:     { fontWeight: 700, fontSize: 18, marginRight: 24, whiteSpace: 'nowrap' },
  links:     { display: 'flex', gap: 2, flex: 1 },
  link:      { display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none',
               padding: '6px 12px', borderRadius: 6, fontSize: 13, whiteSpace: 'nowrap', transition: 'background 0.15s' },
  right:     { display: 'flex', alignItems: 'center', gap: 10 },
  roleBadge: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase' },
  user:      { fontSize: 13 },
  logout:    { border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 13 },
};
