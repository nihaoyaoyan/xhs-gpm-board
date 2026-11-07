from datetime import date

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from app.api.v1._helpers import delta, previous_range, resolve_range
from app.core.deps import AuthGuard, DbSession
from app.core.errors import ok
from app.models import AdReportRow

router = APIRouter(prefix="/ad-reports", tags=["ad-reports"])

LEVELS = {
    "account": "账户",
    "campaign": "计划",
    "creativity": "创意",
    "note": "笔记",
    "keyword": "关键词",
    "spu": "商品",
    "live": "直播间",
}

METRIC_COLUMNS = (
    func.coalesce(func.sum(AdReportRow.spend), 0),
    func.coalesce(func.sum(AdReportRow.impressions), 0),
    func.coalesce(func.sum(AdReportRow.clicks), 0),
    func.coalesce(func.sum(AdReportRow.total_orders), 0),
    func.coalesce(func.sum(AdReportRow.total_gmv), 0),
    func.coalesce(func.sum(AdReportRow.deal_orders), 0),
    func.coalesce(func.sum(AdReportRow.deal_gmv), 0),
)


def _metrics(spend, impressions, clicks, orders, gmv, deal_orders, deal_gmv) -> dict:
    spend, impressions, clicks, orders, gmv, deal_orders, deal_gmv = map(
        float, (spend, impressions, clicks, orders, gmv, deal_orders, deal_gmv)
    )
    return {
        "spend": round(spend, 2),
        "impressions": int(impressions),
        "clicks": int(clicks),
        "ctr": round(clicks / impressions, 6) if impressions else None,
        "acp": round(spend / clicks, 4) if clicks else None,
        "cpm": round(spend * 1000 / impressions, 4) if impressions else None,
        "total_orders": int(orders),
        "total_gmv": round(gmv, 2),
        "deal_orders": int(deal_orders),
        "deal_gmv": round(deal_gmv, 2),
        "roi": round(gmv / spend, 4) if spend else None,
    }


def _totals(row) -> dict:
    return _metrics(*row)


def _scope(shop_id: int, level: str, granularity: str):
    """公共过滤条件；分时只取 hour>=0，按日只取 hour=-1。"""
    return [
        AdReportRow.shop_id == shop_id,
        AdReportRow.level == level,
        AdReportRow.hour >= 0 if granularity == "hour" else AdReportRow.hour == -1,
    ]


async def _summary(db, shop_id: int, level: str, start: date, end: date, granularity: str) -> dict:
    row = (
        await db.execute(
            select(*METRIC_COLUMNS).where(
                *_scope(shop_id, level, granularity),
                AdReportRow.date >= start,
                AdReportRow.date <= end,
            )
        )
    ).one()
    return _totals(row)


async def _coverage(db, shop_id: int, level: str) -> tuple[dict | None, dict | None]:
    hour_row = (
        await db.execute(
            select(func.min(AdReportRow.date), func.max(AdReportRow.date)).where(
                AdReportRow.shop_id == shop_id,
                AdReportRow.level == level,
                AdReportRow.hour >= 0,
            )
        )
    ).one()
    day_row = (
        await db.execute(
            select(func.min(AdReportRow.date), func.max(AdReportRow.date)).where(
                AdReportRow.shop_id == shop_id,
                AdReportRow.level == level,
                AdReportRow.hour == -1,
            )
        )
    ).one()
    hour_range = (
        {"start": hour_row[0].isoformat(), "end": hour_row[1].isoformat()} if hour_row[0] else None
    )
    data_range = {"start": day_row[0].isoformat(), "end": day_row[1].isoformat()} if day_row[0] else None
    return hour_range, data_range


@router.get("")
async def ad_reports(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    level: str = "account",
    granularity: str = "day",
    start: date | None = None,
    end: date | None = None,
):
    if level not in LEVELS:
        raise HTTPException(status_code=400, detail=f"level 需为 {', '.join(LEVELS)}")
    if granularity not in ("day", "hour"):
        raise HTTPException(status_code=400, detail="granularity 需为 day 或 hour")

    start_day, end_day = resolve_range(start, end)
    current = await _summary(db, shop_id, level, start_day, end_day, granularity)
    prev_start, prev_end = previous_range(start_day, end_day)
    previous = await _summary(db, shop_id, level, prev_start, prev_end, granularity)

    deltas = {
        key: delta(current[key], previous[key])
        for key in ("spend", "impressions", "clicks", "ctr", "roi", "total_orders", "total_gmv")
    }

    if granularity == "hour":
        series_rows = (
            await db.execute(
                select(AdReportRow.date, AdReportRow.hour, *METRIC_COLUMNS)
                .where(
                    *_scope(shop_id, level, granularity),
                    AdReportRow.date >= start_day,
                    AdReportRow.date <= end_day,
                )
                .group_by(AdReportRow.date, AdReportRow.hour)
                .order_by(AdReportRow.date, AdReportRow.hour)
            )
        ).all()
        series = [
            {"date": day.isoformat(), "hour": int(hour), **_totals(row)}
            for day, hour, *row in series_rows
        ]
    else:
        series_rows = (
            await db.execute(
                select(AdReportRow.date, *METRIC_COLUMNS)
                .where(
                    *_scope(shop_id, level, granularity),
                    AdReportRow.date >= start_day,
                    AdReportRow.date <= end_day,
                )
                .group_by(AdReportRow.date)
                .order_by(AdReportRow.date)
            )
        ).all()
        series = [{"date": day.isoformat(), **_totals(row)} for day, *row in series_rows]

    if granularity == "hour":
        # 分时明细统一按时间展示，对象维度请看按日视图
        rows = list(reversed(series))
    elif level == "account":
        rows = list(reversed(series))
    elif level == "keyword":
        detail_rows = (
            await db.execute(
                select(AdReportRow.dimension_name, *METRIC_COLUMNS)
                .where(
                    *_scope(shop_id, level, granularity),
                    AdReportRow.date >= start_day,
                    AdReportRow.date <= end_day,
                )
                .group_by(AdReportRow.dimension_name)
                .order_by(func.sum(AdReportRow.spend).desc())
                .limit(2000)
            )
        ).all()
        rows = [
            {"dimension_id": name, "name": name, **_totals(row)}
            for name, *row in detail_rows
            if name
        ]
    else:
        detail_rows = (
            await db.execute(
                select(
                    AdReportRow.dimension_id,
                    AdReportRow.dimension_name,
                    *METRIC_COLUMNS,
                )
                .where(
                    *_scope(shop_id, level, granularity),
                    AdReportRow.date >= start_day,
                    AdReportRow.date <= end_day,
                )
                .group_by(AdReportRow.dimension_id, AdReportRow.dimension_name)
                .order_by(func.sum(AdReportRow.spend).desc())
                .limit(2000)
            )
        ).all()
        rows = [
            {"dimension_id": dim_id, "name": name or dim_id, **_totals(row)}
            for dim_id, name, *row in detail_rows
        ]

    hour_range, data_range = await _coverage(db, shop_id, level)

    return ok(
        {
            "level": level,
            "level_label": LEVELS[level],
            "granularity": granularity,
            "range": {"start": start_day.isoformat(), "end": end_day.isoformat()},
            "previous_range": {"start": prev_start.isoformat(), "end": prev_end.isoformat()},
            "hour_range": hour_range,
            "data_range": data_range,
            "summary": current,
            "previous": previous,
            "deltas": deltas,
            "series": series,
            "rows": rows,
        }
    )
