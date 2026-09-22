/**
 * Badge — a small status label.
 * Member 7 · component library
 *
 * tone: neutral | brand | accent | success | warning | danger
 * Semantic tones (success/warning/danger) mean something; neutral/brand/
 * accent are decorative. Don't use a semantic tone for decoration.
 */
export default function Badge({ children, tone = 'neutral', icon, className = '' }) {
  return (
    <span className={`badge badge--${tone} ${className}`.trim()}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}
