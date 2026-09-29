/**
 * Settings.
 *
 * Only settings the app can genuinely keep are offered here, and each one
 * says WHERE it is kept:
 *
 *   Account & preferences  -> saved to the account (Profile screen,
 *                             PUT /profile and PUT /profile/preferences)
 *   Budget                 -> saved to the account (Budget screen,
 *                             PUT /budgets/{id})
 *   Theme, reduce motion          -> this device only (lib/localSettings.js)
 *
 * The backend has no generic settings endpoint, so nothing here pretends to
 * sync a device-only choice to the account.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Eyebrow, Select } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useLanguage } from '../context/LanguageContext.jsx';
import { LANGUAGES } from '../i18n/translations.js';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import { fullDate, longDate, money } from '../lib/format.js';
import {
  getContrastMode,
  getTheme,
  getReducedMotion,
  getTextSize,
  setContrastMode,
  setTheme,
  setReducedMotion,
  setTextSize,
} from '../lib/localSettings.js';

export default function Settings() {
  const { user, logout } = useAuth();
  const { budget, remaining } = useBudget();
  const { t, lang, setLang } = useLanguage();
  const toast = useToast();
  const navigate = useNavigate();
  const [reducedMotion, setReducedMotionState] = useState(getReducedMotion);
  const [textSize, setTextSizeState] = useState(getTextSize);
  const [theme, setThemeState] = useState(getTheme);
  const [contrastMode, setContrastModeState] = useState(getContrastMode);
  const [connection, setConnection] = useState('checking'); // checking | up | down

  function checkConnection() {
    setConnection('checking');
    api.system.health()
      .then(() => setConnection('up'))
      .catch(() => setConnection('down'));
  }
  useEffect(checkConnection, []);

  function changeTheme(value) {
    setThemeState(value);
    setTheme(value);
    const label = value === 'dark' ? 'Dark' : value === 'light' ? 'Light' : 'System';
    toast.info(`${label} theme set on this device.`);
  }

  function toggleMotion(on) {
    setReducedMotionState(on);
    setReducedMotion(on);
    toast.info(on ? 'Motion reduced on this device.' : 'Motion restored on this device.');
  }

  function changeTextSize(size) {
    setTextSizeState(size);
    setTextSize(size);
    const label = size === 'extra-large' ? 'Extra large' : size === 'large' ? 'Large' : 'Default';
    toast.info(`Text size set to ${label} on this device.`);
  }

  function toggleContrast(on) {
    const mode = on ? 'high' : 'default';
    setContrastModeState(mode);
    setContrastMode(mode);
    toast.info(on ? 'Stronger contrast enabled on this device.' : 'Stronger contrast disabled.');
  }

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  const sectionText = { color: 'var(--c-muted)', fontSize: 'var(--t-sm)' };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }} className="stack stack--loose">
      <div>
        <Eyebrow>{t('settings.eyebrow')}</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>{t('settings.title')}</h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '62ch' }}>
          {t('settings.intro')}
        </p>
      </div>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">{t('settings.account')}</h2>
          <Badge tone="success">{t('settings.savedAccount')}</Badge>
        </div>
        <p style={sectionText}>
          {user?.name} · {user?.email}
          {user?.created_at ? ` · member since ${fullDate(user.created_at)}` : ''}
        </p>
        <p style={sectionText}>
          Your name, favourite categories and preferred stores are on the Profile page.
          Recommendations use them.
        </p>
        <div className="row">
          <Button variant="ghost" size="sm" onClick={() => navigate('/profile')}>{t('settings.profileLink')}</Button>
          <Button variant="quiet" size="sm" onClick={signOut}>{t('nav.signOut')}</Button>
        </div>
      </Card>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">{t('settings.budget')}</h2>
          <Badge tone="success">{t('settings.savedAccount')}</Badge>
        </div>
        <p style={sectionText}>
          {budget
            ? `${money(remaining)} left until ${longDate(budget.cycle_end_date)}.`
            : 'No budget set yet.'}
        </p>
        <div className="row">
          <Button variant="ghost" size="sm" onClick={() => navigate('/budget')}>
            {budget ? 'Edit my budget →' : 'Set my budget →'}
          </Button>
        </div>
      </Card>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">{t('settings.appearance')}</h2>
          <Badge tone="neutral">{t('settings.deviceOnly')}</Badge>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="theme">{t('settings.theme')}</label>
          <Select
            id="theme"
            value={theme}
            onChange={(e) => changeTheme(e.target.value)}
            options={[
              { value: 'system', label: t('settings.themeSystem') },
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
            ]}
          />
        </div>
      </Card>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">{t('settings.language')}</h2>
          <Badge tone="neutral">{t('settings.deviceOnly')}</Badge>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="language">{t('settings.language')}</label>
          <Select
            id="language"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            describedBy="language-hint"
            options={LANGUAGES.map((l) => ({ value: l.code, label: l.native }))}
          />
          <p className="field__hint" id="language-hint">{t('settings.languageHint')}</p>
        </div>
      </Card>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">{t('settings.accessibility')}</h2>
          <Badge tone="neutral">{t('settings.deviceOnly')}</Badge>
        </div>
        <p style={sectionText}>
          These controls change how UniWallet is presented on this browser. They do not change
          your account or the normal app colour palette.
        </p>

        <div className="stack stack--tight">
          <label className="checkbox" htmlFor="reduced-motion">
            <input
              id="reduced-motion"
              type="checkbox"
              checked={reducedMotion}
              onChange={(e) => toggleMotion(e.target.checked)}
            />
            <span>
              Reduce motion{' '}
              <span className="field__hint checkbox__hint">Animations, transitions and scrolling are reduced.</span>
            </span>
          </label>

          <div className="field">
            <label className="field__label" htmlFor="text-size">Text size</label>
            <Select
              id="text-size"
              value={textSize}
              onChange={(e) => changeTextSize(e.target.value)}
              describedBy="text-size-hint"
              options={[
                { value: 'default', label: 'Default' },
                { value: 'large', label: 'Large' },
                { value: 'extra-large', label: 'Extra large' },
              ]}
            />
            <p className="field__hint" id="text-size-hint">
              Increases readable text throughout the app without zooming the whole page.
            </p>
          </div>

          <label className="checkbox" htmlFor="stronger-contrast">
            <input
              id="stronger-contrast"
              type="checkbox"
              checked={contrastMode === 'high'}
              onChange={(e) => toggleContrast(e.target.checked)}
            />
            <span>
              Stronger contrast{' '}
              <span className="field__hint checkbox__hint">Strengthens text and interface boundaries only when enabled.</span>
            </span>
          </label>
        </div>

        <p className="field__hint">
          Reduced motion also respects your browser or operating system&apos;s{' '}
          <code>prefers-reduced-motion</code> preference.
        </p>
      </Card>

      <Card>
        <div className="card__head">
          <h2 className="card__title">{t('settings.connection')}</h2>
          <Badge tone={connection === 'up' ? 'success' : connection === 'down' ? 'danger' : 'neutral'}>
            {connection === 'up' ? t('settings.online') : connection === 'down' ? t('settings.offline') : t('settings.checking')}
          </Badge>
        </div>
        <p style={sectionText}>
          {connection === 'up' && 'UniWallet can reach its server.'}
          {connection === 'down' && 'UniWallet cannot reach its server right now. Check your internet connection.'}
          {connection === 'checking' && 'Checking…'}
        </p>
        {connection === 'down' && (
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" variant="ghost" onClick={checkConnection}>Check again</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
