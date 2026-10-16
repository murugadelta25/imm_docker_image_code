import axios from 'axios';

const platformApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  timeout: 30000,
});

platformApi.interceptors.request.use(cfg => {
  const token = localStorage.getItem('platform_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

platformApi.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && !err.config?.url?.includes('/api/platform/login')) {
      localStorage.removeItem('platform_token');
      localStorage.removeItem('platform_user');
      if (!window.location.pathname.startsWith('/platform')) {
        window.location.href = '/platform/login';
      }
    }
    return Promise.reject(err);
  },
);

export default platformApi;
