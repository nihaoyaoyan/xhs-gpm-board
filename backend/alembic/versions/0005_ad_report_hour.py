"""add hour column for hourly report rows

Revision ID: 0005_ad_report_hour
Revises: 0004_ad_report_rows
Create Date: 2026-11-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0005_ad_report_hour"
down_revision = "0004_ad_report_rows"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("ad_report_rows") as batch_op:
        batch_op.add_column(sa.Column("hour", sa.Integer(), nullable=False, server_default="-1"))
        batch_op.drop_constraint("uq_ad_report_rows_shop_date_level_dim", type_="unique")
        batch_op.create_unique_constraint(
            "uq_ad_report_rows_shop_date_level_dim_hour",
            ["shop_id", "date", "level", "dimension_id", "hour"],
        )


def downgrade() -> None:
    with op.batch_alter_table("ad_report_rows") as batch_op:
        batch_op.drop_constraint("uq_ad_report_rows_shop_date_level_dim_hour", type_="unique")
        batch_op.create_unique_constraint(
            "uq_ad_report_rows_shop_date_level_dim",
            ["shop_id", "date", "level", "dimension_id"],
        )
        batch_op.drop_column("hour")
