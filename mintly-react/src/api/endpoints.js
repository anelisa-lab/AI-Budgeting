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
 * Body: RegisterRequest { name: str, email: EmailStr, password: str }
 *
 * The backend rejects passwords under 8 characters with a 400 before Pydantic
 * even runs. It returns 409 when the email is taken.
 *
 * NOTE: RegisterRequest has exactly three fields. Student number and residence
 * are NOT accepted (see docs/BACKEND_INTEGRATION.md, "Backend dependencies").
 */
export function register({ name, email, password }, opts = {}) {
  return request('/auth/register', {
    method: 'POST',
    body: { name, email, password },
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

/** GET /profile/  ->  UserOut { id, name, email, created_at } */
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
 * PUT /budgets/{budget_id}  ->  BudgetOut
 * Body: BudgetUpdateRequest { total_amount?: Decimal > 0, cycle_end_date?: date }
 *
 * Only those two fields are updatable. Changing total_amount shifts
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
 *   warning_message: string | null
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
 *   min_price, max_price          -> compared against product_offers.total_cost
 *   max_shipping_cost             -> product_offers.shipping_cost
 *   availability                  -> 'available' | 'out_of_stock' | 'unknown' | 'any'
 *                                    (default 'available')
 *   essential_only                -> products.is_essential
 *   sort                          -> 'price_asc' | 'price_desc' | 'newest'
 *                                    ('price_*' sorts on TOTAL cost, not item price)
 *   limit  1..100 (default 20),  offset >= 0 (default 0)
 *
 * SearchResultItem fields:
 *   offer_id, product_id, product_name, brand, category, colour, size,
 *   is_essential, store_id, store_name, store_type, price, shipping_cost,
 *   total_cost, currency, availability_status, product_url
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
 *   remaining_amount, daily_limit, spent_today, remaining_today,
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

/* =======================================================================
 * HEALTH  —  app/main.py
 * =====================================================================*/

/** GET /health  ->  { status: "ok" }.  No auth. Used by the connection check. */
export function health(opts = {}) {
  return request('/health', { ...opts });
}
