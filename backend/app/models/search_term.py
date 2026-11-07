from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SearchTerm(Base):
    """搜索词日粒度表现：channel=ad 为广告搜索词，channel=shop 为店铺搜索词。"""

    __tablename__ = "search_terms"
    __table_args__ = (
        UniqueConstraint("shop_id", "date", "channel", "term", name="uq_search_terms_shop_date_channel_term"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    shop_id: Mapped[int] = mapped_column(Integer, index=True)
    date: Mapped[date] = mapped_column(Date)
    channel: Mapped[str] = mapped_column(String(16), index=True)
    term: Mapped[str] = mapped_column(String(128))
    impressions: Mapped[int] = mapped_column(BigInteger, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    visits: Mapped[int] = mapped_column(Integer, default=0)
    orders_count: Mapped[int] = mapped_column(Integer, default=0)
    buyers: Mapped[int] = mapped_column(Integer, default=0)
    gmv: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    ad_spend: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
