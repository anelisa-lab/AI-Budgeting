/**
 * The shopping list as earlier builds kept it — in this browser only.
 *
 * Since Phase 5 the list is saved on the server (/shopping-list). This file
 * is kept for ONE job: reading a list an earlier build saved on this device,
 * so client.js can upload it to the student's account on their next sign-in
 * and then clear it here. Nothing new is written to it.
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
