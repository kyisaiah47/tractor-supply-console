"""The HTTP API. Every path the Next.js UI calls lives here; Next.js proxies /api/* to it.

Bodies are validated with Pydantic. A bad request returns 400 with the issues, as before.
"""

import re
import time
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import Body, FastAPI, Header, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy.orm import Session

from . import queries
from .catalog import MODEL_CODES, WAREHOUSE_CODES
from .config import as_of
from .db import one, rows
from .idempotency import Outcome, run_idempotent
from .mock_suppliers import KeyReused, SupplierUnavailable, place_order, quote
from .models import MODEL_NAMES, MODEL_SPECS, latest_runs
from .orm import CustomerOrder
from .supply_orders import UnknownPart, create_supply_orders, lines_for_customer_orders
from .weekly import latest_brief, run_weekly_job

app = FastAPI(title="Tractor Supply Console API")

TractorModel = Literal["TX-100", "TX-200", "TX-300", "TX-400", "TX-500"]
Warehouse = Literal["CA", "FL", "IL", "NY", "TX"]
Source = Literal["order_form", "selected_orders", "recommendation", "chatbot", "api"]
assert list(TractorModel.__args__) == MODEL_CODES and list(Warehouse.__args__) == WAREHOUSE_CODES  # type: ignore[attr-defined]
IdemKey = Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)]


def error(status: int, err: object) -> JSONResponse:
    return JSONResponse({"error": jsonable_encoder(err)}, status_code=status)


@app.exception_handler(RequestValidationError)
async def _bad_request(_req: Request, exc: RequestValidationError) -> JSONResponse:
    return error(400, exc.errors())


def outcome_response(o: Outcome) -> Response:
    headers = {"Idempotent-Replayed": "true"} if o.replayed else {}
    if o.raw is not None:
        return Response(o.raw, status_code=o.status, headers=headers, media_type="application/json")
    return JSONResponse(jsonable_encoder(o.body), status_code=o.status, headers=headers)


@app.get("/api/health")
def health() -> dict:
    one("SELECT 1")
    return {"ok": True}


# ---- customer orders ---------------------------------------------------------------------


class OrdersQuery(BaseModel):
    tab: Literal["pipeline", "backlog"] = "pipeline"
    months: int | None = Field(None, ge=1, le=12)
    model: TractorModel | None = None
    warehouse: Warehouse | None = None
    parts: Literal["covered", "short"] | None = None
    limit: int = Field(200, ge=1, le=500)
    offset: int = Field(0, ge=0)


@app.get("/api/orders")
def get_orders(request: Request) -> JSONResponse:
    """Customer orders with part allocation and filter counts. Powers both Orders tabs."""
    params = {k: v for k, v in request.query_params.items() if v != ""}
    params["tab"] = "backlog" if params.get("tab") == "backlog" else "pipeline"
    try:
        q = OrdersQuery.model_validate(params)
    except ValidationError as e:
        return error(400, e.errors(include_url=False))
    months = q.months or (3 if q.tab == "pipeline" else 12)
    return JSONResponse(
        queries.list_orders(q.tab, months, q.model, q.warehouse, q.parts, q.limit, q.offset),
    )


class NewOrder(BaseModel):
    customerId: int = Field(gt=0)
    tractorModel: TractorModel
    quantity: int = Field(ge=1, le=50)
    warehouse: Warehouse | None = None
    requestedDate: str

    @field_validator("requestedDate")
    @classmethod
    def _day(cls, v: str) -> str:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
            raise ValueError("requestedDate must be YYYY-MM-DD")
        return v


