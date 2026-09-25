/**
 * Comparison screen.
 *
 * Two comparisons, because students ask two different questions:
 *
 *  1. "Where should I do this whole shop?"  -> POST /compare/basket (Phase 4,
 *     app/basket.py): the list priced as ONE order at every store, plus the
 *     cheapest plan across up to three stores.
 *  2. "Am I overpaying for this one thing?" -> each item more than one store
 *     sells, priced by POST /true-cost (Member 6).
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * The list itself is device-local (the backend has no shopping-list
 * endpoints). Every price and total on this screen comes from the backend,
 * fetched fresh whenever the list or "Getting it" changes:
 *
 *  - Store totals: items + delivery ONCE per order (the free-delivery
 *    threshold is judged on the whole basket) + the store's own fees + travel
 *    once per trip. A store that lacks an item gets no whole-list total, and
 *    a store that can't serve the student the way they asked (e.g. a shop
 *    that doesn't deliver) is shown separately, never ranked.
 *  - Split plan: the backend tries every set of up to three stores and pays
 *    for each extra delivery or trip, so "split the shop" is only suggested
 *    when it really is cheaper.
 *  - Item by item: each option priced as its OWN order, so these don't add up
 *    to the store totals — the screen says so.
 *
 * Before Phase 4 this screen did the store arithmetic in the browser and
 * could not see store charges or which stores deliver; that code is gone.
 *
 * "Can I afford this today?" is POST /budget-split/check (Member 6), asked
 * about the cheapest whole-list total.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import { basketOffersByProduct, chosenListTotal, itemGroups } from '../lib/search.js';

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

/** "R12,00 delivery · R5,00 fees · R20,00 travel" — only the parts that apply. */
function extrasText(q) {
  return [
    q.delivery > 0 && `${money(q.delivery)} delivery`,
    q.fees > 0 && `${money(q.fees)} fees`,
    q.travel > 0 && `${money(q.travel)} travel`,
  ].filter(Boolean).join(' · ');
}

