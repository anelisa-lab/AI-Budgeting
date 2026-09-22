/**
 * Search parameters, ranking and store comparison.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 * --------------------------------
 * This file used to filter and sort a 257-row array bundled into the app. The
 * backend now does that: GET /search filters on product_offers joined to
 * products and stores, and returns a page at a time with a total `count`.
 * Re-implementing those filters here would be a second, divergent search — the
 * exact problem this alignment pass exists to remove.
 *
 * So the filtering and sorting functions are gone. What is left is:
 *
 *   buildSearchParams()  filters the student set  ->  the backend's own query
 *                        parameter names, and nothing the backend cannot do
 *   rank()               orders ONE page of results the backend returned, using
 *                        the student's budget and their stored preferences
 *   the comparison maths, which now operates on SearchResultItem rows
 *
 * Everything below is a pure function with no React in it, so it can be
 * unit-tested directly — and `rank` is the one function to swap out when a
 * trained recommender replaces the transparent scorer.
 */

/* ------------------------------------------------------------------ sorts */

/**
 * Only what app/routers/search.py actually implements. Its sort_map is:
 *   price_asc  -> o.total_cost ASC     (note: TOTAL cost, not item price)
 *   price_desc -> o.total_cost DESC
 *   newest     -> o.last_checked_at DESC
 *
 * The old UI also offered "closest to campus" and "best rated". The backend
 * returns neither distance nor rating, so offering them would have been a
 * promise the API cannot keep. They are listed in PENDING_BACKEND_FILTERS and
 * shown as unavailable on the Search screen instead of being silently dropped.
 */
export const SORT_OPTIONS = [
  { value: 'price_asc', label: 'Total cost: low to high' },
  { value: 'price_desc', label: 'Total cost: high to low' },
  { value: 'newest', label: 'Most recently checked' },
];

export const AVAILABILITY_OPTIONS = [
  { value: 'available', label: 'In stock only' },
  { value: 'any', label: 'Include out of stock' },
  { value: 'out_of_stock', label: 'Out of stock only' },
];

export const PAGE_SIZE = 20; // backend default; its max is 100

export const DEFAULT_FILTERS = {
  q: '',
  category: '',
  brand: '',
  colour: '',
  size: '',
  store: '',
  maxPrice: '',          // -> max_price, compared against total_cost
  freeShippingOnly: false, // -> max_shipping_cost=0
  essentialOnly: false,   // -> essential_only
  availability: 'available',
  sort: 'price_asc',
};

/**
 * Filters the Search screen shows but cannot apply yet, with the reason.
 * The screen renders these as clearly disabled rather than removing them, so
 * the gap is visible to the team and to a marker instead of being invisible.
 * Each one is specified as a backend request in docs/BACKEND_INTEGRATION.md.
 */
export const PENDING_BACKEND_FILTERS = [
  {
    id: 'radius',
    label: 'Distance from campus',
    reason: 'GET /search returns no store latitude/longitude or distance, so a '
      + 'radius cannot be applied. stores.latitude and stores.longitude exist in '
      + 'the schema but SearchResultItem does not expose them.',
  },
  {
    id: 'rating',
    label: 'Store rating',
    reason: 'There is no rating column on stores, so results cannot be ranked by it.',
  },
];

/* --------------------------------------------------- filters -> query params */

/**
 * Turn the filter state into the query the backend declares.
 *
 * Names on the left are ours, names on the right are search.py's — this is the
 * only place the two vocabularies meet.
 */
export function buildSearchParams(filters = {}, { limit = PAGE_SIZE, offset = 0 } = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const params = {
    q: f.q?.trim() || undefined,
    category: f.category?.trim() || undefined,
    brand: f.brand?.trim() || undefined,
    colour: f.colour?.trim() || undefined,
    size: f.size?.trim() || undefined,
    store: f.store?.trim() || undefined,
    availability: f.availability || 'available',
    sort: SORT_OPTIONS.some((o) => o.value === f.sort) ? f.sort : 'price_asc',
    limit,
    offset,
  };

  // max_price bounds product_offers.total_cost (price + shipping), which is the
  // right ceiling for a student's budget: a cheap item with R99 delivery is not
  // cheap. That was already the rule in docs/SEED_DATA_CONTRACT.md and the
  // backend happens to implement exactly it.
  const max = Number(String(f.maxPrice).replace(/[^\d.]/g, ''));
  if (Number.isFinite(max) && max > 0) params.max_price = max;

  // "No delivery fee" is max_shipping_cost=0 on this backend.
  if (f.freeShippingOnly) params.max_shipping_cost = 0;

  // The backend only adds the clause when the flag is true, so send it only then.
  if (f.essentialOnly) params.essential_only = true;

  return params;
}

