/**
 * ToastContext — brief confirmations after an action succeeds or fails.
 * Member 7.
 *
 * Rubric: "Quality of feedback". Every create/update/delete in the app fires
 * one of these, so an action never completes silently.
 *
 * Toasts are announced to screen readers via an aria-live region, and they
 * are for confirmation only — anything the user must act on belongs in an
 * <Alert> on the page itself, where it stays put.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((message, tone = 'success', ms = 4000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((list) => [...list, { id, message, tone }]);
    const timer = setTimeout(() => dismiss(id), ms);
    timers.current.set(id, timer);
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({
    toast: push,
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'danger', 6000),
    info: (m) => push(m, 'info'),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            <span aria-hidden="true">
              {t.tone === 'success' ? '✓' : t.tone === 'danger' ? '⚠' : 'ℹ'}
            </span>
            <span>{t.message}</span>
            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>.');
  return ctx;
}
