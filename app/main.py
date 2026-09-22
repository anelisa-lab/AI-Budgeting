from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import (
    auth,
    profile,
    budgets,
    search,
    recommendations,
    true_cost,
    budget_split,
)

app = FastAPI(title="AI Shopping for Student Budgeting — Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this to the frontend's real origin before the demo
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(profile.router)
app.include_router(budgets.router)
app.include_router(search.router)
app.include_router(recommendations.router)   # Member 5 — /recommendations
app.include_router(true_cost.router)         # Member 6 — /true-cost
app.include_router(budget_split.router)      # Member 6 — /budget-split
