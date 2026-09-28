/**
 * Notifications — the in-app mirror of every SMS mode exchange, plus
 * app-triggered alerts such as crossing into survival mode. Phase 6.
 *
 * Backed by GET /notifications (app/routers/notifications.py). Every row here
 * was written by the same call that answered an SMS command or fired an
 * automatic alert, so what's shown is exactly what would have been texted —
 * with an `sms_status` badge saying whether it actually reached a phone
 * ('sent'), would have if a gateway were configured ('simulated'), or
 * couldn't ('no_phone' / 'disabled' / 'failed').
 */

import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Eyebrow, Skeleton } from '../components/ui/index.js';
import { useNotifications } from '../context/NotificationsContext.jsx';
import { timeAgo } from '../lib/format.js';

const CATEGORY_ICON = {
  sms_in: '💬', sms_out: '💬', survival: '⚠️', balance: '💰', system: '🔔',
};

const SMS_STATUS_LABEL = {
  sent: { text: 'Sent to your phone', tone: 'success' },
  simulated: { text: 'Would be texted (no SMS gateway connected)', tone: 'neutral' },
  no_phone: { text: 'No phone number saved', tone: 'warning' },
  disabled: { text: 'SMS is turned off', tone: 'neutral' },
  failed: { text: 'Could not send the text', tone: 'danger' },
};

function NotificationRow({ notification, onRead }) {
  const statusInfo = notification.sms_status ? SMS_STATUS_LABEL[notification.sms_status] : null;
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
          {timeAgo(notification.created_at)}
        </span>
      </div>
      <p style={{ marginTop: 'var(--s-2)', color: 'var(--c-ink)', fontSize: 'var(--t-sm)' }}>
        {notification.body}
      </p>
      {statusInfo && (
        <div style={{ marginTop: 'var(--s-2)' }}>
          <Badge tone={statusInfo.tone}>{statusInfo.text}</Badge>
        </div>
      )}
    </button>
  );
}

export default function Notifications() {
  const {
    items, unreadCount, ready, error, markRead, markAllRead,
  } = useNotifications();
  const navigate = useNavigate();

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
              Everything UniWallet has sent you by SMS, plus alerts like entering
              survival mode — all in one place, whether or not it reached your phone.
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
              Text a command to UniWallet&rsquo;s SMS Mode — like BAL or TODAY — and the
              reply will show up here too.
              <div style={{ marginTop: 'var(--s-4)' }}>
                <Button size="sm" onClick={() => navigate('/sms')}>Open SMS Mode →</Button>
              </div>
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
