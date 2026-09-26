"""llm_calls: one row per language model request, with its token use and cost.

Revision ID: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "llm_calls",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("purpose", sa.Text, nullable=False, comment="chat | weekly_brief"),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("input_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer, nullable=False, server_default="0"),
        sa.Column("latency_ms", sa.Integer, nullable=False),
        sa.Column("tool_rounds", sa.Integer, nullable=False, server_default="0"),
        sa.Column("request_id", sa.Text),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("error", sa.Text),
    )
    op.create_index("llm_calls_created", "llm_calls", [sa.text("created_at DESC")])


def downgrade() -> None:
    op.drop_table("llm_calls")
