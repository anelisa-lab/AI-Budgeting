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
 * What the student can pick, and what the backend is actually asked for.
 *
 * app/routers/search.py implements four sorts:
 *   price_asc   -> o.total_cost ASC     (TOTAL cost, not item price)
 *   price_desc  -> o.total_cost DESC
 *   newest      -> o.last_checked_at DESC
 *   rating_desc -> o.rating DESC
 *
 * "Best value for me" is the app's own transparent ranker (rank() below)
 * applied on top of the backend's cheapest-first order. Before Phase 4 that
 * re-ranking was silently applied to "Total cost: low to high", so the list
 * the student saw under that label was NOT low to high. The two are now
 * separate choices: picking "low to high" gets exactly the backend's order.
 */
export const SORT_OPTIONS = [
  { value: 'best', label: 'Best value for me', backend: 'price_asc', ranked: true },
  { value: 'price_asc', label: 'Total cost: low to high', backend: 'price_asc' },
  { value: 'price_desc', label: 'Total cost: high to low', backend: 'price_desc' },
  { value: 'rating_desc', label: 'Best rated', backend: 'rating_desc' },
  { value: 'newest', label: 'Most recently checked', backend: 'newest' },
];

export const DEFAULT_SORT = 'best';

/** The backend sort key for a UI sort value (unknown values fall back safely). */
export function backendSort(value) {
  return (SORT_OPTIONS.find((o) => o.value === value) || SORT_OPTIONS[0]).backend;
}

/** True when the UI sort re-orders results with rank(). */
export function isRankedSort(value) {
  return Boolean((SORT_OPTIONS.find((o) => o.value === value) || SORT_OPTIONS[0]).ranked);
}

export const AVAILABILITY_OPTIONS = [
  { value: 'available', label: 'In stock only' },
  { value: 'any', label: 'Include out of stock' },
  { value: 'out_of_stock', label: 'Out of stock only' },
];

/**
 * How the student gets it (Phase 4, GET /search?fulfilment=). Collecting is
 * priced on the shelf price and only lists stores you can walk into;
 * delivered is price + delivery and only lists stores that deliver. Search,
 * For you and Compare all start on "I'll collect it".
 */
export const FULFILMENT_OPTIONS = [
  { value: 'collection', label: "I'll collect it" },
  { value: 'delivery', label: 'Delivered to me' },
];
export const DEFAULT_FULFILMENT = 'collection';
const validFulfilment = (v) => (FULFILMENT_OPTIONS.some((o) => o.value === v) ? v : DEFAULT_FULFILMENT);

export const PAGE_SIZE = 20; // backend default; its max is 100

export const DEFAULT_FILTERS = {
  q: '',
  category: '',
  brand: '',
  colour: '',
  size: '',
  store: '',
  minPrice: '',          // -> min_price, compared against the effective cost
  maxPrice: '',          // -> max_price, compared against the effective cost
  fulfilment: DEFAULT_FULFILMENT, // -> fulfilment
  freeShippingOnly: false, // -> max_shipping_cost=0
  essentialOnly: false,   // -> essential_only
  availability: 'available',
  sort: DEFAULT_SORT,
};

/**
 * Filters the Search screen shows but cannot apply yet, with the reason in
 * words a student understands. The technical detail is in
 * docs/BACKEND_INTEGRATION.md.
 */
export const PENDING_BACKEND_FILTERS = [
  {
    id: 'radius',
    label: 'Distance from campus',
    reason: 'Coming soon. Search does not know where stores are relative to you yet, '
      + 'so it cannot filter by distance.',
  },
];

/* --------------------------------------------------------- input handling */

