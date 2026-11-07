from datetime import date

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.v1._helpers import resolve_range
from app.core.deps import AuthGuard, DbSession
from app.core.errors import ok
from app.models import AdRecord

router = APIRouter(prefix="/ads", tags=["ads"])


@router.get("")
async def list_ads(db: DbSession, _: AuthGuard, shop_id: int, start: date | None = None, end: date | None = None):
    start_day, end_day = resolve_range(start, end)
    rows = (
        await db.execute(
            select(
                AdRecord.date,
                func.coalesce(func.sum(AdRecord.spend), 0),
                func.coalesce(func.sum(AdRecord.impressions), 0),
                func.coalesce(func.sum(AdRecord.clicks), 0),
                func.coalesce(func.sum(AdRecord.visits), 0),
                func.coalesce(func.sum(AdRecord.gmv), 0),
                func.coalesce(func.sum(AdRecord.order_count), 0),
            )
            .where(AdRecord.shop_id == shop_id, AdRecord.date >= start_day, AdRecord.date <= end_day)
            .group_by(AdRecord.date)
            .order_by(AdRecord.date)
        )
    ).all()

    items = []
    for day, spend, impressions, clicks, visits, gmv, order_count in rows:
        spend, impressions, clicks, visits, gmv, order_count = map(float, (spend, impressions, clicks, visits, gmv, order_count))
        items.append(
            {
                "date": day.isoformat(),
                "spend": round(spend, 2),
                "impressions": int(impressions),
                "clicks": int(clicks),
                "visits": int(visits),
                "gmv": round(gmv, 2),
                "order_count": int(order_count),
                "ctr": round(clicks / impressions, 4) if impressions else None,
                "cvr": round(order_count / clicks, 4) if clicks else None,
                "roi": round(gmv / spend, 4) if spend else None,
                "gpm": round(gmv * 1000 / impressions, 2) if impressions else None,
            }
        )
    return ok(items)
