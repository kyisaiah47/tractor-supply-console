"""ORM classes for the write path: customer orders, supply orders, their jobs, and the
records that make writes idempotent. The analytic reads use plain SQL (supply/db.py).

Foreign keys to tables outside the ORM (parts, warehouses, suppliers) are enforced by the
schema in the Alembic migrations, not declared here."""

from datetime import date, datetime
from typing import Any

from sqlalchemy import ForeignKey, Numeric, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Customer(Base):
    __tablename__ = "customers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text)
    segment: Mapped[str] = mapped_column(Text)
    since: Mapped[date]


class CustomerOrder(Base):
    __tablename__ = "customer_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
    tractor_model: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int]
    warehouse: Mapped[str] = mapped_column(Text)
    ordered_at: Mapped[date]
    requested_date: Mapped[date]
    promised_date: Mapped[date | None]
    fulfilled_date: Mapped[date | None]
    status: Mapped[str] = mapped_column(Text)


class SupplyOrder(Base):
    __tablename__ = "supply_orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(Text)
    supplier: Mapped[str | None] = mapped_column(Text)
    warehouse: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int]
    unit_price: Mapped[float | None] = mapped_column(Numeric(12, 2, asdecimal=False))
    customer_order_id: Mapped[int | None] = mapped_column(ForeignKey("customer_orders.id"))
    date_ordered: Mapped[date]
    promised_date: Mapped[date | None]
    fulfilled_date: Mapped[date | None]
    status: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text, server_default="history")
    external_ref: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)


class SupplyJob(Base):
    __tablename__ = "supply_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    supply_order_id: Mapped[int] = mapped_column(ForeignKey("supply_orders.id"), unique=True)
    status: Mapped[str] = mapped_column(Text, server_default="pending")
    attempts: Mapped[int] = mapped_column(server_default="0")
    run_after: Mapped[datetime] = mapped_column(server_default=func.now())
    last_error: Mapped[str | None] = mapped_column(Text)
    log: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, server_default="[]")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())
    locked_until: Mapped[datetime | None]
    locked_by: Mapped[str | None] = mapped_column(Text)
    stage: Mapped[str | None] = mapped_column(Text)
    supplier: Mapped[str | None] = mapped_column(Text)
    supplier_idempotency_key: Mapped[str | None] = mapped_column(Text, unique=True)
    quote: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"
    key: Mapped[str] = mapped_column(Text, primary_key=True)
    route: Mapped[str] = mapped_column(Text)
    request_hash: Mapped[str] = mapped_column(Text)
    status_code: Mapped[int]
    response: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class MockSupplierOrder(Base):
    __tablename__ = "mock_supplier_orders"
    idempotency_key: Mapped[str] = mapped_column(Text, primary_key=True)
    supplier: Mapped[str] = mapped_column(Text)
    sku: Mapped[str] = mapped_column(Text)
    quantity: Mapped[int]
    response: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class LlmCall(Base):
    __tablename__ = "llm_calls"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    purpose: Mapped[str] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(server_default="0")
    output_tokens: Mapped[int] = mapped_column(server_default="0")
    latency_ms: Mapped[int]
    tool_rounds: Mapped[int] = mapped_column(server_default="0")
    request_id: Mapped[str | None] = mapped_column(Text)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6, asdecimal=False), server_default="0")
    error: Mapped[str | None] = mapped_column(Text)
