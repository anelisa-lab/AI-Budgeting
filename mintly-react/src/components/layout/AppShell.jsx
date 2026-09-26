/**
 * AppShell — nav + page body wrapper used by every route.
 *
 * BackendStatus sits above the nav so that "the API is not running" is said
 * once, at the top, instead of being guessed at from five different screens.
 */

import NavBar from './NavBar.jsx';
import BackendStatus from './BackendStatus.jsx';

export default function AppShell({ children, wide = false }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to main content</a>
      <BackendStatus />
      <NavBar />
      <main className={`app-body ${wide ? '' : ''}`.trim()} id="main">
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
