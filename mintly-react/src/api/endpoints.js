/**
 * The backend contract, transcribed.
 *
 * ONE FUNCTION PER REAL ROUTE IN `AI-Budgeting-main/app/routers/*.py`.
 * Nothing here is invented: every path, method, body key and query parameter
 * below was read off the FastAPI source and the Pydantic models in
 * `app/schemas.py`. The source file and line are named above each group.
 *
 * If the backend changes, THIS is the file to change. Everything above it
 * (client.js, the contexts, the screens) goes through these functions, so a
 * renamed field is a one-line edit here rather than a grep across the app.
 *
 * Paths are written exactly as FastAPI mounts them, including the trailing
 * slash on /profile/ — the profile router uses `prefix="/profile"` with
 * `@router.get("/")`, so the real path has the slash. Hitting `/profile`
 * instead would take a 307 redirect, and a redirect across origins is exactly
 * where browsers drop the Authorization header.
 */

import { request } from './http.js';

/* =======================================================================
 * AUTH  —  app/routers/auth.py   (router prefix "/auth")
 * =====================================================================*/

/**
 * POST /auth/register  ->  201 { user: UserOut, token: string }
 * Body: RegisterRequest { name: str, email: EmailStr, password: str,
 *                         residence?: str (<= 100), student_number?: str (8-9 digits) }
 *
 * The backend rejects passwords under 8 characters with a 400 before Pydantic
 * even runs. It returns 409 when the email is taken, and 422 for a student
 * number that is not 8 or 9 digits. residence and student_number are optional
 * (Phase 4, migration 004); a blank one is left out rather than sent empty.
 */
export function register({ name, email, password, residence, student_number: studentNumber }, opts = {}) {
  const body = { name, email, password };
  if (residence) body.residence = residence;
  if (studentNumber) body.student_number = studentNumber;
  return request('/auth/register', {
    method: 'POST',
    body,
    fieldHints: { 409: 'email', 400: 'password' },
    ...opts,
  });
}

/**
 * POST /auth/login  ->  200 { user: UserOut, token: string }
 * Body: LoginRequest { email: EmailStr, password: str }
 * 401 with the same message for "no such user" and "wrong password".
 */
export function login({ email, password }, opts = {}) {
  return request('/auth/login', {
    method: 'POST',
    body: { email, password },
    fieldHints: { 401: 'password' },
    ...opts,
  });
}

/**
 * POST /auth/logout  ->  200 { message: string }   (requires Bearer token)
 * JWTs are stateless: the backend just tells us to bin the token client-side.
 */
export function logout(token, opts = {}) {
  return request('/auth/logout', { method: 'POST', token, ...opts });
}

/* =======================================================================
 * PROFILE  —  app/routers/profile.py   (router prefix "/profile")
 * =====================================================================*/

/** GET /profile/  ->  UserOut { id, name, email, residence, student_number, created_at } */
export function getProfile(token, opts = {}) {
  return request('/profile/', { token, ...opts });
}

/** PUT /profile/  ->  UserOut.  Body: UpdateProfileRequest { name: str } */
export function updateProfile(token, { name }, opts = {}) {
  return request('/profile/', { method: 'PUT', body: { name }, token, ...opts });
}

/**
 * GET /profile/preferences  ->  PreferencesOut
 *   { preferred_categories: string[], preferred_stores: string[],
 *     max_distance_km: number | null }
 */
export function getPreferences(token, opts = {}) {
  return request('/profile/preferences', { token, ...opts });
}

/**
 * PUT /profile/preferences  ->  PreferencesOut
 * Body: UpdatePreferencesRequest — any subset of the same three fields.
 * The backend COALESCEs, so an omitted key leaves the stored value alone.
 */
export function updatePreferences(token, patch, opts = {}) {
  const body = {};
  if (patch.preferred_categories !== undefined) body.preferred_categories = patch.preferred_categories;
  if (patch.preferred_stores !== undefined) body.preferred_stores = patch.preferred_stores;
  if (patch.max_distance_km !== undefined) body.max_distance_km = patch.max_distance_km;
  return request('/profile/preferences', { method: 'PUT', body, token, ...opts });
}

