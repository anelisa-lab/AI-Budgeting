/**
 * Type coercion and the request/response mapping layer.
 *
 * TWO JOBS, AND ONLY THESE TWO:
 *
 * 1. COERCION. FastAPI is built on Pydantic v2, which serialises `Decimal` to a
 *    JSON **string** ("1650.00"), not a number. Every money field on the wire
 *    therefore arrives as a string, and `"1650.00" - 85` is NaN in JavaScript.
 *    Everything below turns those into real numbers once, at the boundary, so
 *    no screen ever has to remember to call Number().
 *
 * 2. FORM <-> API MAPPING. The budget form asks a student two questions the
 *    backend does not store directly — "when did it land?" and "how long must
 *    it last?" — because "cycle_end_date" is not a question anyone answers.
 *    `budgetToApi` / `budgetFromApi` convert between the two, and they are the
 *    ONLY place that conversion is allowed to happen.
 *
 * Everything else keeps the backend's own field names. `budget.total_amount`,
 * `transaction.item_name` and `offer.product_name` are backend names on
 * purpose: if you can read app/schemas.py you can read this frontend.
 */

/* ------------------------------------------------------------- primitives */

/** Pydantic Decimal -> number. Returns `fallback` for null/undefined/junk. */
export function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Same, but preserves null instead of collapsing it to 0. */
export function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A Date-only string the backend will accept: YYYY-MM-DD. */
export function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from, to) {
  if (!from || !to) return 0;
  const a = new Date(`${toDateOnly(from)}T00:00:00`);
  const b = new Date(`${toDateOnly(to)}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

/** YYYY-MM-DD, `days` after `from`. */
export function addDays(from, days) {
  const base = new Date(`${toDateOnly(from)}T00:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  base.setDate(base.getDate() + Number(days || 0));
  return toDateOnly(base);
}

/* ----------------------------------------------------------------- budget */

/**
 * BudgetOut (app/schemas.py) with every Decimal turned into a number.
 * Field names are unchanged — this is the backend's object, typed correctly.
 */
export function budgetFromApi(b) {
  if (!b) return null;
  return {
    id: b.id,
    user_id: b.user_id,
    budget_kind: b.budget_kind,
    status: b.status,
    currency: b.currency || 'ZAR',
    total_amount: num(b.total_amount),
    remaining_amount: num(b.remaining_amount),
    savings_percentage: num(b.savings_percentage),
    savings_amount: num(b.savings_amount),
    cycle_start_date: toDateOnly(b.cycle_start_date),
    cycle_end_date: toDateOnly(b.cycle_end_date),
    created_at: b.created_at || null,
    updated_at: b.updated_at || null,

    // Cycle history (sql/014): money rolled in from the last cycle, when this
    // one was closed, and which cycle it replaced.
    carried_over_amount: num(b.carried_over_amount),
    completed_at: b.completed_at || null,
    renewed_from_budget_id: b.renewed_from_budget_id ?? null,

    // Written back by the Daily Budget Split on every read (Member 6).
    daily_limit: numOrNull(b.daily_limit),
    budget_mode: b.budget_mode || 'normal',
    // Survival ("broke week") mode starts when remaining_amount drops to this.
    survival_threshold: numOrNull(b.survival_threshold),
  };
}

/**
 * Budget form values -> BudgetCreateRequest.
 *
 *   amount       -> total_amount
 *   payoutDate   -> cycle_start_date   ("when did it land?")
 *   periodDays   -> cycle_end_date     (start + N days; the next payout date,
 *                                       which is what the backend README says
 *                                       cycle_end_date means)
 */
export function budgetToApi({
  amount, payoutDate, periodDays, savingsPercentage, survivalThreshold, budgetKind,
} = {}) {
  const start = toDateOnly(payoutDate);
  return {
    total_amount: num(amount),
    cycle_start_date: start,
    cycle_end_date: addDays(start, num(periodDays, 30)),
    budget_kind: budgetKind || 'monthly',
    savings_percentage: num(savingsPercentage, 0),
    // Blank (or 0) = no survival mode, which the backend expresses as null.
    survival_threshold: thresholdOrNull(survivalThreshold),
  };
}

/** Survival threshold from a form box: blank and 0 both mean "off" (null). */
export function thresholdOrNull(value) {
  const n = numOrNull(value);
  return n === null || n <= 0 ? null : n;
}

/**
 * The "start next cycle" form -> BudgetRenewRequest (POST /budgets/{id}/renew).
 * Same date mapping as a new budget (payoutDate -> start, periodDays -> end),
 * plus what to carry over. survival_threshold is always sent so a cleared box
 * clears it rather than silently keeping the old one.
 */
export function budgetRenewToApi({
  amount, payoutDate, periodDays, savingsPercentage, survivalThreshold,
  carryOverLeftover = true, carryOverSavings = false, keepCategories = true,
} = {}) {
  const start = toDateOnly(payoutDate);
  return {
    total_amount: num(amount),
    cycle_start_date: start,
    cycle_end_date: addDays(start, num(periodDays, 30)),
    savings_percentage: num(savingsPercentage, 0),
    survival_threshold: thresholdOrNull(survivalThreshold),
    carry_over_leftover: Boolean(carryOverLeftover),
    carry_over_savings: Boolean(carryOverSavings),
    keep_categories: Boolean(keepCategories),
  };
}

/**
 * BudgetOut -> the values the budget form shows.
 * The exact inverse of budgetToApi, so editing a saved budget round-trips.
 */
export function budgetToFormValues(budget) {
  if (!budget) return null;
  return {
    amount: String(budget.total_amount ?? ''),
    payoutDate: budget.cycle_start_date || '',
    periodDays: String(daysBetween(budget.cycle_start_date, budget.cycle_end_date) || 30),
    savingsPercentage: String(budget.savings_percentage ?? 0),
    survivalThreshold: budget.survival_threshold == null ? '' : String(budget.survival_threshold),
  };
}

/**
 * PUT /budgets/{id} accepts ONLY total_amount, cycle_end_date and survival_threshold
 * (BudgetUpdateRequest). cycle_start_date is immutable server-side, so the
 * period length is expressed by moving the end date.
 */
export function budgetUpdateToApi(
  { amount, payoutDate, periodDays, survivalThreshold, savingsPercentage },
  existing,
) {
  const start = toDateOnly(payoutDate) || existing?.cycle_start_date;
  const patch = {};
  if (amount !== undefined && amount !== '') patch.total_amount = num(amount);
  if (periodDays !== undefined && periodDays !== '') {
    patch.cycle_end_date = addDays(start, num(periodDays, 30));
  }
  // The backend keeps the old threshold when the field is left out and clears
  // it when it is sent as null. The form shows the current value, so a blank or
  // 0 box means "turn it off" — send null. (Before, a blank box was omitted and
  // the threshold could only be "cleared" with 0, which left survival mode on
  // for a completely used-up budget.)
  if (survivalThreshold !== undefined) {
    patch.survival_threshold = thresholdOrNull(survivalThreshold);
  }
  // The backend recomputes savings from this and the total.
  if (savingsPercentage !== undefined && savingsPercentage !== '') {
    patch.savings_percentage = num(savingsPercentage);
  }
  return patch;
}

/**
 * BudgetSplitOut (app/routers/budget_split.py) with every Decimal coerced.
 * See docs/BUDGET_SPLIT_CONTRACT.md for which field goes where on screen.
 */
export function budgetSplitFromApi(s) {
  if (!s) return null;
  return {
    budget_id: s.budget_id,
    currency: s.currency || 'ZAR',
    as_of: toDateOnly(s.as_of),
    next_payout_date: toDateOnly(s.next_payout_date),
    days_remaining: num(s.days_remaining, 0),
    remaining_amount: num(s.remaining_amount),
    daily_limit: num(s.daily_limit),
    spent_today: num(s.spent_today),
    remaining_today: num(s.remaining_today),
    // numOrNull, not num: it is legitimately null on payout day.
    tomorrow_limit: numOrNull(s.tomorrow_limit),
    mode: s.mode || 'normal',
    survival_threshold: numOrNull(s.survival_threshold),
    message: s.message || null,
    // True once the payout date has passed: the budget needs renewing.
    cycle_ended: Boolean(s.cycle_ended),
    days_overdue: num(s.days_overdue, 0),
    days: Array.isArray(s.days) ? s.days.map((d) => ({
      limit_date: toDateOnly(d.limit_date),
      planned_limit: num(d.planned_limit),
      spent_amount: num(d.spent_amount),
      remaining_limit: num(d.remaining_limit),
      is_today: Boolean(d.is_today),
    })) : [],
  };
}

/* ----------------------------------------------------------- transactions */

/** TransactionOut with Decimals coerced. Backend field names kept. */
export function transactionFromApi(t) {
  if (!t) return null;
  return {
    id: t.id,
    user_id: t.user_id,
    budget_id: t.budget_id,
    item_name: t.item_name,
    amount: num(t.amount),
    category: t.category || 'Other',
    is_essential: Boolean(t.is_essential),
    transaction_date: t.transaction_date || t.created_at || null,
    created_at: t.created_at || null,
  };
}

/**
 * Spend form -> TransactionCreateRequest. `transactionDate` (YYYY-MM-DD) is
 * optional: left out, the spend is stamped "now"; a past date files it on the
 * day it happened so it does not eat into today's allowance.
 */
export function transactionToApi({ description, amount, category, isEssential, transactionDate } = {}) {
  const body = {
    item_name: String(description || '').trim(),
    amount: num(amount),
    category: category || null,
    is_essential: Boolean(isEssential),
  };
  const date = toDateOnly(transactionDate);
  if (date) body.transaction_date = date;
  return body;
}

/** Edit form -> TransactionUpdateRequest. Only the fields given are sent. */
export function transactionUpdateToApi({
  description, amount, category, isEssential, transactionDate,
} = {}) {
  const body = {};
  if (description !== undefined) body.item_name = String(description || '').trim();
  if (amount !== undefined && amount !== '') body.amount = num(amount);
  if (category !== undefined) body.category = category || null;
  if (isEssential !== undefined) body.is_essential = Boolean(isEssential);
  const date = toDateOnly(transactionDate);
  if (date) body.transaction_date = date;
  return body;
}

/** TransactionResult (transaction + budget + overspend flags + fresh split). */
export function transactionResultFromApi(result) {
  if (!result) return null;
  return {
    transaction: transactionFromApi(result.transaction),
    budget: budgetFromApi(result.budget),
    overspend_warning: Boolean(result.overspend_warning),
    warning_message: result.warning_message || null,
    daily_limit_warning: Boolean(result.daily_limit_warning),
    daily_limit_message: result.daily_limit_message || null,
    daily_split: budgetSplitFromApi(result.daily_split),
  };
}

/** BudgetHealthOut — Member 3's warning block for the dashboard. */
export function budgetHealthFromApi(h) {
  if (!h) return null;
  return {
    warning_level: h.warning_level || 'ok', // ok | caution | danger | exhausted
    spendable_amount: num(h.spendable_amount),
    spent_amount: num(h.spent_amount),
    spent_percentage: num(h.spent_percentage),
    over_daily_limit_by: num(h.over_daily_limit_by),
    warnings: Array.isArray(h.warnings) ? h.warnings : [],
  };
}

/* ------------------------------------------------------- priority categories */

/** BudgetCategoryOut — a priority category with what has been spent under it. */
export function budgetCategoryFromApi(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    planned_amount: numOrNull(c.planned_amount),   // null = no amount planned yet
    position: num(c.position, 0),
    spent_amount: num(c.spent_amount),
  };
}

