import { createContext, useContext, useState } from 'react';
import platformApi from '../api/platformClient';

const PlatformAuthCtx = createContext(null);

export function PlatformAuthProvider({ children }) {
  const [admin, setAdmin] = useState(() => {
    const raw = localStorage.getItem('platform_user');
    return raw ? JSON.parse(raw) : null;
  });

  const login = async (username, password) => {
    const form = new URLSearchParams({ username, password });
    const { data } = await platformApi.post('/api/platform/login', form);
    localStorage.setItem('platform_token', data.access_token);
    localStorage.setItem('platform_user', JSON.stringify({ username: data.username }));
    setAdmin({ username: data.username });
    return data;
  };

  const logout = () => {
    localStorage.removeItem('platform_token');
    localStorage.removeItem('platform_user');
    setAdmin(null);
  };

  return (
    <PlatformAuthCtx.Provider value={{ admin, login, logout }}>
      {children}
    </PlatformAuthCtx.Provider>
  );
}

export function usePlatformAuth() {
  return useContext(PlatformAuthCtx);
}
