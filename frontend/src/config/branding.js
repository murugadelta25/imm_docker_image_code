/**
 * Default application name when not set in database or environment.
 * Override at deploy time: VITE_APP_NAME=Your Plant Name (PMS)
 */
export const DEFAULT_APP_NAME =
  (import.meta.env.VITE_APP_NAME || '').trim() || 'Production Monitoring System (PMS)';
