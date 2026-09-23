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
 *
 * PHASE 3 — two backend calls that had no screen until now:
 *
 *  - "Can I afford this today?" is POST /budget-split/check (Member 6). It
 *    answers against the DAILY allowance, not just the balance, and says how
 *    many days of allowance the shop eats — the contract doc names this
 *    screen as where it belongs. It checks the cheapest single-shop total.
 *  - "Item by item" prices each alternative with POST /true-cost (Member 6):
 *    delivery, store charges and travel for that one order, so the cheapest
 *    row is the one that is actually cheapest to get, not just to buy. Those
 *    figures are per product and are never summed into a basket total — the
 *    endpoint prices every offer as its own order.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Progress, Select, Skeleton,
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

  /** POST /budget-split/check verdict for the cheapest single-shop total. */
  const [verdict, setVerdict] = useState(null);
  const [verdictError, setVerdictError] = useState(null);

  /** POST /true-cost per product group: Map<product_id, Map<offer_id, TrueCostOut>>. */
  // One answer for the whole page, so the store chart and item-by-item never
  // disagree about whether delivery is being paid for.
  const [fulfilment, setFulfilment] = useState('collection');
  const [trueCosts, setTrueCosts] = useState(new Map());
  const [trueCostError, setTrueCostError] = useState(null);

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
    () => (lines.length ? priceListByStore(lines, offersByProduct, { fulfilment }) : []),
    [lines, offersByProduct, fulfilment],
  );

  const split = useMemo(
    () => (lines.length ? splitShopTotal(lines, offersByProduct) : 0),
    [lines, offersByProduct],
  );

  const groups = useMemo(
    () => (lines.length ? comparableGroups(lines, offersByProduct) : []),
    [lines, offersByProduct],
  );

  /* ------------------------------------------- true cost, item by item */

  useEffect(() => {
    let cancelled = false;
    if (!token || groups.length === 0) {
      setTrueCosts(new Map());
      return undefined;
    }
    setTrueCostError(null);
    Promise.all(groups.map((g) => api.trueCost
      .compare(token, g.offers.map((o) => o.offer_id), { quantity: g.qty, fulfilment })
      .then((res) => [g.product_id, new Map(res.results.map((r) => [r.offer_id, r]))])))
      .then((entries) => { if (!cancelled) setTrueCosts(new Map(entries)); })
      .catch((err) => {
        if (cancelled) return;
        setTrueCosts(new Map());
        setTrueCostError(err.message || 'True cost is unavailable right now.');
      });
    return () => { cancelled = true; };
  }, [token, groups, fulfilment]);

  /* ------------------------------------------ can I afford this today? */

  const complete = byStore.filter((r) => r.full);
  const best = complete[0] || byStore[0];
  // What the shop really costs: the cheapest single-shop total once prices
  // are in, the list as chosen until then.
  const shopTotal = best ? best.total : listTotal;

  useEffect(() => {
    let cancelled = false;
    setVerdictError(null);
    if (!token || !budget || !(shopTotal > 0)) {
      setVerdict(null);
      return undefined;
    }
    api.budgetSplit.check(token, shopTotal)
      .then((result) => { if (!cancelled) setVerdict(result); })
      .catch((err) => {
        if (cancelled) return;
        setVerdict(null);
        setVerdictError(err.message || 'Could not check this against your budget.');
      });
    return () => { cancelled = true; };
  }, [token, budget, shopTotal]);

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
        <div style={{ maxWidth: 240, marginTop: 'var(--s-4)' }}>
          <Field id="cmp-fulfilment" label="Getting it">
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={fulfilment}
                onChange={(e) => setFulfilment(e.target.value)}
                options={[
                  { value: 'collection', label: "I'll collect it" },
                  { value: 'delivery', label: 'Delivered to me' },
                ]}
              />
            )}
          </Field>
        </div>
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
              {fulfilment === 'collection'
                ? 'Totals are item prices. A store you can walk into is priced for collection; '
                  + 'an online-only store adds one delivery charge — not a fee per item.'
                : 'Totals are item prices plus one delivery charge per store — not a fee per item.'}
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

      {/* ------------------------------------- can I afford this today? */}
      {budget && (verdict || verdictError) && (
        <AffordabilityCard verdict={verdict} error={verdictError} storeName={best?.store.store_name} />
      )}

      {/* ------------------------------------------- item-level comparison */}
      {groups.length > 0 && (
        <Card>
          <h2 className="card__title">Item by item</h2>
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)', maxWidth: '62ch' }}>
            These items on your list are sold by more than one store. Each price is the
            true cost of getting it from that store on its own — item, delivery, store
            charges and travel — worked out by the backend.
          </p>
          {trueCostError && (
            <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-xs)', marginTop: 'var(--s-2)' }}>
              {trueCostError} Showing listed price plus delivery instead.
            </p>
          )}
          <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
            {groups.map((g) => {
              const priced = trueCosts.get(g.product_id);
              // Backend true cost when we have it (cheapest first); listed
              // price + delivery otherwise.
              const rows = g.offers
                .map((o) => ({ ...o, tc: priced?.get(o.offer_id) || null }))
                .map((o) => ({ ...o, shown: o.tc ? o.tc.true_cost : o.total_cost * g.qty }))
                .sort((a, b) => a.shown - b.shown);
              const top = rows[rows.length - 1]?.shown || 1;
              const saving = rows.length > 1 ? rows[rows.length - 1].shown - rows[0].shown : 0;
              return (
              <div key={g.key}>
                <div className="row row--between" style={{ marginBottom: 'var(--s-3)' }}>
                  <span style={{ fontWeight: 'var(--fw-extra)', fontSize: 'var(--t-sm)' }}>
                    {g.product_name}{g.size ? ` · ${g.size}` : ''}{g.qty > 1 ? ` × ${g.qty}` : ''}
                  </span>
                  {saving > 0.005 && <Badge tone="accent">Save {money(saving)}</Badge>}
                </div>
                <div className="stack stack--tight">
                  {rows.map((o, i) => (
                    <div key={o.offer_id}>
                    <div className="cmp-row">
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
                            width: `${Math.max(8, (o.shown / top) * 100)}%`,
                            background: i === 0 ? 'var(--c-forest)' : 'var(--c-coral)',
                            opacity: i === 0 ? 1 : 0.45,
                          }}
                        />
                      </div>
                      <div className="cmp-row__val num">{money(o.shown)}</div>
                    </div>
                    {o.tc && o.tc.hidden_cost > 0 && (
                      <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', marginTop: 2 }}>
                        {money(o.tc.subtotal)} item
                        {o.tc.shipping > 0 && ` + ${money(o.tc.shipping)} delivery`}
                        {o.tc.charges.filter((c) => !c.waived && c.amount > 0)
                          .map((c) => ` + ${money(c.amount)} ${c.label.toLowerCase()}`).join('')}
                        {o.tc.travel_cost > 0 && ` + ${money(o.tc.travel_cost)} travel`}
                      </p>
                    )}
                    </div>
                  ))}
                </div>
              </div>
              );
            })}
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
              <div className="row basket-line__controls" style={{ gap: 'var(--s-2)', flexWrap: 'nowrap' }}>
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

/**
 * POST /budget-split/check, rendered per docs/BUDGET_SPLIT_CONTRACT.md §5:
 *   fits today            -> green
 *   fits the cycle only   -> amber, with how many days of allowance it eats
 *   does not fit at all   -> red, an overspend
 */
function AffordabilityCard({ verdict, error, storeName }) {
  if (error) {
    return (
      <Alert tone="warning" title="Could not check this against your budget">{error}</Alert>
    );
  }
  const tone = verdict.affordable_today ? 'success'
    : verdict.affordable_this_cycle ? 'warning' : 'danger';
  const title = verdict.affordable_today
    ? 'You can afford this shop today'
    : verdict.affordable_this_cycle
      ? `Affordable — but it is ${verdict.days_of_budget ?? '?'} days of allowance`
      : 'This shop is more than you have left';
  return (
    <Alert tone={tone} title={title}>
      {verdict.message}
      {storeName && (
        <span style={{ display: 'block', marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)' }}>
          Checked against {money(verdict.amount)} — your list at {storeName}. You have{' '}
          {money(verdict.remaining_today)} left today and {money(verdict.remaining_amount)} this period.
        </span>
      )}
    </Alert>
  );
}
