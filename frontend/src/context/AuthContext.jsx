import { createContext, useContext, useState } from 'react';
import api from '../api/client';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const u = localStorage.getItem('user');
    return u ? JSON.parse(u) : null;
  });

  const login = async (username, password) => {
    const form = new URLSearchParams({ username, password });
    const { data } = await api.post('/api/auth/login', form);
    localStorage.setItem('token', data.access_token);
    localStorage.setItem('user', JSON.stringify({ id: data.id, username: data.username, role: data.role }));
    setUser({ id: data.id, username: data.username, role: data.role });
    return data.role;
  };

  const logout = () => {
    localStorage.clear();
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
