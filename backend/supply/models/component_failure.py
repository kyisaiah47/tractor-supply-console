"""Component failure: the share of each part, from each supplier, that breaks at receiving,
during assembly or in the field.

Each part-and-supplier rate is a beta-binomial posterior (scipy.stats.beta). The prior is the
provided dataset's own Component_Failure_Rate for that tractor model, weighted like 400 observed
units, so a supplier with few lots stays near the dataset rate and one with thousands of units
speaks for itself. A rate is flagged when the low end of its exact 90% beta interval sits 25%
above the prior.

Only lots received at least 120 days before the as-of date are used, because a part received
last week has not had time to fail yet.
"""

import numpy as np
from scipy import stats
from sklearn.metrics import mean_absolute_error

from ..dates import add_days
from ..db import rows
from .common import rnd

PRIOR_STRENGTH = 400
LIFT_FLAG = 1.25
MATURITY_DAYS = 120
INTERVAL = 0.90

SPEC = {
    "predicts": "Failure rate for every part from every supplier, and how many parts in the next three months of builds will break.",
    "dataSources": [
        "Received parts: how many broke, when, and whether at receiving, assembly or in the field",
        "Market data: component failure rate per tractor model, as the starting point",
        "The production schedule: tractors to be built in the next three months",
    ],
    "inputs": ["part", "supplier", "units received", "units broken", "market failure rate for the model"],
    "outputs": [
        "failure rate with a likely range",
        "parts failing above the market rate",
        "expected broken parts in the next three months",
    ],
    "method": (
        "Starts from the market rate and moves toward each supplier's own record as parts are received. "
        "Flagged when even the low end of the likely range is 25% above the market rate."
    ),
}

LOT_SQL = """
  SELECT l.sku, p.tractor_model, p.category, l.supplier,
         SUM(l.quantity)::int AS units, SUM(l.broken_quantity)::int AS broken,
         SUM(CASE WHEN l.broken_stage='receiving' THEN l.broken_quantity ELSE 0 END)::int AS receiving,
         SUM(CASE WHEN l.broken_stage='assembly'  THEN l.broken_quantity ELSE 0 END)::int AS assembly,
         SUM(CASE WHEN l.broken_stage='field'     THEN l.broken_quantity ELSE 0 END)::int AS field
    FROM inventory_parts l JOIN parts p USING (sku)
   WHERE l.received_date >= :lo AND l.received_date < :hi
   GROUP BY 1,2,3,4"""


def load_input(as_of: str) -> dict:
    cutoff = add_days(as_of, -MATURITY_DAYS)
    split = add_days(as_of, -365)
    return {
        "asOf": as_of,
        "lots": rows(LOT_SQL, {"lo": "1900-01-01", "hi": cutoff}),
        "lotsTrain": rows(LOT_SQL, {"lo": "1900-01-01", "hi": add_days(split, -MATURITY_DAYS)}),
        "lotsTest": rows(LOT_SQL, {"lo": split, "hi": cutoff}),
        "priors": rows(
            """SELECT tractor_model AS model, AVG(component_failure_rate)::float AS rate
                 FROM market_signals WHERE date < :as_of GROUP BY 1""",
            {"as_of": as_of},
        ),
        "pipelineUnits": rows(
            """SELECT o.tractor_model, SUM(o.quantity)::int AS units
                 FROM production_pipeline pp JOIN customer_orders o ON o.id = pp.customer_order_id GROUP BY 1"""
        ),
    }


def posterior(lot: dict, prior: float):
    """Beta posterior after `broken` failures in `units`, from a Beta prior centred on the dataset rate."""
    a = prior * PRIOR_STRENGTH + lot["broken"]
    b = (1 - prior) * PRIOR_STRENGTH + (lot["units"] - lot["broken"])
    return stats.beta(a, b)


def run(inp: dict) -> dict:
    prior = {p["model"]: p["rate"] for p in inp["priors"]}

    def prior_for(m: str) -> float:
        return prior.get(m, 0.05)

    # Backtest: fit on lots received before the last year, predict broken units in the last year's lots.
    fitted = {f"{lot['sku']}|{lot['supplier']}": posterior(lot, prior_for(lot["tractor_model"])).mean() for lot in inp["lotsTrain"]}
    test = inp["lotsTest"]
    broken = np.array([lot["broken"] for lot in test])
    units = np.array([lot["units"] for lot in test])
    model_rate = np.array([fitted.get(f"{lot['sku']}|{lot['supplier']}", prior_for(lot["tractor_model"])) for lot in test])
    dataset_rate = np.array([prior_for(lot["tractor_model"]) for lot in test])
    backtest = {
        "model_mae_units": rnd(mean_absolute_error(broken, model_rate * units), 2),
        "dataset_rate_mae_units": rnd(mean_absolute_error(broken, dataset_rate * units), 2),
        "test_pairs": len(test),
    }

    out_rows = []
    for lot in inp["lots"]:
        p = prior_for(lot["tractor_model"])
        post = posterior(lot, p)
        lo, hi = post.interval(INTERVAL)
        mean = post.mean()
        out_rows.append(
            {
                "sku": lot["sku"],
                "tractorModel": lot["tractor_model"],
                "category": lot["category"],
                "supplier": lot["supplier"],
                "units": lot["units"],
                "broken": lot["broken"],
                "stages": {"receiving": lot["receiving"], "assembly": lot["assembly"], "field": lot["field"]},
                "rate": rnd(mean, 4),
                "lo": rnd(lo, 4),
                "hi": rnd(hi, 4),
                "prior": rnd(p, 4),
                "lift": rnd(mean / p, 2),
                "elevated": bool(lo > p * LIFT_FLAG),
            }
        )
    out_rows.sort(key=lambda r: -r["lift"])

    pipeline = {p["tractor_model"]: p["units"] for p in inp["pipelineUnits"]}
    by_sku: dict[str, list[dict]] = {}
    for r in out_rows:
        by_sku.setdefault(r["sku"], []).append(r)
    exposure = []
    for sku, rs in by_sku.items():
        n = pipeline.get(rs[0]["tractorModel"], 0)
        weighted = float(np.average([r["rate"] for r in rs], weights=[r["units"] for r in rs]))
        exposure.append(
            {
                "sku": sku,
                "tractorModel": rs[0]["tractorModel"],
                "category": rs[0]["category"],
                "pipelineUnits": n,
                "expectedBroken": rnd(n * weighted, 1),
            }
        )
    exposure.sort(key=lambda e: -e["expectedBroken"])

    return {
        "metrics": {"backtest": backtest, "priorStrength": PRIOR_STRENGTH, "liftFlag": LIFT_FLAG, "maturityDays": MATURITY_DAYS},
        "output": {
            "rows": out_rows,
            "elevated": [r for r in out_rows if r["elevated"]],
            "pipelineExposure": exposure,
            "expectedBrokenInPipeline": rnd(sum(e["expectedBroken"] for e in exposure)),
        },
    }