/** The category planner's rows -> the body of PUT /budgets/{id}/categories. */
export function categoriesToApi(rows = []) {
  return {
    categories: rows
      .filter((r) => String(r?.name || '').trim() !== '')
      .map((r) => ({
        name: String(r.name).trim(),
        planned_amount: numOrNull(String(r.plannedAmount ?? '').replace(/[^\d.]/g, '')),
      })),
  };
}

/**
 * The planner + budget form -> the body of POST /budgets/template. The money
 * and period are only sent when the form has them; otherwise the backend uses
 * the active budget.
 */
export function templateToApi({ categories, amount, savingsPercentage, periodDays, startDate } = {}) {
  const body = categoriesToApi(categories);
  const total = numOrNull(String(amount ?? '').replace(/[^\d.]/g, ''));
  if (total !== null && total > 0) body.total_amount = total;
  const pct = numOrNull(savingsPercentage);
  if (pct !== null) body.savings_percentage = Math.min(100, Math.max(0, pct));
  const days = numOrNull(periodDays);
  if (days !== null && days >= 1) body.period_days = Math.round(days);
  const start = toDateOnly(startDate);
  if (start) body.start_date = start;
  return body;
}

/** BudgetDashboardOut — GET /budgets/dashboard. */
export function dashboardFromApi(d) {
  if (!d) return null;
  return {
    budget: budgetFromApi(d.budget),
    split: budgetSplitFromApi(d.daily_split),
    health: budgetHealthFromApi(d.health),
    recent_transactions: Array.isArray(d.recent_transactions)
      ? d.recent_transactions.map(transactionFromApi) : [],
    categories: Array.isArray(d.categories)
      ? d.categories.map(budgetCategoryFromApi) : [],
  };
}

