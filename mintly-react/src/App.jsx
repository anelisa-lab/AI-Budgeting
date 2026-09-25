/**
 * App — the routing skeleton.
 * Member 7.
 *
 * ROUTE MAP
 *   /                public   landing
 *   /login           public   sign in                  (Member 8)
 *   /register        public   create account           (Member 8)
 *   /dashboard       private  budget dashboard         (Member 8)
 *   /budget          private  budget entry / edit      (Member 8)
 *   /search          private  search + results         (Member 9)
 *   /recommendations private  ranked picks             (Member 7, Phase 3)
 *   /compare         private  basket comparison        (Member 9)
 *   /profile         private  profile & preferences    (Member 8, Phase 3)
 *   *                         not found
 *
 * Private routes are wrapped in <ProtectedRoute>, which waits for the stored
 * session to be checked before redirecting, then sends the student back to
 * where they were going once they sign in.
 */

import { Navigate, Route, Routes } from 'react-router-dom';

import AppShell from './components/layout/AppShell.jsx';
import ProtectedRoute from './components/layout/ProtectedRoute.jsx';

import Landing from './screens/Landing.jsx';
import Login from './screens/Login.jsx';
import Register from './screens/Register.jsx';
import Dashboard from './screens/Dashboard.jsx';
import BudgetEntry from './screens/BudgetEntry.jsx';
import Search from './screens/Search.jsx';
import Recommendations from './screens/Recommendations.jsx';
import Compare from './screens/Compare.jsx';
import Profile from './screens/Profile.jsx';
import Settings from './screens/Settings.jsx';
import NotFound from './screens/NotFound.jsx';

import { useAuth } from './context/AuthContext.jsx';

/**
 * Signed-in students skip the marketing page and the auth screens.
 *
 * `to` exists for /register: the moment an account is created this guard
 * re-renders as signed-in, and it can win the race against Register's own
 * navigate('/budget') — so the register route names step 2 itself.
 */
function PublicOnly({ children, to = '/dashboard' }) {
  const { isAuthenticated, status } = useAuth();
  if (status === 'loading') return null;
  // A stored session the server could not confirm: send the student to the
  // app, where ProtectedRoute explains the outage and offers a retry.
  if (status === 'offline') return <Navigate to={to} replace />;
  return isAuthenticated ? <Navigate to={to} replace /> : children;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={<PublicOnly><AppShell><Landing /></AppShell></PublicOnly>}
      />
      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/register" element={<PublicOnly to="/budget"><Register /></PublicOnly>} />

      <Route
        path="/dashboard"
        element={<ProtectedRoute><AppShell><Dashboard /></AppShell></ProtectedRoute>}
      />
      <Route
        path="/budget"
        element={<ProtectedRoute><AppShell><BudgetEntry /></AppShell></ProtectedRoute>}
      />
      <Route
        path="/search"
        element={<ProtectedRoute><AppShell><Search /></AppShell></ProtectedRoute>}
      />
      <Route
        path="/recommendations"
        element={<ProtectedRoute><AppShell><Recommendations /></AppShell></ProtectedRoute>}
      />
      <Route
        path="/compare"
        element={<ProtectedRoute><AppShell><Compare /></AppShell></ProtectedRoute>}
      />

      <Route
        path="/profile"
        element={<ProtectedRoute><AppShell><Profile /></AppShell></ProtectedRoute>}
      />
      <Route
        path="/settings"
        element={<ProtectedRoute><AppShell><Settings /></AppShell></ProtectedRoute>}
      />

      <Route path="*" element={<AppShell><NotFound /></AppShell>} />
    </Routes>
  );
}
