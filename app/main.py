import logging
import os

import psycopg2
from dotenv import load_dotenv
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
    shopping_list,
)

load_dotenv()

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


# Which websites may call the API. Set CORS_ORIGINS (comma-separated) to the
# frontend's real address for the demo; the default is the Vite dev and
# preview servers. "*" is still accepted for a quick local test.
CORS_ORIGINS = [
    o.strip() for o in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    ).split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
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
app.include_router(shopping_list.router)      # Phase 5 — /shopping-list
