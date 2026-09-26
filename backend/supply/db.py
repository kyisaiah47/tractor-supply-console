"""The database: one SQLAlchemy engine on psycopg 3.

Writes (orders, jobs, customers) go through the ORM in supply/orm.py. The analytic reads are
plain SQL through text(), returned as dicts: NUMERIC comes back as float, and dates and
timestamps as ISO strings, which is what the JSON responses carry.
"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import date, datetime
from functools import cache
from typing import Any

from psycopg.types.numeric import FloatLoader
from sqlalchemy import Connection, Engine, create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker

from .config import database_url


@cache
def engine() -> Engine:
    eng = create_engine(
        database_url(),
        pool_size=10,
        pool_pre_ping=True,
        connect_args={"options": "-c timezone=UTC"},
    )

    @event.listens_for(eng, "connect")
    def _numeric_as_float(dbapi_conn, _record) -> None:  # noqa: ANN001
        dbapi_conn.adapters.register_loader("numeric", FloatLoader)

    return eng


@cache
def _session_factory() -> sessionmaker[Session]:
    return sessionmaker(engine(), expire_on_commit=False)


@contextmanager
def session() -> Iterator[Session]:
    """A session in one transaction: committed on success, rolled back on error."""
    with _session_factory()() as s, s.begin():
        yield s


def _plain(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return v


def rows(sql: str, params: Mapping[str, Any] | None = None, conn: Connection | Session | None = None) -> list[dict]:
    """Run one read and return its rows as dicts."""
    if conn is not None:
        res = conn.execute(text(sql), params or {})
        return [{k: _plain(v) for k, v in r.items()} for r in res.mappings()]
    with engine().connect() as c:
        res = c.execute(text(sql), params or {})
        return [{k: _plain(v) for k, v in r.items()} for r in res.mappings()]


def one(sql: str, params: Mapping[str, Any] | None = None, conn: Connection | Session | None = None) -> dict | None:
    r = rows(sql, params, conn)
    return r[0] if r else None


def execute(sql: str, params: Mapping[str, Any] | None = None) -> None:
    with engine().begin() as c:
        c.execute(text(sql), params or {})
