import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useIdleTimeout, { IDLE_TIMEOUT_MS } from '../hooks/useIdleTimeout';
import { hasPersistentSession } from '../auth/sessionPolicy';

export const SESSION_EXPIRED_KEY = 'session_expired_reason';

/**
 * Signs the user out after inactivity (see IDLE_TIMEOUT_MS, default 60 minutes).
 * Any mouse, keyboard, scroll, or touch activity keeps the session alive.
 * Skipped for persistent session users (e.g. sie_admin).
 */
export default function IdleTimeoutGuard({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const persistent = hasPersistentSession(user);

  const handleIdle = useCallback(() => {
    sessionStorage.setItem(SESSION_EXPIRED_KEY, 'idle');
    logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  useIdleTimeout(handleIdle, {
    enabled: Boolean(user) && !persistent,
    timeoutMs: IDLE_TIMEOUT_MS,
  });

  return children;
}
