# UniWallet — Phase 5 Final Sprint Handover

## Sprint requirements

### M7 — Frontend Lead
- Final visual QA pass on every screen.
- Backup demo screen-capture prepared as a manual handover step.

### M8 — Frontend Dev
- Final polish on authentication and budget-dashboard screens.

### M9 — Data / Frontend Dev
- Final polish on search, filters and comparison screens.

## What is included in this final ZIP

This package combines the integrated Phase 4 backend from the Polished ZIP with
the stronger server-backed frontend implementation from the Completed ZIP.

### M7
- Central design tokens for colour, typography, spacing, radii and elevation.
- Final responsive/accessibility polish.
- Keyboard skip link and visible focus states.
- Minimum touch-target sizing.
- Responsive and print styles.
- React ErrorBoundary for a recoverable demo screen.
- Logout loading protection to prevent duplicate sign-out actions.

### M8
- Login/register/auth UI uses the shared UI system.
- Password visibility controls and validation remain available.
- Budget setup/dashboard keeps server-aligned validation and feedback.
- Budget update/delete actions retain confirmation and toast feedback.

### M9
- Search/filter state remains connected to the backend search contract.
- Combined filters, price bounds, fulfilment, availability and essential-only
  behaviour remain supported.
- Search result cards are responsive and handle long names safely.
- Comparison uses the backend basket/true-cost calculations.
- Shopping lists are server-backed through the Phase 5 `/shopping-list`
  endpoints, so the list can follow the signed-in account across devices.

## Important correction made during the merge

The Polished ZIP contained useful Phase 5 visual/accessibility improvements, but
its frontend had changed the shopping list to device-only storage and removed
some shopping-list error handling. The integrated backend in that same ZIP
actually contains the Phase 5 `/shopping-list` router and database migration.

Therefore, the final package keeps the Polished ZIP's visual/accessibility
improvements while restoring the server-backed shopping-list frontend from the
Completed ZIP. This keeps the frontend aligned with the backend that is already
included.

## Backup demo recording

A real video/screen recording cannot be generated from the source ZIP itself.
Before the final live demonstration, one group member should record the
acceptance flow below using Windows Game Bar (Win + G) or OBS.

Recommended recording flow:
1. Register a test student account.
2. Set a budget.
3. Open Dashboard and show the budget summary.
4. Search for a seeded product.
5. Apply at least two filters.
6. Add an item to the shopping list.
7. Open Comparison.
8. Show store totals and fulfilment/true-cost information.
9. Return to Budget and edit the budget.
10. Sign out and sign back in.
11. Repeat at a narrow/mobile browser width.
12. Save the recording as the backup demo artefact.

## Final verification commands

From `mintly-react`:

```cmd
npm install
npm run lint
npm run build
npm run test:contract
npm run dev
```

The existing Phase 5 QA documentation reported 61/61 contract checks passing;
run the commands above on the team's machine after the final merge to confirm
the current environment and dependencies.
