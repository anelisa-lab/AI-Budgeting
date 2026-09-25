import logging

import psycopg2
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.routers import (
    auth,
    profile,
    budgets,
    search,
    recommendations,
    true_cost,
    budget_split,
    compare,
    prices,
)

app = FastAPI(title="AI Shopping for Student Budgeting — Backend")
logger = logging.getLogger("app")


# Registered BEFORE CORSMiddleware so CORS wraps it. An unhandled exception
# otherwise escapes to Starlette's outermost error handler, whose 500 carries
# no CORS headers — the browser then reports a CORS failure and the frontend
# can only say "could not reach the server", hiding the real problem.
@app.middleware("http")
async def json_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except psycopg2.OperationalError:
        logger.exception("Database unavailable")
        return JSONResponse(
            status_code=503,
            content={"detail": "The database is unavailable right now. Please try again shortly."},
        )
    except Exception:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"detail": "Something went wrong on our side. Please try again."},
        )


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
app.include_router(compare.router)
app.include_router(prices.router)
