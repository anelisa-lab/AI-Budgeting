/**
 * Profile & shopping preferences.
 * Member 8 (screen) on Member 2's endpoints.
 *
 * Covers the functional requirement "allow authenticated users to manage
 * profile and shopping preferences":
 *
 *   GET /profile              { name, email, residence, student_number, ... }
 *   PUT /profile              { name, residence, student_number }
 *   PUT /profile/location     { latitude, longitude, label }   (Phase 5)
 *   PUT /profile/preferences  { preferred_categories, preferred_stores, max_distance_km }
 *   GET/PUT /sms/preferences  { phone_number, sms_enabled, low_balance_threshold }  (Phase 6)
 *
 * The SMS card is what actually turns "SMS Mode" from a screen you have to
 * open into something that reaches you: every exchange there (and the
 * survival-mode / low-balance alerts app/routers/budgets.py fires on their
 * own) always lands under Notifications, but it is only texted to a real
 * phone once a number is saved here and the switch is on — see
 * app/notifications.dispatch_sms.
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
  Alert, Button, Card, Eyebrow, Field, Input, Select, Switch,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import * as v from '../lib/validation.js';
import { CATALOGUE_CATEGORIES, canonicalCategory } from '../lib/categories.js';
import { fullDate } from '../lib/format.js';
import { RESIDENCES } from '../lib/residences.js';

/**
 * Parse "-29.8547, 31.0084" (the format Google Maps copies when you
 * right-click a spot) into coordinates. Returns { latitude, longitude } or
 * { error }.
 */
