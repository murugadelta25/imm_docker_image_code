import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const STORAGE_KEY = 'titan-shell-nav-hidden';

const EmbedContext = createContext(null);

function isTruthyParam(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

function detectIntegration(searchParams) {
  if (isTruthyParam(searchParams.get('embed'))) return true;
  if (import.meta.env.VITE_EMBED_INTEGRATION === 'true') return true;
  try {
    return window.self !== window.top;
  } catch {
    return false;
  }
}

function readNavHiddenFromUrl(searchParams) {
  if (isTruthyParam(searchParams.get('showNav'))) return false;
  if (isTruthyParam(searchParams.get('hideNav'))) return true;
  if (isTruthyParam(searchParams.get('embed'))) return true;
  return null;
}

function readInitialNavHidden(searchParams, integration) {
  const fromUrl = readNavHiddenFromUrl(searchParams);
  if (fromUrl !== null) return fromUrl;

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    /* ignore */
  }

  if (import.meta.env.VITE_HIDE_SHELL_NAV === 'true') return true;
  if (integration) return true;
  return false;
}

export function EmbedProvider({ children }) {
  const [searchParams] = useSearchParams();

  const isIntegration = useMemo(() => detectIntegration(searchParams), [searchParams]);

  const [navHidden, setNavHidden] = useState(() =>
    readInitialNavHidden(searchParams, detectIntegration(searchParams)),
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, String(navHidden));
    } catch {
      /* ignore */
    }
  }, [navHidden]);

  useEffect(() => {
    if (!isIntegration) return undefined;

    const handler = (event) => {
      const data = event.data;
      if (!data || data.type !== 'titan-shell-nav') return;

      if (typeof data.hidden === 'boolean') {
        setNavHidden(data.hidden);
      } else if (data.toggle) {
        setNavHidden((value) => !value);
      } else if (typeof data.visible === 'boolean') {
        setNavHidden(!data.visible);
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isIntegration]);

  const toggleNav = useCallback(() => {
    setNavHidden((value) => !value);
  }, []);

  const value = useMemo(
    () => ({
      isIntegration,
      navHidden,
      setNavHidden,
      toggleNav,
      showNav: !navHidden,
    }),
    [isIntegration, navHidden, toggleNav],
  );

  return <EmbedContext.Provider value={value}>{children}</EmbedContext.Provider>;
}

export function useEmbed() {
  const context = useContext(EmbedContext);
  if (!context) {
    throw new Error('useEmbed must be used within EmbedProvider');
  }
  return context;
}
