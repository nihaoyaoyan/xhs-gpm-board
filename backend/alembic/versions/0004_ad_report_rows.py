"""add unified ad report rows

Revision ID: 0004_ad_report_rows
Revises: 0003_search_term_buyers
Create Date: 2026-11-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0004_ad_report_rows"
down_revision = "0003_search_term_buyers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ad_report_rows",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("level", sa.String(12), nullable=False),
        sa.Column("dimension_id", sa.String(96), nullable=False),
        sa.Column("dimension_name", sa.String(255), nullable=True),
        sa.Column("spend", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("impressions", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("clicks", sa.Integer(), server_default="0", nullable=False),
        sa.Column("ctr", sa.Float(), server_default="0", nullable=False),
        sa.Column("acp", sa.Float(), server_default="0", nullable=False),
        sa.Column("cpm", sa.Float(), server_default="0", nullable=False),
        sa.Column("goods_views", sa.Integer(), server_default="0", nullable=False),
        sa.Column("add_cart", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_orders", sa.Integer(), server_default="0", nullable=False),
        sa.Column("total_gmv", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("deal_orders", sa.Integer(), server_default="0", nullable=False),
        sa.Column("deal_gmv", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("raw_json", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint(
            "shop_id", "date", "level", "dimension_id", name="uq_ad_report_rows_shop_date_level_dim"
        ),
    )
    op.create_index("ix_ad_report_rows_shop_level_date", "ad_report_rows", ["shop_id", "level", "date"])


def downgrade() -> None:
    op.drop_index("ix_ad_report_rows_shop_level_date", table_name="ad_report_rows")
    op.drop_table("ad_report_rows")
