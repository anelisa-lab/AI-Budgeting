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
 * list), the nav (the count badge) and Compare (price it at every store).
 *
 * The list is saved to the student's account (Phase 5, /shopping-list), so
 * it follows them to any device. A list saved in this browser by an earlier
 * build is uploaded once on sign-in — see client.js `shoppingList`.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { api } from '../api/client.js';
import { useAuth } from './AuthContext.jsx';

const ShoppingContext = createContext(null);

export function ShoppingProvider({ children }) {
  const { user, token } = useAuth();
  const userId = user?.id ?? null;
  const [lines, setLines] = useState([]);
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
      .then((rows) => { if (!cancelled) setLines(rows); })
      .catch((err) => {
        if (cancelled) return;
        setLines([]);
        setError(err?.message || 'Could not load your shopping list.');
      })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [userId, token]);

  const addOffer = useCallback(async (offer, qty = 1) => {
    setLines(await api.shoppingList.add(offer, qty));
  }, []);

  const setQty = useCallback(async (offerId, qty) => {
    setLines(await api.shoppingList.setQty(offerId, qty));
  }, []);

  const removeOffer = useCallback(async (offerId) => {
    setLines(await api.shoppingList.remove(offerId));
  }, []);

  const clearList = useCallback(async () => {
    setLines(await api.shoppingList.clear());
  }, []);

  /**
   * Item prices only. Delivery is an ORDER-level cost and is added once per
   * store on the Compare screen — adding each offer's shipping_cost per line
   * would charge a student one delivery fee per item, which is simply wrong.
   */
  const listTotal = useMemo(
    () => Number(lines.reduce((sum, l) => sum + l.price * l.qty, 0).toFixed(2)),
    [lines],
  );

  const listCount = useMemo(
    () => lines.reduce((sum, l) => sum + l.qty, 0),
    [lines],
  );

  const qtyOf = useCallback(
    (offerId) => lines.find((l) => l.offer_id === offerId)?.qty || 0,
    [lines],
  );

  const value = useMemo(() => ({
    lines,
    ready,
    error,
    listTotal,
    listCount,
    qtyOf,
    addOffer,
    setQty,
    removeOffer,
    clearList,
    isLocalOnly: api.shoppingList.isLocalOnly,
  }), [lines, ready, error, listTotal, listCount, qtyOf, addOffer, setQty,
       removeOffer, clearList]);

  return <ShoppingContext.Provider value={value}>{children}</ShoppingContext.Provider>;
}

export function useShopping() {
  const ctx = useContext(ShoppingContext);
  if (!ctx) throw new Error('useShopping must be used inside <ShoppingProvider>.');
  return ctx;
}
