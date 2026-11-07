"""add search terms

Revision ID: 0002_search_terms
Revises: 0001_init
Create Date: 2026-11-06
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_search_terms"
down_revision = "0001_init"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "search_terms",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("term", sa.String(128), nullable=False),
        sa.Column("impressions", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("clicks", sa.Integer(), server_default="0", nullable=False),
        sa.Column("visits", sa.Integer(), server_default="0", nullable=False),
        sa.Column("orders_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("gmv", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("ad_spend", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", "date", "channel", "term", name="uq_search_terms_shop_date_channel_term"),
    )
    op.create_index("ix_search_terms_shop_channel_date", "search_terms", ["shop_id", "channel", "date"])


def downgrade() -> None:
    op.drop_index("ix_search_terms_shop_channel_date", table_name="search_terms")
    op.drop_table("search_terms")
