/**
 * One recorded spend, with inline edit and delete.
 *
 * Spends used to be delete-and-re-enter only, so fixing R85 typed instead of
 * R8.50 meant losing the row and its date. Editing sends only what changed to
 * PUT /budgets/{id}/transactions/{tid}; the server re-derives what is left
 * (a bigger amount is spent, a smaller one refunded) and returns the budget.
 */

import { useState } from 'react';
import { Button, Field, Input, Select } from '../ui/index.js';
import { categoryIcon, categoryLabel } from '../../lib/categories.js';
import { money, shortDate } from '../../lib/format.js';
import { toDateOnly } from '../../api/normalise.js';
import * as v from '../../lib/validation.js';

export default function TransactionRow({
  t, categoryOptions, minDate, maxDate, canEdit, canDelete, onSave, onDelete,
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState(null);

  function open() {
    setForm({
      description: t.item_name,
      amount: String(t.amount),
      category: t.category || 'Other',
      isEssential: t.is_essential,
      transactionDate: toDateOnly(t.transaction_date) || '',
    });
    setErrors({});
    setEditing(true);
  }

  function set(name, value) {
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((e) => ({ ...e, [name]: undefined }));
  }

  async function save(event) {
    event.preventDefault();
    const found = {
      description: v.required(form.description, 'Description'),
      amount: v.amount(form.amount, { min: 0.01, max: 20000, fieldName: 'Amount' }),
      transactionDate: v.dateWithin(form.transactionDate, {
        min: minDate, max: maxDate, fieldName: 'Date',
      }),
    };
    const clean = Object.fromEntries(Object.entries(found).filter(([, msg]) => msg));
    setErrors(clean);
    if (Object.keys(clean).length) return;

    setSaving(true);
    try {
      await onSave({
        description: form.description,
        amount: Number(String(form.amount).replace(/[^\d.]/g, '')),
        category: form.category,
        isEssential: form.isEssential,
        transactionDate: form.transactionDate,
      });
      setEditing(false);
    } catch (err) {
      if (err.fieldErrors) setErrors(err.fieldErrors);
      else setErrors({ description: err.message || 'Could not save that change.' });
    } finally {
      setSaving(false);
    }
  }

  if (editing && form) {
    return (
      <form className="stack stack--tight txn-edit" onSubmit={save} noValidate
        style={{ padding: 'var(--s-4) 0', borderBottom: '1px solid var(--c-line)' }}>
        <Field id={`edit-desc-${t.id}`} label="What did you buy?" error={errors.description} required>
          {({ id, describedBy, invalid }) => (
            <Input id={id} value={form.description} invalid={invalid} describedBy={describedBy}
              onChange={(e) => set('description', e.target.value)} />
          )}
        </Field>
        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s-3)' }}>
          <div className="grow">
            <Field id={`edit-amount-${t.id}`} label="Amount" error={errors.amount} required>
              {({ id, describedBy, invalid }) => (
                <Input id={id} inputMode="decimal" prefix="R" value={form.amount}
                  invalid={invalid} describedBy={describedBy}
                  onChange={(e) => set('amount', e.target.value.replace(/[^\d.]/g, ''))} />
              )}
            </Field>
          </div>
          <div className="grow">
            <Field id={`edit-date-${t.id}`} label="Date" error={errors.transactionDate}>
              {({ id, describedBy, invalid }) => (
                <Input id={id} type="date" value={form.transactionDate} min={minDate} max={maxDate}
                  invalid={invalid} describedBy={describedBy}
                  onChange={(e) => set('transactionDate', e.target.value)} />
              )}
            </Field>
          </div>
        </div>
        <Field id={`edit-cat-${t.id}`} label="Category">
          {({ id, describedBy }) => (
            <Select id={id} describedBy={describedBy} value={form.category}
              options={categoryOptions.some((o) => o.value.toLowerCase() === form.category.toLowerCase())
                ? categoryOptions
                : [...categoryOptions, { value: form.category, label: form.category }]}
              onChange={(e) => set('category', e.target.value)} />
          )}
        </Field>
        <label className="checkbox" htmlFor={`edit-ess-${t.id}`}>
          <input id={`edit-ess-${t.id}`} type="checkbox" checked={form.isEssential}
            onChange={(e) => set('isEssential', e.target.checked)} />
          <span>This was something I needed, not something I wanted</span>
        </label>
        <div className="row" style={{ gap: 'var(--s-3)' }}>
          <Button type="submit" size="sm" loading={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
          <Button type="button" size="sm" variant="quiet" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="txn">
      <span className="txn__icon" aria-hidden="true">{categoryIcon(t.category)}</span>
      <div className="grow">
        <p className="txn__name">{t.item_name}</p>
        <p className="txn__meta">
          {categoryLabel(t.category)} · {shortDate(t.transaction_date)}
          {t.is_essential && ' · essential'}
        </p>
      </div>
      <span className="txn__amt num">{money(t.amount)}</span>
      {canEdit && (
        <Button variant="quiet" size="sm" aria-label={`Edit ${t.item_name}, ${money(t.amount)}`} onClick={open}>
          ✎
        </Button>
      )}
      {canDelete && (
        <Button variant="quiet" size="sm" aria-label={`Delete ${t.item_name}, ${money(t.amount)}`} onClick={onDelete}>
          ✕
        </Button>
      )}
    </div>
  );
}
