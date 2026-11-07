"""指标口径的唯一实现：所有 KPI 均在后端计算，前端只做展示。"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import AdRecord, DailyMetric, Order, ShopCostConfig


def safe_div(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None or denominator == 0:
        return None
    return numerator / denominator


def round_money(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


def round_ratio(value: float | None) -> float | None:
    return None if value is None else round(value, 4)


@dataclass
class CostRates:
    cost_rate: float = 0.45
    platform_fee_rate: float = 0.05
    return_rate: float = 0.08
    monthly_fixed_cost: float = 3000.0


def compute_metrics(
    *,
    impressions: int,
    clicks: int,
    visits: int,
    orders_count: int,
    gmv: float,
    ad_spend: float,
    cost: CostRates,
    days_in_month: int,
) -> dict[str, float | None]:
    ctr = safe_div(clicks, impressions)
    cvr = safe_div(orders_count, clicks)
    aov = safe_div(gmv, orders_count)
    gpm = round_money(safe_div(gmv * 1000, impressions))
    roi = round_ratio(safe_div(gmv, ad_spend))

    contribution = 1 - cost.cost_rate - cost.platform_fee_rate - cost.return_rate
    fixed_daily = cost.monthly_fixed_cost / days_in_month if days_in_month else 0
    gross_profit = round_money(gmv * contribution - ad_spend - fixed_daily)
    gross_margin = round_ratio(safe_div(gross_profit, gmv))
    break_even = round_money(safe_div(fixed_daily + ad_spend, contribution)) if contribution > 0 else None

    return {
        "ctr": round_ratio(ctr),
        "cvr": round_ratio(cvr),
        "aov": round_money(aov),
        "gpm": gpm,
        "roi": roi,
        "gross_profit": gross_profit,
        "gross_margin": gross_margin,
        "break_even_sales": break_even,
    }


def month_days(day: date) -> int:
    return calendar.monthrange(day.year, day.month)[1]


def date_range(start: date, end: date) -> list[date]:
    days: list[date] = []
    cursor = start
    while cursor <= end:
        days.append(cursor)
        cursor += timedelta(days=1)
    return days


def _to_date(value: Any) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


async def get_cost_rates(db: AsyncSession, shop_id: int) -> CostRates:
    config = await db.scalar(select(ShopCostConfig).where(ShopCostConfig.shop_id == shop_id))
    if config is None:
        return CostRates(
            cost_rate=settings.default_cost_rate,
            platform_fee_rate=settings.default_platform_fee_rate,
            return_rate=settings.default_return_rate,
            monthly_fixed_cost=settings.default_monthly_fixed_cost,
        )
    return CostRates(
        cost_rate=float(config.cost_rate),
        platform_fee_rate=float(config.platform_fee_rate),
        return_rate=float(config.return_rate),
        monthly_fixed_cost=float(config.monthly_fixed_cost),
    )


async def refresh_daily_metrics(db: AsyncSession, shop_id: int, start: date, end: date) -> int:
    """重算 [start, end] 的日指标并写入 daily_metrics（源数据为唯一事实来源）。"""
    if start > end:
        return 0

    order_stmt = (
        select(
            func.date(Order.paid_at).label("day"),
            func.count().label("cnt"),
            func.coalesce(func.sum(Order.amount), 0).label("amount"),
            func.coalesce(func.sum(Order.refund_amount), 0).label("refund"),
        )
        .where(Order.shop_id == shop_id, func.date(Order.paid_at) >= start, func.date(Order.paid_at) <= end)
        .group_by(func.date(Order.paid_at))
    )
    order_map = {
        _to_date(row.day): (int(row.cnt), float(row.amount), float(row.refund))
        for row in (await db.execute(order_stmt)).all()
    }

    ad_stmt = (
        select(
            AdRecord.date,
            func.coalesce(func.sum(AdRecord.impressions), 0).label("impressions"),
            func.coalesce(func.sum(AdRecord.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AdRecord.visits), 0).label("visits"),
            func.coalesce(func.sum(AdRecord.spend), 0).label("spend"),
        )
        .where(AdRecord.shop_id == shop_id, AdRecord.date >= start, AdRecord.date <= end)
        .group_by(AdRecord.date)
    )
    ad_map = {
        _to_date(row.date): (int(row.impressions), int(row.clicks), int(row.visits), float(row.spend))
        for row in (await db.execute(ad_stmt)).all()
    }

    cost = await get_cost_rates(db, shop_id)
    existing = {
        _to_date(row.date): row
        for row in (
            await db.scalars(
                select(DailyMetric).where(
                    DailyMetric.shop_id == shop_id, DailyMetric.date >= start, DailyMetric.date <= end
                )
            )
        ).all()
    }

    written = 0
    for day in date_range(start, end):
        orders_count, amount, refund = order_map.get(day, (0, 0.0, 0.0))
        impressions, clicks, visits, spend = ad_map.get(day, (0, 0, 0, 0.0))
        gmv = max(amount - refund, 0.0)
        values = compute_metrics(
            impressions=impressions,
            clicks=clicks,
            visits=visits,
            orders_count=orders_count,
            gmv=gmv,
            ad_spend=spend,
            cost=cost,
            days_in_month=month_days(day),
        )

        metric = existing.get(day)
        if metric is None:
            metric = DailyMetric(shop_id=shop_id, date=day)
            db.add(metric)
        metric.impressions = impressions
        metric.clicks = clicks
        metric.visits = visits
        metric.orders_count = orders_count
        metric.gmv = Decimal(str(round(gmv, 2)))
        metric.ad_spend = Decimal(str(round(spend, 2)))
        metric.ctr = values["ctr"]
        metric.cvr = values["cvr"]
        metric.aov = values["aov"]
        metric.gpm = values["gpm"]
        metric.roi = values["roi"]
        metric.gross_profit = values["gross_profit"]
        metric.gross_margin = values["gross_margin"]
        metric.break_even_sales = values["break_even_sales"]
        metric.computed_at = datetime.now(timezone.utc)
        written += 1

    await db.commit()
    return written


async def ensure_metrics(db: AsyncSession, shop_id: int, start: date, end: date) -> None:
    """读路径兜底：区间内完全没有日指标时按需回算。"""
    count = await db.scalar(
        select(func.count()).select_from(DailyMetric).where(
            DailyMetric.shop_id == shop_id, DailyMetric.date >= start, DailyMetric.date <= end
        )
    )
    if not count:
        await refresh_daily_metrics(db, shop_id, start, end)
