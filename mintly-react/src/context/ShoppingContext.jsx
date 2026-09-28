/**
 * ShoppingContext — the student's shopping list.
 *
 * Replaces the old CatalogueContext, which loaded a 257-row product catalogue
 * from a bundled JSON file and held it in memory for client-side filtering.
 * That is gone: the backend owns the catalogue and GET /search does the
 * filtering, sorting and paging server-side, so the Search screen queries the
 * API instead of filtering an array. See lib/search.js.
 *
 * What remains here is the list itself, which is shared by Search (add to
 * list — catalogue offers and live Checkers items), the nav (count + total
 * badge), Compare (the list, and pricing it at every store) and Budget
 * (the list against what's left).
 *
 * The list is saved to the student's account (Phase 5, /shopping-list), so
 * it follows them to any device. A list saved in this browser by an earlier
 * build is uploaded once on sign-in — see client.js `shoppingList`.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { api } from '../api/client.js';
import { EMPTY_LIST } from '../api/normalise.js';
import { useAuth } from './AuthContext.jsx';

const ShoppingContext = createContext(null);

export function ShoppingProvider({ children }) {
  const { user, token } = useAuth();
  const userId = user?.id ?? null;
  // { lines: catalogue offers, liveLines: live store items, summary } — the
  // server's answer, replaced whole after every change.
  const [list, setList] = useState(EMPTY_LIST);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  // The list belongs to the signed-in account: switch storage whenever the
  // account changes, and show nothing while signed out.
  useEffect(() => {
    let cancelled = false;
    api.shoppingList.setOwner(userId, token);
    setReady(false);
    setError(null);
    api.shoppingList.list()
      .then((result) => { if (!cancelled) setList(result); })
      .catch((err) => {
        if (cancelled) return;
        setList(EMPTY_LIST);
        setError(err?.message || 'Could not load your shopping list.');
      })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [userId, token]);

  const addOffer = useCallback(async (offer, qty = 1) => {
    setList(await api.shoppingList.add(offer, qty));
  }, []);

  const setQty = useCallback(async (offerId, qty) => {
    setList(await api.shoppingList.setQty(offerId, qty));
  }, []);

  const removeOffer = useCallback(async (offerId) => {
    setList(await api.shoppingList.remove(offerId));
  }, []);

  /** A live store item (GET /api/search result). Refused by the server if it can't be bought. */
  const addLive = useCallback(async (item, qty = 1) => {
    setList(await api.shoppingList.addLive(item, qty));
  }, []);

  const setLiveQty = useCallback(async (itemId, qty) => {
    setList(await api.shoppingList.setLiveQty(itemId, qty));
  }, []);

  const removeLive = useCallback(async (itemId) => {
    setList(await api.shoppingList.removeLive(itemId));
  }, []);

  const clearList = useCallback(async () => {
    setList(await api.shoppingList.clear());
  }, []);

  const { lines, liveLines, summary } = list;

  /**
   * The list total at the prices SAVED when each item was added, counting
   * only what can still be bought (worked out by the backend). Item prices
   * only: delivery is an order-level cost that Compare adds once per store.
   */
  const listTotal = summary.total;
  const listCount = summary.count;

  const qtyOf = useCallback(
    (offerId) => lines.find((l) => l.offer_id === offerId)?.qty || 0,
    [lines],
  );

  const liveQtyOf = useCallback(
    (itemId) => liveLines.find((l) => l.item_id === itemId)?.qty || 0,
    [liveLines],
  );

  const value = useMemo(() => ({
    lines,
    liveLines,
    summary,
    ready,
    error,
    listTotal,
    listCount,
    qtyOf,
    liveQtyOf,
    addOffer,
    setQty,
    removeOffer,
    addLive,
    setLiveQty,
    removeLive,
    clearList,
    isLocalOnly: api.shoppingList.isLocalOnly,
  }), [lines, liveLines, summary, ready, error, listTotal, listCount, qtyOf, liveQtyOf,
       addOffer, setQty, removeOffer, addLive, setLiveQty, removeLive, clearList]);

  return <ShoppingContext.Provider value={value}>{children}</ShoppingContext.Provider>;
}

export function useShopping() {
  const ctx = useContext(ShoppingContext);
  if (!ctx) throw new Error('useShopping must be used inside <ShoppingProvider>.');
  return ctx;
}
