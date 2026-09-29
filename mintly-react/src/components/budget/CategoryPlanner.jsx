/**
 * "Plan your priorities" — the student jots down the categories that matter
 * this period (groceries, toiletries, transport…), optionally with an amount
 * each, and the app hands back a spreadsheet to budget in: one row per chosen
 * category, sized to the money they have and how long it must last (daily
 * columns for a week, weekly columns for a fortnight or a month).
 *
 * This component only edits the list; BudgetEntry owns the state and does the
 * download and the save, because it also knows the amount and period on the form.
 */

import { useState } from 'react';
import { Alert, Button, Card, Eyebrow, Input } from '../ui/index.js';
import {
  MAX_PLANNER_CATEGORIES, PLANNER_SUGGESTIONS, categoryIcon, cleanPlannerName,
  periodWord, plannerNameError,
} from '../../lib/categories.js';
import { money } from '../../lib/format.js';

export default function CategoryPlanner({
  rows,
  onChange,
  spendable = null,        // what can be spent, to show what is still unplanned
  periodDays = 30,
  onDownload,
  downloading = false,
  onSave = null,           // only when there is a saved budget to attach them to
  saving = false,
  dirty = false,
  error = null,
}) {
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState(null);

  const names = rows.map((r) => r.name);
  const planned = rows.reduce((sum, r) => sum + (Number(r.plannedAmount) || 0), 0);
  const unplanned = spendable === null ? null : Number((spendable - planned).toFixed(2));
  const word = periodWord(periodDays);

  function add(name) {
    const problem = plannerNameError(name, names);
    if (problem) {
      setDraftError(problem);
      return false;
    }
    onChange([...rows, { name: cleanPlannerName(name), plannedAmount: '' }]);
    setDraftError(null);
    return true;
  }

  function toggleSuggestion(name) {
    const at = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (at >= 0) onChange(rows.filter((_, i) => i !== at));
    else add(name);
  }

  function submitDraft(event) {
    event.preventDefault();
    if (add(draft)) setDraft('');
  }

  function setAmount(index, value) {
    onChange(rows.map((r, i) => (i === index ? { ...r, plannedAmount: value.replace(/[^\d.]/g, '') } : r)));
  }

  return (
    <Card id="priorities">
      <Eyebrow>Plan your priorities</Eyebrow>
      <h2 className="card__title" style={{ marginTop: 'var(--s-3)' }}>
        What matters most this {word}?
      </h2>
      <p style={{ color: 'var(--c-muted)', fontSize: 'var(--t-sm)', marginTop: 'var(--s-2)' }}>
        Pick or type the things you need to spend on. We will build you a spreadsheet with a row
        for each one, ready to budget with the money you have for the {word}.
      </p>

      <div className="stack" style={{ marginTop: 'var(--s-5)' }}>
        <div>
          <p className="field__label" id="planner-suggestions-label" style={{ marginBottom: 'var(--s-2)' }}>
            Tap to add
          </p>
          <div className="chips" role="group" aria-labelledby="planner-suggestions-label">
            {PLANNER_SUGGESTIONS.map((name) => {
              const on = names.some((n) => n.toLowerCase() === name.toLowerCase());
              return (
                <button
                  key={name}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() => toggleSuggestion(name)}
                >
                  <span aria-hidden="true">{categoryIcon(name)}</span> {name}
                </button>
              );
            })}
          </div>
        </div>

        <form onSubmit={submitDraft} noValidate>
          <label className="field__label" htmlFor="planner-custom">Something else?</label>
          <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--s-3)', marginTop: 'var(--s-2)' }}>
            <div className="grow">
              <Input
                id="planner-custom"
                placeholder="e.g. Haircut, Books, Church"
                value={draft}
                maxLength={60}
                invalid={Boolean(draftError)}
                describedBy={draftError ? 'planner-custom-error' : undefined}
                onChange={(e) => { setDraft(e.target.value); if (draftError) setDraftError(null); }}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={rows.length >= MAX_PLANNER_CATEGORIES}>
              Add
            </Button>
          </div>
          {draftError && (
            <p className="field__error" id="planner-custom-error" role="alert" style={{ marginTop: 'var(--s-2)' }}>
              <span aria-hidden="true">⚠</span>
              <span>{draftError}</span>
            </p>
          )}
        </form>

        {rows.length > 0 && (
          <div>
            <div className="row row--between">
              <p className="field__label" style={{ margin: 0 }}>Your priorities</p>
              <p className="field__hint" style={{ margin: 0 }}>Amount is optional — you can fill it in on the sheet.</p>
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 'var(--s-3) 0 0' }}>
              {rows.map((row, index) => (
                <li key={row.name.toLowerCase()} className="txn">
                  <span className="txn__icon" aria-hidden="true">{categoryIcon(row.name)}</span>
                  <div className="grow"><p className="txn__name">{row.name}</p></div>
                  <div style={{ width: '8.5rem' }}>
                    <Input
                      id={`planner-amount-${index}`}
                      aria-label={`Planned amount for ${row.name}`}
                      inputMode="decimal"
                      prefix="R"
                      placeholder="0"
                      value={row.plannedAmount}
                      onChange={(e) => setAmount(index, e.target.value)}
                    />
                  </div>
                  <Button
                    variant="quiet"
                    size="sm"
                    aria-label={`Remove ${row.name}`}
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                  >✕</Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {rows.length > 0 && unplanned !== null && planned > 0 && (
          <Alert tone={unplanned < 0 ? 'danger' : 'info'} title={unplanned < 0 ? 'That is more than you can spend' : undefined}>
            {unplanned < 0
              ? `You have planned ${money(planned)}, which is ${money(-unplanned)} more than the ${money(spendable)} you can spend.`
              : `${money(planned)} planned, ${money(unplanned)} of your ${money(spendable)} still to give a job.`}
          </Alert>
        )}

        {error && <Alert tone="danger" title="Could not do that">{error}</Alert>}

        <div className="row" style={{ gap: 'var(--s-3)' }}>
          <Button
            type="button"
            className="grow"
            loading={downloading}
            disabled={rows.length === 0}
            onClick={onDownload}
          >
            {downloading ? 'Building your sheet…' : 'Download budget spreadsheet (.xlsx)'}
          </Button>
          {onSave && (
            <Button
              type="button"
              variant="secondary"
              loading={saving}
              disabled={!dirty}
              onClick={onSave}
            >
              {saving ? 'Saving…' : dirty ? 'Save to dashboard' : 'Saved'}
            </Button>
          )}
        </div>
        <p className="field__hint" style={{ margin: 0 }}>
          {rows.length === 0
            ? 'Add at least one category to get your spreadsheet.'
            : onSave
              ? 'Saving shows planned vs spent for each category on your dashboard.'
              : 'Set your budget below to also see planned vs spent on your dashboard.'}
        </p>
      </div>
    </Card>
  );
}
