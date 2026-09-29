/**
 * Notifications — the central feed of everything that happens in UniWallet:
 * budgets, spends, shopping list, profile and account changes, and alerts
 * such as entering survival mode. Each entry says what happened (title and
 * body), where (the module badge) and when (relative time, full date on hover).
 *
 * Backed by GET /notifications (app/routers/notifications.py).
 */

import { Badge, Button, Card, EmptyState, Eyebrow, Skeleton } from '../components/ui/index.js';
import { useNotifications } from '../context/NotificationsContext.jsx';
import { timeAgo } from '../lib/format.js';

const CATEGORY_ICON = {
  success: '✅', info: 'ℹ️', warning: '⚠️', alert: '🚨',
  survival: '⚠️', balance: '💰', system: '🔔', sms_in: '💬', sms_out: '💬',
};

const MODULE_LABEL = {
  budget: 'Budget', transactions: 'Spending', shopping_list: 'Shopping list',
  profile: 'Profile', account: 'Account', compare: 'Compare',
  recommendations: 'Recommendations', sms: 'SMS (legacy)', system: 'System',
};

const moduleLabel = (m) => MODULE_LABEL[m] || m.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function NotificationRow({ notification, onRead }) {
  return (
    <button
      type="button"
      className="notif-row"
      onClick={() => !notification.is_read && onRead(notification.id)}
      style={{
        display: 'block', width: '100%', textAlign: 'left', border: 0, cursor: 'pointer',
        background: notification.is_read ? 'transparent' : 'var(--c-forest-10, rgba(20,90,50,0.06))',
        borderRadius: 'var(--r-md)', padding: 'var(--s-4)',
      }}
    >
      <div className="row row--between" style={{ gap: 'var(--s-3)' }}>
        <div className="row" style={{ gap: 'var(--s-2)', alignItems: 'center' }}>
          <span aria-hidden="true">{CATEGORY_ICON[notification.category] || '🔔'}</span>
          <strong style={{ fontSize: 'var(--t-sm)' }}>{notification.title}</strong>
          {!notification.is_read && <Badge tone="brand">New</Badge>}
        </div>
        <span style={{ color: 'var(--c-muted)', fontSize: 'var(--t-xs)', whiteSpace: 'nowrap' }}>
          <time dateTime={notification.created_at} title={new Date(notification.created_at).toLocaleString()}>
            {timeAgo(notification.created_at)}
          </time>
        </span>
      </div>
      <p style={{ marginTop: 'var(--s-2)', color: 'var(--c-ink)', fontSize: 'var(--t-sm)' }}>
        {notification.body}
      </p>
      <div style={{ marginTop: 'var(--s-2)' }}>
        <Badge tone="neutral">{moduleLabel(notification.module)}</Badge>
      </div>
    </button>
  );
}

export default function Notifications() {
  const {
    items, unreadCount, ready, error, markRead, markAllRead,
  } = useNotifications();

  return (
    <div className="page--narrow" style={{ margin: '0 auto', maxWidth: 640 }}>
      <div className="stack stack--loose">
        <div className="row row--between" style={{ alignItems: 'flex-start' }}>
          <div>
            <Eyebrow>Stay in the loop</Eyebrow>
            <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
              Notifications
            </h1>
            <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)' }}>
              Everything that happens in UniWallet — budgets, spending, your shopping
              list, profile and alerts — in one place, updated as it happens.
            </p>
          </div>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              Mark all read
            </Button>
          )}
        </div>

        <Card>
          {!ready && (
            <div className="stack">
              <Skeleton height={64} /><Skeleton height={64} /><Skeleton height={64} />
            </div>
          )}
          {ready && error && (
            <EmptyState icon="⚠️" title="Could not load notifications">{error}</EmptyState>
          )}
          {ready && !error && items.length === 0 && (
            <EmptyState icon="🔔" title="Nothing yet">
              Activity across the app will show up here as it happens.
            </EmptyState>
          )}
          {ready && !error && items.length > 0 && (
            <div className="stack" style={{ gap: 'var(--s-2)' }}>
              {items.map((n) => (
                <NotificationRow key={n.id} notification={n} onRead={markRead} />
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
