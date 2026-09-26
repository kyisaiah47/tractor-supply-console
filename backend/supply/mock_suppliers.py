"""Stand-ins for the suppliers' own ordering APIs (the whiteboard's "Home Depot API").

Each supplier answers a quote with price, stock and lead time, and accepts an order. Answers
are deterministic per supplier and part, and about 1 call in 12 fails with a 503 so the
worker's retry path is exercised.

Placing an order honours an Idempotency-Key header the way a real supplier API does: the
supplier stores the key with the result, and a repeat with the same key gets the stored result
back instead of a second order. mock_supplier_orders is that store.

MOCK_SUPPLIER_LATENCY_MS makes the order call take that long before the supplier records the
order, like a slow supplier. It is 0 unless set; it gives the kill test a window to stop the
worker while a supplier call is in flight.
"""

import json
import os
import time
import uuid

from sqlalchemy import text

from .catalog import SUPPLIERS
from .config import as_of
from .dates import add_days
from .db import engine, one, rows
from .prng import js_round


class SupplierUnavailable(Exception):
    pass


class KeyReused(Exception):
    pass


def _hash(s: str) -> float:
    """FNV-1a, 32-bit, scaled to [0, 1)."""
    h = 2166136261
    for ch in s:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h / 4294967296


def supplier_by_slug(slug: str) -> dict | None:
    return next((s for s in SUPPLIERS if s["slug"] == slug.lower()), None)


def quote(slug: str, sku: str, quantity: int, attempt_salt: str = "") -> dict | None:
    s = supplier_by_slug(slug)
    if not s:
        return None
    if _hash(f"{slug}|{sku}|{attempt_salt}|{int(time.time() * 1000) >> 12}") < 0.08:
        raise SupplierUnavailable(f"{s['code']} API returned 503")
    row = one("SELECT unit_price, nominal_lead_days FROM part_suppliers WHERE sku=:sku AND supplier=:s", {"sku": sku, "s": s["code"]})
    if not row:
        return None
    available = js_round(80 + _hash(f"{slug}|{sku}|stock") * 900)
    lead_days = row["nominal_lead_days"] + (0 if available >= quantity else 14)
    return {
        "supplier": s["code"],
        "sku": sku,
        "quantity": quantity,
        "available": available,
        "unitPrice": js_round(row["unit_price"] * (0.97 + _hash(f"{slug}|{sku}|px") * 0.06) * 100) / 100,
        "leadDays": lead_days,
        "promisedDate": add_days(as_of(), lead_days),
        "canFill": available >= quantity,
    }


def place_order(slug: str, sku: str, quantity: int, idempotency_key: str | None) -> tuple[str | None, bool]:
    """Place an order. Returns (response JSON text, replayed). A known key replays the stored text."""
    s = supplier_by_slug(slug)
    if not s:
        return None, False
    key = idempotency_key or f"unkeyed-{uuid.uuid4()}"
    stored = one("SELECT supplier, sku, quantity, response FROM mock_supplier_orders WHERE idempotency_key = :k", {"k": key})
    if stored:
        if (stored["supplier"], stored["sku"], stored["quantity"]) != (s["code"], sku, quantity):
            raise KeyReused(f"Idempotency-Key {key} was already used for a different order")
        return stored["response"], True
    qt = quote(slug, sku, quantity, "order")
    if not qt:
        return None, False
    time.sleep(int(os.environ.get("MOCK_SUPPLIER_LATENCY_MS") or 0) / 1000)
    ref = f"{slug.upper()}-{int(_hash(f'{slug}|{sku}|{quantity}|{time.time_ns()}') * 1e8):08d}"
    result = json.dumps({**qt, "externalRef": ref, "accepted": True})
    with engine().begin() as c:
        inserted = c.execute(
            text(
                """INSERT INTO mock_supplier_orders (idempotency_key, supplier, sku, quantity, response)
                   VALUES (:k, :s, :sku, :q, :r) ON CONFLICT (idempotency_key) DO NOTHING RETURNING 1"""
            ),
            {"k": key, "s": s["code"], "sku": sku, "q": quantity, "r": result},
        ).first()
    if not inserted:
        # Another request with this key won the race: return what it stored.
        return place_order(slug, sku, quantity, key)
    return result, False


def supplier_slugs_for_sku(sku: str) -> list[str]:
    codes = [r["supplier"] for r in rows("SELECT supplier FROM part_suppliers WHERE sku=:sku ORDER BY supplier", {"sku": sku})]
    return [s["slug"] for s in SUPPLIERS if s["code"] in codes]
