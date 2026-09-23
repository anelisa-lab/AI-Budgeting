/**
 * The backend's routes and schemas, transcribed for testing.
 *
 * ⚠ THIS IS NOT A BACKEND AND NOTHING IN src/ IMPORTS IT. ⚠
 *
 * It is a test fixture: a table of what `AI-Budgeting-main/app` declares, so
 * `run.mjs` can assert that the requests the frontend builds would be accepted
 * by the real API — the right path, the right method, the right body keys, and
 * no query parameter the backend does not declare.
 *
 * Everything below was read off these files:
 *   app/main.py            the router mounts and /health
 *   app/routers/auth.py    /auth/register, /auth/login, /auth/logout
 *   app/routers/profile.py /profile/, /profile/preferences
 *   app/routers/budgets.py /budgets, /budgets/current, /budgets/{id}, …
 *   app/routers/search.py  /search and its query parameters
 *   app/routers/budget_split.py      /budget-split, /budget-split/check
 *   app/routers/recommendations.py   /recommendations
 *   app/routers/true_cost.py         /true-cost
 *   app/schemas.py         every request and response model
 *
 * The responses it produces deliberately serialise Decimal as a STRING, the
 * way Pydantic v2 does over JSON ("1650.00", not 1650). Half the point of the
 * test is proving the frontend copes with that.
 *
 * If the backend changes, update this file and re-run the test — a failure
 * here means the frontend and the backend have drifted apart.
 */

/** Pydantic v2 serialises Decimal to a string over JSON. Mimic that exactly. */
export const dec = (n) => Number(n).toFixed(2);

/**
 * method + path pattern + what the route accepts.
 *   body:  the keys the Pydantic request model declares
 *   requiredBody: the subset with no default
 *   query: the ONLY query parameters the route declares
 *   auth:  whether get_current_user_id is a dependency
 */
export const ROUTES = [
  {
    name: 'health',
    method: 'GET', pattern: /^\/health$/, auth: false,
  },
  {
    name: 'register',
    method: 'POST', pattern: /^\/auth\/register$/, auth: false,
    body: ['name', 'email', 'password'],
    requiredBody: ['name', 'email', 'password'],
  },
  {
    name: 'login',
    method: 'POST', pattern: /^\/auth\/login$/, auth: false,
    body: ['email', 'password'],
    requiredBody: ['email', 'password'],
  },
  {
    name: 'logout',
    method: 'POST', pattern: /^\/auth\/logout$/, auth: true,
  },
  {
    name: 'getProfile',
    method: 'GET', pattern: /^\/profile\/$/, auth: true,
  },
  {
    name: 'updateProfile',
    method: 'PUT', pattern: /^\/profile\/$/, auth: true,
    body: ['name'], requiredBody: ['name'],
  },
  {
    name: 'getPreferences',
    method: 'GET', pattern: /^\/profile\/preferences$/, auth: true,
  },
  {
    name: 'updatePreferences',
    method: 'PUT', pattern: /^\/profile\/preferences$/, auth: true,
    body: ['preferred_categories', 'preferred_stores', 'max_distance_km'],
    requiredBody: [],
  },
  {
    name: 'createBudget',
    method: 'POST', pattern: /^\/budgets$/, auth: true,
    body: [
      'total_amount', 'cycle_start_date', 'cycle_end_date', 'budget_kind', 'savings_percentage',
      'survival_threshold',
    ],
    requiredBody: ['total_amount', 'cycle_start_date', 'cycle_end_date'],
  },
  {
    name: 'listBudgets',
    method: 'GET', pattern: /^\/budgets$/, auth: true,
  },
  {
    name: 'getCurrentBudget',
    method: 'GET', pattern: /^\/budgets\/current$/, auth: true,
  },
  {
    name: 'getBudgetDashboard',
    method: 'GET', pattern: /^\/budgets\/dashboard$/, auth: true,
    query: ['recent'],
  },
  {
    name: 'updateBudget',
    method: 'PUT', pattern: /^\/budgets\/\d+$/, auth: true,
    body: ['total_amount', 'cycle_end_date', 'survival_threshold'], requiredBody: [],
  },
  {
    name: 'createTransaction',
    method: 'POST', pattern: /^\/budgets\/\d+\/transactions$/, auth: true,
    body: ['item_name', 'amount', 'category', 'is_essential'],
    requiredBody: ['item_name', 'amount'],
  },
  {
    name: 'listTransactions',
    method: 'GET', pattern: /^\/budgets\/\d+\/transactions$/, auth: true,
  },
  {
    name: 'search',
    method: 'GET', pattern: /^\/search$/, auth: true,
    query: [
      'q', 'category', 'brand', 'colour', 'size', 'store',
      'min_price', 'max_price', 'max_shipping_cost',
      'availability', 'essential_only', 'sort', 'limit', 'offset', 'page',
    ],
  },
  {
    name: 'getBudgetSplit',
    method: 'GET', pattern: /^\/budget-split$/, auth: true,
  },
  {
    name: 'checkAffordability',
    method: 'POST', pattern: /^\/budget-split\/check$/, auth: true,
    body: ['amount'], requiredBody: ['amount'],
  },
  {
    name: 'getRecommendations',
    method: 'POST', pattern: /^\/recommendations$/, auth: true,
    body: [
      'query', 'category', 'max_price', 'fulfilment', 'limit',
      'include_unaffordable', 'candidate_pool',
    ],
    requiredBody: [],
  },
  {
    name: 'getTrueCost',
    method: 'POST', pattern: /^\/true-cost$/, auth: true,
    body: ['offer_ids', 'quantity', 'fulfilment', 'use_my_location'],
    requiredBody: ['offer_ids'],
  },
];

