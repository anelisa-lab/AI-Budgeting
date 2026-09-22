/**
 * Search + results screen.
 *
 * WHAT CHANGED
 * ------------
 * This screen used to filter a bundled 257-row array in the browser. It now
 * calls GET /search on the backend, which does the filtering, sorting and
 * paging in SQL against product_offers joined to products and stores.
 *
 * Consequences worth knowing before you edit this file:
 *
 *  - Every filter here maps to a query parameter search.py actually declares.
 *    The mapping is in lib/search.js `buildSearchParams`, in one place.
 *  - The filters the backend CANNOT do (distance from campus, store rating)
 *    are shown as unavailable rather than quietly dropped, so the gap is
 *    visible. They are specified as backend work in docs/BACKEND_INTEGRATION.md.
 *  - Category / colour / size are free text, because the backend ILIKEs them
 *    and there is no facet endpoint to populate a dropdown from. The datalist
 *    suggestions are built from the results currently on screen and are
 *    labelled as such — they describe this page, not the catalogue.
 *  - GET /search requires a Bearer token, so this screen is correctly behind
 *    <ProtectedRoute>.
 *
 * Filters still live in the URL, so a search can be shared and survives a
 * refresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Input, Select, Skeleton,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useShopping } from '../context/ShoppingContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import { money, plural } from '../lib/format.js';
import {
  AVAILABILITY_OPTIONS, PAGE_SIZE, PENDING_BACKEND_FILTERS,
  SORT_OPTIONS, activeFilterCount, buildSearchParams, filtersFromUrl, filtersToUrl,
  rank, suggestionsFrom,
} from '../lib/search.js';

export default function Search() {
  const { token, preferences } = useAuth();
  const { dailyAllowance, remaining, budget } = useBudget();
  const { addOffer, qtyOf } = useShopping();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const filters = useMemo(() => filtersFromUrl(params), [params]);

  const [offers, setOffers] = useState([]);
  const [count, setCount] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Local draft for the free-text boxes so typing does not fire a request per
  // keystroke; they commit to the URL on submit or blur.
  const [draft, setDraft] = useState({
    q: filters.q, category: filters.category, brand: filters.brand,
    colour: filters.colour, size: filters.size, store: filters.store,
    maxPrice: filters.maxPrice,
  });
  useEffect(() => {
    setDraft({
      q: filters.q, category: filters.category, brand: filters.brand,
      colour: filters.colour, size: filters.size, store: filters.store,
      maxPrice: filters.maxPrice,
    });
  }, [filters]);

  /* ------------------------------------------------------------ fetching */

  // Guards against an older response landing after a newer one and
  // overwriting it — the classic search race.
  const requestId = useRef(0);

  const runSearch = useCallback(async (activeFilters, pageLimit) => {
    if (!token) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const query = buildSearchParams(activeFilters, { limit: pageLimit, offset: 0 });
      const page = await api.search.offers(token, query);
      if (id !== requestId.current) return; // a newer search has started
      setOffers(page.results);
      setCount(page.count);
    } catch (err) {
      if (id !== requestId.current) return;
      setOffers([]);
      setCount(0);
      setError(err.message || 'Could not search right now.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => { setLimit(PAGE_SIZE); }, [params]);
  useEffect(() => { runSearch(filters, limit); }, [runSearch, filters, limit]);

  /* ------------------------------------------------------------- filters */

  function commit(patch) {
    setParams(filtersToUrl({ ...filters, ...patch }), { replace: true });
  }

  function clearAll() {
    setParams(new URLSearchParams(), { replace: true });
    setDraft({ q: '', category: '', brand: '', colour: '', size: '', store: '', maxPrice: '' });
  }

  const activeCount = activeFilterCount(filters);

  /* ------------------------------------------------------------- ranking */

  /**
   * The backend returns the page in its own sort order. `rank` re-orders that
   * page by value, budget fit, delivery cost, availability and the student's
   * stored preferences — it never re-filters, so the count above stays true.
   *
   * Re-ranking only makes sense when the student has not asked for a specific
   * order; if they picked "high to low", respect it.
   */
  const shouldRank = filters.sort === 'price_asc';
  const ceiling = Number(filters.maxPrice) || remaining || dailyAllowance || 0;
  const results = useMemo(
    () => (shouldRank ? rank(offers, { budget: ceiling, preferences }) : offers),
    [shouldRank, offers, ceiling, preferences],
  );

  const categorySuggestions = useMemo(() => suggestionsFrom(offers, 'category'), [offers]);
  const colourSuggestions = useMemo(() => suggestionsFrom(offers, 'colour'), [offers]);
  const sizeSuggestions = useMemo(() => suggestionsFrom(offers, 'size'), [offers]);
  const storeSuggestions = useMemo(() => suggestionsFrom(offers, 'store_name'), [offers]);

  async function handleAdd(offer) {
    try {
      await addOffer(offer, 1);
      toast.success(`${offer.product_name} added to your list.`);
    } catch (err) {
      toast.error(err.message || 'Could not add that item.');
    }
  }

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Find it cheaper</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          What are you looking for?
        </h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '58ch' }}>
          Type what you need and set your ceiling. Every match is priced on total cost —
          the item plus what it costs to get it to you.
        </p>
      </div>

      {error && (
        <Alert tone="danger" title="Could not search">
          {error}
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" onClick={() => runSearch(filters, limit)}>Try again</Button>
          </div>
        </Alert>
      )}

      <div className="search-grid">
        {/* ------------------------------------------------ filter rail */}
        <div className="filters">
          <Card className="stack">
            <div className="row row--between">
              <h2 style={{ fontSize: 'var(--t-md)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' }}>
                Filters
              </h2>
              {activeCount > 0 && (
                <Button variant="quiet" size="sm" onClick={clearAll}>
                  Clear ({activeCount})
                </Button>
              )}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); commit(draft); }} className="stack">
              <Field id="q" label="Search" hint="Matched against product name, brand and category.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="search"
                    placeholder="rice, soap, calculator…"
                    value={draft.q}
                    describedBy={describedBy}
                    onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
                    onBlur={() => commit({ q: draft.q })}
                  />
                )}
              </Field>

              <Field
                id="max"
                label="My budget for this"
                hint={budget
                  ? `You have ${money(remaining)} left this period.`
                  : 'Set a budget to get better suggestions.'}
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    prefix="R"
                    placeholder="No limit"
                    value={draft.maxPrice}
                    describedBy={describedBy}
                    onChange={(e) => setDraft((d) => ({ ...d, maxPrice: e.target.value.replace(/[^\d.]/g, '') }))}
                    onBlur={() => commit({ maxPrice: draft.maxPrice })}
                  />
                )}
              </Field>

              <TextFilter
                id="category" label="Category" value={draft.category}
                suggestions={categorySuggestions}
                onChange={(value) => setDraft((d) => ({ ...d, category: value }))}
                onCommit={(value) => commit({ category: value })}
              />
              <TextFilter
                id="brand" label="Brand" value={draft.brand}
                suggestions={suggestionsFrom(offers, 'brand')}
                onChange={(value) => setDraft((d) => ({ ...d, brand: value }))}
                onCommit={(value) => commit({ brand: value })}
              />
              <TextFilter
                id="colour" label="Colour" value={draft.colour}
                suggestions={colourSuggestions}
                onChange={(value) => setDraft((d) => ({ ...d, colour: value }))}
                onCommit={(value) => commit({ colour: value })}
              />
              <TextFilter
                id="size" label="Size / pack" value={draft.size}
                suggestions={sizeSuggestions}
                onChange={(value) => setDraft((d) => ({ ...d, size: value }))}
                onCommit={(value) => commit({ size: value })}
              />
              <TextFilter
                id="store" label="Store" value={draft.store}
                suggestions={storeSuggestions}
                onChange={(value) => setDraft((d) => ({ ...d, store: value }))}
                onCommit={(value) => commit({ store: value })}
              />

              <Field id="availability" label="Availability">
                {({ id }) => (
                  <Select
                    id={id}
                    options={AVAILABILITY_OPTIONS}
                    value={filters.availability}
                    onChange={(e) => commit({ availability: e.target.value })}
                  />
                )}
              </Field>

              <div className="stack stack--tight">
                <label className="checkbox" htmlFor="freeship">
                  <input
                    id="freeship"
                    type="checkbox"
                    checked={filters.freeShippingOnly}
                    onChange={(e) => commit({ freeShippingOnly: e.target.checked })}
                  />
                  <span>No delivery fee only</span>
                </label>
                <label className="checkbox" htmlFor="essential">
                  <input
                    id="essential"
                    type="checkbox"
                    checked={filters.essentialOnly}
                    onChange={(e) => commit({ essentialOnly: e.target.checked })}
                  />
                  <span>Essentials only</span>
                </label>
              </div>

              {/* Submit exists for keyboard users; blur commits for the rest. */}
              <Button type="submit" variant="secondary" size="sm" block>
                Apply filters
              </Button>
            </form>
          </Card>

          {/* Honest about what the API cannot do yet. */}
          <Card className="stack" style={{ marginTop: 'var(--s-4)' }}>
            <h2 style={{ fontSize: 'var(--t-sm)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' }}>
              Not available yet
            </h2>
            {PENDING_BACKEND_FILTERS.map((f) => (
              <div key={f.id}>
                <p style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-bold)', color: 'var(--c-muted)' }}>
                  {f.label}
                </p>
                <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', marginTop: 'var(--s-1)' }}>
                  {f.reason}
                </p>
              </div>
            ))}
          </Card>
        </div>

        {/* --------------------------------------------------- results */}
        <div>
          <div className="results-head">
            <p className="results-count">
              {loading
                ? 'Searching…'
                : `${plural(count, 'match', 'matches')}${filters.q ? ` for “${filters.q}”` : ''}`}
            </p>
            <div style={{ minWidth: 220 }}>
              <label className="sr-only" htmlFor="sort">Sort results</label>
              <Select
                id="sort"
                options={SORT_OPTIONS}
                value={filters.sort}
                onChange={(e) => commit({ sort: e.target.value })}
              />
            </div>
          </div>

          {loading ? (
            <div className="stack stack--tight">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height={104} radius="var(--r-lg)" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <Card>
              <EmptyState
                icon="🔍"
                title="Nothing matched those filters"
                action={activeCount > 0
                  ? <Button onClick={clearAll}>Clear all filters</Button>
                  : undefined}
              >
                Try raising your budget, searching for a more general word — “soap”
                rather than a brand name — or allowing out-of-stock results.
              </EmptyState>
            </Card>
          ) : (
            <div className="stack stack--tight">
              {results.map((offer, index) => (
                <ResultRow
                  key={offer.offer_id}
                  offer={offer}
                  best={index === 0 && shouldRank}
                  qty={qtyOf(offer.offer_id)}
                  onAdd={() => handleAdd(offer)}
                />
              ))}

              {results.length < count && (
                <Button
                  variant="ghost"
                  block
                  // The backend caps `limit` at 100, so the page grows to that
                  // and no further; beyond it, narrowing the filters is the
                  // honest answer rather than an offset walk that re-ranks
                  // each page against a different set.
                  disabled={limit >= 100}
                  onClick={() => setLimit((n) => Math.min(100, n + PAGE_SIZE))}
                  style={{ marginTop: 'var(--s-3)' }}
                >
                  {limit >= 100
                    ? `Showing the first 100 of ${count} — narrow your filters to see the rest`
                    : `Show more — ${count - results.length} left`}
                </Button>
              )}

              <div className="row row--between" style={{ marginTop: 'var(--s-5)' }}>
                <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', maxWidth: '58ch' }}>
                  {shouldRank
                    ? 'Ranked on total cost, how much of your budget it leaves, delivery cost, '
                      + 'availability and your saved preferences. Prices come from the store '
                      + 'listings — always check the shelf.'
                    : 'Sorted by the backend in the order you chose. Prices come from the store '
                      + 'listings — always check the shelf.'}
                </p>
                <Button variant="ghost" onClick={() => navigate('/compare')}>
                  Compare my list →
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ text filter */

/**
 * A free-text filter with suggestions. The backend matches these with ILIKE,
 * so free text is the honest control — a dropdown would imply a fixed list the
 * API never promised.
 */
function TextFilter({ id, label, value, suggestions, onChange, onCommit }) {
  const listId = `${id}-suggestions`;
  return (
    <Field
      id={id}
      label={label}
      hint={suggestions.length ? 'Suggestions come from the results on screen.' : undefined}
    >
      {({ id: fieldId, describedBy }) => (
        <>
          <Input
            id={fieldId}
            list={suggestions.length ? listId : undefined}
            placeholder="Any"
            value={value}
            describedBy={describedBy}
            onChange={(e) => onChange(e.target.value)}
            onBlur={(e) => onCommit(e.target.value)}
          />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((s) => <option key={s} value={s} />)}
            </datalist>
          )}
        </>
      )}
    </Field>
  );
}

