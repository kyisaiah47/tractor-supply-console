"""Generates the operational dataset from the provided market dataset.

  input : data/market_signals.csv (10,000 rows, 2020-01-01 .. 2023-12-30, provided)
  output: data/generated/*.csv   (customers, orders, pipeline, supply orders, lots, stock)
          data/generated/meta.json (the planning date and the date shift)

The app runs on today's date. Every dataset date is moved forward by the same number of
days so the dataset's last row lands on yesterday; the CSV itself is never changed, and the
seed keeps each row's original date beside the shifted one. Orders before today are history;
orders after today are the open order book. Set APP_AS_OF=YYYY-MM-DD to pin a different day.

The provided rows are market-level signals. This module turns them into the tables on the
whiteboard. Our order book is 1% of market demand for each model and month, shaped by a
farm-year seasonality and 6% annual growth. Supplier delays are sampled from the dataset's
own Supplier_Delay_Days, and lot failure rates from its Component_Failure_Rate.

A few effects are planted on purpose (supply/planted.py). The dataset alone carries none:
every supplier averages about 14.7 days late and every model fails about 5%. The model tests
check that each planted effect is recovered, which is how we know the models find real signal.

Deterministic: the same planning date gives the same files. Sums are plain left-to-right loops
and rounding is half-up, so the output matches the original TypeScript generator byte for byte.
"""

import csv
import json
import math
from datetime import date
from pathlib import Path

from . import planted
from .catalog import PART_CATEGORIES, TRACTOR_MODELS, WAREHOUSE_CODES, build_parts, sku_for
from .config import DATA_DIR, GENERATED_DIR
from .dates import (
    add_days,
    add_months,
    add_months_day,
    days_in_month,
    diff_days,
    month_index,
    month_range,
)
from .prng import Rng, binomial, js_round, normal, pick, poisson, rand_int

SEED = 20240101

PREFIX = [
    "Prairie", "Riverbend", "Heartland", "Golden Valley", "Cedar Creek", "Big Sky", "Red River", "Lone Star",
    "Sunbelt", "Great Lakes", "Harvest Moon", "Blue Ridge", "Delta", "Pioneer", "Frontier", "Summit",
    "Clearwater", "Oak Hollow", "Twin Rivers", "Maple Ridge", "Sandhill", "Mesa", "Bayou", "Finger Lakes",
    "Central Valley", "High Plains", "Gulf Coast", "Hudson Valley", "Sierra", "Palmetto", "Cotton Belt", "Wabash",
]  # fmt: skip
SUFFIX = ["Implement", "Equipment", "Ag Supply", "Tractor", "Farm Machinery", "Ag Partners"]
ENDING = ["Co.", "LLC", "Inc.", "Group"]
SEGMENTS = ["dealer", "dealer", "dealer", "fleet", "co-op"]
ORDER_SIZE = {"TX-100": (1, 8), "TX-200": (1, 6), "TX-300": (1, 4), "TX-400": (1, 3), "TX-500": (1, 2)}
SUPPLIER_WEIGHTS = [0.55, 0.3, 0.15]
STAGES = ["receiving", "receiving", "assembly", "assembly", "assembly", "field", "field"]


def _sum(xs) -> float:
    total = 0
    for x in xs:
        total += x
    return total


def _mean(xs: list[float]) -> float:
    return _sum(xs) / len(xs)


