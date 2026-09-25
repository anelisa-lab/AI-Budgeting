/**
 * Frontend ⇄ backend contract test.
 *
 *     node tests/contract/run.mjs
 *
 * No dependencies, no build step, no running backend. It imports the real
 * frontend API layer (src/api/*.js) and swaps in a fetch that:
 *
 *   1. CHECKS every outgoing request against backend-routes.mjs — the path
 *      must match a route the backend declares, with the right method, the
 *      right auth header, only body keys the Pydantic model accepts, and only
 *      query parameters the route declares;
 *   2. ANSWERS with a response shaped the way FastAPI would, including
 *      Decimal-as-string, so the assertions afterwards prove the frontend
 *      consumes it correctly.
 *
 * A failure means the frontend would send something the backend rejects, or
 * read a field the backend does not send. That is the exact failure this
 * alignment pass exists to prevent, and it is worth re-running whenever either
 * side changes.
 */

import { strict as assert } from 'node:assert';

import {
  ROUTES, SORT_VALUES, AVAILABILITY_VALUES, dec,
  userOut, budgetOut, transactionOut, searchResultItem, budgetSplitOut,
  httpError, validationError,
} from './backend-routes.mjs';

// The frontend under test. Plain JS, no JSX, no React — importable as-is.
process.env.VITE_API_BASE_URL = 'http://localhost:4000';
const {
  auth, profile, budgets, budgetSplit, recommendations, transactions, search, trueCost,
} = await import('../../src/api/client.js');
const { ApiError } = await import('../../src/api/http.js');
const {
  buildSearchParams, filtersFromUrl, filtersToUrl, rank,
  priceListByStore, splitShopTotal, comparableGroups,
  chosenListTotal, validateFilters, canonicalise, describeFilters, recommendationsCanHonour,
  isRankedSort, DEFAULT_FILTERS,
} = await import('../../src/lib/search.js');
const {
  CATALOGUE_CATEGORIES, SPENDING_CATEGORIES, canonicalCategory,
} = await import('../../src/lib/categories.js');
const {
  budgetToApi, budgetToFormValues, budgetUpdateToApi, daysBetween,
} = await import('../../src/api/normalise.js');

const BASE = 'http://localhost:4000';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.test.token';

/* ------------------------------------------------------------ the harness */

let passed = 0;
const failures = [];
/** Every request the frontend made during the current test. */
let captured = [];

function test(name, fn) {
  captured = [];
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        () => { passed += 1; console.log(`  ✓ ${name}`); },
        (err) => { failures.push([name, err]); console.log(`  ✗ ${name}\n      ${err.message}`); },
      );
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
  return Promise.resolve();
}

/**
 * The checking fetch. `responder` returns { status, body } for a given request.
 */
function installFetch(responder) {
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = init.headers || {};
    const record = {
      url, path: parsed.pathname, method, body, headers,
      query: Object.fromEntries(parsed.searchParams.entries()),
    };
    captured.push(record);

    assert.equal(parsed.origin, BASE, `request went to ${parsed.origin}, not the configured base URL`);

    // --- the request must match a route the backend actually declares ------
    const route = ROUTES.find((r) => r.pattern.test(record.path) && r.method === method);
    assert.ok(
      route,
      `no backend route matches ${method} ${record.path}\n`
      + '      (the backend declares only the routes in backend-routes.mjs)',
    );

    if (route.auth) {
      assert.equal(
        headers.Authorization, `Bearer ${TOKEN}`,
        `${route.name} is a protected route; expected an "Authorization: Bearer <token>" header`,
      );
    }

    if (body !== undefined) {
      assert.ok(route.body, `${route.name} does not accept a request body`);
      for (const key of Object.keys(body)) {
        assert.ok(
          route.body.includes(key),
          `${route.name} was sent "${key}", which is not a field on its Pydantic model `
          + `(accepts: ${route.body.join(', ')})`,
        );
      }
      for (const key of route.requiredBody || []) {
        assert.ok(
          key in body && body[key] !== undefined && body[key] !== null,
          `${route.name} is missing required field "${key}"`,
        );
      }
      assert.equal(
        headers['Content-Type'], 'application/json',
        `${route.name} sent a body without a JSON Content-Type header`,
      );
    }

    for (const key of Object.keys(record.query)) {
      assert.ok(
        (route.query || []).includes(key),
        `${route.name} was sent query parameter "${key}", which the backend does not declare `
        + `(accepts: ${(route.query || []).join(', ') || 'none'})`,
      );
    }

    const { status = 200, body: payload = null } = responder(record, route) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => payload,
    };
  };
}

const lastRequest = () => captured[captured.length - 1];

/* ============================================================ AUTH ======= */

console.log('\nAuthentication');

