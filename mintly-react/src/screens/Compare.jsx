/**
 * Comparison screen.
 *
 * Two comparisons, because students ask two different questions:
 *
 *  1. "Where should I do this whole shop?"  -> the list priced at every store
 *     that lists any of the items, cheapest first, plus the split-shop total.
 *  2. "Am I overpaying for this one thing?" -> each item more than one store
 *     sells, with the gap between cheapest and dearest.
 *
 * WHERE THE PRICES COME FROM
 * --------------------------
 * The list itself is device-local (see api/localList.js — the backend has no
 * shopping-list endpoints yet, and the banner below says so). The PRICES are
 * not: every time this screen opens it re-fetches the live offers for each
 * product on the list from GET /search, so a stale snapshot is never what a
 * student is shown a total for.
 *
 * That costs one request per distinct product, because there is no
 * `GET /products/{id}/offers`. It is listed as a backend dependency in
 * docs/BACKEND_INTEGRATION.md, and `api.search.offersForProducts` is the one
 * function that changes when it lands.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, EmptyState, Eyebrow, Progress, Skeleton,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useShopping } from '../context/ShoppingContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import { money, plural } from '../lib/format.js';
import { comparableGroups, priceListByStore, splitShopTotal } from '../lib/search.js';

/**
 * Store ids are integers from the backend, so a colour cannot be keyed off a
 * known slug any more. A fixed palette indexed by id keeps each store the same
 * colour across the two charts on this page, which is all the colour has to do
 * — it never carries meaning on its own.
 */
const PALETTE = [
  '#00A551', '#E4002B', '#004B93', '#006B3F', '#0B4EA2',
  '#00843D', '#00539F', '#6D2E8B', '#00AEEF', '#C8102E',
];
const colourFor = (storeId) => PALETTE[Math.abs(Number(storeId) || 0) % PALETTE.length];

