/**
 * AppShell — nav + page body wrapper used by every route.
 *
 * BackendStatus sits above the nav so that "the API is not running" is said
 * once, at the top, instead of being guessed at from five different screens.
 */

import NavBar from './NavBar.jsx';
import BackendStatus from './BackendStatus.jsx';

export default function AppShell({ children }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to main content</a>
      <BackendStatus />
      <NavBar />
      {/* tabIndex -1: the skip link and RouteFocus can move focus here. */}
      <main className="app-body" id="main" tabIndex={-1}>
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
