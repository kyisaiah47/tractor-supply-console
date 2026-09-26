"""Supplier delay: how many days after the promised date each supplier's parts arrive, and
which open supply orders are likely to land after the part runs out.

Delay = fulfilled_date - promised_date on every fulfilled supply order. The expected delay per
supplier and quarter is a statsmodels OLS regression, delay ~ C(supplier) * C(quarter).

Earlier versions pulled each quarter toward its supplier's average. A statsmodels MixedLM
(random supplier intercept, supplier-by-quarter variance component) was tried for that: every
supplier-quarter cell holds about 100 or more orders, so pooling barely moved the estimates,
and on some planning dates it shrank Supplier D's real Q4 slowdown by a third. The fixed-effects
regression scores the same on the backtest and keeps real effects intact.

The backtest trains on orders promised more than a year before the planning date and scores the
last year against two baselines: the overall mean, and the provided dataset's own per-supplier
Supplier_Delay_Days. Late risk is scipy's empirical survival function of each supplier's delays,
shifted to the expected delay for the order's quarter.
"""

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from scipy import stats
from sklearn.metrics import mean_absolute_error

from ..catalog import SUPPLIER_CODES
from ..dates import add_days, diff_days, quarter_of
from ..db import rows
from ..prng import js_round
from .common import rnd

ON_TIME_DAYS = 3
FORMULA = "delay ~ C(supplier) * C(quarter, levels=range(4))"

SPEC = {
    "predicts": "How many days late each supplier delivers by quarter, and the chance each open supply order arrives after its part runs out.",
    "dataSources": [
        "Supply order history: promised date against delivery date",
        "Market data: supplier delay days, as the baseline to beat",
        "Stock on hand and the production schedule: the date each part runs out",
    ],
    "inputs": ["supplier", "quarter the order was placed", "promised date", "need-by date"],
    "outputs": ["average and worst-case delay per supplier and quarter", "on-time rate", "chance each open supply order is late"],
    "method": "Average delay per supplier and quarter from the supply order history. Risk comes from each supplier's real spread of delays.",
}


def load_input(as_of: str, stockout: list[dict]) -> dict:
    history = rows(
        """SELECT supplier, promised_date AS promised, fulfilled_date AS fulfilled, date_ordered AS ordered
             FROM supply_orders WHERE status='fulfilled' AND fulfilled_date < :as_of AND promised_date IS NOT NULL""",
        {"as_of": as_of},
    )
    dataset_means = rows(
        "SELECT supplier, AVG(supplier_delay_days)::float AS mean FROM market_signals WHERE date < :as_of GROUP BY 1",
        {"as_of": as_of},
    )
    open_orders = rows(
        """SELECT s.id, s.sku, p.tractor_model, s.supplier, s.quantity, s.date_ordered, s.promised_date
             FROM supply_orders s JOIN parts p USING (sku)
            WHERE s.status='placed' AND s.supplier IS NOT NULL ORDER BY s.promised_date"""
    )
    return {"asOf": as_of, "history": history, "datasetMeans": dataset_means, "open": open_orders, "stockout": stockout}


def _frame(history: list[dict]) -> pd.DataFrame:
    h = pd.DataFrame(history, columns=["supplier", "promised", "fulfilled", "ordered"])
    h["delay"] = [diff_days(f, p) for f, p in zip(h["fulfilled"], h["promised"], strict=True)]
    h["quarter"] = [quarter_of(o) for o in h["ordered"]]
    return h


class DelayFit:
    """The regression, with the overall mean for any supplier it has not seen."""

    def __init__(self, h: pd.DataFrame) -> None:
        self.overall = float(h["delay"].mean())
        self.known = set(h["supplier"])
        self.fit = smf.ols(FORMULA, data=h).fit()

    def expected(self, suppliers: list[str], quarters: list[int]) -> np.ndarray:
        q = pd.DataFrame({"supplier": suppliers, "quarter": quarters})
        known = q["supplier"].isin(self.known).to_numpy()
        out = np.full(len(q), self.overall)
        if known.any():
            out[known] = self.fit.predict(q[known]).to_numpy()
        return out


def run(inp: dict) -> dict:
    h = _frame(inp["history"])
    split = add_days(inp["asOf"], -365)
    train, test = h[h["promised"] < split], h[h["promised"] >= split]
    f0 = DelayFit(train)
    ds_mean = {d["supplier"]: d["mean"] for d in inp["datasetMeans"]}
    actual = test["delay"].to_numpy()
    backtest = {
        "model_mae": rnd(mean_absolute_error(actual, f0.expected(list(test["supplier"]), list(test["quarter"]))), 2),
        "overall_mean_mae": rnd(mean_absolute_error(actual, np.full(len(test), f0.overall)), 2),
        "dataset_supplier_mean_mae": rnd(mean_absolute_error(actual, [ds_mean.get(s, f0.overall) for s in test["supplier"]]), 2),
        "test_orders": len(test),
    }

    f = DelayFit(h)
    by_supplier = {s: g["delay"].to_numpy() for s, g in h.groupby("supplier")}
    suppliers = []
    for s in SUPPLIER_CODES:
        d = by_supplier.get(s, np.array([]))
        by_quarter = f.expected([s] * 4, [0, 1, 2, 3])
        suppliers.append(
            {
                "supplier": s,
                "orders": len(d),
                "meanDelay": rnd(float(d.mean()) if len(d) else f.overall, 1),
                "p90Delay": rnd(float(stats.quantile(d, 0.9)), 0) if len(d) else 0,
                "onTimeRate": rnd(float((d <= ON_TIME_DAYS).sum()) / max(1, len(d)), 3),
                "datasetMeanDelay": rnd(ds_mean.get(s, 0), 1),
                "byQuarter": [rnd(float(x), 1) for x in by_quarter],
            }
        )

    stockout = {s["sku"]: s["date"] for s in inp["stockout"]}
    ecdf = {s: stats.ecdf(d) for s, d in by_supplier.items()}
    open_orders = []
    expected = f.expected([o["supplier"] for o in inp["open"]], [quarter_of(o["date_ordered"]) for o in inp["open"]])
    for o, exp in zip(inp["open"], expected, strict=True):
        dist = by_supplier.get(o["supplier"], np.array([f.overall]))
        shift = float(exp) - float(dist.mean())
        need_by = stockout.get(o["sku"])
        late_risk = 0.0
        if need_by:
            slack = diff_days(need_by, o["promised_date"])
            # P(delay + shift > slack), from the supplier's own delays.
            late_risk = float(ecdf[o["supplier"]].sf.evaluate(slack - shift)) if o["supplier"] in ecdf else 0.0
        open_orders.append(
            {
                "id": o["id"],
                "sku": o["sku"],
                "tractorModel": o["tractor_model"],
                "supplier": o["supplier"],
                "quantity": o["quantity"],
                "promised": o["promised_date"],
                "expectedArrival": add_days(o["promised_date"], js_round(float(exp))),
                "p90Arrival": add_days(o["promised_date"], js_round(float(stats.quantile(dist, 0.9)) + shift)),
                "needBy": need_by,
                "lateRisk": rnd(late_risk, 2),
            }
        )

    return {
        "metrics": {"backtest": backtest, "onTimeThresholdDays": ON_TIME_DAYS, "overallMeanDelay": rnd(f.overall, 1)},
        "output": {"suppliers": suppliers, "openOrders": open_orders, "atRisk": sum(1 for o in open_orders if o["lateRisk"] >= 0.5)},
    }