@app.post("/api/orders", status_code=201)
def post_order(o: NewOrder, idempotency_key: IdemKey = None) -> Response:
    """The order form. Writes one customer order."""
    today = as_of()
    if o.requestedDate <= today:
        return error(400, f"requestedDate must be after the app's clock, {today}")

    def write(s: Session) -> Outcome:
        c = one("SELECT state FROM customers WHERE id = :id", {"id": o.customerId}, conn=s)
        if not c:
            return Outcome(404, {"error": f"No customer {o.customerId}"})
        row = CustomerOrder(
            customer_id=o.customerId,
            tractor_model=o.tractorModel,
            quantity=o.quantity,
            warehouse=o.warehouse or c["state"],
            ordered_at=date.fromisoformat(today),
            requested_date=date.fromisoformat(o.requestedDate),
            status="open",
        )
        s.add(row)
        s.flush()
        return Outcome(201, {"id": row.id, "status": "open"})

    return outcome_response(run_idempotent(idempotency_key, "POST /api/orders", o.model_dump(), write))


@app.get("/api/customers")
def get_customers() -> dict:
    return {"customers": rows("SELECT id, name, state, segment FROM customers ORDER BY name")}


# ---- supply orders -----------------------------------------------------------------------


class SupplyLine(BaseModel):
    sku: str = Field(min_length=3)
    quantity: int = Field(gt=0, le=100_000)
    warehouse: str | None = Field(None, min_length=2, max_length=2)
    supplier: str | None = None
    customerOrderId: int | None = None
    note: str | None = Field(None, max_length=500)


class LinesBody(BaseModel):
    lines: list[SupplyLine] = Field(min_length=1, max_length=200)
    source: Source = "api"


class CoverBody(BaseModel):
    customerOrderIds: list[int] = Field(min_length=1, max_length=500)
    dryRun: bool = False


@app.get("/api/supply-orders")
def get_supply_orders(status: str | None = None, source: str | None = None, limit: int = 100) -> dict:
    """Supply orders with their queue job, newest first."""
    where = ["1=1"]
    params: dict = {"limit": max(1, min(500, limit))}
    if status:
        where.append("s.status = :status")
        params["status"] = status
    if source == "app":
        where.append("s.source <> 'history'")
    return {
        "supplyOrders": rows(
            f"""SELECT s.id, s.sku, p.category, p.tractor_model, s.supplier, s.warehouse, s.quantity, s.unit_price,
                       s.date_ordered, s.promised_date, s.fulfilled_date, s.status, s.source, s.external_ref, s.note,
                       j.id AS job_id, j.status AS job_status, j.stage AS job_stage, j.attempts, j.last_error, j.log, j.updated_at
                  FROM supply_orders s JOIN parts p USING (sku)
                  LEFT JOIN supply_jobs j ON j.supply_order_id = s.id
                 WHERE {" AND ".join(where)}
                 ORDER BY s.id DESC LIMIT :limit""",
            params,
        )
    }


@app.get("/api/supply-orders/summary")
def get_supply_summary() -> dict:
    return queries.supply_summary()


@app.post("/api/supply-orders", status_code=201)
def post_supply_orders(raw: Annotated[Any, Body()] = None, idempotency_key: IdemKey = None) -> Response:
    """The place supply/parts order API.

      { lines: [...] }                        queue these lines
      { customerOrderIds: [...], dryRun }     cover those orders' part shortfalls ("Order all selected")

    Orders are written as 'queued' and the worker places them with a supplier asynchronously.
    """
    if not isinstance(raw, dict):
        return error(400, "The body must be a JSON object")
    try:
        body: LinesBody | CoverBody = LinesBody.model_validate(raw) if "lines" in raw else CoverBody.model_validate(raw)
    except ValidationError as e:
        return error(400, e.errors(include_url=False))
    if isinstance(body, CoverBody) and body.dryRun:
        return JSONResponse(jsonable_encoder({"dryRun": True, **lines_for_customer_orders(body.customerOrderIds)}))

    def write(s: Session) -> Outcome:
        try:
            if isinstance(body, CoverBody):
                plan = lines_for_customer_orders(body.customerOrderIds)
                created = create_supply_orders(
                    s,
                    [
                        {
                            "sku": ln["sku"],
                            "quantity": ln["quantity"],
                            "warehouse": ln["warehouse"],
                            "supplier": ln["supplier"],
                            "note": ln["note"],
                            "customerOrderId": ln["forOrders"][0],
                        }
                        for ln in plan["lines"]
                    ],
                    "selected_orders",
                )
                return Outcome(201, {"created": created, "covered": plan["covered"], "requested": plan["requested"]})
            created = create_supply_orders(s, [ln.model_dump() for ln in body.lines], body.source)
            return Outcome(201, {"created": created})
        except UnknownPart as e:
            return Outcome(400, {"error": str(e)})

    return outcome_response(run_idempotent(idempotency_key, "POST /api/supply-orders", body.model_dump(), write))


