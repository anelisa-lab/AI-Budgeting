/**
 * NotificationsContext — the Notifications tab's data (Phase 6).
 *
 * Every SMS exchange (POST /sms/reply) and every app-triggered alert (like
 * crossing into survival mode) is logged server-side as a notification —
 * see app/notifications.py. This context holds that list plus the unread
 * count the nav bar's badge reads, and is the one place that talks to
 * GET/PUT /notifications, the same role ShoppingContext plays for the
 * shopping list.
 *
 * Polled every 30s while signed in, and refreshed immediately after sending
 * an SMS (see SmsMode.jsx), so a new message shows up without a manual
 * reload either way.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const NotificationsContext = createContext(null);
const POLL_MS = 30000;

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
    const interval = setInterval(() => { if (!cancelled) refresh(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
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
