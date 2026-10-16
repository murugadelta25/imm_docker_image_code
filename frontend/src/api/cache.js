/**
 * Client-side cache with stale-while-revalidate pattern
 * - Serve cached data immediately (stale)
 * - Revalidate in background if cache expired
 * - Cache TTL: 5 minutes (serve-from-cache)
 * - Max age: 30 minutes (absolute expiry)
 */

const CACHE_CONFIG = {
  // Cache these endpoints aggressively (low-change data)
  '/api/imm/dashboard/zones': { ttl: 300000, maxAge: 1800000 }, // 5min, 30min max
  '/api/imm/dashboard/factory': { ttl: 300000, maxAge: 1800000 },
  '/api/imm/dashboard/factory/running-rate-trend': { ttl: 300000, maxAge: 1800000 },
  '/api/imm/dashboard/zone': { ttl: 300000, maxAge: 1800000 },
  
  // Cache equipment/machine data for 2 minutes
  '/api/imm/dashboard/equipment': { ttl: 120000, maxAge: 600000 },
  
  // Cache OEE data for 3 minutes
  '/api/oee': { ttl: 180000, maxAge: 900000 },
};

class CacheService {
  constructor() {
    this.cache = new Map();
    this.pendingRequests = new Map();
  }

  // Generate cache key from URL and params
  getCacheKey(url, params) {
    const searchParams = new URLSearchParams(params || {});
    const queryString = searchParams.toString();
    return queryString ? `${url}?${queryString}` : url;
  }

  // Check if URL matches cache config
  shouldCache(url) {
    return Object.keys(CACHE_CONFIG).some(pattern => url.includes(pattern));
  }

  // Get cache config for URL
  getCacheConfig(url) {
    for (const [pattern, config] of Object.entries(CACHE_CONFIG)) {
      if (url.includes(pattern)) {
        return config;
      }
    }
    return null;
  }

  // Get cached data if valid
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const age = now - entry.ts;
    const config = entry.config;

    if (age > config.maxAge) {
      // Absolute expiry exceeded - remove and return null
      this.cache.delete(key);
      return null;
    }

    if (age > config.ttl) {
      // Stale but still valid - return with stale flag
      return { ...entry.data, _stale: true };
    }

    // Fresh cache
    return entry.data;
  }

  // Set cache entry
  set(key, data, config) {
    this.cache.set(key, {
      data,
      ts: Date.now(),
      config,
    });
  }

  // Invalidate specific cache entries
  invalidate(pattern) {
    for (const [key] of this.cache) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  // Clear all cache
  clear() {
    this.cache.clear();
    this.pendingRequests.clear();
  }

  // Deduplicate identical in-flight requests
  async deduplicate(key, requestFn) {
    // If request is already in flight, wait for it
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key);
    }

    // Start new request and track it
    const promise = requestFn()
      .finally(() => this.pendingRequests.delete(key));

    this.pendingRequests.set(key, promise);
    return promise;
  }
}

export const cacheService = new CacheService();

/**
 * Create a cached version of an API call
 * Returns: { data, isCached, isStale }
 */
export async function cachedGet(api, url, config = {}) {
  const params = config.params || {};
  const cacheKey = cacheService.getCacheKey(url, params);
  const cacheConfig = cacheService.getCacheConfig(url);

  // Not cacheable
  if (!cacheConfig) {
    const response = await api.get(url, config);
    return { data: response.data, isCached: false, isStale: false };
  }

  // Check cache first
  const cached = cacheService.get(cacheKey);
  if (cached) {
    const isStale = cached._stale === true;
    // Start background revalidation if stale
    if (isStale) {
      // Fire-and-forget revalidation
      cacheService.deduplicate(`revalidate:${cacheKey}`, async () => {
        try {
          const response = await api.get(url, config);
          cacheService.set(cacheKey, response.data, cacheConfig);
        } catch (e) {
          // Revalidation failed - keep serving stale
          console.debug('[Cache] Revalidation failed, keeping stale data', url);
        }
      });
    }
    return {
      data: cached,
      isCached: true,
      isStale,
    };
  }

  // Cache miss - fetch and deduplicate identical requests
  const response = await cacheService.deduplicate(cacheKey, () => api.get(url, config));
  cacheService.set(cacheKey, response.data, cacheConfig);

  return {
    data: response.data,
    isCached: false,
    isStale: false,
  };
}

export default cacheService;
