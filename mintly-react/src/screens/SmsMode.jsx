/**
 * SMS Mode — a chat-style simulator for the short-code commands UniWallet
 * answers over SMS (POST /sms/reply). Phase 6.
 *
 * This screen doesn't send a real text message itself — it calls the exact
 * same endpoint a real SMS/USSD gateway's webhook would, so what you see
 * here is exactly what a phone would get back. Every exchange also lands
 * under Notifications (and, if a phone number is saved and SMS is turned on
 * in Profile, is actually dispatched there too) — see app/notifications.py.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Badge, Button, Card, Eyebrow, Input } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useNotifications } from '../context/NotificationsContext.jsx';
import { api } from '../api/client.js';

const QUICK_COMMANDS = [
  { label: 'Balance', body: 'BAL' },
  { label: "Today's allowance", body: 'TODAY' },
  { label: 'Cheapest bread', body: 'CMP bread' },
  { label: 'Nearest stores', body: 'NEAR' },
  { label: 'Help', body: 'HELP' },
];

function SmsBubble({ from, text, status }) {
  const mine = from === 'me';
  return (
    <div className="row" style={{ justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '80%',
          background: mine ? 'var(--c-forest)' : 'var(--c-surface-2, #f1f3f1)',
          color: mine ? '#fff' : 'var(--c-ink)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--s-3) var(--s-4)',
          whiteSpace: 'pre-wrap',
          fontSize: 'var(--t-sm)',
        }}
      >
        {text}
        {status && (
          <div style={{ marginTop: 'var(--s-2)' }}>
            <Badge tone={status === 'sent' ? 'success' : 'neutral'}>
              {status === 'sent' ? 'Sent to your phone'
                : status === 'simulated' ? 'Would be texted (no gateway connected)'
                  : status === 'no_phone' ? 'No phone number saved'
                    : status === 'disabled' ? 'SMS is off in Profile'
                      : 'Could not send the text'}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SmsMode() {
  const { token } = useAuth();
  const { refresh: refreshNotifications } = useNotifications();
  const navigate = useNavigate();
  const [thread, setThread] = useState([
    { from: 'uniwallet', text: "Hi! Text a command, or tap one below. Try BAL or HELP." },
  ]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [thread]);

  async function send(text) {
    const body = text.trim();
    if (!body || sending) return;
    setThread((t) => [...t, { from: 'me', text: body }]);
    setDraft('');
    setSending(true);
    setError(null);
    try {
      const { reply, notification } = await api.sms.send(token, body);
      setThread((t) => [...t, { from: 'uniwallet', text: reply, status: notification?.sms_status }]);
      refreshNotifications();
    } catch (err) {
      setError(err.message || 'Could not send that. Try again.');
    } finally {
      setSending(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    send(draft);
  }

  return (
    <div className="page--narrow" style={{ margin: '0 auto', maxWidth: 640 }}>
      <div className="stack stack--loose">
        <div>
          <Eyebrow>Works without data</Eyebrow>
          <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
            SMS Mode
          </h1>
          <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)' }}>
            Everything here works exactly like texting UniWallet's shortcode would —
            useful when data runs out. Turn on real SMS delivery to your phone in{' '}
            <button
              type="button"
              onClick={() => navigate('/profile')}
              style={{ background: 'none', border: 0, padding: 0, color: 'var(--c-forest)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Profile
            </button>.
          </p>
        </div>

        <Card>
          <div className="stack" style={{ gap: 'var(--s-3)' }}>
            <div className="chips">
              {QUICK_COMMANDS.map((c) => (
                <button
                  key={c.body}
                  type="button"
                  className="chip"
                  disabled={sending}
                  onClick={() => send(c.body)}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--s-3)',
                maxHeight: 420, overflowY: 'auto', padding: 'var(--s-2)',
              }}
            >
              {thread.map((m, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <SmsBubble key={i} from={m.from} text={m.text} status={m.status} />
              ))}
              <div ref={bottomRef} />
            </div>

            {error && <Alert tone="danger" title="Could not send">{error}</Alert>}

            <form onSubmit={submit} className="row" style={{ gap: 'var(--s-3)' }}>
              <Input
                value={draft}
                placeholder="Type a command, e.g. CMP bread"
                onChange={(e) => setDraft(e.target.value)}
                disabled={sending}
              />
              <Button type="submit" loading={sending} disabled={!draft.trim()}>
                Send
              </Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
