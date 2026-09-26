"""Demand forecast: tractors ordered per model per month, 12 months ahead.

Four candidate forecasts are fitted and scored on the last two years before the planning date,
each forecast 12 months ahead from the end of the year before (a rolling-origin backtest). The
candidate with the lowest mean absolute percentage error is used for the live forecast.

  trailing_mean          the last 12 months' average (baseline)
  seasonal_naive         the same month last year (baseline)
  trend_seasonal         statsmodels OLS: units ~ t + C(month)
  trend_seasonal_market  statsmodels OLS: units ~ t + C(month) + market demand + trend index + inflation

Exogenous market inputs are not known for future months, so in the backtest and in the
forecast they are held at their trailing 12-month mean. A candidate that only helps when it is
given the future's market data would be cheating the backtest.

Errors are scikit-learn's MAE, MAPE and RMSE. The 80% range is the forecast plus or minus the
backtest RMSE times scipy's normal quantile, widened with the horizon.
"""

import math
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from scipy import stats
from sklearn.metrics import mean_absolute_error, mean_absolute_percentage_error, root_mean_squared_error

from ..catalog import MODEL_CODES
from ..dates import add_months, month_index, month_range
from ..db import rows
from .common import rnd

CANDIDATES = ["trailing_mean", "seasonal_naive", "trend_seasonal", "trend_seasonal_market"]
FORMULAS = {
    "trend_seasonal": "units ~ t + C(month, levels=range(12))",
    "trend_seasonal_market": "units ~ t + C(month, levels=range(12)) + demand + trend + inflation",
}
Z80 = stats.norm.ppf(0.9)  # two-sided 80% range

SPEC = {
    "predicts": "Tractors ordered per model per month for the next 12 months, with a likely range.",
    "dataSources": [
        "Customer order history, the last four years",
        "Market data: market demand, market trend index and inflation by month",
        "Open orders for the next 12 months, to show how much of each month is already booked",
    ],
    "inputs": ["tractor model", "calendar month", "trend over time", "market demand, trend index and inflation"],
    "outputs": ["forecast tractors per model per month", "likely range", "booked and not yet booked tractors", "accuracy of each method"],
    "method": (
        "Four candidate forecasts: last year's average, the same month last year, trend plus month of year, and trend plus "
        "month plus market inputs. Each is tested on the last two years and the most accurate is used."
    ),
}


def load_input(as_of: str) -> dict:
    history = rows(
        """SELECT tractor_model AS model, to_char(requested_date,'YYYY-MM') AS ym, SUM(quantity)::int AS units
             FROM customer_orders WHERE requested_date < :as_of AND status <> 'cancelled' GROUP BY 1,2""",
        {"as_of": as_of},
    )
    market = rows(
        """SELECT tractor_model AS model, to_char(date,'YYYY-MM') AS ym, SUM(demand_units)::float AS demand,
                  AVG(market_trend_index)::float AS trend, AVG(inflation_rate)::float AS inflation
             FROM market_signals WHERE date < :as_of GROUP BY 1,2""",
        {"as_of": as_of},
    )
    booked = rows(
        """SELECT tractor_model AS model, to_char(requested_date,'YYYY-MM') AS ym, SUM(quantity)::int AS units
             FROM customer_orders WHERE requested_date >= date_trunc('month', CAST(:as_of AS date)) AND status <> 'cancelled'
            GROUP BY 1,2""",
        {"as_of": as_of},
    )
    return {"asOf": as_of, "history": history, "market": market, "booked": booked}


def _t_index(ym: str) -> int:
    return (int(ym[:4]) - 2020) * 12 + month_index(ym)


def _frame(yms: list[str]) -> pd.DataFrame:
    return pd.DataFrame({"ym": yms, "t": [_t_index(y) / 12 for y in yms], "month": [month_index(y) for y in yms]})


def series_for(inp: dict, model: str) -> pd.DataFrame:
    """Monthly units and market inputs for one tractor model, from the first month of history to last month."""
    hist = {h["ym"]: h["units"] for h in inp["history"] if h["model"] == model}
    mkt = {m["ym"]: m for m in inp["market"] if m["model"] == model}
    last_ym = add_months(inp["asOf"][:7], -1)
    first_ym = min([h["ym"] for h in inp["history"]] + [last_ym])
    s = _frame(month_range(first_ym, last_ym))
    s["units"] = [hist.get(y, 0) for y in s["ym"]]
    s["demand"] = [mkt[y]["demand"] if y in mkt else 0.0 for y in s["ym"]]
    s["trend"] = [mkt[y]["trend"] if y in mkt else 0.5 for y in s["ym"]]
    s["inflation"] = [mkt[y]["inflation"] if y in mkt else 3.75 for y in s["ym"]]
    return s


