/**
 * LanguageContext — the chosen UI language (device-only, kept in localStorage).
 * `t(key)` returns the text in the chosen language, falling back to English.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { DICTIONARIES, LANGUAGES } from '../i18n/translations.js';

const KEY = 'uniwallet.language';
const CODES = new Set(LANGUAGES.map((l) => l.code));

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return CODES.has(v) ? v : 'en';
  } catch {
    return 'en';
  }
}

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(stored);

  const setLang = useCallback((code) => {
    const next = CODES.has(code) ? code : 'en';
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
    document.documentElement.lang = next;
    setLangState(next);
  }, []);

  const t = useCallback(
    (key) => DICTIONARIES[lang]?.[key] ?? DICTIONARIES.en[key] ?? key,
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used inside <LanguageProvider>');
  return ctx;
}
