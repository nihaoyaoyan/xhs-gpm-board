from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, Integer, Numeric, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DailyMetric(Base):
    __tablename__ = "daily_metrics"
    __table_args__ = (UniqueConstraint("shop_id", "date", name="uq_daily_metrics_shop_date"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    shop_id: Mapped[int] = mapped_column(Integer, index=True)
    date: Mapped[date] = mapped_column(Date)
    impressions: Mapped[int] = mapped_column(BigInteger, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    visits: Mapped[int] = mapped_column(Integer, default=0)
    orders_count: Mapped[int] = mapped_column(Integer, default=0)
    gmv: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    ad_spend: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0)
    ctr: Mapped[Decimal | None] = mapped_column(Numeric(8, 4), nullable=True)
    cvr: Mapped[Decimal | None] = mapped_column(Numeric(8, 4), nullable=True)
    aov: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    gpm: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    roi: Mapped[Decimal | None] = mapped_column(Numeric(8, 4), nullable=True)
    gross_profit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    gross_margin: Mapped[Decimal | None] = mapped_column(Numeric(8, 4), nullable=True)
    break_even_sales: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ShopCostConfig(Base):
    __tablename__ = "shop_cost_configs"
    __table_args__ = (UniqueConstraint("shop_id", name="uq_cost_config_shop"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    shop_id: Mapped[int] = mapped_column(Integer, index=True)
    cost_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=0.45)
    platform_fee_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=0.05)
    return_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=0.08)
    monthly_fixed_cost: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=3000)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
