"""Reads behind the Orders page, the headline counts and the supply page."""

from .allocation import allocate
from .config import as_of
from .dates import add_months_day
from .db import one, rows
from .models import latest_runs


def horizon_end(months: int) -> str:
    return add_months_day(as_of(), months)


def list_orders(
    tab: str,
    months: int,
    model: str | None = None,
    warehouse: str | None = None,
    parts: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> dict:
    today = as_of()
    months = max(1, min(3 if tab == "pipeline" else 12, months))
    end = horizon_end(months)
    where = ["o.status IN ('open','in_production')", "o.requested_date >= :as_of", "o.requested_date < :end"]
    if tab == "pipeline":
        where.append("pp.customer_order_id IS NOT NULL")
    found = rows(
        f"""SELECT o.id, c.name AS customer, c.id AS customer_id, o.tractor_model, o.quantity, o.warehouse, o.ordered_at,
                   o.requested_date, o.promised_date, o.status, pp.stage, pp.scheduled_start
              FROM customer_orders o
              JOIN customers c ON c.id = o.customer_id
              LEFT JOIN production_pipeline pp ON pp.customer_order_id = o.id
             WHERE {" AND ".join(where)}
             ORDER BY o.requested_date, o.id""",
        {"as_of": today, "end": end},
    )
    alloc = allocate()
    all_rows = []
    for r in found:
        a = alloc.get(r["id"])
        all_rows.append(
            {
                "id": r["id"],
                "customer": r["customer"],
                "customerId": r["customer_id"],
                "tractorModel": r["tractor_model"],
                "quantity": r["quantity"],
                "warehouse": r["warehouse"],
                "orderedAt": r["ordered_at"],
                "requestedDate": r["requested_date"],
                "promisedDate": r["promised_date"],
                "status": r["status"],
                "stage": r["stage"],
                "scheduledStart": r["scheduled_start"],
                "needDate": a["needDate"] if a else r["requested_date"],
                "parts": a["status"] if a else "covered",
                "shortfalls": a["shortfalls"] if a else [],
            }
        )

    # Facets are counted before the chip filters so every chip shows what pressing it would give.
    def facet(key: str, rs: list[dict]) -> dict:
        m: dict[str, dict] = {}
        for r in rs:
            v = m.setdefault(str(r[key]), {"orders": 0, "tractors": 0})
            v["orders"] += 1
            v["tractors"] += r["quantity"]
        return dict(sorted(m.items()))

    by_model = [r for r in all_rows if (not warehouse or r["warehouse"] == warehouse) and (not parts or r["parts"] == parts)]
    by_warehouse = [r for r in all_rows if (not model or r["tractorModel"] == model) and (not parts or r["parts"] == parts)]
    by_parts = [r for r in all_rows if (not model or r["tractorModel"] == model) and (not warehouse or r["warehouse"] == warehouse)]
    filtered = [r for r in by_parts if not parts or r["parts"] == parts]

    limit = min(500, limit)
    return {
        "tab": tab,
        "months": months,
        "asOf": today,
        "through": end,
        "totals": {
            "orders": len(filtered),
            "tractors": sum(r["quantity"] for r in filtered),
            "short": sum(1 for r in filtered if r["parts"] == "short"),
        },
        "facets": {
            "model": facet("tractorModel", by_model),
            "warehouse": facet("warehouse", by_warehouse),
            "parts": facet("parts", by_parts),
        },
        "rows": filtered[offset : offset + limit],
    }


def overview() -> dict:
    today = as_of()
    book = one(
        """SELECT COUNT(*)::int AS orders, COALESCE(SUM(quantity),0)::int AS tractors FROM customer_orders
            WHERE status IN ('open','in_production') AND requested_date >= :as_of AND requested_date < :end""",
        {"as_of": today, "end": horizon_end(12)},
    )
    pipeline = one(
        """SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.quantity),0)::int AS tractors
             FROM production_pipeline pp JOIN customer_orders o ON o.id = pp.customer_order_id"""
    )
    supply = one(
        """SELECT COUNT(*) FILTER (WHERE status='placed')::int AS placed, COUNT(*) FILTER (WHERE status='queued')::int AS queued
             FROM supply_orders"""
    )
    jobs = one(
        """SELECT (SELECT COUNT(*) FROM supply_jobs WHERE status IN ('pending','running'))::int AS pending,
                  (SELECT MAX(seen_at) FROM worker_heartbeats) AS worker_seen"""
    )
    last_order = one("SELECT MAX(ordered_at)::text AS at FROM customer_orders")
    runs = latest_runs()
    book, pipeline, supply, jobs = book or {}, pipeline or {}, supply or {}, jobs or {}
    return {
        "asOf": today,
        "backlogOrders": book.get("orders", 0),
        "backlogTractors": book.get("tractors", 0),
        "pipelineOrders": pipeline.get("orders", 0),
        "pipelineTractors": pipeline.get("tractors", 0),
        "supplyPlaced": supply.get("placed", 0),
        "supplyQueued": supply.get("queued", 0),
        "jobsPending": jobs.get("pending", 0),
        "workerSeen": jobs.get("worker_seen"),
        "lateRisk": runs["supplier_delay"]["output"]["atRisk"] if runs else 0,
        "partsToOrder": runs["inventory_strategy"]["output"]["toOrder"] if runs else 0,
        "elevatedFailures": len(runs["component_failure"]["output"]["elevated"]) if runs else 0,
        "forecast12": runs["demand"]["output"]["total12"] if runs else 0,
        "modelsRanAt": runs["ranAt"] if runs else None,
        "lastOrderAt": (last_order or {}).get("at"),
    }


def supply_summary() -> dict:
    """Counts for the supply page header: orders placed from the console, and history before the planning date."""
    counts = rows("SELECT status, COUNT(*)::int AS n FROM supply_orders WHERE source <> 'history' GROUP BY 1")
    history = one(
        """SELECT COUNT(*) FILTER (WHERE status='placed')::int AS placed, COUNT(*) FILTER (WHERE status='fulfilled')::int AS fulfilled
             FROM supply_orders WHERE source = 'history'"""
    )
    return {"console": {r["status"]: r["n"] for r in counts}, "history": history or {"placed": 0, "fulfilled": 0}}
