from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Index, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AdRecord(Base):
    __tablename__ = "ad_records"
    __table_args__ = (
        UniqueConstraint("shop_id", "date", "campaign_id", name="uq_ads_shop_date_campaign"),
        Index("ix_ads_shop_date", "shop_id", "date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    shop_id: Mapped[int] = mapped_column(Integer, index=True)
    date: Mapped[date] = mapped_column(Date)
    campaign_id: Mapped[str] = mapped_column(String(128))
    campaign_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    spend: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    impressions: Mapped[int] = mapped_column(BigInteger, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    visits: Mapped[int] = mapped_column(Integer, default=0)
    gmv: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    order_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
