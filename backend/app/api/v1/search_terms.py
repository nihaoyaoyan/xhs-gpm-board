from datetime import date
from typing import Literal

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.v1._helpers import resolve_range
from app.core.deps import AuthGuard, DbSession
from app.core.errors import ok
from app.models import SearchTerm

router = APIRouter(prefix="/search-terms", tags=["search-terms"])

SORT_FIELDS = {"gmv", "ad_spend", "clicks", "orders", "buyers", "impressions"}


@router.get("")
async def analyze_search_terms(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    channel: Literal["ad", "shop", "note"] = "ad",
    start: date | None = None,
    end: date | None = None,
    keyword: str | None = None,
    sort: str = "gmv",
    limit: int = 100,
):
    start_day, end_day = resolve_range(start, end)

    columns = [
        SearchTerm.term,
        func.coalesce(func.sum(SearchTerm.impressions), 0),
        func.coalesce(func.sum(SearchTerm.clicks), 0),
        func.coalesce(func.sum(SearchTerm.visits), 0),
        func.coalesce(func.sum(SearchTerm.orders_count), 0),
        func.coalesce(func.sum(SearchTerm.buyers), 0),
        func.coalesce(func.sum(SearchTerm.gmv), 0),
        func.coalesce(func.sum(SearchTerm.ad_spend), 0),
    ]
    stmt = select(*columns).where(
        SearchTerm.shop_id == shop_id,
        SearchTerm.channel == channel,
        SearchTerm.date >= start_day,
        SearchTerm.date <= end_day,
    )
    if keyword:
        stmt = stmt.where(SearchTerm.term.ilike(f"%{keyword}%"))
    rows = (await db.execute(stmt.group_by(SearchTerm.term))).all()

    items = []
    for term, impressions, clicks, visits, orders, buyers, gmv, spend in rows:
        impressions, clicks, visits, orders, buyers = map(
            int, (impressions, clicks, visits, orders, buyers)
        )
        gmv, spend = float(gmv), float(spend)
        items.append(
            {
                "term": term,
                "impressions": impressions,
                "clicks": clicks,
                "visits": visits,
                "orders": orders,
                "buyers": buyers,
                "gmv": round(gmv, 2),
                "ad_spend": round(spend, 2),
                "ctr": round(clicks / impressions, 4) if impressions else None,
                "cvr": round(orders / clicks, 4) if clicks else None,
                "gpm": round(gmv * 1000 / impressions, 2) if impressions else None,
                "roi": round(gmv / spend, 4) if spend else None,
            }
        )

    impressions = sum(item["impressions"] for item in items)
    clicks = sum(item["clicks"] for item in items)
    visits = sum(item["visits"] for item in items)
    orders = sum(item["orders"] for item in items)
    buyers = sum(item["buyers"] for item in items)
    gmv = sum(item["gmv"] for item in items)
    spend = sum(item["ad_spend"] for item in items)
    summary = {
        "terms": len(items),
        "impressions": impressions,
        "clicks": clicks,
        "visits": visits,
        "orders": orders,
        "buyers": buyers,
        "gmv": round(gmv, 2),
        "ad_spend": round(spend, 2),
        "ctr": round(clicks / impressions, 4) if impressions else None,
        "cvr": round(orders / clicks, 4) if clicks else None,
        "gpm": round(gmv * 1000 / impressions, 2) if impressions else None,
        "roi": round(gmv / spend, 4) if spend else None,
    }

    for item in items:
        item["gmv_share"] = round(item["gmv"] / gmv, 4) if gmv else 0

    key = sort if sort in SORT_FIELDS else "gmv"
    items.sort(key=lambda item: item[key], reverse=True)
    items = items[: max(1, min(limit, 1000))]

    return ok(
        {
            "channel": channel,
            "range": {"start": start_day.isoformat(), "end": end_day.isoformat()},
            "summary": summary,
            "items": items,
        }
    )
