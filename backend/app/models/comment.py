from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, Index, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import JSONType, Base


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (
        UniqueConstraint("shop_id", "external_id", name="uq_comments_shop_external"),
        Index("ix_comments_shop_comment_at", "shop_id", "comment_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    shop_id: Mapped[int] = mapped_column(Integer, index=True)
    external_id: Mapped[str] = mapped_column(String(128))
    product_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    product_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content: Mapped[str] = mapped_column(Text)
    rating: Mapped[int] = mapped_column(Integer, default=5)
    like_count: Mapped[int] = mapped_column(Integer, default=0)
    comment_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    sentiment: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    sentiment_score: Mapped[Decimal | None] = mapped_column(Numeric(6, 4), nullable=True)
    keywords: Mapped[list | None] = mapped_column(JSONType, nullable=True)
    analyzer_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    analyzed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
