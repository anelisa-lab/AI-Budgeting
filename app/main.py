from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import auth, profile, budgets, search

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
# Member 5/6 mount /recommendations, /true-cost, etc. here.
