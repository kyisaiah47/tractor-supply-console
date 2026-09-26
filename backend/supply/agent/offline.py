"""Offline mode: no model configured, or the model is out of quota. A keyword router picks the
tool a question needs and writes the answer from its result. It uses the same tools as the model
path, so every number is real; it cannot reason across several tools the way a model can."""

import re
import time
from collections.abc import Iterator
from typing import Any

from ..catalog import MODEL_CODES
from .tools import execute_tool

Event = dict[str, Any]

# The first rule whose keywords appear in the question picks the tool. Order matters: "Which parts
# from which supplier are failing?" is about failures, and "Which supply orders will arrive late?"
# is about delays, not reordering. The eval golden set (evals/) checks these choices.
INTENTS = [
    ("forecast", r"forecast|demand|booked|how many tractors|next (year|month|quarter)|next (three|3|six|6|twelve|12) months"),
    ("failures", r"fail|broken|defect|quality|break"),
    ("customer_orders", r"pipeline|backlog|customer"),
    ("delays", r"delay|late|on.time|arriv|runs out|slow|fast"),
    ("inventory", r"order|reorder|inventory|stock|buy|excess|short"),
    ("delays", r"supplier"),
    ("brief", r"brief|summary|week|overview|status|what.*(happen|going)"),
]


def intent_of(question: str) -> str:
    t = question.lower()
    return next((name for name, pattern in INTENTS if re.search(pattern, t)), "overview")


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def usd(x: float) -> str:
    return f"${round(x):,}"


class ToolFailed(Exception):
    pass


def _call(name: str, tool_input: dict, out: list[Event]) -> Any:
    call_id = f"offline_{name}_{time.time_ns()}"
    out.append({"type": "tool_call", "id": call_id, "name": name, "input": tool_input})
    ok, result = execute_tool(name, tool_input)
    out.append({"type": "tool_result", "id": call_id, "name": name, "ok": ok, "result": result})
    if not ok:
        raise ToolFailed(result.get("error", "tool failed"))
    return result


def _say(text: str, pause: float) -> Iterator[Event]:
    """Stream the answer in short pieces, as a model would."""
    for part in re.findall(r".{1,24}(?:\s|$)|\S+", text, flags=re.S) or [text]:
        yield {"type": "text", "text": part}
        if pause:
            time.sleep(pause)


