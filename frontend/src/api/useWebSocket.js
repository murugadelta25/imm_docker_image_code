import { useEffect, useRef } from 'react';

/**
 * WebSocket URL — same host as the page so Vite proxy forwards /ws → backend:8040.
 * Override with VITE_WS_URL (e.g. ws://10.151.47.86:8040) when proxy is unavailable.
 */
function getWsUrl() {
  const fromEnv = import.meta.env.VITE_WS_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

function safeClose(ws) {
  if (!ws) return;
  ws.onclose = null;
  ws.onerror = null;
  ws.onmessage = null;
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'component unmount');
  } else if (ws.readyState === WebSocket.CONNECTING) {
    ws.onopen = () => ws.close(1000, 'component unmount');
  }
}

export function useWebSocket(onMessage, enabled = true) {
  const wsRef = useRef(null);
  const onMsgRef = useRef(onMessage);
  const retryRef = useRef(null);
  const unmounted = useRef(false);
  const retryMs = useRef(3000);

  onMsgRef.current = onMessage;

  useEffect(() => {
    if (!enabled) return undefined;

    unmounted.current = false;
    retryMs.current = 3000;

    function scheduleReconnect() {
      if (unmounted.current) return;
      clearTimeout(retryRef.current);
      retryRef.current = setTimeout(connect, retryMs.current);
      retryMs.current = Math.min(retryMs.current * 1.5, 30000);
    }

    function connect() {
      if (unmounted.current) return;

      let ws;
      try {
        ws = new WebSocket(`${getWsUrl()}/ws`);
      } catch {
        scheduleReconnect();
        return;
      }

      wsRef.current = ws;

      ws.onopen = () => {
        retryMs.current = 3000;
      };

      ws.onmessage = (e) => {
        try {
          onMsgRef.current(JSON.parse(e.data));
        } catch {
          /* ignore malformed payloads */
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        /* close triggers onclose → reconnect; avoid console noise */
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
      };
    }

    connect();

    return () => {
      unmounted.current = true;
      clearTimeout(retryRef.current);
      safeClose(wsRef.current);
      wsRef.current = null;
    };
  }, [enabled]);
}