await test('register sends exactly { name, email, password } to POST /auth/register', async () => {
  installFetch(() => ({ status: 201, body: { user: userOut(), token: TOKEN } }));
  const result = await auth.register({
    name: 'Nozibusiso Cindi',
    email: 's221234567@dut4life.ac.za',
    password: 'UniWallet2026',
    // The register screen holds these two; they must NOT reach the API.
    studentNumber: '22123456',
    residence: 'steve-biko',
  });
  const req = lastRequest();
  assert.equal(req.path, '/auth/register');
  assert.equal(req.method, 'POST');
  assert.deepEqual(Object.keys(req.body).sort(), ['email', 'name', 'password']);
  assert.equal(result.token, TOKEN);
  assert.equal(result.user.name, 'Nozibusiso Cindi');
});

await test('login posts to /auth/login and returns the user and token', async () => {
  installFetch(() => ({ status: 200, body: { user: userOut(), token: TOKEN } }));
  const result = await auth.login({ email: 'a@b.ac.za', password: 'UniWallet2026' });
  assert.equal(lastRequest().path, '/auth/login');
  assert.deepEqual(Object.keys(lastRequest().body).sort(), ['email', 'password']);
  assert.equal(result.user.id, 1);
});

await test('a 401 from login lands on the password field, not a bare banner', async () => {
  installFetch(() => ({ status: 401, body: httpError('Invalid email or password') }));
  await assert.rejects(
    () => auth.login({ email: 'a@b.ac.za', password: 'wrong' }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      assert.equal(err.message, 'Invalid email or password');
      assert.equal(err.fieldErrors.password, 'Invalid email or password');
      return true;
    },
  );
});

await test('a 409 from register lands on the email field', async () => {
  installFetch(() => ({
    status: 409, body: httpError('An account with that email already exists'),
  }));
  await assert.rejects(
    () => auth.register({ name: 'A B', email: 'taken@dut4life.ac.za', password: 'UniWallet2026' }),
    (err) => {
      assert.equal(err.fieldErrors.email, 'An account with that email already exists');
      return true;
    },
  );
});

await test("Pydantic's 422 is mapped onto the form fields that produced it", async () => {
  installFetch(() => ({
    status: 422,
    body: validationError(
      ['email', 'value is not a valid email address'],
      ['total_amount', 'Input should be greater than 0'],
    ),
  }));
  await assert.rejects(
    () => auth.register({ name: 'A B', email: 'nope', password: 'UniWallet2026' }),
    (err) => {
      assert.equal(err.status, 422);
      // `total_amount` is the backend's name; `amount` is the input's id.
      assert.ok(err.fieldErrors.email.includes('valid email address'));
      assert.equal(err.fieldErrors.amount, 'Your allowance must be more than R0.');
      return true;
    },
  );
});

await test('logout posts to /auth/logout with the bearer token', async () => {
  installFetch(() => ({ status: 200, body: { message: 'Logged out.' } }));
  await auth.logout(TOKEN);
  assert.equal(lastRequest().path, '/auth/logout');
  assert.equal(lastRequest().headers.Authorization, `Bearer ${TOKEN}`);
});

/* ========================================================= PROFILE ======= */

console.log('\nProfile');

await test('session restore calls GET /profile/ — WITH the trailing slash', async () => {
  installFetch(() => ({ status: 200, body: userOut() }));
  const me = await profile.get(TOKEN);
  // /profile would take a 307 redirect, and a cross-origin redirect is exactly
  // where a browser drops the Authorization header.
  assert.equal(lastRequest().path, '/profile/');
  assert.equal(me.email, 's221234567@dut4life.ac.za');
});

await test('PUT /profile/ sends only `name`', async () => {
  installFetch(() => ({ status: 200, body: userOut({ name: 'N Cindi' }) }));
  const updated = await profile.update(TOKEN, { name: 'N Cindi' });
  assert.deepEqual(Object.keys(lastRequest().body), ['name']);
  assert.equal(updated.name, 'N Cindi');
});

await test('preferences round-trip through /profile/preferences', async () => {
  installFetch(() => ({
    status: 200,
    body: { preferred_categories: ['Groceries'], preferred_stores: ['Shoprite'], max_distance_km: '5.00' },
  }));
  const prefs = await profile.getPreferences(TOKEN);
  assert.equal(lastRequest().path, '/profile/preferences');
  assert.deepEqual(prefs.preferred_categories, ['Groceries']);
  // NUMERIC(6,2) arrives as a string and must come out a number.
  assert.equal(prefs.max_distance_km, 5);
  assert.equal(typeof prefs.max_distance_km, 'number');
});

/* ========================================================= BUDGETS ======= */

console.log('\nBudgets');

await test('GET /budgets/current answering 404 means "no budget", not an error', async () => {
  installFetch(() => ({ status: 404, body: httpError('No active budget') }));
  const budget = await budgets.getCurrent(TOKEN);
  assert.equal(budget, null, 'a 404 must become null so the dashboard shows its empty state');
});