/** app/routers/search.py sort_map keys. Anything else falls back to price_asc. */
export const SORT_VALUES = ['price_asc', 'price_desc', 'newest'];
/** search.py availability check. */
export const AVAILABILITY_VALUES = ['available', 'out_of_stock', 'unknown', 'any'];

/* ---------------------------------------------------------------- payloads */

export function userOut(over = {}) {
  return {
    id: 1, name: 'Nozibusiso Cindi', email: 's221234567@dut4life.ac.za',
    created_at: '2026-09-21T08:00:00+00:00', ...over,
  };
}

export function budgetOut(over = {}) {
  const base = {
    id: 7, user_id: 1, budget_kind: 'monthly', status: 'active', currency: 'ZAR',
    total_amount: dec(1650), remaining_amount: dec(1650),
    savings_percentage: dec(0), savings_amount: dec(0),
    cycle_start_date: '2026-09-21', cycle_end_date: '2026-10-21',
    created_at: '2026-09-21T08:00:00+00:00', updated_at: '2026-09-21T08:00:00+00:00',
  };
  return { ...base, ...over };
}

export function transactionOut(over = {}) {
  return {
    id: 31, user_id: 1, budget_id: 7, item_name: 'Bread and milk',
    amount: dec(85.5), category: 'Groceries', is_essential: true,
    transaction_date: '2026-09-22T09:00:00+00:00',
    created_at: '2026-09-22T09:00:00+00:00', ...over,
  };
}

export function searchResultItem(over = {}) {
  const price = over.price ?? 40.49;
  const shipping = over.shipping_cost ?? 0;
  return {
    offer_id: 101, product_id: 11, product_name: 'Super Maize Meal',
    brand: 'Ace', category: 'Groceries', colour: null, size: '2.5kg',
    is_essential: true, store_id: 3, store_name: 'Shoprite Warwick Junction',
    store_type: 'physical',
    price: dec(price), shipping_cost: dec(shipping), total_cost: dec(price + shipping),
    currency: 'ZAR', availability_status: 'available', product_url: null,
    ...over,
    ...(over.price !== undefined ? { price: dec(over.price) } : {}),
    ...(over.shipping_cost !== undefined ? { shipping_cost: dec(over.shipping_cost) } : {}),
    ...(over.total_cost !== undefined ? { total_cost: dec(over.total_cost) } : {}),
  };
}

/* ----------------------------------------------------------- error bodies */

/** FastAPI HTTPException: {"detail": "..."} */
export const httpError = (message) => ({ detail: message });

/** Pydantic 422: {"detail": [{type, loc, msg, input}]} */
export const validationError = (...fields) => ({
  detail: fields.map(([field, msg]) => ({
    type: 'value_error', loc: ['body', field], msg, input: null,
  })),
});

/** BudgetSplitOut, serialised the way FastAPI does. */
export function budgetSplitOut(over = {}) {
  return {
    budget_id: 7, currency: 'ZAR', as_of: '2026-09-23', next_payout_date: '2026-10-08',
    days_remaining: 16, remaining_amount: dec(1200), daily_limit: dec(78.62),
    spent_today: dec(57.99), remaining_today: dec(20.63), tomorrow_limit: dec(78.62),
    mode: 'normal', survival_threshold: null,
    message: 'R1257.99 over 16 days gives you R78.62 a day. You have R20.63 left to spend today.',
    days: [],
    ...over,
  };
}
