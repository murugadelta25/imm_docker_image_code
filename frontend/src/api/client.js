import axios from 'axios';
import { PERSISTENT_SESSION_USERNAME } from '../auth/sessionPolicy';

const inIframe = () => {
  try { return window.self !== window.top; } catch { return true; }
};

// Accept token injected by parent PMM3 frame via postMessage
window.addEventListener('message', (e) => {
  if (e.data?.type === 'PMS_TOKEN' && e.data.token) {
    localStorage.setItem('token', e.data.token);
    if (e.data.user) localStorage.setItem('user', JSON.stringify(e.data.user));
  }
});

// Signal parent that we are ready to receive the token
if (inIframe()) {
  window.parent.postMessage({ type: 'PMS_READY' }, '*');
}

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  // No default here — request interceptor sets per-URL timeouts.
  // (A fixed 30000 here previously blocked the interceptor: if (!cfg.timeout) never ran.)
});

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;

  // Per-endpoint timeout strategy (only when caller did not set timeout)
  if (cfg.timeout == null) {
    const url = cfg.url || '';
    if (url.includes('/work-orders')) {
      cfg.timeout = 45000; // list/track-record can be heavier
    } else if (url.includes('/factory') || url.includes('/running-rate-trend')) {
      cfg.timeout = 5000;
    } else if (url.includes('/zones') || url.includes('/equipment')) {
      cfg.timeout = 10000;
    } else if (url.includes('/dashboard') || url.includes('/oee')) {
      cfg.timeout = 8000;
    } else if (url.includes('/health') || url.includes('/status')) {
      cfg.timeout = 5000;
    } else {
      cfg.timeout = 15000;
    }
  }
  return cfg;
});

api.interceptors.response.use(
  r => r,
  err => {
    const url = err.config?.url || '';
    const isAuthPublic = url.includes('/api/auth/login') || url.includes('/api/auth/forgot-password');
    if (err.response?.status === 401 && !isAuthPublic) {
      const userJson = localStorage.getItem('user');
      let username = null;
      try {
        username = userJson ? JSON.parse(userJson).username : null;
      } catch {
        username = null;
      }
      // Don't redirect when embedded — just reject so the component handles it
      if (!inIframe() && username !== PERSISTENT_SESSION_USERNAME) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;
