/**
 * Switch — an accessible on/off toggle (role="switch").
 *
 * A plain checkbox reads to screen readers as "checked/unchecked", which is
 * right for a form field but wrong for a setting that takes effect the
 * moment it's flipped (like "SMS is on"). `role="switch"` + `aria-checked`
 * is the pattern browsers and screen readers expect for that instead.
 *
 * Clicking the paired <label htmlFor> also activates this, because a
 * <button> is a labelable element per the HTML spec — no extra wiring needed.
 */
export default function Switch({
  id, checked, onChange, disabled = false, label,
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`switch${checked ? ' switch--on' : ''}`}
    >
      <span className="switch__thumb" />
    </button>
  );
}