export default function Compare() {
  const { token } = useAuth();
  const {
    lines, listCount, setQty, removeOffer, clearList, isLocalOnly,
  } = useShopping();
  const { remaining, budget } = useBudget();
  const toast = useToast();
  const navigate = useNavigate();

  // One answer for the whole page, so the store chart and item-by-item never
  // disagree about whether delivery is being paid for.
  const [fulfilment, setFulfilment] = useState('collection');

  const [comparison, setComparison] = useState(null); // null = not loaded yet
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [verdict, setVerdict] = useState(null);
  const [verdictError, setVerdictError] = useState(null);

  const [trueCosts, setTrueCosts] = useState(new Map());
  const [trueCostError, setTrueCostError] = useState(null);

  /* ------------------------------------ the whole list, POST /compare/basket */

  // Products and quantities decide the basket (a quantity can cross a
  // free-delivery threshold), so both are in the key.
  const basketKey = useMemo(() => {
    const qty = new Map();
    for (const l of lines) qty.set(l.product_id, (qty.get(l.product_id) || 0) + l.qty);
    return [...qty].sort((a, b) => a[0] - b[0]).map(([id, q]) => `${id}x${q}`).join(',');
  }, [lines]);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const loadId = useRef(0);

  const loadComparison = useCallback(async () => {
    const id = ++loadId.current;
    if (!token || !basketKey) {
      setComparison(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.compare.basket(token, linesRef.current, { fulfilment });
      if (id === loadId.current) setComparison(result);
    } catch (err) {
      if (id !== loadId.current) return;
      if (err.status === 404) {
        // None of the products is listed anywhere any more — not an outage.
        setComparison({ stores: [], items: [], unavailable: [], best_plan: null, gone: true });
      } else {
        setComparison(null);
        setError(err.message || 'Could not load current prices for your list.');
      }
    } finally {
      if (id === loadId.current) setLoading(false);
    }
  }, [token, basketKey, fulfilment]);

  useEffect(() => { loadComparison(); }, [loadComparison]);

  const pricesReady = comparison !== null && !loading;
  const stores = comparison?.stores || [];
  const usable = stores.filter((q) => q.fulfilment_available);
  const complete = usable.filter((q) => q.full);
  const incomplete = usable.filter((q) => !q.full);
  const cannotServe = stores.filter((q) => !q.fulfilment_available);
  const best = stores.find((q) => q.store_id === comparison?.best_single_store_id) || null;
  const plan = comparison?.best_plan || null;
  const splitPlan = plan && plan.store_count > 1 ? plan : null;

  /* -------------------------------------------- derived from the response */

  const offersByProduct = useMemo(
    () => (comparison && !loading ? basketOffersByProduct(comparison, lines) : null),
    [comparison, loading, lines],
  );
  const groups = useMemo(
    () => (comparison && !loading ? itemGroups(comparison) : []),
    [comparison, loading],
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

  // The cheapest way to buy the whole list: the best plan when there is one
  // (it may be a single store), otherwise the cheapest complete store.
  const cheapestTotal = plan?.total ?? best?.total ?? 0;

  useEffect(() => {
    let cancelled = false;
    setVerdictError(null);
    if (!token || !budget || !(cheapestTotal > 0)) {
      setVerdict(null);
      return undefined;
    }
    api.budgetSplit.check(token, cheapestTotal)
      .then((result) => { if (!cancelled) setVerdict(result); })
      .catch((err) => {
        if (cancelled) return;
        setVerdict(null);
        setVerdictError(err.message || 'Could not check this against your budget.');
      });
    return () => { cancelled = true; };
  }, [token, budget, cheapestTotal]);

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
  const noCompleteStore = pricesReady && usable.length > 0 && complete.length === 0;
  const overBudget = Boolean(budget) && pricesReady && chosen.total > remaining;
  const unavailable = comparison?.unavailable || [];
  const priceInfo = comparison?.prices;
  const travelUnknown = pricesReady && fulfilment === 'collection' && comparison && !comparison.location_known;

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
            <Button size="sm" onClick={loadComparison}>Try again</Button>
          </div>
        </Alert>
      )}

      {priceInfo && priceInfo.listings > 0 && !priceInfo.all_confirmed && (
        <p className="price-note">
          <Badge tone="neutral">Estimate</Badge>{' '}
          {priceInfo.confirmed === 0
            ? 'All of these prices are estimates — none has been confirmed with the store yet. Check the shelf price before you buy.'
            : `${priceInfo.estimates} of ${priceInfo.listings} prices are estimates; the rest were confirmed with the store.`}
        </p>
      )}

      {overBudget && (
        <Alert tone="warning" title="This list is more than you have left">
          Your list as chosen comes to {money(chosen.total)}, but you have {money(remaining)} left
          this period.
          {cheapestTotal > 0 && cheapestTotal < chosen.total
            ? ` Shopping it the cheapest way brings it to ${money(cheapestTotal)}.`
            : ' Remove something or look for cheaper alternatives in Search.'}
        </Alert>
      )}

      {/* ------------------------------------------- store-by-store chart */}
      <Card>
        <h2 className="card__title">Your whole list, by store</h2>
        <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)', maxWidth: '64ch' }}>
          Everything on your list as one order at each store
          {fulfilment === 'delivery' ? ', with one delivery fee per order' : ''} and the
          store&apos;s own fees. Only stores that stock every item get a total.
        </p>
        {travelUnknown && (
          <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)', maxWidth: '64ch' }}>
            Taxi fares aren&apos;t included: UniWallet doesn&apos;t know where you are yet.
            {' '}<Link to="/profile">Add your location</Link> to include them.
          </p>
        )}

        {!pricesReady && !error ? (
          <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }} aria-busy="true">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={34} radius="var(--r-md)" />)}
          </div>
        ) : stores.length === 0 ? (
          !error && (
            <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-4)' }}>
              None of the items on your list are listed by any store right now, so there is
              nothing to compare. They may have been removed since you added them.
            </p>
          )
        ) : (
          <>
            {complete.length > 0 && (
              <div className="stack stack--tight" style={{ marginTop: 'var(--s-5)' }}>
                {complete.map((row, i) => (
                  <div className={i === 0 ? 'cmp-row cmp-row--best' : 'cmp-row'} key={row.store_id}>
                    <div className="cmp-row__name">
                      <span className="cmp-row__dot" style={{ background: colourFor(row.store_id) }} aria-hidden="true" />
                      <span title={row.store_name}>{row.store_name}</span>
                    </div>
                    <div className="cmp-row__bar" aria-hidden="true">
                      <div
                        className="cmp-row__fill"
                        style={{
                          width: `${Math.max(6, (row.total / maxTotal) * 100)}%`,
                          background: i === 0 ? 'var(--c-forest)' : colourFor(row.store_id),
                          opacity: i === 0 ? 1 : 0.5,
                        }}
                      />
                    </div>
                    <div className="cmp-row__val num">
                      {money(row.total)}
                      {extrasText(row) && <span className="cmp-row__sub">incl. {extrasText(row)}</span>}
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
                    <li key={r.store_id}>
                      <span className="cmp-row__dot" style={{ background: colourFor(r.store_id) }} aria-hidden="true" />
                      {r.store_name} — {r.stocked} of {r.stocked + r.missing_count} items
                      {r.missing.length > 0 && ` (no ${r.missing.map((m) => m.product_name).join(', ')})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {cannotServe.length > 0 && (
              <div style={{ marginTop: 'var(--s-5)' }}>
                <p style={{ fontSize: 'var(--t-xs)', fontWeight: 'var(--fw-extra)', color: 'var(--c-muted)' }}>
                  {fulfilment === 'delivery' ? "Don't deliver" : "Can't be collected from"}
                </p>
                <ul className="cmp-missing">
                  {cannotServe.map((r) => (
                    <li key={r.store_id}>
                      <span className="cmp-row__dot" style={{ background: colourFor(r.store_id) }} aria-hidden="true" />
                      {r.store_name}
                      {r.full ? ` — ${money(r.total)} if you ${r.fulfilment === 'collection' ? 'collect it' : 'have it delivered'}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>

      {/* --------------------------------------------------- the verdict */}
      {(best || splitPlan) && (
        <div className="dash-hero">
          <Card tone="forest">
            <p className="dash-label">Cheapest single shop</p>
            <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
              {best ? money(best.total) : '—'}
            </div>
            <p className="dash-sub dash-sub--on-dark">
              {best
                ? `at ${best.store_name}${extrasText(best) ? ` · includes ${extrasText(best)}` : ''}`
                : 'No single store stocks your whole list.'}
            </p>
            {gap > 0 && (
              <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(243,239,226,0.86)' }}>
                {money(gap)} less than {worst.store_name} for exactly the same items.
              </p>
            )}
            {best && (
              <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)', color: 'rgba(243,239,226,0.66)' }}>
                {complete.length} of {usable.length} stores stock your whole list.
              </p>
            )}
          </Card>

          <Card tone="butter">
            <p className="dash-label">Split across stores</p>
            <div className="dash-amount num" style={{ marginTop: 'var(--s-3)' }}>
              {splitPlan ? money(splitPlan.total) : '—'}
            </div>
            <p className="dash-sub dash-sub--on-butter">
              {splitPlan
                ? splitPlan.stores.map((q) => q.store_name).join(' + ')
                : 'buying each item wherever it is cheapest'}
            </p>
            <p style={{ marginTop: 'var(--s-4)', fontSize: 'var(--t-sm)', color: 'rgba(28,28,25,0.75)' }}>
              {splitPlan
                ? (splitPlan.saving_vs_best_single != null && splitPlan.saving_vs_best_single > 0
                  ? `${money(splitPlan.saving_vs_best_single)} less than one stop, after paying for the extra ${fulfilment === 'delivery' ? 'delivery' : 'trip'}.`
                  : `No single store has everything, so this is the cheapest way to get it all${fulfilment === 'delivery' ? ', delivery included' : ''}.`)
                : best
                  ? `One stop at ${best.store_name} is already the cheapest way to buy this list, once the extra ${fulfilment === 'delivery' ? 'delivery' : 'trip'} is paid for.`
                  : 'At least one item is not in stock anywhere, so there is no split-shop figure.'}
            </p>
          </Card>
        </div>
      )}

      {noCompleteStore && !splitPlan && (
        <Alert tone="info" title="No single store stocks everything on your list">
          UniWallet only calls a store cheapest when it has every item, so there is no
          whole-list total yet. Remove the item most stores are missing, or buy it separately.
        </Alert>
      )}

      {pricesReady && unavailable.length > 0 && (
        <Alert tone="warning" title={`${plural(unavailable.length, 'item')} can't be bought right now`}>
          {unavailable.map((u) => u.product_name).join(', ')}
          {unavailable.length === 1 ? ' is' : ' are'} not in stock at any store that can
          {fulfilment === 'delivery' ? ' deliver to you' : ' be collected from'}, so
          {unavailable.length === 1 ? ' it is' : ' they are'} left out of the totals above.
        </Alert>
      )}

      {/* ------------------------------------- can I afford this today? */}
      {budget && (verdict || verdictError) && (
        <AffordabilityCard
          verdict={verdict}
          error={verdictError}
          where={splitPlan ? splitPlan.stores.map((q) => q.store_name).join(' + ') : best?.store_name}
        />
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
              {trueCostError} Showing the shelf price only, without delivery or store fees.
            </p>
          )}
          <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
            {groups.map((g) => {
              const pricedGroup = trueCosts.get(g.product_id);
              // Backend true cost when we have it; otherwise the shelf price
              // for the quantity, labelled as such above.
              const rows = g.offers
                .map((o) => ({ ...o, tc: pricedGroup?.get(o.offer_id) || null }))
                .map((o) => ({ ...o, shown: o.tc ? o.tc.true_cost : o.line_total }))
                .sort((a, b) => a.shown - b.shown);
              const top = rows[rows.length - 1]?.shown || 1;
              const saving = rows.length > 1 ? rows[rows.length - 1].shown - rows[0].shown : 0;
              return (
                <div key={g.product_id}>
                  <div className="row row--between" style={{ marginBottom: 'var(--s-3)' }}>
                    <span style={{ fontWeight: 'var(--fw-extra)', fontSize: 'var(--t-sm)' }}>
                      {g.product_name}{g.qty > 1 ? ` × ${g.qty}` : ''}
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
                        {o.tc && !o.tc.fulfilment_available && (
                          <p className="cmp-row__breakdown">
                            {o.tc.fulfilment === 'collection' ? "Doesn't deliver — priced for collection" : 'Delivery only — priced delivered'}
                          </p>
                        )}
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
function AffordabilityCard({ verdict, error, where }) {
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
      {where && (
        <span style={{ display: 'block', marginTop: 'var(--s-2)', fontSize: 'var(--t-xs)' }}>
          Checked against {money(verdict.amount)} — your whole list at {where}. You have{' '}
          {money(verdict.remaining_today)} left today and {money(verdict.remaining_amount)} this period.
        </span>
      )}
    </Alert>
  );
}
