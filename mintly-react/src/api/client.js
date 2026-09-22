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
  budgetFromApi,
  budgetSplitFromApi,
  budgetToApi,
  budgetUpdateToApi,
  preferencesFromApi,
  searchResponseFromApi,
  transactionFromApi,
  transactionResultFromApi,
  transactionToApi,
  userFromApi,
} from './normalise.js';

export { API_BASE_URL, ApiError, setUnauthorizedHandler };

/* -------------------------------------------------------------------- auth */

export const auth = {
  /**
   * The backend's RegisterRequest is { name, email, password } — nothing else.
   * The register form also collects a student number and a residence; those
   * are NOT sent, because the API would silently drop them and the student
   * would believe they had been saved. See docs/BACKEND_INTEGRATION.md.
   */
  async register({ name, email, password }) {
    const payload = await endpoints.register({ name, email, password });
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

  /** PUT /profile/ accepts `name` only. */
  async update(token, { name }) {
    return userFromApi(await endpoints.updateProfile(token, { name }));
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

  async list(token) {
    const rows = await endpoints.listBudgets(token);
    return Array.isArray(rows) ? rows.map(budgetFromApi) : [];
  },

  /** Form values in, BudgetCreateRequest out. */
  async create(token, formValues) {
    return budgetFromApi(await endpoints.createBudget(token, budgetToApi(formValues)));
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
};

/* ------------------------------------------------------------ transactions */

export const transactions = {
  /** Transactions belong to a budget, not to a user, so the id is required. */
  async list(token, budgetId) {
    const rows = await endpoints.listTransactions(token, budgetId);
    return Array.isArray(rows) ? rows.map(transactionFromApi) : [];
  },

  /**
   * Returns { transaction, budget, overspend_warning, warning_message }.
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
   * Every offer for a set of products, for the store-by-store comparison.
   *
   * INTERIM: there is no `GET /products/{id}/offers`, so this searches by
   * product name (`q` ILIKEs name/brand/category) and keeps the rows whose
   * product_id matches. It is real backend data, but it costs one request per
   * distinct product and can miss an offer whose product name differs.
   * docs/BACKEND_INTEGRATION.md specifies the endpoint that would fix both.
   */
  async offersForProducts(token, products) {
    const unique = [];
    const seen = new Set();
    for (const p of products) {
      if (seen.has(p.product_id)) continue;
      seen.add(p.product_id);
      unique.push(p);
    }

    const responses = await Promise.all(
      unique.map((p) => this
        .offers(token, { q: p.product_name, availability: 'any', limit: 100, sort: 'price_asc' })
        .catch(() => ({ results: [] }))),
    );

    const byProduct = new Map();
    unique.forEach((p, i) => {
      const matches = responses[i].results.filter((r) => r.product_id === p.product_id);
      byProduct.set(p.product_id, matches);
    });
    return byProduct;
  },
};

/* ----------------------------------------------------------- shopping list */

/**
 * Device-local. NOT a backend resource yet — localList.js explains why and
 * the Compare screen tells the student. Kept behind this namespace so that
 * replacing it with real endpoints is a change to this block alone.
 */
export const shoppingList = {
  list: () => localList.list(),
  add: (offer, qty) => localList.add(offer, qty),
  setQty: (offerId, qty) => localList.setQty(offerId, qty),
  remove: (offerId) => localList.remove(offerId),
  clear: () => localList.clear(),
  /** True while the list is device-local; drives the banner on Compare. */
  isLocalOnly: true,
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
  auth, profile, budgets, budgetSplit, transactions, search, shoppingList, system,
};

export default api;
