/**
 * ProtectedRoute — keeps signed-out visitors off the app screens.
 * Member 8.
 *
 * Remembers where the student was trying to go and sends them back there
 * after they sign in, instead of dumping them on the dashboard.
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Alert, Button, Logo } from '../ui/index.js';

export default function ProtectedRoute({ children }) {
  const {
    isAuthenticated, status, retrySession, logout,
  } = useAuth();
  const location = useLocation();

  // Wait for the stored session to be checked before deciding — otherwise a
  // refresh on /dashboard bounces the user to /login for a frame.
  if (status === 'loading') {
    return (
      <div className="auth" role="status" aria-live="polite">
        <span className="spinner" style={{ color: 'var(--c-forest)' }} />
        <span className="sr-only">Checking your session…</span>
      </div>
    );
  }

  // Signed in on this device, but the server could not be reached to confirm
  // it. Keep the session and let the student retry instead of logging them out.
  if (status === 'offline') {
    return (
      <div className="auth">
        <div className="auth__card stack">
          <div className="stack" style={{ justifyItems: 'center' }}><Logo size={44} /></div>
          <Alert tone="danger" title="UniWallet can't reach its server">
            You are still signed in on this device, but your budget and prices can&apos;t
            load right now. Check your internet connection and try again.
          </Alert>
          <div className="row">
            <Button onClick={retrySession}>Try again</Button>
            <Button variant="quiet" onClick={logout}>Sign out</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
