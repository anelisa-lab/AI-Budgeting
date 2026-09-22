/**
 * Skeleton — placeholder shown while data loads.
 * Member 7 · component library
 *
 * Preferred over a bare spinner for lists: it keeps the layout stable, so
 * the page doesn't jump when the real rows arrive.
 */
export default function Skeleton({ height = 16, width = '100%', radius }) {
  return (
    <div
      className="skeleton"
      style={{ height, width, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}
