/**
 * NotificationsContext — the Notifications tab's data.
 *
 * Every system event, from every module, is logged server-side as a
 * notification — see app/notifications.py. This context holds that list plus
 * the unread count the nav bar's badge reads, and is the one place that talks
 * to GET/PUT /notifications.
 *
 * Kept close to real time: refetched right after any successful write the app
 * makes (api/http.js fires NOTIFICATIONS_STALE_EVENT), whenever the tab
 * regains focus, and polled every 10s while the page is visible.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../api/client.js';
import { NOTIFICATIONS_STALE_EVENT } from '../api/http.js';
import { useAuth } from './AuthContext.jsx';

const NotificationsContext = createContext(null);
const POLL_MS = 10000;

export function NotificationsProvider({ children }) {
  const { isAuthenticated, token } = useAuth();
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const refresh = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const { items: rows, unread_count: unread } = await api.notifications.list(tokenRef.current, { limit: 50 });
      setItems(rows);
      setUnreadCount(unread);
      setError(null);
    } catch (err) {
      setError(err.message || 'Could not load notifications.');
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setItems([]);
      setUnreadCount(0);
      setReady(false);
      return undefined;
    }
    let cancelled = false;
    refresh();
    const tick = () => { if (!cancelled && document.visibilityState !== 'hidden') refresh(); };
    const interval = setInterval(tick, POLL_MS);
    // Events are written in the request's own transaction or just after it,
    // so a short delay lets the write land before we ask for the list.
    let staleTimer = null;
    const onStale = () => {
      clearTimeout(staleTimer);
      staleTimer = setTimeout(tick, 300);
    };
    window.addEventListener(NOTIFICATIONS_STALE_EVENT, onStale);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(staleTimer);
      window.removeEventListener(NOTIFICATIONS_STALE_EVENT, onStale);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [isAuthenticated, token, refresh]);

  const markRead = useCallback(async (id) => {
    setItems((rows) => rows.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
    setUnreadCount((n) => Math.max(0, n - 1));
    try {
      await api.notifications.markRead(token, id);
    } catch {
      refresh(); // out of step with the server — reload rather than lie
    }
  }, [token, refresh]);

  const markAllRead = useCallback(async () => {
    setItems((rows) => rows.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      await api.notifications.markAllRead(token);
    } catch {
      refresh();
    }
  }, [token, refresh]);

  const value = useMemo(() => ({
    items, unreadCount, ready, error, refresh, markRead, markAllRead,
  }), [items, unreadCount, ready, error, refresh, markRead, markAllRead]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationsProvider>.');
  return ctx;
}
