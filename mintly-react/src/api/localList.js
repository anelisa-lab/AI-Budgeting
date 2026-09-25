/**
 * The shopping list — held on this device, NOT on the backend.
 *
 * ⚠ READ THIS BEFORE CHANGING ANYTHING HERE ⚠
 *
 * This is not a mock of a backend endpoint and it must never be mistaken for
 * one. The backend genuinely has no shopping-list API yet:
 *
 *   sql/schema.sql DOES define `comparison_lists` and `comparison_items`
 *   app/routers/   does NOT expose any router for them
 *
 * So the list a student builds on the Search screen lives in this browser,
 * under one key, until those endpoints exist. The Compare screen says so on
 * screen — it is never presented as saved to an account.
 *
 * WHAT MAKES IT EASY TO REPLACE
 * -----------------------------
 * Every function below is async and returns the WHOLE list, which is exactly
 * the shape a REST endpoint would return. `client.js` calls them through the
 * same `shoppingList.*` namespace it would use for real endpoints, so swapping
 * this for the real thing is an edit to client.js alone — no context, no
 * screen, no component changes.
 *
 * The four endpoints needed, and the request/response each one should use, are
 * specified in docs/BACKEND_INTEGRATION.md under "Backend dependencies".
 *
 * A line stores a snapshot of the offer it came from (price, store, shipping)
 * so the list still renders if an offer is later delisted. Live prices are
 * re-fetched from GET /search whenever the Compare screen opens, so a stale
 * snapshot is never what the student is shown a total for.
 */

/**
 * One list PER ACCOUNT on this device. Before Phase 4 there was a single key,
 * so on a shared computer (a res common room, a campus lab) the next student
 * to sign in saw — and could edit — the previous student's list. The key now
 * carries the signed-in user's id; ShoppingContext calls setOwner() whenever
 * the account changes, and nothing is read or written while signed out.
 */
const KEY_PREFIX = 'uniwallet.shoppingList.v3.u';
// Lists saved by earlier builds under one shared key. They are handed to the
// first account that signs in on this device, once, and then removed.
const LEGACY_KEYS = ['uniwallet.shoppingList.v2', 'mintly.shoppingList.v2'];
const MAX_QTY = 20;

let ownerId = null;

/** Called by ShoppingContext with the signed-in user's id (or null). */
export function setOwner(userId) {
  ownerId = userId == null ? null : String(userId);
  if (ownerId) migrateLegacy();
}

function storageKey() {
  return ownerId ? `${KEY_PREFIX}${ownerId}` : null;
}

function migrateLegacy() {
  try {
    const key = storageKey();
    for (const legacy of LEGACY_KEYS) {
      const raw = localStorage.getItem(legacy);
      if (raw === null) continue;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, raw);
      localStorage.removeItem(legacy);
    }
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}

function read() {
  const key = storageKey();
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Private browsing, blocked storage, or corrupt JSON. An empty list is the
    // right answer — the app must not crash because storage said no.
    return [];
  }
}

function write(lines) {
  const key = storageKey();
  if (!key) return [];
  try {
    localStorage.setItem(key, JSON.stringify(lines));
  } catch {
    /* Storage unavailable — the list still works until the tab is closed. */
  }
  return lines;
}

const clampQty = (qty) => Math.max(1, Math.min(MAX_QTY, Math.round(Number(qty) || 1)));

/** GET equivalent. */
export async function list() {
  return read();
}

/**
 * POST equivalent. `offer` is a SearchResultItem straight from GET /search,
 * already coerced by normalise.offerFromApi.
 */
export async function add(offer, qty = 1) {
  const lines = read();
  const existing = lines.find((l) => l.offer_id === offer.offer_id);
  if (existing) {
    existing.qty = clampQty(existing.qty + qty);
  } else {
    lines.push({
      offer_id: offer.offer_id,
      product_id: offer.product_id,
      product_name: offer.product_name,
      brand: offer.brand,
      size: offer.size,
      category: offer.category,
      is_essential: offer.is_essential,
      store_id: offer.store_id,
      store_name: offer.store_name,
      store_type: offer.store_type,
      price: offer.price,
      shipping_cost: offer.shipping_cost,
      total_cost: offer.total_cost,
      qty: clampQty(qty),
      added_at: new Date().toISOString(),
    });
  }
  return write(lines);
}

/** PATCH equivalent. qty <= 0 removes the line, matching the old contract. */
export async function setQty(offerId, qty) {
  const next = Number(qty);
  if (!Number.isFinite(next) || next <= 0) return remove(offerId);
  const lines = read().map((l) => (l.offer_id === offerId ? { ...l, qty: clampQty(next) } : l));
  return write(lines);
}

/** DELETE equivalent. */
export async function remove(offerId) {
  return write(read().filter((l) => l.offer_id !== offerId));
}

/** DELETE-all equivalent. */
export async function clear() {
  return write([]);
}
