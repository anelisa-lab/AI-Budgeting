/**
 * NavBar — primary navigation.
 * Member 7.
 *
 * Shows a different set of links depending on whether anyone is signed in,
 * and marks the current route with aria-current so the active state is
 * announced as well as coloured.
 */

import { NavLink, useNavigate } from 'react-router-dom';
import { Badge, Button, Logo } from '../ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useShopping } from '../../context/ShoppingContext.jsx';
import { API_BASE_URL } from '../../api/client.js';

const LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/search', label: 'Search' },
  { to: '/compare', label: 'Compare' },
  { to: '/budget', label: 'Budget' },
];

export default function NavBar() {
  const { isAuthenticated, user, logout } = useAuth();
  const { listCount } = useShopping();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="nav">
      <nav className="nav__in" aria-label="Main">
        <NavLink to={isAuthenticated ? '/dashboard' : '/'} aria-label="Mintly home">
          <Logo size={34} />
        </NavLink>

        {isAuthenticated && (
          <div className="nav__links">
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className="nav__link">
                {l.label}
                {l.to === '/compare' && listCount > 0 && (
                  <span className="num"> ({listCount})</span>
                )}
              </NavLink>
            ))}
          </div>
        )}

        <div className="nav__right">
          <Badge tone="neutral" title={`Connected to the backend at ${API_BASE_URL}`}>
            Live API
          </Badge>

          {isAuthenticated ? (
            <>
              <span className="badge badge--accent" title={user?.email}>
                {user?.name?.split(' ')[0] || 'Student'}
              </span>
              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Sign out
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => navigate('/login')}>
                Sign in
              </Button>
              <Button variant="primary" size="sm" onClick={() => navigate('/register')}>
                Create account
              </Button>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
