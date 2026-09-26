"""Supply order worker.

Claims queued jobs from Postgres with FOR UPDATE SKIP LOCKED, asks every supplier that makes
the part for a quote over HTTP, picks the lowest cost after the failure and delay models'
adjustments, places the order, and records every step in the job's log.

Each job moves through three stages, saved on the job before the next step starts:

  quoted   the chosen supplier, its quote and the supplier idempotency key are saved
  placing  the order is about to be sent to the supplier
  placed   the supplier accepted it and the supply order is updated

A retry skips quoting and reuses the saved supplier, so it cannot order from a different one.
The supplier call carries Idempotency-Key: supply-order-<id>; the supplier replays its stored
result on a repeat, so a job that died after the supplier accepted it is not ordered twice.

A claim holds a lease (locked_until). A worker that dies leaves the job 'running' with a lease
that runs out; the next claim takes it back. The lease is longer than a job's HTTP timeouts
added together. Every write checks the worker still holds the lease for that attempt, so a
worker that lost its lease cannot overwrite the one that took the job over. A job gets five
attempts; after that it is 'failed', the dead-letter state, with the error recorded.
"""

import json
import logging
import os
import signal
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import text

from .catalog import PART_CATEGORIES
from .config import API_URL, as_of
from .dates import day_label, quarter_of
from .db import engine, one
from .mock_suppliers import supplier_slugs_for_sku
from .models import latest_runs

log = logging.getLogger("supply.worker")

MAX_ATTEMPTS = 5
POLL_SECONDS = 1.5
HTTP_TIMEOUT_SECONDS = 8.0
DELAY_COST_PER_DAY = 0.001
# The most HTTP calls one job makes: a quote from every supplier of the part, then the order.
MAX_HTTP_CALLS = max(len(c["suppliers"]) for c in PART_CATEGORIES) + 1
# Longer than every HTTP timeout of one job added together, plus 15 s for the database work.
LEASE_SECONDS = MAX_HTTP_CALLS * HTTP_TIMEOUT_SECONDS + 15


class LostLease(Exception):
    """Another worker took this job over after the lease ran out."""


@dataclass
class Job:
    id: int
    supply_order_id: int
    attempts: int
    stage: str | None
    supplier: str | None
    supplier_idempotency_key: str | None
    quote: dict | None


def supplier_key(supply_order_id: int) -> str:
    return f"supply-order-{supply_order_id}"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def dead_letter_expired() -> list[int]:
    """Jobs whose lease ran out on their last allowed attempt go to 'failed'."""
    with engine().begin() as c:
        rows = c.execute(
            text(
                """UPDATE supply_jobs
                      SET status = 'failed', locked_until = NULL, locked_by = NULL, updated_at = now(),
                          last_error = COALESCE(last_error || '; ', '') || 'the worker stopped during attempt ' || attempts,
                          log = log || jsonb_build_array(jsonb_build_object('at', CAST(:at AS text), 'msg',
                                'The worker stopped during try ' || attempts || ' of ' || CAST(:max AS int) || '. No tries left.'))
                    WHERE status = 'running' AND locked_until < now() AND attempts >= :max
                RETURNING id, supply_order_id"""
            ),
            {"max": MAX_ATTEMPTS, "at": _now()},
        ).all()
        if rows:
            c.execute(text("UPDATE supply_orders SET status = 'failed' WHERE id = ANY(:ids)"), {"ids": [r.supply_order_id for r in rows]})
    return [r.id for r in rows]


def claim(worker: str, lease_seconds: float = LEASE_SECONDS) -> Job | None:
    """Claim one pending job whose time has come, or one whose worker's lease has run out."""
    with engine().begin() as c:
        r = c.execute(
            text(
                """UPDATE supply_jobs
                      SET status = 'running', attempts = attempts + 1, locked_by = :w,
                          locked_until = now() + make_interval(secs => :lease), updated_at = now()
                    WHERE id = (SELECT id FROM supply_jobs
                                 WHERE attempts < :max
                                   AND ((status = 'pending' AND run_after <= now())
                                        OR (status = 'running' AND locked_until < now()))
                                 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
                RETURNING id, supply_order_id, attempts, stage, supplier, supplier_idempotency_key, quote"""
            ),
            {"w": worker, "lease": lease_seconds, "max": MAX_ATTEMPTS},
        ).first()
    if not r:
        return None
    return Job(r.id, r.supply_order_id, r.attempts, r.stage, r.supplier, r.supplier_idempotency_key, r.quote)


def _fenced(c: Any, job: Job, worker: str, sql: str, params: dict) -> None:
    """Run one write on the job only while this worker still holds its lease for this attempt."""
    res = c.execute(
        text(sql + " AND locked_by = :w AND attempts = :attempt"), {**params, "id": job.id, "w": worker, "attempt": job.attempts}
    )
    if res.rowcount != 1:
        raise LostLease(f"job {job.id} was taken over after its lease ran out")


