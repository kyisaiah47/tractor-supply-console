"""Creates the schema and loads both datasets:

  data/market_signals.csv  -> market_signals (the provided dataset, row for row)
  data/generated/*.csv     -> the operational tables (run `supply generate` first)

The schema is rebuilt from the Alembic migrations. Then the four models run once and the
first weekly brief is written.
"""

import csv
import json
import time
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text

from .catalog import SUPPLIERS, TRACTOR_MODELS, WAREHOUSES
from .config import DATA_DIR, GENERATED_DIR
from .dates import add_days
from .db import engine

BACKEND_DIR = Path(__file__).resolve().parents[1]
TABLES = ["parts", "part_suppliers", "customers", "customer_orders", "production_pipeline", "supply_orders", "inventory_parts", "inventory"]
SIGNAL_COLS = [
    "date", "source_date", "tractor_model", "demand_units", "supplier", "supplier_delay_days",
    "component_failure_rate", "inventory_levels", "warehouse_location", "inflation_rate", "market_trend_index",
]  # fmt: skip


def alembic_config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    return cfg


def migrate() -> None:
    command.upgrade(alembic_config(), "head")


def reset_schema() -> None:
    """Drop everything and rebuild the schema from the migrations."""
    with engine().begin() as c:
        c.execute(text("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public"))
    migrate()


def _copy(cur, table: str, cols: list[str], rows) -> int:
    n = 0
    with cur.copy(f"COPY {table} ({', '.join(cols)}) FROM STDIN") as cp:
        for r in rows:
            cp.write_row([None if v == "" else v for v in r])
            n += 1
    return n


def _read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    with open(path, newline="") as f:
        reader = csv.reader(f)
        cols = next(reader)
        return cols, [r for r in reader if r]


def seed(generated_dir: Path | None = None, run_models: bool = True) -> None:
    gen = generated_dir or GENERATED_DIR
    if not (gen / "customer_orders.csv").exists():
        raise SystemExit("data/generated is empty. Run `supply generate` first.")
    meta = json.loads((gen / "meta.json").read_text())
    reset_schema()

    counts: dict[str, int] = {}
    raw = engine().raw_connection()
    try:
        cur = raw.cursor()
        with open(DATA_DIR / "market_signals.csv", newline="") as f:
            signals = [r for r in csv.DictReader(f) if any(r.values())]
        counts["market_signals"] = _copy(
            cur,
            "market_signals",
            SIGNAL_COLS,
            (
                [
                    add_days(r["Date"], meta["shiftDays"]),
                    r["Date"],
                    r["Tractor_Model"],
                    r["Demand_Units"],
                    r["Supplier"],
                    r["Supplier_Delay_Days"],
                    r["Component_Failure_Rate"],
                    r["Inventory_Levels"],
                    r["Warehouse_Location"],
                    r["Inflation_Rate"],
                    r["Market_Trend_Index"],
                ]  # fmt: skip
                for r in signals
            ),
        )
        _copy(cur, "tractor_models", ["code", "name", "horsepower", "list_price", "build_days"],
              ([m["code"], m["name"], m["horsepower"], m["listPrice"], m["buildDays"]] for m in TRACTOR_MODELS))  # fmt: skip
        _copy(cur, "suppliers", ["code", "slug", "name"], ([s["code"], s["slug"], s["name"]] for s in SUPPLIERS))
        _copy(cur, "warehouses", ["code", "name"], ([w["code"], w["name"]] for w in WAREHOUSES))
        for t in TABLES:
            cols, data = _read_csv(gen / f"{t}.csv")
            counts[t] = _copy(cur, t, cols, data)
            if "id" in cols:
                cur.execute(f"SELECT setval(pg_get_serial_sequence('{t}','id'), (SELECT MAX(id) FROM {t}))")
        raw.commit()
    finally:
        raw.close()

    for k, v in counts.items():
        print(f"  loaded {k:<20} {v}")
    print(f"  planning date {meta['asOf']}, dataset dates moved forward {meta['shiftDays']} days")

    if run_models:
        from .weekly import run_weekly_job

        t0 = time.perf_counter()
        brief = run_weekly_job(use_llm=False, as_of=meta["asOf"])
        print(f"  ran 4 models and wrote the weekly brief in {(time.perf_counter() - t0) * 1000:.0f} ms ({brief['author']})")
