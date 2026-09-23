# Daily Budget Split — response format

**Member 6 → Member 8.** Phase 3 handoff: everything the UI needs to render the
Daily Budget Split, and the traps that will bite if the numbers are treated as
ordinary totals.

Source of truth: `app/budget_split.py` (the arithmetic) and
`app/routers/budget_split.py` (the routes). Every example below is real output
from that code, not illustrative.

---

## 1. Where the numbers come from

Three endpoints return the same `BudgetSplitOut` object:

| Call | Returns | Use it for |
|------|---------|-----------|
| `GET /budget-split` | `BudgetSplitOut` | the dashboard's headline |
| `GET /budgets/current` | `BudgetOut` + `daily_split` | budget screen, one call |
| `GET /budgets/dashboard` | `budget`, `daily_split`, `health`, `recent_transactions` | the whole dashboard in one call |

`POST /budgets/{id}/transactions` also returns a recalculated `daily_split` (nullable — it is `null` if the budget went inactive), so
**after recording a purchase, take the split from that response** rather than
re-fetching. It is already correct and one round trip cheaper.

All of them require `Authorization: Bearer <token>`. `GET /budget-split` returns
**404 "No active budget"** when the student has not set one up — that is a
normal state, not an error, and `client.js` already turns it into `null`.

The split is recalculated on every read. There is nothing to cache and nothing
to invalidate.

---

## 2. The response, field by field

```jsonc
{
  "budget_id": 4,
  "currency": "ZAR",
  "as_of": "2026-09-23",             // the day this was calculated for
  "next_payout_date": "2026-10-08",  // budgets.cycle_end_date
  "days_remaining": 16,              // INCLUSIVE of today and payout day
  "remaining_amount": "1200.00",     // spendable balance, savings excluded
  "daily_limit": "78.62",            // today's allowance, fixed at 00:00
  "spent_today": "57.99",
  "remaining_today": "20.63",        // daily_limit - spent_today, floored at 0
  "tomorrow_limit": "78.62",         // the rate from tomorrow; null on payout day
  "mode": "normal",                  // "normal" | "survival"
  "survival_threshold": null,
  "message": "R1257.99 over 16 days gives you R78.62 a day. You have R20.63 left to spend today.",
  "days": [
    { "limit_date": "2026-09-23", "planned_limit": "78.62",
      "spent_amount": "57.99", "remaining_limit": "20.63", "is_today": true },
    { "limit_date": "2026-09-24", "planned_limit": "78.62",
      "spent_amount": "0.00", "remaining_limit": "78.62", "is_today": false }
  ]
}
```

**All money is a decimal string, not a number.** `"78.62"`, never `78.62`.
The backend uses `Decimal` end to end so the lines always add up; JSON numbers
would reintroduce float error. `normalise.js` already converts with `num()` —
keep doing that, and never do money arithmetic on the raw strings.

### Which number goes where

- **`daily_limit`** — the big number on the dashboard. "You have R78.62 a day."
- **`remaining_today`** — the progress ring / "left to spend today". This is the
  one that moves during the day.
- **`tomorrow_limit`** — the small print under the ring: "from tomorrow, R78.62
  a day". It only differs from `daily_limit` when today went off plan, which is
  exactly when it matters.
- **`message`** — written for students, already handles every state below.
  Render it verbatim; do not rebuild it from the fields. If the wording is
  wrong for the UI, tell Member 6 and it changes in one place for every screen.
- **`days`** — the fortnight strip. Starts at `as_of`, never earlier, and stops
  at `next_payout_date`, so it holds between 1 and 14 entries.

---

## 3. Three traps

**`daily_limit` is today's allowance fixed at the start of the day, not
`remaining_amount / days_remaining`.** In the example above, R1200 ÷ 16 = R75,
but `daily_limit` is R78.62 — because the student began the day with R1257.99
and has since spent R57.99. This is deliberate: if the headline recomputed from
the live balance, it would drift down every time the student bought a loaf of
bread, and a budget that shrinks as you look at it is useless. **Do not
recompute it in the UI; the two will disagree and the backend is right.**

**Summing `planned_limit` across `days` does not give the balance.** Today's
`planned_limit` is the whole day's allowance including what has already been
spent. To show "money still available", use
`remaining_today + tomorrow_limit × (days_remaining − 1)`, or just use
`remaining_amount`.

**`mode` alone does not tell you the student is in trouble.** `mode` is only
`"survival"` when the budget has a `survival_threshold` set and the balance has
fallen to it. A student with R0 and no threshold configured is still
`"normal"`. Key the alarming UI off the states in the next section, not off
`mode` by itself.

---

## 4. The five states to design for

Real payloads, trimmed to the fields that decide the rendering.

### Normal

```jsonc
{ "daily_limit": "78.62", "spent_today": "57.99", "remaining_today": "20.63",
  "tomorrow_limit": "78.62", "mode": "normal",
  "message": "R1257.99 over 16 days gives you R78.62 a day. You have R20.63 left to spend today." }
```

Ring at `spent_today / daily_limit`. Normal colours.

### Overspent today

