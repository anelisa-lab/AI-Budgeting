/**
 * Card — the app's surface primitive.
 * Member 7 · component library
 *
 * tone: paper | tint | forest | butter | coral
 * Use `forest` / `butter` / `coral` only for the one or two things on a
 * screen that genuinely deserve emphasis. If everything is a coloured card,
 * nothing reads as important.
 */
export default function Card({
  children,
  tone = 'paper',
  flat = false,
  interactive = false,
  as: Tag = 'div',
  className = '',
  ...rest
}) {
  const toneClass = tone === 'paper' ? '' : `card--${tone}`;
  const classes = [
    'card',
    toneClass,
    flat ? 'card--flat' : '',
    interactive ? 'card--interactive' : '',
    className,
  ].filter(Boolean).join(' ');

  return <Tag className={classes} {...rest}>{children}</Tag>;
}
