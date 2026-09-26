"""The HTTP API: every route answers, and both POSTs are idempotent on the Idempotency-Key header."""

import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from supply.api import app
from supply.db import one

client = TestClient(app)


def count(sql: str) -> int:
    row = one(sql)
    assert row
    return next(iter(row.values()))


@pytest.mark.parametrize(
    "path",
    [
        "/api/health",
        "/api/overview",
        "/api/orders?tab=pipeline&months=3",
        "/api/orders?tab=backlog&months=12&model=TX-400&parts=short",
        "/api/customers",
        "/api/supply-orders?source=app",
        "/api/supply-orders/summary",
        "/api/queue",
        "/api/models",
        "/api/models/demand",
        "/api/brief",
        "/api/mock-suppliers/b/quote?sku=ENG-100&qty=5&attempt=x",
    ],
)
def test_every_read_route_answers(path):
    r = client.get(path)
    # The mock supplier fails about 1 call in 12 on purpose.
    assert r.status_code == 200 or (path.startswith("/api/mock-suppliers") and r.status_code == 503), (path, r.status_code, r.text[:200])


def test_a_bad_request_returns_400_with_the_issues():
    r = client.post("/api/orders", json={"customerId": 3, "tractorModel": "TX-900", "quantity": 2, "requestedDate": "2026-12-01"})
    assert r.status_code == 400
    assert r.json()["error"][0]["loc"][-1] == "tractorModel"
    assert client.get("/api/orders?model=TX-900").status_code == 400
    assert client.get("/api/models/nope").status_code == 404


def test_posting_a_supply_order_twice_with_one_key_writes_one_order_and_returns_the_same_bytes():
    key = str(uuid.uuid4())
    before = count("SELECT COUNT(*) FROM supply_orders")
    jobs_before = count("SELECT COUNT(*) FROM supply_jobs")
    body = {"lines": [{"sku": "HYD-400", "quantity": 120}], "source": "api"}
    first = client.post("/api/supply-orders", json=body, headers={"Idempotency-Key": key})
    second = client.post("/api/supply-orders", json=body, headers={"Idempotency-Key": key})
    assert first.status_code == second.status_code == 201
    assert first.content == second.content
    assert second.headers.get("Idempotent-Replayed") == "true"
    assert count("SELECT COUNT(*) FROM supply_orders") == before + 1
    assert count("SELECT COUNT(*) FROM supply_jobs") == jobs_before + 1


def test_covering_customer_orders_twice_with_one_key_queues_the_parts_once():
    short = client.get("/api/orders?tab=pipeline&months=1&parts=short&limit=2").json()["rows"]
    ids = [r["id"] for r in short]
    key = str(uuid.uuid4())
    before = count("SELECT COUNT(*) FROM supply_orders")
    first = client.post("/api/supply-orders", json={"customerOrderIds": ids}, headers={"Idempotency-Key": key})
    second = client.post("/api/supply-orders", json={"customerOrderIds": ids}, headers={"Idempotency-Key": key})
    assert first.status_code == 201 and first.content == second.content
    assert count("SELECT COUNT(*) FROM supply_orders") == before + len(first.json()["created"]) > before


def test_posting_a_customer_order_twice_with_one_key_writes_one_order():
    key = str(uuid.uuid4())
    before = count("SELECT COUNT(*) FROM customer_orders")
    body = {"customerId": 3, "tractorModel": "TX-300", "quantity": 2, "requestedDate": "2026-12-01"}
    first = client.post("/api/orders", json=body, headers={"Idempotency-Key": key})
    second = client.post("/api/orders", json=body, headers={"Idempotency-Key": key})
    assert first.status_code == second.status_code == 201
    assert first.content == second.content
    assert count("SELECT COUNT(*) FROM customer_orders") == before + 1


def test_the_same_key_sent_at_the_same_moment_writes_one_order():
    key = str(uuid.uuid4())
    before = count("SELECT COUNT(*) FROM supply_orders")
    body = {"lines": [{"sku": "TIR-100", "quantity": 7}]}

    def post(_):
        with TestClient(app) as c:
            return c.post("/api/supply-orders", json=body, headers={"Idempotency-Key": key})

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(post, range(6)))
    assert {r.status_code for r in results} == {201}
    assert len({r.content for r in results}) == 1
    assert count("SELECT COUNT(*) FROM supply_orders") == before + 1


def test_a_key_reused_with_a_different_body_is_refused():
    key = str(uuid.uuid4())
    assert (
        client.post("/api/supply-orders", json={"lines": [{"sku": "HYD-400", "quantity": 1}]}, headers={"Idempotency-Key": key}).status_code
        == 201
    )
    r = client.post("/api/supply-orders", json={"lines": [{"sku": "HYD-400", "quantity": 2}]}, headers={"Idempotency-Key": key})
    assert r.status_code == 422


def test_without_a_key_each_post_is_a_new_order():
    before = count("SELECT COUNT(*) FROM supply_orders")
    for _ in range(2):
        assert client.post("/api/supply-orders", json={"lines": [{"sku": "TIR-100", "quantity": 5}]}).status_code == 201
    assert count("SELECT COUNT(*) FROM supply_orders") == before + 2


def test_a_failed_request_stores_no_key_so_the_client_can_retry_it():
    key = str(uuid.uuid4())
    assert (
        client.post("/api/supply-orders", json={"lines": [{"sku": "XXX-1", "quantity": 5}]}, headers={"Idempotency-Key": key}).status_code
        == 400
    )
    assert one("SELECT key FROM idempotency_keys WHERE key = :k", {"k": key}) is None
