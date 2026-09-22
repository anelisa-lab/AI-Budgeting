/**
 * Logo — the Mintly wordmark.
 * Member 7 · component library
 */
export default function Logo({ size = 36, showName = true }) {
  return (
    <span className="logo">
      <svg
        className="logo__mark"
        width={size}
        height={size}
        viewBox="0 0 40 40"
        role="img"
        aria-label="Mintly"
      >
        <rect x="3" y="4" width="26" height="32" rx="10" fill="var(--c-coral)" />
        <rect x="11" y="4" width="26" height="32" rx="10" fill="var(--c-forest)" />
        <circle cx="20" cy="15.5" r="5.4" fill="var(--c-cream)" />
      </svg>
      {showName && (
        <span className="logo__name" style={{ fontSize: size * 0.62 }}>mintly</span>
      )}
    </span>
  );
}