/** AffordabilityOut — POST /budget-split/check. */
export function affordabilityFromApi(a) {
  if (!a) return null;
  return {
    amount: num(a.amount),
    affordable_today: Boolean(a.affordable_today),
    affordable_this_cycle: Boolean(a.affordable_this_cycle),
    remaining_today: num(a.remaining_today),
    remaining_amount: num(a.remaining_amount),
    days_of_budget: numOrNull(a.days_of_budget),
    message: a.message || '',
  };
}

/* ---------------------------------------------------------------- search */

/**
 * SearchResultItem with Decimals coerced.
 *
 * `offer_id` is the identity here, NOT `product_id`: the same product listed
 * at five stores is five offers, and comparing stores is the point of the app.
 */
export function offerFromApi(r) {
  if (!r) return null;
  const price = num(r.price);
  const shipping = num(r.shipping_cost);
  return {
    offer_id: r.offer_id,
    product_id: r.product_id,
    product_name: r.product_name,
    brand: r.brand || null,
    category: r.category || null,
    subcategory: r.subcategory || null,
    colour: r.colour || null,
    size: r.size || null,
    is_essential: Boolean(r.is_essential),
    store_id: r.store_id,
    store_name: r.store_name,
    store_type: r.store_type,            // 'online' | 'physical' | 'mixed'
    store_latitude: numOrNull(r.store_latitude),
    store_longitude: numOrNull(r.store_longitude),
    price,
    shipping_cost: shipping,
    // total_cost is a GENERATED column server-side (price + shipping_cost);
    // we take the backend's value and only fall back to the sum if it is null.
    total_cost: r.total_cost == null ? price + shipping : num(r.total_cost),
    currency: r.currency || 'ZAR',
    availability_status: r.availability_status || 'unknown',
    rating: numOrNull(r.rating),
    rating_count: num(r.rating_count, 0),
    last_updated: r.last_updated || null,
    product_url: r.product_url || null,
    // Phase 4 backend. effective_cost is what ?fulfilment= made the offer
    // cost: the shelf price when collecting, price + delivery when delivered.
    // Without ?fulfilment= it is absent, so fall back to total_cost.
    effective_cost: r.effective_cost == null
      ? (r.total_cost == null ? price + shipping : num(r.total_cost))
      : num(r.effective_cost),
    ...priceProvenance(r),
    delivery_available: r.delivery_available ?? null,
    collection_available: r.collection_available ?? null,
    // Phase 5: km from the student's saved location; null when unknown.
    distance_km: numOrNull(r.distance_km),
  };
}

