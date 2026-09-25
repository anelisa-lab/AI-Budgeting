# Wireframes — all core screens

**Owner:** Member 7 (Frontend Lead)

Low-fidelity layout for every screen, written before the components were
built. Each one lists what is on it, what a student can do, and what happens
when things go wrong — the last column is the one teams forget, and it is
directly worth marks under "Quality of feedback".

A rendered, clickable version of all of these is the live demo build.

---

## Screen map

```
                    ┌───────────┐
                    │  Landing  │  public
                    └─────┬─────┘
              ┌───────────┴───────────┐
        ┌─────▼─────┐           ┌─────▼──────┐
        │   Login   │◄─────────►│  Register  │  public
        └─────┬─────┘           └─────┬──────┘
              │                       │
              │                 ┌─────▼──────┐
              │                 │   Budget   │  first-run setup
              │                 │   entry    │
              │                 └─────┬──────┘
              └──────────┬────────────┘
                   ┌─────▼──────┐
                   │ Dashboard  │◄──────┐  private
                   └─────┬──────┘       │
                         │              │
                   ┌─────▼──────┐  ┌────┴─────┐
                   │   Search   │─►│ Compare  │
                   └────────────┘  └──────────┘
```

New students land on Register → Budget entry → Dashboard. Returning students
land on Login → Dashboard.

---

## 1. Login

```
┌──────────────────────────────────────┐
│              [ UniWallet ]              │
│ ┌──────────────────────────────────┐ │
│ │ • WELCOME BACK                   │ │
│ │ Sign in to UniWallet                │ │
│ │ Pick up where you left off…      │ │
│ │                                  │ │
│ │ [ ! form-level error, if any   ] │ │
│ │                                  │ │
│ │ Email address *                  │ │
│ │ [_______________________________]│ │
│ │ ⚠ inline error under the field   │ │
│ │                                  │ │
│ │ Password *              [Show]   │ │
│ │ [_______________________________]│ │
│ │                                  │ │
│ │ [        Sign in        ]        │ │
│ │ New here? Create an account      │ │
│ └──────────────────────────────────┘ │
│  Demo note: running on mock API      │
└──────────────────────────────────────┘
```

**Actions:** sign in · go to register
**States:** idle · validating · submitting (spinner in button) · field error ·
form error · success (toast, then redirect to wherever they were headed)

---

## 2. Register

Same frame as login, plus: full name, student number, residence (select),
password with a **live strength meter**, confirm password, terms checkbox.

```
│ Password *                          │
│ [______________________]  [Show]    │
│ ▓▓▓▓ ▓▓▓▓ ▓▓▓▓ ░░░░   Good          │
```

**Validation rules** (all in `src/lib/validation.js`):
student number 8–9 digits · valid email · password ≥ 8 chars with a letter and
a number · confirmation must match · terms must be ticked · residence required.

**On success:** straight to budget entry, not the dashboard — an empty
dashboard teaches a new student nothing.

---

## 3. Budget entry

```
│ • STEP 1 OF 2                                │
│ What are you working with?                   │
│                                              │
│ Start from a known amount                    │
│ (NSFAS living R1 650)(Living+care R1 940)(…) │
│                                              │
│ How much did you receive? *                  │
│ [R] [1650__________________]                 │
│                                              │
│ When did it land? *     How long must it last│
│ [2026-09-21]            [One month (30 days)]│
│                                              │
│ ┌── live preview, updates as you type ─────┐ │
│ │ YOUR SAFE SPEND                          │ │
│ │ R55,00 a day      R385,00 a week         │ │
│ │ R1 650,00 spread evenly over 30 days.    │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ [     Set my budget     ] [ Delete ]         │
```

The preview is the whole point of the screen: the student sees the number that
changes their behaviour **before** they commit to anything.

**CRUD:** create (first time) · read (prefilled on return) · update (same form)
· delete (with a confirm).

---

## 4. Dashboard

```
│ • YOUR MONEY THIS PERIOD                              │
│ Good morning, Nozibusiso.                             │
│                                                       │
│ ┌── forest ───────────────┐ ┌── butter ─────────────┐ │
│ │ Left to spend  [18 days]│ │ Safe to spend         │ │
│ │ R842,50                 │ │ R46,80                │ │
│ │ of R1 650,00            │ │ per day               │ │
│ │ ▓▓▓▓▓▓▓░░░░░░░░         │ │ [Find cheaper →]      │ │
│ └─────────────────────────┘ └───────────────────────┘ │
│                                                       │
│ [ ✓ On track — R842,50 left with 18 days to go … ]    │
│                                                       │
│ ┌ R807 ┐ ┌ 12 ┐ ┌ R214 ┐ ┌ 21 Sep ┐   stat row        │
│                                                       │
│ ┌── Record a spend ───────┐ ┌── Where it went ──────┐ │
│ │ What did you buy? *     │ │ 🛒 Groceries    R512  │ │
│ │ [____________________]  │ │ ▓▓▓▓▓▓▓▓▓░░░░░░       │ │
│ │ Amount *   Category     │ │ 🧼 Toiletries   R180  │ │
│ │ [R][____]  [Groceries▾] │ │ ▓▓▓▓░░░░░░░░░░        │ │
│ │ [ Add to my spending ]  │ └───────────────────────┘ │
│ └─────────────────────────┘                           │
│                                                       │
│ ┌── Recent spending ──────────────── Edit budget ───┐ │
│ │ 🛒 Bread, milk and eggs   Groceries · 20 Sep  R85 ✕│ │
│ │ 🧼 Soap and toothpaste    Toiletries · 19 Sep R47 ✕│ │
│ └───────────────────────────────────────────────────┘ │
```

