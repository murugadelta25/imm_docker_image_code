import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useAuth } from './AuthContext';
import { applySiteBranding, fetchPublicBranding } from '../utils/siteBranding';

const DEFAULT_CONFIG = {
  shifts: [
    { id: 'A', name: 'Shift A', start: '08:00', end: '20:00', enabled: true },
    { id: 'B', name: 'Shift B', start: '20:00', end: '08:00', enabled: true },
    { id: 'C', name: 'Shift C', start: '22:00', end: '06:00', enabled: false },
  ],
  breaks: {
    A: {
      lunch_break: 30, lunch_start: '12:00', lunch_end: '12:30',
      tea_break: 10, tea_start: '10:00', tea_end: '10:10',
      tpm_cleaning: 10, tpm_start: '11:00', tpm_end: '11:10',
      other_cleaning: 0, management_meeting: 0,
    },
    B: {
      lunch_break: 30, lunch_start: '00:00', lunch_end: '00:30',
      tea_break: 10, tea_start: '22:00', tea_end: '22:10',
      tpm_cleaning: 10, tpm_start: '23:00', tpm_end: '23:10',
      other_cleaning: 0, management_meeting: 0,
    },
    C: {
      lunch_break: 30, lunch_start: '02:00', lunch_end: '02:30',
      tea_break: 10, tea_start: '00:00', tea_end: '00:10',
      tpm_cleaning: 10, tpm_start: '01:00', tpm_end: '01:10',
      other_cleaning: 0, management_meeting: 0,
    },
  },
  checkDataDaysBack: 1,
  data_capture: {
    mode: 'auto',
  },
  mobile_integration: {
    enabled: true,
  },
  backup: {
    enabled: false,
    interval_days: 15,
    max_backups: 10,
    last_backup_at: null,
  },
};

export function getCurrentShift(config) {
  const now = new Date();
  const hhmm = now.getHours() * 60 + now.getMinutes();
  for (const sh of config.shifts) {
    if (!sh.enabled) continue;
    const [sH, sM] = sh.start.split(':').map(Number);
    const [eH, eM] = sh.end.split(':').map(Number);
    const start = sH * 60 + sM, end = eH * 60 + eM;
    const inShift = end > start ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
    if (inShift) return sh;
  }
  return null;
}

export function timeToMinutes(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60;
  return diff;
}

const ConfigContext = createContext({ config: DEFAULT_CONFIG, ready: false, reload: () => {} });

export function ConfigProvider({ children }) {
  const { user } = useAuth();
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [ready, setReady] = useState(false);

  const reload = useCallback(() => {
    return api.get('/api/config/')
      .then(r => {
        setConfig(r.data);
        setReady(true);
      })
      .catch(() => {
        setReady(true);
      });
  }, []);

  useEffect(() => {
    fetchPublicBranding().then(b => {
      if (b) applySiteBranding(b);
    });
  }, []);

  useEffect(() => {
    const fc = config?.factory;
    if (!fc) return;
    applySiteBranding({
      siteTitle: fc.siteTitle,
      factories: fc.factories,
      faviconFactoryId: fc.faviconFactoryId,
    });
  }, [config?.factory?.siteTitle, config?.factory?.faviconFactoryId, config?.factory?.factories]);

  // Fetch config when user logs in, reset to default on logout
  useEffect(() => {
    if (user) {
      setReady(false);
      reload();
    } else {
      setConfig(DEFAULT_CONFIG);
      setReady(false);
    }
  }, [user, reload]);

  return <ConfigContext.Provider value={{ config, ready, reload }}>{children}</ConfigContext.Provider>;
}

export function useConfig() {
  return useContext(ConfigContext);
}

/** True when Configuration → Mobile App Integration is ON (default true). */
export function isMobileIntegrationEnabled(config) {
  return config?.mobile_integration?.enabled !== false;
}

/** True when Configuration → Data Capture Mode is Manual. */
export function isManualDataEntryEnabled(config) {
  return (config?.data_capture?.mode || 'auto') === 'manual';
}
