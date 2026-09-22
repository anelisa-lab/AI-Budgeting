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
 * `dailyAllowance` (the "safe to spend per day" figure). Member 6's Daily
 * Budget Split now exists as its own endpoint, GET /budget-split
 * (app/routers/budget_split.py) — it is NOT a field on BudgetOut, so we fetch
 * it alongside the budget and prefer `split.daily_limit` the moment it is
 * available. If that call fails for any reason (network hiccup, or simply no
 * active budget yet), we fall back to the exact formula the backend README
 * specifies, `remaining_amount / days until cycle_end_date`, computed here.
 * Either way the number is labelled on screen so nobody mistakes one for the
 * other.
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
  serverDailyLimit: true, // GET /budget-split is live — see BudgetProvider.refresh
};

const BudgetContext = createContext(null);

export function BudgetProvider({ children }) {
  const { token, isAuthenticated } = useAuth();

  const [budget, setBudget] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [split, setSplit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);

  /* -------------------------------------------------------------- loading */

  const refresh = useCallback(async () => {
    if (!token) {
      setBudget(null);
      setTransactions([]);
      setSplit(null);
      setLoaded(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // Fetching the budget is sequential on purpose: both transactions and
      // the split hang off a budget id, so there is nothing to fetch in
      // parallel until we know whether a budget exists at all.
      const current = await api.budgets.getCurrent(token); // null when 404
      setBudget(current);

      if (current) {
        // Transactions and the split are independent of each other, so they
        // go out together. The split is an enhancement, not core data: if it
        // fails for any reason we still want the transaction list and the
        // budget itself, so its failure is swallowed here rather than
        // surfaced as a page-level error — `derived` below falls back to a
        // local calculation the instant `split` is null.
        const [rows, splitResult] = await Promise.all([
          api.transactions.list(token, current.id),
          api.budgetSplit.get(token).catch(() => null),
        ]);
        setTransactions(rows);
        setSplit(splitResult);
      } else {
        setTransactions([]);
        setSplit(null);
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
      setLoaded(false);
    }
  }, [isAuthenticated, refresh]);

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
    // total_amount or the cycle length changing both shift daily_limit — best
    // effort, same reasoning as in refresh() above.
    api.budgetSplit.get(token).then(setSplit).catch(() => setSplit(null));
    return saved;
  }, [budget, token]);

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
    // Today's spend changes spent_today/remaining_today/daily_limit — best
    // effort, same reasoning as in refresh() above.
    api.budgetSplit.get(token).then(setSplit).catch(() => setSplit(null));
    return result;
  }, [budget, token]);

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
    const daysLeft = budget ? Math.max(0, daysUntil(budget.cycle_end_date)) : 0;
    const daysGone = Math.max(0, periodDays - daysLeft);

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
    else if (spent > onPace * 1.15 && daysLeft > 0 && spent > 0) health = 'fast';
    else if (ratio >= 0.9) health = 'tight';
    else if (split?.mode === 'survival') health = 'tight';

    const byCategory = {};
    for (const t of transactions) {
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
      onPace: Number(onPace.toFixed(2)),
      health,
      byCategory,
      splitMessage: split?.message ?? null,
    };
  }, [budget, transactions, split]);

  const value = useMemo(() => ({
    budget,
    transactions,
    split,
    loading,
    loaded,
    error,
    refresh,
    saveBudget,
    addTransaction,
    supports: BACKEND_SUPPORTS,
    ...derived,
  }), [budget, transactions, split, loading, loaded, error, refresh, saveBudget,
       addTransaction, derived]);

  return <BudgetContext.Provider value={value}>{children}</BudgetContext.Provider>;
}

export function useBudget() {
  const ctx = useContext(BudgetContext);
  if (!ctx) throw new Error('useBudget must be used inside <BudgetProvider>.');
  return ctx;
}
