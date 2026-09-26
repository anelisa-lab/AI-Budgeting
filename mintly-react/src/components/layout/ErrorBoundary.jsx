import React from 'react';
import Button from '../ui/Button.jsx';

/**
 * Phase 5 safety net: one broken screen should not turn a demo into a blank page.
 * The boundary gives the presenter a recovery action and keeps the rest of the
 * app shell available after a hard render error.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Keep this useful during the final QA pass without exposing a stack trace
    // to students in the UI.
    if (import.meta.env?.DEV) console.error('UniWallet render error', error, info);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="error-page" role="alert" aria-live="assertive">
        <div className="error-page__card">
          <p className="eyebrow">UniWallet</p>
          <h1>Something went wrong on this screen.</h1>
          <p>
            Your account data has not been deleted. Try the screen again, or return
            to the dashboard if the problem continues.
          </p>
          <div className="row">
            <Button onClick={this.reset}>Try again</Button>
            <Button variant="ghost" onClick={() => window.location.assign('/dashboard')}>
              Back to dashboard
            </Button>
          </div>
          {import.meta.env?.DEV && this.state.error?.message && (
            <details className="error-page__details">
              <summary>Developer error</summary>
              <code>{this.state.error.message}</code>
            </details>
          )}
        </div>
      </main>
    );
  }
}
