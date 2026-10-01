import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { assetUrl } from '../api/config';
import { DEFAULT_APP_NAME } from '../config/branding';

const BrandingContext = createContext(null);

/** Built-in app logo used before any factory logo is uploaded. */
export const DEFAULT_LOGO_URL = '/din_pms.png';

function applyFavicon(url) {
  const hrefBase = assetUrl(url) || DEFAULT_LOGO_URL;
  let link = document.querySelector("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  // Cache-bust so a newly uploaded factory logo replaces the previous favicon.
  link.href = hrefBase.includes('?') ? `${hrefBase}&t=${Date.now()}` : `${hrefBase}?t=${Date.now()}`;
  link.type = 'image/png';
}

export function BrandingProvider({ children }) {
  const [siteTitle, setSiteTitle] = useState(DEFAULT_APP_NAME);
  const [faviconUrl, setFaviconUrl] = useState(null);
  const [loginImageEnabled, setLoginImageEnabled] = useState(false);
  const [loginImageUrl, setLoginImageUrl] = useState(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    return api
      .get('/api/config/branding')
      .then((response) => {
        const title = (response.data?.siteTitle || '').trim() || DEFAULT_APP_NAME;
        setSiteTitle(title);
        setFaviconUrl(response.data?.faviconUrl || null);
        setLoginImageEnabled(!!response.data?.loginImageEnabled);
        setLoginImageUrl(response.data?.loginImageUrl || null);
        setLogoVersion((v) => v + 1);
        setLoaded(true);
        return title;
      })
      .catch(() => {
        setSiteTitle(DEFAULT_APP_NAME);
        setFaviconUrl(null);
        setLoginImageEnabled(false);
        setLoginImageUrl(null);
        setLogoVersion((v) => v + 1);
        setLoaded(true);
        return DEFAULT_APP_NAME;
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    document.title = siteTitle;
  }, [siteTitle]);

  useEffect(() => {
    applyFavicon(faviconUrl);
  }, [faviconUrl, logoVersion]);

  // App header / favicon logo — never mixed with login hero image
  const logoUrl = useMemo(() => {
    const base = assetUrl(faviconUrl) || DEFAULT_LOGO_URL;
    return `${base}${base.includes('?') ? '&' : '?'}v=${logoVersion || 1}`;
  }, [faviconUrl, logoVersion]);

  // Login hero — custom company image when enabled, else default DIN PMS logo
  const loginHeroUrl = useMemo(() => {
    if (loginImageEnabled && loginImageUrl) {
      const base = assetUrl(loginImageUrl) || loginImageUrl;
      return `${base}${base.includes('?') ? '&' : '?'}v=${logoVersion || 1}`;
    }
    return `${DEFAULT_LOGO_URL}?v=${logoVersion || 1}`;
  }, [loginImageEnabled, loginImageUrl, logoVersion]);

  const value = useMemo(
    () => ({
      siteTitle,
      faviconUrl,
      logoUrl,
      loginImageEnabled,
      loginImageUrl,
      loginHeroUrl,
      loaded,
      reload,
    }),
    [siteTitle, faviconUrl, logoUrl, loginImageEnabled, loginImageUrl, loginHeroUrl, loaded, reload],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  const context = useContext(BrandingContext);
  if (!context) {
    throw new Error('useBranding must be used within BrandingProvider');
  }
  return context;
}
