/** Tech Blue tile helpers — corner brackets + translucent surfaces. */

export function isTechBlueTheme(theme) {
  return theme?.id === 'techBlue';
}

export function pageClass(theme) {
  return isTechBlueTheme(theme) ? 'titan-tech-blue-page' : undefined;
}

export function tileClass(theme) {
  return isTechBlueTheme(theme) ? 'titan-tech-tile' : undefined;
}

/** MUI Box-style surface class for Tech Blue cards (main / nested / raised). */
export function surfaceClass(theme, variant = 'main') {
  if (!isTechBlueTheme(theme)) return undefined;
  if (variant === 'nested') return 'titan-tech-surface-nested';
  if (variant === 'raised') return 'titan-tech-surface-raised';
  return 'titan-tech-surface';
}

export function withSurfaceClass(theme, variant = 'main', className = '') {
  const sc = surfaceClass(theme, variant);
  return [sc, className].filter(Boolean).join(' ') || undefined;
}

/** Card / panel surface style (translucent on Tech Blue). */
export function tileStyle(theme, extra = {}) {
  return {
    background: theme.surface,
    borderRadius: 10,
    ...extra,
  };
}

/** Merge tile className with any existing class. */
export function withTileClass(theme, className = '') {
  const tc = tileClass(theme);
  return [tc, className].filter(Boolean).join(' ') || undefined;
}
