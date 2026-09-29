"""
The budgeting chatbot — POST /chat.

Stateless per call: the frontend resends the plain-text turns it already
has, this runs one full tool-use turn against app/chatbot.py, and only the
final reply goes back to the client — Claude's tool_use/tool_result content
blocks are never serialized out or stored. See app/chatbot.py for the
system prompt, the tool definitions, and why each tool exists.
"""

import anthropic
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
        # ANTHROPIC_API_KEY missing — a deployment/config problem, not the
        # student's fault.
        raise HTTPException(status_code=503, detail=str(exc))
    except anthropic.AuthenticationError:
        raise HTTPException(
            status_code=503,
            detail="The budgeting assistant is misconfigured — check ANTHROPIC_API_KEY.",
        )
    except anthropic.PermissionDeniedError:
        raise HTTPException(
            status_code=503,
            detail="The budgeting assistant's API key does not have the right permissions.",
        )
    except anthropic.RateLimitError:
        raise HTTPException(
            status_code=429,
            detail="The budgeting assistant is busy right now — try again in a moment.",
        )
    except anthropic.APIStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"The budgeting assistant could not reach Claude: {exc.message}",
        )
    except anthropic.APIConnectionError:
        raise HTTPException(
            status_code=502,
            detail="Could not reach Claude — check the server's network connection.",
        )
    return ChatResponse(**result)