# ---- models, the weekly job and the brief -------------------------------------------------


@app.get("/api/models")
def get_models() -> JSONResponse:
    runs = latest_runs()
    if not runs:
        return error(404, "No model runs yet. POST /api/jobs/weekly.")
    return JSONResponse(jsonable_encoder({"specs": MODEL_SPECS, "asOf": as_of(), **runs}))


@app.get("/api/models/{name}")
def get_model(name: str) -> JSONResponse:
    if name not in MODEL_NAMES:
        return error(404, f"Unknown model. One of: {', '.join(MODEL_NAMES)}")
    runs = latest_runs()
    if not runs:
        return error(404, "No model runs yet. POST /api/jobs/weekly.")
    return JSONResponse(jsonable_encoder({"model": name, "spec": MODEL_SPECS[name], "ranAt": runs["ranAt"], **runs[name]}))


@app.post("/api/jobs/weekly")
def post_weekly() -> dict:
    """Run the four models and write the weekly brief. A scheduler calls this once a week."""
    t0 = time.perf_counter()
    brief = run_weekly_job(use_llm=True)
    return {**brief, "ms": round((time.perf_counter() - t0) * 1000)}


@app.get("/api/brief")
def get_brief() -> JSONResponse:
    b = latest_brief()
    return JSONResponse(jsonable_encoder(b)) if b else error(404, "No brief yet")


@app.get("/api/overview")
def get_overview() -> dict:
    return queries.overview()


@app.get("/api/queue")
def get_queue() -> dict:
    """Worker heartbeats and the most recent supply jobs."""
    counts = rows("SELECT status, COUNT(*)::int AS n FROM supply_jobs GROUP BY 1")
    return {
        "workers": rows("SELECT worker, seen_at, processed FROM worker_heartbeats ORDER BY seen_at DESC"),
        "counts": {c["status"]: c["n"] for c in counts},
        "jobs": rows(
            """SELECT j.id, j.supply_order_id, j.status, j.stage, j.attempts, j.last_error, j.log, j.supplier AS chosen_supplier,
                      j.locked_until, j.created_at, j.updated_at, s.sku, s.quantity, s.supplier, s.status AS order_status
                 FROM supply_jobs j JOIN supply_orders s ON s.id = j.supply_order_id
                ORDER BY j.id DESC LIMIT 50"""
        ),
    }


# ---- mock supplier APIs ------------------------------------------------------------------


@app.get("/api/mock-suppliers/{slug}/quote")
def get_quote(slug: str, sku: str = "", qty: float = 0, attempt: str = "") -> JSONResponse:
    if not sku or not qty > 0:
        return error(400, "sku and qty are required")
    try:
        r = quote(slug, sku, int(qty), attempt)
    except SupplierUnavailable as e:
        return error(503, str(e))
    return JSONResponse(r) if r else error(404, f"Supplier {slug} does not make {sku}")


class SupplierOrder(BaseModel):
    sku: str
    quantity: int = Field(gt=0)


@app.post("/api/mock-suppliers/{slug}/orders", status_code=201)
def post_supplier_order(slug: str, body: SupplierOrder, idempotency_key: IdemKey = None) -> Response:
    try:
        r, replayed = place_order(slug, body.sku, body.quantity, idempotency_key)
    except SupplierUnavailable as e:
        return error(503, str(e))
    except KeyReused as e:
        return error(422, str(e))
    if not r:
        return error(404, f"Supplier {slug} does not make {body.sku}")
    return Response(r, status_code=201, headers={"Idempotent-Replayed": "true"} if replayed else {}, media_type="application/json")