/** A money box's text as a number, or null when blank/invalid. */
export function parseMoney(value) {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number(text.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Checks the backend would otherwise answer with a 400 (search.py rejects
 * min_price > max_price). Caught here so the student sees it on the field,
 * not as "Could not search".
 */
export function validateFilters(filters = {}) {
  const errors = {};
  const min = parseMoney(filters.minPrice);
  const max = parseMoney(filters.maxPrice);
  if (String(filters.minPrice ?? '').trim() !== '' && min === null) errors.minPrice = 'Enter an amount in rand, like 50.';
  if (String(filters.maxPrice ?? '').trim() !== '' && max === null) errors.maxPrice = 'Enter an amount in rand, like 200.';
  if (min !== null && max !== null && max > 0 && min > max) {
    errors.minPrice = `The minimum (R${min}) is more than your maximum (R${max}).`;
  }
  return errors;
}

/**
 * The backend matches brand, colour, size and category with ILIKE and NO
 * wildcards — "tastic" finds "Tastic", but "2 kg" does not find "2kg".
 * When what was typed matches a value the catalogue really uses (ignoring
 * case and spaces), send the catalogue's own spelling.
 */
export function canonicalise(value, options = []) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const squash = (x) => String(x).toLowerCase().replace(/\s+/g, '');
  const hit = options.find((o) => squash(o) === squash(text));
  return hit || text;
}

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
    availability: AVAILABILITY_OPTIONS.some((o) => o.value === f.availability) ? f.availability : 'available',
    fulfilment: validFulfilment(f.fulfilment),
    sort: backendSort(f.sort),
    limit,
    offset,
  };

  const min = parseMoney(f.minPrice);
  if (min !== null && min > 0) params.min_price = min;

  // With ?fulfilment= the backend bounds the EFFECTIVE cost: the shelf price
  // when collecting, price + delivery when delivered — what the student pays.
  const max = parseMoney(f.maxPrice);
  if (max !== null && max > 0) params.max_price = max;

  // "No delivery fee" is max_shipping_cost=0 on this backend.
  if (f.freeShippingOnly) params.max_shipping_cost = 0;

  // The backend only adds the clause when the flag is true, so send it only then.
  if (f.essentialOnly) params.essential_only = true;

  return params;
}

/** Read filters out of the URL, so a search can be shared and survives a refresh. */
export function filtersFromUrl(searchParams) {
  const get = (k, fallback = '') => searchParams.get(k) ?? fallback;
  const sort = get('sort', DEFAULT_SORT);
  return {
    ...DEFAULT_FILTERS,
    q: get('q'),
    category: get('category'),
    brand: get('brand'),
    colour: get('colour'),
    size: get('size'),
    store: get('store'),
    minPrice: get('min'),
    maxPrice: get('max'),
    freeShippingOnly: searchParams.get('freeship') === '1',
    essentialOnly: searchParams.get('essential') === '1',
    fulfilment: validFulfilment(searchParams.get('get')),
    availability: get('availability', 'available'),
    sort: SORT_OPTIONS.some((o) => o.value === sort) ? sort : DEFAULT_SORT,
  };
}

/** The inverse: filters -> URLSearchParams, omitting anything at its default. */
export function filtersToUrl(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const out = new URLSearchParams();
  const put = (key, value, dflt = '') => {
    const v = typeof value === 'string' ? value.trim() : value;
    if (v !== undefined && v !== null && v !== '' && v !== dflt) {
      out.set(key, String(v));
    }
  };
  put('q', f.q);
  put('category', f.category);
  put('brand', f.brand);
  put('colour', f.colour);
  put('size', f.size);
  put('store', f.store);
  put('min', f.minPrice);
  put('max', f.maxPrice);
  if (f.freeShippingOnly) out.set('freeship', '1');
  if (f.essentialOnly) out.set('essential', '1');
  put('get', f.fulfilment, DEFAULT_FULFILMENT);
  put('availability', f.availability, 'available');
  put('sort', f.sort, DEFAULT_SORT);
  return out;
}

/** How many filters the student has actually set — drives the "Clear (n)" button. */
export function activeFilterCount(filters) {
  return describeFilters(filters).length;
}

/**
 * Every active filter as a removable chip: { key, label, reset }.
 * `reset` is the patch that switches that one filter off again.
 */
