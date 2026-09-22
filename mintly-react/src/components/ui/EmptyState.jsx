/**
 * EmptyState — what a list shows when it has nothing in it.
 * Member 7 · component library
 *
 * An empty list with no explanation reads as a broken screen. Every empty
 * state in this app says what happened and offers the next action.
 */
export default function EmptyState({ icon = '🔍', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">{icon}</div>
      <h3 className="empty__title">{title}</h3>
      {children && <p className="empty__body">{children}</p>}
      {action}
    </div>
  );
}