/**
 * Where a price came from. Every seeded price is a modelled estimate; only a
 * price confirmed with the store (price_source 'live_api' or
 * 'verified_manual', with a price_verified_at date) is shown as confirmed.
 * The backend decides this — the screens only label it.
 */
export function priceProvenance(r) {
  const source = r?.price_source || 'seed_estimate';
  const verifiedAt = r?.price_verified_at || null;
  return {
    price_source: source,
    price_verified_at: verifiedAt,
    price_is_estimate: r?.price_is_estimate ?? (source === 'seed_estimate' || !verifiedAt),
  };
}

/** SearchResponse { results, count, limit, offset, page, total_pages, has_more, message }. */
export function searchResponseFromApi(payload) {
  return {
    results: Array.isArray(payload?.results) ? payload.results.map(offerFromApi) : [],
    count: num(payload?.count, 0),
    limit: num(payload?.limit, 20),
    offset: num(payload?.offset, 0),
    page: num(payload?.page, 1),
    total_pages: num(payload?.total_pages, 0),
    has_more: Boolean(payload?.has_more),
    // The backend's own wording for "no results" and "past the last page".
    message: payload?.message || null,
  };
}

/* ------------------------------------------------------ live store search */

/** LiveSearchItem — one product from GET /api/search. */
/** A real price as a number, or null. 0, negatives and junk are never a price. */
export function priceOrNull(value) {
  const n = numOrNull(value);
  return n != null && n > 0 ? n : null;
}