export function describeFilters(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const out = [];
  const text = (key, label) => {
    if (String(f[key] || '').trim()) out.push({ key, label: `${label}: ${f[key]}`, reset: { [key]: '' } });
  };
  if (String(f.q || '').trim()) out.push({ key: 'q', label: `“${f.q}”`, reset: { q: '' } });
  text('category', 'Category');
  text('brand', 'Brand');
  text('colour', 'Colour');
  text('size', 'Size');
  text('store', 'Store');
  if (String(f.minPrice || '').trim()) out.push({ key: 'minPrice', label: `From R${f.minPrice}`, reset: { minPrice: '' } });
  if (String(f.maxPrice || '').trim()) out.push({ key: 'maxPrice', label: `Up to R${f.maxPrice}`, reset: { maxPrice: '' } });
  if (validFulfilment(f.fulfilment) !== DEFAULT_FULFILMENT) {
    out.push({ key: 'fulfilment', label: 'Delivered to me', reset: { fulfilment: DEFAULT_FULFILMENT } });
  }
  if (f.freeShippingOnly) out.push({ key: 'freeShippingOnly', label: 'No delivery fee', reset: { freeShippingOnly: false } });
  if (f.essentialOnly) out.push({ key: 'essentialOnly', label: 'Essentials only', reset: { essentialOnly: false } });
  if (f.availability !== 'available') {
    const label = AVAILABILITY_OPTIONS.find((o) => o.value === f.availability)?.label || f.availability;
    out.push({ key: 'availability', label, reset: { availability: 'available' } });
  }
  if (f.sort !== DEFAULT_SORT) {
    const label = SORT_OPTIONS.find((o) => o.value === f.sort)?.label || f.sort;
    out.push({ key: 'sort', label: `Sort: ${label}`, reset: { sort: DEFAULT_SORT } });
  }
  return out;
}

/**
 * The filters POST /recommendations can honour: a query, a category, a price
 * ceiling, how the student gets it and essentials only. With any OTHER filter
 * on, the "Recommended for you" picks
 * would ignore it (e.g. show Checkers while the student filtered to Shoprite),
 * so Search hides them rather than contradict the results under them.
 */
