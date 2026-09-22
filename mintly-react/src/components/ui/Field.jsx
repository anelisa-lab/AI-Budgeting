/**
 * Field — label + control + hint + error, in one consistent block.
 * Member 7 · component library
 *
 * Every form control in the app is wrapped in this so that labels, required
 * markers, hint text and error messages look and behave identically
 * everywhere. It also wires up htmlFor / aria-describedby / aria-invalid,
 * which is what makes the forms usable with a screen reader.
 */
export default function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required && <span className="field__req" aria-hidden="true">*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {children({ id, describedBy, invalid: Boolean(error) })}

      {hint && !error && <p className="field__hint" id={hintId}>{hint}</p>}
      {error && (
        <p className="field__error" id={errorId} role="alert">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