**The status banner changes with behaviour**, not just with the number:
`good` → green "On track" · `tight` → amber "It is getting tight" ·
`fast` → amber "Spending faster than planned", comparing against the even-pace
figure · `over` → red "You are over budget".

**States:** loading (skeletons, not a spinner — the layout stays still) ·
no budget yet (empty state → budget entry) · no transactions yet · normal.

---

## 5. Search + results

```
┌── filters (sticky) ──┐ ┌── results ──────────────────────┐
│ Filters      Clear(3)│ │ 14 matches for "rice"  [Sort ▾] │
│                      │ │                                 │
│ Search               │ │ ┌─────────────────────────────┐ │
│ [rice_____________]  │ │ │🍚 Parboiled White Rice      │ │
│                      │ │ │  Tastic · 2kg · Food Lover's│ │
│ My budget for this   │ │ │  [★ Best value][2.6 km][…]  │ │
│ [R][200___________]  │ │ │  ✦ cheapest total cost      │ │
│                      │ │ │                    R35,99   │ │
│ Within 25 km         │ │ │              [Add to list]  │ │
│ ──────●────────      │ │ └─────────────────────────────┘ │
│                      │ │ ┌─────────────────────────────┐ │
│ Category [All      ▾]│ │ │🍚 Parboiled White Rice      │ │
│ Colour   [Any      ▾]│ │ │  Tastic · 2kg · Checkers    │ │
│ Size     [Any      ▾]│ │ │                    R42,99   │ │
│                      │ │ └─────────────────────────────┘ │
│ ☐ No delivery fee    │ └─────────────────────────────────┘
│ ☑ Include online     │
└──────────────────────┘
```

Filters live in the **URL**, so a search can be shared and the back button
works. At phone width the rail stacks above the results.

**States:** loading (five skeleton rows) · no matches (empty state offering
"Clear all filters") · results.

---

## 6. Compare

```
│ • SAME LIST, EVERY STORE                              │
│ Where should you shop?                                │
│                                                       │
│ ┌── Your whole list, by store ──────────────────────┐ │
│ │ ● Makro Springfield  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   R383,56  │ │
│ │ ● Food Lover's       ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  R424,27  │ │
│ │ ● Shoprite Warwick   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  R432,36  │ │
│ │ ● Pick n Pay         ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ R466,00  │ │
│ └───────────────────────────────────────────────────┘ │
│                                                       │
│ ┌── forest ───────────┐ ┌── butter ─────────────────┐ │
│ │ Cheapest single shop│ │ Split across stores       │ │
│ │ R383,56             │ │ R379,06                   │ │
│ │ at Makro · 5.0 km   │ │ R4,50 better — only worth │ │
│ │ R82,44 less than PnP│ │ it if two are close       │ │
│ └─────────────────────┘ └───────────────────────────┘ │
│                                                       │
│ Item by item — things more than one store sells       │
│ Your list — [−] 2 [+]  R83,98  ✕                      │
```

**States:** empty list (empty state → search) · normal · over-budget warning
banner when the list exceeds what is left.

---

## Responsive rules

| Width | Behaviour |
|---|---|
| ≥ 1040px | search rail beside results; dashboard hero two-up |
| 720–1040px | search rail stacks above results |
| < 720px | everything one column; nav links scroll horizontally; result price and button drop below the item |

Minimum side gutter is 16px at every width. Nothing scrolls sideways.

---

## Accessibility decisions

- Every input is wrapped in `<Field>`, which wires `htmlFor`,
  `aria-describedby` and `aria-invalid` — errors are announced, not just
  coloured red.
- Errors use `role="alert"`; toasts sit in an `aria-live="polite"` region.
- Colour never carries meaning alone: the budget bar changes colour **and**
  the banner text changes.
- One visible focus ring for the whole app, defined once in `global.css`.
- Native `<select>` rather than a custom dropdown — correct on a keyboard and
  faster on a low-end phone, which matters for this user group.