function parseCoordinates(text) {
  const parts = String(text).trim().split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 2) {
    return { error: 'Enter your latitude and longitude, like -29.8547, 31.0084.' };
  }
  const [latitude, longitude] = parts.map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: 'Latitude and longitude must be numbers, like -29.8547, 31.0084.' };
  }
  if (latitude < -90 || latitude > 90) return { error: 'Latitude must be between -90 and 90.' };
  if (longitude < -180 || longitude > 180) return { error: 'Longitude must be between -180 and 180.' };
  return { latitude, longitude };
}

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
  const [studentNumber, setStudentNumber] = useState(user?.student_number || '');
  const [studentNumberError, setStudentNumberError] = useState(null);
  const [residence, setResidence] = useState(user?.residence || '');
  const [savingName, setSavingName] = useState(false);

  // Where the student is — distance search, "near me", proximity, taxi fares.
  const [location, setLocationState] = useState(undefined); // undefined = loading
  const [locationError, setLocationError] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [coordsText, setCoordsText] = useState('');
  const [coordsError, setCoordsError] = useState(null);
  const [locationLabel, setLocationLabel] = useState('');
  const [savingLocation, setSavingLocation] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.profile.getLocation(token)
      .then((l) => { if (!cancelled) setLocationState(l); })
      .catch(() => { if (!cancelled) { setLocationState(null); setLocationError('Could not load your saved location.'); } });
    return () => { cancelled = true; };
  }, [token]);

  async function saveLocation(coords) {
    setSavingLocation(true);
    setLocationError(null);
    try {
      setLocationState(await api.profile.setLocation(token, coords));
      setShowManual(false);
      setCoordsText('');
      setLocationLabel('');
      toast.success('Location saved — distances and taxi fares now use it.');
    } catch (err) {
      setLocationError(err.message || 'Could not save your location.');
    } finally {
      setSavingLocation(false);
    }
  }

  function saveManualLocation(event) {
    event.preventDefault();
    const parsed = parseCoordinates(coordsText);
    if (parsed.error) { setCoordsError(parsed.error); return; }
    const label = locationLabel.trim().replace(/\s+/g, ' ');
    if (label.length > 100) { setCoordsError('Keep the name under 100 characters.'); return; }
    setCoordsError(null);
    saveLocation({
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      label: label || 'My location',
    });
  }

  function shareDeviceLocation() {
    if (!navigator.geolocation) {
      setLocationError('This browser cannot share its location. Use "Insert your location" instead.');
      return;
    }
    setSavingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => saveLocation({
        latitude: pos.coords.latitude, longitude: pos.coords.longitude, label: 'My current location',
      }),
      () => {
        setSavingLocation(false);
        setLocationError('Location permission was not given. Use "Insert your location" instead.');
      },
      { timeout: 10000, maximumAge: 300000 },
    );
  }

  async function forgetLocation() {
    setSavingLocation(true);
    try {
      setLocationState(await api.profile.clearLocation(token));
      toast.info('Location removed.');
    } catch (err) {
      setLocationError(err.message || 'Could not remove your location.');
    } finally {
      setSavingLocation(false);
    }
  }

  // SMS delivery — GET/PUT /sms/preferences (Phase 6). Loaded independently of
  // the shopping preferences above; a failure here shouldn't block the rest
  // of the page, so it gets its own state instead of piggy-backing on prefsState.
  const [smsPhone, setSmsPhone] = useState('');
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [smsThreshold, setSmsThreshold] = useState('');
  const [smsPhoneError, setSmsPhoneError] = useState(null);
  const [smsThresholdError, setSmsThresholdError] = useState(null);
  const [smsState, setSmsState] = useState('loading'); // loading | ready | error
  const [savingSms, setSavingSms] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.sms.getPreferences(token)
      .then((p) => {
        if (cancelled) return;
        setSmsPhone(p.phone_number || '');
        setSmsEnabled(p.sms_enabled);
        setSmsThreshold(p.low_balance_threshold == null ? '' : String(p.low_balance_threshold));
        setSmsState('ready');
      })
      .catch(() => { if (!cancelled) setSmsState('error'); });
    return () => { cancelled = true; };
  }, [token]);

  async function saveSmsPreferences(event) {
    event.preventDefault();
    const phone = smsPhone.trim();
    const phoneError = phone && !/^[+\d][\d\s-]{6,29}$/.test(phone)
      ? 'Enter a phone number using digits only, e.g. 0821234567 or +27821234567.'
      : null;
    const blankThreshold = String(smsThreshold).trim() === '';
    const thresholdNum = Number(smsThreshold);
    const thresholdError = !blankThreshold && !(Number.isFinite(thresholdNum) && thresholdNum >= 0)
      ? 'Enter a rand amount of 0 or more.'
      : null;
    setSmsPhoneError(phoneError);
    setSmsThresholdError(thresholdError);
    if (phoneError || thresholdError) return;

    // A switch turned on with no phone number saved would just silently log
    // "no_phone" on every text — tell the student now instead of later.
    if (smsEnabled && !phone) {
      setSmsPhoneError('Add your number before turning SMS delivery on.');
      return;
    }

    setSavingSms(true);
    try {
      const saved = await api.sms.updatePreferences(token, {
        phone_number: phone,
        sms_enabled: smsEnabled,
        ...(blankThreshold ? {} : { low_balance_threshold: thresholdNum }),
      });
      setSmsPhone(saved.phone_number || '');
      setSmsEnabled(saved.sms_enabled);
      setSmsThreshold(saved.low_balance_threshold == null ? '' : String(saved.low_balance_threshold));
      toast.success('SMS preferences saved.');
    } catch (err) {
      toast.error(err.message || 'Could not save your SMS preferences.');
    } finally {
      setSavingSms(false);
    }
  }

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

  useEffect(() => {
    setName(user?.name || '');
    setStudentNumber(user?.student_number || '');
    setResidence(user?.residence || '');
  }, [user]);
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
    const snError = studentNumber.trim() ? v.studentNumber(studentNumber) : null;
    setNameError(error);
    setStudentNumberError(snError);
    if (error || snError) return;
    setSavingName(true);
    try {
      await updateProfile({
        name: name.trim().replace(/\s+/g, ' '),
        // '' clears either one on the server.
        student_number: studentNumber.trim(),
        residence,
      });
      toast.success('Details updated.');
    } catch (err) {
      if (err.fieldErrors?.studentNumber) setStudentNumberError(err.fieldErrors.studentNumber);
      else setNameError(err.fieldErrors?.name || err.message || 'Could not update your details.');
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
              <Field id="profile-student-number" label="Student number" hint="Optional · 8 or 9 digits." error={studentNumberError}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id} inputMode="numeric" placeholder="Not provided"
                    value={studentNumber} invalid={invalid} describedBy={describedBy}
                    onChange={(e) => { setStudentNumber(e.target.value.replace(/\D/g, '')); setStudentNumberError(null); }}
                  />
                )}
              </Field>
              <Field id="profile-residence" label="Residence" hint="Optional.">
                {({ id, describedBy }) => (
                  <Select
                    id={id} options={RESIDENCES} value={residence} describedBy={describedBy}
                    onChange={(e) => setResidence(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div>
              <Button
                type="submit"
                loading={savingName}
                disabled={name.trim() === (user?.name || '')
                  && studentNumber.trim() === (user?.student_number || '')
                  && residence === (user?.residence || '')}
              >
                {savingName ? 'Saving…' : 'Save details'}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <div className="stack">
            <h2 className="card__title">Where you are</h2>
            <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)' }}>
              Used to find stores near you, rank nearer stores higher and add taxi fares to
              the true cost when you collect. Only distances are worked out from it.
            </p>
            {location === undefined ? (
              <p style={{ fontSize: 'var(--t-sm)', color: 'var(--c-muted)' }}>Loading…</p>
            ) : location ? (
              <Alert tone="success" title={`Saved: ${location.label}`}>
                Search can now filter by distance and Compare adds taxi fares for far stores.
              </Alert>
            ) : (
              <Alert tone="info" title="No location saved yet">
                Distance filters and taxi fares stay off until you add one.
              </Alert>
            )}
            {locationError && <Alert tone="danger" title="Location">{locationError}</Alert>}
            <div className="row" style={{ gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <Button
                type="button"
                variant={showManual ? 'ghost' : undefined}
                onClick={() => { setShowManual((open) => !open); setCoordsError(null); setLocationError(null); }}
                disabled={savingLocation}
                aria-expanded={showManual}
                aria-controls="profile-manual-location"
              >
                Insert your location
              </Button>
              <Button type="button" variant="ghost" onClick={shareDeviceLocation} disabled={savingLocation}>
                Use my current location
              </Button>
              {location && (
                <Button type="button" variant="quiet" onClick={forgetLocation} disabled={savingLocation}>
                  Remove
                </Button>
              )}
            </div>
            {showManual && (
              <form
                id="profile-manual-location"
                onSubmit={saveManualLocation}
                className="stack"
                noValidate
              >
                <Field
                  id="profile-coords"
                  label="Latitude and longitude"
                  hint="In Google Maps, right-click your spot and tap the numbers to copy them, then paste here."
                  error={coordsError}
                  required
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      inputMode="text"
                      placeholder="-29.8547, 31.0084"
                      value={coordsText}
                      invalid={invalid}
                      describedBy={describedBy}
                      onChange={(e) => { setCoordsText(e.target.value); setCoordsError(null); }}
                    />
                  )}
                </Field>
                <Field id="profile-location-label" label="Name this place" hint="Optional, e.g. “My digs”.">
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      maxLength={100}
                      placeholder="My location"
                      value={locationLabel}
                      describedBy={describedBy}
                      onChange={(e) => setLocationLabel(e.target.value)}
                    />
                  )}
                </Field>
                <div>
                  <Button type="submit" loading={savingLocation} disabled={!coordsText.trim()}>
                    Save location
                  </Button>
                </div>
              </form>
            )}
          </div>
        </Card>

        <Card>
          <form onSubmit={saveSmsPreferences} noValidate className="stack">
            <h2 className="card__title">Notifications &amp; SMS</h2>
            <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)' }}>
              Everything UniWallet tells you — SMS Mode replies, entering survival mode,
              a low balance — always shows up under{' '}
              <button
                type="button"
                onClick={() => navigate('/notifications')}
                style={{ background: 'none', border: 0, padding: 0, color: 'var(--c-forest)', textDecoration: 'underline', cursor: 'pointer' }}
              >
                Notifications
              </button>
              . Add your number and switch this on to also get them as a real text.
            </p>

            {smsState === 'error' && (
              <Alert tone="warning" title="Could not load your SMS preferences">
                Refresh the page to try again.
              </Alert>
            )}

            <Field
              id="profile-sms-phone"
              label="Phone number"
              hint="Used only to send you these alerts."
              error={smsPhoneError}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  type="tel"
                  inputMode="tel"
                  placeholder="e.g. 0821234567"
                  value={smsPhone}
                  invalid={invalid}
                  describedBy={describedBy}
                  disabled={smsState === 'loading'}
                  onChange={(e) => { setSmsPhone(e.target.value); setSmsPhoneError(null); }}
                />
              )}
            </Field>

            <div className="switch-row">
              <div className="switch-row__text">
                <label htmlFor="profile-sms-enabled" className="switch-row__label">
                  Text me these alerts
                </label>
                <span className="switch-row__hint">
                  {smsEnabled ? 'On — sent to your phone when a number is saved.' : 'Off — still logged under Notifications.'}
                </span>
              </div>
              <Switch
                id="profile-sms-enabled"
                checked={smsEnabled}
                onChange={setSmsEnabled}
                disabled={smsState === 'loading'}
                label="Text me these alerts"
              />
            </div>

            <Field
              id="profile-sms-threshold"
              label="Also alert me when my balance drops below"
              hint="Optional. Separate from Survival mode's own threshold, so you can hear about it earlier. Leave blank to turn off this alert."
              error={smsThresholdError}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  prefix="R"
                  placeholder="e.g. 100"
                  value={smsThreshold}
                  invalid={invalid}
                  describedBy={describedBy}
                  disabled={smsState === 'loading'}
                  onChange={(e) => { setSmsThreshold(e.target.value.replace(/[^\d.]/g, '')); setSmsThresholdError(null); }}
                />
              )}
            </Field>

            <div>
              <Button type="submit" loading={savingSms} disabled={smsState !== 'ready'}>
                {savingSms ? 'Saving…' : 'Save notification settings'}
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
