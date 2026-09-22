/**
 * Alert — inline feedback attached to a screen or a form.
 * Member 7 · component library
 *
 * This is the app's main answer to the rubric's "Quality of feedback" line.
 * Use it for anything the user needs to read and act on. Use Toast instead
 * for confirmation of something that already succeeded.
 */
const ICONS = { info: 'ℹ', success: '✓', warning: '!', danger: '⚠' };

export default function Alert({ tone = 'info', title, children }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="alert__icon" aria-hidden="true">{ICONS[tone]}</span>
      <div>
        {title && <strong className="alert__title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}
