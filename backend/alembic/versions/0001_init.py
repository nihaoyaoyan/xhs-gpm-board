"""initial schema

Revision ID: 0001_init
Revises:
Create Date: 2026-11-06
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001_init"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_index("ix_users_username", "users", ["username"])

    op.create_table(
        "shops",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("qianfan_shop_id", sa.String(128), nullable=False),
        sa.Column("app_key", sa.String(128)),
        sa.Column("app_secret", sa.Text()),
        sa.Column("status", sa.String(32), server_default="active", nullable=False),
        sa.Column("timezone", sa.String(64), server_default="Asia/Shanghai", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("qianfan_shop_id", name="uq_shops_qianfan_shop_id"),
    )
    op.create_index("ix_shops_qianfan_shop_id", "shops", ["qianfan_shop_id"])

    op.create_table(
        "products",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(128), nullable=False),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("price", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("sku_count", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", "external_id", name="uq_products_shop_external"),
    )
    op.create_index("ix_products_shop_id", "products", ["shop_id"])

    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(128), nullable=False),
        sa.Column("product_id", sa.Integer()),
        sa.Column("product_title", sa.String(255)),
        sa.Column("sku_name", sa.String(128)),
        sa.Column("qty", sa.Integer(), server_default="1", nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("refund_amount", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("status", sa.String(32), server_default="paid", nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("raw", JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", "external_id", name="uq_orders_shop_external"),
    )
    op.create_index("ix_orders_shop_id", "orders", ["shop_id"])
    op.create_index("ix_orders_status", "orders", ["status"])
    op.create_index("ix_orders_shop_paid_at", "orders", ["shop_id", "paid_at"])

    op.create_table(
        "ad_records",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("campaign_id", sa.String(128), nullable=False),
        sa.Column("campaign_name", sa.String(128)),
        sa.Column("spend", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("impressions", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("clicks", sa.Integer(), server_default="0", nullable=False),
        sa.Column("visits", sa.Integer(), server_default="0", nullable=False),
        sa.Column("gmv", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("order_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", "date", "campaign_id", name="uq_ads_shop_date_campaign"),
    )
    op.create_index("ix_ad_records_shop_id", "ad_records", ["shop_id"])
    op.create_index("ix_ads_shop_date", "ad_records", ["shop_id", "date"])

    op.create_table(
        "comments",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(128), nullable=False),
        sa.Column("product_id", sa.Integer()),
        sa.Column("product_title", sa.String(255)),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("rating", sa.Integer(), server_default="5", nullable=False),
        sa.Column("like_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("comment_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sentiment", sa.String(16)),
        sa.Column("sentiment_score", sa.Numeric(6, 4)),
        sa.Column("keywords", JSONB()),
        sa.Column("analyzer_type", sa.String(16)),
        sa.Column("analyzed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", "external_id", name="uq_comments_shop_external"),
    )
    op.create_index("ix_comments_shop_id", "comments", ["shop_id"])
    op.create_index("ix_comments_sentiment", "comments", ["sentiment"])
    op.create_index("ix_comments_shop_comment_at", "comments", ["shop_id", "comment_at"])

    op.create_table(
        "daily_metrics",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("impressions", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("clicks", sa.Integer(), server_default="0", nullable=False),
        sa.Column("visits", sa.Integer(), server_default="0", nullable=False),
        sa.Column("orders_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("gmv", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("ad_spend", sa.Numeric(14, 2), server_default="0", nullable=False),
        sa.Column("ctr", sa.Numeric(8, 4)),
        sa.Column("cvr", sa.Numeric(8, 4)),
        sa.Column("aov", sa.Numeric(12, 2)),
        sa.Column("gpm", sa.Numeric(12, 2)),
        sa.Column("roi", sa.Numeric(8, 4)),
        sa.Column("gross_profit", sa.Numeric(14, 2)),
        sa.Column("gross_margin", sa.Numeric(8, 4)),
        sa.Column("break_even_sales", sa.Numeric(14, 2)),
        sa.Column("computed_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", "date", name="uq_daily_metrics_shop_date"),
    )
    op.create_index("ix_daily_metrics_shop_id", "daily_metrics", ["shop_id"])

    op.create_table(
        "shop_cost_configs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("cost_rate", sa.Numeric(6, 4), server_default="0.45", nullable=False),
        sa.Column("platform_fee_rate", sa.Numeric(6, 4), server_default="0.05", nullable=False),
        sa.Column("return_rate", sa.Numeric(6, 4), server_default="0.08", nullable=False),
        sa.Column("monthly_fixed_cost", sa.Numeric(14, 2), server_default="3000", nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("shop_id", name="uq_cost_config_shop"),
    )
    op.create_index("ix_shop_cost_configs_shop_id", "shop_cost_configs", ["shop_id"])

    op.create_table(
        "sync_states",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("resource", sa.String(32), nullable=False),
        sa.Column("cursor", sa.String(255)),
        sa.Column("last_synced_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("shop_id", "resource", name="uq_sync_state_shop_resource"),
    )
    op.create_index("ix_sync_states_shop_id", "sync_states", ["shop_id"])

    op.create_table(
        "sync_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("shop_id", sa.Integer(), nullable=False),
        sa.Column("resource", sa.String(32), nullable=False),
        sa.Column("mode", sa.String(32), server_default="incremental", nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("fetched_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status", sa.String(16), server_default="running", nullable=False),
        sa.Column("message", sa.Text()),
    )
    op.create_index("ix_sync_logs_shop_id", "sync_logs", ["shop_id"])


def downgrade() -> None:
    for table in (
        "sync_logs",
        "sync_states",
        "shop_cost_configs",
        "daily_metrics",
        "comments",
        "ad_records",
        "orders",
        "products",
        "shops",
        "users",
    ):
        op.drop_table(table)
