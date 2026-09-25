/**
 * BudgetContext — the active budget, its transactions, and the figures shown
 * on the dashboard.
 *
 * THE ONE RULE IN THIS FILE
 * -------------------------
 * `remaining_amount` belongs to the backend. The old version of this file
 * computed it as `total - sum(transactions)`, which is a second implementation
 * of a calculation app/routers/budgets.py already performs — and the two
 * disagree the moment a student overspends, because the server floors
 * remaining at 0 (schema constraint `remaining_amount >= 0`) while a
 * subtraction in the browser goes negative.
 *
 * So: every figure derived below starts from the budget object the backend
 * returned. Transactions are used for the category breakdown and the list,
 * which are presentation of the transaction log — not a second source of truth
 * for what is left.
 *
 * WHAT IS STILL COMPUTED HERE, AND WHY
 * ------------------------------------
 * Nothing money-related. The dashboard loads from GET /budgets/dashboard
 * (Member 3), which carries the budget, Member 6's Daily Budget Split and a
 * `health` block with ready-to-show warnings in one call. `dailyAllowance`
 * falls back to `remaining / days left` only if the split is missing, and the
 * screen labels it when it does.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';
import { daysBetween } from '../api/normalise.js';
import { daysUntil } from '../lib/format.js';

/** 2026 NSFAS caps — the defaults the budget screen offers. Presentational. */
export const NSFAS = {
  livingAllowanceMonthly: 1650,
  personalCareMonthly: 290,
  transportMonthly: 625,
  booksOnceOff: 5200,
  academicMonths: 10,
};

/**
 * The backend does not delete budgets or transactions — there is no
 * DELETE route in app/routers/budgets.py. These flags let the screens disable
 * those controls honestly instead of offering a button that cannot work.
 */
export const BACKEND_SUPPORTS = {
  deleteBudget: false,
  deleteTransaction: false,
  serverDailyLimit: true, // GET /budgets/dashboard carries the split — see refresh
};

const BudgetContext = createContext(null);

