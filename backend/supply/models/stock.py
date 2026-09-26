"""When each part runs out if nothing new arrives: on-hand stock consumed by the production
pipeline in scheduled-start order. This is the need-by date for open supply orders."""

from ..db import rows


def load_stockout() -> list[dict]:
    on_hand = rows("SELECT sku, SUM(on_hand)::int AS units FROM inventory GROUP BY 1")
    demand = rows(
        """SELECT p.sku, pp.scheduled_start, (o.quantity * p.qty_per_tractor)::int AS units
             FROM production_pipeline pp
             JOIN customer_orders o ON o.id = pp.customer_order_id
             JOIN parts p ON p.tractor_model = o.tractor_model
            ORDER BY p.sku, pp.scheduled_start, o.id"""
    )
    return compute_stockout(on_hand, demand)


def compute_stockout(on_hand: list[dict], demand: list[dict]) -> list[dict]:
    stock = {o["sku"]: o["units"] for o in on_hand}
    used: dict[str, int] = {}
    out: dict[str, str | None] = dict.fromkeys(stock)
    for d in demand:
        if out.get(d["sku"]):
            continue
        u = used.get(d["sku"], 0) + d["units"]
        used[d["sku"]] = u
        if u > stock.get(d["sku"], 0):
            out[d["sku"]] = d["scheduled_start"]
    return [{"sku": sku, "date": date} for sku, date in out.items()]
