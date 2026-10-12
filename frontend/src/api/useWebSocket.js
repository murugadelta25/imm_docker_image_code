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
  const pingIntervalRef = useRef(null);
  const unmounted = useRef(false);
  const retryMs = useRef(3000);
  const wasDisconnectedRef = useRef(false);

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

    function startPingInterval(ws) {
      // Send pong response every 20 seconds to keep connection alive
      // Server sends ping every 25s, so this keeps us ahead of server timeout
      pingIntervalRef.current = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'pong' }));
          } catch {
            /* ignore send errors */
          }
        }
      }, 20000);
    }

    function stopPingInterval() {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    }

    async function checkOfflineData() {
      /**
       * When connection is restored, check if there's offline data waiting
       * to be restored. Trigger dashboard refresh without requiring page reload.
       */
      try {
        const { default: api } = await import('./client');
        const res = await api.get('/api/imm/nodered/queue/status');
        
        if (res.data?.total_offline_devices > 0 || res.data?.total_queued_entries > 0) {
          // Offline data detected - notify and refresh
          console.log('[INFO] Offline data detected - restoring...');
          
          // Dispatch custom event that dashboards can listen to
          window.dispatchEvent(new CustomEvent('offline-data-restored', {
            detail: {
              offline_devices: res.data?.offline_devices || [],
              queued_entries: res.data?.total_queued_entries || 0
            }
          }));
          
          // Auto-refresh common dashboards
          if (window.location.pathname.includes('/equipment')) {
            // Wait a moment for backend to process restoration, then refresh
            setTimeout(() => {
              window.location.reload();
            }, 2000);
          }
        }
      } catch (err) {
        console.log('[DEBUG] Queue status check failed:', err.message);
      }
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
        
        // If this is a reconnection after being disconnected, check for offline data
        if (wasDisconnectedRef.current) {
          console.log('[INFO] Connection restored - checking for offline data...');
          checkOfflineData().catch(err => {
            console.log('[DEBUG] Offline data check error:', err.message);
          });
          wasDisconnectedRef.current = false;
        }
        
        startPingInterval(ws);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ping') {
            // Server sent a ping — respond with pong
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong' }));
            }
          } else {
            // Regular message — pass to callback
            onMsgRef.current(msg);
          }
        } catch {
          /* ignore malformed payloads */
        }
      };

      ws.onclose = () => {
        wasDisconnectedRef.current = true;
        stopPingInterval();
        wsRef.current = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        /* close triggers onclose → reconnect; avoid console noise */
        wasDisconnectedRef.current = true;
        stopPingInterval();
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
      };
    }

    connect();

    return () => {
      unmounted.current = true;
      clearTimeout(retryRef.current);
      stopPingInterval();
      safeClose(wsRef.current);
      wsRef.current = null;
    };
  }, [enabled]);
}
