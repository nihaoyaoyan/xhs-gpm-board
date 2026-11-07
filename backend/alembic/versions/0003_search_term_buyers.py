"""add buyers to search terms

Revision ID: 0003_search_term_buyers
Revises: 0002_search_terms
Create Date: 2026-11-06
"""

import sqlalchemy as sa
from alembic import op

revision = "0003_search_term_buyers"
down_revision = "0002_search_terms"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "search_terms",
        sa.Column("buyers", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("search_terms", "buyers")