await test('a 500 on GET /budgets/current is NOT swallowed as "no budget"', async () => {
  installFetch(() => ({ status: 500, body: httpError('boom') }));
  await assert.rejects(() => budgets.getCurrent(TOKEN), (err) => err.status === 500);
});

await test('Decimal-as-string from Pydantic is coerced to real numbers', async () => {
  installFetch(() => ({
    status: 200,
    body: budgetOut({ total_amount: dec(1650), remaining_amount: dec(1564.5), savings_amount: dec(0) }),
  }));
  const budget = await budgets.getCurrent(TOKEN);
  assert.equal(typeof budget.total_amount, 'number', 'total_amount must not stay a string');
  assert.equal(budget.total_amount, 1650);
  assert.equal(budget.remaining_amount, 1564.5);
  // The bug this guards against: "1650.00" - 85.5 is NaN.
  assert.equal(budget.total_amount - budget.remaining_amount, 85.5);
});

await test('the budget form maps payoutDate + periodDays onto the cycle dates', async () => {
  installFetch(() => ({ status: 201, body: budgetOut() }));
  await budgets.create(TOKEN, {
    amount: 1650, payoutDate: '2026-09-21', periodDays: 30, savingsPercentage: 10,
  });
  const req = lastRequest();
  assert.equal(req.path, '/budgets');
  assert.equal(req.method, 'POST');
  assert.equal(req.body.total_amount, 1650);
  assert.equal(req.body.cycle_start_date, '2026-09-21');
  assert.equal(req.body.cycle_end_date, '2026-10-21', 'start + 30 days');
  assert.equal(req.body.savings_percentage, 10);
  assert.equal(req.body.budget_kind, 'monthly');
});

await test('budget form values round-trip through the API mapping', () => {
  const form = { amount: 1650, payoutDate: '2026-09-21', periodDays: 14, savingsPercentage: 0 };
  const sent = budgetToApi(form);
  const back = budgetToFormValues({
    total_amount: Number(sent.total_amount),
    savings_percentage: 0,
    cycle_start_date: sent.cycle_start_date,
    cycle_end_date: sent.cycle_end_date,
  });
  assert.equal(back.payoutDate, '2026-09-21');
  assert.equal(back.periodDays, '14');
  assert.equal(daysBetween(sent.cycle_start_date, sent.cycle_end_date), 14);
});

await test('PUT /budgets/{id} sends only the two fields it accepts', async () => {
  installFetch(() => ({ status: 200, body: budgetOut({ total_amount: dec(1940) }) }));
  const existing = { id: 7, cycle_start_date: '2026-09-21' };
  await budgets.update(TOKEN, existing, { amount: 1940, payoutDate: '2026-09-21', periodDays: 30 });
  const req = lastRequest();
  assert.equal(req.path, '/budgets/7');
  assert.equal(req.method, 'PUT');
  assert.deepEqual(Object.keys(req.body).sort(), ['cycle_end_date', 'total_amount']);
  assert.equal(req.body.total_amount, 1940);
});

/* ==================================================== TRANSACTIONS ======= */

console.log('\nTransactions');

await test('transactions are budget-scoped: /budgets/{id}/transactions', async () => {
  installFetch(() => ({ status: 200, body: [transactionOut()] }));
  const rows = await transactions.list(TOKEN, 7);
  assert.equal(lastRequest().path, '/budgets/7/transactions');
  assert.equal(rows[0].item_name, 'Bread and milk');
  assert.equal(rows[0].amount, 85.5);
  assert.equal(typeof rows[0].amount, 'number');
});

await test('recording a spend sends item_name (not description) and is_essential', async () => {
  installFetch(() => ({
    status: 201,
    body: {
      transaction: transactionOut(),
      budget: budgetOut({ remaining_amount: dec(1564.5) }),
      overspend_warning: false,
      warning_message: null,
    },
  }));
  const result = await transactions.create(TOKEN, 7, {
    description: 'Bread and milk', amount: 85.5, category: 'Groceries', isEssential: true,
  });
  const req = lastRequest();
  assert.equal(req.path, '/budgets/7/transactions');
  assert.equal(req.body.item_name, 'Bread and milk');
  assert.ok(!('description' in req.body), 'the backend has no `description` field');
  assert.equal(req.body.is_essential, true);
  // The response's budget is authoritative — the frontend must not re-derive it.
  assert.equal(result.budget.remaining_amount, 1564.5);
  assert.equal(result.overspend_warning, false);
});

await test("the server's overspend verdict and message are carried through", async () => {
  installFetch(() => ({
    status: 201,
    body: {
      transaction: transactionOut({ amount: dec(2000) }),
      budget: budgetOut({ remaining_amount: dec(0) }),
      overspend_warning: true,
      warning_message: 'This purchase is R350.00 over your remaining budget.',
    },
  }));
  const result = await transactions.create(TOKEN, 7, { description: 'Laptop bag', amount: 2000 });
  assert.equal(result.overspend_warning, true);
  assert.equal(result.warning_message, 'This purchase is R350.00 over your remaining budget.');
  assert.equal(result.budget.remaining_amount, 0, 'the server floors remaining at 0');
});

