/**
 * Live prices — product cards from GET /api/search.
 *
 * Shown on the Search screen for the word in the search box, above the
 * catalogue results. The backend asks the stores it has switched on
 * (Checkers Sixty60 only for now) at most once per query every 6 hours, so
 * running this on every search is cheap.
 *
 * These are not catalogue offers — no offer_id, no delivery fee, no fees
 * from store_charges. Each card links to the store, and "Add to list" puts
 * the item on the student's list (POST /shopping-list/items {item_id}) at
 * today's price, saved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Skeleton } from '../ui/index.js';
import { api } from '../../api/client.js';
import { useShopping } from '../../context/ShoppingContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { money, plural, timeAgo } from '../../lib/format.js';

const FIRST_ROWS = 8;
const STORE_LABELS = { checkers: 'Checkers Sixty60' };

export default function LivePrices({ token, query }) {
  const term = (query || '').trim();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const controller = useRef(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    setData(null);
    setError(null);
    setShowAll(false);
    if (!token || term.length < 2) { setLoading(false); return; }

    const ctrl = new AbortController();
    controller.current = ctrl;
    setLoading(true);
    try {
      const result = await api.search.live(token, term, { signal: ctrl.signal });
      if (!ctrl.signal.aborted) setData(result);
    } catch (err) {
      if (err?.name === 'AbortError' || ctrl.signal.aborted) return;
      setError(err.message || 'Live prices are unavailable right now.');
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [token, term]);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);

  if (term.length < 2) return null;

  const storeNames = (data?.stores || []).map((s) => STORE_LABELS[s.store] || s.name);
  const title = storeNames.length ? `Live prices · ${storeNames.join(', ')}` : 'Live prices';
  const fetchedAt = data?.stores?.map((s) => s.fetched_at).filter(Boolean).sort()[0];
  const stale = data?.stores?.some((s) => s.source === 'stale');
  // Belt and braces: the backend already filters by store in SQL; this only
  // shows cards from a store the backend says is switched on (Checkers).
  const activeNames = new Set((data?.stores || []).map((s) => s.name));
  const items = (data?.results || []).filter((item) => activeNames.has(item.store));
  const visible = showAll ? items : items.slice(0, FIRST_ROWS);

  return (
    <Card className="stack live-prices" style={{ marginBottom: 'var(--s-5)' }}>
      <div className="row row--between">
        <h2 style={{ fontSize: 'var(--t-md)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' }}>
          <span aria-hidden="true">●</span> {title}
        </h2>
        {fetchedAt && (
          <span className="live-prices__checked">
            {stale && <Badge tone="warning">May be out of date</Badge>}{' '}
            Prices checked {timeAgo(fetchedAt)}
          </span>
        )}
      </div>

      <p className="live-prices__count" aria-live="polite">
        {loading
          ? `Checking live prices for “${term}”…`
          : data && items.length > 0
            ? `${plural(items.length, 'product')} for “${term}”`
            : ''}
      </p>

      {loading ? (
        <div className="live-grid" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={250} radius="var(--r-lg)" />)}
        </div>
      ) : error ? (
        <Alert tone="warning" title="Live prices unavailable">
          {error} The catalogue results below still work.
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
          </div>
        </Alert>
      ) : items.length === 0 ? (
        <p className="live-prices__empty">
          {data?.message || `No live prices found for “${term}”.`}
        </p>
      ) : (
        <>
          {data.message && <p className="live-prices__empty">{data.message}</p>}
          <ul className="live-grid">
            {visible.map((item) => <LiveCard key={item.id} item={item} />)}
          </ul>
          {items.length > FIRST_ROWS && (
            <Button variant="ghost" block onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${items.length}`}
            </Button>
          )}
          <p className="live-prices__note">
            Straight from the store&apos;s website. Delivery and store fees aren&apos;t included.
            Items you add keep the price they had when you added them.
          </p>
        </>
      )}
    </Card>
  );
}

function LiveCard({ item }) {
  const [imageFailed, setImageFailed] = useState(false);
  const body = (
    <>
      <div className="live-card__image">
        {item.image_url && !imageFailed ? (
          <img
            src={item.image_url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span aria-hidden="true">🛒</span>
        )}
      </div>
      <div className="live-card__body">
        <h3 className="live-card__name">{item.name}</h3>
        <LivePrice item={item} />
        <div className="result__tags">
          {item.buyable && item.on_promotion && <Badge tone="accent">Promotion</Badge>}
          {!item.in_stock && <Badge tone="danger">Out of stock</Badge>}
        </div>
      </div>
    </>
  );
  return (
    <li className="live-card">
      {item.product_url ? (
        <a
          className="live-card__link"
          href={item.product_url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${item.name}, ${priceLabel(item)} at ${item.store} (opens the store's website)`}
        >
          {body}
        </a>
      ) : <div className="live-card__link">{body}</div>}
      <ListButton item={item} />
    </li>
  );
}

/**
 * Below every card, always visible (no hover needed on a phone):
 *   buyable          -> "Add to list", then "Added ✓ +1" and a quantity stepper
 *   no price / stock -> disabled, so an unpriced item can never be added
 * The server refuses an unbuyable item too (409), so this is not the only guard.
 */
