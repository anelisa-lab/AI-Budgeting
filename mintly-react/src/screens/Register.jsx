/**
 * Register screen.
 *
 * Carries the app's heaviest validation load: live password-strength meter,
 * per-field errors that explain the fix, and a submit button that reports
 * progress.
 *
 * WHAT THE BACKEND ACTUALLY ACCEPTS
 * ---------------------------------
 * POST /auth/register takes RegisterRequest { name, email, password } and
 * nothing else. Student number and residence are NOT stored — `users` has a
 * `residence_area_code` column but neither RegisterRequest nor UserOut expose
 * it, and there is no student-number column at all.
 *
 * So those two inputs are kept (Res-Mate bulk-buy matching needs residence,
 * and the team already designed for it) but they are marked optional, grouped
 * under a heading that says they are not saved yet, and they are NOT sent. A
 * field that is silently dropped by the API is worse than one that admits it.
 * docs/BACKEND_INTEGRATION.md specifies the backend change that would let this
 * block become real.
 */

import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Eyebrow, Field, Input, Logo, Select,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import * as v from '../lib/validation.js';

/** DUT residences. Not yet accepted by the backend — see the header. */
const RESIDENCES = [
  { value: '', label: 'Select your residence…' },
  { value: 'ml-sultan', label: 'ML Sultan Campus Residence' },
  { value: 'steve-biko', label: 'Steve Biko Campus Residence' },
  { value: 'ritson', label: 'Ritson Residence' },
  { value: 'berea', label: 'Berea Residence' },
  { value: 'new-castle', label: 'Newcastle Campus Residence' },
  { value: 'off-campus', label: 'Off-campus / private accommodation' },
];

/**
 * studentNumber and residence are optional because the backend cannot store
 * them; their rules only fire once something has been typed, so an empty
 * value is never an error.
 */
const RULES = {
  name: (value) => v.fullName(value),
  email: (value) => v.email(value),
  password: (value) => v.password(value),
  confirm: (value, all) => v.confirmPassword(value, all.password),
  terms: (value) => v.accepted(value),
  studentNumber: (value) => (value ? v.studentNumber(value) : null),
  residence: () => null,
};