/**
 * LiveSearchItem — one product from GET /api/search. price is null (never 0)
 * when the store has no price right now; last_known_price is the last real
 * price seen. `buyable` is the one flag screens should use.
 */
export function liveItemFromApi(i) {
  const inStock = i.in_stock !== false;
  const price = inStock ? priceOrNull(i.price) : null;
  return {
    id: i.id,
    name: i.name,
    price,
    last_known_price: priceOrNull(i.last_known_price),
    last_priced_at: i.last_priced_at || null,
    buyable: inStock && price != null,
    image_url: i.image_url || null,
    product_url: i.product_url || null,
    store: i.store,
    brand: i.brand || null,
    category: i.category || null,
    on_promotion: Boolean(i.on_promotion),
    in_stock: inStock,
    last_updated: i.last_updated || null,
  };
}

/** LiveSearchResponse. stores[].source is cache | live | stale | unavailable. */
export function liveSearchFromApi(payload) {
  const results = Array.isArray(payload?.results) ? payload.results.map(liveItemFromApi) : [];
  return {
    query: payload?.query || '',
    results,
    count: num(payload?.count, results.length),
    stores: Array.isArray(payload?.stores)
      ? payload.stores.map((s) => ({
        store: s.store,
        name: s.name || s.store,
        source: s.source,
        fetched_at: s.fetched_at || null,
        count: num(s.count, 0),
      }))
      : [],
    message: payload?.message || null,
  };
}

/* -------------------------------------------------------- recommendations */

