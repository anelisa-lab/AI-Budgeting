/**
 * ProtectedRoute — keeps signed-out visitors off the app screens.
 * Member 8.
 *
 * Remembers where the student was trying to go and sends them back there
 * after they sign in, instead of dumping them on the dashboard.
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, status } = useAuth();
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

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
