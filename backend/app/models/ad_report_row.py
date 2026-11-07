from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Float, Index, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AdReportRow(Base):
    """乘风离线报表落地表：level 取 account/campaign/creativity/note/keyword/spu/live。

    dimension_id 为各层级对象标识；关键词层级为 "campaign_id:keyword" 以保证唯一。
    hour 为分时小时（0-23），按日汇总行为 -1；成交指标为报表的 7 天归因口径（total_*_7d / deal_*_7d）。
    """

    __tablename__ = "ad_report_rows"
    __table_args__ = (
        UniqueConstraint(
            "shop_id", "date", "level", "dimension_id", "hour", name="uq_ad_report_rows_shop_date_level_dim_hour"
        ),
        Index("ix_ad_report_rows_shop_level_date", "shop_id", "level", "date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    shop_id: Mapped[int] = mapped_column(Integer, index=True)
    date: Mapped[date] = mapped_column(Date)
    hour: Mapped[int] = mapped_column(Integer, default=-1)
    level: Mapped[str] = mapped_column(String(12))
    dimension_id: Mapped[str] = mapped_column(String(96))
    dimension_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    spend: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    impressions: Mapped[int] = mapped_column(BigInteger, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    ctr: Mapped[float] = mapped_column(Float, default=0)
    acp: Mapped[float] = mapped_column(Float, default=0)
    cpm: Mapped[float] = mapped_column(Float, default=0)
    goods_views: Mapped[int] = mapped_column(Integer, default=0)
    add_cart: Mapped[int] = mapped_column(Integer, default=0)
    total_orders: Mapped[int] = mapped_column(Integer, default=0)
    total_gmv: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    deal_orders: Mapped[int] = mapped_column(Integer, default=0)
    deal_gmv: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    raw_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
