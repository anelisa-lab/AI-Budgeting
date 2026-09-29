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
  auth, profile, budgets, budgetSplit, recommendations, transactions, search, trueCost, compare,
  shoppingList,
} = await import('../../src/api/client.js');
const { ApiError } = await import('../../src/api/http.js');
const {
  buildSearchParams, filtersFromUrl, filtersToUrl, rank,
  basketOffersByProduct, itemGroups,
  chosenListTotal, validateFilters, canonicalise, describeFilters, recommendationsCanHonour,
  isRankedSort, DEFAULT_FILTERS, isBuyable,
} = await import('../../src/lib/search.js');
const {
  CATALOGUE_CATEGORIES, SPENDING_CATEGORIES, canonicalCategory, CATEGORIES_WITHOUT_LISTINGS,
} = await import('../../src/lib/categories.js');
const {
  budgetToApi, budgetToFormValues, budgetUpdateToApi, daysBetween,
  budgetRenewToApi, thresholdOrNull, categoriesToApi, templateToApi, transactionToApi,
  transactionUpdateToApi, dashboardFromApi,
} = await import('../../src/api/normalise.js');
const { categories: budgetCategories } = await import('../../src/api/client.js');
const {
  previewNewBudget, previewRenewal, previewEdit, floorCents, daysToPayout,
} = await import('../../src/lib/budgetMath.js');
const {
  PLANNER_SUGGESTIONS, cleanPlannerName, plannerNameError, spendCategoryOptions, periodWord,
} = await import('../../src/lib/categories.js');
const { validDate, dateWithin } = await import('../../src/lib/validation.js');

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

    const { status = 200, body: payload = null, file = null } = responder(record, route) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (h) => {
          const key = h.toLowerCase();
          // A file response (the spreadsheet download) is binary with a filename.
          if (file) {
            if (key === 'content-type') return file.type;
            if (key === 'content-disposition') return `attachment; filename="${file.name}"`;
            return null;
          }
          return key === 'content-type' ? 'application/json' : null;
        },
      },
      json: async () => payload,
      blob: async () => new Blob([file ? file.bytes : '']),
    };
  };
}

const lastRequest = () => captured[captured.length - 1];

/* ============================================================ AUTH ======= */

console.log('\nAuthentication');

await test('register sends name, email, password, residence and student number', async () => {
  installFetch(() => ({
    status: 201,
    body: { user: userOut({ residence: 'berea', student_number: '22123456' }), token: TOKEN },
  }));
  const result = await auth.register({
    name: 'Nozibusiso Cindi',
    email: 's221234567@dut4life.ac.za',
    password: 'UniWallet2026',
    student_number: '22123456',
    residence: 'berea',
  });
  const req = lastRequest();
  assert.equal(req.path, '/auth/register');
  assert.equal(req.method, 'POST');
  assert.deepEqual(Object.keys(req.body).sort(), ['email', 'name', 'password', 'residence', 'student_number']);
  assert.equal(result.token, TOKEN);
  assert.equal(result.user.name, 'Nozibusiso Cindi');
  assert.equal(result.user.residence, 'berea');
  assert.equal(result.user.student_number, '22123456');
});