export function recommendationsCanHonour(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return !(
    String(f.brand || '').trim() || String(f.colour || '').trim() || String(f.size || '').trim()
    || String(f.store || '').trim() || String(f.minPrice || '').trim()
    || f.freeShippingOnly || f.availability !== 'available'
  );
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
 * stored preferences from GET /profile/preferences. Rating is available from
 * the backend for display/sorting, but this transparent ranker does not invent
 * an additional rating weight.
 *
 * It re-orders the page the backend returned; it does not re-filter it.
 */
export function rank(offers, { budget = 0, preferences = null } = {}) {
  if (!Array.isArray(offers) || offers.length === 0) return [];

  // effective_cost is what the student pays the way they are getting it
  // (shelf price when collecting); older responses only have total_cost.
  const costOf = (o) => o.effective_cost ?? o.total_cost;
  const costs = offers.map(costOf);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const spread = maxCost - minCost || 1;

  const preferredStores = (preferences?.preferred_stores || []).map((s) => String(s).toLowerCase());
  const preferredCategories = (preferences?.preferred_categories || []).map((c) => String(c).toLowerCase());

  return offers
    .map((o) => {
      // 1. Value — cheapest total cost in this result set scores highest.
      const cost = costOf(o);
      const valueScore = 1 - (cost - minCost) / spread;

      // 2. Budget fit — rewards leaving the most of the period intact.
      //    Anything over the ceiling was filtered out server-side already.
      const budgetScore = budget > 0
        ? Math.max(0, Math.min(1, 1 - cost / budget))
        : 0.5;

      // 3. Delivery — what is paid on top of the shelf price. Collecting from
      //    a store you walk into pays none, whatever its delivery fee is.
      const extra = Math.max(0, cost - o.price);
      const shippingScore = extra === 0 ? 1 : Math.max(0, 1 - extra / Math.max(o.price, 1));

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
      if (extra === 0) reasons.push('no delivery cost');
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

/** Only an offer the backend says is in stock can be bought today. */
export const isBuyable = (o) => o && o.availability_status === 'available';

/**
 * Delivery for ONE order at a store, from the offers bought there.
 *
 * Used only for "your list as chosen" (each line at the store the student
 * picked it from). The store totals come from POST /compare/basket, which
 * knows each store's real delivery rule; here the closest honest reading of
 * "one delivery" is the largest shipping_cost among the lines bought there.
 * Collecting from any store you can walk into costs no delivery; an
 * online-only store always delivers.
 */
export function orderDelivery(offers, storeType, fulfilment) {
  if (fulfilment === 'collection' && storeType !== 'online') return 0;
  return offers.reduce((max, o) => Math.max(max, Number(o.shipping_cost) || 0), 0);
}

/**
 * The list exactly as the student built it: each line at the store they
 * picked it from, at TODAY's price, plus one delivery per store they would
 * order from. Lines whose store no longer lists them in stock are reported in
 * `unavailable` and left out of the total rather than priced from a stale
 * snapshot.
 */
export function chosenListTotal(lines, offersByProduct, { fulfilment = 'collection' } = {}) {
  const byStore = new Map();
  let items = 0;
  const unavailable = [];
  const livePrice = new Map();
  for (const line of lines) {
    const offers = offersByProduct.get(line.product_id);
    const live = offers ? offers.find((o) => o.offer_id === line.offer_id) : null;
    // Before live prices arrive, fall back to the saved snapshot.
    const offer = offers ? live : line;
    if (offers && !isBuyable(live)) {
      unavailable.push(line);
      continue;
    }
    livePrice.set(line.offer_id, offer.price);
    items += offer.price * line.qty;
    const entry = byStore.get(line.store_id) || { store_type: line.store_type, offers: [] };
    entry.offers.push(offer);
    byStore.set(line.store_id, entry);
  }
  let delivery = 0;
  for (const { store_type: storeType, offers } of byStore.values()) {
    delivery += orderDelivery(offers, storeType, fulfilment);
  }
  return {
    items: Number(items.toFixed(2)),
    delivery: Number(delivery.toFixed(2)),
    total: Number((items + delivery).toFixed(2)),
    stores: byStore.size,
    unavailable,
    livePrice,
  };
}

/**
 * Adapt a POST /compare/basket response (api/normalise.js
 * basketComparisonFromApi) to the Map<product_id, offer[]> shape
 * chosenListTotal reads. The response carries every listing of every product
 * on the list, with today's price and stock; the shipping_cost of the listing
 * the student picked comes from the saved line, since the basket response
 * prices delivery per ORDER rather than per listing.
 */
export function basketOffersByProduct(comparison, lines = []) {
  const map = new Map();
  if (!comparison) return map;
  const saved = new Map(lines.map((l) => [l.offer_id, l]));
  const storeType = new Map((comparison.stores || []).map((q) => [q.store_id, q.store_type]));
  for (const item of comparison.items || []) {
    map.set(item.product_id, item.offers.map((o) => ({
      offer_id: o.offer_id,
      product_id: item.product_id,
      store_id: o.store_id,
      store_name: o.store_name,
      store_type: storeType.get(o.store_id) ?? saved.get(o.offer_id)?.store_type ?? 'physical',
      price: o.price,
      shipping_cost: saved.get(o.offer_id)?.shipping_cost ?? 0,
      availability_status: o.in_stock ? 'available' : 'out_of_stock',
    })));
  }
  return map;
}

/**
 * Per-item head-to-head from a /compare/basket response: the same product at
 * every store that has it in stock. Only products with more than one such
 * listing are worth showing; the biggest price spread comes first.
 */
export function itemGroups(comparison) {
  return (comparison?.items || [])
    .map((item) => {
      const offers = item.offers.filter((o) => o.in_stock);
      if (offers.length < 2) return null;
      const totals = offers.map((o) => o.line_total);
      return {
        product_id: item.product_id,
        product_name: item.product_name,
        qty: item.qty,
        offers,
        saving: Number((Math.max(...totals) - Math.min(...totals)).toFixed(2)),
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
