/**
 * Button — the app's only clickable primitive.
 * Member 7 (Frontend Lead) · component library
 *
 * Never style a <button> ad hoc in a screen. If you need a new look, add a
 * variant here so every screen gets it at the same time.
 */
export default function Button({
  children,
  variant = 'primary',   // primary | secondary | ghost | quiet | danger
  size = 'md',           // sm | md | lg
  block = false,
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  ...rest
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    block ? 'btn--block' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
