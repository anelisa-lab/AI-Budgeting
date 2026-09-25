/**
 * A one-line banner when the backend cannot be reached at all.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every screen handles its own API errors, but they all say roughly the same
 * thing when the real problem is that uvicorn is not running: "could not load
 * your budget", "could not search". During integration that sends people
 * hunting through frontend code for a backend that was never started.
 *
 * So GET /health — the one unauthenticated route on the backend (app/main.py)
 * — is checked once on mount, and the answer is stated plainly, with the URL
 * being tried, so the fix is obvious.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../ui/index.js';
import { api, API_BASE_URL } from '../../api/client.js';

/** true in `npm run dev`, false in a production build. */
const IS_DEV = Boolean(import.meta.env?.DEV);

export default function BackendStatus({ compact = false }) {
  const [state, setState] = useState('checking'); // checking | up | down

  const check = useCallback(() => {
    setState('checking');
    return api.system.health()
      .then(() => setState('up'))
      .catch(() => setState('down'));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.system.health()
      .then(() => { if (!cancelled) setState('up'); })
      .catch(() => { if (!cancelled) setState('down'); });
    return () => { cancelled = true; };
  }, []);

  if (state !== 'down') return null;

  return (
    <div
      style={compact
        ? { marginBottom: 'var(--s-5)' }
        : { padding: 'var(--s-3) var(--gutter) 0', maxWidth: 'var(--page-max)', margin: '0 auto' }}
    >
      <Alert tone="danger" title="UniWallet can't reach its server">
        Your budget, search and prices will not load until it is back. Check your
        internet connection, then try again.
        {IS_DEV && (
          <span style={{ display: 'block', marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)' }}>
            Developer note: nothing is answering at <code>{API_BASE_URL}</code>. Start the
            backend with <code>uvicorn app.main:app --reload --port 4000</code> or set{' '}
            <code>VITE_API_BASE_URL</code> in <code>.env.local</code>.
          </span>
        )}
        <div style={{ marginTop: 'var(--s-3)' }}>
          <Button size="sm" onClick={check}>Try again</Button>
        </div>
      </Alert>
    </div>
  );
}