/* =======================================================================
 * BUDGETS  —  app/routers/budgets.py   (router prefix "/budgets")
 * =====================================================================*/

/**
 * POST /budgets  ->  201 BudgetOut
 * Body: BudgetCreateRequest {
 *   total_amount: Decimal > 0,
 *   cycle_start_date: date (YYYY-MM-DD),
 *   cycle_end_date:   date (YYYY-MM-DD),
 *   budget_kind: "monthly" | "available"   (default "monthly")
 *   savings_percentage: Decimal 0..100     (default 0)
 *   survival_threshold: Decimal >= 0 | null (survival mode below this balance)
 * }
 * 409 when the user already has an active budget (unique partial index
 * uq_one_active_budget_per_user).
 */
export function createBudget(token, body, opts = {}) {
  return request('/budgets', {
    method: 'POST',
    body,
    token,
    fieldHints: { 409: 'amount', 400: 'periodDays' },
    ...opts,
  });
}

/** GET /budgets  ->  BudgetOut[]  (history, newest first) */
export function listBudgets(token, opts = {}) {
  return request('/budgets', { token, ...opts });
}

/**
 * GET /budgets/current  ->  BudgetOut
 * 404 "No active budget" when there is none. The caller turns that into null;
 * see client.js `budgets.getCurrent`.
 */
export function getCurrentBudget(token, opts = {}) {
  return request('/budgets/current', { token, ...opts });
}

/**
 * GET /budgets/dashboard?recent=N  ->  BudgetDashboardOut {
 *   budget: BudgetOut,
 *   daily_split: BudgetSplitOut,
 *   health: BudgetHealthOut {
 *     warning_level: 'ok' | 'caution' | 'danger' | 'exhausted',
 *     spendable_amount, spent_amount, spent_percentage, over_daily_limit_by,
 *     warnings: string[]               <- ready to show, written for students
 *   },
 *   recent_transactions: TransactionOut[]
 * }
 * Member 3's one-call dashboard. 404 "No active budget" like /budgets/current.
 */
export function getBudgetDashboard(token, { recent } = {}, opts = {}) {
  const query = recent === undefined ? undefined : { recent };
  return request('/budgets/dashboard', { token, query, ...opts });
}

/**
 * PUT /budgets/{budget_id}  ->  BudgetOut
 * Body: BudgetUpdateRequest { total_amount?: Decimal > 0, cycle_end_date?: date,
 *                             survival_threshold?: Decimal >= 0 }
 *
 * Only those three fields are updatable. Changing total_amount shifts
 * remaining_amount by the same delta server-side, so spend already recorded is
 * preserved — the frontend must NOT try to recompute it.
 */
export function updateBudget(token, budgetId, patch, opts = {}) {
  return request(`/budgets/${encodeURIComponent(budgetId)}`, {
    method: 'PUT',
    body: patch,
    token,
    fieldHints: { 400: 'periodDays' },
    ...opts,
  });
}

/**
 * POST /budgets/{budget_id}/transactions  ->  201 TransactionResult {
 *   transaction: TransactionOut,
 *   budget: BudgetOut,              <- authoritative new remaining_amount
 *   overspend_warning: boolean,
 *   warning_message: string | null,
 *   daily_limit_warning: boolean,    <- fits the cycle, but not what is left today
 *   daily_limit_message: string | null,
 *   daily_split: BudgetSplitOut | null   <- already recalculated; no re-fetch needed
 * }
 * Body: TransactionCreateRequest {
 *   item_name: str, amount: Decimal > 0,
 *   category?: str | null, is_essential?: bool (default false)
 * }
 */
export function createTransaction(token, budgetId, body, opts = {}) {
  return request(`/budgets/${encodeURIComponent(budgetId)}/transactions`, {
    method: 'POST',
    body,
    token,
    fieldHints: { 400: 'amount' },
    ...opts,
  });
}

