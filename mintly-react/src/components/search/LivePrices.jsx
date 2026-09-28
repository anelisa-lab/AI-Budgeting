/**
 * Live prices — product cards from GET /live-search, plus Pick n Pay's
 * catalogue matches shown in the same grid.
 *
 * Shown on the Search screen for the word in the search box, above the
 * catalogue results below. The backend asks the stores it has switched on
 * at most once per query every 6 hours, so running this on every search is
 * cheap.
 *
 * Pick n Pay has no live scraper (its robots.txt disallows its search path
 * — see app/scrapers/__init__.py). Its cards here come from the EXISTING
 * catalogue (GET /search?store=Pick n Pay, the same endpoint the results
 * below use) rather than a live fetch, so they can sit in the same grid
 * without a second scraper. Every Pick n Pay card is tagged "Catalogue
 * price, not live" so it's never mistaken for a Checkers/Shoprite one, and
 * "Add to list" for it goes through the ordinary catalogue-offer flow
 * (offer_id), not the live-item one (item_id) — Pick n Pay was never
 * scraped, so it has no items-table row to point at.
 *
 * Live cards are not catalogue offers — no offer_id, no delivery fee, no
 * fees from store_charges. Each card links to the store, and "Add to list"
 * puts the item on the student's list (POST /shopping-list/items {item_id})
 * at today's price, saved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Skeleton } from '../ui/index.js';
import { api } from '../../api/client.js';
import { useShopping } from '../../context/ShoppingContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { money, plural, timeAgo } from '../../lib/format.js';

const FIRST_ROWS = 8;
const STORE_LABELS = { checkers: 'Checkers Sixty60' };

// Not scraped — shown from the catalogue instead. See the module docstring.
const CATALOGUE_ONLY_STORE = 'Pick n Pay';
const CATALOGUE_MATCH_LIMIT = 8;

export default function LivePrices({ token, query }) {
  const term = (query || '').trim();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [catalogueItems, setCatalogueItems] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const controller = useRef(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    setData(null);
    setError(null);
    setCatalogueItems([]);
    setShowAll(false);
    if (!token || term.length < 2) { setLoading(false); return; }

    const ctrl = new AbortController();
    controller.current = ctrl;
    setLoading(true);

    // Independent of each other: Pick n Pay's catalogue lookup failing (or
    // being empty) must never hide genuinely live Checkers/Shoprite results,
    // and vice versa.
    const live = api.search.live(token, term, { signal: ctrl.signal });
    const catalogue = api.search.offers(token, {
      q: term, store: CATALOGUE_ONLY_STORE, availability: 'any', limit: CATALOGUE_MATCH_LIMIT,
    }, { signal: ctrl.signal }).catch(() => null);

    try {
      const result = await live;
      if (!ctrl.signal.aborted) setData(result);
    } catch (err) {
      if (err?.name === 'AbortError' || ctrl.signal.aborted) return;
      setError(err.message || 'Live prices are unavailable right now.');
    }
    const catalogueResult = await catalogue;
    if (!ctrl.signal.aborted && catalogueResult) {
      setCatalogueItems(catalogueResult.results.map(catalogueOfferToCard));
    }
    if (!ctrl.signal.aborted) setLoading(false);
  }, [token, term]);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);

  if (term.length < 2) return null;

  const liveStoreNames = (data?.stores || []).map((s) => STORE_LABELS[s.store] || s.name);
  const title = liveStoreNames.length ? `Live prices · ${liveStoreNames.join(', ')}` : 'Live prices';
  const fetchedAt = data?.stores?.map((s) => s.fetched_at).filter(Boolean).sort()[0];
  const stale = data?.stores?.some((s) => s.source === 'stale');
  // Belt and braces: the backend already filters by store in SQL; this only
  // shows cards from a store the backend says is switched on.
  const activeNames = new Set((data?.stores || []).map((s) => s.name));
  const liveItems = (data?.results || []).filter((item) => activeNames.has(item.store));
  const items = [...liveItems, ...catalogueItems];
  const visible = showAll ? items : items.slice(0, FIRST_ROWS);

  return (
    <Card className="stack live-prices" style={{ marginBottom: 'var(--s-5)' }}>
      <div className="row row--between">
        <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 'var(--t-md)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' }}>
            <span aria-hidden="true">●</span> {title}
          </h2>
          {catalogueItems.length > 0 && (
            <Badge tone="neutral">+ {CATALOGUE_ONLY_STORE} (catalogue, not live)</Badge>
          )}
        </div>
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
          : (data || catalogueItems.length > 0) && items.length > 0
            ? `${plural(items.length, 'product')} for “${term}”`
            : ''}
      </p>

      {loading ? (
        <div className="live-grid" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={250} radius="var(--r-lg)" />)}
        </div>
      ) : error && items.length === 0 ? (
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
          {error && (
            <Alert tone="warning" title="Some live prices are unavailable">
              {error}
            </Alert>
          )}
          {data?.message && <p className="live-prices__empty">{data.message}</p>}
          <ul className="live-grid">
            {visible.map((item) => <LiveCard key={item.id} item={item} />)}
          </ul>
          {items.length > FIRST_ROWS && (
            <Button variant="ghost" block onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${items.length}`}
            </Button>
          )}
          <p className="live-prices__note">
            Live cards are straight from the store&apos;s website; {CATALOGUE_ONLY_STORE} cards are
            from our catalogue, not fetched live. Delivery and store fees aren&apos;t included.
            Items you add keep the price they had when you added them.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * A Pick n Pay catalogue offer (GET /search), reshaped into the same card
 * shape a live item has, so LiveCard can render either without knowing the
 * difference. `source: 'catalogue'` is the one thing that tells them apart.
 */
