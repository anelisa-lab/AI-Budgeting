/**
 * Search + results screen.
 *
 * Calls GET /search on the backend, which filters, sorts and pages in SQL
 * against product_offers joined to products and stores. Every filter maps to
 * a query parameter search.py declares — the mapping is `buildSearchParams`
 * in lib/search.js, in one place.
 *
 * PHASE 4 — why filtered searches used to come back empty, and what changed
 * ------------------------------------------------------------------------
 *  - Category, brand, colour and size are matched by the backend with ILIKE
 *    and NO wildcards, so free text had to match the catalogue exactly:
 *    "Grocer", "2 kg" or "PnP" returned nothing. Category and store are now
 *    real choices (the store list comes from the live catalogue), and brand,
 *    colour and size suggest — and snap to — the catalogue's own spelling.
 *  - A minimum above the maximum used to reach the backend as a 400 and blank
 *    the page with "Could not search". It is now caught on the field.
 *  - "Total cost: low to high" used to be silently re-ranked. Ranking is now
 *    its own sort, "Best value for me"; every other sort is the backend's
 *    order untouched.
 *  - Results page through the WHOLE result set (offset paging) instead of
 *    stopping at 100.
 *  - "Recommended for you" is hidden while a filter it cannot honour is on
 *    (store, brand, …) instead of showing picks that contradict the results.
 *  - An empty result lists the active filters as one-click removable chips.
 *
 * Filters live in the URL, so a search can be shared and survives a refresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Input, PriceSourceBadge, Select, Skeleton,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useShopping } from '../context/ShoppingContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import { money, plural } from '../lib/format.js';
import {
  CATALOGUE_CATEGORIES, canonicalCategory, categoryIcon, isWithoutListings,
} from '../lib/categories.js';
import {
  AVAILABILITY_OPTIONS, FULFILMENT_OPTIONS, PAGE_SIZE, PENDING_BACKEND_FILTERS, SORT_OPTIONS,
  activeFilterCount, buildSearchParams, canonicalise, describeFilters, filtersFromUrl,
  filtersToUrl, isRankedSort, rank, recommendationsCanHonour, validateFilters,
} from '../lib/search.js';

const TEXT_KEYS = ['q', 'brand', 'colour', 'size', 'minPrice', 'maxPrice'];
const draftFrom = (f) => Object.fromEntries(TEXT_KEYS.map((k) => [k, f[k]]));

export default function Search() {
  const { token, preferences } = useAuth();
  const { dailyAllowance, remaining, budget } = useBudget();
  const { addOffer, qtyOf } = useShopping();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const filters = useMemo(() => filtersFromUrl(params), [params]);
  const filterErrors = useMemo(() => validateFilters(filters), [filters]);
  const filtersValid = Object.keys(filterErrors).length === 0;

  /** Pages as the backend returned them; ranking is applied per page at render. */
  const [pages, setPages] = useState([]);
  const [count, setCount] = useState(0);
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [moreError, setMoreError] = useState(null);

  const [recs, setRecs] = useState(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsError, setRecsError] = useState(null);

  // What the catalogue really contains, for the store list and suggestions.
  const [facets, setFacets] = useState(null);
  const [facetsError, setFacetsError] = useState(false);

  // Filters are folded away on phones so the results are not pushed below a
  // screen-and-a-half of form. Desktop always shows them (CSS).
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Local draft for the typed boxes so typing does not fire a request per
  // keystroke; they commit to the URL on submit or blur.
  const [draft, setDraft] = useState(() => draftFrom(filters));
  useEffect(() => { setDraft(draftFrom(filters)); }, [filters]);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    api.search.catalogueFacets(token)
      .then((f) => { if (!cancelled) { setFacets(f); setFacetsError(false); } })
      .catch(() => { if (!cancelled) setFacetsError(true); });
    return () => { cancelled = true; };
  }, [token]);

  /* ------------------------------------------------------------ fetching */

  // Guards against an older response landing after a newer one and
  // overwriting it — the classic search race.
  const requestId = useRef(0);
  const ranked = isRankedSort(filters.sort);
  const ceiling = Number(filters.maxPrice) || remaining || dailyAllowance || 0;

  /** Rank one page on its own, so loading more never reshuffles what is on screen. */
  const orderPage = useCallback(
    (page) => (ranked ? rank(page, { budget: ceiling, preferences }) : page),
    [ranked, ceiling, preferences],
  );

  const runSearch = useCallback(async () => {
    if (!token) return;
    const id = ++requestId.current;
    setMoreError(null);
    if (!filtersValid) {
      // Nothing to ask the backend: the field error says what to fix.
      setPages([]); setCount(0); setNextOffset(null); setError(null); setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await api.search.offers(token, buildSearchParams(filters, { limit: PAGE_SIZE, offset: 0 }));
      if (id !== requestId.current) return; // a newer search has started
      setPages([page.results]);
      setCount(page.count);
      setNextOffset(page.has_more ? page.offset + page.results.length : null);
    } catch (err) {
      if (id !== requestId.current) return;
      setPages([]);
      setCount(0);
      setNextOffset(null);
      setError(err.message || 'Could not search right now.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [token, filters, filtersValid]);

  useEffect(() => { runSearch(); }, [runSearch]);

  // Each page is ranked on its own, so loading more never reshuffles what is
  // already on screen.
  const offers = useMemo(() => pages.flatMap(orderPage), [pages, orderPage]);

  async function loadMore() {
    if (nextOffset == null || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.search.offers(token, buildSearchParams(filters, { limit: PAGE_SIZE, offset: nextOffset }));
      if (id !== requestId.current) return;
      setPages((list) => {
        const seen = new Set(list.flat().map((o) => o.offer_id));
        return [...list, page.results.filter((o) => !seen.has(o.offer_id))];
      });
      setCount(page.count);
      setNextOffset(page.has_more ? page.offset + page.results.length : null);
    } catch (err) {
      if (id === requestId.current) setMoreError(err.message || 'Could not load more results.');
    } finally {
      if (id === requestId.current) setLoadingMore(false);
    }
  }

  /* ----------------------------------------------------- recommendations */

  const recsAllowed = recommendationsCanHonour(filters);
  const recsId = useRef(0);
  useEffect(() => {
    const query = filters.q.trim();
    const category = filters.category.trim();
    if (!token || (!query && !category) || !recsAllowed || !filtersValid) {
      recsId.current += 1;
      setRecs(null);
      setRecsError(null);
      setRecsLoading(false);
      return;
    }
    const id = ++recsId.current;
    setRecsLoading(true);
    setRecsError(null);
    api.recommendations
      .get(token, {
        query: query || undefined,
        category: category || undefined,
        max_price: Number(filters.maxPrice) || undefined,
        // Priced the same way as the results under them.
        fulfilment: filters.fulfilment,
        essential_only: filters.essentialOnly || undefined,
        limit: 3,
      })
      .then((result) => { if (id === recsId.current) setRecs(result); })
      .catch((err) => {
        if (id !== recsId.current) return;
        setRecs(null);
        setRecsError(err.message || 'Recommendations are unavailable right now.');
      })
      .finally(() => { if (id === recsId.current) setRecsLoading(false); });
  }, [token, filters.q, filters.category, filters.maxPrice, filters.fulfilment,
    filters.essentialOnly, recsAllowed, filtersValid]);

  /* ------------------------------------------------------------- filters */

  function commit(patch) {
    // Anything typed but not yet applied goes along too, so changing the
    // category never throws away a search word still sitting in the box.
    const next = { ...filters, ...draft, ...patch };
    // Snap typed values to the catalogue's own spelling (see canonicalise).
    if (facets) {
      next.brand = canonicalise(next.brand, facets.brands);
      next.colour = canonicalise(next.colour, facets.colours);
      next.size = canonicalise(next.size, facets.sizes);
      next.store = canonicalise(next.store, facets.stores);
    }
    next.category = canonicalCategory(next.category);
    setParams(filtersToUrl(next), { replace: true });
  }

  function clearAll() {
    setParams(new URLSearchParams(), { replace: true });
    setDraft(draftFrom(filtersFromUrl(new URLSearchParams())));
  }

  const activeCount = activeFilterCount(filters);
  const chips = describeFilters(filters);

  const categoryOptions = useMemo(() => {
    const known = CATALOGUE_CATEGORIES.map((c) => ({ value: c.value, label: c.label }));
    const extra = (facets?.categories || [])
      .filter((c) => !known.some((k) => k.value.toLowerCase() === c.toLowerCase()))
      .map((c) => ({ value: c, label: c }));
    const current = filters.category && ![...known, ...extra].some((o) => o.value === filters.category)
      ? [{ value: filters.category, label: filters.category }] : [];
    return [{ value: '', label: 'Any category' }, ...known, ...extra, ...current];
  }, [facets, filters.category]);

  const storeOptions = useMemo(() => {
    const list = facets?.stores || [];
    const current = filters.store && !list.includes(filters.store)
      ? [{ value: filters.store, label: filters.store }] : [];
    return [{ value: '', label: 'Any store' }, ...list.map((s) => ({ value: s, label: s })), ...current];
  }, [facets, filters.store]);

  async function handleAdd(offer) {
    try {
      await addOffer(offer, 1);
      toast.success(`${offer.product_name} (${offer.store_name}) added to your list.`);
    } catch (err) {
      toast.error(err.message || 'Could not add that item.');
    }
  }

  const noListingsCategory = isWithoutListings(filters.category);

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Find it cheaper</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          What are you looking for?
        </h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '58ch' }}>
          Search every listed store at once. Tell UniWallet how you&apos;ll get it: collecting
          shows the shelf price at stores you can walk into, delivered adds each store&apos;s
          delivery fee, so the cheapest result really is cheapest for you.
        </p>
      </div>

      {/* ------------------------------------------------ keyword bar */}
      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => { e.preventDefault(); commit({ q: draft.q }); }}
      >
        <label className="sr-only" htmlFor="q">Search for a product</label>
        <Input
          id="q"
          type="search"
          placeholder="rice, soap, calculator, bread under R20…"
          value={draft.q}
          onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
          autoComplete="off"
        />
        <Button type="submit">Search</Button>
        <Button
          type="button"
          variant="ghost"
          className="search-bar__filters"
          aria-expanded={filtersOpen}
          aria-controls="search-filters"
          onClick={() => setFiltersOpen((o) => !o)}
        >
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
      </form>

      {error && (
        <Alert tone="danger" title="Could not search">
          {error}
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" onClick={runSearch}>Try again</Button>
          </div>
        </Alert>
      )}

      <div className="search-grid">
        {/* ------------------------------------------------ filter rail */}
        <div className={filtersOpen ? 'filters filters--open' : 'filters'} id="search-filters">
          <Card className="stack">
            <div className="row row--between">
              <h2 style={{ fontSize: 'var(--t-md)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' }}>
                Filters
              </h2>
              {activeCount > 0 && (
                <Button variant="quiet" size="sm" onClick={clearAll}>
                  Clear all ({activeCount})
                </Button>
              )}
            </div>

            <form
              onSubmit={(e) => { e.preventDefault(); commit(draft); setFiltersOpen(false); }}
              className="stack"
              noValidate
            >
              <Field id="fulfilment" label="Getting it">
                {({ id }) => (
                  <Select
                    id={id}
                    options={FULFILMENT_OPTIONS}
                    value={filters.fulfilment}
                    onChange={(e) => commit({ fulfilment: e.target.value })}
                  />
                )}
              </Field>

              <Field id="category" label="Category">
                {({ id }) => (
                  <Select
                    id={id}
                    options={categoryOptions}
                    value={filters.category}
                    onChange={(e) => commit({ category: e.target.value })}
                  />
                )}
              </Field>

              <Field
                id="store"
                label="Store"
                hint={facetsError ? 'Could not load the store list — type a store name instead.' : undefined}
              >
                {({ id, describedBy }) => (facetsError ? (
                  <Input
                    id={id}
                    placeholder="Any store"
                    defaultValue={filters.store}
                    key={filters.store}
                    describedBy={describedBy}
                    onBlur={(e) => commit({ store: e.target.value })}
                  />
                ) : (
                  <Select
                    id={id}
                    options={storeOptions}
                    value={filters.store}
                    disabled={!facets}
                    onChange={(e) => commit({ store: e.target.value })}
                  />
                ))}
              </Field>

              <div className="filter-pair">
                <Field id="min" label="Min price" error={filterErrors.minPrice}>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      prefix="R"
                      placeholder="0"
                      value={draft.minPrice}
                      invalid={invalid}
                      describedBy={describedBy}
                      onChange={(e) => setDraft((d) => ({ ...d, minPrice: e.target.value.replace(/[^\d.]/g, '') }))}
                      onBlur={() => commit({ minPrice: draft.minPrice })}
                    />
                  )}
                </Field>
                <Field id="max" label="Max price" error={filterErrors.maxPrice}>
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      inputMode="decimal"
                      prefix="R"
                      placeholder="No limit"
                      value={draft.maxPrice}
                      invalid={invalid}
                      describedBy={describedBy}
                      onChange={(e) => setDraft((d) => ({ ...d, maxPrice: e.target.value.replace(/[^\d.]/g, '') }))}
                      onBlur={() => commit({ maxPrice: draft.maxPrice })}
                    />
                  )}
                </Field>
              </div>
              <p className="field__hint" style={{ marginTop: 'calc(var(--s-3) * -1)' }}>
                {filters.fulfilment === 'delivery' ? 'Price includes delivery.' : 'Shelf price — you are collecting.'}
                {budget ? ` You have ${money(remaining)} left this period.` : ''}
              </p>

              <TextFilter
                id="brand" label="Brand" value={draft.brand}
                suggestions={facets?.brands || []}
                onChange={(value) => setDraft((d) => ({ ...d, brand: value }))}
                onCommit={(value) => commit({ brand: value })}
              />
              <TextFilter
                id="colour" label="Colour" value={draft.colour}
                suggestions={facets?.colours || []}
                onChange={(value) => setDraft((d) => ({ ...d, colour: value }))}
                onCommit={(value) => commit({ colour: value })}
              />
              <TextFilter
                id="size" label="Size / pack" value={draft.size}
                suggestions={facets?.sizes || []}
                onChange={(value) => setDraft((d) => ({ ...d, size: value }))}
                onCommit={(value) => commit({ size: value })}
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

              {/* Typed boxes commit on blur; this applies them all at once
                  (and is what Enter does from any box). */}
              <Button type="submit" variant="secondary" size="sm" block>
                Apply filters
              </Button>
            </form>

            {PENDING_BACKEND_FILTERS.map((f) => (
              <p key={f.id} className="field__hint">
                <strong>{f.label}:</strong> {f.reason}
              </p>
            ))}
          </Card>
        </div>

        {/* --------------------------------------------------- results */}
        <div>
          {recsAllowed ? (
            <Recommendations
              recs={recs}
              loading={recsLoading}
              error={recsError}
              qtyOf={qtyOf}
              onAdd={handleAdd}
              query={filters.q}
              fulfilment={filters.fulfilment}
            />
          ) : (filters.q || filters.category) && (
            <p className="field__hint" style={{ marginBottom: 'var(--s-4)' }}>
              Personal picks are hidden while store, brand or other detailed filters are on.{' '}
              <Link to="/recommendations" state={{ query: filters.q }}>See picks for “{filters.q || filters.category}” →</Link>
            </p>
          )}

          <div className="results-head">
            <p className="results-count" aria-live="polite">
              {loading
                ? 'Searching…'
                : !filtersValid
                  ? 'Fix the highlighted filter to search.'
                  : `${plural(count, 'match', 'matches')}${filters.q ? ` for “${filters.q}”` : ''}`}
            </p>
            <div style={{ minWidth: 220 }}>
              <label className="sr-only" htmlFor="sort">Sort results</label>
              <Select
                id="sort"
                options={SORT_OPTIONS.map(({ value, label }) => ({ value, label }))}
                value={filters.sort}
                onChange={(e) => commit({ sort: e.target.value })}
              />
            </div>
          </div>

          {chips.length > 0 && (
            <div className="chips" style={{ marginBottom: 'var(--s-4)' }} aria-label="Active filters">
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="chip chip--removable"
                  onClick={() => commit(c.reset)}
                  aria-label={`Remove filter ${c.label}`}
                >
                  {c.label} <span aria-hidden="true">✕</span>
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div className="stack stack--tight" aria-busy="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height={104} radius="var(--r-lg)" />
              ))}
            </div>
          ) : !filtersValid ? (
            <Card>
              <EmptyState icon="↕️" title="Check your price range">
                {filterErrors.minPrice || filterErrors.maxPrice}
              </EmptyState>
            </Card>
          ) : error ? null : offers.length === 0 ? (
            <Card>
              <EmptyState
                icon={noListingsCategory ? categoryIcon(filters.category) : '🔍'}
                title={noListingsCategory
                  ? `No ${filters.category} items are listed yet`
                  : 'Nothing matched all of those filters'}
                action={activeCount > 0
                  ? <Button onClick={clearAll}>Clear all filters</Button>
                  : undefined}
              >
                {noListingsCategory
                  ? `${filters.category} is a category you can budget and record spending for, but none of the stores in the catalogue list ${filters.category.toLowerCase()} products yet. `
                  : chips.length > 1
                    ? 'Remove one filter at a time using the chips above to widen the search. '
                    : ''}
                Try a more general word — “soap” rather than a brand — or a higher maximum price.
              </EmptyState>
            </Card>
          ) : (
            <div className="stack stack--tight">
              {offers.map((offer, index) => (
                <ResultRow
                  key={offer.offer_id}
                  offer={offer}
                  best={index === 0 && ranked}
                  fulfilment={filters.fulfilment}
                  qty={qtyOf(offer.offer_id)}
                  onAdd={() => handleAdd(offer)}
                />
              ))}

              {moreError && (
                <Alert tone="danger" title="Could not load more results">{moreError}</Alert>
              )}

              {nextOffset != null && (
                <Button
                  variant="ghost"
                  block
                  loading={loadingMore}
                  onClick={loadMore}
                  style={{ marginTop: 'var(--s-3)' }}
                >
                  {loadingMore ? 'Loading…' : `Show more — ${count - offers.length} left`}
                </Button>
              )}

              <div className="row row--between" style={{ marginTop: 'var(--s-5)' }}>
                <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', maxWidth: '58ch' }}>
                  {ranked
                    ? 'Best value ranks each page on what it costs you, how much of your budget it leaves, '
                      + 'delivery cost, availability and your saved preferences. '
                    : 'Shown in the order you chose. '}
                  Store fees are added on Compare. Prices marked &ldquo;Estimated&rdquo; have not been
                  confirmed with the store yet — always check the shelf.
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

/* ------------------------------------------------------- recommendations */

/**
 * Member 5's recommender, top three. Every pick shows its TRUE cost (item +
 * delivery + store fees) and the backend's plain-English reason.
 */
function Recommendations({ recs, loading, error, qtyOf, onAdd, query, fulfilment }) {
  if (loading && !recs) {
    return <Skeleton height={140} radius="var(--r-lg)" />;
  }
  if (error) {
    return (
      <div style={{ marginBottom: 'var(--s-5)' }}>
        <Alert tone="warning" title="Recommendations unavailable">
          {error} The search results below still work.
        </Alert>
      </div>
    );
  }
  if (!recs) return null;

  const survival = recs.budget.mode === 'survival';
  const closestOnly = recs.results.length > 0 && recs.results.every((r) => !r.matched_query);

  return (
    <Card className="stack" style={{ marginBottom: 'var(--s-5)' }}>
      <div className="row row--between">
        <h2 style={{ fontSize: 'var(--t-md)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' }}>
          <span aria-hidden="true">✦</span> Recommended for you
        </h2>
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          {survival && <Badge tone="danger">Survival mode · essentials only</Badge>}
          <Link to="/recommendations" state={{ query, fulfilment }} style={{ fontSize: 'var(--t-sm)', fontWeight: 'var(--fw-bold)' }}>
            More picks →
          </Link>
        </div>
      </div>

      <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>
        Priced at true cost — the shelf price plus {fulfilment === 'delivery' ? 'delivery' : 'any travel'} and
        the store&apos;s own fees — so a pick can cost a little more here than the same listing
        in the results below.
      </p>
      {survival && recs.budget.message && (
        <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>{recs.budget.message}</p>
      )}
      {closestOnly && (
        <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>
          Nothing is listed under those exact words, so these are the closest matches.
        </p>
      )}

      {recs.results.length === 0 ? (
        <p style={{ fontSize: 'var(--t-sm)', color: 'var(--c-muted)' }}>
          {recs.message || 'No recommendation for this search.'}
        </p>
      ) : (
        <div className="stack stack--tight">
          {recs.results.map((r) => {
            const qty = qtyOf(r.offer_id);
            return (
              <article className={r.rank === 1 ? 'result result--best' : 'result'} key={r.offer_id}>
                <div className="result__icon" aria-hidden="true">{r.rank}</div>
                <div>
                  <h3 className="result__name">{r.product_name}</h3>
                  <p className="result__meta">
                    {[r.brand, r.size, r.store_name, r.distance_km != null ? `${r.distance_km} km` : null]
                      .filter(Boolean).join(' · ')}
                  </p>
                  <div className="result__tags">
                    {r.meets_budget
                      ? <Badge tone="success">Within your budget</Badge>
                      : <Badge tone="danger">Over your remaining budget</Badge>}
                    {r.is_essential && <Badge tone="accent">Essential</Badge>}
                    <PriceSourceBadge offer={r} />
                  </div>
                  <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)' }}>
                    {r.explanation}
                  </p>
                </div>
                <div className="result__right">
                  <div>
                    <div className="result__price num">{money(r.true_cost)}</div>
                    <p className="result__ship">
                      {r.hidden_cost > 0
                        ? `true cost · ${money(r.price)} + ${money(r.hidden_cost)} ${r.fulfilment === 'collection' ? 'fees & travel' : 'delivery & fees'}`
                        : 'true cost · no extra fees'}
                    </p>
                  </div>
                  <Button size="sm" variant={qty > 0 ? 'secondary' : 'primary'} onClick={() => onAdd(r)}>
                    {qty > 0 ? `In list (${qty}) · Add another` : 'Add to list'}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ text filter */

/**
 * A typed filter with suggestions from the WHOLE catalogue (not just the page
 * on screen). What is typed is snapped to the catalogue's spelling on commit.
 */
function TextFilter({ id, label, value, suggestions, onChange, onCommit }) {
  const listId = `${id}-suggestions`;
  return (
    <Field id={id} label={label}>
      {({ id: fieldId, describedBy }) => (
        <>
          <Input
            id={fieldId}
            list={suggestions.length ? listId : undefined}
            placeholder="Any"
            value={value}
            describedBy={describedBy}
            autoComplete="off"
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

function ResultRow({ offer, best, fulfilment, qty, onAdd }) {
  const inStock = offer.availability_status === 'available';
  const delivered = fulfilment === 'delivery';
  const extra = Math.max(0, Number((offer.effective_cost - offer.price).toFixed(2)));
  return (
    <article className={best ? 'result result--best' : 'result'}>
      <div className="result__icon" aria-hidden="true">
        {categoryIcon(offer.category)}
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
          {delivered && (offer.shipping_cost === 0
            ? <Badge tone="success">No delivery fee</Badge>
            : <Badge tone="neutral">+{money(offer.shipping_cost)} delivery</Badge>)}
          {offer.is_essential && <Badge tone="accent">Essential</Badge>}
          <PriceSourceBadge offer={offer} />
          {offer.rating != null && (
            <Badge tone="neutral">
              <span aria-hidden="true">★</span> {offer.rating.toFixed(1)}
              <span className="sr-only"> out of 5</span>
              {offer.rating_count > 0 ? ` (${offer.rating_count})` : ''}
            </Badge>
          )}
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
          <div className="result__price num">{money(offer.effective_cost)}</div>
          <p className="result__ship">
            {extra > 0
              ? `${money(offer.price)} + ${money(extra)} delivery`
              : delivered ? 'listed price, no delivery fee' : 'shelf price · you collect'}
          </p>
        </div>
        <Button
          size="sm"
          variant={qty > 0 ? 'secondary' : 'primary'}
          onClick={onAdd}
          disabled={!inStock}
          aria-label={inStock && qty === 0 ? `Add to list: ${offer.product_name} at ${offer.store_name}` : undefined}
        >
          {!inStock ? 'Unavailable' : qty > 0 ? `In list (${qty}) · Add another` : 'Add to list'}
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
