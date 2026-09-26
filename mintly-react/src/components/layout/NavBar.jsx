/**
 * NavBar — primary navigation.
 * Member 7.
 *
 * Shows a different set of links depending on whether anyone is signed in,
 * and marks the current route with aria-current so the active state is
 * announced as well as coloured.
 */

import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Button, Logo } from '../ui/index.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useShopping } from '../../context/ShoppingContext.jsx';

const LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/recommendations', label: 'For you' },
  { to: '/search', label: 'Search' },
  { to: '/compare', label: 'Compare' },
  { to: '/budget', label: 'Budget' },
  { to: '/profile', label: 'Profile' },
  { to: '/settings', label: 'Settings' },
];

export default function NavBar() {
  const { isAuthenticated, user, logout } = useAuth();
  const { listCount } = useShopping();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const linksRef = useRef(null);

  // On a phone the links are a swipeable row; bring the current page's link
  // into view instead of leaving it off the right-hand edge.
  useEffect(() => {
    const row = linksRef.current;
    const active = row?.querySelector('[aria-current="page"]');
    if (row && active && row.scrollWidth > row.clientWidth) {
      row.scrollLeft = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
    }
  });

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <header className="nav">
      <nav className="nav__in" aria-label="Main">
        <NavLink to={isAuthenticated ? '/dashboard' : '/'} aria-label="UniWallet home">
          <Logo size={34} />
        </NavLink>

        {isAuthenticated && (
          <div className="nav__links" ref={linksRef}>
            {LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} className="nav__link">
                {l.label}
                {l.to === '/compare' && listCount > 0 && (
                  <span className="num">
                    {' '}({listCount})<span className="sr-only"> items in your list</span>
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        )}

        <div className="nav__right">
          {isAuthenticated ? (
            <>
              <NavLink
                to="/profile"
                className="badge badge--accent"
                title={`${user?.email || ''} — profile & preferences`}
              >
                {user?.name?.split(' ')[0] || 'Student'}
              </NavLink>
              <Button variant="ghost" size="sm" onClick={handleLogout} loading={loggingOut}>
                {loggingOut ? 'Signing out…' : 'Sign out'}
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
