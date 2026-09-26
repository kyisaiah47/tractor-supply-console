"""The supply order worker: saved supplier, supplier idempotency key, lease and dead letter.

The worker talks to the mock suppliers over HTTP. Here that HTTP goes to the API in-process
through FastAPI's TestClient, so the supplier's own idempotency store is the real one.
"""

import time
from typing import cast

import httpx
import pytest
from fastapi.testclient import TestClient

from supply import worker as w
from supply.api import app
from supply.db import execute, one, rows

BASE = "http://testserver"


class WorkerKilled(BaseException):
    """Stands in for kill -9: not an Exception, so the worker's error handling never sees it."""


@pytest.fixture(autouse=True)
def only_this_tests_jobs():
    execute("UPDATE supply_jobs SET status = 'done', locked_until = NULL WHERE status IN ('pending', 'running')")


def new_job(sku: str = "HYD-300", quantity: int = 40) -> dict:
    r = TestClient(app).post("/api/supply-orders", json={"lines": [{"sku": sku, "quantity": quantity}]})
    assert r.status_code == 201, r.text
    return r.json()["created"][0]


def job_row(job_id: int) -> dict:
    row = one("SELECT * FROM supply_jobs WHERE id = :id", {"id": job_id})
    assert row
    return row


def supplier_orders(so_id: int) -> list[dict]:
    return rows("SELECT * FROM mock_supplier_orders WHERE idempotency_key = :k", {"k": w.supplier_key(so_id)})


def drain(job_id: int, worker: str = "test-worker", http: httpx.Client | None = None) -> dict:
    """Run the worker until this job is done or failed. The mock suppliers fail 1 call in 12 on purpose."""
    # TestClient is an httpx.Client that sends requests to the app in-process.
    client = http if http is not None else cast(httpx.Client, TestClient(app))
    for _ in range(w.MAX_ATTEMPTS + 1):
        execute("UPDATE supply_jobs SET run_after = now() WHERE id = :id", {"id": job_id})
        w.run_one(worker, client, BASE)
        row = job_row(job_id)
        if row["status"] in ("done", "failed"):
            return row
    return job_row(job_id)


def test_the_lease_is_longer_than_every_http_timeout_of_a_job_added_together():
    assert w.MAX_HTTP_CALLS == 4
    assert w.LEASE_SECONDS > w.MAX_HTTP_CALLS * w.HTTP_TIMEOUT_SECONDS


def test_a_job_is_quoted_saved_and_placed():
    created = new_job()
    row = drain(created["jobId"])
    assert row["status"] == "done" and row["stage"] == "placed"
    assert row["supplier_idempotency_key"] == f"supply-order-{created['id']}"
    so = one("SELECT status, supplier, external_ref FROM supply_orders WHERE id = :id", {"id": created["id"]})
    assert so and so["status"] == "placed" and so["supplier"] == row["supplier"]
    assert [x["supplier"] for x in supplier_orders(created["id"])] == [row["supplier"]]
    assert "Placed with" in row["log"][-1]["msg"]


def test_processing_the_same_job_twice_records_one_supplier_order():
    created = new_job()
    first = drain(created["jobId"])
    ref = one("SELECT external_ref FROM supply_orders WHERE id = :id", {"id": created["id"]})
    # Deliver the finished job a second time, as a queue can after a crash.
    execute("UPDATE supply_jobs SET status = 'pending', attempts = 1 WHERE id = :id", {"id": created["jobId"]})
    second = drain(created["jobId"])
    assert first["status"] == second["status"] == "done"
    assert len(supplier_orders(created["id"])) == 1
    assert one("SELECT external_ref FROM supply_orders WHERE id = :id", {"id": created["id"]}) == ref
    assert "without quoting again" in second["log"][-2]["msg"]


def test_a_worker_killed_after_the_supplier_accepted_is_reclaimed_after_its_lease_and_orders_once():
    created = new_job()
    client = TestClient(app)

    class DiesAfterPlacing(httpx.Client):
        def request(self, method, url, **kw):  # type: ignore[override]
            res = client.request(method, url, **kw)
            if method == "POST" and "/orders" in str(url) and res.status_code == 201:
                raise WorkerKilled
            return res

    # Worker A claims with a one second lease, gets quotes, the supplier accepts, then A dies.
    for _ in range(w.MAX_ATTEMPTS):
        execute("UPDATE supply_jobs SET run_after = now() WHERE id = :id", {"id": created["jobId"]})
        try:
            w.run_one("worker-a", DiesAfterPlacing(), BASE, lease_seconds=1)
        except WorkerKilled:
            break
    killed = job_row(created["jobId"])
    assert killed["status"] == "running" and killed["stage"] == "placing" and killed["locked_by"] == "worker-a"
    assert len(supplier_orders(created["id"])) == 1

    # While the lease holds, nobody else can take the job.
    assert w.claim("worker-b") is None
    time.sleep(1.2)

    # After the lease, worker B takes it back, reuses the saved supplier, and the supplier replays.
    done = drain(created["jobId"], worker="worker-b")
    assert done["status"] == "done" and done["locked_by"] == "worker-b"
    assert done["supplier"] == killed["supplier"]
    placed = supplier_orders(created["id"])
    assert len(placed) == 1
    so = one("SELECT status, external_ref FROM supply_orders WHERE id = :id", {"id": created["id"]})
    assert so and so["status"] == "placed" and so["external_ref"] in placed[0]["response"]

    # Worker A's stale lease cannot write over worker B's result.
    stale = w.Job(created["jobId"], created["id"], killed["attempts"], "placing", killed["supplier"], None, None)
    with pytest.raises(w.LostLease):
        w.fail(stale, RuntimeError("late"), "worker-a")


def test_a_job_that_keeps_failing_is_dead_lettered_after_five_attempts_with_the_error():
    created = new_job()
    down = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(503, json={"error": "supplier down"})))
    row = drain(created["jobId"], http=down)
    assert row["status"] == "failed" and row["attempts"] == w.MAX_ATTEMPTS
    assert "supplier down" in row["last_error"]
    assert one("SELECT status FROM supply_orders WHERE id = :id", {"id": created["id"]}) == {"status": "failed"}
    execute("UPDATE supply_jobs SET run_after = now() WHERE id = :id", {"id": created["jobId"]})
    assert w.claim("test-worker") is None


def test_a_lease_that_runs_out_on_the_last_attempt_goes_to_the_dead_letter_state():
    created = new_job()
    execute(
        "UPDATE supply_jobs SET status = 'running', attempts = :n, locked_until = now() - interval '1 second' WHERE id = :id",
        {"n": w.MAX_ATTEMPTS, "id": created["jobId"]},
    )
    assert w.dead_letter_expired() == [created["jobId"]]
    row = job_row(created["jobId"])
    assert row["status"] == "failed" and "stopped during attempt 5" in row["last_error"]
    assert one("SELECT status FROM supply_orders WHERE id = :id", {"id": created["id"]}) == {"status": "failed"}
