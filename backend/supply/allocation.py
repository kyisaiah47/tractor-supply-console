"""Part allocation: walks every open customer order in the order its build needs parts, and
gives each one stock on hand plus inbound supply orders expected to have arrived by then.

An order whose parts are all allocated is "covered"; otherwise it is "short" by the parts
listed. This is recomputed on every read, so a newly placed supply order shows immediately.
"""

from .catalog import BUILD_DAYS
from .config import as_of
from .dates import add_days, quarter_of
from .db import rows
from .models import latest_runs
from .prng import js_round


def allocate() -> dict[int, dict]:
    orders = rows(
        """SELECT o.id, o.tractor_model, o.quantity, o.requested_date, pp.scheduled_start
             FROM customer_orders o LEFT JOIN production_pipeline pp ON pp.customer_order_id = o.id
            WHERE o.status IN ('open','in_production')"""
    )
    bom = rows("SELECT sku, tractor_model, category, qty_per_tractor FROM parts")
    on_hand = rows("SELECT sku, SUM(on_hand)::int AS units FROM inventory GROUP BY 1")
    inbound = rows(
        "SELECT sku, supplier, quantity, status, date_ordered, promised_date FROM supply_orders WHERE status IN ('queued','placed')"
    )
    runs = latest_runs()

    quarter = quarter_of(as_of())
    delay_by_supplier = {s["supplier"]: s["byQuarter"][quarter] for s in (runs["supplier_delay"]["output"]["suppliers"] if runs else [])}
    arrivals: dict[str, list[tuple[str, int]]] = {}
    for s in inbound:
        if s["status"] == "placed" and s["promised_date"]:
            date = add_days(s["promised_date"], js_round(delay_by_supplier.get(s["supplier"] or "", 14)))
        else:
            date = add_days(s["date_ordered"], 45)
        arrivals.setdefault(s["sku"], []).append((date, s["quantity"]))
    for a in arrivals.values():
        a.sort(key=lambda x: x[0])

    bom_by_model: dict[str, list[dict]] = {}
    for b in bom:
        bom_by_model.setdefault(b["tractor_model"], []).append(b)

    need = sorted(
        ({**o, "needDate": o["scheduled_start"] or add_days(o["requested_date"], -(BUILD_DAYS[o["tractor_model"]] + 3))} for o in orders),
        key=lambda o: (o["needDate"], o["id"]),
    )

    stock = {o["sku"]: o["units"] for o in on_hand}
    cursor: dict[str, int] = {}
    out: dict[int, dict] = {}
    for o in need:
        shortfalls = []
        for b in bom_by_model.get(o["tractor_model"], []):
            arr = arrivals.get(b["sku"], [])
            i = cursor.get(b["sku"], 0)
            avail = stock.get(b["sku"], 0)
            while i < len(arr) and arr[i][0] <= o["needDate"]:
                avail += arr[i][1]
                i += 1
            cursor[b["sku"]] = i
            want = o["quantity"] * b["qty_per_tractor"]
            if avail >= want:
                stock[b["sku"]] = avail - want
            else:
                stock[b["sku"]] = 0
                shortfalls.append({"sku": b["sku"], "category": b["category"], "short": want - max(0, avail)})
        out[o["id"]] = {"needDate": o["needDate"], "status": "short" if shortfalls else "covered", "shortfalls": shortfalls}
    return out
