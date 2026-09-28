"""
Shared, genuinely store-agnostic bits for app/scrapers/*.py.

Each store's scraper is investigated and written on its own — a South
African grocer's site is not assumed to share Checkers' page shape just
because it looks similar (see app/scrapers/shoprite.py and pnp.py for what
each site actually does). What's here is infrastructure every scraper needs
regardless of the site underneath it:

  USER_AGENT              a realistic desktop browser UA, so a plain
                          `requests` call doesn't announce itself as a script
  DEFAULT_REQUEST_TIMEOUT the ceiling every scraper's own HTTP call should
                          use — see the note below
  looks_blocked()         a generic fallback check for "this is a bot/captcha
                          page", for a store whose blocking has no header as
                          clean as Checkers' AWS WAF one

On timeouts and app/live_search.py's parallel fetch
----------------------------------------------------
app/live_search.py runs all active stores' fetches in a thread pool and
gives up waiting on a store after LIVE_SEARCH_STORE_TIMEOUT_SECONDS (default
12s) so one slow site can't hold up the others. Python can't forcibly kill a
thread, so a store whose own request is still in flight at that point keeps
running in the background — harmless, since it does not touch the database
(app/live_search.py only reads a finished thread's return value; database
writes happen afterwards, back on the main thread). It also means each
scraper's own `requests(..., timeout=...)` should stay at or below
DEFAULT_REQUEST_TIMEOUT, so an abandoned thread finishes (and its
connection is freed) soon after we've stopped waiting on it, rather than
lingering indefinitely.
"""

from __future__ import annotations

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# Keep each scraper's own request timeout at or below this — see the module
# docstring. Also used as the fallback here if a scraper doesn't set its own.
DEFAULT_REQUEST_TIMEOUT = 12

_BLOCK_MARKERS = (
    "captcha", "are you a human", "are you a robot", "access denied",
    "request blocked", "just a moment", "attention required",
    "unusual traffic", "enable javascript and cookies",
)


def looks_blocked(text: str) -> bool:
    """
    A generic fallback for "this is a bot-challenge or block page", for a
    store that doesn't hand us a clean signal the way Checkers' AWS WAF
    response headers do. Cheap and imprecise on purpose: a scraper should
    prefer its own site-specific check first and only fall back to this.
    """
    if not text:
        return False
    head = text[:4000].lower()
    return any(marker in head for marker in _BLOCK_MARKERS)
