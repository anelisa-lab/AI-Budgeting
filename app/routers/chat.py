"""
The budgeting chatbot — POST /chat.

Stateless per call: the frontend resends the plain-text turns it already
has, this runs one full tool-use turn against app/chatbot.py, and only the
final reply goes back to the client — Gemini's own function-call content is
never serialized out or stored. See app/chatbot.py for the system prompt,
the tool definitions, and why each tool exists.
"""

from google.genai import errors as genai_errors
from fastapi import APIRouter, Depends, HTTPException

from app.chatbot import run_chat
from app.dependencies import get_current_user_id
from app.schemas import ChatRequest, ChatResponse

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("", response_model=ChatResponse)
def chat(payload: ChatRequest, user_id: int = Depends(get_current_user_id)):
    try:
        result = run_chat(
            user_id,
            payload.message,
            history=[h.model_dump() for h in payload.history],
        )
    except RuntimeError as exc:
        # GEMINI_API_KEY missing — a deployment/config problem, not the
        # student's fault.
        raise HTTPException(status_code=503, detail=str(exc))
    except genai_errors.ClientError as exc:
        # google-genai doesn't split auth/quota/rate-limit into separate
        # exception classes — every 4xx is a ClientError, so the HTTP code
        # on it is what actually distinguishes them.
        if exc.code == 429:
            raise HTTPException(
                status_code=429,
                detail="The budgeting assistant is busy right now — try again in a moment.",
            )
        if exc.code in (401, 403):
            raise HTTPException(
                status_code=503,
                detail="The budgeting assistant is misconfigured — check GEMINI_API_KEY.",
            )
        raise HTTPException(
            status_code=502,
            detail=f"The budgeting assistant could not reach Gemini: {exc.message or exc}",
        )
    except genai_errors.ServerError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini is having trouble right now: {exc.message or exc}",
        )
    return ChatResponse(**result)
