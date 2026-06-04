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
    
    const wsBase = import.meta.env.VITE_WS_URL || defaultWsUrl;
    const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        // Only reconnect if token is still valid/active
        if (localStorage.getItem('smart_cctv_token')) {
          setTimeout(connect, 3000); // Reconnect
        }
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          setLastEvent(data);
          // Notify type-specific listeners
          const listeners = listenersRef.current.get(data.type);
          if (listeners) listeners.forEach(fn => fn(data));
          // Notify wildcard listeners
          const allListeners = listenersRef.current.get('*');
          if (allListeners) allListeners.forEach(fn => fn(data));
        } catch {}
      };
    }

    connect();
    return () => {
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
