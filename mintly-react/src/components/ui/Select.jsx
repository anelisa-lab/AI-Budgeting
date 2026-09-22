/**
 * Select — native <select> with the app's chevron and focus ring.
 * Member 7 · component library
 *
 * Deliberately native rather than a custom dropdown: it is keyboard- and
 * screen-reader-correct for free, and on a phone it opens the OS picker,
 * which is faster for students on low-end devices.
 */
export default function Select({
  id,
  options = [],
  invalid = false,
  describedBy,
  ...rest
}) {
  return (
    <div className="select-wrap">
      <select
        id={id}
        className={['select', invalid ? 'select--invalid' : ''].filter(Boolean).join(' ')}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
