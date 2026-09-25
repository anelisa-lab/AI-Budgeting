/**
 * Profile & shopping preferences.
 * Member 8 (screen) on Member 2's endpoints.
 *
 * Covers the functional requirement "allow authenticated users to manage
 * profile and shopping preferences":
 *
 *   GET /profile              { name, email, residence, student_number, ... }
 *   PUT /profile              { name }   (residence and student number are
 *                                         set at sign-up and shown read-only)
 *   PUT /profile/preferences  { preferred_categories, preferred_stores, max_distance_km }
 *
 * These are not decoration. The recommender (app/recommender.py) scores
 * `preference_match` on categories and stores, and uses `max_distance_km` as
 * the travel radius for proximity; Search's own ranking reads the same
 * preferences. The recommender compares names EXACTLY, so stores and
 * categories are offered as toggles built from the live catalogue rather than
 * free text a student could misspell.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Eyebrow, Field, Input,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import * as v from '../lib/validation.js';
import { CATALOGUE_CATEGORIES, canonicalCategory } from '../lib/categories.js';
import { fullDate } from '../lib/format.js';
import { residenceLabel } from '../lib/residences.js';

/** Toggle `value` in a list. */
const toggle = (list, value) => (list.includes(value)
  ? list.filter((x) => x !== value)
  : [...list, value]);

