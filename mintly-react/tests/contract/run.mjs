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
  userOut, budgetOut, transactionOut, searchResultItem,
  httpError, validationError,
} from './backend-routes.mjs';

// The frontend under test. Plain JS, no JSX, no React — importable as-is.
process.env.VITE_API_BASE_URL = 'http://localhost:4000';
const { auth, profile, budgets, transactions, search } = await import('../../src/api/client.js');
const { ApiError } = await import('../../src/api/http.js');
const {
  buildSearchParams, filtersFromUrl, filtersToUrl, rank,
  priceListByStore, splitShopTotal, comparableGroups,
} = await import('../../src/lib/search.js');
const { budgetToApi, budgetToFormValues, daysBetween } = await import('../../src/api/normalise.js');

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
    password: 'Mintly2026',
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
  const result = await auth.login({ email: 'a@b.ac.za', password: 'Mintly2026' });
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
    () => auth.register({ name: 'A B', email: 'taken@dut4life.ac.za', password: 'Mintly2026' }),
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
    () => auth.register({ name: 'A B', email: 'nope', password: 'Mintly2026' }),
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
    store: 'Shoprite', maxPrice: '60', freeShippingOnly: true, essentialOnly: false,
    availability: 'any', sort: 'price_desc',
  };
  const back = filtersFromUrl(new URLSearchParams(filtersToUrl(filters).toString()));
  assert.equal(back.q, 'rice');
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
      { offer_id: 1, product_id: 1, store_id: 10, store_name: 'Full Store', store_type: 'physical', price: 40, shipping_cost: 0, total_cost: 40, product_name: 'A', size: '1kg' },
      { offer_id: 2, product_id: 1, store_id: 20, store_name: 'Partial Store', store_type: 'physical', price: 30, shipping_cost: 0, total_cost: 30, product_name: 'A', size: '1kg' },
    ]],
    [2, [
      { offer_id: 3, product_id: 2, store_id: 10, store_name: 'Full Store', store_type: 'physical', price: 20, shipping_cost: 0, total_cost: 20, product_name: 'B', size: '2kg' },
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
  assert.ok(partial.total < full[0].total, 'and its total really is lower — which is the trap');
});

await test('a physical store is not charged delivery; an online one is charged once', () => {
  const lines = [{ product_id: 1, qty: 1, price: 40 }, { product_id: 2, qty: 1, price: 20 }];
  const offersByProduct = new Map([
    [1, [{ offer_id: 1, product_id: 1, store_id: 30, store_name: 'Takealot', store_type: 'online', price: 40, shipping_cost: 60, total_cost: 100, product_name: 'A' }]],
    [2, [{ offer_id: 2, product_id: 2, store_id: 30, store_name: 'Takealot', store_type: 'online', price: 20, shipping_cost: 60, total_cost: 80, product_name: 'B' }]],
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
      { offer_id: 1, product_id: 1, store_id: 10, store_name: 'A', store_type: 'physical', price: 40, shipping_cost: 0, total_cost: 40, product_name: 'Rice', size: '2kg' },
      { offer_id: 2, product_id: 1, store_id: 20, store_name: 'B', store_type: 'physical', price: 31, shipping_cost: 0, total_cost: 31, product_name: 'Rice', size: '2kg' },
    ]],
  ]);
  assert.equal(splitShopTotal(lines, offersByProduct), 62);
  const [group] = comparableGroups(lines, offersByProduct);
  assert.equal(group.saving, 9);
  assert.equal(group.cheapest.store_name, 'B');
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