await test('register leaves blank optional fields out instead of sending them empty', async () => {
  installFetch(() => ({ status: 201, body: { user: userOut(), token: TOKEN } }));
  await auth.register({
    name: 'A B', email: 'a@b.ac.za', password: 'UniWallet2026', student_number: '', residence: '',
  });
  assert.deepEqual(Object.keys(lastRequest().body).sort(), ['email', 'name', 'password']);
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

await test('live search calls GET /live-search?query= and coerces the Decimal price', async () => {
  installFetch(() => ({
    status: 200,
    body: {
      query: 'bread',
      results: [{
        id: 7, name: 'Albany Superior White Bread 700g', price: dec(18.99),
        image_url: 'https://catalog.sixty60.co.za/v2/files/abc?width=600&height=600',
        product_url: 'https://www.checkers.co.za/product/albany-superior-white-bread-700g-10136301EA',
        store: 'Checkers', brand: 'Albany', category: null, on_promotion: false, in_stock: true,
        last_updated: '2026-09-28T00:39:26+02:00',
      }],
      count: 1,
      stores: [{ store: 'checkers', name: 'Checkers', source: 'cache', fetched_at: '2026-09-28T00:39:26+02:00', count: 1 }],
      message: null,
    },
  }));
  const live = await search.live(TOKEN, 'bread');
  const req = lastRequest();
  assert.equal(req.path, '/live-search');
  assert.deepEqual(req.query, { query: 'bread' });
  assert.equal(live.results[0].price, 18.99);
  assert.equal(live.results[0].image_url.startsWith('https://'), true);
  assert.equal(live.stores[0].source, 'cache');
  assert.equal(live.stores[0].name, 'Checkers');
});

await test('an out-of-stock live item with price 0 or null is never R0', async () => {
  const oos = (price) => ({
    id: 9, name: 'Pride Red Speckled Beans 2kg', price, last_known_price: dec(18.99),
    image_url: null, product_url: null, store: 'Checkers', brand: 'Pride', category: null,
    on_promotion: false, in_stock: false, last_updated: '2026-09-28T00:00:00+02:00',
  });
  for (const price of [null, dec(0), 0]) {
    installFetch(() => ({ body: {
      query: 'beans', count: 1, message: null, results: [oos(price)],
      stores: [{ store: 'checkers', name: 'Checkers', source: 'live', fetched_at: null, count: 1 }],
    } }));
    const [item] = (await search.live(TOKEN, 'beans')).results;
    assert.equal(item.price, null, `price ${price} must become null, not 0`);
    assert.equal(item.buyable, false);
    assert.equal(item.last_known_price, 18.99);
  }
  installFetch(() => ({ body: {
    query: 'beans', count: 1, message: null,
    results: [{ ...oos(dec(0)), in_stock: true, last_known_price: null }],
    stores: [{ store: 'checkers', name: 'Checkers', source: 'live', fetched_at: null, count: 1 }],
  } }));
  const [zero] = (await search.live(TOKEN, 'beans')).results;
  assert.equal(zero.price, null, 'an in-stock R0 is "price unavailable", not free');
  assert.equal(zero.buyable, false);
});

await test('out-of-stock and unpriced offers are never "cheapest" and never buyable', () => {
  const o = (id, price, availability_status = 'available') => ({
    offer_id: id, price, effective_cost: price, total_cost: price, availability_status,
    store_name: 'S', category: 'Groceries',
  });
  const ranked = rank([o(1, 0), o(2, 5, 'out_of_stock'), o(3, 30), o(4, 20)], { budget: 100 });
  assert.deepEqual(ranked.map((r) => r.offer_id).slice(0, 2), [4, 3], 'buyable first, cheapest on top');
  assert.ok(!ranked.slice(2).some((r) => /cheapest/.test(r.why)));
  assert.equal(isBuyable(o(1, 0)), false);
  assert.equal(isBuyable(o(2, 5, 'out_of_stock')), false);
  assert.equal(isBuyable(o(4, 20)), true);
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
  // Editing: the box shows the current value, so blank or 0 means "turn it off" and is
  // sent as null (the server clears it). Leaving the field out entirely keeps the old one.
  assert.deepEqual(budgetUpdateToApi({ survivalThreshold: '' }, {}), { survival_threshold: null });
  assert.deepEqual(budgetUpdateToApi({ survivalThreshold: '0' }, {}), { survival_threshold: null });
  assert.deepEqual(budgetUpdateToApi({}, {}), {});
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

/* ============================================ PHASE 4 BACKEND WIRING ===== */

console.log('\nPhase 4 backend — basket compare, fulfilment, price provenance');

const basketQuote = (over = {}) => ({
  store_id: 3, store_name: 'Shoprite Warwick Junction', store_type: 'physical', distance_km: null,
  fulfilment: 'collection', fulfilment_available: true, full: true, stocked: 2, missing_count: 0,
  lines: [], missing: [], subtotal: dec(60), delivery: dec(0), fees: dec(0), travel: dec(0),
  total: dec(60), estimate_count: 2, notes: [], ...over,
});

await test('Compare asks POST /compare/basket for the whole list, one entry per product', async () => {
  installFetch(() => ({
    body: {
      fulfilment: 'delivery', location_known: false,
      stores: [
        basketQuote({ store_id: 4, store_name: 'Checkers Berea Centre', fulfilment: 'delivery', delivery: dec(35), total: dec(95) }),
        basketQuote({ fulfilment: 'collection', fulfilment_available: false, notes: ["Shoprite Warwick Junction doesn't deliver"] }),
      ],
      best_single_store_id: 4,
      best_plan: { total: dec(95), store_count: 1, stores: [basketQuote({ store_id: 4 })], saving_vs_best_single: dec(0) },
      unavailable: [],
      items: [{ product_id: 5, product_name: 'Brown Bread · 700g', qty: 3, offers: [
        { offer_id: 1, store_id: 4, store_name: 'Checkers Berea Centre', price: dec(20), line_total: dec(60), in_stock: true, is_estimate: true, price_source: 'seed_estimate', price_verified_at: null, product_url: null },
      ] }],
      prices: { listings: 2, estimates: 2, confirmed: 0, all_confirmed: false },
    },
  }));
  const result = await compare.basket(TOKEN, [
    { offer_id: 1, product_id: 5, qty: 1 },
    { offer_id: 2, product_id: 5, qty: 2 },   // same bread from another store
    { offer_id: 7, product_id: 9, qty: 1 },
  ], { fulfilment: 'delivery' });
  const req = lastRequest();
  assert.equal(req.path, '/compare/basket');
  assert.deepEqual(req.body.items, [{ product_id: 5, qty: 3 }, { product_id: 9, qty: 1 }]);
  assert.equal(req.body.fulfilment, 'delivery');
  assert.equal(result.stores[0].total, 95, 'Decimal strings become numbers');
  assert.equal(result.stores[0].delivery, 35);
  assert.equal(result.stores[1].fulfilment_available, false, 'a store that cannot deliver is flagged');
  assert.equal(result.best_single_store_id, 4);
  assert.equal(result.best_plan.store_count, 1);
  assert.equal(result.prices.all_confirmed, false);
  assert.equal(result.location_known, false);
});

await test('item by item keeps only in-stock listings, and only products with a choice', () => {
  const groups = itemGroups({ items: [
    { product_id: 1, product_name: 'Rice', qty: 2, offers: [
      { offer_id: 1, store_id: 1, price: 40, line_total: 80, in_stock: true },
      { offer_id: 2, store_id: 2, price: 31, line_total: 62, in_stock: true },
      { offer_id: 3, store_id: 3, price: 10, line_total: 20, in_stock: false },
    ] },
    { product_id: 2, product_name: 'Soap', qty: 1, offers: [
      { offer_id: 4, store_id: 1, price: 9, line_total: 9, in_stock: true },
      { offer_id: 5, store_id: 2, price: 7, line_total: 7, in_stock: false },
    ] },
  ] });
  assert.equal(groups.length, 1, 'soap has only one in-stock listing, so nothing to compare');
  assert.equal(groups[0].offers.length, 2, 'the out-of-stock R10 rice is not a choice');
  assert.equal(groups[0].saving, 18);
});

await test('the list "as chosen" reads today\'s price and stock from the basket response', () => {
  const lines = [
    { offer_id: 1, product_id: 1, qty: 2, price: 9, store_id: 1, store_type: 'mixed', shipping_cost: 35 },
    { offer_id: 3, product_id: 2, qty: 1, price: 5, store_id: 2, store_type: 'physical', shipping_cost: 0 },
  ];
  const map = basketOffersByProduct({
    stores: [{ store_id: 1, store_type: 'mixed' }],
    items: [
      { product_id: 1, offers: [{ offer_id: 1, store_id: 1, price: 10, in_stock: true }] },
      { product_id: 2, offers: [{ offer_id: 3, store_id: 2, price: 5, in_stock: false }] },
    ],
  }, lines);
  const collected = chosenListTotal(lines, map, { fulfilment: 'collection' });
  assert.equal(collected.items, 20, 'today\'s R10, not the saved R9');
  assert.equal(collected.delivery, 0, 'collecting from a store you walk into, even a "mixed" one');
  assert.equal(collected.unavailable.length, 1, 'the out-of-stock line is reported, not priced');
  assert.equal(chosenListTotal(lines, map, { fulfilment: 'delivery' }).delivery, 35);
});

await test('search is priced the way the student gets it (?fulfilment=)', async () => {
  assert.equal(DEFAULT_FILTERS.fulfilment, 'collection');
  assert.equal(buildSearchParams({}).fulfilment, 'collection');
  assert.equal(buildSearchParams({ fulfilment: 'delivery' }).fulfilment, 'delivery');
  assert.equal(buildSearchParams({ fulfilment: 'teleport' }).fulfilment, 'collection');
  const url = filtersToUrl({ ...DEFAULT_FILTERS, fulfilment: 'delivery' });
  assert.equal(filtersFromUrl(url).fulfilment, 'delivery', 'survives a refresh');
  assert.deepEqual(describeFilters({ fulfilment: 'delivery' }).map((c) => c.key), ['fulfilment']);

  installFetch(() => ({ body: { results: [
    searchResultItem({ price: 19.99, shipping_cost: 35, effective_cost: dec(19.99), price_source: 'seed_estimate' }),
  ], count: 1, limit: 20, offset: 0 } }));
  const page = await search.offers(TOKEN, buildSearchParams({ q: 'bread' }));
  assert.equal(lastRequest().query.fulfilment, 'collection');
  assert.equal(page.results[0].effective_cost, 19.99, 'shelf price when collecting, not R54.99');
  assert.equal(page.results[0].total_cost, 54.99);
  assert.equal(page.results[0].price_is_estimate, true);
});

await test('"Best value" ranks on what the student pays, not on a delivery they skip', () => {
  const [top] = rank([
    { ...searchResultItem({ offer_id: 1, price: 20, shipping_cost: 40 }), price: 20, shipping_cost: 40, total_cost: 60, effective_cost: 20 },
    { ...searchResultItem({ offer_id: 2, price: 25, shipping_cost: 0 }), price: 25, shipping_cost: 0, total_cost: 25, effective_cost: 25 },
  ]);
  assert.equal(top.offer_id, 1, 'collecting, R20 beats R25 whatever the delivery fee');
});

await test('essentials only and fulfilment reach POST /recommendations', async () => {
  installFetch(() => ({ body: { results: [], count: 0, budget: {} } }));
  await recommendations.get(TOKEN, { query: 'soap', fulfilment: 'collection', essential_only: true });
  assert.equal(lastRequest().body.essential_only, true);
  assert.equal(lastRequest().body.fulfilment, 'collection');
  assert.equal(recommendationsCanHonour({ q: 'soap', essentialOnly: true, fulfilment: 'delivery' }), true);
});

await test('a confirmed price is labelled confirmed; a seed price is an estimate', async () => {
  installFetch(() => ({ body: { results: [
    searchResultItem({ offer_id: 1, price_source: 'verified_manual', price_verified_at: '2026-09-20T10:00:00+00:00' }),
    searchResultItem({ offer_id: 2 }),
  ], count: 2, limit: 20, offset: 0 } }));
  const page = await search.offers(TOKEN, {});
  assert.equal(page.results[0].price_is_estimate, false);
  assert.equal(page.results[1].price_is_estimate, true, 'no price_source means a seed estimate');
});

/* ================================================= PHASE 5 BACKEND ===== */

console.log('\nPhase 5 — location, distance, deletes, server list, history');

await test('location is read, saved and cleared on /profile/location', async () => {
  installFetch((req) => {
    if (req.method === 'GET') return { body: null };
    if (req.method === 'DELETE') return { status: 204 };
    return { body: { latitude: '-29.854700', longitude: '31.008400', label: req.body.label, updated_at: null } };
  });
  assert.equal(await profile.getLocation(TOKEN), null, 'no saved location is null, not an error');
  const saved = await profile.setLocation(TOKEN, { latitude: -29.8547, longitude: 31.0084, label: 'Steve Biko Campus (Durban)' });
  assert.deepEqual(lastRequest().body, { latitude: -29.8547, longitude: 31.0084, label: 'Steve Biko Campus (Durban)' });
  assert.equal(saved.latitude, -29.8547, 'Decimal strings become numbers');
  assert.equal(await profile.clearLocation(TOKEN), null);
  assert.equal(lastRequest().method, 'DELETE');
});

await test('profile update sends residence / student number only when given', async () => {
  installFetch(() => ({ body: userOut({ residence: 'berea', student_number: '22123456' }) }));
  await profile.update(TOKEN, { name: 'A B' });
  assert.deepEqual(Object.keys(lastRequest().body), ['name']);
  const u = await profile.update(TOKEN, { name: 'A B', residence: 'berea', student_number: '' });
  assert.deepEqual(lastRequest().body, { name: 'A B', residence: 'berea', student_number: '' }, "'' clears it");
  assert.equal(u.residence, 'berea');
});

await test('distance filter and "nearest first" reach GET /search', async () => {
  assert.equal(buildSearchParams({ maxDistance: '5' }).max_distance_km, 5);
  assert.equal(buildSearchParams({ maxDistance: '7' }).max_distance_km, undefined, 'only offered distances');
  assert.equal(buildSearchParams({ sort: 'distance' }).sort, 'distance');
  const url = filtersToUrl({ ...DEFAULT_FILTERS, maxDistance: '1.5' });
  assert.equal(filtersFromUrl(url).maxDistance, '1.5');
  assert.deepEqual(describeFilters({ maxDistance: '3' }).map((c) => c.key), ['maxDistance']);
  assert.equal(recommendationsCanHonour({ q: 'bread', maxDistance: '3' }), false);

  installFetch(() => ({ body: { results: [searchResultItem({ distance_km: 0.53 })], count: 1, limit: 20, offset: 0 } }));
  const page = await search.offers(TOKEN, buildSearchParams({ q: 'bread', maxDistance: '3', sort: 'distance' }));
  assert.equal(lastRequest().query.max_distance_km, '3');
  assert.equal(page.results[0].distance_km, 0.53);
});

await test('deleting a spend uses the server\'s budget, not a local sum', async () => {
  installFetch(() => ({ body: { budget: budgetOut({ remaining_amount: dec(1650) }), daily_split: budgetSplitOut() } }));
  const result = await transactions.remove(TOKEN, 7, 31);
  assert.equal(lastRequest().method, 'DELETE');
  assert.equal(lastRequest().path, '/budgets/7/transactions/31');
  assert.equal(result.budget.remaining_amount, 1650);
  assert.ok(result.daily_split);

  installFetch(() => ({ status: 204 }));
  await budgets.remove(TOKEN, 7);
  assert.equal(lastRequest().path, '/budgets/7');
  assert.equal(lastRequest().method, 'DELETE');
});

const listLine = (over = {}) => ({
  offer_id: 101, product_id: 11, product_name: 'Super Maize Meal', brand: 'Ace', size: '2.5kg',
  category: 'Groceries', is_essential: true, store_id: 3, store_name: 'Shoprite Warwick Junction',
  store_type: 'physical', price: dec(40.49), current_price: dec(41.99), shipping_cost: dec(0),
  total_cost: dec(41.99), availability_status: 'available', qty: 2, added_at: '2026-09-25T10:00:00+00:00',
  ...over,
});

await test('the shopping list lives on the server and a device list is uploaded once', async () => {
  const store = { 'uniwallet.shoppingList.v3.u1': JSON.stringify([{ offer_id: 101, qty: 2 }]) };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  installFetch((req) => ({ body: { items: req.method === 'DELETE' && req.path === '/shopping-list' ? [] : [listLine()] } }));
  shoppingList.setOwner(1, TOKEN);
  const { lines } = await shoppingList.list();
  const posts = captured.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 1, 'the device list is uploaded');
  assert.deepEqual(posts[0].body, { offer_id: 101, qty: 2 });
  assert.equal(lines[0].price, 40.49, 'price when added (Compare shows "was")');
  assert.equal(lines[0].current_price, 41.99);
  assert.equal(shoppingList.isLocalOnly, false);

  captured = [];
  await shoppingList.list();
  assert.equal(captured.filter((r) => r.method === 'POST').length, 0, 'and only once');

  await shoppingList.setQty(101, 0);
  assert.deepEqual(lastRequest().body, { qty: 0 }, '0 removes the line');
  await shoppingList.add({ offer_id: 5 }, 1);
  assert.deepEqual(lastRequest().body, { offer_id: 5, qty: 1 });
  await shoppingList.clear();
  assert.equal(lastRequest().path, '/shopping-list');
  shoppingList.setOwner(null, null);
  delete globalThis.localStorage;
});

await test('live Checkers items go on the same list, at the price saved when added', async () => {
  const liveLine = {
    item_id: 7, name: 'Albany Superior White Bread 700g', store: 'Checkers', brand: 'Albany',
    image_url: 'https://img/a', product_url: 'https://www.checkers.co.za/product/a',
    price: dec(18.99), current_price: dec(19.99), in_stock: true, buyable: true,
    price_changed: true, qty: 2, line_total: dec(37.98), added_at: '2026-09-28T10:00:00+00:00',
  };
  installFetch(() => ({ body: {
    items: [], live_items: [liveLine],
    summary: { total: dec(37.98), count: 2, unavailable_count: 0, changed_count: 1 },
  } }));
  shoppingList.setOwner(1, TOKEN);
  const list = await shoppingList.addLive({ id: 7 }, 1);
  assert.deepEqual(lastRequest().body, { item_id: 7, qty: 1 });
  assert.equal(lastRequest().path, '/shopping-list/items');
  const [line] = list.liveLines;
  assert.equal(line.price, 18.99, 'the saved price');
  assert.equal(line.current_price, 19.99, 'today, only shown beside it');
  assert.equal(list.summary.total, 37.98, 'the total stays at saved prices');
  assert.equal(list.summary.count, 2);

  await shoppingList.setLiveQty(7, 3);
  assert.equal(lastRequest().method, 'PATCH');
  assert.equal(lastRequest().path, '/shopping-list/live-items/7');
  await shoppingList.removeLive(7);
  assert.equal(lastRequest().method, 'DELETE');

  installFetch(() => ({ body: {
    items: [], summary: { total: dec(0), count: 1, unavailable_count: 1, changed_count: 0 },
    live_items: [{ ...liveLine, current_price: null, in_stock: false, buyable: false, qty: 1 }],
  } }));
  const gone = await shoppingList.list();
  assert.equal(gone.liveLines[0].current_price, null, 'no price now is null, never R0');
  assert.equal(gone.summary.total, 0);
  shoppingList.setOwner(null, null);
});

await test('an out-of-stock item is refused by the server (409), not added', async () => {
  installFetch(() => ({ status: 409, body: { detail: 'That item is out of stock or has no price right now.' } }));
  shoppingList.setOwner(1, TOKEN);
  await assert.rejects(() => shoppingList.addLive({ id: 9 }, 1), (err) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /out of stock/);
    return true;
  });
  shoppingList.setOwner(null, null);
});

await test('recent searches skip blank runs, show each query once, and can be cleared', async () => {
  installFetch((req) => (req.method === 'DELETE' ? { status: 204 } : { body: { runs: [
    { id: 3, query_text: 'bread', created_at: '2026-09-25T10:00:00+00:00', items: [
      { offer_id: 1, rank: 1, product_name: 'Brown Bread', store_name: 'Checkers', total_cost_snapshot: '18.99' },
    ] },
    { id: 2, query_text: null, created_at: null, items: [] },
    { id: 1, query_text: 'Bread', created_at: null, items: [] },
  ] } }));
  const rows = await recommendations.history(TOKEN);
  assert.equal(lastRequest().query.limit, '20');
  assert.deepEqual(rows.map((r) => r.query), ['bread']);
  assert.equal(rows[0].top[0].total_cost, 18.99);
  await recommendations.clearHistory(TOKEN);
  assert.equal(lastRequest().method, 'DELETE');
});

await test('Maintenance is a category with listings now', () => {
  assert.equal(CATEGORIES_WITHOUT_LISTINGS.length, 0);
});

/* ============================== CYCLES, SPEND DATES, CATEGORIES, TEMPLATE == */

console.log('\nBudget cycles, spend dates and the category template');

await test('the entry-form preview agrees with the backend daily split (the R57.17 vs R55.32 bug)', () => {
  // R1 715 for 30 days, landed today. The backend divides by 31 (today and payout day
  // both count) and rounds the daily limit DOWN: 1715 / 31 = 55.3225 -> 55.32.
  const p = previewNewBudget({ amount: 1715, savingsPercentage: 0, periodDays: 30, startDate: '2026-09-29' }, '2026-09-29');
  assert.equal(p.daysLeft, 31);
  assert.equal(p.daily, 55.32, 'the old form said 57.17');
  assert.equal(p.weekly, 387.24);
  // 10% aside: 1715 - 171.50 = 1543.50; / 31 = 49.7903 -> 49.79 (matches the template's B12).
  assert.equal(previewNewBudget({ amount: 1715, savingsPercentage: 10, periodDays: 30, startDate: '2026-09-29' }, '2026-09-29').daily, 49.79);
});

await test('the preview counts days from TODAY, like the split, when the allowance landed earlier', () => {
  // Landed 5 days ago for 30 days: the payout is 25 days away, so 26 days are left.
  const p = previewNewBudget({ amount: 1715, periodDays: 30, startDate: '2026-09-24' }, '2026-09-29');
  assert.equal(p.daysLeft, 26);
  assert.equal(p.daily, floorCents(1715 / 26));
  assert.equal(daysToPayout('2026-09-29', '2026-09-29'), 1, 'payout day itself is one day');
  assert.equal(daysToPayout('2026-09-20', '2026-09-29'), 1, 'never below one');
});

await test('the daily figure is rounded down, never up', () => {
  assert.equal(floorCents(57.179), 57.17);
  assert.equal(floorCents(10), 10);
  assert.equal(floorCents(0.29), 0.29, 'no float drift: 0.29 * 100 is 28.999999999999996');
});

await test('editing preview mirrors the server: savings follow the total, spend is kept', () => {
  // Same numbers as tests/test_budget_calc.py::test_raising_the_total_recomputes_savings...
  const budget = {
    total_amount: 1000, remaining_amount: 800, savings_amount: 100, savings_percentage: 10,
    carried_over_amount: 0, cycle_start_date: '2026-09-29',
  };
  const p = previewEdit({ amount: 2000, savingsPercentage: '10', periodDays: 30, budget }, '2026-09-29');
  assert.equal(p.savings, 200);
  assert.equal(p.remaining, 1700);
  // Changing only the percentage moves money between savings and remaining.
  const q = previewEdit({ amount: 1000, savingsPercentage: '20', periodDays: 30, budget: { ...budget, remaining_amount: 900 } }, '2026-09-29');
  assert.equal(q.savings, 200);
  assert.equal(q.remaining, 800);
  // Carried-over money is not saved again.
  const c = previewEdit({
    amount: 1600, savingsPercentage: '10', periodDays: 30,
    budget: { ...budget, total_amount: 1500, savings_amount: 150, remaining_amount: 1350, carried_over_amount: 500 },
  }, '2026-09-29');
  assert.equal(c.savings, 110);
});

await test('renewal preview carries over the leftover and only saves from the fresh allowance', () => {
  const p = previewRenewal({
    amount: 1715, savingsPercentage: 10, periodDays: 30, startDate: '2026-09-29',
    leftover: 300, previousSavings: 100, carryLeftover: true, carrySavings: false,
  }, '2026-09-29');
  assert.equal(p.total, 2015);
  assert.equal(p.savings, 171.5, '10% of R1715, not of R2015');
  assert.equal(p.spendable, 1843.5);
  const withSavings = previewRenewal({
    amount: 1000, savingsPercentage: 0, periodDays: 7, startDate: '2026-09-29',
    leftover: 0, previousSavings: 100, carryLeftover: true, carrySavings: true,
  }, '2026-09-29');
  assert.equal(withSavings.total, 1100);
});

await test('POST /budgets/{id}/renew sends the carry-over choices and dates the backend accepts', async () => {
  installFetch(() => ({ status: 201, body: budgetOut({ id: 8, total_amount: dec(2015), carried_over_amount: dec(300), renewed_from_budget_id: 7 }) }));
  const next = await budgets.renew(TOKEN, 7, {
    amount: 1715, payoutDate: '2026-09-29', periodDays: 30, savingsPercentage: 10,
    survivalThreshold: '', carryOverLeftover: true, carryOverSavings: false, keepCategories: true,
  });
  const req = lastRequest();
  assert.equal(req.path, '/budgets/7/renew');
  assert.equal(req.method, 'POST');
  assert.equal(req.body.total_amount, 1715);
  assert.equal(req.body.cycle_start_date, '2026-09-29');
  assert.equal(req.body.cycle_end_date, '2026-10-29');
  assert.equal(req.body.carry_over_leftover, true);
  assert.equal(req.body.carry_over_savings, false);
  assert.equal(req.body.survival_threshold, null, 'a blank box means "off", sent as null');
  assert.equal(next.id, 8);
  assert.equal(next.carried_over_amount, 300);
  assert.equal(typeof next.carried_over_amount, 'number');
  assert.equal(next.renewed_from_budget_id, 7);
});

await test('a 409 or 400 on renew lands on a form field, not a bare banner', async () => {
  installFetch(() => ({ status: 400, body: httpError('That cycle would already have ended.') }));
  await assert.rejects(
    () => budgets.renew(TOKEN, 7, { amount: 1000, payoutDate: '2026-01-01', periodDays: 30 }),
    (err) => err.fieldErrors?.periodDays && /already have ended/.test(err.message),
  );
});

await test('survival threshold: blank or 0 clears it (null), omitted keeps it', () => {
  assert.equal(thresholdOrNull(''), null);
  assert.equal(thresholdOrNull('0'), null);
  assert.equal(thresholdOrNull(0), null);
  assert.equal(thresholdOrNull('200'), 200);
  assert.ok(!('survival_threshold' in budgetUpdateToApi({ amount: 1000 }, { cycle_start_date: '2026-09-21' })));
  assert.equal(budgetUpdateToApi({ amount: 1000, survivalThreshold: '' }, {}).survival_threshold, null);
  assert.equal(budgetUpdateToApi({ amount: 1000, survivalThreshold: '0' }, {}).survival_threshold, null);
  assert.equal(budgetUpdateToApi({ amount: 1000, survivalThreshold: '150' }, {}).survival_threshold, 150);
  assert.equal(budgetToApi({ amount: 1000, payoutDate: '2026-09-21', survivalThreshold: '0' }).survival_threshold, null);
});

await test('PUT /budgets/{id} can now change the savings percentage', async () => {
  installFetch(() => ({ status: 200, body: budgetOut() }));
  await budgets.update(TOKEN, { id: 7, cycle_start_date: '2026-09-21' }, {
    amount: 1940, payoutDate: '2026-09-21', periodDays: 30, savingsPercentage: 15, survivalThreshold: '',
  });
  const req = lastRequest();
  assert.deepEqual(Object.keys(req.body).sort(),
    ['cycle_end_date', 'savings_percentage', 'survival_threshold', 'total_amount']);
  assert.equal(req.body.savings_percentage, 15);
});

await test('a spend can carry a date, and leaves it out when there is none', async () => {
  assert.equal(transactionToApi({ description: 'Bread', amount: 20 }).transaction_date, undefined);
  assert.equal(transactionToApi({ description: 'Bread', amount: 20, transactionDate: '' }).transaction_date, undefined);
  installFetch(() => ({
    status: 201,
    body: { transaction: transactionOut(), budget: budgetOut(), overspend_warning: false, warning_message: null },
  }));
  await transactions.create(TOKEN, 7, { description: 'Groceries', amount: 85.5, transactionDate: '2026-09-28' });
  assert.equal(lastRequest().body.transaction_date, '2026-09-28');
  assert.equal(lastRequest().body.item_name, 'Groceries');
});

await test('editing a spend sends only what changed and uses the server\'s budget', async () => {
  assert.deepEqual(transactionUpdateToApi({ amount: '90' }), { amount: 90 });
  assert.deepEqual(transactionUpdateToApi({ category: null }), { category: null }, 'null clears the category');
  installFetch(() => ({
    body: {
      transaction: transactionOut({ amount: dec(9) }),
      budget: budgetOut({ remaining_amount: dec(1641) }),
      daily_split: budgetSplitOut(),
    },
  }));
  const result = await transactions.update(TOKEN, 7, 31, { description: 'Bread', amount: 9, transactionDate: '2026-09-22' });
  const req = lastRequest();
  assert.equal(req.method, 'PUT');
  assert.equal(req.path, '/budgets/7/transactions/31');
  assert.deepEqual(Object.keys(req.body).sort(), ['amount', 'item_name', 'transaction_date']);
  assert.equal(result.transaction.amount, 9);
  assert.equal(result.budget.remaining_amount, 1641, 'taken from the response, never recomputed');
  assert.ok(result.daily_split);
});

await test('the transaction list can be paged', async () => {
  installFetch(() => ({ body: [transactionOut()] }));
  await transactions.list(TOKEN, 7, { limit: 25, offset: 50 });
  assert.equal(lastRequest().query.limit, '25');
  assert.equal(lastRequest().query.offset, '50');
  await transactions.list(TOKEN, 7);
  assert.deepEqual(lastRequest().query, {}, 'no paging means no query string: the full list');
});

await test('the dashboard payload carries the split\'s cycle flag and the priority categories', () => {
  const dash = dashboardFromApi({
    budget: budgetOut(),
    daily_split: budgetSplitOut({ cycle_ended: true, days_overdue: 10 }),
    health: { warning_level: 'ok', spendable_amount: dec(1650), spent_amount: dec(0), spent_percentage: dec(0), over_daily_limit_by: dec(0), warnings: [] },
    recent_transactions: [],
    categories: [
      { id: 1, name: 'Groceries', planned_amount: dec(600), position: 0, spent_amount: dec(85.5) },
      { id: 2, name: 'Toiletries', planned_amount: null, position: 1, spent_amount: dec(0) },
    ],
  });
  assert.equal(dash.split.cycle_ended, true);
  assert.equal(dash.split.days_overdue, 10);
  assert.equal(dash.categories.length, 2);
  assert.equal(dash.categories[0].planned_amount, 600);
  assert.equal(typeof dash.categories[0].spent_amount, 'number');
  assert.equal(dash.categories[1].planned_amount, null, 'no plan stays null, not 0');
  // An older backend without categories still works.
  assert.deepEqual(dashboardFromApi({ budget: budgetOut(), daily_split: budgetSplitOut(), health: null }).categories, []);
});

await test('priority categories: blank names are dropped, blank amounts become null', async () => {
  assert.deepEqual(
    categoriesToApi([
      { name: ' Groceries ', plannedAmount: '600' },
      { name: '   ', plannedAmount: '50' },
      { name: 'Toiletries', plannedAmount: '' },
    ]),
    { categories: [{ name: 'Groceries', planned_amount: 600 }, { name: 'Toiletries', planned_amount: null }] },
  );
  installFetch(() => ({
    body: [{ id: 1, name: 'Groceries', planned_amount: dec(600), position: 0, spent_amount: dec(85.5) }],
  }));
  const saved = await budgetCategories.replace(TOKEN, 7, [{ name: 'Groceries', plannedAmount: '600' }]);
  assert.equal(lastRequest().method, 'PUT');
  assert.equal(lastRequest().path, '/budgets/7/categories');
  assert.equal(saved[0].planned_amount, 600);
  assert.equal(saved[0].spent_amount, 85.5);
});

await test('over-planning a budget is reported on the categories, with the server\'s wording', async () => {
  installFetch(() => ({ status: 400, body: httpError('Your planned amounts add up to R1800.00, which is R150.00 more than the R1650.00 you can spend.') }));
  await assert.rejects(
    () => budgetCategories.replace(TOKEN, 7, [{ name: 'Groceries', plannedAmount: '1800' }]),
    (err) => err.status === 400 && err.fieldErrors?.categories && /R150\.00 more/.test(err.message),
  );
});

await test('the spreadsheet download posts the categories and hands back the file and its name', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  installFetch(() => ({
    file: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'uniwallet-monthly-budget-2026-09-29.xlsx', bytes },
  }));
  const { blob, filename } = await budgets.downloadTemplate(TOKEN, {
    categories: [{ name: 'Groceries', plannedAmount: '600' }, { name: 'Transport', plannedAmount: '' }],
    amount: '1715', savingsPercentage: '10', periodDays: '30', startDate: '2026-09-29',
  });
  const req = lastRequest();
  assert.equal(req.path, '/budgets/template');
  assert.equal(req.method, 'POST');
  assert.deepEqual(req.body, {
    categories: [{ name: 'Groceries', planned_amount: 600 }, { name: 'Transport', planned_amount: null }],
    total_amount: 1715, savings_percentage: 10, period_days: 30, start_date: '2026-09-29',
  });
  assert.equal(filename, 'uniwallet-monthly-budget-2026-09-29.xlsx');
  assert.equal(blob.size, bytes.length);
});

