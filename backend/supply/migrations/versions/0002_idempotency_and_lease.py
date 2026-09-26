"""Idempotency keys, the worker lease and one weekly run per week.

- idempotency_keys: one row per client key sent to POST /api/orders or POST /api/supply-orders,
  written in the same transaction as the orders, holding the exact response text a repeat gets back.
- supply_jobs: one job per supply order. The worker saves the chosen supplier, the quote and
  the supplier idempotency key on the job before it calls the supplier, and moves the job
  through stage quoted, placing, placed. locked_until is the lease: a running job whose lease
  has expired is claimed again.
- mock_supplier_orders: the mock suppliers' own record of orders, keyed by the Idempotency-Key
  header, so a repeated call replays the stored result instead of ordering again.
- model_runs and weekly_briefs: one set per planning week, updated in place.

Revision ID: 0002
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

NOW = sa.text("now()")


def upgrade() -> None:
    op.create_table(
        "idempotency_keys",
        sa.Column("key", sa.Text, primary_key=True),
        sa.Column("route", sa.Text, nullable=False),
        sa.Column("request_hash", sa.Text, nullable=False),
        sa.Column("status_code", sa.Integer, nullable=False),
        sa.Column("response", sa.Text, nullable=False, comment="the JSON body as sent, replayed byte for byte"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )

    op.add_column("supply_jobs", sa.Column("locked_until", sa.DateTime(timezone=True)))
    op.add_column("supply_jobs", sa.Column("locked_by", sa.Text))
    op.add_column(
        "supply_jobs",
        sa.Column("stage", sa.Text, sa.CheckConstraint("stage IN ('quoted','placing','placed')", name="supply_jobs_stage_check")),
    )
    op.add_column("supply_jobs", sa.Column("supplier", sa.Text, sa.ForeignKey("suppliers.code")))
    op.add_column("supply_jobs", sa.Column("supplier_idempotency_key", sa.Text, unique=True))
    op.add_column("supply_jobs", sa.Column("quote", JSONB))
    op.create_unique_constraint("supply_jobs_supply_order_id_key", "supply_jobs", ["supply_order_id"])
    op.create_index("supply_jobs_lease", "supply_jobs", ["status", "locked_until"])

    op.create_table(
        "mock_supplier_orders",
        sa.Column("idempotency_key", sa.Text, primary_key=True),
        sa.Column("supplier", sa.Text, sa.ForeignKey("suppliers.code"), nullable=False),
        sa.Column("sku", sa.Text, nullable=False),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("response", sa.Text, nullable=False, comment="the JSON body as sent, replayed byte for byte"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )

    op.add_column("model_runs", sa.Column("week", sa.Date))
    op.execute("UPDATE model_runs SET week = date_trunc('week', as_of)::date")
    op.execute("DELETE FROM model_runs a USING model_runs b WHERE a.model = b.model AND a.week = b.week AND a.ran_at < b.ran_at")
    op.alter_column("model_runs", "week", nullable=False)
    op.create_unique_constraint("model_runs_model_week_key", "model_runs", ["model", "week"])

    op.add_column("weekly_briefs", sa.Column("week", sa.Date))
    op.execute("UPDATE weekly_briefs SET week = date_trunc('week', as_of)::date")
    op.execute("DELETE FROM weekly_briefs a USING weekly_briefs b WHERE a.week = b.week AND a.generated_at < b.generated_at")
    op.alter_column("weekly_briefs", "week", nullable=False)
    op.create_unique_constraint("weekly_briefs_week_key", "weekly_briefs", ["week"])


def downgrade() -> None:
    op.drop_constraint("weekly_briefs_week_key", "weekly_briefs")
    op.drop_column("weekly_briefs", "week")
    op.drop_constraint("model_runs_model_week_key", "model_runs")
    op.drop_column("model_runs", "week")
    op.drop_table("mock_supplier_orders")
    op.drop_index("supply_jobs_lease", "supply_jobs")
    op.drop_constraint("supply_jobs_supply_order_id_key", "supply_jobs")
    for c in ["quote", "supplier_idempotency_key", "supplier", "stage", "locked_by", "locked_until"]:
        op.drop_column("supply_jobs", c)
    op.drop_table("idempotency_keys")
