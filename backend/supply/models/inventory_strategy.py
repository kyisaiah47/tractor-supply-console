"""Inventory strategy: for every part, whether to order now, how many, and from which supplier,
so that builds are covered at a 95% service level without carrying excess.

It combines the other three models. Demand sets how fast a part is used. The supplier delay
model stretches each supplier's quoted lead time by how late that supplier really is, and its
spread becomes lead-time uncertainty in the safety stock. The failure model inflates the
quantity to cover parts that will break, and prices a supplier's broken parts into its cost.
Inflation from the provided dataset raises the cost of holding stock.

  safety stock  = z * sqrt(L * sd_demand^2 + demand^2 * sd_L^2)     z from scipy.stats.norm
  reorder point = demand * L + safety stock
  target        = reorder point + one month of demand
  order when stock on hand + on order < reorder point; mark excess when it is above
  target + two months of demand.
"""

import math

from scipy import stats

from ..db import one, rows
from .common import rnd

SERVICE_LEVEL = 0.95
Z_SERVICE = stats.norm.ppf(SERVICE_LEVEL)  # one-sided
Z_P90 = stats.norm.ppf(0.9)  # turns a supplier's p90 delay into a standard deviation
REVIEW_MONTHS = 1
EXCESS_MONTHS = 2
BASE_HOLDING = 0.2  # warehouse, capital and obsolescence, per year
DELAY_COST_PER_DAY = 0.001  # share of price lost per day late (line stoppage risk)
ORDER_COST = 400  # fixed cost per order, for the economic order quantity

SPEC = {
    "predicts": "For every part: order now, hold, or excess; the quantity; and the supplier with the lowest effective cost.",
    "dataSources": [
        "The demand, supplier delay and component failure forecasts",
        "Stock on hand and supply already ordered",
        "Each supplier's price and quoted lead time",
        "Market data: inflation, for the cost of holding stock",
    ],
    "inputs": ["monthly demand and its spread", "lead time plus expected delay", "failure rate", "unit price", "inflation"],
    "outputs": ["reorder point and target stock", "order quantity", "chosen supplier", "spend", "excess units and value"],
    "method": (
        "Order when stock plus supply on the way falls below the reorder point, set to cover 95% of lead times and demand "
        "swings. The supplier is the cheapest after pricing in its failures and delays."
    ),
}


def load_input(as_of: str) -> dict:
    infl = one(
        """SELECT AVG(inflation_rate)::float AS v FROM market_signals
            WHERE date >= (CAST(:as_of AS date) - interval '12 months') AND date < :as_of""",
        {"as_of": as_of},
    )
    return {
        "asOf": as_of,
        "parts": rows("SELECT sku, tractor_model, category, qty_per_tractor, standard_cost FROM parts ORDER BY sku"),
        "partSuppliers": rows("SELECT sku, supplier, unit_price, nominal_lead_days FROM part_suppliers"),
        "onHand": rows("SELECT sku, SUM(on_hand)::int AS units FROM inventory GROUP BY 1"),
        "onOrder": rows("SELECT sku, SUM(quantity)::int AS units FROM supply_orders WHERE status IN ('queued','placed') GROUP BY 1"),
        "inflation": (infl or {}).get("v") or 3.75,
    }


