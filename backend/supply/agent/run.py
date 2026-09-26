"""The planning assistant's agent loop.

The model answers, calls tools, reads their results and answers again, up to MAX_ROUNDS. Every
event is yielded as one dict and streamed to the browser as one JSON line:

  meta, text, tool_call, tool_result, done, error

Claude runs through the Anthropic SDK with server-side refusal fallbacks. Gemini runs through the
OpenAI SDK on Google's OpenAI-compatible endpoint, moving to the next free model on a 429. If
the model fails before it writes any text (a rate limit, an outage), the answer comes from the
offline keyword router instead. The assistant only drafts orders: propose_supply_order writes
nothing, and the chat's Confirm button is the only path that queues them.
"""

import json
import logging
from collections.abc import Iterator
from typing import Any

import openai

from ..config import as_of, gemini_models, llm_config
from ..llm import ANTHROPIC_BETAS, CallRecord, anthropic_client, gemini_client
from .offline import run_offline
from .tools import TOOLS, execute_tool

log = logging.getLogger(__name__)
Event = dict[str, Any]

MAX_ROUNDS = 10  # the last round is answered without tools, so a reply always arrives
BUSY_NOTE = "The language model is busy right now, so this answer comes straight from the console's data.\n\n"


def system_prompt() -> str:
    return f"""You are the planning assistant inside a supply chain console for a tractor manufacturer that builds five models, TX-100 to TX-500, from parts bought from Supplier A to Supplier E and stocked in five warehouses (CA, FL, IL, NY, TX).

The app's clock is {as_of()}. History is everything before that date; the open order book and all forecasts are after it.

How to answer:
- Get every number from a tool. Never estimate or invent a figure. If no tool has it, say so.
- The reader is a supply planner, not a developer. Never name a database table, a field, a tool or function, an API or a statistical method. Say "the demand forecast", "the supplier delay forecast", "market data", "order history".
- Keep answers short: one fact per sentence, plain words. Use a small markdown table when comparing more than three rows.
- Call each tool once with the widest filter you need. get_supplier_delays with no supplier returns every supplier at once.
- When the user asks you to draft, order, buy or reorder anything, call propose_supply_order in the same turn with the quantities and suppliers from get_inventory_recommendations. It only drafts: the user must press Confirm. Never say an order was placed.
- Market data on its own predicts little: market demand does not move with the trend index or inflation, and every supplier averages about the same delay there. The forecasts rely on the company's own order and supply history. Say this if asked why a forecast uses one input and not another."""


def run_agent(history: list[dict], offline_pause: float = 0.012) -> Iterator[Event]:
    provider, model = llm_config()
    yield {"type": "meta", "provider": provider, "model": model}
    wrote_text = False
    rec = CallRecord("chat", provider, model) if provider != "offline" else None
    try:
        if rec is None:
            source = run_offline(history, offline_pause)
        elif provider == "anthropic":
            source = run_anthropic(history, model, rec)
        else:
            source = run_gemini(history, rec)
        for ev in source:
            wrote_text = wrote_text or ev["type"] == "text"
            yield ev
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001 - any model failure falls back to the offline answer below
        log.error("[chat] %s/%s failed: %s", provider, model, e)
        if rec:
            rec.error = f"{type(e).__name__}: {e}"[:500]
        if not wrote_text and rec is not None:
            try:
                yield {"type": "text", "text": BUSY_NOTE}
                yield from run_offline(history, offline_pause)
                yield {"type": "done"}
                return
            except Exception as e2:  # noqa: BLE001
                log.error("[chat] offline fallback failed: %s", e2)
        yield {"type": "error", "message": "The assistant could not finish that answer. Try again in a moment."}
    finally:
        if rec:
            rec.save()


def _run_tool(name: str, call_id: str, tool_input: Any) -> tuple[list[Event], bool, Any]:
    ok, result = execute_tool(name, tool_input)
    events = [
        {"type": "tool_call", "id": call_id, "name": name, "input": tool_input},
        {"type": "tool_result", "id": call_id, "name": name, "ok": ok, "result": result},
    ]
    return events, ok, result