await test('with an active budget the template request needs only the categories', () => {
  assert.deepEqual(
    templateToApi({ categories: [{ name: 'Groceries', plannedAmount: '' }] }),
    { categories: [{ name: 'Groceries', planned_amount: null }] },
  );
  // Nonsense money or period is left out rather than sent (the backend then falls back to the budget).
  const body = templateToApi({ categories: [{ name: 'A', plannedAmount: '' }], amount: '', periodDays: 'abc' });
  assert.ok(!('total_amount' in body) && !('period_days' in body));
  assert.equal(templateToApi({ categories: [{ name: 'A' }], savingsPercentage: 250 }).savings_percentage, 100);
});

await test('a failed download is an ApiError with the server\'s message', async () => {
  installFetch(() => ({ status: 400, body: httpError('Tell us how much you received and how many days it must last, or set up a budget first.') }));
  await assert.rejects(
    () => budgets.downloadTemplate(TOKEN, { categories: [{ name: 'Groceries', plannedAmount: '' }] }),
    (err) => err instanceof ApiError && /how much you received/.test(err.message),
  );
});

await test('planner names are tidied and checked the way the backend does', () => {
  assert.equal(cleanPlannerName('  =Bread   & milk '), 'Bread & milk');
  assert.equal(cleanPlannerName('=+-@'), '');
  assert.match(plannerNameError('', []), /Type a category/);
  assert.match(plannerNameError('Wild*card', []), /cannot contain/);
  assert.match(plannerNameError('groceries', ['Groceries']), /already on your list/);
  assert.match(plannerNameError('x'.repeat(61), []), /under 60/);
  assert.equal(plannerNameError('Haircut', ['Groceries']), null);
  assert.ok(PLANNER_SUGGESTIONS.every((n) => plannerNameError(n, []) === null));
});

