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

    // Written back by the Daily Budget Split on every read (Member 6).
    daily_limit: numOrNull(b.daily_limit),
    budget_mode: b.budget_mode || 'normal',
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
export function budgetToApi({ amount, payoutDate, periodDays, savingsPercentage, budgetKind } = {}) {
  const start = toDateOnly(payoutDate);
  return {
    total_amount: num(amount),
    cycle_start_date: start,
    cycle_end_date: addDays(start, num(periodDays, 30)),
    budget_kind: budgetKind || 'monthly',
    savings_percentage: num(savingsPercentage, 0),
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
  };
}

/**
 * PUT /budgets/{id} accepts ONLY total_amount and cycle_end_date
 * (BudgetUpdateRequest). cycle_start_date is immutable server-side, so the
 * period length is expressed by moving the end date.
 */
export function budgetUpdateToApi({ amount, payoutDate, periodDays }, existing) {
  const start = toDateOnly(payoutDate) || existing?.cycle_start_date;
  const patch = {};
  if (amount !== undefined && amount !== '') patch.total_amount = num(amount);
  if (periodDays !== undefined && periodDays !== '') {
    patch.cycle_end_date = addDays(start, num(periodDays, 30));
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

/** Spend form -> TransactionCreateRequest. */
export function transactionToApi({ description, amount, category, isEssential } = {}) {
  return {
    item_name: String(description || '').trim(),
    amount: num(amount),
    category: category || null,
    is_essential: Boolean(isEssential),
  };
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

/** BudgetDashboardOut — GET /budgets/dashboard. */
export function dashboardFromApi(d) {
  if (!d) return null;
  return {
    budget: budgetFromApi(d.budget),
    split: budgetSplitFromApi(d.daily_split),
    health: budgetHealthFromApi(d.health),
    recent_transactions: Array.isArray(d.recent_transactions)
      ? d.recent_transactions.map(transactionFromApi) : [],
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
    colour: r.colour || null,
    size: r.size || null,
    is_essential: Boolean(r.is_essential),
    store_id: r.store_id,
    store_name: r.store_name,
    store_type: r.store_type,            // 'online' | 'physical' | 'mixed'
    price,
    shipping_cost: shipping,
    // total_cost is a GENERATED column server-side (price + shipping_cost);
    // we take the backend's value and only fall back to the sum if it is null.
    total_cost: r.total_cost == null ? price + shipping : num(r.total_cost),
    currency: r.currency || 'ZAR',
    availability_status: r.availability_status || 'unknown',
    product_url: r.product_url || null,
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

/* ------------------------------------------------------------------ user */

/** UserOut { id, name, email, created_at }. */
export function userFromApi(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    created_at: u.created_at || null,
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
