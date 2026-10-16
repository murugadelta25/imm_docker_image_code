import { useEffect, useRef } from 'react';

/** 30 minutes of no mouse, keyboard, scroll, or touch activity */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

const ACTIVITY_EVENTS = [
  'mousedown',
  'mousemove',
  'keydown',
  'scroll',
  'touchstart',
  'click',
  'wheel',
];

/** Throttle activity resets to once per second */
const ACTIVITY_THROTTLE_MS = 1000;

/**
 * Calls `onIdle` after `timeoutMs` with no user interaction on the page.
 * Resets the timer on mouse, keyboard, scroll, and touch events.
 */
export function useIdleTimeout(onIdle, { enabled = true, timeoutMs = IDLE_TIMEOUT_MS } = {}) {
  const lastActivityRef = useRef(Date.now());
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled) return undefined;

    lastActivityRef.current = Date.now();
    let timeoutId;

    const fireIfIdle = () => {
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        onIdleRef.current();
        return true;
      }
      return false;
    };

    const scheduleCheck = () => {
      clearTimeout(timeoutId);
      const remaining = timeoutMs - (Date.now() - lastActivityRef.current);
      timeoutId = setTimeout(() => {
        if (!fireIfIdle()) scheduleCheck();
      }, Math.max(remaining, 0));
    };

    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivityRef.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityRef.current = now;
      scheduleCheck();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') fireIfIdle();
    };

    ACTIVITY_EVENTS.forEach((event) => {
      window.addEventListener(event, onActivity, { passive: true });
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleCheck();

    return () => {
      clearTimeout(timeoutId);
      ACTIVITY_EVENTS.forEach((event) => {
        window.removeEventListener(event, onActivity);
      });
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, timeoutMs]);
}

export default useIdleTimeout;
