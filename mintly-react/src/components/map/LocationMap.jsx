/**
 * LocationMap — a live Leaflet map over OpenStreetMap tiles. No API key: OSM's
 * tile server and its Nominatim geocoder (lib/geocode.js) are free to use
 * for a project at this scale, which is why they were picked over Google
 * Maps/Mapbox (both need a billing-linked key the team doesn't have).
 *
 * Two things live on the map:
 *   - `marker`      one pin the student can drag (or place by clicking the
 *                    map) when `onMarkerChange` is given — used by Profile's
 *                    "Insert your location" picker.
 *   - `extraMarkers` any number of read-only pins with a popup label — used
 *                    by Search's "Stores near you" to plot the student and
 *                    each nearby store.
 *
 * `fitToMarkers` frames `center` and every `extraMarkers` point together
 * instead of a fixed zoom on `center` alone — pass it for a read-only map
 * with more than one pin, or a nearby pin can end up off the edge of a small
 * map at a tight zoom.
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// Leaflet's default marker icon is built from relative URLs that assume the
// image files sit next to the CSS on disk. A bundler rewrites those imports
// into hashed asset URLs instead, so without this the default pin 404s and
// silently doesn't render. This runs once per bundle, not per map.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const STORE_ICON = new L.DivIcon({
  className: 'map-pin map-pin--store',
  html: '<span aria-hidden="true">🛒</span>',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  popupAnchor: [0, -26],
});

const DUT_STEVE_BIKO = [-29.85, 31.01]; // fallback centre: Durban, before any location is known

export default function LocationMap({
  center,
  zoom = 15,
  marker,
  onMarkerChange,
  extraMarkers = [],
  fitToMarkers = false,
  height = 260,
  className = '',
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const extraLayerRef = useRef(null);
  const onMarkerChangeRef = useRef(onMarkerChange);
  onMarkerChangeRef.current = onMarkerChange;

  // Create the map once. `center`/`zoom` are only the INITIAL view — see the
  // effect below for keeping it in sync with prop changes afterwards.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current, { scrollWheelZoom: false })
      .setView(center || DUT_STEVE_BIKO, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on('click', (e) => onMarkerChangeRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    extraLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      extraLayerRef.current = null;
    };
  }, []);

  // Re-centre when the caller hands us a new point (e.g. a geocoded address),
  // without tearing the map down. Depends on the coordinates themselves, not
  // the `center` array's identity, so a parent that builds `[lat, lng]` fresh
  // every render doesn't reset the student's own pan/zoom on every keystroke.
  const centerLat = center?.[0];
  const centerLng = center?.[1];
  useEffect(() => {
    if (mapRef.current && !fitToMarkers && centerLat != null && centerLng != null) {
      mapRef.current.setView([centerLat, centerLng], zoom);
    }
  }, [centerLat, centerLng, fitToMarkers]);

  // Read-only mode (Search's "stores near you"): a fixed zoom on `center`
  // alone can leave every extra pin off the edge of a small map — 1.4 km at
  // zoom 15 is already most of the frame. Frame the student and every store
  // together instead, tightest first, re-fitting whenever either changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitToMarkers) return;
    const points = [];
    if (centerLat != null && centerLng != null) points.push([centerLat, centerLng]);
    for (const m of extraMarkers) points.push([m.lat, m.lng]);
    if (points.length === 0) return;
    if (points.length === 1) map.setView(points[0], zoom);
    else map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 16 });
  }, [centerLat, centerLng, extraMarkers, fitToMarkers]);

  // The one draggable/placeable pin.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!marker) {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      return;
    }
    const draggable = Boolean(onMarkerChange);
    if (!markerRef.current) {
      markerRef.current = L.marker([marker.lat, marker.lng], { draggable }).addTo(map);
      markerRef.current.on('dragend', () => {
        const pos = markerRef.current.getLatLng();
        onMarkerChangeRef.current?.({ lat: pos.lat, lng: pos.lng });
      });
    } else {
      markerRef.current.setLatLng([marker.lat, marker.lng]);
    }
  }, [marker?.lat, marker?.lng, onMarkerChange]);

  // Read-only pins — e.g. every nearby store.
  useEffect(() => {
    if (!extraLayerRef.current) return;
    extraLayerRef.current.clearLayers();
    for (const m of extraMarkers) {
      L.marker([m.lat, m.lng], { icon: STORE_ICON })
        .bindPopup(m.label || '')
        .addTo(extraLayerRef.current);
    }
  }, [extraMarkers]);

  return (
    <div
      ref={containerRef}
      className={`location-map ${className}`.trim()}
      style={{ height }}
      role="group"
      aria-label="Map"
    />
  );
}