/* ========================================================== SEARCH ======= */

console.log('\nSearch');

await test('GET /search sends only parameters the backend declares', async () => {
  installFetch(() => ({
    status: 200,
    body: { results: [searchResultItem()], count: 1, limit: 20, offset: 0 },
  }));
  await search.offers(TOKEN, buildSearchParams({
    q: 'maize meal', category: 'Groceries', colour: '', size: '2.5kg',
    maxPrice: '45', freeShippingOnly: true, essentialOnly: true,
    availability: 'available', sort: 'price_asc',
  }));
  const req = lastRequest();
  assert.equal(req.path, '/search');
  assert.equal(req.query.q, 'maize meal');
  assert.equal(req.query.max_price, '45');
  assert.equal(req.query.max_shipping_cost, '0', '"no delivery fee" is max_shipping_cost=0');
  assert.equal(req.query.essential_only, 'true');
  assert.ok(!('colour' in req.query), 'empty filters must not be sent as ""');
  assert.ok(!('radius' in req.query), 'the backend has no radius parameter');
});

await test('search results are coerced, including the generated total_cost', async () => {
  installFetch(() => ({
    status: 200,
    body: {
      results: [searchResultItem({ price: 40.49, shipping_cost: 9.5, total_cost: 49.99 })],
      count: 1, limit: 20, offset: 0,
    },
  }));
  const page = await search.offers(TOKEN, buildSearchParams({}));
  const offer = page.results[0];
  assert.equal(typeof offer.price, 'number');
  assert.equal(offer.total_cost, 49.99);
  assert.equal(page.count, 1);
  assert.equal(page.results[0].rating, null);
});

await test('only sorts the backend implements are ever sent', () => {
  for (const value of ['distance_asc', 'rating_desc', 'total_asc', 'nonsense']) {
    const params = buildSearchParams({ sort: value });
    assert.ok(
      SORT_VALUES.includes(params.sort),
      `sort "${value}" produced "${params.sort}", which search.py's sort_map does not contain`,
    );
  }
  assert.equal(buildSearchParams({ sort: 'price_desc' }).sort, 'price_desc');
});

await test('availability is always one of the four the backend checks for', () => {
  for (const value of ['available', 'any', 'out_of_stock']) {
    assert.ok(AVAILABILITY_VALUES.includes(buildSearchParams({ availability: value }).availability));
  }
});

await test('the backend limit cap of 100 is respected', () => {
  const params = buildSearchParams({}, { limit: 100, offset: 0 });
  assert.ok(params.limit <= 100, 'search.py declares limit as Query(le=100)');
});

await test('filters survive a round-trip through the URL', () => {
  const filters = {
    q: 'rice', category: 'Groceries', brand: 'Tastic', colour: '', size: '2kg',
    store: 'Shoprite', minPrice: '40', maxPrice: '60', freeShippingOnly: true, essentialOnly: false,
    availability: 'any', sort: 'price_desc',
  };
  const back = filtersFromUrl(new URLSearchParams(filtersToUrl(filters).toString()));
  assert.equal(back.q, 'rice');
  assert.equal(back.minPrice, '40');
  assert.equal(back.maxPrice, '60');
  assert.equal(back.freeShippingOnly, true);
  assert.equal(back.essentialOnly, false);
  assert.equal(back.availability, 'any');
  assert.equal(back.sort, 'price_desc');
});

/* ================================================ RANKING & COMPARE ====== */

console.log('\nRanking and comparison');

await test('the ranker orders backend offers without dropping any', () => {
  const offers = [
    { offer_id: 1, product_id: 1, total_cost: 60, price: 60, shipping_cost: 0, store_name: 'A', category: 'Groceries', availability_status: 'available', is_essential: false },
    { offer_id: 2, product_id: 1, total_cost: 40, price: 40, shipping_cost: 0, store_name: 'B', category: 'Groceries', availability_status: 'available', is_essential: false },
    { offer_id: 3, product_id: 1, total_cost: 50, price: 45, shipping_cost: 5, store_name: 'C', category: 'Groceries', availability_status: 'out_of_stock', is_essential: false },
  ];
  const ranked = rank(offers, { budget: 100, preferences: null });
  assert.equal(ranked.length, 3, 'ranking must not filter — the backend owns filtering');
  assert.equal(ranked[0].offer_id, 2, 'the cheapest in-stock offer should rank first');
  assert.ok(ranked[0].why.length > 0, 'every recommendation must carry its reason');
});