def _cell(v) -> str:
    """A CSV cell written the way JavaScript's String() writes it: 4480.0 is '4480'."""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def generate(as_of: str | None = None, out_dir: Path | None = None) -> dict:
    as_of = as_of or date.today().isoformat()
    out = out_dir or GENERATED_DIR
    rng = Rng(SEED)

    with open(DATA_DIR / "market_signals.csv", newline="") as f:
        signals = [r for r in csv.DictReader(f) if any(r.values())]

    # ---- the date shift -------------------------------------------------------------------
    dates = sorted(r["Date"] for r in signals)
    dataset_first, dataset_last = dates[0], dates[-1]
    shift_days = diff_days(as_of, dataset_last) - 1
    shifted_first = add_days(dataset_first, shift_days)
    shifted_last = add_days(dataset_last, shift_days)
    cur = as_of[:7]
    start = add_months(shifted_first[:7], 1)  # first full month of history
    last_full = add_months(cur, -1)
    end = add_months(cur, 11)

    def covered_days(ym: str) -> int:
        first = f"{ym}-01"
        last = f"{ym}-{days_in_month(ym):02d}"
        lo = first if first > shifted_first else shifted_first
        hi = last if last < shifted_last else shifted_last
        return 0 if lo > hi else diff_days(hi, lo) + 1

    # ---- aggregate the provided dataset (on shifted dates) ----------------------------------
    market_demand: dict[str, float] = {}
    failure_by_model_month: dict[str, list[float]] = {}
    delays_by_supplier_month: dict[str, list[float]] = {}
    delays_by_supplier: dict[str, list[float]] = {}
    latest_inventory: dict[str, tuple[str, int]] = {}
    for r in signals:
        d = add_days(r["Date"], shift_days)
        ym = d[:7]
        k = f"{r['Tractor_Model']}|{ym}"
        market_demand[k] = market_demand.get(k, 0) + float(r["Demand_Units"])
        failure_by_model_month.setdefault(k, []).append(float(r["Component_Failure_Rate"]))
        sk = f"{r['Supplier']}|{ym}"
        delays_by_supplier_month.setdefault(sk, []).append(float(r["Supplier_Delay_Days"]))
        delays_by_supplier.setdefault(r["Supplier"], []).append(float(r["Supplier_Delay_Days"]))
        ik = f"{r['Tractor_Model']}|{r['Warehouse_Location']}"
        prev = latest_inventory.get(ik)
        if prev is None or d > prev[0]:
            latest_inventory[ik] = (d, int(r["Inventory_Levels"]))

    def market_rate(model: str, ym: str) -> float:
        """Market demand per model per month, as a full-month rate so partial months count."""
        days = covered_days(ym)
        return market_demand.get(f"{model}|{ym}", 0) / days * days_in_month(ym) if days else 0

    trailing_rate = {
        m["code"]: _mean([market_rate(m["code"], ym) for ym in month_range(add_months(last_full, -11), last_full)]) for m in TRACTOR_MODELS
    }

    def sample_delay(supplier: str, ym: str) -> int:
        pool = delays_by_supplier_month.get(f"{supplier}|{ym}") or delays_by_supplier[supplier]
        d = pool[math.floor(rng() * len(pool))]
        mult = planted.SUPPLIER_DELAY.get(supplier)
        if isinstance(mult, float):
            d *= mult
        elif isinstance(mult, dict):
            d *= mult["q4"] if month_index(ym) >= 9 else 1
        return max(0, js_round(d))

    def failure_rate(model: str, category: str, supplier: str, ym: str) -> float:
        pool = failure_by_model_month.get(f"{model}|{ym}")
        p = _mean(pool) if pool else 0.05
        for f in planted.FAILURE:
            if f["category"] == category and (not f["supplier"] or f["supplier"] == supplier) and (not f["model"] or f["model"] == model):
                p *= f["multiplier"]
        return min(p, 0.6)

    y0, m0 = int(start[:4]), int(start[5:7])

    def growth(ym: str) -> float:
        years = int(ym[:4]) - y0 + (int(ym[5:7]) - m0) / 12
        return math.pow(1 + planted.GROWTH_PER_YEAR, years)

    # ---- customers ----------------------------------------------------------------------
    customers: list[dict] = []
    used_names: set[str] = set()
    while len(customers) < 64:
        name = f"{pick(rng, PREFIX)} {pick(rng, SUFFIX)} {pick(rng, ENDING)}"
        if name in used_names:
            continue
        used_names.add(name)
        customers.append(
            {
                "id": len(customers) + 1,
                "name": name,
                "state": pick(rng, WAREHOUSE_CODES),
                "segment": pick(rng, SEGMENTS),
                "since": add_days("2012-01-01", rand_int(rng, 0, 2800)),
                "weight": 0.3 + rng() * 2.2,
            }
        )
    total_weight = _sum(c["weight"] for c in customers)

    def pick_customer() -> dict:
        r = rng() * total_weight
        for c in customers:
            r -= c["weight"]
            if r <= 0:
                return c
        return customers[-1]

    # ---- customer orders ----------------------------------------------------------------
    orders: list[dict] = []
    units_by_model_month: dict[str, int] = {}
    expected_by_model_month: dict[str, float] = {}
    cy, cm = int(cur[:4]), int(cur[5:7])

    def months_ahead(ym: str) -> int:
        return (int(ym[:4]) - cy) * 12 + (int(ym[5:7]) - cm)

    def emit_orders(model: str, ym: str, units: int) -> None:
        """Draws orders for one model and month. Orders requested before today are history and
        were delivered. Orders from today on are the open book; a month further out is less
        booked, so each future order is kept with that month's booking probability."""
        left = units
        booked = max(planted.BOOKED_FLOOR, 1 - planted.BOOKED_DECAY_PER_MONTH * max(0, months_ahead(ym)))
        while left > 0:
            lo, hi = ORDER_SIZE[model]
            q = min(left, rand_int(rng, lo, hi))
            left -= q
            c = pick_customer()
            requested = f"{ym}-{rand_int(rng, 1, days_in_month(ym)):02d}"
            future = requested >= as_of
            ordered = add_days(requested, -rand_int(rng, 25, 170))
            warehouse = c["state"] if rng() < 0.82 else pick(rng, WAREHOUSE_CODES)
            keep = rng()
            if future and keep > booked:
                continue
            if ordered >= as_of:
                ordered = add_days(as_of, -rand_int(rng, 1, 20))
            o = {
                "id": len(orders) + 1,
                "customer_id": c["id"],
                "tractor_model": model,
                "quantity": q,
                "warehouse": warehouse,
                "ordered_at": ordered,
                "requested_date": requested,
                "promised_date": "",
                "fulfilled_date": "",
                "status": "open",
            }
            if not future:
                o["promised_date"] = add_days(requested, rand_int(rng, 0, 3))
                done = add_days(o["promised_date"], max(-5, js_round(normal(rng, 2, 5))))
                if done >= as_of:
                    done = add_days(as_of, -1)
                if done < ordered:
                    done = requested
                o["fulfilled_date"] = done
                o["status"] = "fulfilled"
            orders.append(o)
            k = f"{model}|{ym}"
            units_by_model_month[k] = units_by_model_month.get(k, 0) + q

    # Market data exists up to yesterday. Months after it use the trailing 12-month market rate.
    for ym in month_range(start, end):
        for m in TRACTOR_MODELS:
            use_market = ym < cur or (ym == cur and covered_days(cur) >= 10)
            rate = market_rate(m["code"], ym) if use_market else trailing_rate[m["code"]]
            expected = rate * planted.MARKET_SHARE * planted.SEASONAL[month_index(ym)] * growth(ym)
            expected_by_model_month[f"{m['code']}|{ym}"] = expected
            emit_orders(m["code"], ym, poisson(rng, expected))

    # ---- production pipeline: open orders due in the first three months --------------------
    build_days = {m["code"]: m["buildDays"] for m in TRACTOR_MODELS}
    pipeline: list[dict] = []
    pipeline_horizon = add_months_day(as_of, 3)
    for o in orders:
        if o["status"] != "open" or o["requested_date"] >= pipeline_horizon:
            continue
        finish = add_days(o["requested_date"], -3)
        start_day = add_days(finish, -build_days[o["tractor_model"]])
        stage = "scheduled"
        entered = add_days(start_day, -14)
        if finish < add_days(as_of, 2):
            stage = "qa"
            entered = add_days(finish, -1)
        elif start_day <= as_of:
            stage = "assembly"
            entered = start_day
        if entered >= as_of:
            entered = add_days(as_of, -1)
        o["status"] = "in_production"
        o["promised_date"] = add_days(finish, 2)
        pipeline.append(
            {
                "customer_order_id": o["id"],
                "stage": stage,
                "stage_entered_at": entered,
                "scheduled_start": start_day,
                "scheduled_finish": finish,
            }
        )

    # ---- parts, supply orders, lots ------------------------------------------------------
    parts, part_suppliers = build_parts()
    suppliers_by_sku: dict[str, list[dict]] = {}
    for ps in part_suppliers:
        suppliers_by_sku.setdefault(ps["sku"], []).append(ps)

    supply_orders: list[dict] = []
    lots: list[dict] = []
    # Orders are placed a lead time ahead of the build month they cover.
    for ym in month_range(start, add_months(cur, 2)):
        for m in TRACTOR_MODELS:
            key = f"{m['code']}|{ym}"
            units = units_by_model_month.get(key, 0) if ym < cur else js_round(expected_by_model_month.get(key, 0))
            if not units:
                continue
            for cat in PART_CATEGORIES:
                sku = sku_for(cat["key"], m["code"])
                opts = suppliers_by_sku[sku]
                r = rng()
                choice = opts[-1]
                for i in range(len(opts)):
                    r -= SUPPLIER_WEIGHTS[i] if i < len(SUPPLIER_WEIGHTS) else 0
                    if r <= 0:
                        choice = opts[i]
                        break
                need = f"{ym}-01"
                date_ordered = add_days(need, -(choice["nominal_lead_days"] + rand_int(rng, 5, 15)))
                if date_ordered >= as_of:
                    continue
                qty = max(1, js_round(units * (1 + normal(rng, 0.03, 0.06))))
                promised = add_days(date_ordered, choice["nominal_lead_days"])
                delay = sample_delay(choice["supplier"], date_ordered[:7])
                arrives = add_days(promised, delay)
                fulfilled = arrives < as_of
                so = {
                    "id": len(supply_orders) + 1,
                    "sku": sku,
                    "supplier": choice["supplier"],
                    "warehouse": pick(rng, WAREHOUSE_CODES),
                    "quantity": qty,
                    "unit_price": choice["unit_price"],
                    "date_ordered": date_ordered,
                    "promised_date": promised,
                    "fulfilled_date": arrives if fulfilled else "",
                    "status": "fulfilled" if fulfilled else "placed",
                }
                supply_orders.append(so)
                if fulfilled:
                    p = failure_rate(m["code"], cat["key"], choice["supplier"], arrives[:7])
                    broken_at = add_days(arrives, rand_int(rng, 0, 120))
                    broken = binomial(rng, qty, p) if broken_at < as_of else 0
                    lots.append(
                        {
                            "id": len(lots) + 1,
                            "sku": sku,
                            "supplier": choice["supplier"],
                            "warehouse": so["warehouse"],
                            "supply_order_id": so["id"],
                            "quantity": qty,
                            "received_date": arrives,
                            "broken_quantity": broken,
                            "broken_date": broken_at if broken else "",
                            "broken_stage": pick(rng, STAGES) if broken else "",
                        }
                    )

    # ---- on-hand stock at the as-of date -------------------------------------------------
    # Seeded from the dataset's latest Inventory_Levels per model and warehouse, scaled to our share.
    inventory: list[dict] = []
    for p in parts:
        depth = 0.55 + rng() * 1.6
        for wh in WAREHOUSE_CODES:
            lvl = latest_inventory.get(f"{p['tractor_model']}|{wh}", ("", 1000))[1]
            inventory.append({"sku": p["sku"], "warehouse": wh, "on_hand": max(0, js_round(lvl * planted.MARKET_SHARE * depth))})

    # ---- write --------------------------------------------------------------------------
    out.mkdir(parents=True, exist_ok=True)

    def write_csv(name: str, rows: list[dict]) -> int:
        cols = list(rows[0].keys())
        with open(out / f"{name}.csv", "w", newline="") as f:
            w = csv.writer(f, lineterminator="\n")
            w.writerow(cols)
            for r in rows:
                w.writerow([_cell(r[c]) for c in cols])
        return len(rows)

    counts = {
        "customers": write_csv("customers", [{k: c[k] for k in ("id", "name", "state", "segment", "since")} for c in customers]),
        "customer_orders": write_csv("customer_orders", orders),
        "production_pipeline": write_csv("production_pipeline", pipeline),
        "parts": write_csv("parts", parts),
        "part_suppliers": write_csv("part_suppliers", part_suppliers),
        "supply_orders": write_csv("supply_orders", supply_orders),
        "inventory_parts": write_csv("inventory_parts", lots),
        "inventory": write_csv("inventory", inventory),
    }
    meta = {
        "asOf": as_of,
        "shiftDays": shift_days,
        "datasetFirst": dataset_first,
        "datasetLast": dataset_last,
        "shiftedFirst": shifted_first,
        "shiftedLast": shifted_last,
        "historyStart": f"{start}-01",
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")

    open_orders = [o for o in orders if o["status"] != "fulfilled"]
    print(f"generated from {len(signals)} market signal rows")
    print(f"  planning date        {as_of} (dataset dates moved forward {shift_days} days)")
    for k, v in counts.items():
        print(f"  {k:<20} {v}")
    print(f"  open orders          {len(open_orders)} ({sum(o['quantity'] for o in open_orders)} tractors)")
    print(f"  history              {start}-01 to {add_days(as_of, -1)}")
    return meta
