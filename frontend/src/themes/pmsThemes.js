import pmmBackground from '../assets/themes/pmm_background.png';
import paperBackground from '../assets/themes/paper_background.png';

/** Shared background assets from new_theme package */
export const THEME_ASSETS = {
  content: pmmBackground,
  nav: paperBackground,
};

/**
 * Runtime theme tokens (derived from muiTheme + techBlueTheme, English-only).
 * dark / light = original PMS themes; techBlue = new_theme tech palette.
 */
export const THEMES = {
  dark: {
    id: 'dark',
    name: 'Dark',
    isDark: true,
    bg: '#0f172a',
    surface: '#1e293b',
    surface2: '#1a2540',
    border: '#3d5068',
    text: '#f8fafc',
    textMuted: '#cbd5e1',
    textDim: '#94a3b8',
    textFaint: '#64748b',
    accent: '#38bdf8',
    brand: '#22c55e',
    navHover: 'rgba(56, 189, 248, 0.08)',
    navFocus: 'rgba(56, 189, 248, 0.16)',
    inp: '#0f172a',
    inpBorder: '#4a6080',
    scrollTrack: '#1e293b',
    scrollThumb: '#475569',
    appBarBg: '#1e293b',
    appBarBorder: '#3d5068',
    contentBg: '#0f172a',
    pageBg: undefined,
    navStyle: 'accent',
    navBg: '#1e293b',
    fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  light: {
    id: 'light',
    name: 'Light',
    isDark: false,
    bg: '#F0F2F9',
    surface: 'rgba(254, 254, 254, 0.92)',
    surface2: '#f8fafc',
    border: '#D9D9D9',
    text: '#333333',
    textMuted: '#727171',
    textDim: '#737272',
    textFaint: '#A6A6A6',
    accent: '#1588DA',
    brand: '#77AF46',
    navHover: 'rgba(21, 136, 218, 0.08)',
    navFocus: 'rgba(21, 136, 218, 0.14)',
    inp: '#ffffff',
    inpBorder: 'rgba(0, 0, 0, 0.23)',
    scrollTrack: '#e2e8f0',
    scrollThumb: '#94a3b8',
    appBarBg: 'linear-gradient(180deg, #fefefef2, #fafafaf2)',
    appBarBorder: '#D9D9D9CC',
    contentBg: '#F0F2F9',
    navStyle: 'classic',
    navBg: 'rgba(254, 254, 254, 0.92)',
    fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
  techBlue: {
    id: 'techBlue',
    name: 'Tech Blue',
    isDark: true,
    bg: '#03133a',
    /** MUI Paper / Box — light bluish panel (techBlueTheme background.default + picker gradient) */
    surface: 'linear-gradient(160deg, rgba(43, 62, 108, 0.94) 0%, rgba(12, 74, 110, 0.90) 100%)',
    surface2: 'rgba(34, 49, 87, 0.82)',
    surfaceRaised: 'rgba(55, 90, 130, 0.88)',
    border: '#22cae7',
    text: '#ffffff',
    textMuted: '#d4eef8',
    textDim: '#22cae7',
    textFaint: '#9ec8de',
    labelColor: '#22cae7',
    titleColor: '#ffffff',
    accent: '#22cae7',
    brand: '#77AF46',
    navHover: 'rgba(34, 202, 231, 0.12)',
    navFocus: 'rgba(34, 202, 231, 0.22)',
    inp: 'rgba(4, 20, 59, 0.85)',
    inpBorder: '#22cae7',
    scrollTrack: '#223157',
    scrollThumb: '#22cae7',
    appBarBg: 'linear-gradient(rgba(8, 49, 82, 1), rgba(11, 75, 107, 1))',
    appBarBorder: '#22cae7',
    contentBgImage: `url(${pmmBackground})`,
    contentBgOverlay: 'linear-gradient(131.08deg, rgba(3, 19, 58, 0.42) 18.73%, rgba(1, 9, 28, 0.52) 84.69%)',
    navStyle: 'accent',
    navBg: `linear-gradient(135deg, rgba(12, 59, 94, 0.82) 27%, rgba(13, 26, 61, 0.88) 63%), url(${paperBackground}) center top / cover no-repeat`,
    fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  },
};

export const THEME_ORDER = ['techBlue', 'dark', 'light'];

export function getTheme(id) {
  return THEMES[id] || THEMES.dark;
}

/** Page wrapper background — transparent only when content image should show through (Tech Blue). */
export function pageBackground(theme) {
  if (theme.contentBgImage) return 'transparent';
  return theme.pageBg ?? theme.bg;
}

/** Main content area background layers (image + optional overlay). */
export function contentAreaStyle(theme) {
  if (theme.contentBgOverlay && theme.contentBgImage) {
    return {
      backgroundColor: theme.bg,
      backgroundImage: `${theme.contentBgOverlay}, ${theme.contentBgImage}`,
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center center, center center',
      backgroundRepeat: 'no-repeat, no-repeat',
      backgroundAttachment: 'scroll, fixed',
    };
  }
  return { background: theme.contentBg || theme.bg };
}
