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

export const PAGE_SIZE = 20; // backend default; its max is 100

export const DEFAULT_FILTERS = {
  q: '',
  category: '',
  brand: '',
  colour: '',
  size: '',
  store: '',
  minPrice: '',          // -> min_price, compared against total_cost
  maxPrice: '',          // -> max_price, compared against total_cost
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
    sort: backendSort(f.sort),
    limit,
    offset,
  };

  const min = parseMoney(f.minPrice);
  if (min !== null && min > 0) params.min_price = min;

  // max_price bounds product_offers.total_cost (price + shipping), which is the
  // right ceiling for a student's budget: a cheap item with R99 delivery is not
  // cheap. That was already the rule in docs/SEED_DATA_CONTRACT.md and the
  // backend happens to implement exactly it.
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
 * The filters POST /recommendations can honour: a query, a category and a
 * price ceiling. With any OTHER filter on, the "Recommended for you" picks
 * would ignore it (e.g. show Checkers while the student filtered to Shoprite),
 * so Search hides them rather than contradict the results under them.
 */
export function recommendationsCanHonour(filters) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return !(
    String(f.brand || '').trim() || String(f.colour || '').trim() || String(f.size || '').trim()
    || String(f.store || '').trim() || String(f.minPrice || '').trim()
    || f.freeShippingOnly || f.essentialOnly || f.availability !== 'available'
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

/** Only an offer the backend says is in stock can be bought today. */
export const isBuyable = (o) => o && o.availability_status === 'available';

/**
 * Delivery for ONE order at a store, from the offers bought there.
 *
 * The backend carries shipping_cost per OFFER and has no basket rule, so the
 * closest honest reading of "one delivery" is the largest shipping_cost among
 * the lines bought there. Collecting from any store you can walk into costs
 * no delivery; an online-only store always delivers.
 */
export function orderDelivery(offers, storeType, fulfilment) {
  if (fulfilment === 'collection' && storeType !== 'online') return 0;
  return offers.reduce((max, o) => Math.max(max, Number(o.shipping_cost) || 0), 0);
}

/**
 * Price the whole list at every store that appears in the offers we fetched.
 *
 * `offersByProduct` is a Map<product_id, SearchResultItem[]> built by
 * `api.search.offersForProducts` — real rows from GET /search, not local data.
 *
 * Rules:
 *  - only IN-STOCK offers count; a store whose only listing is out of stock
 *    does not stock that line today
 *  - a store gets a total ONLY when it stocks every line. Before Phase 3 a
 *    missing line was priced at the cheapest store's price, which let a store
 *    with half the list look cheapest; that synthetic figure is gone
 *  - total = shelf prices x quantity + ONE delivery (see orderDelivery)
 *  - complete stores come first, cheapest first; incomplete stores follow,
 *    most of the list first, with no total
 */
export function priceListByStore(lines, offersByProduct, { fulfilment = 'collection' } = {}) {
  const stores = new Map();
  for (const offers of offersByProduct.values()) {
    for (const o of offers) {
      if (!stores.has(o.store_id)) {
        stores.set(o.store_id, {
          store_id: o.store_id,
          store_name: o.store_name,
          store_type: o.store_type,
        });
      }
    }
  }
  if (stores.size === 0) return [];

  return [...stores.values()]
    .map((store) => {
      let subtotal = 0;
      let stocked = 0;
      let missing = 0;
      let outOfStock = 0;
      const bought = [];

      for (const line of lines) {
        const offers = offersByProduct.get(line.product_id) || [];
        const listed = offers.find((o) => o.store_id === store.store_id);
        if (isBuyable(listed)) {
          stocked += 1;
          subtotal += listed.price * line.qty;
          bought.push(listed);
        } else {
          missing += 1;
          if (listed) outOfStock += 1;
        }
      }

      const full = missing === 0 && lines.length > 0;
      const delivery = full ? orderDelivery(bought, store.store_type, fulfilment) : 0;
      const total = full ? Number((subtotal + delivery).toFixed(2)) : null;

      return {
        store,
        subtotal: Number(subtotal.toFixed(2)),
        delivery: Number(delivery.toFixed(2)),
        total,
        stocked,
        missing,
        outOfStock,
        coverage: lines.length ? stocked / lines.length : 0,
        full,
      };
    })
    .sort((a, b) => {
      if (a.full !== b.full) return a.full ? -1 : 1;
      if (a.full && b.full) return a.total - b.total || a.store.store_name.localeCompare(b.store.store_name);
      return b.coverage - a.coverage || a.store.store_name.localeCompare(b.store.store_name);
    });
}

/**
 * Cheapest achievable total, buying each line wherever it is cheapest
 * (in-stock offers only). Shelf prices only — this is the figure for a
 * student walking between shops, not ordering several separate deliveries.
 * null when any line has no in-stock offer at all.
 */
export function splitShopTotal(lines, offersByProduct) {
  let total = 0;
  for (const line of lines) {
    const offers = (offersByProduct.get(line.product_id) || []).filter(isBuyable);
    if (offers.length === 0) return null;
    const cheapest = offers.reduce((best, o) => (o.price < best.price ? o : best), offers[0]);
    total += cheapest.price * line.qty;
  }
  return Number(total.toFixed(2));
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
 * Per-item head-to-head: the same product at every store that lists it in
 * stock. Only products with more than one such offer are worth showing.
 */
export function comparableGroups(lines, offersByProduct) {
  // One group per PRODUCT: the same bread added from two stores is still one
  // head-to-head (and two groups would share a React key).
  const byProduct = new Map();
  for (const line of lines) {
    const seen = byProduct.get(line.product_id);
    if (seen) seen.qty += line.qty;
    else byProduct.set(line.product_id, { ...line });
  }
  return [...byProduct.values()]
    .map((line) => {
      const offers = [...(offersByProduct.get(line.product_id) || [])]
        .filter(isBuyable)
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
        qty: line.qty,
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
