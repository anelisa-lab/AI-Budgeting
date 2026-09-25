/**
 * DUT campuses a student can pick as "where I am" (Phase 5, Profile).
 *
 * The location is the origin for distance search, "near me", proximity
 * ranking and taxi fares (PUT /profile/location). Steve Biko is the point the
 * seed catalogue's store distances are measured from
 * (docs/seed/build_seed.py CAMPUS). The others are APPROXIMATE campus-area
 * points — close enough for "which store is nearer", which is all they are
 * used for. A student who wants their exact spot uses "Use my current
 * location" instead, which asks the browser.
 */
export const CAMPUSES = [
  { value: 'steve-biko', label: 'Steve Biko Campus (Durban)', latitude: -29.8547, longitude: 31.0084 },
  { value: 'ml-sultan', label: 'ML Sultan Campus (Durban)', latitude: -29.8563, longitude: 31.0122 },
  { value: 'ritson', label: 'Ritson Campus (Durban)', latitude: -29.8527, longitude: 31.0048 },
  { value: 'city', label: 'City Campus (Durban)', latitude: -29.8583, longitude: 31.0226 },
  { value: 'riverside', label: 'Riverside Campus (Pietermaritzburg)', latitude: -29.589, longitude: 30.388 },
  { value: 'indumiso', label: 'Indumiso Campus (Pietermaritzburg)', latitude: -29.642, longitude: 30.36 },
];

export function campusByValue(value) {
  return CAMPUSES.find((c) => c.value === value) || null;
}