/** Read filters out of the URL, so a search can be shared and survives a refresh. */
export function filtersFromUrl(searchParams) {
  const get = (k, fallback = '') => searchParams.get(k) ?? fallback;
  return {
    ...DEFAULT_FILTERS,
    q: get('q'),
    category: get('category'),
    brand: get('brand'),
    colour: get('colour'),
    size: get('size'),
    store: get('store'),
    maxPrice: get('max'),
    freeShippingOnly: searchParams.get('freeship') === '1',
    essentialOnly: searchParams.get('essential') === '1',
    availability: get('availability', 'available'),
    sort: get('sort', 'price_asc'),
  };
}

/** The inverse: filters -> URLSearchParams, omitting anything at its default. */
export function filtersToUrl(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const out = new URLSearchParams();
  const put = (key, value, dflt = '') => {
    if (value !== undefined && value !== null && value !== '' && value !== dflt) {
      out.set(key, String(value));
    }
  };
  put('q', f.q);
  put('category', f.category);
  put('brand', f.brand);
  put('colour', f.colour);
  put('size', f.size);
  put('store', f.store);
  put('max', f.maxPrice);
  if (f.freeShippingOnly) out.set('freeship', '1');
  if (f.essentialOnly) out.set('essential', '1');
  put('availability', f.availability, 'available');
  put('sort', f.sort, 'price_asc');
  return out;
}

/** How many filters the student has actually set — drives the "Clear (n)" button. */
export function activeFilterCount(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return [
    f.q, f.category, f.brand, f.colour, f.size, f.store, f.maxPrice,
    f.freeShippingOnly, f.essentialOnly,
    f.availability !== 'available',
    f.sort !== 'price_asc',
  ].filter(Boolean).length;
}

/* -------------------------------------------------------------- the ranker */

/**
 * The recommendation layer, stated honestly.
 *
 * A transparent weighted score, not a trained model — which is the right thing
 * for a student-facing budgeting tool, because every recommendation can be
 * explained back in one sentence.
 *
 * It scores ONLY on fields GET /search actually returns plus the student's own
 * stored preferences from GET /profile/preferences. The previous version also
 * scored distance and store rating; the backend exposes neither, so scoring
 * them would have meant inventing the data.
 *
 * It re-orders the page the backend returned; it does not re-filter it.
 */
