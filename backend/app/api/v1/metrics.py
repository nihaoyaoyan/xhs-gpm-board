from datetime import date

from fastapi import APIRouter
from sqlalchemy import select

from app.api.v1._helpers import resolve_range
from app.core.deps import AuthGuard, DbSession
from app.core.errors import ok
from app.models import DailyMetric
from app.services.metrics import ensure_metrics, get_cost_rates

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/daily")
async def daily_metrics(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    start: date | None = None,
    end: date | None = None,
):
    start_day, end_day = resolve_range(start, end)
    await ensure_metrics(db, shop_id, start_day, end_day)
    cost = await get_cost_rates(db, shop_id)
    rows = (
        await db.scalars(
            select(DailyMetric)
            .where(DailyMetric.shop_id == shop_id, DailyMetric.date >= start_day, DailyMetric.date <= end_day)
            .order_by(DailyMetric.date)
        )
    ).all()

    return ok(
        {
            "cost_config": {
                "cost_rate": cost.cost_rate,
                "platform_fee_rate": cost.platform_fee_rate,
                "return_rate": cost.return_rate,
                "monthly_fixed_cost": cost.monthly_fixed_cost,
            },
            "items": [
                {
                    "date": row.date.isoformat(),
                    "impressions": row.impressions,
                    "clicks": row.clicks,
                    "visits": row.visits,
                    "orders": row.orders_count,
                    "gmv": float(row.gmv),
                    "ad_spend": float(row.ad_spend),
                    "ctr": float(row.ctr) if row.ctr is not None else None,
                    "cvr": float(row.cvr) if row.cvr is not None else None,
                    "aov": float(row.aov) if row.aov is not None else None,
                    "gpm": float(row.gpm) if row.gpm is not None else None,
                    "roi": float(row.roi) if row.roi is not None else None,
                    "gross_profit": float(row.gross_profit) if row.gross_profit is not None else None,
                    "gross_margin": float(row.gross_margin) if row.gross_margin is not None else None,
                    "break_even_sales": float(row.break_even_sales) if row.break_even_sales is not None else None,
                }
                for row in rows
            ],
        }
    )
