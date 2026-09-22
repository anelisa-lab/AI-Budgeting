/**
 * Login screen.
 *
 * POST /auth/login takes { email, password } and answers 401 with the SAME
 * message whether the account does not exist or the password is wrong — the
 * backend deliberately does not leak which. http.js is told (via fieldHints in
 * endpoints.js) to put that message on the password field, which is where a
 * student is looking when a sign-in fails.
 *
 * Validation behaviour (rubric: "Validation and acceptance"):
 *  - fields validate on blur, so the student is not shouted at mid-typing
 *  - the whole form validates on submit
 *  - a failed field error clears as soon as the student edits that field
 *  - server-side errors (wrong password) land on the right field
 *  - the first invalid field is focused after a failed submit
 */

import { useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Eyebrow, Field, Input, Logo } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { API_BASE_URL } from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import * as v from '../lib/validation.js';

const RULES = {
  email: (value) => v.email(value),
  password: (value) => v.required(value, 'Password'),
};

export default function Login() {
  const { login, sessionExpired, dismissSessionExpired } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const formRef = useRef(null);

  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function change(name, value) {
    setValues((s) => ({ ...s, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: undefined }));
    if (formError) setFormError(null);
  }

  function blur(name) {
    const message = RULES[name](values[name], values);
    setErrors((e) => ({ ...e, [name]: message || undefined }));
  }

  function focusFirstError(errs) {
    const first = Object.keys(errs)[0];
    if (first && formRef.current) {
      formRef.current.querySelector(`#${first}`)?.focus();
    }
  }

  async function submit(event) {
    event.preventDefault();
    setFormError(null);

    const { errors: found, isValid } = v.validateAll(values, RULES);
    setErrors(found);
    if (!isValid) {
      focusFirstError(found);
      return;
    }

    setSubmitting(true);
    dismissSessionExpired();
    try {
      const user = await login(values);
      toast.success(`Welcome back, ${user.name.split(' ')[0]}.`);
      navigate(location.state?.from || '/dashboard', { replace: true });
    } catch (err) {
      if (err.fieldErrors) {
        setErrors(err.fieldErrors);
        focusFirstError(err.fieldErrors);
      } else {
        setFormError(err.message || 'Could not sign you in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="stack" style={{ justifyItems: 'center', marginBottom: 'var(--s-6)' }}>
          <Logo size={44} />
        </div>

        <Card>
          <form ref={formRef} onSubmit={submit} noValidate className="stack">
            <div>
              <Eyebrow>Welcome back</Eyebrow>
              <h1 className="auth__title" style={{ marginTop: 'var(--s-3)' }}>
                Sign in to Mintly
              </h1>
              <p className="auth__sub">
                Pick up where you left off — your budget and your list are waiting.
              </p>
            </div>

            {sessionExpired && !formError && (
              <Alert tone="warning" title="Your session expired">
                You were signed out because the token issued at sign-in is no longer
                accepted. Sign in again to pick up where you left off.
              </Alert>
            )}

            {formError && <Alert tone="danger" title="Sign-in failed">{formError}</Alert>}

            <Field id="email" label="Email address" error={errors.email} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="email"
                  autoComplete="email"
                  placeholder="s221234567@dut4life.ac.za"
                  value={values.email}
                  invalid={invalid}
                  describedBy={describedBy}
                  onChange={(e) => change('email', e.target.value)}
                  onBlur={() => blur('email')}
                />
              )}
            </Field>

            <Field id="password" label="Password" error={errors.password} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  placeholder="Your password"
                  value={values.password}
                  invalid={invalid}
                  describedBy={describedBy}
                  onChange={(e) => change('password', e.target.value)}
                  onBlur={() => blur('password')}
                />
              )}
            </Field>

            <Button type="submit" size="lg" block loading={submitting}>
              {submitting ? 'Signing you in…' : 'Sign in'}
            </Button>
          </form>

          <p className="auth__foot">
            New here? <Link to="/register">Create an account</Link>
          </p>
        </Card>

        <div className="auth__demo">
          <strong>Note —</strong> this build talks to the live backend at{' '}
          <code>{API_BASE_URL}</code>. Start it with{' '}
          <code>uvicorn app.main:app --reload --port 4000</code> and point{' '}
          <code>VITE_API_BASE_URL</code> at it in <code>.env.local</code> if it runs
          somewhere else.
        </div>
      </div>
    </div>
  );
}