def run_anthropic(history: list[dict], model: str, rec: CallRecord) -> Iterator[Event]:
    client = anthropic_client()
    tools: list[Any] = [
        {"name": t.name, "description": t.description, "input_schema": t.json_schema, "eager_input_streaming": True} for t in TOOLS
    ]
    messages: list[Any] = [{"role": h["role"], "content": h["content"]} for h in history]
    for rnd in range(MAX_ROUNDS):
        extra: dict[str, Any] = {"tool_choice": {"type": "none"}} if rnd == MAX_ROUNDS - 1 else {}
        with client.beta.messages.stream(
            model=model,
            max_tokens=16000,
            system=system_prompt(),
            tools=tools,
            messages=messages,
            output_config={"effort": "medium"},
            betas=ANTHROPIC_BETAS,
            fallbacks="default",
            **extra,
        ) as stream:
            for ev in stream:
                if ev.type == "content_block_delta" and ev.delta.type == "text_delta":
                    yield {"type": "text", "text": ev.delta.text}
            msg = stream.get_final_message()
            # Top-level usage is the attempt that produced this message; after a fallback, msg.model names the model that did.
            rec.add(msg.usage.input_tokens, msg.usage.output_tokens, stream.request_id, msg.model)
        if msg.stop_reason == "refusal":
            yield {"type": "text", "text": "\n\nThe model declined to answer that."}
            return
        uses = [b for b in msg.content if b.type == "tool_use"]
        if msg.stop_reason != "tool_use" or not uses:
            return
        rec.tool_rounds += 1
        messages.append({"role": "assistant", "content": [b.model_dump(exclude_none=True) for b in msg.content]})
        results = []
        for u in uses:
            events, ok, result = _run_tool(u.name, u.id, u.input)
            yield from events
            results.append({"type": "tool_result", "tool_use_id": u.id, "content": json.dumps(result, default=str), "is_error": not ok})
        messages.append({"role": "user", "content": results})


def run_gemini(history: list[dict], rec: CallRecord) -> Iterator[Event]:
    client = gemini_client()
    models = gemini_models()
    mi = 0
    tools: list[Any] = [
        {"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.json_schema}} for t in TOOLS
    ]
    messages: list[Any] = [{"role": "system", "content": system_prompt()}, *({"role": h["role"], "content": h["content"]} for h in history)]
    for rnd in range(MAX_ROUNDS):
        extra: dict[str, Any] = {"tool_choice": "none"} if rnd == MAX_ROUNDS - 1 else {}
        while True:
            try:
                stream = client.chat.completions.create(
                    model=models[mi], messages=messages, tools=tools, stream=True, stream_options={"include_usage": True}, **extra
                )
                break
            except openai.RateLimitError:
                if mi == len(models) - 1:
                    raise
                log.warning("[chat] %s is over its free quota, trying %s", models[mi], models[mi + 1])
                mi += 1
        text = ""
        # Gemini 3 models return a thought signature on each tool call that must be sent back.
        calls: dict[int, dict] = {}
        for chunk in stream:
            if chunk.usage:
                rec.add(chunk.usage.prompt_tokens, chunk.usage.completion_tokens, chunk.id, models[mi])
            if not chunk.choices:
                continue
            d = chunk.choices[0].delta
            if d.content:
                text += d.content
                yield {"type": "text", "text": d.content}
            for tc in d.tool_calls or []:
                i = tc.index if tc.index is not None else len(calls)
                c = calls.setdefault(i, {"id": tc.id or f"call_{rnd}_{i}", "name": "", "args": "", "extra": None})
                if tc.id:
                    c["id"] = tc.id
                if tc.function and tc.function.name:
                    c["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    c["args"] += tc.function.arguments
                extra_content = (tc.model_extra or {}).get("extra_content")
                if extra_content:
                    c["extra"] = extra_content
        real = [calls[i] for i in sorted(calls)]
        if not real:
            return
        rec.tool_rounds += 1
        messages.append(
            {
                "role": "assistant",
                "content": text or None,
                "tool_calls": [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {"name": c["name"], "arguments": c["args"] or "{}"},
                        **({"extra_content": c["extra"]} if c["extra"] else {}),
                    }
                    for c in real
                ],
            }
        )
        for c in real:
            try:
                tool_input = json.loads(c["args"] or "{}")
            except ValueError:
                tool_input = {}
            events, _ok, result = _run_tool(c["name"], c["id"], tool_input)
            yield from events
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(result, default=str)})