def run_offline(history: list[dict], pause: float = 0.012) -> Iterator[Event]:
    question = next((h["content"] for h in reversed(history) if h["role"] == "user"), "")
    t = question.lower()
    model = next((m for m in MODEL_CODES if m.lower() in t), None)
    letter = re.search(r"supplier\s+([a-e])\b", t)
    supplier = f"Supplier {letter.group(1).upper()}" if letter else None
    intent = intent_of(question)
    ev: list[Event] = []

    def flush() -> Iterator[Event]:
        yield from ev
        ev.clear()

    if intent == "forecast":
        r = _call("get_demand_forecast", {"tractor_model": model} if model else {}, ev)
        yield from flush()
        lines = [
            f"| {m['model']} | {sum(f['units'] for f in m['forecast'][:3])} | {sum(f['booked'] for f in m['forecast'][:3])} "
            f"| {sum(f['units'] for f in m['forecast'])} |"
            for m in r["perModel"]
        ]
        yield from _say(
            f"Tested on the last two years, the forecast was off by {pct(r['backtest'][r['chosenModel']]['mape'])} a month on average.\n\n"
            "| Model | Next 3 months | Booked | Next 12 months |\n|---|---|---|---|\n" + "\n".join(lines),
            pause,
        )
        return
    if intent == "delays":
        r = _call("get_supplier_delays", {"supplier": supplier} if supplier else {}, ev)
        yield from flush()
        table = [
            f"| {s['supplier']} | {s['meanDelay']} | {s['p90Delay']} | {' / '.join(str(q) for q in s['byQuarter'])} | {s['datasetMeanDelay']} |"
            for s in r["suppliers"]
        ]
        risk = "\n".join(
            f"Supply order {o['id']} ({o['sku']}, {o['supplier']}) should arrive {o['expectedArrival']}, and the part runs out "
            f"{o['needBy']}. Late-risk {pct(o['lateRisk'])}."
            for o in r["openOrders"][:5]
        )
        yield from _say(
            "| Supplier | Average days late | Worst 10% | By quarter | Market average |\n|---|---|---|---|---|\n"
            + "\n".join(table)
            + f"\n\n{r['openAtRisk']} open supply orders will probably arrive after their part runs out."
            + (f"\n\n{risk}" if risk else ""),
            pause,
        )
        return
    if intent == "failures":
        filters = {**({"tractor_model": model} if model else {}), **({"supplier": supplier} if supplier else {})}
        r = _call("get_component_failures", filters, ev)
        yield from flush()
        table = [
            f"| {x['sku']} | {x['category']} | {x['supplier']} | {pct(x['rate'])} | {pct(x['prior'])} | {x['units']} |"
            for x in r["rows"][:8]
        ]
        yield from _say(
            (
                "These parts fail well above the market rate:\n\n| Part | Category | Supplier | Rate | Expected | Units seen |\n"
                "|---|---|---|---|---|---|\n"
                + "\n".join(table)
                + f"\n\nAbout {r['expectedBrokenInPipeline']} parts in the next three months of builds will break."
            )
            if table
            else "No part is failing above the market rate for that filter.",
            pause,
        )
        return
    if intent == "inventory":
        action = "excess" if "excess" in t else "order"
        r = _call("get_inventory_recommendations", {"action": action, **({"tractor_model": model} if model else {})}, ev)
        yield from flush()
        table = [
            f"| {x['sku']} | {x['quantity']} | {x['supplier']} | {usd(x['spend'])} | "
            f"{x['daysOfCover'] if x['daysOfCover'] is not None else '-'} |"
            for x in r["rows"][:10]
        ]
        yield from _say(
            (
                f"{r['summary']['toOrder']} parts need an order now, for {usd(r['summary']['spend'])} in total.\n\n"
                "| Part | Quantity | Supplier | Spend | Days of stock |\n|---|---|---|---|---|\n" + "\n".join(table)
            )
            if table
            else "Nothing matches that filter.",
            pause,
        )
        if re.search(r"place|draft|propose|go ahead|do it", t) and r["rows"]:
            _call(
                "propose_supply_order",
                {
                    "lines": [{"sku": x["sku"], "quantity": x["quantity"], "supplier": x["supplier"]} for x in r["rows"][:10]],
                    "reason": "Parts below their reorder point, from the inventory strategy model.",
                },
                ev,
            )
            yield from flush()
            yield from _say("\n\nI drafted these orders. Press Confirm to queue them.", pause)
        return
    if intent == "customer_orders":
        tab = "backlog" if re.search(r"backlog|12|year", t) else "pipeline"
        r = _call(
            "list_customer_orders",
            {"tab": tab, "months": 3 if tab == "pipeline" else 12, **({"tractor_model": model} if model else {}), "limit": 5},
            ev,
        )
        yield from flush()
        label = "0-3 month production pipeline" if tab == "pipeline" else "12-month backlog"
        yield from _say(
            f"The {label} holds {r['totals']['orders']} orders for {r['totals']['tractors']} tractors{f' of {model}' if model else ''}. "
            f"{r['totals']['short']} of them are short of at least one part.",
            pause,
        )
        return
    if intent == "brief":
        r = _call("get_weekly_brief", {}, ev)
        yield from flush()
        yield from _say(r["body"] if r else "No weekly brief yet.", pause)
        return
    o = _call("get_overview", {}, ev)
    yield from flush()
    yield from _say(
        f"The 12-month backlog holds {o['backlogTractors']} tractors and the 0-3 month pipeline {o['pipelineTractors']}. "
        f"{o['partsToOrder']} parts need an order, {o['lateRisk']} open supply orders are at risk of arriving late, and "
        f"{o['elevatedFailures']} part and supplier pairs fail above normal.\n\nAsk about the demand forecast, supplier delays, "
        "component failures, what to reorder, or the production pipeline.",
        pause,
    )
