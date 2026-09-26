"""Deterministic checks on one recorded planning-assistant answer. No model is called.

A transcript is the list of NDJSON events the assistant streamed for one question:
meta, text, tool_call, tool_result, done, error. The answer is the concatenated text events.

  expected_tools      every tool the case expects was called, and no draft was made unasked
  numbers_grounded    every number in the answer appears in a tool result, or is a total or a
                      rounding of numbers that do
  no_placed_claim     the answer never says an order was placed; the assistant only drafts
  no_internal_names   the answer names no database table, tool, field or statistical method
"""

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

TOOLS = {
    "get_overview",
    "list_customer_orders",
    "get_demand_forecast",
    "get_supplier_delays",
    "get_component_failures",
    "get_inventory_recommendations",
    "query_market_signals",
    "get_weekly_brief",
    "propose_supply_order",
}
TABLES = {
    "market_signals",
    "tractor_models",
    "suppliers",
    "warehouses",
    "parts",
    "part_suppliers",
    "customers",
    "customer_orders",
    "production_pipeline",
    "supply_orders",
    "supply_jobs",
    "worker_heartbeats",
    "inventory",
    "inventory_parts",
    "model_runs",
    "weekly_briefs",
    "llm_calls",
    "idempotency_keys",
    "mock_supplier_orders",
}
# Names of methods and model internals a supply planner should never see.
METHODS = [
    r"\bOLS\b",
    r"least squares",
    r"\bregression\b",
    r"beta[- ]binomial",
    r"\bposterior\b",
    r"\bECDF\b",
    r"\bMAPE\b",
    r"\bRMSE\b",
    r"\bMAE\b",
    r"\bbacktest",
    r"statsmodels",
    r"scipy",
    r"scikit",
    r"\bz[- ]score\b",
    r"trend_seasonal",
    r"seasonal_naive",
    r"trailing_mean",
]
# Tables the whole console uses as plain words. A bare "parts", "customers" or "inventory" is English, not a table name.
PLAIN_WORD_TABLES = {"suppliers", "warehouses", "parts", "customers", "inventory"}

PLACED_CLAIMS = [
    r"\b(?:I|we)(?: have|'ve)? (?:placed|ordered|queued|submitted|sent)\b",
    r"\b(?:order|orders)\s+(?:is|are|was|were|has been|have been)\s+(?:placed|submitted|sent to|queued)\b",
    r"\b(?:has|have) been ordered\b",
    r"\bplaced (?:the|these|your|an?) (?:supply )?orders?\b",
]

# Numbers that are labels in the console's own wording, not claims: horizons ("next 3 months",
# "12-month backlog", "0-3 month"), the p90 column ("Worst 10%"), quarters, tractor models and SKUs.
LABELS = [
    r"\b\d+\s*-\s*\d+\s+months?\b",
    r"\b\d+[- ]months?\b",
    r"\bWorst 10%",
    r"\bQ[1-4]\b",
    r"\bTX-\d{3}\b",
    r"\b[A-Z]{3}-\d{3}\b",
    r"\b\d{4}-\d{2}-\d{2}\b",
]
NUMBER = re.compile(r"(?<![\w.])-?\$?\d[\d,]*(?:\.\d+)?%?")


def events(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def answer(evs: list[dict]) -> str:
    return "".join(e["text"] for e in evs if e["type"] == "text")


def tool_calls(evs: list[dict]) -> list[str]:
    return [e["name"] for e in evs if e["type"] == "tool_call"]


def tool_results(evs: list[dict]) -> list[Any]:
    return [e["result"] for e in evs if e["type"] == "tool_result"]


# ---- 1. tool choice -------------------------------------------------------------------------


def expected_tools(evs: list[dict], expected: list[str]) -> list[str]:
    called = tool_calls(evs)
    problems = [f"did not call {t}" for t in expected if t not in called]
    if "propose_supply_order" in called and "propose_supply_order" not in expected:
        problems.append("drafted an order nobody asked for")
    return problems


# ---- 2. numbers are grounded in tool results -------------------------------------------------


def _leaves(x: Any) -> Iterable[float]:
    """Every number in a tool result, including numbers written inside its strings."""
    if isinstance(x, bool):
        return
    if isinstance(x, int | float):
        yield float(x)
    elif isinstance(x, str):
        for m in NUMBER.finditer(x):
            v = _parse(m.group())
            if v is not None:
                yield v
    elif isinstance(x, dict):
        for v in x.values():
            yield from _leaves(v)
    elif isinstance(x, list):
        for v in x:
            yield from _leaves(v)


def _series_totals(x: Any) -> Iterable[float]:
    """Totals the answer may state: for each list of records, the running totals of each numeric field."""
    if isinstance(x, dict):
        for v in x.values():
            yield from _series_totals(v)
    elif isinstance(x, list):
        records = [r for r in x if isinstance(r, dict)]
        if records:
            fields = {k for r in records for k, v in r.items() if isinstance(v, int | float) and not isinstance(v, bool)}
            for f in fields:
                total = 0.0
                for r in records:
                    v = r.get(f)
                    if isinstance(v, int | float) and not isinstance(v, bool):
                        total += v
                        yield total
        for v in x:
            yield from _series_totals(v)


def _parse(token: str) -> float | None:
    t = token.replace("$", "").replace(",", "").rstrip("%")
    try:
        return float(t)
    except ValueError:
        return None


def _forms(v: float) -> set[float]:
    """The ways a tool number may be written: as is, rounded, or as a percentage."""
    out = {v}
    for d in (0, 1, 2):
        out.add(round(v, d))
        out.add(round(v * 100, d))
    return out


def numbers_grounded(evs: list[dict], question: str = "") -> list[str]:
    results = tool_results(evs)
    known: set[float] = set()
    for v in list(_leaves(results)) + list(_series_totals(results)) + list(_leaves(question)):
        known |= _forms(v)
    text = answer(evs)
    for pattern in LABELS:
        text = re.sub(pattern, " ", text)
    problems = []
    for m in NUMBER.finditer(text):
        n = _parse(m.group())
        if n is None:
            continue
        if not any(abs(n - k) <= 1e-9 * max(1.0, abs(k)) for k in known):
            problems.append(f"{m.group()} is in no tool result")
    return problems


# ---- 3. a draft is never called an order -----------------------------------------------------


def no_placed_claim(evs: list[dict]) -> list[str]:
    text = answer(evs)
    return [f"claims an order was placed: {m.group()!r}" for p in PLACED_CLAIMS for m in re.finditer(p, text, flags=re.I)]


# ---- 4. no table, tool or method names -------------------------------------------------------


def no_internal_names(evs: list[dict]) -> list[str]:
    text = answer(evs)
    problems = [f"names the tool {t}" for t in sorted(TOOLS) if t in text]
    for t in sorted(TABLES - PLAIN_WORD_TABLES):
        if re.search(rf"\b{t}\b", text):
            problems.append(f"names the table {t}")
    for p in METHODS:
        m = re.search(p, text, flags=re.I)
        if m:
            problems.append(f"names a method: {m.group()!r}")
    return problems


def run_all(evs: list[dict], case: dict) -> dict[str, list[str]]:
    return {
        "expected_tools": expected_tools(evs, case["expected_tools"]),
        "numbers_grounded": numbers_grounded(evs, case["question"]),
        "no_placed_claim": no_placed_claim(evs),
        "no_internal_names": no_internal_names(evs),
    }