/** GET /budgets/{budget_id}/transactions  ->  TransactionOut[]  (newest first) */
export function listTransactions(token, budgetId, opts = {}) {
  return request(`/budgets/${encodeURIComponent(budgetId)}/transactions`, { token, ...opts });
}

/* =======================================================================
 * SEARCH  —  app/routers/search.py   (router prefix "/search")
 * =====================================================================*/

/**
 * GET /search  ->  SearchResponse { results: SearchResultItem[], count, limit, offset }
 * REQUIRES a Bearer token (Depends(get_current_user_id)).
 *
 * Query parameters, exactly as declared in search.py:
 *   q, category, brand, colour, size, store,
 *   min_price, max_price          -> compared against the effective cost (below)
 *   max_shipping_cost             -> product_offers.shipping_cost
 *   availability                  -> 'available' | 'out_of_stock' | 'unknown' | 'any'
 *                                    (default 'available')
 *   essential_only                -> products.is_essential
 *   fulfilment                    -> 'collection' | 'delivery'   (Phase 4)
 *                                    collection: price/filter/sort on the SHELF
 *                                    price, only stores you can walk into;
 *                                    delivery: price + delivery, only stores
 *                                    that deliver. Omitted: total_cost.
 *   sort                          -> 'price_asc' | 'price_desc' | 'newest' | 'rating_desc'
 *                                    ('price_*' sorts on the effective cost)
 *   limit  1..100 (default 20),  offset >= 0 (default 0)
 *
 * SearchResultItem fields:
 *   offer_id, product_id, product_name, brand, category, colour, size,
 *   is_essential, store_id, store_name, store_type, price, shipping_cost,
 *   total_cost, currency, availability_status, product_url,
 *   effective_cost, price_source, price_verified_at,
 *   delivery_available, collection_available            (Phase 4)
 */
export function search(token, params = {}, opts = {}) {
  return request('/search', { token, query: params, ...opts });
}

/* =======================================================================
 * BUDGET SPLIT  —  app/routers/budget_split.py   (router prefix "/budget-split")
 * =====================================================================*/

/**
 * GET /budget-split  ->  BudgetSplitOut {
 *   budget_id, currency, as_of, next_payout_date, days_remaining,
 *   remaining_amount, daily_limit, spent_today, remaining_today, tomorrow_limit,
 *   mode: 'normal' | 'survival', survival_threshold, message, days: DaySplitOut[]
 * }
 * Today's allowance for the user's active budget. 404 "No active budget"
 * when there is none — same shape as GET /budgets/current, and the caller
 * turns that into null; see client.js `budgetSplit.get`.
 *
 * Recalculated fresh on every call (it also writes budgets.daily_limit and
 * budget_mode back server-side), so there is no caching to worry about.
 */
export function getBudgetSplit(token, opts = {}) {
  return request('/budget-split', { token, ...opts });
}

/**
 * POST /budget-split/check  ->  AffordabilityOut {
 *   amount, affordable_today, affordable_this_cycle,
 *   remaining_today, remaining_amount, days_of_budget, message
 * }
 * Body: AffordabilityRequest { amount: Decimal > 0 }
 */
export function checkAffordability(token, { amount }, opts = {}) {
  return request('/budget-split/check', { method: 'POST', body: { amount }, token, ...opts });
}

/* =======================================================================
 * RECOMMENDATIONS  —  app/routers/recommendations.py   (prefix "/recommendations")
 * =====================================================================*/

/**
 * POST /recommendations  ->  RecommendationResponse {
 *   run_id, search_id, query, parsed: ParsedQueryOut,
 *   budget: { budget_id, remaining_amount, daily_limit, days_remaining, mode, message },
 *   results: RecommendedOffer[]  (rank, offer_id, product_name, store_name, price,
 *            true_cost, cost_breakdown, score, component_scores, meets_budget,
 *            matched_query, explanation, ...),
 *   count, candidates_considered, response_time_ms, message
 * }
 * Body: RecommendationRequest — every key optional:
 *   query, category, max_price, fulfilment ('delivery' | 'collection'),
 *   limit 1..50, include_unaffordable, candidate_pool 10..200,
 *   essential_only (Phase 4 — applied on the server BEFORE the limit)
 */