/** RecommendedOffer — one ranked result from POST /recommendations. */
export function recommendationFromApi(r) {
  if (!r) return null;
  const cb = r.cost_breakdown || {};
  return {
    rank: num(r.rank, 0),
    offer_id: r.offer_id,
    product_id: r.product_id,
    product_name: r.product_name,
    brand: r.brand || null,
    category: r.category || null,
    size: r.size || null,
    is_essential: Boolean(r.is_essential),
    store_id: r.store_id,
    store_name: r.store_name,
    store_type: r.store_type,
    price: num(r.price),
    true_cost: num(r.true_cost),
    hidden_cost: num(cb.hidden_cost),
    distance_km: numOrNull(r.distance_km),
    rating: numOrNull(r.rating),
    rating_count: num(r.rating_count, 0),
    last_updated: r.last_updated || null,
    score: num(r.score),
    component_scores: r.component_scores || {},
    meets_budget: Boolean(r.meets_budget),
    meets_preferences: Boolean(r.meets_preferences),
    // false = none of the student's words matched; this is a closest match.
    matched_query: r.matched_query !== false,
    explanation: r.explanation || '',
    currency: r.currency || 'ZAR',
    // Enough of the SearchResultItem shape for "add to list" to reuse it.
    shipping_cost: num(cb.shipping),
    total_cost: num(r.price) + num(cb.shipping),
    availability_status: 'available',
    product_url: r.product_url || null,
    // How it was priced. A store that can't serve the student the way they
    // asked is priced the only way it can be (Phase 4 true-cost rule 7).
    fulfilment: cb.fulfilment || null,
    fulfilment_available: cb.fulfilment_available !== false,
    ...priceProvenance(r),
  };
}

/** RecommendationResponse. */
export function recommendationsFromApi(payload) {
  const b = payload?.budget || {};
  return {
    run_id: payload?.run_id ?? null,
    results: Array.isArray(payload?.results) ? payload.results.map(recommendationFromApi) : [],
    count: num(payload?.count, 0),
    candidates_considered: num(payload?.candidates_considered, 0),
    response_time_ms: num(payload?.response_time_ms, 0),
    message: payload?.message || null,
    budget: {
      budget_id: b.budget_id ?? null,
      remaining_amount: numOrNull(b.remaining_amount),
      daily_limit: numOrNull(b.daily_limit),
      days_remaining: b.days_remaining ?? null,
      mode: b.mode || 'normal',
      message: b.message || null,
    },
  };
}

/* -------------------------------------------------------------- true cost */

/** TrueCostOut — one offer priced as a single order, itemised. */
export function trueCostFromApi(t) {
  if (!t) return null;
  return {
    offer_id: t.offer_id,
    quantity: num(t.quantity, 1),
    fulfilment: t.fulfilment || 'delivery',
    subtotal: num(t.subtotal),
    shipping: num(t.shipping),
    charges: Array.isArray(t.charges) ? t.charges.map((c) => ({
      label: c.label,
      charge_type: c.charge_type,
      amount: num(c.amount),
      waived: Boolean(c.waived),
      note: c.note || null,
    })) : [],
    charges_total: num(t.charges_total),
    travel_cost: num(t.travel_cost),
    true_cost: num(t.true_cost),
    hidden_cost: num(t.hidden_cost),
    distance_km: numOrNull(t.distance_km),
    notes: Array.isArray(t.notes) ? t.notes : [],
    product_name: t.product_name || null,
    store_name: t.store_name || null,
    requested_fulfilment: t.requested_fulfilment || null,
    fulfilment_available: t.fulfilment_available !== false,
  };
}

/* ------------------------------------------------------ basket comparison */

function basketLineFromApi(l) {
  return {
    product_id: l.product_id,
    product_name: l.product_name,
    qty: num(l.qty, 1),
    offer_id: l.offer_id,
    price: num(l.price),
    line_total: num(l.line_total),
    is_estimate: l.is_estimate !== false,
  };
}

