# UniWallet Phase 4 Frontend Integration

Integrated source: `AI-Budgeting-Adheel-UniWallet-Phase4-Frontend` branch archive
Target: UniWallet React frontend
Frontend framework: React + Vite (not Flutter)

## Phase 4 frontend alignment

- Register -> Budget -> Dashboard -> Search -> Recommendations -> Compare -> Profile/Settings routes are present.
- Search supports combined filters, clear filters, sorting and paging/show-more.
- Search uses fulfilment-aware effective cost and server-side `essential_only`.
- Recommendations honour the active fulfilment and filter constraints.
- Compare uses the basket comparison endpoint, handles delivery/collection and missing/unavailable items.
- True-cost results are displayed per offer and labelled separately from listed/effective price.
- Dashboard uses backend budget/daily-split values and handles overspend/daily-limit warnings.
- Registration/Profile support residence and student number without sending unsupported blank fields.
- Profile and Settings are included and protected routes/session recovery are wired.
- Responsive UI was implemented for mobile/tablet/desktop.
- Branding was checked for removal of Mintly references.
- Phase 4 contract tests and documentation are included.

## Day 6 / Phase 4 integration checklist

M1: Integration-ready route structure and demo flow.
M2: Auth/session integration is wired through AuthContext and API client.
M3: Budget calculations consume backend budget/daily-split responses.
M4: Search/filter results feed recommendations and comparison.
M5: Recommendation scoring is consumed from the recommendation endpoint.
M6: True-cost and daily budget split values are displayed from backend responses.
M7: Global design tokens, spacing, typography and responsive polish are present.
M8: Frontend loading/error states and responsive checks are implemented.
M9: Search/results/comparison UI and catalogue data handling are included.
M10: Contract tests and Phase 4 documentation are included.

## Important

The frontend depends on the Phase 4 backend routes included in this integrated project, especially:
- `POST /compare/basket`
- fulfilment-aware search
- `essential_only` recommendations
- price provenance fields
- residence/student-number registration/profile fields

Before the final team merge, run:

```bash
cd mintly-react
npm install
npm run build
npm run test:contract
npm run dev
```

Then manually click through:

`register -> set budget -> search -> recommendation -> compare -> true cost`

and verify the backend is running against the team's current database/seed.
