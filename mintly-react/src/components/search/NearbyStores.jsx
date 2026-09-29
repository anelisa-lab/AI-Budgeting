/**
 * "Stores near you" — the physical stores closest to the student's saved
 * location (GET /search/stores/nearby, app/routers/search.py), shown on the
 * Search screen so "where can I actually go buy this" doesn't require a trip
 * to Profile first.
 *
 * Independent of the search box on purpose: the location is set once in
 * Profile ("Use my current location" / "Insert your location", both of which
 * save immediately) and this list answers the same regardless of what a
 * student is typing above it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Badge, Button, Card, Skeleton,
} from '../ui/index.js';
import LocationMap from '../map/LocationMap.jsx';
import { api } from '../../api/client.js';
import { km } from '../../lib/format.js';

const TITLE_STYLE = { fontSize: 'var(--t-md)', fontFamily: 'var(--font-sans)', fontWeight: 'var(--fw-extra)' };

function fmtKm(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export default function NearbyStores({ token }) {
  const navigate = useNavigate();
  // loading | needs-location | error | ready
  const [state, setState] = useState('loading');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    if (!token) return;
    setState('loading');
    api.search.nearby(token)
      .then((result) => {
        if (result === null) { setState('needs-location'); return; }
        setData(result);
        setState('ready');
      })
      .catch((err) => {
        setError(err.message || 'Could not load stores near you.');
        setState('error');
      });
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const storeMarkers = useMemo(() => (data?.results || []).map((s) => ({
    lat: s.latitude,
    lng: s.longitude,
    label: `${s.store_name} — ${km(s.distance_km)}`,
  })), [data]);

  return (
    <Card className="stack" style={{ marginBottom: 'var(--s-5)' }}>
      <h2 style={TITLE_STYLE}><span aria-hidden="true">📍</span> Stores near you</h2>

      {state === 'loading' && <Skeleton height={180} radius="var(--r-lg)" />}

      {state === 'needs-location' && (
        <>
          <Alert tone="info" title="Add your location to see this">
            Save where you are in Profile and this fills in with the physical stores closest to you.
          </Alert>
          <div>
            <Button type="button" variant="secondary" onClick={() => navigate('/profile')}>
              Set my location
            </Button>
          </div>
        </>
      )}

      {state === 'error' && (
        <Alert tone="warning" title="Could not load nearby stores">
          {error}
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Button size="sm" variant="secondary" onClick={load}>Try again</Button>
          </div>
        </Alert>
      )}

      {state === 'ready' && (
        data.results.length === 0 ? (
          <p className="live-prices__empty">
            No physical stores within {fmtKm(data.max_distance_km)} km of {data.origin?.label} yet.
            Widen &ldquo;How far will you travel?&rdquo; in Profile to see more.
          </p>
        ) : (
          <>
            <span style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>
              Within {fmtKm(data.max_distance_km)} km of {data.origin?.label}
            </span>
            <LocationMap
              center={data.origin ? [data.origin.latitude, data.origin.longitude] : undefined}
              marker={data.origin ? { lat: data.origin.latitude, lng: data.origin.longitude } : null}
              extraMarkers={storeMarkers}
              fitToMarkers
              height={220}
            />
            <ul className="nearby-stores__list">
              {data.results.map((s) => (
                <li key={s.store_id} className="nearby-store">
                  <div>
                    <p style={{ fontWeight: 'var(--fw-extra)' }}>{s.store_name}</p>
                    {s.address && (
                      <p style={{ fontSize: 'var(--t-xs)', color: 'var(--c-muted)' }}>{s.address}</p>
                    )}
                    <div className="result__tags" style={{ marginTop: 'var(--s-1)' }}>
                      {s.delivery_available && <Badge tone="neutral">Delivers</Badge>}
                      {s.collection_available && <Badge tone="neutral">Collection</Badge>}
                    </div>
                  </div>
                  <span className="nearby-store__distance num">{km(s.distance_km)}</span>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </Card>
  );
}
