/**
 * Comparison screen.
 *
 * Two comparisons, because students ask two different questions:
 *
 *  1. "Where should I do this whole shop?"  -> the list priced at every store
 *     that stocks ALL of it, cheapest first, plus the split-shop total.
 *  2. "Am I overpaying for this one thing?" -> each item more than one store
 *     sells, priced by the backend's true-cost calculator.
 *
 * WHERE THE NUMBERS COME FROM, AND WHY THEY ARE LABELLED THE WAY THEY ARE
 * -----------------------------------------------------------------------
 * The list itself is device-local (the backend has no shopping-list
 * endpoints). The PRICES are live: every time this screen opens, or the set of
 * products on the list changes, it re-fetches each product's offers from
 * GET /search. Nothing is priced from a stale snapshot and no price is made up:
 *
 *  - Whole-list totals are shelf price x quantity + ONE delivery per store,
 *    from in-stock offers only. A store that does not stock every line gets
 *    no total at all.
 *  - "Item by item" is POST /true-cost (Member 6): each option priced as its
 *    own order — item, delivery, the store's own fees and travel.
 *
 * Those are genuinely different questions, so the two figures differ: store
 * fees (e.g. a card surcharge) are charged once per ORDER, and the backend has
 * no endpoint that prices a whole basket as one order. Rather than invent that
 * calculation here, both figures are labelled for what they are and the
 * screen explains the difference. The basket endpoint is listed as a backend
 * dependency in docs/BACKEND_INTEGRATION.md.
 *
 * "Can I afford this today?" is POST /budget-split/check (Member 6), asked
 * about the cheapest complete single-shop total.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { categoryIcon } from '../lib/categories.js';
import {
  chosenListTotal, comparableGroups, priceListByStore, splitShopTotal,
} from '../lib/search.js';

/**
 * Store ids are integers from the backend, so a colour cannot be keyed off a
 * known slug. A fixed palette indexed by id keeps each store the same colour
 * across the two charts on this page — colour never carries meaning alone.
 */
const PALETTE = [
  '#00A551', '#E4002B', '#004B93', '#006B3F', '#0B4EA2',
  '#00843D', '#00539F', '#6D2E8B', '#00AEEF', '#C8102E',
];
const colourFor = (storeId) => PALETTE[Math.abs(Number(storeId) || 0) % PALETTE.length];

