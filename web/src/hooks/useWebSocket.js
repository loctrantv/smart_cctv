import { useState, useEffect, useRef, useCallback } from 'react';

export function useWebSocket(token) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const wsRef = useRef(null);
  const listenersRef = useRef(new Map());

  useEffect(() => {
    if (!token) {
      setConnected(false);
      return;
    }

    const defaultWsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
    const wsBase = (import.meta.env.VITE_WS_URL || defaultWsUrl).replace(/\/+$/, '');
    // When connecting same-origin, HttpOnly cookie is automatically sent on WS handshake;
    // still pass token as fallback if cross-origin VITE_WS_URL is configured.
    const wsUrl = import.meta.env.VITE_WS_URL
      ? `${wsBase}/ws?token=${encodeURIComponent(token)}`
      : `${wsBase}/ws`;

    let unmounted = false;
    let reconnectTimer = null;

    function connect() {
      if (unmounted) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!unmounted) setConnected(true);
      };
      ws.onclose = () => {
        if (unmounted) return;
        setConnected(false);
        if (localStorage.getItem('smart_cctv_token')) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          setLastEvent(data);
          const listeners = listenersRef.current.get(data.type);
          if (listeners) listeners.forEach((fn) => fn(data));
          const allListeners = listenersRef.current.get('*');
          if (allListeners) allListeners.forEach((fn) => fn(data));
        } catch {}
      };
    }

    connect();
    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) wsRef.current.close();
    };
  }, [token]);

  const on = useCallback((type, callback) => {
    if (!listenersRef.current.has(type)) {
      listenersRef.current.set(type, new Set());
    }
    listenersRef.current.get(type).add(callback);
    return () => listenersRef.current.get(type)?.delete(callback);
  }, []);

  return { connected, lastEvent, on };
}
