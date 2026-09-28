import Badge from './Badge.jsx';

/**
 * Pick n Pay has no live scraper (robots.txt disallows its search path — see
 * app/scrapers/__init__.py's STORE_NAMES comment). Its prices on Search,
 * Recommendations, Compare etc. all come from the seeded/price_feed
 * catalogue (product_offers), same as any other store's un-scraped price —
 * but with Checkers and Shoprite now showing genuinely live cards on the
 * same Search page, a Pick n Pay row needs its own label so it is never
 * mistaken for one of those. Every branch is seeded as "Pick n Pay <branch>"
 * (see mintly-react/docs/seed), hence the prefix match rather than an exact one.
 */
const NOT_LIVE_STORE_PREFIXES = ['Pick n Pay', 'SPAR'];

function isNotLiveStore(storeName) {
  return NOT_LIVE_STORE_PREFIXES.some((prefix) => (storeName || '').startsWith(prefix));
}

/**
 * PriceSourceBadge — where a price came from.
 *
 * Every seeded price is a modelled estimate; only a price confirmed with the
 * store (Phase 4 price feed: price_source 'live_api' or 'verified_manual')
 * shows its date. The backend decides which is which; this only labels it.
 */
export default function PriceSourceBadge({ offer }) {
  if (!offer) return null;
  if (isNotLiveStore(offer.store_name)) {
    return <Badge tone="warning">Catalogue price, not live</Badge>;
  }
  if (offer.price_is_estimate || !offer.price_verified_at) {
    return <Badge tone="neutral">Estimated price</Badge>;
  }
  const when = new Date(offer.price_verified_at);
  const label = Number.isNaN(when.getTime())
    ? 'Confirmed price'
    : `Confirmed ${when.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;
  return <Badge tone="success">{label}</Badge>;
}
