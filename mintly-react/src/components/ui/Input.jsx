import { useState } from 'react';

/**
 * Input — text / email / number / password.
 * Member 7 · component library
 *
 * `prefix` renders a fixed symbol inside the field (used for "R" on every
 * money input so a student never has to wonder about the unit).
 * Password inputs get a show/hide toggle automatically.
 */
export default function Input({
  id,
  type = 'text',
  prefix,
  invalid = false,
  describedBy,
  className = '',
  ...rest
}) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const actualType = isPassword && revealed ? 'text' : type;

  const control = (
    <input
      id={id}
      type={actualType}
      className={['input', invalid ? 'input--invalid' : '', className]
        .filter(Boolean).join(' ')}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );

  if (!prefix && !isPassword) return control;

  return (
    <div className="input-group">
      {prefix && <span className="input-group__prefix" aria-hidden="true">{prefix}</span>}
      {control}
      {isPassword && (
        <button
          type="button"
          className="input-group__action"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? 'Hide password' : 'Show password'}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      )}
    </div>
  );
}
