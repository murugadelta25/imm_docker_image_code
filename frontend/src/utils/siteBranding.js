import { assetUrl } from '../api/config';

const DEFAULT_TITLE = 'DELTA-EAP-PMS';

function ensureFaviconLink() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    document.head.appendChild(link);
  }
  return link;
}

/** Apply browser tab title and favicon from factory config or branding API response. */
export function applySiteBranding({ siteTitle, faviconUrl, factories, faviconFactoryId } = {}) {
  const title = siteTitle || DEFAULT_TITLE;
  document.title = title;

  let logo = faviconUrl || null;
  if (!logo && factories?.length) {
    const fav = faviconFactoryId
      ? factories.find(f => f.id === faviconFactoryId)
      : null;
    logo = fav?.logoUrl || factories.find(f => f.logoUrl)?.logoUrl || null;
  }

  const link = ensureFaviconLink();
  // Fall back to built-in DIN PMS logo (not a factory upload).
  const href = assetUrl(logo) || '/din_pms.png';
  link.href = href.includes('?') ? `${href}&t=${Date.now()}` : `${href}?t=${Date.now()}`;
  link.type = 'image/png';
}

export async function fetchPublicBranding() {
  try {
    const res = await fetch('/api/config/branding');
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