/** StoreQuoteOut — the whole list as ONE order at one store. */
export function storeQuoteFromApi(q) {
  return {
    store_id: q.store_id,
    store_name: q.store_name,
    store_type: q.store_type,
    distance_km: numOrNull(q.distance_km),
    fulfilment: q.fulfilment,
    fulfilment_available: q.fulfilment_available !== false,
    full: Boolean(q.full),
    stocked: num(q.stocked, 0),
    missing_count: num(q.missing_count, 0),
    lines: Array.isArray(q.lines) ? q.lines.map(basketLineFromApi) : [],
    missing: Array.isArray(q.missing) ? q.missing : [],
    subtotal: num(q.subtotal),
    delivery: num(q.delivery),
    fees: num(q.fees),
    travel: num(q.travel),
    total: num(q.total),
    estimate_count: num(q.estimate_count, 0),
    notes: Array.isArray(q.notes) ? q.notes : [],
  };
}

/** CompareBasketResponse — POST /compare/basket. */
export function basketComparisonFromApi(payload) {
  const plan = payload?.best_plan;
  const prices = payload?.prices || {};
  return {
    fulfilment: payload?.fulfilment || 'collection',
    location_known: Boolean(payload?.location_known),
    stores: Array.isArray(payload?.stores) ? payload.stores.map(storeQuoteFromApi) : [],
    best_single_store_id: payload?.best_single_store_id ?? null,
    best_plan: plan ? {
      total: num(plan.total),
      store_count: num(plan.store_count, 0),
      stores: Array.isArray(plan.stores) ? plan.stores.map(storeQuoteFromApi) : [],
      saving_vs_best_single: numOrNull(plan.saving_vs_best_single),
    } : null,
    unavailable: Array.isArray(payload?.unavailable) ? payload.unavailable : [],
    items: Array.isArray(payload?.items) ? payload.items.map((it) => ({
      product_id: it.product_id,
      product_name: it.product_name,
      qty: num(it.qty, 1),
      offers: Array.isArray(it.offers) ? it.offers.map((o) => ({
        offer_id: o.offer_id,
        store_id: o.store_id,
        store_name: o.store_name,
        price: num(o.price),
        line_total: num(o.line_total),
        in_stock: Boolean(o.in_stock),
        is_estimate: o.is_estimate !== false,
        price_verified_at: o.price_verified_at || null,
        product_url: o.product_url || null,
      })) : [],
    })) : [],
    prices: {
      listings: num(prices.listings, 0),
      estimates: num(prices.estimates, 0),
      confirmed: num(prices.confirmed, 0),
      all_confirmed: Boolean(prices.all_confirmed),
    },
  };
}

/** TrueCostResponse — results arrive cheapest first. */
export function trueCostResponseFromApi(payload) {
  return {
    results: Array.isArray(payload?.results) ? payload.results.map(trueCostFromApi) : [],
    cheapest_offer_id: payload?.cheapest_offer_id ?? null,
    saving_vs_dearest: num(payload?.saving_vs_dearest),
  };
}

/* ------------------------------------------------------------------ user */

/** UserOut { id, name, email, residence, student_number, created_at }. */
export function userFromApi(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    residence: u.residence || null,
    student_number: u.student_number || null,
    phone_number: u.phone_number || null,
    created_at: u.created_at || null,
  };
}

/** NotificationPreferencesOut. */
export function notificationPreferencesFromApi(p) {
  return { low_balance_threshold: numOrNull(p?.low_balance_threshold) };
}

/* ----------------------------------------------------------- notifications */

/** NotificationOut. */
export function notificationFromApi(n) {
  return {
    id: n.id,
    category: n.category,
    module: n.module || 'system',
    title: n.title,
    body: n.body,
    is_read: Boolean(n.is_read),
    created_at: n.created_at,
  };
}

/** NotificationListOut. */
export function notificationListFromApi(payload) {
  return {
    items: Array.isArray(payload?.items) ? payload.items.map(notificationFromApi) : [],
    unread_count: num(payload?.unread_count, 0),
  };
}

