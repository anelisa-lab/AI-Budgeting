/**
 * Eyebrow — the small uppercase label above a heading.
 * Member 7 · component library
 */
export default function Eyebrow({ children, onDark = false }) {
  return (
    <p className={onDark ? 'eyebrow eyebrow--on-dark' : 'eyebrow'}>{children}</p>
  );
}
