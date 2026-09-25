/**
 * The app-facing API.
 *
 * Every screen and every context talks to the backend through this object and
 * nothing else. It is a thin layer: `endpoints.js` owns the URLs, `http.js`
 * owns the transport and the error shape, `normalise.js` owns the type
 * coercion. This file's only job is to compose those three into calls that
 * read like the thing the app is trying to do.
 *
 * WHAT CHANGED FROM THE PREVIOUS VERSION, AND WHY
 * -----------------------------------------------
 * The old client.js was written against docs/API_CONTRACT.md, which was agreed
 * before the backend existed and does not match what was built. It called
 * /auth/me, /transactions, /products and /basket — none of which exist in
 * AI-Budgeting-main. It also carried a mock implementation behind a
 * LIVE_ENDPOINTS_READY switch. Both are gone: the real routes are live, and
 * there is no second implementation that can silently disagree with them.
 *
 * The one exception is `shoppingList`, which is device-local because the
 * backend has no endpoint for it at all — see localList.js, which explains
 * itself at length, and the Compare screen, which tells the student.
 */

import * as endpoints from './endpoints.js';
import * as localList from './localList.js';
import { API_BASE_URL, ApiError, setUnauthorizedHandler } from './http.js';
import {
  affordabilityFromApi,
  basketComparisonFromApi,
  locationFromApi,
  budgetFromApi,
  budgetSplitFromApi,
  budgetToApi,
  budgetUpdateToApi,
  dashboardFromApi,
  preferencesFromApi,
  recommendationsFromApi,
  searchResponseFromApi,
  shoppingListFromApi,
  transactionFromApi,
  transactionResultFromApi,
  transactionToApi,
  trueCostResponseFromApi,
  userFromApi,
} from './normalise.js';

export { API_BASE_URL, ApiError, setUnauthorizedHandler };

/* -------------------------------------------------------------------- auth */

export const auth = {
  /**
   * RegisterRequest { name, email, password, residence?, student_number? }.
   * The two optional fields were added to the backend in Phase 4.
   */
  async register({ name, email, password, residence, student_number: studentNumber }) {
    const payload = await endpoints.register({
      name, email, password, residence, student_number: studentNumber,
    });
    return { user: userFromApi(payload.user), token: payload.token };
  },

  async login({ email, password }) {
    const payload = await endpoints.login({ email, password });
    return { user: userFromApi(payload.user), token: payload.token };
  },

  /**
   * The backend cannot invalidate a JWT (it says so in auth.py), so a failure
   * here does not mean the student is still signed in — the token is binned
   * client-side either way. AuthContext clears local state first, then calls
   * this, and ignores the outcome.
   */
  logout: (token) => endpoints.logout(token),
};

/* ----------------------------------------------------------------- profile */

export const profile = {
  /**
   * There is no /auth/me on this backend. GET /profile/ is the route that
   * restores a session, and it is what proves the stored token is still valid.
   */
  async get(token) {
    return userFromApi(await endpoints.getProfile(token));
  },

  /**
   * PUT /profile/ — name, and optionally residence / student number
   * (undefined = leave as is, '' = clear).
   */
  async update(token, { name, residence, student_number: studentNumber }) {
    return userFromApi(await endpoints.updateProfile(token, {
      name, residence, student_number: studentNumber,
    }));
  },

  /** The student's saved location (Phase 5), or null. */
  async getLocation(token) {
    return locationFromApi(await endpoints.getLocation(token));
  },

  async setLocation(token, { latitude, longitude, label }) {
    return locationFromApi(await endpoints.setLocation(token, { latitude, longitude, label }));
  },

  async clearLocation(token) {
    await endpoints.clearLocation(token);
    return null;
  },

  async getPreferences(token) {
    return preferencesFromApi(await endpoints.getPreferences(token));
  },

  async updatePreferences(token, patch) {
    return preferencesFromApi(await endpoints.updatePreferences(token, patch));
  },
};

/* ----------------------------------------------------------------- budgets */