export function getRecommendations(token, body = {}, opts = {}) {
  const allowed = [
    'query', 'category', 'max_price', 'fulfilment', 'limit',
    'include_unaffordable', 'candidate_pool', 'essential_only',
  ];
  const clean = {};
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') clean[key] = body[key];
  }
  return request('/recommendations', { method: 'POST', body: clean, token, ...opts });
}

/* =======================================================================
 * TRUE COST  —  app/routers/true_cost.py   (prefix "/true-cost")
 * =====================================================================*/

/**
 * POST /true-cost  ->  TrueCostResponse {
 *   results: TrueCostOut[] { offer_id, quantity, fulfilment, subtotal, shipping,
 *            charges[], charges_total, travel_cost, true_cost, hidden_cost,
 *            distance_km, notes[], product_name, store_name }  (cheapest first),
 *   cheapest_offer_id, saving_vs_dearest
 * }
 * Body: TrueCostRequest { offer_ids: int[1..50], quantity 1..99,
 *                         fulfilment 'delivery' | 'collection', use_my_location }
 *
 * Every offer is priced as its OWN order, so this answers "which of these
 * alternatives is really cheapest" — the same product at several stores. It
 * is not a basket total: summing results would charge delivery once per item.
 */
export function getTrueCost(token, { offer_ids, quantity = 1, fulfilment = 'delivery', use_my_location = true }, opts = {}) {
  return request('/true-cost', {
    method: 'POST',
    body: { offer_ids, quantity, fulfilment, use_my_location },
    token,
    ...opts,
  });
}

/* =======================================================================
 * COMPARE  —  app/routers/compare.py   (prefix "/compare")   Phase 4
 * =====================================================================*/

/**
 * POST /compare/basket  ->  CompareBasketResponse {
 *   fulfilment, location_known,
 *   stores: StoreQuoteOut[] { store_id, store_name, store_type, distance_km,
 *           fulfilment, fulfilment_available, full, stocked, missing_count,
 *           lines[], missing[], subtotal, delivery, fees, travel, total,
 *           estimate_count, notes[] },
 *   best_single_store_id, best_plan: { total, store_count, stores[], saving_vs_best_single },
 *   unavailable[], items: [{ product_id, product_name, qty, offers[] }],
 *   prices: { listings, estimates, confirmed, all_confirmed }
 * }
 * Body: CompareBasketRequest { items: [{ product_id, qty 1..99 }] (1..50),
 *                              fulfilment 'collection' | 'delivery', use_my_location }
 *
 * The whole list as ONE order per store: delivery once per order (with the
 * free-delivery threshold judged on the basket), store fees once, travel once
 * per trip, nothing imputed for a store that lacks an item. 404 when none of
 * the products is listed anywhere any more.
 */
export function compareBasket(token, { items, fulfilment = 'collection', use_my_location = true }, opts = {}) {
  return request('/compare/basket', {
    method: 'POST',
    body: { items, fulfilment, use_my_location },
    token,
    ...opts,
  });
}

/* =======================================================================
 * PRICES  —  app/routers/prices.py   (prefix "/prices")   Phase 4
 * =====================================================================*/

/**
 * GET /prices/status  ->  PriceStatusOut {
 *   by_source: { seed_estimate: n, live_api: n, verified_manual: n },
 *   newest_verification, live_provider_configured, message
 * }
 */
export function getPriceStatus(token, opts = {}) {
  return request('/prices/status', { token, ...opts });
}

/* =======================================================================
 * HEALTH  —  app/main.py
 * =====================================================================*/

/** GET /health  ->  { status: "ok" }.  No auth. Used by the connection check. */
export function health(opts = {}) {
  return request('/health', { ...opts });
}