await test('stored preferences from the backend influence the ranking', () => {
  const offers = [
    { offer_id: 1, product_id: 1, total_cost: 42, price: 42, shipping_cost: 0, store_name: 'Shoprite', category: 'Groceries', availability_status: 'available', is_essential: false },
    { offer_id: 2, product_id: 1, total_cost: 40, price: 40, shipping_cost: 0, store_name: 'Makro', category: 'Groceries', availability_status: 'available', is_essential: false },
  ];
  const plain = rank(offers, { budget: 100 });
  const preferred = rank(offers, { budget: 100, preferences: { preferred_stores: ['Shoprite'], preferred_categories: [] } });
  assert.equal(plain[0].offer_id, 2);
  assert.ok(
    preferred.find((o) => o.offer_id === 1).score > plain.find((o) => o.offer_id === 1).score,
    'a preferred store must score higher than it does without the preference',
  );
});

await test('a store is only "complete" when it stocks every line', () => {
  const lines = [
    { product_id: 1, qty: 1, price: 40 },
    { product_id: 2, qty: 2, price: 20 },
  ];
  const offersByProduct = new Map([
    [1, [
      { offer_id: 1, product_id: 1, store_id: 10, store_name: 'Full Store', store_type: 'physical', price: 40, shipping_cost: 0, total_cost: 40, product_name: 'A', size: '1kg', availability_status: 'available' },
      { offer_id: 2, product_id: 1, store_id: 20, store_name: 'Partial Store', store_type: 'physical', price: 30, shipping_cost: 0, total_cost: 30, product_name: 'A', size: '1kg', availability_status: 'available' },
    ]],
    [2, [
      { offer_id: 3, product_id: 2, store_id: 10, store_name: 'Full Store', store_type: 'physical', price: 20, shipping_cost: 0, total_cost: 20, product_name: 'B', size: '2kg', availability_status: 'available' },
    ]],
  ]);

  const rows = priceListByStore(lines, offersByProduct);
  const full = rows.filter((r) => r.full);
  assert.equal(full.length, 1);
  assert.equal(full[0].store.store_name, 'Full Store');
  assert.equal(rows[0].store.store_name, 'Full Store', 'a complete shop outranks a cheaper incomplete one');
  // Partial Store is cheaper per item but misses a line; it must not come first.
  const partial = rows.find((r) => r.store.store_name === 'Partial Store');
  assert.equal(partial.missing, 1);
  assert.equal(partial.total, null, 'incomplete stores must not receive a synthetic total');
});

await test('a physical store is not charged delivery; an online one is charged once', () => {
  const lines = [{ product_id: 1, qty: 1, price: 40 }, { product_id: 2, qty: 1, price: 20 }];
  const offersByProduct = new Map([
    [1, [{ offer_id: 1, product_id: 1, store_id: 30, store_name: 'Takealot', store_type: 'online', price: 40, shipping_cost: 60, total_cost: 100, product_name: 'A', availability_status: 'available' }]],
    [2, [{ offer_id: 2, product_id: 2, store_id: 30, store_name: 'Takealot', store_type: 'online', price: 20, shipping_cost: 60, total_cost: 80, product_name: 'B', availability_status: 'available' }]],
  ]);
  const [row] = priceListByStore(lines, offersByProduct);
  assert.equal(row.subtotal, 60);
  assert.equal(row.delivery, 60, 'one delivery charge, not one per line');
  assert.equal(row.total, 120);
});

await test('the split-shop total buys each line wherever it is cheapest', () => {
  const lines = [{ product_id: 1, qty: 2, price: 40 }];
  const offersByProduct = new Map([
    [1, [
      { offer_id: 1, product_id: 1, store_id: 10, store_name: 'A', store_type: 'physical', price: 40, shipping_cost: 0, total_cost: 40, product_name: 'Rice', size: '2kg', availability_status: 'available' },
      { offer_id: 2, product_id: 1, store_id: 20, store_name: 'B', store_type: 'physical', price: 31, shipping_cost: 0, total_cost: 31, product_name: 'Rice', size: '2kg', availability_status: 'available' },
    ]],
  ]);
  assert.equal(splitShopTotal(lines, offersByProduct), 62);
  const [group] = comparableGroups(lines, offersByProduct);
  assert.equal(group.saving, 9);
  assert.equal(group.cheapest.store_name, 'B');
});

/* ========================================================= PHASE 3 ===== */

console.log('\nPhase 3 — dashboard, Daily Budget Split, recommendations');

await test('GET /budgets/dashboard is coerced into budget, split and health', async () => {
  installFetch((req) => (req.path === '/budgets' ? { body: [budgetOut()] } : {
    body: {
      budget: budgetOut({ daily_limit: dec(78.62), budget_mode: 'normal' }),
      daily_split: budgetSplitOut(),
      health: {
        warning_level: 'caution', spendable_amount: dec(1650), spent_amount: dec(450),
        spent_percentage: '27.3', over_daily_limit_by: dec(0), warnings: ['Careful.'],
      },
      recent_transactions: [transactionOut()],
    },
  }));
  const dash = await budgets.getDashboard(TOKEN);
  assert.equal(captured[0].path, '/budgets', 'checks for an active budget first');
  assert.equal(lastRequest().path, '/budgets/dashboard');
  assert.equal(dash.budget.remaining_amount, 1650);
  assert.equal(dash.split.daily_limit, 78.62);
  assert.equal(dash.split.tomorrow_limit, 78.62);
  assert.equal(dash.health.warning_level, 'caution');
  assert.equal(dash.health.spent_percentage, 27.3);
  assert.deepEqual(dash.health.warnings, ['Careful.']);
  assert.equal(dash.recent_transactions[0].amount, 85.5);
});

