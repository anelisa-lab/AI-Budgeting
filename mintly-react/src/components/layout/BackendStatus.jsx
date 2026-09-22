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

import { useEffect, useState } from 'react';
import { Alert } from '../ui/index.js';
import { api, API_BASE_URL } from '../../api/client.js';

export default function BackendStatus() {
  const [state, setState] = useState('checking'); // checking | up | down

  useEffect(() => {
    let cancelled = false;
    api.system.health()
      .then(() => { if (!cancelled) setState('up'); })
      .catch(() => { if (!cancelled) setState('down'); });
    return () => { cancelled = true; };
  }, []);

  if (state !== 'down') return null;

  return (
    <div style={{ padding: 'var(--s-3) var(--s-4) 0' }}>
      <Alert tone="danger" title={`The backend is not responding at ${API_BASE_URL}`}>
        Start it with <code>uvicorn app.main:app --reload --port 4000</code>, or set{' '}
        <code>VITE_API_BASE_URL</code> in <code>.env.local</code> if it is running
        somewhere else. Nothing on the screens below will load until it answers.
      </Alert>
    </div>
  );
}
