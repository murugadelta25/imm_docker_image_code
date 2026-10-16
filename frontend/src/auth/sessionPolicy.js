/** Username that keeps an always-on session (no idle auto-logout). */
export const PERSISTENT_SESSION_USERNAME = 'sie_admin';

export function hasPersistentSession(user) {
  return user?.username === PERSISTENT_SESSION_USERNAME;
}