await test('a 404 from GET /budgets/dashboard is the empty state, not an error', async () => {
  installFetch(() => ({ status: 404, body: httpError('No active budget') }));
  assert.equal(await budgets.getDashboard(TOKEN, { knownActive: true }), null);
});

await test('a student with no active budget never triggers the 404 at all', async () => {
  installFetch((req) => (req.path === '/budgets' ? { body: [budgetOut({ status: 'closed' })] } : { status: 500, body: httpError('should not be called') }));
  assert.equal(await budgets.getDashboard(TOKEN), null);
  assert.equal(captured.length, 1, 'only GET /budgets is asked');
});

await test('tomorrow_limit stays null on payout day instead of becoming 0', async () => {
  installFetch(() => ({ body: budgetSplitOut({ tomorrow_limit: null, days_remaining: 1 }) }));
  const split = await budgetSplit.get(TOKEN);
  assert.equal(split.tomorrow_limit, null);
});

await test('a transaction result carries the daily warning and the fresh split', async () => {
  installFetch(() => ({
    status: 201,
    body: {
      transaction: transactionOut(), budget: budgetOut({ remaining_amount: dec(1100) }),
      overspend_warning: false, warning_message: null,
      daily_limit_warning: true, daily_limit_message: 'More than today.',
      daily_split: budgetSplitOut({ remaining_today: dec(0) }),
    },
  }));
  const result = await transactions.create(TOKEN, 7, { description: 'Shoes', amount: 150 });
  assert.equal(result.daily_limit_warning, true);
  assert.equal(result.daily_limit_message, 'More than today.');
  assert.equal(result.daily_split.remaining_today, 0);
});

await test('POST /budget-split/check sends only { amount }', async () => {
  installFetch(() => ({
    body: {
      amount: dec(250), affordable_today: false, affordable_this_cycle: true,
      remaining_today: dec(20.63), remaining_amount: dec(1200), days_of_budget: '3.2',
      message: 'R250.00 is over today\'s R20.63.',
    },
  }));
  const verdict = await budgetSplit.check(TOKEN, 250);
  assert.deepEqual(lastRequest().body, { amount: 250 });
  assert.equal(verdict.days_of_budget, 3.2);
  assert.equal(verdict.affordable_this_cycle, true);
});

await test('POST /recommendations drops empty keys and coerces every result', async () => {
  installFetch(() => ({
    body: {
      run_id: 3, search_id: 4, query: 'bread',
      parsed: { keywords: ['bread'] },
      budget: {
        budget_id: 7, remaining_amount: dec(1200), daily_limit: dec(78.62),
        days_remaining: 16, mode: 'survival', message: 'Survival mode.',
      },
      results: [{
        rank: 1, offer_id: 11, product_id: 2, product_name: 'Brown Bread',
        store_name: 'Shoprite', store_type: 'physical', price: dec(17.95),
        true_cost: dec(21.45), currency: 'ZAR', distance_km: 1.2, score: 0.83,
        component_scores: { relevance: 1 }, meets_budget: true, meets_preferences: true,
        matched_query: false, explanation: 'Cheapest.', is_essential: true,
        cost_breakdown: { shipping: dec(3.5), hidden_cost: dec(3.5) },
      }],
      count: 1, candidates_considered: 9, response_time_ms: 12, message: null,
    },
  }));
  const recs = await recommendations.get(TOKEN, { query: 'bread', category: '', max_price: undefined, limit: 3 });
  assert.deepEqual(lastRequest().body, { query: 'bread', limit: 3 });
  assert.equal(recs.budget.mode, 'survival');
  const [top] = recs.results;
  assert.equal(top.true_cost, 21.45);
  assert.equal(top.hidden_cost, 3.5);
  assert.equal(top.matched_query, false);
  assert.equal(top.explanation, 'Cheapest.');
});

await test('POST /true-cost sends offer ids + quantity and coerces the breakdown', async () => {
  installFetch(() => ({
    body: {
      results: [{
        offer_id: 11, currency: 'ZAR', quantity: 2, fulfilment: 'collection',
        subtotal: dec(35.9), shipping: dec(0), charges_total: dec(5.5), travel_cost: dec(12),
        true_cost: dec(53.4), hidden_cost: dec(17.5), distance_km: 2.4, notes: [],
        charges: [{ label: 'Card payment surcharge', charge_type: 'card', amount: dec(3.5), waived: false }],
        product_name: 'Brown Bread', store_name: 'Shoprite',
      }],
      cheapest_offer_id: 11, saving_vs_dearest: dec(0),
    },
  }));
  const res = await trueCost.compare(TOKEN, [11, 12], { quantity: 2, fulfilment: 'collection' });
  assert.deepEqual(lastRequest().body, {
    offer_ids: [11, 12], quantity: 2, fulfilment: 'collection', use_my_location: true,
  });
  assert.equal(res.results[0].true_cost, 53.4);
  assert.equal(res.results[0].charges[0].amount, 3.5);
  assert.equal(res.cheapest_offer_id, 11);
});

