/**
 * Progress — a budget bar.
 * Member 7 · component library
 *
 * `tone` is chosen by the caller from the spend ratio, so the bar carries
 * the same meaning as the number next to it: green while there is room,
 * amber when it is tight, red when the budget is blown.
 */
export default function Progress({
  value = 0,          // 0..1
  tone = 'brand',     // brand | accent | warning | danger
  surface = 'light',  // light | dark | butter
  label,
}) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
  const trackClass = surface === 'dark'
    ? 'progress progress--on-dark'
    : surface === 'butter'
      ? 'progress progress--on-butter'
      : 'progress';
  const fillClass = tone === 'brand' ? 'progress__fill' : `progress__fill progress__fill--${tone}`;

  return (
    <div
      className={trackClass}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={fillClass} style={{ width: `${pct}%` }} />
    </div>
  );
}
