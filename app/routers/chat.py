"""
The budgeting chatbot — POST /chat.

Stateless per call: the frontend resends the plain-text turns it already
has, this runs one full tool-use turn against app/chatbot.py, and only the
final reply goes back to the client — Gemini's own function-call content is
never serialized out or stored. See app/chatbot.py for the system prompt,
the tool definitions, and why each tool exists.
"""

import json

from google.genai import errors as genai_errors
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.chatbot import run_chat, run_chat_stream
from app.dependencies import get_current_user_id
from app.schemas import ChatRequest, ChatResponse

router = APIRouter(prefix="/chat", tags=["chat"])


def _to_http_error(exc: Exception) -> HTTPException:
    """Map a chatbot/Gemini failure to the HTTP error the student should see."""
    if isinstance(exc, RuntimeError):
        # GEMINI_API_KEY missing — a deployment/config problem, not the
        # student's fault.
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, genai_errors.ClientError):
        # google-genai doesn't split auth/quota/rate-limit into separate
        # exception classes — every 4xx is a ClientError, so the HTTP code
        # on it is what actually distinguishes them.
        if exc.code == 429:
            return HTTPException(
                status_code=429,
                detail="The budgeting assistant is busy right now — try again in a moment.",
            )
        if exc.code in (401, 403):
            return HTTPException(
                status_code=503,
                detail="The budgeting assistant is misconfigured — check GEMINI_API_KEY.",
            )
        return HTTPException(
            status_code=502,
            detail=f"The budgeting assistant could not reach Gemini: {exc.message or exc}",
        )
    if isinstance(exc, genai_errors.ServerError):
        return HTTPException(
            status_code=502,
            detail=f"Gemini is having trouble right now: {exc.message or exc}",
        )
    raise exc


_HANDLED = (RuntimeError, genai_errors.ClientError, genai_errors.ServerError)


@router.post("", response_model=ChatResponse)
def chat(payload: ChatRequest, user_id: int = Depends(get_current_user_id)):
    try:
        result = run_chat(
            user_id,
            payload.message,
            history=[h.model_dump() for h in payload.history],
        )
    except _HANDLED as exc:
        raise _to_http_error(exc)
    return ChatResponse(**result)


@router.post("/stream")
def chat_stream(payload: ChatRequest, user_id: int = Depends(get_current_user_id)):
    """
    Same turn as POST /chat, sent as Server-Sent Events so the reply appears
    as it is written. Each event is `data: <json>` — see run_chat_stream() for
    the event types. A failure part-way becomes {"type": "error", ...} because
    the 200 status has already gone out by then.
    """
    history = [h.model_dump() for h in payload.history]

    def events():
        try:
            for event in run_chat_stream(user_id, payload.message, history=history):
                yield f"data: {json.dumps(event)}\n\n"
        except _HANDLED as exc:
            err = _to_http_error(exc)
            yield f"data: {json.dumps({'type': 'error', 'status': err.status_code, 'detail': err.detail})}\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