def run(inp: dict, demand: dict, delay: dict, failure: dict) -> dict:
    holding_rate = BASE_HOLDING + inp["inflation"] / 100
    quarter = (int(inp["asOf"][5:7]) - 1) // 3
    on_hand = {o["sku"]: o["units"] for o in inp["onHand"]}
    on_order = {o["sku"]: o["units"] for o in inp["onOrder"]}
    supplier_stats = {s["supplier"]: s for s in delay["output"]["suppliers"]}
    fail_rate = {f"{r['sku']}|{r['supplier']}": r["rate"] for r in failure["output"]["rows"]}
    per_model = {m["model"]: m for m in demand["output"]["perModel"]}

    out_rows = []
    for p in inp["parts"]:
        dm = per_model[p["tractor_model"]]
        next3 = dm["forecast"][:3]
        monthly = sum(max(f["units"], f["booked"]) for f in next3) / 3 * p["qty_per_tractor"]
        sd_monthly = dm["sigma"] * p["qty_per_tractor"]

        options = []
        for s in (s for s in inp["partSuppliers"] if s["sku"] == p["sku"]):
            st = supplier_stats.get(s["supplier"])
            exp_delay = st["byQuarter"][quarter] if st else 15
            spread = max(1, (st["p90Delay"] - st["meanDelay"]) / Z_P90) if st else 8
            fr = fail_rate.get(f"{p['sku']}|{s['supplier']}", 0.05)
            effective = s["unit_price"] / (1 - fr) * (1 + DELAY_COST_PER_DAY * exp_delay)
            options.append(
                {
                    "supplier": s["supplier"],
                    "unitPrice": s["unit_price"],
                    "quotedLeadDays": s["nominal_lead_days"],
                    "expectedDelayDays": rnd(exp_delay, 1),
                    "leadMonths": (s["nominal_lead_days"] + exp_delay) / 30,
                    "sdLeadMonths": spread / 30,
                    "failureRate": fr,
                    "effectiveCost": rnd(effective, 2),
                }
            )
        options.sort(key=lambda o: o["effectiveCost"])
        best = options[0]

        safety = Z_SERVICE * math.sqrt(best["leadMonths"] * sd_monthly**2 + monthly**2 * best["sdLeadMonths"] ** 2)
        reorder_point = monthly * best["leadMonths"] + safety
        target = reorder_point + monthly * REVIEW_MONTHS
        have = on_hand.get(p["sku"], 0)
        coming = on_order.get(p["sku"], 0)
        position = have + coming

        action, quantity = "ok", 0
        if position < reorder_point:
            action = "order"
            eoq = math.sqrt(2 * monthly * 12 * ORDER_COST / (best["unitPrice"] * holding_rate))
            quantity = math.ceil(max(target - position, min(eoq, monthly)) / (1 - best["failureRate"]))
        elif position > target + monthly * EXCESS_MONTHS:
            action = "excess"
        excess_units = rnd(position - target) if action == "excess" else 0
        if action == "order":
            reason = (
                f"{have} on hand and {coming} on order is below the reorder point of {rnd(reorder_point)}. "
                f"{best['supplier']} has the lowest cost after failures ({best['failureRate'] * 100:.1f}%) "
                f"and delay ({best['expectedDelayDays']} days)."
            )
        elif action == "excess":
            monthly_cost = rnd(excess_units * best["unitPrice"] * holding_rate / 12)
            reason = (
                f"{position} on hand and on order is {excess_units} above the target of {rnd(target)}. "
                f"Holding the excess costs about ${monthly_cost:,} a month."
            )
        else:
            reason = f"{position} on hand and on order covers the reorder point of {rnd(reorder_point)}."

        out_rows.append(
            {
                "sku": p["sku"],
                "tractorModel": p["tractor_model"],
                "category": p["category"],
                "monthlyDemand": rnd(monthly),
                "onHand": have,
                "onOrder": coming,
                "position": position,
                "safetyStock": rnd(safety),
                "reorderPoint": rnd(reorder_point),
                "target": rnd(target),
                "daysOfCover": rnd(have / monthly * 30) if monthly > 0 else None,
                "action": action,
                "quantity": quantity,
                "supplier": best["supplier"],
                "unitPrice": best["unitPrice"],
                "spend": rnd(quantity * best["unitPrice"]),
                "excessUnits": excess_units,
                "excessValue": rnd(excess_units * best["unitPrice"]),
                "reason": reason,
                "options": [
                    {
                        "supplier": o["supplier"],
                        "unitPrice": o["unitPrice"],
                        "quotedLeadDays": o["quotedLeadDays"],
                        "expectedDelayDays": o["expectedDelayDays"],
                        "failureRate": rnd(o["failureRate"], 4),
                        "effectiveCost": o["effectiveCost"],
                    }
                    for o in options
                ],
            }
        )

    to_order = [r for r in out_rows if r["action"] == "order"]
    excess = [r for r in out_rows if r["action"] == "excess"]
    return {
        "metrics": {
            "serviceLevel": SERVICE_LEVEL,
            "holdingRate": rnd(holding_rate, 4),
            "inflation": rnd(inp["inflation"], 2),
            "reviewMonths": REVIEW_MONTHS,
        },
        "output": {
            "rows": out_rows,
            "toOrder": len(to_order),
            "spend": rnd(sum(r["spend"] for r in to_order)),
            "excess": len(excess),
            "excessValue": rnd(sum(r["excessValue"] for r in excess)),
        },
    }
