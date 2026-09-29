/**
 * Chat — the budgeting assistant (POST /chat, app/chatbot.py).
 *
 * A conversational way to build a priced, realistic shopping list: "I have
 * R400 for the week" in, an itemised plan grounded in the app's own live
 * and catalogue prices out. The backend is stateless per call, so this
 * screen is the one place that keeps the conversation — it resends every
 * prior turn (as plain text only; Claude's tool calls never leave the
 * server) on each new message.
 *
 * The thread lives in memory only, like SMS Mode's simulator: it resets on
 * reload rather than being saved to the account, since the backend itself
 * keeps nothing between calls.
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Eyebrow } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../api/client.js';

const STARTERS = [
  'I have R400 for this week — what should I buy?',
  'Budget me for groceries this week',
  'Cheapest place to buy maize meal and rice?',
  "What's left in my budget today?",
];

const TOOL_LABELS = {
  get_budget_status: 'checked your budget',
  recommend_items: 'searched live prices',
  search_products: 'searched the catalogue',
  list_stores: 'checked which stores are covered',
  compare_stores_for_list: 'compared stores',
  check_affordability: "checked today's allowance",
  get_shopping_list: 'looked at your shopping list',
  add_to_shopping_list: 'added an item to your list',
};

function toolSummary(toolsUsed) {
  if (!toolsUsed?.length) return null;
  const unique = [...new Set(toolsUsed)];
  return unique.map((t) => TOOL_LABELS[t] || t).join(' · ');
}

function ChatBubble({ from, text, toolsUsed }) {
  const mine = from === 'me';
  return (
    <div className="row" style={{ justifyContent: mine ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '85%',
          background: mine ? 'var(--c-forest)' : 'var(--c-surface-2, #f1f3f1)',
          color: mine ? '#fff' : 'var(--c-ink)',
          borderRadius: 'var(--r-lg)',
          padding: 'var(--s-3) var(--s-4)',
          whiteSpace: 'pre-wrap',
          fontSize: 'var(--t-sm)',
        }}
      >
        {text}
        {toolSummary(toolsUsed) && (
          <div style={{ marginTop: 'var(--s-2)' }}>
            <Badge tone="neutral">{toolSummary(toolsUsed)}</Badge>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Chat() {
  const { token } = useAuth();
  const [thread, setThread] = useState([
    {
      from: 'assistant',
      text:
        "Hi! Tell me how much you have and for how long — e.g. \"R400 for this week\" — "
        + 'and I’ll build a priced shopping list from real store prices.',
    },
  ]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [thread]);

  async function send(text) {
    const message = text.trim();
    if (!message || sending) return;

    // Plain-text history only, oldest first — the backend never sees or
    // stores tool calls, so none of that belongs in what we resend either.
    const history = thread
      .filter((m) => m.from !== 'error')
      .map((m) => ({ role: m.from === 'me' ? 'user' : 'assistant', content: m.text }));

    setThread((t) => [...t, { from: 'me', text: message }]);
    setDraft('');
    setSending(true);
    setError(null);
    try {
      const { reply, tools_used: toolsUsed } = await api.chat.send(token, message, history);
      setThread((t) => [...t, { from: 'assistant', text: reply, toolsUsed }]);
    } catch (err) {
      setError(err.message || 'Could not reach the budgeting assistant. Try again.');
    } finally {
      setSending(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    send(draft);
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  }

  return (
    <div className="page--narrow" style={{ margin: '0 auto', maxWidth: 640 }}>
      <div className="stack stack--loose">
        <div>
          <Eyebrow>Budgeting assistant</Eyebrow>
          <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
            Chat
          </h1>
          <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)' }}>
            Every price it gives you comes from a live lookup against this app&rsquo;s own
            stores — Checkers, Shoprite and the rest of the catalogue — not a guess.
          </p>
        </div>

        <Card>
          <div className="stack" style={{ gap: 'var(--s-3)' }}>
            {thread.length <= 1 && (
              <div className="chips">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="chip"
                    disabled={sending}
                    onClick={() => send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--s-3)',
                maxHeight: 480, overflowY: 'auto', padding: 'var(--s-2)',
              }}
            >
              {thread.map((m, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <ChatBubble key={i} from={m.from} text={m.text} toolsUsed={m.toolsUsed} />
              ))}
              {sending && (
                <div className="row" style={{ justifyContent: 'flex-start' }}>
                  <Badge tone="neutral">Thinking…</Badge>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {error && <Alert tone="danger" title="Could not send">{error}</Alert>}

            <form onSubmit={submit} className="stack" style={{ gap: 'var(--s-3)' }}>
              <textarea
                className="input"
                rows={2}
                value={draft}
                placeholder="e.g. I have R400 for this week — what should I buy?"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
                style={{ resize: 'vertical', minHeight: 46 }}
              />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button type="submit" loading={sending} disabled={!draft.trim()}>
                  Send
                </Button>
              </div>
            </form>
          </div>
        </Card>
      </div>
    </div>
  );
}
