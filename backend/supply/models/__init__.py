"""The four models: run them, store their output once per planning week, read the latest."""

import json
from datetime import date, timedelta

from sqlalchemy import text

from ..db import engine, rows
from . import component_failure, demand, inventory_strategy, stock, supplier_delay

MODEL_SPECS = {
    "demand": {"title": "Demand fluctuations", **demand.SPEC},
    "supplier_delay": {"title": "Supplier delays", **supplier_delay.SPEC},
    "component_failure": {"title": "Component failures", **component_failure.SPEC},
    "inventory_strategy": {"title": "Cost-effective inventory strategy", **inventory_strategy.SPEC},
}
MODEL_NAMES = list(MODEL_SPECS)


def week_of(as_of: str) -> str:
    """The Monday of the planning date's week. One set of model runs and one brief per week."""
    d = date.fromisoformat(as_of)
    return (d - timedelta(days=d.weekday())).isoformat()


def run_all_models(as_of: str) -> dict:
    d = demand.run(demand.load_input(as_of))
    cf = component_failure.run(component_failure.load_input(as_of))
    sd = supplier_delay.run(supplier_delay.load_input(as_of, stock.load_stockout()))
    inv = inventory_strategy.run(inventory_strategy.load_input(as_of), d, sd, cf)
    return {"demand": d, "supplier_delay": sd, "component_failure": cf, "inventory_strategy": inv}


def save_runs(as_of: str, results: dict) -> None:
    """Upsert one row per model for the planning week, so a second run that week updates in place."""
    with engine().begin() as c:
        for name in MODEL_NAMES:
            c.execute(
                text(
                    """INSERT INTO model_runs (model, as_of, week, metrics, output)
                       VALUES (:model, :as_of, :week, CAST(:metrics AS jsonb), CAST(:output AS jsonb))
                       ON CONFLICT (model, week) DO UPDATE
                         SET as_of = EXCLUDED.as_of, ran_at = now(), metrics = EXCLUDED.metrics, output = EXCLUDED.output"""
                ),
                {
                    "model": name,
                    "as_of": as_of,
                    "week": week_of(as_of),
                    "metrics": json.dumps(results[name]["metrics"]),
                    "output": json.dumps(results[name]["output"]),
                },
            )


def latest_runs() -> dict | None:
    rs = rows("SELECT DISTINCT ON (model) model, metrics, output, ran_at FROM model_runs ORDER BY model, ran_at DESC")
    if len(rs) < len(MODEL_NAMES):
        return None
    out: dict = {r["model"]: {"metrics": r["metrics"], "output": r["output"]} for r in rs}
    out["ranAt"] = max(r["ran_at"] for r in rs)
    return out
