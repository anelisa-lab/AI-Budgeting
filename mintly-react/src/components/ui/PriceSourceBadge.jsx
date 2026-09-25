import Badge from './Badge.jsx';

/**
 * PriceSourceBadge — where a price came from.
 *
 * Every seeded price is a modelled estimate; only a price confirmed with the
 * store (Phase 4 price feed: price_source 'live_api' or 'verified_manual')
 * shows its date. The backend decides which is which; this only labels it.
 */
export default function PriceSourceBadge({ offer }) {
  if (!offer) return null;
  if (offer.price_is_estimate || !offer.price_verified_at) {
    return <Badge tone="neutral">Estimated price</Badge>;
  }
  const when = new Date(offer.price_verified_at);
  const label = Number.isNaN(when.getTime())
    ? 'Confirmed price'
    : `Confirmed ${when.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}`;
  return <Badge tone="success">{label}</Badge>;
}
