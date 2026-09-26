"""The planning assistant, with no network: the model providers are recorded HTTP streams
played back through httpx2.MockTransport, the HTTP layer both SDKs use. This checks the tool loop, the NDJSON events, the
llm_calls record and the fallbacks without spending anything."""

import json

import anthropic
import httpx2
import openai
import pytest
from fastapi.testclient import TestClient

from supply import llm
from supply.agent.run import BUSY_NOTE, run_agent
from supply.api import app
from supply.db import execute, one


def sse(events: list[tuple[str | None, dict | str]]) -> bytes:
    out = []
    for name, data in events:
        body = data if isinstance(data, str) else json.dumps(data)
        out.append((f"event: {name}\n" if name else "") + f"data: {body}\n\n")
    return "".join(out).encode()


def claude_turn(msg_id: str, blocks: list[dict], stop: str, input_tokens: int, output_tokens: int) -> bytes:
    events: list[tuple[str | None, dict | str]] = [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": msg_id,
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-opus-5",
                    "content": [],
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": input_tokens, "output_tokens": 1},
                },
            },
        )
    ]
    for i, b in enumerate(blocks):
        if b["type"] == "text":
            events.append(
                ("content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
            )
            events.append(
                ("content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"]}})
            )
        else:
            events.append(
                (
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": i,
                        "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}},
                    },
                )
            )
            events.append(
                (
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": i,
                        "delta": {"type": "input_json_delta", "partial_json": json.dumps(b["input"])},
                    },
                )
            )
        events.append(("content_block_stop", {"type": "content_block_stop", "index": i}))
    events.append(
        (
            "message_delta",
            {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": output_tokens}},
        )
    )
    events.append(("message_stop", {"type": "message_stop"}))
    return sse(events)


def gemini_chunks(chunks: list[dict], usage: tuple[int, int]) -> bytes:
    base = {"id": "gen-1", "object": "chat.completion.chunk", "created": 1, "model": "gemini"}
    events: list[tuple[str | None, dict | str]] = [(None, {**base, "choices": [c]}) for c in chunks]
    events.append(
        (None, {**base, "choices": [], "usage": {"prompt_tokens": usage[0], "completion_tokens": usage[1], "total_tokens": sum(usage)}})
    )
    events.append((None, "[DONE]"))
    return sse(events)


class Recorder:
    """Plays one recorded response per request and keeps the request bodies."""

    def __init__(self, responses: list[httpx2.Response]) -> None:
        self.responses = responses
        self.requests: list[dict] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(json.loads(request.content))
        return self.responses[len(self.requests) - 1]


def last_llm_call() -> dict:
    row = one("SELECT * FROM llm_calls ORDER BY id DESC LIMIT 1")
    assert row
    return row


@pytest.fixture
def no_llm_calls():
    execute("DELETE FROM llm_calls")


def test_claude_answers_with_a_tool_round_and_the_call_is_recorded(monkeypatch, no_llm_calls):
    rec = Recorder(
        [
            httpx2.Response(
                200,
                headers={"content-type": "text/event-stream", "request-id": "req_round1"},
                content=claude_turn(
                    "msg_1", [{"type": "tool_use", "id": "toolu_1", "name": "get_supplier_delays", "input": {}}], "tool_use", 1200, 40
                ),
            ),
            httpx2.Response(
                200,
                headers={"content-type": "text/event-stream", "request-id": "req_round2"},
                content=claude_turn("msg_2", [{"type": "text", "text": "Supplier D is slowest in Q4."}], "end_turn", 2000, 30),
            ),
        ]
    )
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setattr(
        llm, "anthropic_client", lambda: anthropic.Anthropic(api_key="test", http_client=httpx2.Client(transport=httpx2.MockTransport(rec)))
    )
    import supply.agent.run as run_mod

    monkeypatch.setattr(run_mod, "anthropic_client", llm.anthropic_client)

    events = list(run_agent([{"role": "user", "content": "Which supplier is slowest in Q4?"}]))
    assert [e["type"] for e in events] == ["meta", "tool_call", "tool_result", "text", "done"]
    assert events[2]["ok"] and events[2]["result"]["suppliers"]
    assert events[3]["text"] == "Supplier D is slowest in Q4."

    first = rec.requests[0]
    assert first["fallbacks"] == "default" and first["output_config"] == {"effort": "medium"}
    assert all(t["eager_input_streaming"] for t in first["tools"]) and len(first["tools"]) == 9
    assert rec.requests[1]["messages"][-1]["content"][0]["tool_use_id"] == "toolu_1"

    call = last_llm_call()
    assert (call["provider"], call["model"], call["purpose"]) == ("anthropic", "claude-opus-5", "chat")
    assert (call["input_tokens"], call["output_tokens"], call["tool_rounds"]) == (3200, 70, 1)
    assert call["request_id"] == "req_round2" and call["error"] is None
    assert call["cost_usd"] == pytest.approx((3200 * 5 + 70 * 25) / 1e6)


def test_claude_rate_limited_answers_in_keyword_mode_and_records_the_error(monkeypatch, no_llm_calls):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    limited = httpx2.MockTransport(
        lambda r: httpx2.Response(429, json={"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}})
    )
    import supply.agent.run as run_mod

    monkeypatch.setattr(
        run_mod,
        "anthropic_client",
        lambda: anthropic.Anthropic(api_key="test", max_retries=0, http_client=httpx2.Client(transport=limited)),
    )
    events = list(run_agent([{"role": "user", "content": "What is the demand forecast?"}], offline_pause=0))
    assert events[1] == {"type": "text", "text": BUSY_NOTE}
    assert any(e["type"] == "tool_call" and e["name"] == "get_demand_forecast" for e in events)
    assert events[-1] == {"type": "done"}
    assert "RateLimitError" in last_llm_call()["error"]


def test_gemini_moves_to_the_next_free_model_on_a_429_and_returns_the_thought_signature(monkeypatch, no_llm_calls):
    signature = {"google": {"thought_signature": "sig-123"}}
    rec = Recorder(
        [
            httpx2.Response(429, json={"error": {"message": "quota", "code": 429}}),
            httpx2.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=gemini_chunks(
                    [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_a",
                                        "type": "function",
                                        "function": {"name": "get_demand_forecast", "arguments": '{"tractor_model": "TX-400"}'},
                                        "extra_content": signature,
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    (900, 20),
                ),
            ),
            httpx2.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=gemini_chunks(
                    [{"index": 0, "delta": {"content": "TX-400 demand is steady."}, "finish_reason": "stop"}], (1500, 12)
                ),
            ),
        ]
    )
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_MODEL", "model-one")
    monkeypatch.setenv("GEMINI_FALLBACK_MODELS", "model-two")
    import supply.agent.run as run_mod

    monkeypatch.setattr(
        run_mod,
        "gemini_client",
        lambda: openai.OpenAI(
            api_key="test", base_url=llm.GEMINI_BASE_URL, max_retries=0, http_client=httpx2.Client(transport=httpx2.MockTransport(rec))
        ),
    )
    events = list(run_agent([{"role": "user", "content": "How is TX-400 demand?"}]))
    assert [e["type"] for e in events] == ["meta", "tool_call", "tool_result", "text", "done"]
    assert events[1]["input"] == {"tractor_model": "TX-400"}
    assert [r["model"] for r in rec.requests] == ["model-one", "model-two", "model-two"]
    sent_back = rec.requests[2]["messages"][-2]["tool_calls"][0]
    assert sent_back["extra_content"] == signature
    call = last_llm_call()
    assert (call["provider"], call["model"], call["input_tokens"], call["output_tokens"], call["tool_rounds"]) == (
        "gemini",
        "model-two",
        2400,
        32,
        1,
    )
    assert call["cost_usd"] == 0


def test_offline_mode_records_no_llm_call(no_llm_calls):
    events = list(run_agent([{"role": "user", "content": "Which parts are failing?"}], offline_pause=0))
    assert events[0] == {"type": "meta", "provider": "offline", "model": "rules"}
    assert events[-1] == {"type": "done"}
    assert one("SELECT COUNT(*) AS n FROM llm_calls") == {"n": 0}


def test_the_chat_streams_ndjson_and_a_draft_orders_nothing():
    before = one("SELECT COUNT(*) AS n FROM supply_orders")
    with TestClient(app).stream(
        "POST", "/api/chat", json={"messages": [{"role": "user", "content": "Draft orders for everything we should reorder"}]}
    ) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in r.iter_lines() if line]
    names = [e["name"] for e in events if e["type"] == "tool_call"]
    assert names == ["get_inventory_recommendations", "propose_supply_order"]
    draft = next(e for e in events if e["type"] == "tool_result" and e["name"] == "propose_supply_order")["result"]
    assert draft["proposal"] is True and draft["lines"] and "Not placed" in draft["note"]
    assert one("SELECT COUNT(*) AS n FROM supply_orders") == before
    assert events[-1] == {"type": "done"}


def test_the_chat_rejects_a_conversation_that_does_not_start_with_the_user():
    r = TestClient(app).post("/api/chat", json={"messages": [{"role": "assistant", "content": "hi"}]})
    assert r.status_code == 400


def test_the_llm_calls_readout_sums_the_calls(no_llm_calls):
    rec = llm.CallRecord("weekly_brief", "anthropic", "claude-opus-5")
    rec.add(1000, 200, "req_x")
    rec.save()
    body = TestClient(app).get("/api/llm-calls").json()
    assert body["totals"]["calls"] == 1 and body["totals"]["input_tokens"] == 1000
    assert body["totals"]["cost_usd"] == pytest.approx((1000 * 5 + 200 * 25) / 1e6)
    assert body["recent"][0]["request_id"] == "req_x"
