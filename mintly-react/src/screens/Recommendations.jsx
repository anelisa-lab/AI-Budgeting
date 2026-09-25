/**
 * Recommendations screen — "For you".
 *
 * The backend ranks on true cost, daily allowance, preferences, proximity,
 * rating, and freshness. The screen keeps the natural-language query intact
 * so the server remains the single place that parses recommendation intent.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, EmptyState, Eyebrow, Field, Input, Select, Skeleton,
} from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useBudget } from '../context/BudgetContext.jsx';
import { useShopping } from '../context/ShoppingContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { api } from '../api/client.js';
import { money } from '../lib/format.js';
import { CATALOGUE_CATEGORIES, categoryIcon, isWithoutListings } from '../lib/categories.js';

/**
 * An explicit category is a HARD filter on POST /recommendations, so the
 * options must use the catalogue's category names.
 */
const CATEGORY_OPTIONS = [
  { value: '', label: 'Any category' },
  ...CATALOGUE_CATEGORIES.map(({ value, label }) => ({ value, label })),
];

const FULFILMENT_OPTIONS = [
  { value: 'delivery', label: 'Delivered to me' },
  { value: 'collection', label: "I'll collect it" },
];

export default function Recommendations() {
  const { token } = useAuth();
  const {
    budget, budgetMode, dailyAllowance, remainingToday, loading: budgetLoading, loaded: budgetLoaded,
  } = useBudget();
  const { addOffer, qtyOf } = useShopping();
  const toast = useToast();
  const navigate = useNavigate();

  // Search's "More picks →" hands its query over, so the list continues it.
  const location = useLocation();
  const [query, setQuery] = useState(location.state?.query || '');
  const [fulfilment, setFulfilment] = useState('delivery');
  const [includeUnaffordable, setIncludeUnaffordable] = useState(false);
  const [category, setCategory] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  /** What is in the box; committed to `maxPrice` on blur/submit, not per keystroke. */
  const [maxPriceDraft, setMaxPriceDraft] = useState('');
  const [essentialOnly, setEssentialOnly] = useState(false);
  const [sort, setSort] = useState('recommended');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // A slower, older request must not overwrite the answer to a newer one.
  const requestId = useRef(0);

  const runSearch = useCallback(async (activeQuery) => {
    if (!token) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.recommendations.get(token, {
        query: activeQuery || undefined,
        fulfilment,
        category: category || undefined,
        max_price: maxPrice ? Number(maxPrice) : undefined,
        include_unaffordable: includeUnaffordable,
        limit: 12,
      });
      if (id !== requestId.current) return;
      setResponse(result);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err.message || 'Could not load recommendations right now.');
      setResponse(null);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [token, fulfilment, category, maxPrice, includeUnaffordable]);

  // First load, and again whenever a filter that the BACKEND applies changes
  // (the text query waits for "Find recommendations").
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => { runSearch(queryRef.current); }, [runSearch]);

  function handleSubmit(event) {
    event.preventDefault();
    if (maxPriceDraft !== maxPrice) setMaxPrice(maxPriceDraft); // the effect re-runs
    else runSearch(query);
  }

  /**
   * recommendationFromApi already carries the SearchResultItem fields a list
   * line needs (price, shipping_cost, total_cost), so the offer goes in as-is —
   * the same way Search adds one. Store fees and travel are NOT folded into the
   * line's shipping: Compare works out delivery per store, once.
   */
  async function handleAdd(rec) {
    try {
      await addOffer(rec, 1);
      toast.success(`Added ${rec.product_name} to your list.`);
    } catch (err) {
      toast.error(err.message || 'Could not add that item.');
    }
  }

  const survival = budgetMode === 'survival' || response?.budget?.mode === 'survival';
  const closestOnly = (response?.results || []).length > 0
    && response.results.every((r) => !r.matched_query);

  const results = (response?.results || [])
    .filter((rec) => !essentialOnly || rec.is_essential)
    .slice()
    .sort((a, b) => {
      if (sort === 'true_cost_asc') return a.true_cost - b.true_cost;
      if (sort === 'true_cost_desc') return b.true_cost - a.true_cost;
      if (sort === 'distance') return (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity);
      if (sort === 'rating') return (b.rating ?? -1) - (a.rating ?? -1);
      return a.rank - b.rank;
    });

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Picked for your budget</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          For you
        </h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '58ch' }}>
          Ranked on what actually lands in your basket — price, delivery, how close it
          gets you to overspending today, and how far it is to go get it. Not just the
          cheapest sticker price.
        </p>
      </div>

      {budgetLoaded && !budget && (
        <Alert tone="info" title="Set a budget first">
          Recommendations are scored against your daily allowance — Mintly needs a
          budget to know what that is.
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" onClick={() => navigate('/budget')}>Set my budget</Button>
          </div>
        </Alert>
      )}

      {survival && (
        <Alert tone="warning" title="Survival mode — showing essentials only">
          Your balance is below the survival threshold on this budget. Non-essential
          items are held back until it clears.
        </Alert>
      )}

      {budgetLoading && !budgetLoaded ? (
        <Card tone="tint" flat aria-busy="true">
          <div className="row row--between">
            <div style={{ minWidth: 180 }}>
              <Skeleton height={14} width="9rem" />
              <div style={{ marginTop: 'var(--s-2)' }}><Skeleton height={30} width="7rem" /></div>
            </div>
            <Skeleton height={36} width="16rem" />
          </div>
        </Card>
      ) : budget && (
        <Card tone="tint" flat>
          <div className="row row--between">
            <div>
              <p style={{ fontSize: 'var(--t-sm)', color: 'var(--c-muted)' }}>
                Left to spend today
              </p>
              <p className="num" style={{ fontSize: 'var(--t-xl)', fontWeight: 'var(--fw-extra)' }}>
                {money(remainingToday)}
              </p>
              <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>
                of your {money(dailyAllowance)} daily allowance
              </p>
            </div>
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', maxWidth: '32ch' }}>
              Results are scored against this figure, not just what&apos;s left for the
              whole period — something that fits the month but eats four days of food
              in one go won&apos;t rank well.
            </p>
          </div>
        </Card>
      )}

      <Card>
        <form onSubmit={handleSubmit} className="stack" style={{ gap: 'var(--s-4)' }}>
          <div className="row" style={{ gap: 'var(--s-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="grow" style={{ minWidth: 220 }}>
              <Field id="rec-query" label="What are you after?">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    placeholder="cheap black sneakers under R500 near me size 9"
                    value={query}
                    describedBy={describedBy}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div style={{ minWidth: 180 }}>
              <Field id="rec-fulfilment" label="Getting it">
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    options={FULFILMENT_OPTIONS}
                    value={fulfilment}
                    describedBy={describedBy}
                    onChange={(e) => setFulfilment(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Button type="submit" loading={loading}>
              {loading ? 'Finding…' : 'Find recommendations'}
            </Button>
          </div>

          <div className="row" style={{ gap: 'var(--s-4)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 180 }}>
              <Field id="rec-category" label="Category">
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    options={CATEGORY_OPTIONS}
                    value={category}
                    describedBy={describedBy}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <div style={{ minWidth: 180 }}>
              <Field id="rec-max-price" label="Maximum total price">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    prefix="R"
                    placeholder="No limit"
                    value={maxPriceDraft}
                    describedBy={describedBy}
                    onChange={(e) => setMaxPriceDraft(e.target.value.replace(/[^\d.]/g, ''))}
                    onBlur={() => setMaxPrice(maxPriceDraft)}
                  />
                )}
              </Field>
            </div>
            <div style={{ minWidth: 190 }}>
              <Field id="rec-sort" label="Sort results">
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    describedBy={describedBy}
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    options={[
                      { value: 'recommended', label: 'Recommended order' },
                      { value: 'true_cost_asc', label: 'True cost: low to high' },
                      { value: 'true_cost_desc', label: 'True cost: high to low' },
                      { value: 'distance', label: 'Closest first' },
                      { value: 'rating', label: 'Highest rating first' },
                    ]}
                  />
                )}
              </Field>
            </div>
            <label className="checkbox" htmlFor="rec-essential" style={{ marginBottom: 'var(--s-3)' }}>
              <input
                id="rec-essential"
                type="checkbox"
                checked={essentialOnly}
                onChange={(e) => setEssentialOnly(e.target.checked)}
              />
              <span>Essentials only</span>
            </label>
            <label className="checkbox" htmlFor="rec-unaffordable" style={{ marginBottom: 'var(--s-3)' }}>
              <input
                id="rec-unaffordable"
                type="checkbox"
                checked={includeUnaffordable}
                onChange={(e) => setIncludeUnaffordable(e.target.checked)}
              />
              <span>Include items over my remaining budget</span>
            </label>
          </div>
        </form>
      </Card>

      {error && (
        <Alert tone="danger" title="Could not load recommendations">
          {error}
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" onClick={() => runSearch(query)}>Try again</Button>
          </div>
        </Alert>
      )}

      {closestOnly && !loading && (
        <Alert tone="info" title="No exact match">
          Nothing is listed under those exact words, so these are the closest matches.
        </Alert>
      )}

      {loading ? (
        <div className="stack stack--tight">
          {[0, 1, 2].map((i) => <Skeleton key={i} height={128} radius="var(--r-lg)" />)}
        </div>
      ) : results.length === 0 ? (
        <Card>
          <EmptyState
            icon={isWithoutListings(category) ? categoryIcon(category) : '✨'}
            title={isWithoutListings(category)
              ? `No ${category} items are listed yet`
              : essentialOnly && (response?.results || []).length > 0
                ? 'None of these picks are essentials'
                : 'Nothing ranked yet'}
          >
            {isWithoutListings(category)
              ? `The catalogue does not list ${category.toLowerCase()} products yet. Pick another category or search for something specific.`
              : essentialOnly && (response?.results || []).length > 0
                ? 'Untick “Essentials only” to see these picks, or search for an essential like bread, soap or maize meal.'
                : <>
                  {response?.message ? `${response.message} ` : ''}
                  Try a broader search, or tick &ldquo;Include items over my remaining
                  budget&rdquo; to see more.
                </>}
          </EmptyState>
        </Card>
      ) : (
        <div className="stack stack--tight">
          {results.map((rec) => (
            <RecommendationCard
              key={rec.offer_id}
              rec={{ ...rec, fulfilment }}
              qty={qtyOf(rec.offer_id)}
              onAdd={() => handleAdd(rec)}
            />
          ))}
          <div className="row row--between" style={{ marginTop: 'var(--s-4)' }}>
            <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted-light)', maxWidth: '52ch' }}>
              Want every store and filter? <Link to={`/search${query ? `?q=${encodeURIComponent(query)}` : ''}`}>Search the full catalogue</Link>.
            </p>
            <Button variant="ghost" onClick={() => navigate('/compare')}>
              Compare my list →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecommendationCard({ rec, qty, onAdd }) {
  return (
    <article className="result">
      <div className="result__icon" aria-hidden="true">
        {rec.is_essential ? '🧺' : '✨'}
      </div>

      <div>
        <h3 className="result__name">
          <span className="badge badge--brand" style={{ marginRight: 'var(--s-2)' }}>
            #{rec.rank}
          </span>
          {rec.product_name}
        </h3>
        <p className="result__meta">
          {[rec.brand, rec.size, rec.store_name].filter(Boolean).join(' · ')}
        </p>
        <div className="result__tags">
          {rec.meets_budget
            ? <Badge tone="success">Within your budget</Badge>
            : <Badge tone="danger">Over your remaining budget</Badge>}
          {rec.is_essential && <Badge tone="accent">Essential</Badge>}
          {rec.rating != null && (
            // rating_count 0 means "not recorded", not "no reviews".
            <Badge tone="neutral">
              ★ {rec.rating.toFixed(1)}{rec.rating_count > 0 ? ` (${rec.rating_count})` : ''}
            </Badge>
          )}
          {rec.distance_km != null && (
            <Badge tone="neutral">{rec.distance_km.toFixed(1)} km away</Badge>
          )}
        </div>
        <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)', marginTop: 'var(--s-2)', maxWidth: '52ch' }}>
          <span aria-hidden="true">✦</span> {rec.explanation}
        </p>
      </div>

      <div className="result__right">
        <div>
          <div className="result__price num">{money(rec.true_cost)}</div>
          <p className="result__ship">
            {rec.hidden_cost > 0
              ? `true cost · ${money(rec.price)} + ${money(rec.hidden_cost)} ${rec.fulfilment === 'collection' ? 'fees & travel' : 'delivery & fees'}`
              : 'true cost · no extra fees'}
          </p>
        </div>
        <Button size="sm" variant={qty > 0 ? 'secondary' : 'primary'} onClick={onAdd}>
          {qty > 0 ? `In list (${qty}) · Add another` : 'Add to list'}
        </Button>
      </div>
    </article>
  );
}