await test('no offer ids means no /true-cost request at all', async () => {
  installFetch(() => { throw new Error('should not be called'); });
  const res = await trueCost.compare(TOKEN, []);
  assert.deepEqual(res.results, []);
});

await test('survival threshold round-trips through create, edit and update', () => {
  const body = budgetToApi({ amount: 1650, payoutDate: '2026-09-01', periodDays: 30, survivalThreshold: '200' });
  assert.equal(body.survival_threshold, 200);
  assert.equal(budgetToApi({ amount: 1650, payoutDate: '2026-09-01', periodDays: 30 }).survival_threshold, null);
  const form = budgetToFormValues({ total_amount: 1650, cycle_start_date: '2026-09-01',
    cycle_end_date: '2026-10-01', savings_percentage: 0, survival_threshold: 200 });
  assert.equal(form.survivalThreshold, '200');
  assert.deepEqual(budgetUpdateToApi({ survivalThreshold: '' }, {}), {});
  assert.deepEqual(budgetUpdateToApi({ survivalThreshold: '0' }, {}), { survival_threshold: 0 });
});

await test('the same product added from two stores is one item-by-item group', () => {
  const offers = [
    { offer_id: 1, product_id: 5, store_id: 1, product_name: 'Bread', store_name: 'A', price: 20, total_cost: 20, availability_status: 'available' },
    { offer_id: 2, product_id: 5, store_id: 2, product_name: 'Bread', store_name: 'B', price: 18, total_cost: 18, availability_status: 'available' },
  ];
  const lines = [
    { offer_id: 1, product_id: 5, qty: 1, price: 20 },
    { offer_id: 2, product_id: 5, qty: 2, price: 18 },
  ];
  const groups = comparableGroups(lines, new Map([[5, offers]]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].qty, 3);
});

/* ========================================================= PHASE 4 ===== */

console.log('\nPhase 4 — search filters, compare accuracy, categories');

const offer = (o) => ({
  product_name: 'Item', size: '1kg', shipping_cost: 0, availability_status: 'available',
  store_type: 'physical', ...o, total_cost: (o.price ?? 0) + (o.shipping_cost ?? 0),
});

await test('"Best value" is the default and is sent to the backend as price_asc', () => {
  assert.equal(DEFAULT_FILTERS.sort, 'best');
  assert.equal(buildSearchParams({}).sort, 'price_asc');
  assert.ok(isRankedSort('best'));
});

await test('"Total cost: low to high" is NOT re-ranked by the app', () => {
  assert.equal(isRankedSort('price_asc'), false);
  assert.equal(buildSearchParams({ sort: 'price_asc' }).sort, 'price_asc');
  assert.equal(buildSearchParams({ sort: 'rating_desc' }).sort, 'rating_desc');
});

await test('a minimum above the maximum is caught before any request is made', () => {
  assert.ok(validateFilters({ minPrice: '100', maxPrice: '50' }).minPrice);
  assert.deepEqual(validateFilters({ minPrice: '10', maxPrice: '50' }), {});
  assert.deepEqual(validateFilters({ minPrice: '', maxPrice: '' }), {});
});

await test('typed brand/size/store values snap to the catalogue spelling', () => {
  assert.equal(canonicalise('2 kg', ['1kg', '2kg']), '2kg');
  assert.equal(canonicalise('tastic', ['Tastic', 'Albany']), 'Tastic');
  assert.equal(canonicalise('Something new', ['Tastic']), 'Something new');
  assert.equal(canonicalise('  ', ['Tastic']), '');
});

await test('combined filters all reach the backend together', () => {
  const p = buildSearchParams({
    q: 'rice', category: 'Groceries', brand: 'Tastic', size: '2kg', store: 'Shoprite Warwick Junction',
    minPrice: '10', maxPrice: '60', freeShippingOnly: true, essentialOnly: true, availability: 'any', sort: 'price_desc',
  });
  assert.deepEqual(
    { q: p.q, category: p.category, brand: p.brand, size: p.size, store: p.store, min: p.min_price, max: p.max_price, ship: p.max_shipping_cost, ess: p.essential_only, av: p.availability, sort: p.sort },
    { q: 'rice', category: 'Groceries', brand: 'Tastic', size: '2kg', store: 'Shoprite Warwick Junction', min: 10, max: 60, ship: 0, ess: true, av: 'any', sort: 'price_desc' },
  );
});

