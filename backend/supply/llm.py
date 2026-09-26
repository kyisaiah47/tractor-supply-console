"""Language model clients, and the llm_calls record of every request.

Anthropic goes through the Anthropic SDK. Gemini goes through the OpenAI SDK on Google's
OpenAI-compatible endpoint. Each answer the planning assistant gives, and each weekly brief a
model writes, is one row in llm_calls: provider, model, tokens, latency, tool rounds, the
provider's request id and the cost computed from the price table below.
"""

import logging
import os
import time
from dataclasses import dataclass, field

import anthropic
import openai
from sqlalchemy import text

from .config import gemini_models, llm_config
from .db import engine

log = logging.getLogger(__name__)

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
ANTHROPIC_BETAS = ["server-side-fallback-2026-07-01"]

# US dollars per million tokens, (input, output). Anthropic first-party rates. The Gemini models
# the app uses are called on Google AI Studio's free tier, which costs nothing.
PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}


def cost_usd(provider: str, model: str, input_tokens: int, output_tokens: int) -> float:
    if provider == "gemini":
        return 0.0
    price = PRICES.get(model)
    if price is None:
        log.warning("no price for %s; llm_calls records its cost as 0", model)
        return 0.0
    return (input_tokens * price[0] + output_tokens * price[1]) / 1_000_000


@dataclass
class CallRecord:
    """Token use for one answer, summed over its tool rounds."""

    purpose: str
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    tool_rounds: int = 0
    request_id: str | None = None
    error: str | None = None
    started: float = field(default_factory=time.perf_counter)

    def add(self, input_tokens: int | None, output_tokens: int | None, request_id: str | None, model: str | None = None) -> None:
        self.input_tokens += input_tokens or 0
        self.output_tokens += output_tokens or 0
        self.request_id = request_id or self.request_id
        if model:
            self.model = model

    def save(self) -> None:
        latency = round((time.perf_counter() - self.started) * 1000)
        try:
            with engine().begin() as c:
                c.execute(
                    text(
                        """INSERT INTO llm_calls (purpose, provider, model, input_tokens, output_tokens, latency_ms,
                                                  tool_rounds, request_id, cost_usd, error)
                           VALUES (:purpose, :provider, :model, :i, :o, :lat, :rounds, :rid, :cost, :err)"""
                    ),
                    {
                        "purpose": self.purpose,
                        "provider": self.provider,
                        "model": self.model,
                        "i": self.input_tokens,
                        "o": self.output_tokens,
                        "lat": latency,
                        "rounds": self.tool_rounds,
                        "rid": self.request_id,
                        "cost": cost_usd(self.provider, self.model, self.input_tokens, self.output_tokens),
                        "err": self.error,
                    },
                )
        except Exception as e:  # noqa: BLE001 - a failed usage record must never fail the answer
            log.error("could not record the llm call: %s", e)


def anthropic_client() -> anthropic.Anthropic:
    return anthropic.Anthropic()


def gemini_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=os.environ.get("GEMINI_API_KEY"), base_url=GEMINI_BASE_URL, max_retries=1)


def complete_text(system: str, prompt: str, purpose: str = "weekly_brief") -> dict | None:
    """One-shot text completion for the weekly brief. None when no model is configured."""
    provider, model = llm_config()
    if provider == "offline":
        return None
    rec = CallRecord(purpose, provider, model)
    try:
        if provider == "anthropic":
            with anthropic_client().beta.messages.stream(
                model=model,
                max_tokens=4000,
                output_config={"effort": "low"},
                betas=ANTHROPIC_BETAS,
                fallbacks="default",
                system=system,
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                msg = stream.get_final_message()
                rec.add(msg.usage.input_tokens, msg.usage.output_tokens, stream.request_id, msg.model)
            if msg.stop_reason == "refusal":
                return {"text": "", "author": f"llm:anthropic/{msg.model}"}
            body = "".join(b.text for b in msg.content if b.type == "text")
            return {"text": body, "author": f"llm:anthropic/{msg.model}"}
        client = gemini_client()
        last_error: Exception | None = None
        for m in gemini_models():
            try:
                res = client.chat.completions.create(
                    model=m, messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}]
                )
                u = res.usage
                rec.add(u.prompt_tokens if u else 0, u.completion_tokens if u else 0, res.id, m)
                return {"text": res.choices[0].message.content or "", "author": f"llm:gemini/{m}"}
            except openai.RateLimitError as e:
                last_error = e
        raise last_error or RuntimeError("no Gemini model configured")
    except Exception as e:
        rec.error = f"{type(e).__name__}: {e}"[:500]
        raise
    finally:
        rec.save()


def usage_summary() -> dict:
    """The Models page readout: totals over every recorded call, and the latest calls."""
    with engine().connect() as c:
        totals = (
            c.execute(
                text(
                    """SELECT COUNT(*)::int AS calls, COALESCE(SUM(input_tokens),0)::int AS input_tokens,
                              COALESCE(SUM(output_tokens),0)::int AS output_tokens, COALESCE(SUM(cost_usd),0)::float AS cost_usd,
                              COALESCE(AVG(latency_ms),0)::int AS avg_latency_ms, COALESCE(AVG(tool_rounds),0)::float AS avg_tool_rounds,
                              COUNT(*) FILTER (WHERE error IS NOT NULL)::int AS errors
                         FROM llm_calls"""
                )
            )
            .mappings()
            .one()
        )
        by_model = c.execute(
            text(
                """SELECT provider, model, COUNT(*)::int AS calls, SUM(input_tokens)::int AS input_tokens,
                          SUM(output_tokens)::int AS output_tokens, SUM(cost_usd)::float AS cost_usd
                     FROM llm_calls GROUP BY 1,2 ORDER BY calls DESC"""
            )
        ).mappings()
        recent = c.execute(
            text(
                """SELECT created_at, purpose, provider, model, input_tokens, output_tokens, latency_ms, tool_rounds,
                          request_id, cost_usd::float AS cost_usd, error
                     FROM llm_calls ORDER BY id DESC LIMIT 10"""
            )
        ).mappings()
        provider, model = llm_config()
        return {
            "provider": provider,
            "model": model,
            "totals": dict(totals),
            "byModel": [dict(r) for r in by_model],
            "recent": [{**r, "created_at": r["created_at"].isoformat()} for r in recent],
        }
