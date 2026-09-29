"""
Pure-logic tests for app/chatbot.py: the tool schemas are well-formed, tool
dispatch turns a bad or unknown call into an error result instead of
raising, and the agentic loop in run_chat() actually stops once
MAX_TOOL_ITERATIONS is hit rather than looping — and quota-burning —
forever.

None of this touches Postgres or the real Gemini API: the client is a
stub returning genuine google.genai.types objects (not duck-typed
stand-ins — function_calls/text are computed properties on the real SDK
model, so a fake needs the real class to behave correctly), matching the
rest of this suite's "no database, no API key" approach (see README's
Tests section).
"""

import os
from decimal import Decimal
from unittest.mock import patch

import pytest
from google.genai import _api_client as genai_api_client
from google.genai import types

from app import chatbot


def test_get_gemini_client_enables_retries_on_transient_errors():
    """
    The SDK does ZERO automatic retries unless retry_options is explicitly
    set — an unconfigured client gives up on the very first 503 "model is
    experiencing high demand" response, which is exactly the free tier's
    normal, expected, and supposed-to-be-transient behaviour under load.
    """
    chatbot._gemini_client = None
    with patch.dict(os.environ, {"GEMINI_API_KEY": "fake-key-for-testing"}):
        client = chatbot._get_gemini_client()
    opts = client._api_client._http_options.retry_options
    assert opts is not None
    resolved = genai_api_client.retry_args(opts)
    assert resolved["stop"].max_attempt_number > 1
    chatbot._gemini_client = None


def test_every_tool_has_a_matching_dispatch_entry():
    tool_names = {t["name"] for t in chatbot.TOOLS}
    assert tool_names == set(chatbot.TOOL_DISPATCH)


def test_every_tool_schema_is_well_formed():
    for tool in chatbot.TOOLS:
        assert tool["name"]
        assert tool["description"]
        schema = tool["input_schema"]
        assert schema["type"] == "object"
        assert "properties" in schema


def test_gemini_tools_builds_one_function_declaration_per_tool():
    tools = chatbot._gemini_tools()
    names = {fd.name for fd in tools[0].function_declarations}
    assert names == set(chatbot.TOOL_DISPATCH)


def test_run_tool_reports_an_unknown_tool_without_raising():
    result = chatbot._run_tool(user_id=1, name="not_a_real_tool", tool_input={})
    assert result == {"error": True, "message": "Unknown tool 'not_a_real_tool'."}


def test_run_tool_wraps_an_unexpected_exception_as_an_error_result():
    def boom(**kwargs):
        raise ValueError("boom")

    with patch.dict(chatbot.TOOL_DISPATCH, {"get_budget_status": boom}):
        result = chatbot._run_tool(user_id=1, name="get_budget_status", tool_input={})

    assert result["error"] is True
    assert "boom" in result["message"]


def test_run_tool_never_lets_tool_input_override_the_authenticated_user():
    """
    tool_input is JSON the model produced. A user_id key in it must be
    dropped, not passed through — a tool must always run as the real
    signed-in student, whatever the model's input claims.
    """
    seen = {}

    def spy(**kwargs):
        seen.update(kwargs)
        return {"ok": True}

    with patch.dict(chatbot.TOOL_DISPATCH, {"get_budget_status": spy}):
        chatbot._run_tool(user_id=1, name="get_budget_status", tool_input={"user_id": 999})

    assert seen == {"user_id": 1}


def test_dump_makes_decimals_json_safe():
    assert chatbot._dump({"price": Decimal("19.99")}) == {"price": "19.99"}


def test_decimal_rejects_a_non_numeric_amount():
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        chatbot._decimal("not a number", "amount")


# --------------------------------------------------------------- run_chat


def _text_response(text, finish_reason="STOP"):
    candidate = types.Candidate(
        content=types.Content(role="model", parts=[types.Part.from_text(text=text)]),
        finish_reason=finish_reason,
    )
    return types.GenerateContentResponse(candidates=[candidate])


def _tool_call_response(name, args=None):
    call = types.FunctionCall(name=name, args=args or {})
    candidate = types.Candidate(
        content=types.Content(role="model", parts=[types.Part(function_call=call)]),
        finish_reason="STOP",
    )
    return types.GenerateContentResponse(candidates=[candidate])


class _StubModels:
    def __init__(self, responses):
        self._responses = iter(responses)
        self.calls = []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        return next(self._responses)


class _StubClient:
    def __init__(self, responses):
        self.models = _StubModels(responses)


def test_run_chat_stops_after_max_tool_iterations():
    """A model that keeps calling tools must not turn into an unbounded loop."""
    responses = [_tool_call_response("get_budget_status") for _ in range(chatbot.MAX_TOOL_ITERATIONS)]
    stub_client = _StubClient(responses)

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client), patch.object(
        chatbot, "_run_tool", return_value={"ok": True}
    ):
        result = chatbot.run_chat(user_id=1, message="budget me for the week")

    assert len(stub_client.models.calls) == chatbot.MAX_TOOL_ITERATIONS
    assert result["tools_used"] == ["get_budget_status"] * chatbot.MAX_TOOL_ITERATIONS
    assert "narrow" in result["reply"] or "steps" in result["reply"]


def test_run_chat_returns_final_text_when_gemini_is_done():
    stub_client = _StubClient([_text_response("Here's your plan.")])

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client):
        result = chatbot.run_chat(user_id=1, message="hi")

    assert result == {"reply": "Here's your plan.", "tools_used": []}