export function BudgetProvider({ children }) {
  const { token, isAuthenticated } = useAuth();

  const [budget, setBudget] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [split, setSplit] = useState(null);
  /** BudgetHealthOut from GET /budgets/dashboard — the server's warnings. */
  const [serverHealth, setServerHealth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  /* -------------------------------------------------------------- loading */

  const refresh = useCallback(async () => {
    if (!token) {
      setBudget(null);
      setTransactions([]);
      setSplit(null);
      setServerHealth(null);
      setLoaded(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // One call for the budget, its Daily Budget Split and the health
      // warnings (null when there is no active budget). The full transaction
      // list is fetched afterwards because the dashboard payload only carries
      // the most recent few, and the category breakdown needs all of them.
      const dash = await api.budgets.getDashboard(token);
      setBudget(dash?.budget ?? null);
      setSplit(dash?.split ?? null);
      setServerHealth(dash?.health ?? null);

      if (dash?.budget) {
        setTransactions(await api.transactions.list(token, dash.budget.id));
      } else {
        setTransactions([]);
      }
      setLoaded(true);
    } catch (err) {
      setError(err.message || 'Could not load your budget.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (isAuthenticated) refresh();
    else {
      setBudget(null);
      setTransactions([]);
      setSplit(null);
      setServerHealth(null);
      setLoaded(false);
    }
  }, [isAuthenticated, refresh]);

  /** Health warnings are server-computed, so re-read them after a change. */
  const refreshHealth = useCallback(() => {
    api.budgets.getDashboard(token, { recent: 0, knownActive: true })
      .then((dash) => {
        if (!dash) return;
        setSplit(dash.split);
        setServerHealth(dash.health);
      })
      .catch(() => setServerHealth(null));
  }, [token]);

  /* ------------------------------------------------------------ mutations */

  /**
   * POST /budgets when there is no active budget, PUT /budgets/{id} when there
   * is. The backend enforces one active budget per user with a unique partial
   * index, so creating a second one is a 409 — which is why this branches on
   * the budget we already hold rather than always POSTing.
   */
  const saveBudget = useCallback(async (formValues) => {
    const saved = budget
      ? await api.budgets.update(token, budget, formValues)
      : await api.budgets.create(token, formValues);
    setBudget(saved);
    // A brand-new budget has no transactions; an edited one keeps its own.
    if (!budget) setTransactions([]);
    setLoaded(true);
    // total_amount or the cycle length changing both shift daily_limit.
    refreshHealth();
    return saved;
  }, [budget, token, refreshHealth]);

  /**
   * POST /budgets/{id}/transactions.
   *
   * The response carries the recalculated budget AND the overspend flag. We
   * take both: `result.budget` replaces our copy (never a local subtraction),
   * and the caller gets the warning so the dashboard can show it.
   */
  const addTransaction = useCallback(async (formValues) => {
    if (!budget) throw new Error('Set a budget before recording a spend.');
    const result = await api.transactions.create(token, budget.id, formValues);
    setTransactions((list) => [result.transaction, ...list]);
    setBudget(result.budget);
    // The response already carries the recalculated split (see
    // docs/BUDGET_SPLIT_CONTRACT.md), so there is nothing to re-fetch for it.
    if (result.daily_split) setSplit(result.daily_split);
    refreshHealth();
    return result;
  }, [budget, token, refreshHealth]);

  /* -------------------------------------------------------------- derived */

  const derived = useMemo(() => {
    const total = budget?.total_amount ?? 0;
    const savings = budget?.savings_amount ?? 0;
    const remaining = budget?.remaining_amount ?? 0;

    // Savings are carved out of the budget up front by the backend
    // (remaining = total - savings_amount at creation), so the pot a student
    // can actually spend from is total minus savings.
    const spendable = Math.max(0, total - savings);
    const spent = Math.max(0, Number((spendable - remaining).toFixed(2)));
    const ratio = spendable > 0 ? Math.min(1, spent / spendable) : 0;

    const periodDays = budget
      ? Math.max(1, daysBetween(budget.cycle_start_date, budget.cycle_end_date))
      : 0;
    // Counted the way the backend's Daily Budget Split counts it (today AND
    // payout day, never below 1 — app/budget_split.py days_remaining), and
    // taken from the split itself when it is there. The first version counted
    // one day fewer, so the dashboard said "30 days left" beside the split's
    // "31 days until your next payout".
    const daysLeft = budget
      ? (split?.days_remaining ?? Math.max(1, daysUntil(budget.cycle_end_date) + 1))
      : 0;
    const daysGone = Math.max(0, periodDays + 1 - daysLeft);

    // GET /budget-split (app/routers/budget_split.py) is the source of truth
    // once it answers; budget.daily_limit is a second, older path to the same
    // number (the split endpoint writes it back to budgets.daily_limit
    // server-side, so it can lag one refresh behind `split` itself). Only
    // when both are unavailable do we fall back to the app's own formula.
    const dailyAllowance = split?.daily_limit ?? budget?.daily_limit
      ?? (daysLeft > 0 ? remaining / daysLeft : remaining);
    const dailyAllowanceIsFromServer = split?.daily_limit != null || budget?.daily_limit != null;

    // What an even spender would have got through by now.
    const onPace = periodDays > 0 ? spendable * (daysGone / periodDays) : 0;

    // `remaining` can never be negative (the server floors it), so "over" is
    // "nothing left", not "below zero". `split.mode === 'survival'` is the
    // backend's own verdict (app/budget_split.py) — it fires before the
    // app's own pace/ratio heuristics would, per the endpoint's own contract
    // ("mode: 'survival' turns the UI amber").
    let health = 'good';
    if (budget && remaining <= 0 && spendable > 0) health = 'over';
    // Needs at least one full day behind it: on day 0 the pace is R0, so any
    // spend at all used to read as "spending faster than planned".
    else if (daysGone > 0 && spent > onPace * 1.15 && daysLeft > 0 && spent > 0) health = 'fast';
    else if (ratio >= 0.9) health = 'tight';
    else if (split?.mode === 'survival') health = 'tight';

    const byCategory = {};
    let recorded = 0;
    for (const t of transactions) {
      recorded += t.amount;
      const key = t.category || 'Other';
      byCategory[key] = Number(((byCategory[key] || 0) + t.amount).toFixed(2));
    }

    return {
      total,
      savings,
      spendable,
      spent,
      remaining,
      ratio,
      periodDays,
      daysLeft,
      daysGone,
      dailyAllowance: Number(Math.max(0, dailyAllowance).toFixed(2)),
      dailyAllowanceIsFromServer,
      weeklyAllowance: Number(Math.max(0, dailyAllowance * 7).toFixed(2)),
      remainingToday: Number(Math.max(0, split?.remaining_today ?? dailyAllowance).toFixed(2)),
      budgetMode: split?.mode || 'normal',
      onPace: Number(onPace.toFixed(2)),
      health,
      byCategory,
      recorded: Number(recorded.toFixed(2)),
      splitMessage: split?.message ?? null,
      survival: split?.mode === 'survival',
      overToday: split ? split.spent_today > split.daily_limit : false,
    };
  }, [budget, transactions, split]);

  const value = useMemo(() => ({
    budget,
    transactions,
    split,
    serverHealth,
    loading,
    loaded,
    error,
    refresh,
    saveBudget,
    addTransaction,
    supports: BACKEND_SUPPORTS,
    ...derived,
  }), [budget, transactions, split, serverHealth, loading, loaded, error, refresh,
       saveBudget, addTransaction, derived]);

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

export function useBudget() {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error('useBudget must be used inside <BudgetProvider>.');
  return ctx;
}
