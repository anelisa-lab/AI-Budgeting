/**
 * RouteFocus — what a full page load does for free, done for client-side
 * navigation too.
 *
 * In a single-page app nothing happens for assistive technology when the
 * route changes: the tab title stays "UniWallet", a screen reader announces
 * nothing, keyboard focus stays on the link that was clicked (now in a nav
 * that is still there) and the window keeps its old scroll position. So on
 * every change of PATH (not of ?query — typing a search must not steal focus):
 *
 *   - document.title names the page (WCAG 2.4.2 Page Titled)
 *   - the window goes back to the top
 *   - focus moves to <main id="main">, so the next Tab or the screen reader's
 *     reading starts at the new page's content (WCAG 2.4.3 Focus Order)
 *
 * The very first render only sets the title; focus is left where the browser
 * put it so the skip link is still the first Tab stop.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

const TITLES = {
  '/': 'Budget your allowance',
  '/login': 'Sign in',
  '/register': 'Create your account',
  '/dashboard': 'Dashboard',
  '/budget': 'Your budget',
  '/search': 'Search',
  '/compare': 'Compare your list',
  '/profile': 'Profile & preferences',
  '/settings': 'Settings',
};

export function pageTitle(pathname) {
  const name = TITLES[pathname] || 'Page not found';
  return `${name} · UniWallet`;
}

export default function RouteFocus() {
  const { pathname } = useLocation();
  // Compared by path rather than a "first render" flag, so React StrictMode's
  // double-run of effects on mount doesn't count as a navigation.
  const previous = useRef(pathname);

  useEffect(() => {
    document.title = pageTitle(pathname);
    if (previous.current === pathname) return undefined;
    previous.current = pathname;
    // Wait a frame so the new screen (and its <main>) has rendered.
    const frame = requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      const target = document.getElementById('main') || document.querySelector('h1');
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  return null;
}