def test_run_chat_passes_the_system_prompt_and_tools_to_gemini():
    stub_client = _StubClient([_text_response("ok")])

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client):
        chatbot.run_chat(user_id=1, message="hi")

    config = stub_client.models.calls[0]["config"]
    assert "UniWallet's budgeting assistant" in config.system_instruction
    assert {fd.name for fd in config.tools[0].function_declarations} == set(chatbot.TOOL_DISPATCH)


def test_run_chat_falls_back_to_a_message_when_gemini_returns_no_text():
    stub_client = _StubClient([_text_response("")])

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client):
        result = chatbot.run_chat(user_id=1, message="hi")

    assert result["reply"] == "I couldn't put together an answer that time — could you rephrase?"


def test_run_chat_flags_a_truncated_max_tokens_reply():
    stub_client = _StubClient([_text_response("Item 1: maize meal R54.99...", finish_reason="MAX_TOKENS")])

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client):
        result = chatbot.run_chat(user_id=1, message="plan my whole month")

    assert result["reply"].startswith("Item 1: maize meal R54.99...")
    assert "cut off" in result["reply"]


def test_run_chat_executes_tool_then_returns_text():
    stub_client = _StubClient(
        [_tool_call_response("list_stores"), _text_response("Checkers and Shoprite have live prices.")]
    )

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client), patch.object(
        chatbot, "_run_tool", return_value={"stores": []}
    ) as run_tool:
        result = chatbot.run_chat(user_id=7, message="what stores do you cover?")

    run_tool.assert_called_once_with(7, "list_stores", {})
    assert result == {
        "reply": "Checkers and Shoprite have live prices.",
        "tools_used": ["list_stores"],
    }


def test_run_chat_translates_assistant_history_role_to_model():
    """The wire contract with the frontend is user/assistant; Gemini's own
    roles are user/model — the translation must happen without leaking
    "assistant" into the request Gemini actually receives."""
    stub_client = _StubClient([_text_response("ok")])
    history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]

    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client):
        chatbot.run_chat(user_id=1, message="what now", history=history)

    contents = stub_client.models.calls[0]["contents"]
    roles = [c.role for c in contents]
    assert roles == ["user", "model", "user"]


# ----------------------------------------------------- speed-up behaviour


def test_thinking_budget_defaults_to_off_and_can_be_overridden():
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("GEMINI_THINKING_BUDGET", None)
        assert chatbot._thinking_budget() == 0
    with patch.dict(os.environ, {"GEMINI_THINKING_BUDGET": "512"}):
        assert chatbot._thinking_budget() == 512
    with patch.dict(os.environ, {"GEMINI_THINKING_BUDGET": ""}):
        assert chatbot._thinking_budget() is None


def test_run_chat_sends_the_thinking_budget_to_gemini():
    stub_client = _StubClient([_text_response("ok")])
    with patch.dict(os.environ, {"GEMINI_THINKING_BUDGET": "0"}), patch.object(
        chatbot, "_get_gemini_client", return_value=stub_client
    ):
        chatbot.run_chat(user_id=1, message="hi")
    config = stub_client.models.calls[0]["config"]
    assert config.thinking_config.thinking_budget == 0


def test_template_menu_is_only_in_the_prompt_for_spreadsheet_conversations():
    assert "Payday-to-Payday Planner" not in chatbot._system_prompt(include_spreadsheets=False)
    assert "Payday-to-Payday Planner" in chatbot._system_prompt(include_spreadsheets=True)
    assert chatbot._wants_spreadsheet("Can you recommend a spreadsheet?", [])
    assert chatbot._wants_spreadsheet("running out before payday", [{"role": "assistant", "content": "Want a spreadsheet?"}])
    assert not chatbot._wants_spreadsheet("I have R400 for this week", [])


def test_shopping_turn_uses_the_shorter_prompt():
    stub_client = _StubClient([_text_response("ok")])
    with patch.object(chatbot, "_get_gemini_client", return_value=stub_client):
        chatbot.run_chat(user_id=1, message="I have R400 for this week")
    assert "Payday-to-Payday Planner" not in stub_client.models.calls[0]["config"].system_instruction


class _StreamModels:
    def __init__(self, turns):
        self._turns = iter(turns)

    def generate_content_stream(self, **kwargs):
        return iter(next(self._turns))


def _stream_client(turns):
    client = type("C", (), {})()
    client.models = _StreamModels(turns)
    return client


def test_run_chat_stream_emits_deltas_then_done():
    client = _stream_client([[_text_response("Here's "), _text_response("your plan.")]])
    with patch.object(chatbot, "_get_gemini_client", return_value=client):
        events = list(chatbot.run_chat_stream(user_id=1, message="hi"))
    assert [e["text"] for e in events if e["type"] == "delta"] == ["Here's ", "your plan."]
    assert events[-1] == {"type": "done", "reply": "Here's your plan.", "tools_used": []}


def test_run_chat_stream_runs_tools_then_streams_the_answer():
    client = _stream_client([
        [_tool_call_response("get_budget_status")],
        [_text_response("You have R50 a day.")],
    ])
    with patch.object(chatbot, "_get_gemini_client", return_value=client), patch.object(
        chatbot, "_run_tool", return_value={"ok": True}
    ):
        events = list(chatbot.run_chat_stream(user_id=1, message="what's left?"))
    assert {"type": "tool", "name": "get_budget_status"} in events
    assert events[-1]["reply"] == "You have R50 a day."
    assert events[-1]["tools_used"] == ["get_budget_status"]