export const budgets = {
  /**
   * GET /budgets/current answers 404 when a student has no active budget.
   * That is not an error for us — it is the "set your budget" empty state, so
   * it becomes null here and the dashboard renders the empty state.
   *
   * Any OTHER failure is rethrown: a 500 must not be mistaken for "no budget".
   */
  async getCurrent(token) {
    try {
      return budgetFromApi(await endpoints.getCurrentBudget(token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * GET /budgets/dashboard — budget, Daily Budget Split, health warnings and
   * the latest transactions in one call. Same 404-means-null rule as above.
   */
  async getDashboard(token, { recent, knownActive = false } = {}) {
    // A brand-new student has no budget, and asking the dashboard for one
    // answers 404 — which every browser prints as a red console error on the
    // very first screen after registering. GET /budgets answers [] instead, so
    // ask that first unless the caller already knows a budget exists.
    if (!knownActive) {
      const all = await endpoints.listBudgets(token);
      if (!Array.isArray(all) || !all.some((b) => b.status === 'active')) return null;
    }
    try {
      return dashboardFromApi(await endpoints.getBudgetDashboard(token, { recent }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  async list(token) {
    const rows = await endpoints.listBudgets(token);
    return Array.isArray(rows) ? rows.map(budgetFromApi) : [];
  },

  /** Form values in, BudgetCreateRequest out. */
  async create(token, formValues) {
    return budgetFromApi(await endpoints.createBudget(token, budgetToApi(formValues)));
  },

  /** DELETE /budgets/{id} — the budget and every spend recorded against it. */
  async remove(token, budgetId) {
    await endpoints.deleteBudget(token, budgetId);
  },

  /**
   * PUT /budgets/{id}. Only total_amount and cycle_end_date are updatable, and
   * the server re-derives remaining_amount from the delta — so nothing here
   * touches remaining_amount.
   */
  async update(token, budget, formValues) {
    const patch = budgetUpdateToApi(formValues, budget);
    return budgetFromApi(await endpoints.updateBudget(token, budget.id, patch));
  },
};

/**
 * Daily Budget Split — Member 6's endpoint (app/routers/budget_split.py).
 *
 * Same "404 means nothing to show" pattern as `budgets.getCurrent`: no
 * active budget means there is no split to compute, not an error. Any OTHER
 * failure is rethrown so BudgetContext can decide how to degrade (it falls
 * back to the app's own remaining ÷ days-left calculation — see
 * BudgetContext.jsx).
 */
export const budgetSplit = {
  async get(token) {
    try {
      return budgetSplitFromApi(await endpoints.getBudgetSplit(token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },

  /** "Can I afford this today?" — POST /budget-split/check. */
  async check(token, amount) {
    return affordabilityFromApi(await endpoints.checkAffordability(token, { amount }));
  },
};

/* --------------------------------------------------------- recommendations */

/**
 * Member 5's recommender — POST /recommendations. Ranks on true cost against
 * today's allowance, and in survival mode returns essentials only.
 */
export const recommendations = {
  async get(token, body) {
    return recommendationsFromApi(await endpoints.getRecommendations(token, body));
  },

  /**
   * Past searches and what was recommended for them (Phase 5 "Recent
   * searches"). Runs without a query (the default For you list) are skipped,
   * and a query searched twice is shown once, newest first.
   */
  async history(token, { limit = 20 } = {}) {
    const payload = await endpoints.getRecommendationHistory(token, { limit });
    const seen = new Set();
    const out = [];
    for (const run of payload?.runs || []) {
      const query = String(run.query_text || '').trim();
      if (!query || seen.has(query.toLowerCase())) continue;
      seen.add(query.toLowerCase());
      out.push({
        id: run.id,
        query,
        created_at: run.created_at || null,
        top: (run.items || []).slice(0, 3).map((i) => ({
          offer_id: i.offer_id,
          product_name: i.product_name,
          store_name: i.store_name,
          total_cost: Number(i.total_cost_snapshot) || 0,
        })),
      });
    }
    return out;
  },

  async clearHistory(token) {
    await endpoints.clearRecommendationHistory(token);
  },
};

/* --------------------------------------------------------------- true cost */

/**
 * Member 6's calculator — POST /true-cost. Prices each offer as its own order
 * (item + delivery + store charges + travel), so it compares ALTERNATIVES for
 * one product. Compare's "Item by item" uses it; summing results is never a
 * basket total.
 */
export const trueCost = {
  async compare(token, offerIds, { quantity = 1, fulfilment = 'delivery' } = {}) {
    if (!offerIds?.length) return { results: [], cheapest_offer_id: null, saving_vs_dearest: 0 };
    return trueCostResponseFromApi(await endpoints.getTrueCost(token, {
      offer_ids: offerIds.slice(0, 50),
      quantity: Math.max(1, Math.min(99, Math.round(quantity))),
      fulfilment,
    }));
  },
};

/* ---------------------------------------------------------- compare basket */

/**
 * POST /compare/basket (Phase 4, app/basket.py). The whole list priced as
 * ONE order per store — delivery once per order with the free-delivery
 * threshold judged on the basket, store fees once, travel once per trip —
 * and the cheapest plan across up to three stores. This replaced the
 * arithmetic the Compare screen used to do in the browser, which could not
 * see store charges or which stores deliver.
 */
export const compare = {
  async basket(token, lines, { fulfilment = 'collection' } = {}) {
    const qtyByProduct = new Map();
    for (const line of lines) {
      qtyByProduct.set(line.product_id, (qtyByProduct.get(line.product_id) || 0) + line.qty);
    }
    const items = [...qtyByProduct].slice(0, 50)
      .map(([productId, qty]) => ({ product_id: productId, qty: Math.max(1, Math.min(99, qty)) }));
    if (items.length === 0) return null;
    return basketComparisonFromApi(await endpoints.compareBasket(token, { items, fulfilment }));
  },
};

/** GET /prices/status — how many catalogue prices are estimates vs confirmed. */
export const prices = {
  status: (token) => endpoints.getPriceStatus(token),
};

/* ------------------------------------------------------------ transactions */

export const transactions = {
  /** Transactions belong to a budget, not to a user, so the id is required. */
  async list(token, budgetId) {
    const rows = await endpoints.listTransactions(token, budgetId);
    return Array.isArray(rows) ? rows.map(transactionFromApi) : [];
  },

  /**
   * Returns { transaction, budget, overspend_warning, warning_message,
   *           daily_limit_warning, daily_limit_message, daily_split }.
   *
   * The `budget` in that response is the authoritative post-spend state — the
   * caller MUST use it rather than subtracting the amount itself, because the
   * server floors remaining_amount at 0 on an overspend and the two would
   * drift apart the first time a student went over.
   */
  async create(token, budgetId, formValues) {
    const payload = await endpoints.createTransaction(
      token, budgetId, transactionToApi(formValues),
    );
    return transactionResultFromApi(payload);
  },

  /**
   * DELETE a recorded spend (Phase 5). Returns { budget, daily_split } — the
   * authoritative state after the money goes back, like create() does.
   */
  async remove(token, budgetId, transactionId) {
    const payload = await endpoints.deleteTransaction(token, budgetId, transactionId);
    return {
      budget: budgetFromApi(payload?.budget),
      daily_split: payload?.daily_split ? budgetSplitFromApi(payload.daily_split) : null,
    };
  },
};

/* ------------------------------------------------------------------ search */

export const search = {
  /**
   * GET /search. Params are passed through as the backend names them; the
   * Search screen builds them in one place (buildSearchParams in lib/search.js)
   * so the mapping from filter UI to query string is readable in one sitting.
   */
  async offers(token, params) {
    return searchResponseFromApi(await endpoints.search(token, params));
  },

  /**
   * The values the catalogue actually uses for store, brand, colour, size and
   * category, so Search can offer real choices instead of free text that has
   * to match the backend's ILIKE exactly ("PnP" or "2 kg" used to return
   * nothing). Built from GET /search itself — there is no facets endpoint —
   * by walking the pages once per session; the answer is cached per token.
   */
  catalogueFacets(token) {
    if (!facetCache.has(token)) {
      const load = (async () => {
        const rows = [];
        for (let offset = 0, more = true; more && offset < 2000; offset += 100) {
          // eslint-disable-next-line no-await-in-loop
          const page = await this.offers(token, { availability: 'any', limit: 100, offset });
          rows.push(...page.results);
          more = page.has_more;
        }
        const unique = (field) => [...new Set(
          rows.map((o) => o[field]).filter((v) => v && String(v).toLowerCase() !== 'n/a'),
        )].sort((a, b) => String(a).localeCompare(String(b)));
        return {
          categories: unique('category'),
          stores: unique('store_name'),
          brands: unique('brand'),
          colours: unique('colour'),
          sizes: unique('size'),
          total: rows.length,
        };
      })();
      // A failed load must not be cached forever.
      load.catch(() => facetCache.delete(token));
      facetCache.set(token, load);
    }
    return facetCache.get(token);
  },
};

const facetCache = new Map();

/* ----------------------------------------------------------- shopping list */

/**
 * Server-side since Phase 5 (/shopping-list), so the list follows the
 * student to any device. The first time a student signs in after the move,
 * whatever was saved in this browser's localStorage (localList.js) is
 * uploaded once and then cleared, so nobody loses the list they had.
 */
let listToken = null;
let listUserId = null;

async function uploadDeviceList(token) {
  const saved = await localList.list();
  if (!saved.length) return;
  for (const line of saved) {
    // eslint-disable-next-line no-await-in-loop
    await endpoints.addShoppingListItem(token, { offer_id: line.offer_id, qty: line.qty })
      .catch(() => null); // an offer that no longer exists is simply dropped
  }
  await localList.clear();
}

export const shoppingList = {
  /** Called by ShoppingContext whenever the signed-in account changes. */
  setOwner(userId, token) {
    listUserId = userId;
    listToken = userId ? token : null;
    localList.setOwner(userId);
  },
  async list() {
    if (!listToken) return [];
    await uploadDeviceList(listToken);
    return shoppingListFromApi(await endpoints.getShoppingList(listToken));
  },
  async add(offer, qty = 1) {
    return shoppingListFromApi(await endpoints.addShoppingListItem(listToken, { offer_id: offer.offer_id, qty }));
  },
  async setQty(offerId, qty) {
    return shoppingListFromApi(await endpoints.setShoppingListQty(listToken, offerId, Math.max(0, Math.round(qty))));
  },
  async remove(offerId) {
    return shoppingListFromApi(await endpoints.removeShoppingListItem(listToken, offerId));
  },
  async clear() {
    return shoppingListFromApi(await endpoints.clearShoppingList(listToken));
  },
  /** False since Phase 5: the list is saved to the account. */
  isLocalOnly: false,
  get ownerId() { return listUserId; },
};

/* ------------------------------------------------------------------ health */

export const system = {
  /** Used by the connection check so a dead backend says so, once, clearly. */
  async health() {
    return endpoints.health();
  },
};

/** Grouped default export, for `import { api } from '../api/client.js'`. */
export const api = {
  auth, profile, budgets, budgetSplit, recommendations, trueCost, compare, prices,
  transactions, search, shoppingList, system,
};

export default api;