def _append_log(c: Any, job: Job, worker: str, entry: dict) -> None:
    _fenced(
        c,
        job,
        worker,
        "UPDATE supply_jobs SET log = log || CAST(:entry AS jsonb), updated_at = now() WHERE id = :id",
        {"entry": json.dumps([{"at": _now(), **entry}])},
    )


def _request(http: httpx.Client, method: str, url: str, **kw: Any) -> dict:
    res = http.request(method, url, **kw)
    try:
        body = res.json()
    except ValueError:
        body = {}
    if res.status_code >= 400:
        raise RuntimeError(f"{res.status_code} {body.get('error', res.reason_phrase)}")
    return body


def _choose_supplier(job: Job, so: dict, http: httpx.Client, base_url: str, worker: str) -> dict:
    """Quote every supplier of the part, save the best on the job (stage quoted), and return it."""
    runs = latest_runs()
    q = quarter_of(as_of())
    delay = {s["supplier"]: s["byQuarter"][q] for s in (runs["supplier_delay"]["output"]["suppliers"] if runs else [])}
    fail = {f"{r['sku']}|{r['supplier']}": r["rate"] for r in (runs["component_failure"]["output"]["rows"] if runs else [])}

    slugs = supplier_slugs_for_sku(so["sku"])
    url = f"{base_url}/api/mock-suppliers/{{}}/quote"

    def ask(slug: str) -> dict:
        return _request(http, "GET", url.format(slug), params={"sku": so["sku"], "qty": so["quantity"], "attempt": job.attempts})

    quotes, errors = [], []
    with ThreadPoolExecutor(max_workers=len(slugs) or 1) as pool:
        for slug, fut in [(s, pool.submit(ask, s)) for s in slugs]:
            try:
                quotes.append({"slug": slug, **fut.result()})
            except Exception as e:  # noqa: BLE001 - one supplier failing is logged, the rest still quote
                errors.append(f"{slug}: {e}")
    if not quotes:
        raise RuntimeError(f"no supplier answered: {'; '.join(errors)}")

    scored = []
    for qt in quotes:
        fr = fail.get(f"{so['sku']}|{qt['supplier']}", 0.05)
        d = delay.get(qt["supplier"], 14)
        effective = qt["unitPrice"] / (1 - fr) * (1 + DELAY_COST_PER_DAY * (d + (0 if qt["canFill"] else 14)))
        scored.append({**qt, "failureRate": fr, "expectedDelay": d, "effective": round(effective, 2)})
    scored.sort(key=lambda s: s["effective"])
    best = scored[0]

    key = supplier_key(job.supply_order_id)
    with engine().begin() as c:
        _fenced(
            c,
            job,
            worker,
            """UPDATE supply_jobs SET stage = 'quoted', supplier = :s, supplier_idempotency_key = :k,
                      quote = CAST(:q AS jsonb), updated_at = now() WHERE id = :id""",
            {"s": best["supplier"], "k": key, "q": json.dumps(best)},
        )
        _append_log(
            c,
            job,
            worker,
            {
                "msg": f"{len(quotes)} of {len(slugs)} suppliers quoted. {best['supplier']} has the lowest cost after expected failures and delay.",
                "quotes": [
                    {k: s[k] for k in ("supplier", "unitPrice", "canFill", "leadDays", "failureRate", "expectedDelay", "effective")}
                    for s in scored
                ],
                "errors": errors,
            },
        )
    job.stage, job.supplier, job.supplier_idempotency_key, job.quote = "quoted", best["supplier"], key, best
    return best