/** PreferencesOut. max_distance_km is nullable in the schema. */
export function preferencesFromApi(p) {
  return {
    preferred_categories: Array.isArray(p?.preferred_categories) ? p.preferred_categories : [],
    preferred_stores: Array.isArray(p?.preferred_stores) ? p.preferred_stores : [],
    max_distance_km: numOrNull(p?.max_distance_km),
  };
}

/* ---------------------------------------------------------- shopping list */

/**
 * ShoppingListLineOut — one line on the server-side list (Phase 5). `price`
 * is what the offer cost when it was added (so Compare can say "was R9");
 * `current_price` is today's.
 */
export function shoppingLineFromApi(l) {
  return {
    offer_id: l.offer_id,
    product_id: l.product_id,
    product_name: l.product_name,
    brand: l.brand || null,
    size: l.size || null,
    category: l.category || null,
    is_essential: Boolean(l.is_essential),
    store_id: l.store_id,
    store_name: l.store_name,
    store_type: l.store_type,
    price: num(l.price),
    current_price: num(l.current_price),
    shipping_cost: num(l.shipping_cost),
    total_cost: num(l.total_cost),
    availability_status: l.availability_status || 'unknown',
    qty: num(l.qty, 1),
    added_at: l.added_at || null,
  };
}

/** LiveListLineOut — a live store item (Checkers) on the list. */
export function liveListLineFromApi(l) {
  return {
    item_id: l.item_id,
    name: l.name,
    store: l.store,
    brand: l.brand || null,
    image_url: l.image_url || null,
    product_url: l.product_url || null,
    price: num(l.price),                        // saved when added
    current_price: priceOrNull(l.current_price), // today; null = no price now
    in_stock: l.in_stock !== false,
    buyable: Boolean(l.buyable),
    price_changed: Boolean(l.price_changed),
    qty: num(l.qty, 1),
    line_total: num(l.line_total),
    added_at: l.added_at || null,
  };
}

export const EMPTY_LIST = Object.freeze({
  lines: [], liveLines: [],
  summary: { total: 0, count: 0, unavailable_count: 0, changed_count: 0 },
});

/**
 * ShoppingListOut -> { lines (catalogue offers), liveLines (live items), summary }.
 * summary.total is at saved prices and only counts what can be bought now.
 */
export function shoppingListFromApi(payload) {
  const s = payload?.summary || {};
  return {
    lines: Array.isArray(payload?.items) ? payload.items.map(shoppingLineFromApi) : [],
    liveLines: Array.isArray(payload?.live_items) ? payload.live_items.map(liveListLineFromApi) : [],
    summary: {
      total: num(s.total),
      count: num(s.count),
      unavailable_count: num(s.unavailable_count),
      changed_count: num(s.changed_count),
    },
  };
}

/* --------------------------------------------------------------- location */

/** StoreNearbyOut — one physical store from GET /search/stores/nearby. */
export function nearbyStoreFromApi(s) {
  return {
    store_id: s.store_id,
    store_name: s.store_name,
    store_type: s.store_type,
    address: s.address || null,
    latitude: num(s.latitude),
    longitude: num(s.longitude),
    distance_km: num(s.distance_km),
    delivery_available: s.delivery_available ?? null,
    collection_available: s.collection_available ?? null,
  };
}

/** NearbyStoresResponse { results, count, max_distance_km, origin }. */
export function nearbyStoresFromApi(payload) {
  return {
    results: Array.isArray(payload?.results) ? payload.results.map(nearbyStoreFromApi) : [],
    count: num(payload?.count, 0),
    max_distance_km: num(payload?.max_distance_km),
    origin: locationFromApi(payload?.origin),
  };
}

/** LocationOut, or null when the student hasn't set one. */
export function locationFromApi(l) {
  if (!l || l.latitude == null || l.longitude == null) return null;
  return {
    latitude: num(l.latitude),
    longitude: num(l.longitude),
    label: l.label || 'My location',
    updated_at: l.updated_at || null,
  };
}
