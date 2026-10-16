import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { THEMES, THEME_ORDER, getTheme } from '../themes/pmsThemes';

export { THEMES };

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [themeName, setThemeName] = useState(
    () => localStorage.getItem('pms_theme') || 'techBlue',
  );

  const theme = useMemo(() => getTheme(themeName), [themeName]);

  const cycleTheme = useCallback(() => {
    setThemeName((prev) => {
      const idx = THEME_ORDER.indexOf(prev);
      const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
      return next;
    });
  }, []);

  const toggleMode = useCallback(() => {
    setThemeName((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  useEffect(() => {
    localStorage.setItem('pms_theme', themeName);
    const r = document.documentElement;
    r.dataset.theme = themeName;
    r.style.setProperty('--bg', theme.bg);
    r.style.setProperty('--surface', theme.surface);
    r.style.setProperty('--surface-2', theme.surface2);
    if (theme.surfaceRaised) r.style.setProperty('--surface-raised', theme.surfaceRaised);
    else r.style.removeProperty('--surface-raised');
    r.style.setProperty('--border', theme.border);
    r.style.setProperty('--text', theme.text);
    r.style.setProperty('--text-muted', theme.textMuted);
    r.style.setProperty('--text-dim', theme.textDim ?? theme.textMuted);
    r.style.setProperty('--text-faint', theme.textFaint ?? theme.textMuted);
    if (theme.labelColor) r.style.setProperty('--label-color', theme.labelColor);
    else r.style.removeProperty('--label-color');
    if (theme.titleColor) r.style.setProperty('--title-color', theme.titleColor);
    else r.style.removeProperty('--title-color');
    r.style.setProperty('--accent', theme.accent);
    r.style.setProperty('--nav-hover', theme.navHover);
    r.style.setProperty('--nav-focus', theme.navFocus);
    r.style.setProperty('--scroll-track', theme.scrollTrack);
    r.style.setProperty('--scroll-thumb', theme.scrollThumb);
    if (theme.contentBg) r.style.setProperty('--content-bg', theme.contentBg);
    else r.style.removeProperty('--content-bg');
    r.style.setProperty('--nav-bg', theme.navBg);
    r.style.setProperty('--appbar-bg', theme.appBarBg);
    r.style.setProperty('--appbar-border', theme.appBarBorder);
    r.style.setProperty('--page-bg', theme.contentBgImage ? 'transparent' : (theme.pageBg ?? theme.bg));
    if (theme.id === 'techBlue') {
      r.style.setProperty('--tile-accent', theme.accent);
    } else {
      r.style.removeProperty('--tile-accent');
    }
    document.body.style.background = theme.bg;
    document.body.style.color = theme.text;
    document.body.style.fontFamily = theme.fontFamily;
  }, [themeName, theme]);

  return (
    <ThemeContext.Provider value={{
      theme,
      themeName,
      setThemeName,
      toggleMode,
      cycleTheme,
      themeOptions: THEME_ORDER.map((id) => ({ id, name: THEMES[id].name })),
    }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
