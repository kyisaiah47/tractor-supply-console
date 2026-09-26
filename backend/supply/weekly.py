"""The weekly job: run the four models, store their output, and write the dashboard's brief.

The brief is written by the configured LLM from a fixed set of facts, or by a template when no
LLM is configured. Either way every number in it comes from `facts`. There is one set of model
runs and one brief per planning week: running the job again that week updates them in place.
"""

import json
import logging

from sqlalchemy import text

from .config import as_of as default_as_of
from .dates import month_label
from .db import engine, one
from .models import run_all_models, save_runs, week_of

log = logging.getLogger(__name__)


def brief_facts(r: dict) -> dict:
    d = r["demand"]
    next3 = [
        {
            "model": m["model"],
            "forecast": sum(f["units"] for f in m["forecast"][:3]),
            "booked": sum(f["booked"] for f in m["forecast"][:3]),
        }
        for m in d["output"]["perModel"]
    ]
    suppliers = sorted(r["supplier_delay"]["output"]["suppliers"], key=lambda s: -s["meanDelay"])
    to_order = sorted(
        (x for x in r["inventory_strategy"]["output"]["rows"] if x["action"] == "order"),
        key=lambda x: x["daysOfCover"] or 0,
    )
    return {
        "horizon": f"{month_label(d['output']['horizon'][0])} to {month_label(d['output']['horizon'][11])}",
        "demand": {
            "chosenModel": d["metrics"]["chosen"],
            "backtestMape": d["metrics"]["backtest"][d["metrics"]["chosen"]]["mape"],
            "forecast12": d["output"]["total12"],
            "booked12": d["output"]["booked12"],
            "next3": next3,
        },
        "suppliers": {
            "slowest": suppliers[0],
            "fastest": suppliers[-1],
            "openAtRisk": r["supplier_delay"]["output"]["atRisk"],
            "openTotal": len(r["supplier_delay"]["output"]["openOrders"]),
        },
        "failures": {
            "elevated": [
                {"sku": e["sku"], "category": e["category"], "supplier": e["supplier"], "rate": e["rate"], "prior": e["prior"]}
                for e in r["component_failure"]["output"]["elevated"][:4]
            ],
            "expectedBrokenInPipeline": r["component_failure"]["output"]["expectedBrokenInPipeline"],
        },
        "inventory": {
            "toOrder": r["inventory_strategy"]["output"]["toOrder"],
            "spend": r["inventory_strategy"]["output"]["spend"],
            "excess": r["inventory_strategy"]["output"]["excess"],
            "excessValue": r["inventory_strategy"]["output"]["excessValue"],
            "mostUrgent": [
                {"sku": x["sku"], "daysOfCover": x["daysOfCover"], "supplier": x["supplier"], "quantity": x["quantity"]}
                for x in to_order[:3]
            ],
        },
    }


def pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def usd(x: float) -> str:
    return f"${round(x):,}"


def template_brief(f: dict) -> str:
    lines = [
        f"Demand: the forecast for {f['horizon']} is {f['demand']['forecast12']:,} tractors, and {f['demand']['booked12']:,} "
        f"are already booked. Tested on the last two years, the forecast was off by {pct(f['demand']['backtestMape'])} a month on average.",
        f"Suppliers: {f['suppliers']['slowest']['supplier']} is the slowest at {f['suppliers']['slowest']['meanDelay']} days late "
        f"on average, and {f['suppliers']['fastest']['supplier']} is the fastest at {f['suppliers']['fastest']['meanDelay']}. "
        f"{f['suppliers']['openAtRisk']} of {f['suppliers']['openTotal']} open supply orders will probably arrive after their part runs out.",
    ]
    if f["failures"]["elevated"]:
        e = "; ".join(
            f"{x['category']} {x['sku']} from {x['supplier']} fails {pct(x['rate'])} against {pct(x['prior'])} expected"
            for x in f["failures"]["elevated"]
        )
        lines.append(
            f"Failures: {e}. About {f['failures']['expectedBrokenInPipeline']:,} parts in the next three months of builds will break."
        )
    inv = f["inventory"]
    urgent = inv["mostUrgent"][0] if inv["mostUrgent"] else None
    lines.append(
        f"Inventory: {inv['toOrder']} parts need an order now, for {usd(inv['spend'])} in total. "
        + (
            f"{inv['excess']} parts hold more than two months of stock above target, worth {usd(inv['excessValue'])}. "
            if inv["excess"]
            else "No part holds more than two months of stock above target. "
        )
        + (
            f"Order {urgent['quantity']} {urgent['sku']} from {urgent['supplier']} first: {urgent['daysOfCover']} days of stock are left."
            if urgent
            else ""
        )
    )
    return "\n\n".join(lines)


