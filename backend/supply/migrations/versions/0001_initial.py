"""The initial schema, as it stood in db/schema.sql before the Python port.

Tables 1-5 are the five tables on the system design whiteboard:
  customer_orders, supply_orders, customers, production_pipeline, inventory_parts.
The rest hold the provided dataset, the catalog, the worker queue and model output.

Revision ID: 0001
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

NOW = sa.text("now()")


def upgrade() -> None:
    # The provided dataset, loaded row for row from data/market_signals.csv.
    op.create_table(
        "market_signals",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("date", sa.Date, nullable=False, comment="shifted so the last row is the day before the planning date"),
        sa.Column("source_date", sa.Date, nullable=False, comment="the date as it appears in the CSV"),
        sa.Column("tractor_model", sa.Text, nullable=False),
        sa.Column("demand_units", sa.Integer, nullable=False),
        sa.Column("supplier", sa.Text, nullable=False),
        sa.Column("supplier_delay_days", sa.Integer, nullable=False),
        sa.Column("component_failure_rate", sa.Numeric(6, 4), nullable=False),
        sa.Column("inventory_levels", sa.Integer, nullable=False),
        sa.Column("warehouse_location", sa.Text, nullable=False),
        sa.Column("inflation_rate", sa.Numeric(5, 2), nullable=False),
        sa.Column("market_trend_index", sa.Numeric(4, 2), nullable=False),
    )
    op.create_index("market_signals_model_date", "market_signals", ["tractor_model", "date"])

    # Catalog
    op.create_table(
        "tractor_models",
        sa.Column("code", sa.Text, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("horsepower", sa.Integer, nullable=False),
        sa.Column("list_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("build_days", sa.Integer, nullable=False),
    )
    op.create_table(
        "suppliers",
        sa.Column("code", sa.Text, primary_key=True, comment="'Supplier A' .. 'Supplier E', as in the dataset"),
        sa.Column("slug", sa.Text, nullable=False, unique=True, comment="'a' .. 'e', used in the mock supplier API path"),
        sa.Column("name", sa.Text, nullable=False),
    )
    op.create_table(
        "warehouses",
        sa.Column("code", sa.Text, primary_key=True, comment="'CA','FL','IL','NY','TX', as in the dataset"),
        sa.Column("name", sa.Text, nullable=False),
    )
    op.create_table(
        "parts",
        sa.Column("sku", sa.Text, primary_key=True),
        sa.Column("tractor_model", sa.Text, sa.ForeignKey("tractor_models.code"), nullable=False),
        sa.Column("category", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("qty_per_tractor", sa.Integer, nullable=False),
        sa.Column("standard_cost", sa.Numeric(12, 2), nullable=False),
    )
    op.create_table(
        "part_suppliers",
        sa.Column("sku", sa.Text, sa.ForeignKey("parts.sku"), primary_key=True),
        sa.Column("supplier", sa.Text, sa.ForeignKey("suppliers.code"), primary_key=True),
        sa.Column("unit_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("nominal_lead_days", sa.Integer, nullable=False),
    )

    # 3. customers
    op.create_table(
        "customers",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("state", sa.Text, sa.ForeignKey("warehouses.code"), nullable=False),
        sa.Column("segment", sa.Text, nullable=False, comment="dealer | fleet | co-op"),
        sa.Column("since", sa.Date, nullable=False),
    )

    # 1. customer_orders. The order form writes here: customer_id, tractor model, quantity, id.
    op.create_table(
        "customer_orders",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("customer_id", sa.Integer, sa.ForeignKey("customers.id"), nullable=False),
        sa.Column("tractor_model", sa.Text, sa.ForeignKey("tractor_models.code"), nullable=False),
        sa.Column("quantity", sa.Integer, sa.CheckConstraint("quantity > 0"), nullable=False),
        sa.Column("warehouse", sa.Text, sa.ForeignKey("warehouses.code"), nullable=False),
        sa.Column("ordered_at", sa.Date, nullable=False),
        sa.Column("requested_date", sa.Date, nullable=False, comment="the delivery date the customer asked for"),
        sa.Column("promised_date", sa.Date),
        sa.Column("fulfilled_date", sa.Date),
        sa.Column(
            "status",
            sa.Text,
            sa.CheckConstraint("status IN ('open','in_production','fulfilled','cancelled')"),
            nullable=False,
        ),
    )
    op.create_index("customer_orders_requested", "customer_orders", ["requested_date"])
    op.create_index("customer_orders_status", "customer_orders", ["status"])

    # 4. production_pipeline. One row per order that is scheduled to be built.
    op.create_table(
        "production_pipeline",
        sa.Column("customer_order_id", sa.Integer, sa.ForeignKey("customer_orders.id"), primary_key=True),
        sa.Column(
            "stage",
            sa.Text,
            sa.CheckConstraint("stage IN ('awaiting_parts','scheduled','assembly','qa','ready')"),
            nullable=False,
        ),
        sa.Column("stage_entered_at", sa.Date, nullable=False),
        sa.Column("scheduled_start", sa.Date, nullable=False),
        sa.Column("scheduled_finish", sa.Date, nullable=False),
    )

    # 2. supply_orders. date_ordered, promised_date and fulfilled_date are the whiteboard's columns.
    op.create_table(
        "supply_orders",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("sku", sa.Text, sa.ForeignKey("parts.sku"), nullable=False),
        sa.Column("supplier", sa.Text, sa.ForeignKey("suppliers.code"), comment="null until the worker places it"),
        sa.Column("warehouse", sa.Text, sa.ForeignKey("warehouses.code"), nullable=False),
        sa.Column("quantity", sa.Integer, sa.CheckConstraint("quantity > 0"), nullable=False),
        sa.Column("unit_price", sa.Numeric(12, 2)),
        sa.Column("customer_order_id", sa.Integer, sa.ForeignKey("customer_orders.id")),
        sa.Column("date_ordered", sa.Date, nullable=False),
        sa.Column("promised_date", sa.Date),
        sa.Column("fulfilled_date", sa.Date),
        sa.Column(
            "status",
            sa.Text,
            sa.CheckConstraint("status IN ('queued','placed','fulfilled','failed')"),
            nullable=False,
        ),
        sa.Column(
            "source",
            sa.Text,
            nullable=False,
            server_default="history",
            comment="history | order_form | selected_orders | recommendation | chatbot | api",
        ),
        sa.Column("external_ref", sa.Text),
        sa.Column("note", sa.Text),
    )
    op.create_index("supply_orders_status", "supply_orders", ["status"])
    op.create_index("supply_orders_sku", "supply_orders", ["sku"])

    # Worker queue for supply orders (Postgres-backed, claimed with FOR UPDATE SKIP LOCKED).
    op.create_table(
        "supply_jobs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("supply_order_id", sa.Integer, sa.ForeignKey("supply_orders.id"), nullable=False),
        sa.Column(
            "status",
            sa.Text,
            sa.CheckConstraint("status IN ('pending','running','done','failed')"),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("run_after", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("last_error", sa.Text),
        sa.Column("log", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_index("supply_jobs_pending", "supply_jobs", ["status", "run_after"])

    op.create_table(
        "worker_heartbeats",
        sa.Column("worker", sa.Text, primary_key=True),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("processed", sa.Integer, nullable=False, server_default="0"),
    )

    # On-hand stock per part per warehouse at the app's as-of date.
    op.create_table(
        "inventory",
        sa.Column("sku", sa.Text, sa.ForeignKey("parts.sku"), primary_key=True),
        sa.Column("warehouse", sa.Text, sa.ForeignKey("warehouses.code"), primary_key=True),
        sa.Column("on_hand", sa.Integer, nullable=False),
    )

    # 5. inventory_parts. One row per received lot; broken / broken_date from the whiteboard
    #    are broken_quantity, broken_date and the stage the failure was found at.
    op.create_table(
        "inventory_parts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("sku", sa.Text, sa.ForeignKey("parts.sku"), nullable=False),
        sa.Column("supplier", sa.Text, sa.ForeignKey("suppliers.code"), nullable=False),
        sa.Column("warehouse", sa.Text, sa.ForeignKey("warehouses.code"), nullable=False),
        sa.Column("supply_order_id", sa.Integer, sa.ForeignKey("supply_orders.id")),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("received_date", sa.Date, nullable=False),
        sa.Column("broken_quantity", sa.Integer, nullable=False, server_default="0"),
        sa.Column("broken_date", sa.Date),
        sa.Column("broken_stage", sa.Text, sa.CheckConstraint("broken_stage IN ('receiving','assembly','field')")),
    )
    op.create_index("inventory_parts_sku_supplier", "inventory_parts", ["sku", "supplier"])

    # Output of the four models, one row per model per run.
    op.create_table(
        "model_runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "model",
            sa.Text,
            sa.CheckConstraint("model IN ('demand','supplier_delay','component_failure','inventory_strategy')"),
            nullable=False,
        ),
        sa.Column("as_of", sa.Date, nullable=False),
        sa.Column("ran_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("metrics", JSONB, nullable=False),
        sa.Column("output", JSONB, nullable=False),
    )
    op.create_index("model_runs_latest", "model_runs", ["model", sa.text("ran_at DESC")])

    # The weekly job's written summary shown on the dashboard.
    op.create_table(
        "weekly_briefs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("as_of", sa.Date, nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.Column("author", sa.Text, nullable=False, comment="'template' or 'llm:<provider>/<model>'"),
        sa.Column("body", sa.Text, nullable=False),
        sa.Column("facts", JSONB, nullable=False),
    )


def downgrade() -> None:
    for t in [
        "weekly_briefs", "model_runs", "inventory_parts", "inventory", "worker_heartbeats", "supply_jobs",
        "supply_orders", "production_pipeline", "customer_orders", "customers", "part_suppliers", "parts",
        "warehouses", "suppliers", "tractor_models", "market_signals",
    ]:  # fmt: skip
        op.drop_table(t)
