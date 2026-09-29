/**
 * Search screen — live store prices for the typed word.
 *
 * Trimmed down to just the search box and the price cards from
 * components/search/LivePrices.jsx. LivePrices already merges Pick n Pay
 * and SPAR's catalogue matches into the same grid as the live
 * Checkers/Shoprite cards, so the old separate filter rail + catalogue
 * results list below it was showing a second, differently-filtered list of
 * the same products — removed rather than kept as duplicate, confusing UI.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Eyebrow, Input } from '../components/ui/index.js';
import { useAuth } from '../context/AuthContext.jsx';
import LivePrices from '../components/search/LivePrices.jsx';
import NearbyStores from '../components/search/NearbyStores.jsx';

export default function Search() {
  const { token } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const [draft, setDraft] = useState(q);

  return (
    <div className="stack stack--loose">
      <div>
        <Eyebrow>Find it cheaper</Eyebrow>
        <h1 style={{ fontSize: 'var(--t-2xl)', color: 'var(--c-forest)', marginTop: 'var(--s-3)' }}>
          What are you looking for?
        </h1>
        <p style={{ color: 'var(--c-muted)', marginTop: 'var(--s-3)', maxWidth: '58ch' }}>
          Search Checkers, Shoprite, SuperbHyper, Pick n Pay and SPAR at once.
        </p>
      </div>

      <form
        className="search-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(draft ? { q: draft } : {}, { replace: true });
        }}
      >
        <label className="sr-only" htmlFor="q">Search for a product</label>
        <Input
          id="q"
          type="search"
          placeholder="rice, soap, bread…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        <Button type="submit">Search</Button>
      </form>

      <LivePrices token={token} query={q} />

      <NearbyStores token={token} />
    </div>
  );
}
