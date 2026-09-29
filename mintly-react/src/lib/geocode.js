/**
 * Address search, backed by OpenStreetMap's Nominatim — free, no API key,
 * which is why it was picked over Google/Mapbox geocoding (both need a
 * billing-linked key this project doesn't have). It's a public, rate-limited
 * service (usage policy: at most ~1 request/second, and never on every
 * keystroke), so callers of `geocodeAddress` must debounce and/or gate it
 * behind an explicit "Find on map" action rather than searching as-you-type.
 *
 * South Africa is not hardcoded as a bias so a student temporarily elsewhere
 * (home for the holidays, an exchange trip) can still find themselves.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/**
 * Resolves to an array of { latitude, longitude, label } matches, nearest
 * relevance first, or throws an Error with a message safe to show directly.
 */
export async function geocodeAddress(query, { signal, limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 3) throw new Error('Type at least 3 characters of the address.');

  const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=0&limit=${limit}&q=${encodeURIComponent(q)}`;
  let response;
  try {
    response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('Could not reach the map search right now. Check your connection and try again.');
  }
  if (!response.ok) {
    throw new Error('The map search is unavailable right now. Try again in a moment.');
  }
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`No place found for "${q}". Try a fuller address, or drop the pin on the map instead.`);
  }
  return rows
    .map((r) => ({
      latitude: Number(r.lat),
      longitude: Number(r.lon),
      label: r.display_name,
    }))
    .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
}

/** The reverse: a coordinate to a human-readable place name, best-effort. */
export async function reverseGeocode(latitude, longitude, { signal } = {}) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`;
  try {
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const row = await response.json().catch(() => null);
    return row?.display_name || null;
  } catch {
    // Best-effort only — callers fall back to their own default label.
    return null;
  }
}