export default function Register() {
  const { register } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const formRef = useRef(null);

  const [values, setValues] = useState({
    name: '', studentNumber: '', email: '', residence: '',
    password: '', confirm: '', terms: false,
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const strength = useMemo(() => v.passwordStrength(values.password), [values.password]);

  function change(name, value) {
    setValues((s) => ({ ...s, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: undefined }));
    // Re-check the confirmation whenever the password itself changes.
    if (name === 'password' && errors.confirm) {
      setErrors((e) => ({ ...e, confirm: undefined }));
    }
    if (formError) setFormError(null);
  }

  function blur(name) {
    const message = RULES[name](values[name], values);
    setErrors((e) => ({ ...e, [name]: message || undefined }));
  }

  function focusFirstError(errs) {
    const first = Object.keys(errs)[0];
    if (first && formRef.current) formRef.current.querySelector(`#${first}`)?.focus();
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
    try {
      // Exactly the three fields RegisterRequest declares.
      const user = await register({
        name: values.name,
        email: values.email,
        password: values.password,
      });
      toast.success(`Account created. Welcome to Mintly, ${user.name.split(' ')[0]}.`);
      // Straight to budget setup — an empty dashboard would teach them nothing.
      navigate('/budget', { replace: true });
    } catch (err) {
      if (err.fieldErrors) {
        setErrors(err.fieldErrors);
        focusFirstError(err.fieldErrors);
      } else {
        setFormError(err.message || 'Could not create your account. Please try again.');
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
              <Eyebrow>Get started</Eyebrow>
              <h1 className="auth__title" style={{ marginTop: 'var(--s-3)' }}>
                Create your account
              </h1>
              <p className="auth__sub">
                Free for DUT students. Takes about a minute.
              </p>
            </div>

            {formError && <Alert tone="danger" title="Could not create account">{formError}</Alert>}

            <Field id="name" label="Full name" error={errors.name} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id} autoComplete="name" placeholder="Nozibusiso Cindi"
                  value={values.name} invalid={invalid} describedBy={describedBy}
                  onChange={(e) => change('name', e.target.value)}
                  onBlur={() => blur('name')}
                />
              )}
            </Field>

            <Field id="email" label="Email address" error={errors.email} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id} type="email" autoComplete="email"
                  placeholder="s221234567@dut4life.ac.za"
                  value={values.email} invalid={invalid} describedBy={describedBy}
                  onChange={(e) => change('email', e.target.value)}
                  onBlur={() => blur('email')}
                />
              )}
            </Field>

            <Field
              id="password"
              label="Password"
              hint="At least 8 characters, with a letter and a number."
              error={errors.password}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id} type="password" autoComplete="new-password"
                  value={values.password} invalid={invalid} describedBy={describedBy}
                  onChange={(e) => change('password', e.target.value)}
                  onBlur={() => blur('password')}
                />
              )}
            </Field>

            {values.password && (
              <div className="strength" aria-live="polite">
                <div className="strength__bars">
                  {[1, 2, 3, 4].map((step) => (
                    <div
                      key={step}
                      className={
                        strength.score >= step
                          ? `strength__bar strength__bar--on-${strength.score}`
                          : 'strength__bar'
                      }
                    />
                  ))}
                </div>
                <p className="strength__label">Password strength: {strength.label}</p>
              </div>
            )}

            <Field id="confirm" label="Confirm password" error={errors.confirm} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id} type="password" autoComplete="new-password"
                  value={values.confirm} invalid={invalid} describedBy={describedBy}
                  onChange={(e) => change('confirm', e.target.value)}
                  onBlur={() => blur('confirm')}
                />
              )}
            </Field>

            {/* Collected for a feature that is designed but not yet stored
                server-side. Nothing here is sent to POST /auth/register. */}
            <fieldset
              style={{
                border: '1.5px solid var(--c-line)',
                borderRadius: 'var(--r-lg)',
                padding: 'var(--s-4)',
                display: 'grid',
                gap: 'var(--s-4)',
              }}
            >
              <legend className="field__label" style={{ padding: '0 var(--s-2)' }}>
                Optional — not saved yet
              </legend>
              <p className="field__hint" style={{ marginTop: 0 }}>
                Res-Mate bulk-buy matching needs these, but the account API does not
                store them yet. Fill them in if you like; you will be asked again once
                the backend supports it.
              </p>

              <Field
                id="studentNumber"
                label="Student number"
                hint="8 or 9 digits, exactly as it appears on your student card."
                error={errors.studentNumber}
              >
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id} inputMode="numeric" placeholder="22123456"
                    value={values.studentNumber} invalid={invalid} describedBy={describedBy}
                    onChange={(e) => change('studentNumber', e.target.value.replace(/\D/g, ''))}
                    onBlur={() => blur('studentNumber')}
                  />
                )}
              </Field>

              <Field
                id="residence"
                label="Residence"
                hint="Used for bulk-buy matching with students near you."
                error={errors.residence}
              >
                {({ id, describedBy, invalid }) => (
                  <Select
                    id={id} options={RESIDENCES}
                    value={values.residence} invalid={invalid} describedBy={describedBy}
                    onChange={(e) => change('residence', e.target.value)}
                  />
                )}
              </Field>
            </fieldset>

            <div>
              <label className="checkbox" htmlFor="terms">
                <input
                  id="terms" type="checkbox" checked={values.terms}
                  onChange={(e) => change('terms', e.target.checked)}
                  aria-invalid={Boolean(errors.terms) || undefined}
                  aria-describedby={errors.terms ? 'terms-error' : undefined}
                />
                <span>
                  I agree that Mintly may store my budget and spending data to give me
                  recommendations. My spending is never shared with other students in a
                  way that identifies me.
                </span>
              </label>
              {errors.terms && (
                <p className="field__error" id="terms-error" role="alert"
                   style={{ marginTop: 'var(--s-2)' }}>
                  <span aria-hidden="true">⚠</span><span>{errors.terms}</span>
                </p>
              )}
            </div>

            <Button type="submit" size="lg" block loading={submitting}>
              {submitting ? 'Creating your account…' : 'Create account'}
            </Button>
          </form>

          <p className="auth__foot">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </Card>
      </div>
    </div>
  );
}