export default function Compare() {
  const { token } = useAuth();
  const {
    lines, listCount, setQty, removeOffer, clearList, isLocalOnly,
  } = useShopping();
  const { remaining, budget } = useBudget();
  const toast = useToast();
  const navigate = useNavigate();

  const [offersByProduct, setOffersByProduct] = useState(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [verdict, setVerdict] = useState(null);
  const [verdictError, setVerdictError] = useState(null);

  // One answer for the whole page, so the store chart and item-by-item never
  // disagree about whether delivery is being paid for.
  const [fulfilment, setFulfilment] = useState('collection');
  const [trueCosts, setTrueCosts] = useState(new Map());
  const [trueCostError, setTrueCostError] = useState(null);

  /* --------------------------------------------- live prices from /search */

  // Only the SET of products decides what needs fetching. Changing a quantity
  // used to re-fetch every product's prices (one request each).
  const productKey = useMemo(
    () => [...new Set(lines.map((l) => l.product_id))].sort((a, b) => a - b).join(','),
    [lines],
  );
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const loadId = useRef(0);

  const loadOffers = useCallback(async () => {
    const id = ++loadId.current;
    if (!token || !productKey) {
      setOffersByProduct(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const map = await api.search.offersForProducts(token, linesRef.current);
      if (id === loadId.current) setOffersByProduct(map);
    } catch (err) {
      if (id === loadId.current) setError(err.message || 'Could not load current prices for your list.');
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [token, productKey]);

  useEffect(() => { loadOffers(); }, [loadOffers]);

  const priced = offersByProduct || new Map();
  const pricesReady = offersByProduct !== null && !loading;

  /* -------------------------------------------------------------- derived */

  const byStore = useMemo(
    () => (lines.length && pricesReady ? priceListByStore(lines, priced, { fulfilment }) : []),
    [lines, priced, pricesReady, fulfilment],
  );
  const split = useMemo(
    () => (lines.length && pricesReady ? splitShopTotal(lines, priced) : null),
    [lines, priced, pricesReady],
  );
  const groups = useMemo(
    () => (lines.length && pricesReady ? comparableGroups(lines, priced) : []),
    [lines, priced, pricesReady],
  );
  const chosen = useMemo(
    () => chosenListTotal(lines, offersByProduct || new Map(), { fulfilment }),
    [lines, offersByProduct, fulfilment],
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
  const best = complete[0] || null;
  const shopTotal = best?.total || 0;

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
          Add a few things from Search and UniWallet will price the whole list at every
          store, then tell you where it is cheapest.
        </EmptyState>
      </Card>
    );
  }

  const worst = complete.length ? complete[complete.length - 1] : null;
  const gap = best && worst ? Number((worst.total - best.total).toFixed(2)) : 0;
  const maxTotal = Math.max(...complete.map((r) => r.total), 1);
  const splitSaving = best && split != null ? Number((best.total - split).toFixed(2)) : null;
  const incomplete = byStore.filter((r) => !r.full);
  const noCompleteStore = pricesReady && byStore.length > 0 && complete.length === 0;
  const overBudget = Boolean(budget) && pricesReady && chosen.total > remaining;

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Same list, every store</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          Where should you shop?
        </h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '58ch' }}>
          {plural(listCount, 'item')} on your list, priced at every store that stocks them.
        </p>
        <div style={{ maxWidth: 260, marginTop: 'var(--s-4)' }}>
          <Field id="cmp-fulfilment" label="Getting it" hint="Collecting from a store you can walk into has no delivery fee.">
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
        <Alert tone="info" title="Your list is saved on this device">
          It stays in this browser for your account, so it won&apos;t follow you to another
          phone or computer yet. The prices below are fetched fresh every time you open this page.
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

      {overBudget && (
        <Alert tone="warning" title="This list is more than you have left">
          Your list as chosen comes to {money(chosen.total)}, but you have {money(remaining)} left
          this period.
          {best && best.total < chosen.total
            ? ` Buying it all at ${best.store.store_name} brings it to ${money(best.total)}.`
            : ' Remove something or look for cheaper alternatives in Search.'}
        </Alert>
      )}

      {/* ------------------------------------------- store-by-store chart */}
      <Card>
        <h2 className="card__title">Your whole list, by store</h2>
        <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)', maxWidth: '64ch' }}>
          Shelf prices for everything on your list{fulfilment === 'delivery' ? ' plus one delivery fee per store' : ''}.
          Only stores that stock every item get a total.
        </p>

        {!pricesReady && !error ? (
          <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }} aria-busy="true">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={34} radius="var(--r-md)" />)}
          </div>
        ) : byStore.length === 0 ? (
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-4)' }}>
            None of the items on your list are listed by any store right now, so there is
            nothing to compare. They may have been removed since you added them.
          </p>
        ) : (
          <>
            {complete.length > 0 && (
              <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }}>
                {complete.map((row, i) => (
                  <div className={i === 0 ? 'cmp-row cmp-row--best' : 'cmp-row'} key={row.store.store_id}>
                    <div className="cmp-row__name">
                      <span className="cmp-row__dot" style={{ background: colourFor(row.store.store_id) }} aria-hidden="true" />
                      <span title={row.store.store_name}>{row.store.store_name}</span>
                    </div>
                    <div className="cmp-row__bar" aria-hidden="true">
                      <div
                        className="cmp-row__fill"
                        style={{
                          width: `${Math.max(6, (row.total / maxTotal) * 100)}%`,
                          background: i === 0 ? 'var(--c-forest)' : colourFor(row.store.store_id),
                          opacity: i === 0 ? 1 : 0.5,
                        }}
                      />
                    </div>
                    <div className="cmp-row__val num">
                      {money(row.total)}
                      {row.delivery > 0 && (
                        <span className="cmp-row__sub">incl. {money(row.delivery)} delivery</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {incomplete.length > 0 && (
              <div style={{ marginTop: 'var(--s-5)' }}>
                <p style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-extra)', color: 'var(--c-muted)' }}>
                  Don&apos;t stock your whole list
                </p>
                <ul className="cmp-missing">
                  {incomplete.map((r) => (
                    <li key={r.store.store_id}>
                      <span className="cmp-row__dot" style={{ background: colourFor(r.store.store_id) }} aria-hidden="true" />
                      {r.store.store_name} — {r.stocked} of {r.stocked + r.missing} items
                      {r.outOfStock > 0 && ` (${r.outOfStock} out of stock)`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>

      {/* --------------------------------------------------- the verdict */}
      {best && (
        <div className="dash-hero">
          <Card tone="forest">
            <p className="dash-label">Cheapest single shop</p>
            <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
              {money(best.total)}
            </div>
            <p className="dash-sub dash-sub--on-dark">
              at {best.store.store_name}
              {best.delivery > 0 ? ` · includes ${money(best.delivery)} delivery` : ''}
            </p>
            {gap > 0 && (
              <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(243,239,226,0.86)' }}>
                {money(gap)} less than {worst.store.store_name} for exactly the same items.
              </p>
            )}
            <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)', color: 'rgba(243,239,226,0.66)' }}>
              {complete.length} of {byStore.length} stores stock your whole list.
              {' '}Store fees such as a card surcharge are extra — see Item by item.
            </p>
          </Card>

          <Card tone="butter">
            <p className="dash-label">Split across stores</p>
            <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
              {split != null ? money(split) : '—'}
            </div>
            <p className="dash-sub dash-sub--on-butter">
              shelf prices, buying each item wherever it is cheapest
            </p>
            <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(28,28,25,0.75)' }}>
              {split == null
                ? 'At least one item is not in stock anywhere, so there is no split-shop figure.'
                : splitSaving > 0.01
                  ? `${money(splitSaving)} less than one stop — only worth it if the stores are close together, and before any extra delivery or taxi fares.`
                  : `One stop at ${best.store.store_name} is already the cheapest way to buy this list.`}
            </p>
          </Card>
        </div>
      )}

      {noCompleteStore && (
        <Alert tone="info" title="No single store stocks everything on your list">
          UniWallet only calls a store cheapest when it has every item, so there is no
          whole-list total yet. Remove the item most stores are missing, or buy it separately.
        </Alert>
      )}

      {/* ------------------------------------- can I afford this today? */}
      {budget && (verdict || verdictError) && (
        <AffordabilityCard verdict={verdict} error={verdictError} storeName={best?.store.store_name} />
      )}

      {/* ------------------------------------------- item-level comparison */}
      {groups.length > 0 && (
        <Card>
          <h2 className="card__title">Item by item</h2>
          <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)', maxWidth: '64ch' }}>
            What each item costs if you buy it <strong>on its own</strong> at each store —
            item, {fulfilment === 'delivery' ? 'delivery' : 'travel'} and the store&apos;s own
            fees, worked out by UniWallet&apos;s true-cost calculator. Buying several items in one
            trip shares those fees, so these don&apos;t add up to the whole-list totals above.
          </p>
          {trueCostError && (
            <p style={{ color: 'var(--c-warning)', fontSize: 'var(--t-xs)', marginTop: 'var(--s-2)' }}>
              {trueCostError} Showing the listed price plus delivery instead, without store fees.
            </p>
          )}
          <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
            {groups.map((g) => {
              const pricedGroup = trueCosts.get(g.product_id);
              // Backend true cost when we have it; otherwise the listed price
              // for the quantity plus ONE delivery (delivery is per order).
              const rows = g.offers
                .map((o) => ({ ...o, tc: pricedGroup?.get(o.offer_id) || null }))
                .map((o) => ({
                  ...o,
                  shown: o.tc
                    ? o.tc.true_cost
                    : Number((o.price * g.qty + (fulfilment === 'collection' && o.store_type !== 'online' ? 0 : o.shipping_cost)).toFixed(2)),
                }))
                .sort((a, b) => a.shown - b.shown);
              const top = rows[rows.length - 1]?.shown || 1;
              const saving = rows.length > 1 ? rows[rows.length - 1].shown - rows[0].shown : 0;
              return (
                <div key={g.key}>
                  <div className="row row--between" style={{ marginBottom: 'var(--s-3)' }}>
                    <span style={{ fontWeight: 'var(--fw-extra)', fontSize: 'var(--t-sm)' }}>
                      {g.product_name}{g.size ? ` · ${g.size}` : ''}{g.qty > 1 ? ` × ${g.qty}` : ''}
                    </span>
                    {saving > 0.005 && <Badge tone="accent">Save up to {money(saving)}</Badge>}
                  </div>
                  <div className="stack stack--tight">
                    {rows.map((o, i) => (
                      <div key={o.offer_id}>
                        <div className="cmp-row">
                          <div className="cmp-row__name">
                            <span className="cmp-row__dot" style={{ background: colourFor(o.store_id) }} aria-hidden="true" />
                            <span title={o.store_name}>{o.store_name}</span>
                          </div>
                          <div className="cmp-row__bar" aria-hidden="true">
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
                          <p className="cmp-row__breakdown">
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
          {lines.map((line) => {
            const gone = chosen.unavailable.some((u) => u.offer_id === line.offer_id);
            const price = chosen.livePrice.get(line.offer_id) ?? line.price;
            const changed = pricesReady && !gone && Math.abs(price - line.price) >= 0.005;
            return (
              <div className="basket-line" key={line.offer_id}>
                <span className="txn__icon" aria-hidden="true">{categoryIcon(line.category)}</span>
                <div className="grow">
                  <p className="txn__name">{line.product_name}</p>
                  <p className="txn__meta">
                    {[line.size, line.store_name].filter(Boolean).join(' · ')}
                    {gone && ' · no longer in stock here'}
                    {changed && ` · was ${money(line.price)}`}
                  </p>
                </div>
                <div className="row basket-line__controls" style={{ gap: 'var(--s-2)', flexWrap: 'nowrap' }}>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setQty(line.offer_id, line.qty - 1)}
                    aria-label={line.qty === 1 ? `Remove ${line.product_name}` : `One fewer ${line.product_name}`}
                  >−</Button>
                  <span className="num" style={{ minWidth: 20, textAlign: 'center', fontWeight: 'var(--fw-extra)' }} aria-label={`Quantity ${line.qty}`}>
                    {line.qty}
                  </span>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setQty(line.offer_id, line.qty + 1)}
                    disabled={line.qty >= 20}
                    aria-label={`One more ${line.product_name}`}
                  >+</Button>
                  <span className="num" style={{ minWidth: 76, textAlign: 'right', fontWeight: 'var(--fw-extra)', textDecoration: gone ? 'line-through' : undefined }}>
                    {money(Number((price * line.qty).toFixed(2)))}
                  </span>
                  <Button
                    variant="quiet" size="sm"
                    onClick={() => removeOffer(line.offer_id)}
                    aria-label={`Remove ${line.product_name}`}
                  >✕</Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)', paddingTop: 'var(--s-5)', borderTop: '1.5px solid var(--c-line)' }}>
          <div className="row row--between">
            <span style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)' }}>Items</span>
            <span className="num" style={{ fontWeight: 'var(--fw-bold)' }}>{money(chosen.items)}</span>
          </div>
          <div className="row row--between">
            <span style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)' }}>
              {chosen.delivery > 0
                ? `Delivery${chosen.stores > 1 ? ` (${chosen.stores} stores, one fee per store)` : ''}`
                : fulfilment === 'collection' ? 'Delivery — none, you are collecting' : 'Delivery'}
            </span>
            <span className="num" style={{ fontWeight: 'var(--fw-bold)' }}>
              {chosen.delivery > 0 ? money(chosen.delivery) : 'R0,00'}
            </span>
          </div>
          <div className="row row--between">
            <span style={{ color: 'var(--c-muted)', fontWeight: 'var(--fw-semibold)' }}>
              Your list as chosen
            </span>
            <span className="num" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-xl)', color: 'var(--c-forest)' }}>
              {money(chosen.total)}
            </span>
          </div>
          {chosen.unavailable.length > 0 && (
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-warning)' }}>
              {plural(chosen.unavailable.length, 'item')} left out because the store you picked no
              longer has it in stock. Search for it again to pick another store.
            </p>
          )}
        </div>

        {budget && pricesReady && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            <Progress
              value={remaining > 0 ? Math.min(1, chosen.total / remaining) : 1}
              tone={overBudget ? 'danger' : 'brand'}
              label="Share of your remaining budget"
            />
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)' }}>
              {overBudget
                ? `This list is ${money(chosen.total - remaining)} more than you have left.`
                : `This would leave you ${money(remaining - chosen.total)} for the rest of the period.`}
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
      ? (verdict.days_of_budget != null
        ? `Affordable — but it uses ${verdict.days_of_budget} days of allowance`
        : 'Affordable this period, but not within today\'s allowance')
      : 'This shop is more than you have left';
  return (
    <Alert tone={tone} title={title}>
      {verdict.message}
      {storeName && (
        <span style={{ display: 'block', marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)' }}>
          Checked against {money(verdict.amount)} — your whole list at {storeName}. You have{' '}
          {money(verdict.remaining_today)} left today and {money(verdict.remaining_amount)} this period.
        </span>
      )}
    </Alert>
  );
}