export function rank(offers, { budget = 0, preferences = null } = {}) {
  if (!Array.isArray(offers) || offers.length === 0) return [];

  const costs = offers.map((o) => o.total_cost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const spread = maxCost - minCost || 1;

  const preferredStores = (preferences?.preferred_stores || []).map((s) => String(s).toLowerCase());
  const preferredCategories = (preferences?.preferred_categories || []).map((c) => String(c).toLowerCase());

  return offers
    .map((o) => {
      // 1. Value — cheapest total cost in this result set scores highest.
      const valueScore = 1 - (o.total_cost - minCost) / spread;

      // 2. Budget fit — rewards leaving the most of the period intact.
      //    Anything over the ceiling was filtered out server-side already.
      const budgetScore = budget > 0
        ? Math.max(0, Math.min(1, 1 - o.total_cost / budget))
        : 0.5;

      // 3. Delivery — a zero shipping_cost is money not spent.
      const shippingScore = o.shipping_cost === 0
        ? 1
        : Math.max(0, 1 - o.shipping_cost / Math.max(o.price, 1));

      // 4. Availability — an out-of-stock offer is not a recommendation.
      const availabilityScore = o.availability_status === 'available' ? 1
        : o.availability_status === 'unknown' ? 0.5 : 0;

      // 5. Stated preference — real data from GET /profile/preferences.
      const storeMatch = preferredStores.includes(String(o.store_name).toLowerCase()) ? 1 : 0;
      const categoryMatch = preferredCategories.includes(String(o.category || '').toLowerCase()) ? 1 : 0;
      const preferenceScore = Math.min(1, storeMatch + categoryMatch);

      const score =
        valueScore * 0.40 +
        budgetScore * 0.20 +
        shippingScore * 0.15 +
        availabilityScore * 0.15 +
        preferenceScore * 0.10;

      const reasons = [];
      if (valueScore > 0.85) reasons.push('cheapest total cost in these results');
      if (o.shipping_cost === 0) reasons.push('no delivery cost');
      if (o.is_essential) reasons.push('an essential item');
      if (storeMatch) reasons.push('one of your preferred stores');
      if (categoryMatch) reasons.push('in a category you follow');
      if (o.availability_status !== 'available') reasons.push('check availability before travelling');

      return {
        ...o,
        score: Number(score.toFixed(4)),
        why: reasons.slice(0, 2).join(' · ') || 'good balance of price and delivery cost',
      };
    })
    .sort((a, b) => b.score - a.score);
}

/* ---------------------------------------------------------- comparison maths */

/**
 * Price the whole list at every store that appears in the offers we fetched.
 *
 * `offersByProduct` is a Map<product_id, SearchResultItem[]> built by
 * `api.search.offersForProducts` — real rows from GET /search, not local data.
 *
 * Rules, unchanged from the version the team already agreed:
 *  - a store that does not stock a line is charged that line's cheapest price
 *    anywhere, so totals stay comparable
 *  - but coverage is reported and ranked on FIRST, so a store stocking nothing
 *    cannot show the cheapest total and win
 *  - only a store that covers every line can be called "cheapest single shop"
 *
 * Delivery: the backend carries shipping_cost per OFFER, and there is no
 * order-level delivery rule on `stores`. Charging every line's shipping would
 * bill a student one delivery per item. So a physical store costs nothing to
 * "deliver" (you carry it), and for an online or mixed store we charge the
 * largest single shipping_cost among the lines bought there — the closest
 * honest approximation of one delivery. A real order-level rule belongs in the
 * backend; it is listed in docs/BACKEND_INTEGRATION.md.
 */
export function priceListByStore(lines, offersByProduct) {
  const stores = new Map();
  for (const offers of offersByProduct.values()) {
    for (const o of offers) {
      if (!stores.has(o.store_id)) {
        stores.set(o.store_id, { store_id: o.store_id, store_name: o.store_name, store_type: o.store_type });
      }
    }
  }
  if (stores.size === 0) return [];

  return [...stores.values()]
    .map((store) => {
      let subtotal = 0;
      let stocked = 0;
      let missing = 0;
      let biggestShipping = 0;

      for (const line of lines) {
        const offers = offersByProduct.get(line.product_id) || [];
        if (offers.length === 0) continue;

        const here = offers.find((o) => o.store_id === store.store_id);
        const cheapestAnywhere = offers.reduce(
          (best, o) => (o.price < best.price ? o : best),
          offers[0],
        );

        if (here) {
          stocked += 1;
          subtotal += here.price * line.qty;
          biggestShipping = Math.max(biggestShipping, here.shipping_cost);
        } else {
          missing += 1;
          subtotal += cheapestAnywhere.price * line.qty;
        }
      }

      const delivery = store.store_type === 'physical' ? 0 : biggestShipping;
      const lineCount = stocked + missing;

      return {
        store,
        subtotal: Number(subtotal.toFixed(2)),
        delivery: Number(delivery.toFixed(2)),
        total: Number((subtotal + delivery).toFixed(2)),
        stocked,
        missing,
        coverage: lineCount ? stocked / lineCount : 0,
        full: missing === 0 && lineCount > 0,
      };
    })
    .sort((a, b) => {
      if (a.full !== b.full) return a.full ? -1 : 1;
      if (!a.full && a.coverage !== b.coverage) return b.coverage - a.coverage;
      return a.total - b.total;
    });
}

/**
 * Cheapest achievable total, buying each line wherever it is cheapest.
 * Item prices only — this is the figure for a student walking between shops,
 * not ordering several separate deliveries.
 */
export function splitShopTotal(lines, offersByProduct) {
  let total = 0;
  for (const line of lines) {
    const offers = offersByProduct.get(line.product_id) || [];
    if (offers.length === 0) {
      total += line.price * line.qty; // fall back to the snapshot we stored
      continue;
    }
    const cheapest = offers.reduce((best, o) => (o.price < best.price ? o : best), offers[0]);
    total += cheapest.price * line.qty;
  }
  return Number(total.toFixed(2));
}

/**
 * Per-item head-to-head: the same product at every store that lists it.
 * Only products with more than one offer are worth showing.
 */
export function comparableGroups(lines, offersByProduct) {
  return lines
    .map((line) => {
      const offers = [...(offersByProduct.get(line.product_id) || [])]
        .sort((a, b) => a.total_cost - b.total_cost);
      if (offers.length < 2) return null;
      const cheapest = offers[0];
      const dearest = offers[offers.length - 1];
      return {
        key: String(line.product_id),
        product_id: line.product_id,
        product_name: cheapest.product_name,
        size: cheapest.size,
        category: cheapest.category,
        offers,
        cheapest,
        dearest,
        saving: Number((dearest.total_cost - cheapest.total_cost).toFixed(2)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.saving - a.saving);
}

/**
 * Suggestion values for the free-text filters, taken from the page of results
 * currently on screen.
 *
 * These are a convenience, NOT a facet list: they describe this page, not the
 * whole catalogue. A real facet endpoint is listed as a backend dependency.
 */
export function suggestionsFrom(offers, field) {
  return [...new Set(
    (offers || []).map((o) => o[field]).filter((v) => v && String(v).toLowerCase() !== 'n/a'),
  )].sort();
}
