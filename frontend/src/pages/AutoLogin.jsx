import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AutoLogin() {
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const u = params.get('u');
    const p = params.get('p');
    const redirect = params.get('redirect') || '/dashboard';

    if (!u || !p) { navigate('/login', { replace: true }); return; }

    // Always re-login to ensure a fresh valid token
    login(u, p)
      .then(() => navigate(redirect, { replace: true }))
      .catch(() => navigate('/login', { replace: true }));
  }, []);

  return null;
}
