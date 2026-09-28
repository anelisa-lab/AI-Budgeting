"""
Pure-logic tests for app/chatbot.py: the tool schemas are well-formed, tool
dispatch turns a bad or unknown call into an error result instead of
raising, and the agentic loop in run_chat() actually stops once
MAX_TOOL_ITERATIONS is hit rather than looping — and billing — forever.

None of this touches Postgres or the real Claude API: the Anthropic client
is a stub, matching the rest of this suite's "no database, no API key"
approach (see README's Tests section).
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from app import chatbot


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


def test_dump_makes_decimals_json_safe():
    assert chatbot._dump({"price": Decimal("19.99")}) == {"price": "19.99"}


def test_decimal_rejects_a_non_numeric_amount():
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        chatbot._decimal("not a number", "amount")


def _tool_use_response(name="get_budget_status"):
    block = SimpleNamespace(type="tool_use", id="toolu_1", name=name, input={})
    return SimpleNamespace(stop_reason="tool_use", content=[block])


def test_run_chat_stops_after_max_tool_iterations():
    """A model that keeps calling tools must not turn into an unbounded loop."""
    calls = {"n": 0}

    class StubMessages:
        def create(self, **kwargs):
            calls["n"] += 1
            return _tool_use_response()

    stub_client = SimpleNamespace(messages=StubMessages())

    with patch.object(chatbot, "_get_client", return_value=stub_client), patch.object(
        chatbot, "_run_tool", return_value={"ok": True}
    ):
        result = chatbot.run_chat(user_id=1, message="budget me for the week")

    assert calls["n"] == chatbot.MAX_TOOL_ITERATIONS
    assert result["tools_used"] == ["get_budget_status"] * chatbot.MAX_TOOL_ITERATIONS
    assert "narrow" in result["reply"] or "steps" in result["reply"]


def test_run_chat_returns_final_text_when_claude_is_done():
    text_block = SimpleNamespace(type="text", text="Here's your plan.")
    final = SimpleNamespace(stop_reason="end_turn", content=[text_block])

    class StubMessages:
        def create(self, **kwargs):
            return final

    stub_client = SimpleNamespace(messages=StubMessages())

    with patch.object(chatbot, "_get_client", return_value=stub_client):
        result = chatbot.run_chat(user_id=1, message="hi")

    assert result == {"reply": "Here's your plan.", "tools_used": []}


def test_run_chat_executes_tool_then_returns_text():
    tool_response = _tool_use_response("list_stores")
    text_block = SimpleNamespace(type="text", text="Checkers and Shoprite have live prices.")
    final = SimpleNamespace(stop_reason="end_turn", content=[text_block])
    responses = iter([tool_response, final])

    class StubMessages:
        def create(self, **kwargs):
            return next(responses)

    stub_client = SimpleNamespace(messages=StubMessages())

    with patch.object(chatbot, "_get_client", return_value=stub_client), patch.object(
        chatbot, "_run_tool", return_value={"stores": []}
    ) as run_tool:
        result = chatbot.run_chat(user_id=7, message="what stores do you cover?")

    run_tool.assert_called_once_with(7, "list_stores", {})
    assert result == {"reply": "Checkers and Shoprite have live prices.", "tools_used": ["list_stores"]}