function catalogueOfferToCard(offer) {
  const inStock = offer.availability_status === 'available';
  // The shelf price, not effective_cost/total_cost — those add the store's
  // delivery fee (e.g. +R45 by default), and this grid's own note says
  // "delivery and store fees aren't included", matching how live cards work.
  const rawPrice = offer.price;
  const buyable = inStock && Number(rawPrice) > 0;
  return {
    id: `catalogue-offer-${offer.offer_id}`,
    offer_id: offer.offer_id,
    name: offer.product_name,
    price: buyable ? Number(rawPrice) : null,
    last_known_price: !buyable && Number(rawPrice) > 0 ? Number(rawPrice) : null,
    image_url: null,               // the catalogue has no product photos — see module docstring
    product_url: offer.product_url || null,
    store: offer.store_name,
    brand: offer.brand,
    on_promotion: false,
    in_stock: inStock,
    buyable,
    source: 'catalogue',
  };
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
        <p className="live-card__store">
          {item.store}{item.source === 'catalogue' && ' · catalogue'}
        </p>
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
 *
 * A live item (item_id) and a Pick n Pay catalogue card (offer_id) go on the
 * SAME shopping list, just through the matching half of useShopping().
 */
function ListButton({ item }) {
  const isCatalogue = item.source === 'catalogue';
  const { liveQtyOf, addLive, setLiveQty, qtyOf, addOffer, setQty } = useShopping();
  const toast = useToast();
  const qty = isCatalogue ? qtyOf(item.offer_id) : liveQtyOf(item.id);
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

  const add = () => (isCatalogue ? addOffer({ offer_id: item.offer_id }, 1) : addLive(item, 1));
  const changeQty = (next) => (isCatalogue ? setQty(item.offer_id, next) : setLiveQty(item.id, next));

  if (!item.buyable) {
    return (
      <div className="live-card__actions">
        <Button size="sm" variant="secondary" block disabled aria-disabled="true">
          {!item.in_stock ? 'Unavailable' : 'No price — can’t add'}
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
          onClick={() => run(add, true)}
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
          onClick={() => run(() => changeQty(qty - 1), false)}
          aria-label={qty === 1 ? `Remove ${item.name} from your list` : `One fewer ${item.name}`}
        >−</Button>
        <span className="num" aria-live="polite" style={{ fontWeight: 'var(--fw-extra)' }}>
          {flash ? <span className="live-card__added" key={flash}>Added ✓ +1</span> : `${qty} on list`}
        </span>
        <Button
          variant="ghost" size="sm" disabled={busy || qty >= 20}
          onClick={() => run(add, true)}
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