def predict(candidate: str, train: pd.DataFrame, horizon: list[str]) -> np.ndarray:
    """Fit one candidate on `train` and forecast the `horizon` months."""
    last12 = train.tail(12)
    if candidate == "trailing_mean":
        return np.full(len(horizon), last12["units"].mean())
    if candidate == "seasonal_naive":
        by_month = dict(zip(last12["month"], last12["units"], strict=True))
        return np.array([by_month.get(month_index(y), last12["units"].mean()) for y in horizon], dtype=float)
    fit = smf.ols(FORMULAS[candidate], data=train).fit()
    future = _frame(horizon)
    for col in ("demand", "trend", "inflation"):
        future[col] = last12[col].mean()
    return np.maximum(0, fit.predict(future).to_numpy())


def run(inp: dict) -> dict:
    as_of_ym = inp["asOf"][:7]
    folds: list[dict[str, Any]] = [
        {"trainTo": add_months(as_of_ym, -25), "test": month_range(add_months(as_of_ym, -24), add_months(as_of_ym, -13))},
        {"trainTo": add_months(as_of_ym, -13), "test": month_range(add_months(as_of_ym, -12), add_months(as_of_ym, -1))},
    ]
    series = {m: series_for(inp, m) for m in MODEL_CODES}

    backtest: dict[str, dict] = {}
    for c in CANDIDATES:
        maes, mapes = [], []
        rmse_by_model = {}
        for model in MODEL_CODES:
            s = series[model]
            errs = []
            for f in folds:
                train = s[s["ym"] <= f["trainTo"]]
                actual = s[s["ym"].isin(f["test"])]["units"].to_numpy()
                pred = predict(c, train, f["test"])
                maes.append(mean_absolute_error(actual, pred))
                mapes.append(mean_absolute_percentage_error(actual, pred))
                errs.append(root_mean_squared_error(actual, pred))
            rmse_by_model[model] = float(np.mean(errs))
        backtest[c] = {"mae": rnd(float(np.mean(maes)), 1), "mape": rnd(float(np.mean(mapes)), 4), "rmseByModel": rmse_by_model}
    chosen = min(CANDIDATES, key=lambda c: backtest[c]["mape"])

    horizon = month_range(as_of_ym, add_months(as_of_ym, 11))
    booked = {f"{b['model']}|{b['ym']}": b["units"] for b in inp["booked"]}
    per_model = []
    for model in MODEL_CODES:
        s = series[model]
        pred = predict(chosen, s, horizon)
        sigma = backtest[chosen]["rmseByModel"][model]
        forecast = []
        for i, ym in enumerate(horizon):
            b = booked.get(f"{model}|{ym}", 0)
            widen = math.sqrt(1 + i / 12)
            forecast.append(
                {
                    "ym": ym,
                    "units": rnd(pred[i]),
                    "lo": max(0, rnd(pred[i] - Z80 * sigma * widen)),
                    "hi": rnd(pred[i] + Z80 * sigma * widen),
                    "booked": b,
                    "unbooked": max(0, rnd(pred[i]) - b),
                }
            )
        per_model.append(
            {
                "model": model,
                "sigma": rnd(sigma, 1),
                "history": [{"ym": ym, "units": int(u)} for ym, u in zip(s["ym"].tail(24), s["units"].tail(24), strict=True)],
                "forecast": forecast,
            }
        )

    # Does the provided dataset carry demand signal on its own? Correlations over model-months.
    market = pd.DataFrame(inp["market"])
    diagnostics = {
        "corrDemandVsTrendIndex": rnd(float(stats.pearsonr(market["demand"], market["trend"]).statistic), 3),
        "corrDemandVsInflation": rnd(float(stats.pearsonr(market["demand"], market["inflation"]).statistic), 3),
    }

    return {
        "metrics": {
            "chosen": chosen,
            "backtest": backtest,
            "diagnostics": diagnostics,
            "folds": [f"{f['test'][0]}..{f['test'][11]}" for f in folds],
        },
        "output": {
            "horizon": horizon,
            "perModel": per_model,
            "total12": sum(f["units"] for m in per_model for f in m["forecast"]),
            "booked12": sum(f["booked"] for m in per_model for f in m["forecast"]),
        },
    }