await test('the spend form offers the student\'s own categories first, without duplicates', () => {
  const opts = spendCategoryOptions(['Haircut', 'groceries']);
  assert.equal(opts[0].value, 'Haircut');
  assert.equal(opts.filter((o) => o.value.toLowerCase() === 'groceries').length, 1);
  assert.ok(opts.some((o) => o.value === 'Transport'), 'the standard categories are still there');
});

await test('a week is budgeted weekly, a fortnight in two weeks, a month monthly', () => {
  assert.equal(periodWord(7), 'week');
  assert.equal(periodWord(14), 'two weeks');
  assert.equal(periodWord(30), 'month');
});

await test('date validators say what they check', () => {
  assert.equal(validDate('2026-09-29'), null);
  assert.match(validDate('', 'Payout date'), /required/);
  assert.match(validDate('2026-13-45', 'Payout date'), /not a valid date/);
  assert.match(validDate('29/09/2026', 'Payout date'), /not a valid date/);
  // The spend date: blank = today; never future; never before the budget started.
  assert.equal(dateWithin('', { min: '2026-09-01', max: '2026-09-29' }), null);
  assert.equal(dateWithin('2026-09-28', { min: '2026-09-01', max: '2026-09-29' }), null);
  assert.match(dateWithin('2026-09-30', { min: '2026-09-01', max: '2026-09-29' }), /future/);
  assert.match(dateWithin('2026-08-31', { min: '2026-09-01', max: '2026-09-29' }), /before your budget started/);
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
