/**
 * AuthContext — who is signed in, and the register / login / logout calls.
 *
 * HOW AUTHENTICATION ACTUALLY WORKS ON THIS BACKEND
 * -------------------------------------------------
 * Read app/security.py and app/dependencies.py: it is a stateless JWT, signed
 * HS256, with the user id in `sub` and a 7-day expiry, presented as
 * `Authorization: Bearer <token>`. There are no cookies and no server-side
 * session, so:
 *
 *   - the token is the whole session, and we keep it in localStorage
 *   - "restoring a session" means calling GET /profile/ and seeing if the token
 *     is still accepted; there is no /auth/me on this backend
 *   - logging out is a client-side act (POST /auth/logout just says so), so we
 *     clear local state FIRST and treat the call as best-effort
 *   - a 401 from ANY request anywhere means the token is dead; http.js calls
 *     the handler registered below, which signs the student out once rather
 *     than leaving them clicking a dead UI
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { api, setUnauthorizedHandler } from '../api/client.js';

const TOKEN_KEY = 'mintly.token';
const AuthContext = createContext(null);

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — the session lasts until the tab is closed */
  }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => readToken());
  const [user, setUser] = useState(null);
  const [preferences, setPreferences] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready
  const [sessionExpired, setSessionExpired] = useState(false);

  /* -------------------------------------------------- global 401 handling */

  const signOutLocally = useCallback(() => {
    saveToken(null);
    setToken(null);
    setUser(null);
    setPreferences(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Only shout about it if we believed we were signed in; a 401 on the
      // login call itself is just a wrong password.
      setSessionExpired(Boolean(readToken()));
      signOutLocally();
    });
    return () => setUnauthorizedHandler(null);
  }, [signOutLocally]);

  /* ------------------------------------------------------ session restore */

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!token) {
        setStatus('ready');
        return;
      }
      try {
        // GET /profile/ is the real "is this token still good?" call.
        const me = await api.profile.get(token);
        if (cancelled) return;
        setUser(me);

        // Preferences drive the recommendation ranking on Search. A failure
        // here must not sign anyone out — the app is perfectly usable without
        // stored preferences.
        try {
          const prefs = await api.profile.getPreferences(token);
          if (!cancelled) setPreferences(prefs);
        } catch {
          if (!cancelled) setPreferences(null);
        }
      } catch {
        if (!cancelled) signOutLocally();
      } finally {
        if (!cancelled) setStatus('ready');
      }
    }

    restore();
    return () => { cancelled = true; };
  }, [token, signOutLocally]);

  /* ------------------------------------------------------------ mutations */

  const register = useCallback(async (payload) => {
    // Only name, email and password reach the backend — see client.js.
    const { token: t, user: u } = await api.auth.register(payload);
    setSessionExpired(false);
    saveToken(t);
    setToken(t);
    setUser(u);
    return u;
  }, []);

  const login = useCallback(async (payload) => {
    const { token: t, user: u } = await api.auth.login(payload);
    setSessionExpired(false);
    saveToken(t);
    setToken(t);
    setUser(u);
    return u;
  }, []);

  const logout = useCallback(async () => {
    const current = token;
    signOutLocally();
    setSessionExpired(false);
    if (current) {
      try {
        await api.auth.logout(current);
      } catch {
        /* Stateless JWT — the token is already gone from this device. */
      }
    }
  }, [token, signOutLocally]);

  /** PUT /profile/ takes `name` and nothing else. */
  const updateProfile = useCallback(async ({ name }) => {
    const updated = await api.profile.update(token, { name });
    setUser(updated);
    return updated;
  }, [token]);

  const updatePreferences = useCallback(async (patch) => {
    const updated = await api.profile.updatePreferences(token, patch);
    setPreferences(updated);
    return updated;
  }, [token]);

  const dismissSessionExpired = useCallback(() => setSessionExpired(false), []);

  const value = useMemo(() => ({
    token,
    user,
    preferences,
    status,
    sessionExpired,
    dismissSessionExpired,
    isAuthenticated: Boolean(token && user),
    register,
    login,
    logout,
    updateProfile,
    updatePreferences,
  }), [token, user, preferences, status, sessionExpired, dismissSessionExpired,
       register, login, logout, updateProfile, updatePreferences]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