function ListButton({ item }) {
  const { liveQtyOf, addLive, setLiveQty } = useShopping();
  const toast = useToast();
  const qty = liveQtyOf(item.id);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(0);      // bumps on every successful add
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function run(action, added) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      if (added) {
        setFlash((n) => n + 1);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFlash(0), 1400);
      }
    } catch (err) {
      toast.error(err.message || 'Could not update your list.');
    } finally {
      setBusy(false);
    }
  }

  if (!item.buyable) {
    return (
      <div className="live-card__actions">
        <Button size="sm" variant="secondary" block disabled aria-disabled="true">
          {item.in_stock ? 'No price — can’t add' : 'Out of stock'}
        </Button>
      </div>
    );
  }

  if (qty === 0) {
    return (
      <div className="live-card__actions">
        <Button
          size="sm"
          block
          loading={busy}
          onClick={() => run(() => addLive(item, 1), true)}
          aria-label={`Add to list: ${item.name}, ${money(item.price)}`}
        >
          Add to list
        </Button>
      </div>
    );
  }

  return (
    <div className="live-card__actions">
      <div className="live-card__stepper">
        <Button
          variant="ghost" size="sm" disabled={busy}
          onClick={() => run(() => setLiveQty(item.id, qty - 1), false)}
          aria-label={qty === 1 ? `Remove ${item.name} from your list` : `One fewer ${item.name}`}
        >−</Button>
        <span className="num" aria-live="polite" style={{ fontWeight: 'var(--fw-extra)' }}>
          {flash ? <span className="live-card__added" key={flash}>Added ✓ +1</span> : `${qty} on list`}
        </span>
        <Button
          variant="ghost" size="sm" disabled={busy || qty >= 20}
          onClick={() => run(() => addLive(item, 1), true)}
          aria-label={`One more ${item.name}`}
        >+</Button>
      </div>
    </div>
  );
}

/**
 * Never "R0,00": a price only shows when the item can be bought. Otherwise
 * the last real price seen, in grey, or "Price unavailable".
 */
function LivePrice({ item }) {
  if (item.buyable) {
    return <div className="live-card__price num">{money(item.price)}</div>;
  }
  return (
    <p className="live-card__no-price">
      {item.last_known_price != null
        ? <>Last seen <span className="num">{money(item.last_known_price)}</span></>
        : 'Price unavailable'}
    </p>
  );
}

function priceLabel(item) {
  if (item.buyable) return money(item.price);
  const status = item.in_stock ? 'price unavailable' : 'out of stock';
  return item.last_known_price != null
    ? `${status}, last seen ${money(item.last_known_price)}` : status;
}