```jsonc
{ "daily_limit": "75.00", "spent_today": "200.00", "remaining_today": "0.00",
  "tomorrow_limit": "66.66", "mode": "normal",
  "message": "You're R125.00 over today's R75.00 allowance. From tomorrow you have R66.66 a day." }
```

Detect with `spent_today > daily_limit`. The ring is full; show the overshoot.
`tomorrow_limit` has dropped from R75.00 to R66.66 — **surface that**, it is the
consequence the student needs to see, and it is the whole point of the feature.

### Survival mode

```jsonc
{ "remaining_amount": "80.00", "daily_limit": "12.50", "remaining_today": "0.00",
  "tomorrow_limit": "5.33", "mode": "survival", "survival_threshold": "150.00",
  "message": "Survival mode: R80.00 must last 16 days more. You have R0.00 left today, then about R5.33 a day. Essentials only — the app will stop suggesting anything else." }
```

Detect with `mode === "survival"`. Amber/serious treatment. The claim in that
message is real: `POST /recommendations` stops returning non-essentials
entirely while the budget is in survival mode, so the UI and the recommender
agree. Note `daily_limit` (R12.50, start-of-day) is higher than
`tomorrow_limit` (R5.33) here — lead with `tomorrow_limit` in this state.

### Allowance exhausted

```jsonc
{ "remaining_amount": "0.00", "daily_limit": "0.00", "remaining_today": "0.00",
  "mode": "normal",
  "message": "Your allowance for this cycle is finished. Nothing left to split — hold out until your next payout." }
```

Detect with `remaining_amount === 0`, **not** with `mode`. Note `mode` is still
`"normal"` because this budget has no threshold set. Hide the daily figure
entirely; show the message and the days to payout.

### Payout day (and after)

```jsonc
{ "days_remaining": 1, "daily_limit": "240.00", "tomorrow_limit": null,
  "message": "R240.00 over 1 day gives you R240.00 a day. You have R240.00 left to spend today." }
```

`tomorrow_limit` is `null` — there is no tomorrow in this cycle. Hide the
"from tomorrow" line rather than rendering `null`. Once the payout date has
passed, `days_remaining` stays at 1 and the message changes to "Your payout
date has passed with R… left."

---

## 5. "Can I afford this?" — `POST /budget-split/check`

The client wrapper exists (`api.budgetSplit.check`), but no screen calls it yet. It answers against the **daily allowance**,
not just the balance, which is the honest answer for a product page or the
comparison screen.

```
POST /budget-split/check
{ "amount": 250.00 }
```

```jsonc
{
  "amount": "250.00",
  "affordable_today": false,
  "affordable_this_cycle": true,
  "remaining_today": "20.63",
  "remaining_amount": "1200.00",
  "days_of_budget": "3.2",
  "message": "R250.00 is over today's R20.63, but you can afford it this cycle — it uses about 3.2 days of your allowance, so the next few days get tighter."
}
```

The three outcomes:

| `affordable_today` | `affordable_this_cycle` | Render as |
|---|---|---|
| `true` | `true` | green — "fits today" |
| `false` | `true` | amber — affordable, but costs `days_of_budget` days |
| `false` | `false` | red — this is an overspend |

`days_of_budget` is the number worth showing: "this is 3.2 days of food" lands
harder than a rand figure, and it is what makes the app a budgeting tool rather
than a price comparison site.

---

## 6. Two things to change on the frontend

**Done in Phase 3:** both changes below are in place (`tomorrow_limit` is mapped,
and `budgetSplit.check()` in `client.js` wraps the endpoint). The check is not
yet called from any screen.

Small, and both in files Member 8 owns:

1. **`src/api/normalise.js` → `budgetSplitFromApi`** does not map
   `tomorrow_limit`, so it is silently dropped before any screen sees it. Add:
   ```js
   tomorrow_limit: numOrNull(s.tomorrow_limit),
   ```
   (`numOrNull`, not `num` — it is legitimately `null` on payout day.)

2. **`src/api/endpoints.js`** has no wrapper for `POST /budget-split/check`.
   One to add when the affordability check gets wired into the product page:
   ```js
   export function checkAffordability(token, { amount }, opts = {}) {
     return request('/budget-split/check', { method: 'POST', body: { amount }, token, ...opts });
   }
   ```

---

## 7. Timezone

`spent_today` buckets transactions on `transaction_date::date` in the
**database server's** timezone. Set the dev database to `Africa/Johannesburg`
(`SET TIME ZONE 'Africa/Johannesburg';`) or a purchase made at 23:30 lands on
the wrong day and today's ring will be wrong. This is a backend/ops note, but
it shows up first as a UI bug, so it is worth knowing where to look.

---

## 8. If a number looks wrong

The arithmetic is unit-tested in `tests/test_budget_split.py` — 27 cases
including the inclusive day count, overspending, survival mode, payout day and
a full week simulated day by day. Run `pytest tests/test_budget_split.py` (no
database needed). If a case is missing rather than broken, that is the file to
add it to, and the fix belongs in `app/budget_split.py` where every screen
picks it up at once.
