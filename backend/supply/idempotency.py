"""Idempotency keys for POST /api/orders and POST /api/supply-orders.

The client sends an Idempotency-Key header, one UUID per user action. The first request with
a key inserts it into idempotency_keys (a unique column) in the same transaction that writes
the orders, and stores the response text there. A repeat with the same key and the same body
gets those exact bytes back and writes nothing. A concurrent repeat waits on the unique index until the
first commits. A key reused with a different body gets 422. Failed requests store nothing, so
the client can retry with the same key.
"""

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass

from fastapi.encoders import jsonable_encoder
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import session
from .orm import IdempotencyKey


@dataclass
class Outcome:
    status: int
    body: dict
    replayed: bool = False
    raw: str | None = None  # the exact response text, when it was stored or replayed


class _Abort(Exception):
    def __init__(self, outcome: Outcome) -> None:
        self.outcome = outcome


def request_hash(route: str, payload: dict) -> str:
    return hashlib.sha256(json.dumps({"route": route, "body": payload}, sort_keys=True).encode()).hexdigest()


def run_idempotent(key: str | None, route: str, payload: dict, handler: Callable[[Session], Outcome]) -> Outcome:
    try:
        with session() as s:
            if not key:
                out = handler(s)
                if out.status >= 300:
                    raise _Abort(out)
                return out
            h = request_hash(route, payload)
            claimed = s.execute(
                text(
                    """INSERT INTO idempotency_keys (key, route, request_hash, status_code, response)
                       VALUES (:k, :r, :h, 0, '') ON CONFLICT (key) DO NOTHING RETURNING key"""
                ),
                {"k": key, "r": route, "h": h},
            ).first()
            if not claimed:
                prior = s.get(IdempotencyKey, key)
                assert prior is not None
                if prior.request_hash != h:
                    raise _Abort(Outcome(422, {"error": "This Idempotency-Key was already used for a different request."}))
                return Outcome(prior.status_code, {}, replayed=True, raw=prior.response)
            out = handler(s)
            if out.status >= 300:
                raise _Abort(out)
            out.raw = json.dumps(jsonable_encoder(out.body))
            s.execute(
                text("UPDATE idempotency_keys SET status_code = :c, response = :b WHERE key = :k"),
                {"c": out.status, "b": out.raw, "k": key},
            )
            return out
    except _Abort as a:
        return a.outcome