def llm_facts(f: dict) -> dict:
    """What the LLM sees: every figure already formatted, every field named for what it means."""

    def n(x: float) -> str:
        return f"{round(x):,}"

    return {
        "period": f["horizon"],
        "demand": {
            "tractorsForecast": n(f["demand"]["forecast12"]),
            "tractorsAlreadyBooked": n(f["demand"]["booked12"]),
            "forecastAverageMissOnTheLastTwoYears": pct(f["demand"]["backtestMape"]),
        },
        "suppliers": {
            "slowest": {
                "name": f["suppliers"]["slowest"]["supplier"],
                "averageDaysLate": f["suppliers"]["slowest"]["meanDelay"],
                "daysLateInQ4": f["suppliers"]["slowest"]["byQuarter"][3],
            },
            "fastest": {"name": f["suppliers"]["fastest"]["supplier"], "averageDaysLate": f["suppliers"]["fastest"]["meanDelay"]},
            "openSupplyOrders": f["suppliers"]["openTotal"],
            "openSupplyOrdersLikelyToArriveAfterThePartRunsOut": f["suppliers"]["openAtRisk"],
        },
        "failures": {
            "partsFailingAboveTheMarketRate": [
                {
                    "part": f"{e['category']} {e['sku']}",
                    "supplier": e["supplier"],
                    "failureRate": pct(e["rate"]),
                    "marketRate": pct(e["prior"]),
                }
                for e in f["failures"]["elevated"]
            ],
            "partsExpectedToBreakInTheNextThreeMonthsOfBuilds": n(f["failures"]["expectedBrokenInPipeline"]),
        },
        "inventory": {
            "partsToOrderNow": f["inventory"]["toOrder"],
            "totalCostOfThoseOrders": usd(f["inventory"]["spend"]),
            "partsWithExcessStock": f["inventory"]["excess"],
            "mostUrgent": [
                {"part": u["sku"], "daysOfStockLeft": u["daysOfCover"], "orderQuantity": u["quantity"], "supplier": u["supplier"]}
                for u in f["inventory"]["mostUrgent"]
            ],
        },
    }


BRIEF_SYSTEM = """You write the weekly supply-chain brief for a tractor manufacturer's planning team.
Use only the facts in the JSON. Copy every number exactly as written, with its % or $ sign. Never invent a number.
Never name a database table, field, model id or statistical method. Write for a supply planner.
Write four paragraphs headed Demand, Suppliers, Failures, Inventory, each starting with its heading and a colon.
Each paragraph has at most three sentences. One fact per sentence. Plain sentences, no metaphors, no filler, no bullet points.
End the Inventory paragraph with the single most urgent action: which part to order, how many, and from which supplier."""


def run_weekly_job(use_llm: bool = True, as_of: str | None = None) -> dict:
    as_of = as_of or default_as_of()
    results = run_all_models(as_of)
    save_runs(as_of, results)
    facts = brief_facts(results)
    body, author = template_brief(facts), "template"
    if use_llm:
        from .llm import complete_text

        try:
            out = complete_text(BRIEF_SYSTEM, json.dumps(llm_facts(facts), indent=2), purpose="weekly_brief")
            if out and out["text"].strip():
                body, author = out["text"].strip(), out["author"]
            elif out:
                log.error("weekly brief: %s returned no text, kept the template brief", out["author"])
        except Exception as e:  # noqa: BLE001 - the template brief is the fallback for any model failure
            log.error("weekly brief: LLM call failed, kept the template brief: %s", e)
    with engine().begin() as c:
        c.execute(
            text(
                """INSERT INTO weekly_briefs (as_of, week, author, body, facts)
                   VALUES (:as_of, :week, :author, :body, CAST(:facts AS jsonb))
                   ON CONFLICT (week) DO UPDATE
                     SET as_of = EXCLUDED.as_of, generated_at = now(), author = EXCLUDED.author,
                         body = EXCLUDED.body, facts = EXCLUDED.facts"""
            ),
            {"as_of": as_of, "week": week_of(as_of), "author": author, "body": body, "facts": json.dumps(facts)},
        )
    return {"asOf": as_of, "author": author, "body": body, "facts": facts}


def latest_brief() -> dict | None:
    return one("SELECT as_of, generated_at, author, body, facts FROM weekly_briefs ORDER BY generated_at DESC LIMIT 1")
