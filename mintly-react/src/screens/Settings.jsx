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
 *   Reduce motion          -> this device only (lib/localSettings.js)
 *   Shopping list          -> this device only, per account
 *
 * The backend has no generic settings endpoint, so nothing here pretends to
 * sync a device-only choice to the account.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Eyebrow } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useShopping } from '../context/ShoppingContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import { fullDate, longDate, money, plural } from '../lib/format.js';
import { getReducedMotion, setReducedMotion } from '../lib/localSettings.js';

export default function Settings() {
  const { user, logout } = useAuth();
  const { budget, remaining } = useBudget();
  const { clearList, listCount } = useShopping();
  const toast = useToast();
  const navigate = useNavigate();
  const [reducedMotion, setReducedMotionState] = useState(getReducedMotion);
  const [connection, setConnection] = useState('checking'); // checking | up | down

  function checkConnection() {
    setConnection('checking');
    api.system.health()
      .then(() => setConnection('up'))
      .catch(() => setConnection('down'));
  }
  useEffect(checkConnection, []);

  function toggleMotion(on) {
    setReducedMotionState(on);
    setReducedMotion(on);
    toast.info(on ? 'Motion reduced on this device.' : 'Motion restored on this device.');
  }

  async function clearShoppingList() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Clear your shopping list on this device?')) return;
    await clearList();
    toast.info('Shopping list cleared.');
  }

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  const sectionText = { color: 'var(--c-muted)', fontSize: 'var(--t-sm)' };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }} className="stack stack--loose">
      <div>
        <Eyebrow>App settings</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>Settings</h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '62ch' }}>
          Each setting says where it is kept: on your account (follows you to any device)
          or on this device only.
        </p>
      </div>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">Account</h2>
          <Badge tone="success">Saved to your account</Badge>
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
          <Button variant="ghost" size="sm" onClick={() => navigate('/profile')}>Profile &amp; preferences →</Button>
          <Button variant="quiet" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </Card>

      <Card className="stack">
        <div className="card__head">
          <h2 className="card__title">Budget</h2>
          <Badge tone="success">Saved to your account</Badge>
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
          <h2 className="card__title">Accessibility</h2>
          <Badge tone="neutral">This device only</Badge>
        </div>
        <p style={sectionText}>Turns off animations and sliding effects across the app.</p>
    <label className="checkbox" htmlFor="reduced-motion">
      <input
        id="reduced-motion"
        type="checkbox"
        checked={reducedMotion}
        onChange={(e) => toggleMotion(e.target.checked)}
      />
      <span>Reduce motion</span>
    </label>
  </Card>

  <Card className="stack">
    <div className="card__head">
      <h2 className="card__title">Shopping list</h2>
      <Badge tone="neutral">This device only</Badge>
    </div>
        <p style={sectionText}>
          {plural(listCount, 'item')} on your list. The list is kept in this browser for
          your account and does not sync to other devices yet.
        </p>
        <div className="row">
          <Button variant="ghost" size="sm" onClick={() => navigate('/compare')} disabled={!listCount}>
            Open my list
          </Button>
          <Button variant="danger" size="sm" onClick={clearShoppingList} disabled={!listCount}>
            Clear shopping list
          </Button>
        </div>
      </Card>

      <Card>
        <div className="card__head">
          <h2 className="card__title">Connection</h2>
          <Badge tone={connection === 'up' ? 'success' : connection === 'down' ? 'danger' : 'neutral'}>
            {connection === 'up' ? 'Online' : connection === 'down' ? 'Offline' : 'Checking'}
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