export default function Profile() {
  const {
    token, user, preferences, updateProfile, updatePreferences, reloadPreferences,
  } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [name, setName] = useState(user?.name || '');
  const [nameError, setNameError] = useState(null);
  const [savingName, setSavingName] = useState(false);

  const [categories, setCategories] = useState(preferences?.preferred_categories || []);
  const [stores, setStores] = useState(preferences?.preferred_stores || []);
  const [distance, setDistance] = useState(
    preferences?.max_distance_km == null ? '' : String(preferences.max_distance_km),
  );
  const [distanceError, setDistanceError] = useState(null);
  const [savingPrefs, setSavingPrefs] = useState(false);

  // What the catalogue actually has, so every toggle is a name the
  // recommender can match. /search caps a page at 100 rows, so this walks the
  // pages (a handful for the seed); saved values are always kept in the list.
  const [catalogue, setCatalogue] = useState({ categories: [], stores: [] });
  const [catalogueError, setCatalogueError] = useState(null);

  useEffect(() => { setName(user?.name || ''); }, [user]);
  useEffect(() => {
    setCategories(preferences?.preferred_categories || []);
    setStores(preferences?.preferred_stores || []);
    setDistance(preferences?.max_distance_km == null ? '' : String(preferences.max_distance_km));
  }, [preferences]);

  useEffect(() => {
    let cancelled = false;
    api.search.catalogueFacets(token)
      .then((f) => {
        if (!cancelled) setCatalogue({ categories: f.categories, stores: f.stores });
      })
      .catch((err) => { if (!cancelled) setCatalogueError(err.message || 'Could not load stores.'); });
    return () => { cancelled = true; };
  }, [token]);

  // Preferences are loaded with the session; if that load failed, saving now
  // would overwrite the stored ones with blanks — so fetch them again first.
  const [prefsState, setPrefsState] = useState(preferences ? 'ready' : 'loading');
  useEffect(() => {
    if (preferences) { setPrefsState('ready'); return undefined; }
    let cancelled = false;
    setPrefsState('loading');
    reloadPreferences()
      .then(() => { if (!cancelled) setPrefsState('ready'); })
      .catch(() => { if (!cancelled) setPrefsState('error'); });
    return () => { cancelled = true; };
  }, [preferences, reloadPreferences]);

  // The app's category list (which includes Maintenance) plus anything else
  // the live catalogue or the saved preferences contain.
  const categoryOptions = useMemo(() => {
    const out = CATALOGUE_CATEGORIES.map((c) => c.value);
    for (const c of [...catalogue.categories, ...categories]) {
      if (!out.some((x) => x.toLowerCase() === String(c).toLowerCase())) out.push(c);
    }
    return out;
  }, [catalogue.categories, categories]);
  const storeOptions = useMemo(
    () => [...new Set([...catalogue.stores, ...stores])].sort(),
    [catalogue.stores, stores],
  );

  async function saveName(event) {
    event.preventDefault();
    const error = v.fullName(name) || (name.trim().length > 100 ? 'Keep your name under 100 characters.' : null);
    setNameError(error);
    if (error) return;
    setSavingName(true);
    try {
      await updateProfile({ name: name.trim().replace(/\s+/g, ' ') });
      toast.success('Name updated.');
    } catch (err) {
      setNameError(err.fieldErrors?.name || err.message || 'Could not update your name.');
    } finally {
      setSavingName(false);
    }
  }

  async function savePreferences(event) {
    event.preventDefault();
    const blank = String(distance).trim() === '';
    const km = Number(distance);
    // Same bounds as UpdatePreferencesRequest.max_distance_km (0..9999).
    const error = !blank && !(Number.isFinite(km) && km >= 0 && km <= 9999)
      ? 'Distance must be a number of kilometres between 0 and 9999.'
      : null;
    setDistanceError(error);
    if (error) return;

    if (prefsState !== 'ready') {
      toast.error('Your saved preferences have not loaded yet, so nothing was changed. Try again in a moment.');
      return;
    }
    setSavingPrefs(true);
    try {
      await updatePreferences({
        preferred_categories: categories.map(canonicalCategory),
        preferred_stores: stores,
        // Omitted when blank: the backend keeps what it had rather than
        // clearing it, so a blank box never silently changes the radius.
        ...(blank ? {} : { max_distance_km: Number(distance) }),
      });
      toast.success('Preferences saved — recommendations will use them.');
    } catch (err) {
      toast.error(err.message || 'Could not save your preferences.');
    } finally {
      setSavingPrefs(false);
    }
  }

  return (
    <div className="page--narrow" style={{ margin: '0 auto', maxWidth: 640 }}>
      <div className="stack stack--loose">
        <div>
          <Eyebrow>Your account</Eyebrow>
          <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
            Profile &amp; preferences
          </h1>
          <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)' }}>
            Tell UniWallet where you like to shop and what you usually buy. Your
            recommendations are ranked with these.
          </p>
        </div>

        <Card>
          <form onSubmit={saveName} noValidate className="stack">
            <h2 className="card__title">Your details</h2>
            <Field id="profile-name" label="Name" error={nameError} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  value={name}
                  invalid={invalid}
                  describedBy={describedBy}
                  autoComplete="name"
                  onChange={(e) => { setName(e.target.value); setNameError(null); }}
                />
              )}
            </Field>
            <Field
              id="profile-email"
              label="Email"
              hint={`Your email is your sign-in and cannot be changed here.${user?.created_at ? ` Member since ${fullDate(user.created_at)}.` : ''}`}
            >
              {({ id, describedBy }) => (
                <Input id={id} value={user?.email || ''} describedBy={describedBy} disabled />
              )}
            </Field>
            <div className="profile-facts">
              <Field id="profile-student-number" label="Student number" hint="Added when you signed up.">
                {({ id, describedBy }) => (
                  <Input id={id} value={user?.student_number || 'Not provided'} describedBy={describedBy} disabled />
                )}
              </Field>
              <Field id="profile-residence" label="Residence" hint="Added when you signed up.">
                {({ id, describedBy }) => (
                  <Input id={id} value={residenceLabel(user?.residence) || 'Not provided'} describedBy={describedBy} disabled />
                )}
              </Field>
            </div>
            <div>
              <Button type="submit" loading={savingName} disabled={name.trim() === (user?.name || '')}>
                {savingName ? 'Saving…' : 'Save name'}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <form onSubmit={savePreferences} noValidate className="stack">
            <h2 className="card__title">Shopping preferences</h2>

            {prefsState === 'error' && (
              <Alert tone="warning" title="Could not load your saved preferences">
                Refresh the page to try again. Saving is paused so your saved choices are not overwritten.
              </Alert>
            )}

            {catalogueError && (
              <Alert tone="warning" title="Could not load the store list">
                {catalogueError} Your saved preferences are still shown below.
              </Alert>
            )}

            <div>
              <p className="field__label" style={{ marginBottom: 'var(--s-2)' }}>
                What do you usually shop for?
              </p>
              <div className="chips">
                {categoryOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="chip"
                    aria-pressed={categories.includes(c)}
                    onClick={() => setCategories((list) => toggle(list, c))}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="field__label" style={{ marginBottom: 'var(--s-2)' }}>
                Stores you prefer
              </p>
              <div className="chips">
                {storeOptions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip"
                    aria-pressed={stores.includes(s)}
                    onClick={() => setStores((list) => toggle(list, s))}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="field__hint" style={{ marginTop: 'var(--s-2)' }}>
                A preferred store ranks higher; others are never hidden.
              </p>
            </div>

            <Field
              id="profile-distance"
              label="How far will you travel?"
              hint="Saved to your account for recommendations. Distance only counts once your location is on record, which the app cannot set yet. Leave blank to keep what is saved."
              error={distanceError}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  suffix="km"
                  placeholder="e.g. 5"
                  value={distance}
                  invalid={invalid}
                  describedBy={describedBy}
                  onChange={(e) => { setDistance(e.target.value.replace(/[^\d.]/g, '')); setDistanceError(null); }}
                />
              )}
            </Field>

            <div className="row" style={{ gap: 'var(--s-3)' }}>
              <Button type="submit" loading={savingPrefs} disabled={prefsState !== 'ready'}>
                {savingPrefs ? 'Saving…' : 'Save preferences'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => navigate('/recommendations')}>
                See my recommendations →
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