export default function Compare() {
  const { token } = useAuth();
  const { lines, listCount, listTotal, setQty, removeOffer, clearList, isLocalOnly } = useShopping();
  const { remaining, budget } = useBudget();
  const toast = useToast();
  const navigate = useNavigate();

  const [offersByProduct, setOffersByProduct] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /* --------------------------------------------- live prices from /search */

  const loadOffers = useCallback(async () => {
    if (!token || lines.length === 0) {
      setOffersByProduct(new Map());
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setOffersByProduct(await api.search.offersForProducts(token, lines));
    } catch (err) {
      setError(err.message || 'Could not load current prices for your list.');
    } finally {
      setLoading(false);
    }
  }, [token, lines]);

  useEffect(() => { loadOffers(); }, [loadOffers]);

  /* -------------------------------------------------------------- derived */

  const byStore = useMemo(
    () => (lines.length ? priceListByStore(lines, offersByProduct) : []),
    [lines, offersByProduct],
  );

  const split = useMemo(
    () => (lines.length ? splitShopTotal(lines, offersByProduct) : 0),
    [lines, offersByProduct],
  );

  const groups = useMemo(
    () => (lines.length ? comparableGroups(lines, offersByProduct) : []),
    [lines, offersByProduct],
  );

  async function handleClear() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Clear every item from your list?')) return;
    await clearList();
    toast.info('List cleared.');
  }

  /* ---------------------------------------------------------- empty state */

  if (listCount === 0) {
    return (
      <Card>
        <EmptyState
          icon="🧺"
          title="Your list is empty"
          action={<Button size="lg" onClick={() => navigate('/search')}>Search for items</Button>}
        >
          Add a few things from Search and Mintly will price the whole list at every
          store, then tell you where it is cheapest.
        </EmptyState>
      </Card>
    );
  }

  const complete = byStore.filter((r) => r.full);
  const best = complete[0] || byStore[0];
  const worst = complete.length ? complete[complete.length - 1] : byStore[byStore.length - 1];
  const gap = best && worst ? Number((worst.total - best.total).toFixed(2)) : 0;
  const maxTotal = Math.max(...byStore.map((r) => r.total), 1);
  const splitSaving = best ? Number((best.total - split).toFixed(2)) : 0;
  const overBudget = Boolean(budget) && listTotal > remaining;
  const noCompleteStore = byStore.length > 0 && complete.length === 0;

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Same list, every store</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          Where should you shop?
        </h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '58ch' }}>
          {plural(listCount, 'item')} on your list, priced at every store that lists them.
        </p>
      </div>

      {isLocalOnly && (
        <Alert tone="info" title="This list is saved on this device only">
          The backend has no shopping-list endpoints yet, so your list will not follow
          you to another phone or browser. The prices below are live from the API.
        </Alert>
      )}

      {error && (
        <Alert tone="danger" title="Could not load current prices">
          {error}
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" onClick={loadOffers}>Try again</Button>
          </div>
        </Alert>
      )}

      {overBudget && best && (
        <Alert tone="warning" title="This list is more than you have left">
          Your list comes to {money(listTotal)} but you have {money(remaining)} left this
          period. Shopping at {best.store.store_name} brings it to {money(best.total)}.
        </Alert>
      )}

      {noCompleteStore && best && (
        <Alert tone="info" title="No single store stocks everything on your list">
          {best.store.store_name} covers the most — {best.stocked} of{' '}
          {best.stocked + best.missing} items. The totals below price the rest at
          whatever the cheapest store charges, so you can still compare them fairly.
        </Alert>
      )}

      {/* ------------------------------------------- store-by-store chart */}
      <Card>
        <h2 className="card__title">Your whole list, by store</h2>

        {loading && byStore.length === 0 ? (
          <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }}>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={34} radius="var(--r-md)" />)}
          </div>
        ) : byStore.length === 0 ? (
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-4)' }}>
            None of the items on your list are listed by any store right now, so there is
            nothing to compare. They may have been delisted since you added them.
          </p>
        ) : (
          <>
            <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }}>
              {byStore.map((row, i) => (
                <div
                  className={i === 0 && row.full ? 'cmp-row cmp-row--best' : 'cmp-row'}
                  key={row.store.store_id}
                  style={{ opacity: row.full ? 1 : 0.62 }}
                >
                  <div className="cmp-row__name">
                    <span
                      className="cmp-row__dot"
                      style={{ background: colourFor(row.store.store_id) }}
                      aria-hidden="true"
                    />
                    <span title={row.store.store_name}>{row.store.store_name}</span>
                  </div>
                  <div className="cmp-row__bar">
                    <div
                      className="cmp-row__fill"
                      style={{
                        width: `${Math.max(6, (row.total / maxTotal) * 100)}%`,
                        background: i === 0 && row.full
                          ? 'var(--c-forest)'
                          : colourFor(row.store.store_id),
                        opacity: i === 0 && row.full ? 1 : 0.5,
                      }}
                    />
                  </div>
                  <div className="cmp-row__val num">{money(row.total)}</div>
                </div>
              ))}
            </div>

            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', marginTop: 'var(--s-4)' }}>
              Totals are item prices plus one delivery charge where delivery applies —
              not a fee per item. A store you can walk into is priced for collection.
            </p>

            {byStore.some((r) => !r.full) && (
              <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-4)' }}>
                <strong>Faded rows do not stock your whole list.</strong>{' '}
                {byStore.filter((r) => !r.full)
                  .map((r) => `${r.store.store_name} has ${r.stocked} of ${r.stocked + r.missing}`)
                  .join(' · ')}
                . Missing lines are priced at the cheapest store so the totals stay
                comparable, which is why a shop with little of your list can still show a
                low number — it is not a cheaper shop, it is an incomplete one.
              </p>
            )}
          </>
        )}
      </Card>

      {/* --------------------------------------------------- the verdict */}
      {best && (
        <div className="dash-hero">
          <Card tone="forest">
            <p className="dash-label">
              {noCompleteStore ? 'Best single shop' : 'Cheapest single shop'}
            </p>
            <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
              {money(best.total)}
            </div>
            <p className="dash-sub dash-sub--on-dark">
              at {best.store.store_name}
              {noCompleteStore && ` · ${best.stocked} of ${best.stocked + best.missing} items`}
            </p>
            {gap > 0 && !noCompleteStore && (
              <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(243,239,226,0.86)' }}>
                {money(gap)} less than {worst.store.store_name} for exactly the same items.
              </p>
            )}
            {!noCompleteStore && complete.length > 1 && (
              <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)', color: 'rgba(243,239,226,0.66)' }}>
                {complete.length} of {byStore.length} stores stock your whole list.
              </p>
            )}
          </Card>

          <Card tone="butter">
            <p className="dash-label">Split across stores</p>
            <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
              {money(split)}
            </div>
            <p className="dash-sub dash-sub--on-butter">
              buying each item wherever it is cheapest
            </p>
            <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(28,28,25,0.75)' }}>
              {splitSaving > 0.01
                ? `${money(splitSaving)} better than one stop — worth it only if two stores are close together.`
                : `One stop at ${best.store.store_name} is already the cheapest way to buy this list.`}
            </p>
          </Card>
        </div>
      )}

      {/* ------------------------------------------- item-level comparison */}
      {groups.length > 0 && (
        <Card>
          <h2 className="card__title">Item by item</h2>
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)' }}>
            These items on your list are sold by more than one store.
          </p>
          <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
            {groups.map((g) => (
              <div key={g.key}>
                <div className="row row--between" style={{ marginBottom: 'var(--s-3)' }}>
                  <span style={{ fontWeight: 'var(--fw-extra)', fontSize: 'var(--t-sm)' }}>
                    {g.product_name}{g.size ? ` · ${g.size}` : ''}
                  </span>
                  {g.saving > 0 && <Badge tone="accent">Save {money(g.saving)}</Badge>}
                </div>
                <div className="stack stack--tight">
                  {g.offers.map((o, i) => (
                    <div className="cmp-row" key={o.offer_id}>
                      <div className="cmp-row__name">
                        <span
                          className="cmp-row__dot"
                          style={{ background: colourFor(o.store_id) }}
                          aria-hidden="true"
                        />
                        <span title={o.store_name}>{o.store_name}</span>
                      </div>
                      <div className="cmp-row__bar">
                        <div
                          className="cmp-row__fill"
                          style={{
                            width: `${Math.max(8, (o.total_cost / g.dearest.total_cost) * 100)}%`,
                            background: i === 0 ? 'var(--c-forest)' : 'var(--c-coral)',
                            opacity: i === 0 ? 1 : 0.45,
                          }}
                        />
                      </div>
                      <div className="cmp-row__val num">{money(o.total_cost)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* --------------------------------------------------- the list itself */}
      <Card>
        <div className="card__head">
          <h2 className="card__title">Your list</h2>
          <div className="row">
            <Badge tone="neutral">{plural(listCount, 'item')}</Badge>
            <Button variant="quiet" size="sm" onClick={handleClear}>Clear list</Button>
          </div>
        </div>

        <div style={{ marginTop: 'var(--s-4)' }}>
          {lines.map((line) => (
            <div className="basket-line" key={line.offer_id}>
              <span className="txn__icon" aria-hidden="true">
                {line.is_essential ? '🧺' : '🛍️'}
              </span>
              <div className="grow">
                <p className="txn__name">{line.product_name}</p>
                <p className="txn__meta">
                  {[line.size, line.store_name].filter(Boolean).join(' · ')}
                  {line.shipping_cost > 0 && ` · +${money(line.shipping_cost)} delivery`}
                </p>
              </div>
              <div className="row" style={{ gap: 'var(--s-2)', flexWrap: 'nowrap' }}>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setQty(line.offer_id, line.qty - 1)}
                  aria-label={`One fewer ${line.product_name}`}
                >−</Button>
                <span className="num" style={{ minWidth: 20, textAlign: 'center', fontWeight: 'var(--fw-extra)' }}>
                  {line.qty}
                </span>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setQty(line.offer_id, line.qty + 1)}
                  aria-label={`One more ${line.product_name}`}
                >+</Button>
                <span className="num" style={{ minWidth: 76, textAlign: 'right', fontWeight: 'var(--fw-extra)' }}>
                  {money(Number((line.price * line.qty).toFixed(2)))}
                </span>
                <Button
                  variant="quiet" size="sm"
                  onClick={() => removeOffer(line.offer_id)}
                  aria-label={`Remove ${line.product_name}`}
                >✕</Button>
              </div>
            </div>
          ))}
        </div>

        <div
          className="row row--between"
          style={{ marginTop: 'var(--s-5)', paddingTop: 'var(--s-5)', borderTop: '1.5px solid var(--c-line)' }}
        >
          <span style={{ color: 'var(--c-muted)', fontWeight: 'var(--fw-semibold)' }}>
            List total as chosen
          </span>
          <span
            className="num"
            style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-xl)', color: 'var(--c-forest)' }}
          >
            {money(listTotal)}
          </span>
        </div>

        {budget && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            <Progress
              value={remaining > 0 ? Math.min(1, listTotal / remaining) : 1}
              tone={overBudget ? 'danger' : 'brand'}
              label="Share of your remaining budget"
            />
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)' }}>
              {overBudget
                ? `This list is ${money(listTotal - remaining)} more than you have left.`
                : `This would leave you ${money(remaining - listTotal)} for the rest of the period.`}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