await test('active filters become removable chips, and clearing resets them', () => {
  const chips = describeFilters({ q: 'rice', store: 'Makro', essentialOnly: true });
  assert.deepEqual(chips.map((c) => c.key), ['q', 'store', 'essentialOnly']);
  assert.deepEqual(chips[1].reset, { store: '' });
  assert.equal(describeFilters(DEFAULT_FILTERS).length, 0);
});

await test('recommendations are hidden when a filter they cannot honour is on', () => {
  assert.equal(recommendationsCanHonour({ q: 'rice', category: 'Groceries', maxPrice: '50' }), true);
  assert.equal(recommendationsCanHonour({ q: 'rice', store: 'Shoprite' }), false);
  assert.equal(recommendationsCanHonour({ q: 'rice', brand: 'Tastic' }), false);
});

await test('an out-of-stock listing does not make a store "complete" or cheapest', () => {
  const lines = [{ offer_id: 1, product_id: 1, qty: 1, price: 10, store_id: 1 }];
  const map = new Map([[1, [
    offer({ offer_id: 1, product_id: 1, store_id: 1, store_name: 'Cheap', price: 10, availability_status: 'out_of_stock' }),
    offer({ offer_id: 2, product_id: 1, store_id: 2, store_name: 'Stocked', price: 12 }),
  ]]]);
  const rows = priceListByStore(lines, map);
  assert.equal(rows[0].store.store_name, 'Stocked');
  const cheap = rows.find((r) => r.store.store_name === 'Cheap');
  assert.equal(cheap.full, false);
  assert.equal(cheap.outOfStock, 1);
  assert.equal(splitShopTotal(lines, map), 12, 'split shop ignores out-of-stock offers too');
});

await test('collecting from a store you can walk into has no delivery, even a "mixed" one', () => {
  const lines = [{ offer_id: 1, product_id: 1, qty: 2, price: 10, store_id: 1 }];
  const map = new Map([[1, [offer({ offer_id: 1, product_id: 1, store_id: 1, store_name: 'M', store_type: 'mixed', price: 10, shipping_cost: 35 })]]]);
  assert.equal(priceListByStore(lines, map, { fulfilment: 'collection' })[0].total, 20);
  assert.equal(priceListByStore(lines, map, { fulfilment: 'delivery' })[0].total, 55);
});

await test('the list "as chosen" uses live prices and one delivery per store', () => {
  const lines = [
    { offer_id: 1, product_id: 1, qty: 2, price: 9, store_id: 1, store_type: 'physical', shipping_cost: 40 },
    { offer_id: 2, product_id: 2, qty: 1, price: 30, store_id: 1, store_type: 'physical', shipping_cost: 40 },
    { offer_id: 3, product_id: 3, qty: 1, price: 5, store_id: 2, store_type: 'physical', shipping_cost: 0 },
  ];
  const map = new Map([
    [1, [offer({ offer_id: 1, product_id: 1, store_id: 1, price: 10, shipping_cost: 40 })]],
    [2, [offer({ offer_id: 2, product_id: 2, store_id: 1, price: 30, shipping_cost: 35 })]],
    [3, [offer({ offer_id: 3, product_id: 3, store_id: 2, price: 5, availability_status: 'out_of_stock' })]],
  ]);
  const delivered = chosenListTotal(lines, map, { fulfilment: 'delivery' });
  assert.equal(delivered.items, 50, 'today\'s price (R10), not the saved R9');
  assert.equal(delivered.delivery, 40, 'one delivery for store 1, the larger fee');
  assert.equal(delivered.total, 90);
  assert.equal(delivered.unavailable.length, 1, 'the out-of-stock line is reported, not priced');
  assert.equal(chosenListTotal(lines, map, { fulfilment: 'collection' }).total, 50);
});

await test('there is one category list, and it includes Maintenance', () => {
  assert.ok(CATALOGUE_CATEGORIES.some((c) => c.value === 'Maintenance'));
  for (const c of CATALOGUE_CATEGORIES) {
    assert.ok(SPENDING_CATEGORIES.some((x) => x.value === c.value), `${c.value} is also a spending category`);
  }
  assert.equal(canonicalCategory('maintenance'), 'Maintenance');
  assert.equal(canonicalCategory('groceries'), 'Groceries');
});

/* ==================================================== NETWORK FAULTS ===== */

console.log('\nFailure handling');

await test('an unreachable backend produces a readable message, not a raw TypeError', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(
    () => profile.get(TOKEN),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 0);
      assert.ok(/could not reach the server/i.test(err.message));
      return true;
    },
  );
});

/* ------------------------------------------------------------- the tally */

const total = passed + failures.length;
console.log(`\n${passed}/${total} contract checks passed.`);
if (failures.length) {
  console.log('\nFailures:');
  for (const [name, err] of failures) console.log(`  · ${name}\n    ${err.stack?.split('\n')[0]}`);
  process.exit(1);
}