def process_job(job: Job, http: httpx.Client, base_url: str = API_URL, worker: str = "") -> None:
    so = one("SELECT sku, quantity, warehouse FROM supply_orders WHERE id = :id", {"id": job.supply_order_id})
    if not so:
        raise RuntimeError(f"supply order {job.supply_order_id} is missing")

    if job.stage in ("quoted", "placing", "placed") and job.quote and job.supplier_idempotency_key:
        best = job.quote
        with engine().begin() as c:
            _append_log(
                c, job, worker, {"msg": f"Try {job.attempts}: reusing the saved choice, {best['supplier']}, without quoting again."}
            )
    else:
        best = _choose_supplier(job, so, http, base_url, worker)

    with engine().begin() as c:
        _fenced(c, job, worker, "UPDATE supply_jobs SET stage = 'placing', updated_at = now() WHERE id = :id", {})
    placed = _request(
        http,
        "POST",
        f"{base_url}/api/mock-suppliers/{best['slug']}/orders",
        json={"sku": so["sku"], "quantity": so["quantity"]},
        headers={"Idempotency-Key": job.supplier_idempotency_key or supplier_key(job.supply_order_id)},
    )

    with engine().begin() as c:
        _fenced(
            c,
            job,
            worker,
            """UPDATE supply_jobs SET status = 'done', stage = 'placed', last_error = NULL, locked_until = NULL,
                      updated_at = now() WHERE id = :id""",
            {},
        )
        c.execute(
            text(
                """UPDATE supply_orders SET supplier = :s, unit_price = :p, promised_date = :d, external_ref = :r, status = 'placed'
                    WHERE id = :id"""
            ),
            {
                "id": job.supply_order_id,
                "s": best["supplier"],
                "p": placed["unitPrice"],
                "d": placed["promisedDate"],
                "r": placed["externalRef"],
            },
        )
        c.execute(
            text("UPDATE supply_jobs SET log = log || CAST(:entry AS jsonb) WHERE id = :id"),
            {
                "id": job.id,
                "entry": json.dumps(
                    [
                        {
                            "at": _now(),
                            "msg": f"Placed with {best['supplier']}, reference {placed['externalRef']}, promised {day_label(placed['promisedDate'])}.",
                        }
                    ]
                ),
            },
        )


def fail(job: Job, err: Exception, worker: str) -> None:
    message = str(err)
    with engine().begin() as c:
        if job.attempts >= MAX_ATTEMPTS:
            _fenced(
                c,
                job,
                worker,
                """UPDATE supply_jobs SET status = 'failed', last_error = :m, locked_until = NULL, locked_by = NULL,
                          updated_at = now() WHERE id = :id""",
                {"m": message},
            )
            c.execute(text("UPDATE supply_orders SET status = 'failed' WHERE id = :id"), {"id": job.supply_order_id})
            c.execute(
                text("UPDATE supply_jobs SET log = log || CAST(:e AS jsonb) WHERE id = :id"),
                {
                    "id": job.id,
                    "e": json.dumps([{"at": _now(), "msg": f"Could not place the order after {job.attempts} tries: {message}"}]),
                },
            )
        else:
            backoff = 2**job.attempts
            _append_log(c, job, worker, {"msg": f"Try {job.attempts} failed ({message}). Trying again in {backoff} seconds."})
            _fenced(
                c,
                job,
                worker,
                """UPDATE supply_jobs SET status = 'pending', last_error = :m, locked_until = NULL, locked_by = NULL,
                          run_after = now() + make_interval(secs => :b), updated_at = now() WHERE id = :id""",
                {"m": message, "b": backoff},
            )


def heartbeat(worker: str, processed: int) -> None:
    with engine().begin() as c:
        c.execute(
            text(
                """INSERT INTO worker_heartbeats (worker, seen_at, processed) VALUES (:w, now(), :n)
                   ON CONFLICT (worker) DO UPDATE SET seen_at = now(), processed = :n"""
            ),
            {"w": worker, "n": processed},
        )


def run_one(worker: str, http: httpx.Client, base_url: str = API_URL, lease_seconds: float = LEASE_SECONDS) -> str | None:
    """Claim and process one job. Returns 'done', 'retry' or 'lost', or None when nothing is due."""
    job = claim(worker, lease_seconds)
    if not job:
        return None
    try:
        process_job(job, http, base_url, worker)
        log.info("job %s done (supply order %s)", job.id, job.supply_order_id)
        return "done"
    except LostLease as e:
        log.warning("%s", e)
        return "lost"
    except Exception as e:  # noqa: BLE001 - any failure is retried with backoff, then dead-lettered
        log.info("job %s attempt %s failed: %s", job.id, job.attempts, e)
        try:
            fail(job, e, worker)
        except LostLease as lost:
            log.warning("%s", lost)
            return "lost"
        return "retry"


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[worker] %(message)s")
    worker = f"{socket.gethostname()}:{os.getpid()}"
    stopping = False

    def stop(*_: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    log.info("%s polling supply_jobs every %ss, lease %ss, suppliers at %s", worker, POLL_SECONDS, LEASE_SECONDS, API_URL)
    processed = 0
    with httpx.Client(timeout=HTTP_TIMEOUT_SECONDS) as http:
        while not stopping:
            try:
                heartbeat(worker, processed)
                for job_id in dead_letter_expired():
                    log.info("job %s ran out of tries after its worker stopped; marked failed", job_id)
                while not stopping and (outcome := run_one(worker, http)):
                    processed += outcome == "done"
            except Exception as e:  # noqa: BLE001 - a database blip must not kill the worker
                log.error("poll error: %s", e)
            time.sleep(POLL_SECONDS)
    with engine().begin() as c:
        c.execute(text("DELETE FROM worker_heartbeats WHERE worker = :w"), {"w": worker})