/* ------------------------------------------------------------ result row */

function ResultRow({ offer, best, qty, onAdd }) {
  const inStock = offer.availability_status === 'available';
  return (
    <article className={best ? 'result result--best' : 'result'}>
      <div className="result__icon" aria-hidden="true">
        {offer.is_essential ? '🧺' : '🛍️'}
      </div>

      <div>
        <h3 className="result__name">{offer.product_name}</h3>
        <p className="result__meta">
          {[offer.brand, offer.size, offer.store_name].filter(Boolean).join(' · ')}
        </p>
        <div className="result__tags">
          {best && <Badge tone="brand" icon="★">Best value</Badge>}
          <Badge tone="neutral">
            {offer.store_type === 'physical' ? 'In store'
              : offer.store_type === 'online' ? 'Online only' : 'Store or online'}
          </Badge>
          {offer.shipping_cost === 0
            ? <Badge tone="success">No delivery cost</Badge>
            : <Badge tone="neutral">+{money(offer.shipping_cost)} delivery</Badge>}
          {offer.is_essential && <Badge tone="accent">Essential</Badge>}
          {!inStock && (
            <Badge tone="danger">
              {offer.availability_status === 'out_of_stock' ? 'Out of stock' : 'Stock unknown'}
            </Badge>
          )}
          {offer.colour && offer.colour.toLowerCase() !== 'n/a' && (
            <Badge tone="neutral">{offer.colour}</Badge>
          )}
        </div>
        {offer.why && (
          <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)' }}>
            <span aria-hidden="true">✦</span> {offer.why}
          </p>
        )}
      </div>

      <div className="result__right">
        <div>
          <div className="result__price num">{money(offer.total_cost)}</div>
          <p className="result__ship">
            {offer.shipping_cost > 0
              ? `${money(offer.price)} + ${money(offer.shipping_cost)}`
              : 'total cost'}
          </p>
        </div>
        <Button size="sm" variant={qty > 0 ? 'secondary' : 'primary'} onClick={onAdd}>
          {qty > 0 ? `In list (${qty}) · Add another` : 'Add to list'}
        </Button>
        {offer.product_url && (
          <a
            href={offer.product_url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ fontSize: 'var(--t-xs)' }}
          >
            View at {offer.store_name}
          </a>
        )}
      </div>
    </article>
  );
}
