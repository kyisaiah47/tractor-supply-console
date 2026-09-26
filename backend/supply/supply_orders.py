"""Creating supply orders. Every path (Order all selected on the Orders page, a reorder
recommendation, the planning assistant after the user confirms, a direct API call) ends here:
rows are written as 'queued' with one job each, and the worker places them with a supplier."""

import math
from datetime import UTC, date, datetime

from sqlalchemy.orm import Session

from .allocation import allocate
from .config import as_of
from .db import rows
from .models import latest_runs
from .orm import SupplyJob, SupplyOrder

SOURCE_LABEL = {
    "order_form": "the order form",
    "selected_orders": "Order all selected",
    "recommendation": "a reorder recommendation",
    "chatbot": "the planning assistant",
    "api": "an integration",
}


class UnknownPart(ValueError):
    pass


def lines_for_customer_orders(ids: list[int]) -> dict:
    """Supply lines that would cover the part shortfalls of the given customer orders."""
    alloc = allocate()
    orders = rows("SELECT id, warehouse FROM customer_orders WHERE id = ANY(:ids)", {"ids": ids})
    runs = latest_runs()
    rec = {r["sku"]: r for r in (runs["inventory_strategy"]["output"]["rows"] if runs else [])}
    wh_of = {o["id"]: o["warehouse"] for o in orders}
    merged: dict[str, dict] = {}
    covered = 0
    for oid in ids:
        a = alloc.get(oid)
        if not a:
            continue
        if not a["shortfalls"]:
            covered += 1
        for s in a["shortfalls"]:
            wh = wh_of.get(oid, "IL")
            key = f"{s['sku']}|{wh}"
            cur = merged.setdefault(
                key,
                {"sku": s["sku"], "quantity": 0, "warehouse": wh, "supplier": rec.get(s["sku"], {}).get("supplier"), "forOrders": []},
            )
            cur["quantity"] += s["short"]
            cur["forOrders"].append(oid)
    lines = []
    for line in merged.values():
        r = rec.get(line["sku"])
        fr = next((o["failureRate"] for o in (r["options"] if r else []) if o["supplier"] == line["supplier"]), 0.05)
        many = len(line["forOrders"]) > 1
        lines.append(
            {
                **line,
                "quantity": math.ceil(line["quantity"] / (1 - fr)),
                "unitPrice": r["unitPrice"] if r else None,
                "note": f"Covers shortfall for customer order{'s' if many else ''} {', '.join(map(str, line['forOrders']))}, "
                f"plus {fr * 100:.1f}% for expected failures.",
            }
        )
    return {"lines": lines, "covered": covered, "requested": len(ids)}


def create_supply_orders(s: Session, lines: list[dict], source: str) -> list[dict]:
    """Write each line as a queued supply order with one job, inside the caller's transaction."""
    if not lines:
        return []
    known = {r["sku"] for r in rows("SELECT sku FROM parts WHERE sku = ANY(:skus)", {"skus": [x["sku"] for x in lines]}, conn=s)}
    created = []
    now = datetime.now(UTC).isoformat()
    for line in lines:
        if line["sku"] not in known:
            raise UnknownPart(f"Unknown part {line['sku']}")
        note = line.get("note") or (f"Preferred supplier: {line['supplier']}" if line.get("supplier") else None)
        so = SupplyOrder(
            sku=line["sku"],
            supplier=None,
            warehouse=line.get("warehouse") or "IL",
            quantity=line["quantity"],
            customer_order_id=line.get("customerOrderId"),
            date_ordered=date.fromisoformat(as_of()),
            status="queued",
            source=source,
            note=note,
        )
        s.add(so)
        s.flush()
        job = SupplyJob(
            supply_order_id=so.id,
            log=[{"at": now, "msg": f"Ordered from {SOURCE_LABEL[source]}. Asking suppliers for quotes."}],
        )
        s.add(job)
        s.flush()
        created.append({"id": so.id, "jobId": job.id, "sku": line["sku"], "quantity": line["quantity"]})
    return created
