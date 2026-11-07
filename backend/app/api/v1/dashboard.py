from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter
from sqlalchemy import func, select

from app.core.deps import AuthGuard, DbSession
from app.core.errors import ok
from app.models import Comment, DailyMetric
from app.services.metrics import date_range, ensure_metrics
from app.api.v1._helpers import delta, resolve_range, previous_range

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

ADDITIVE_METRICS = {"gmv", "orders", "ad_spend", "gross_profit"}
SUPPORTED_METRICS = ADDITIVE_METRICS | {"roi", "gpm"}


async def _sum_metrics(db, shop_id: int, start: date, end: date) -> dict:
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(DailyMetric.impressions), 0),
                func.coalesce(func.sum(DailyMetric.clicks), 0),
                func.coalesce(func.sum(DailyMetric.visits), 0),
                func.coalesce(func.sum(DailyMetric.orders_count), 0),
                func.coalesce(func.sum(DailyMetric.gmv), 0),
                func.coalesce(func.sum(DailyMetric.ad_spend), 0),
                func.coalesce(func.sum(DailyMetric.gross_profit), 0),
                func.coalesce(func.sum(DailyMetric.break_even_sales), 0),
            ).where(
                DailyMetric.shop_id == shop_id,
                DailyMetric.date >= start,
                DailyMetric.date <= end,
            )
        )
    ).one()

    impressions, clicks, visits, orders, gmv, ad_spend, gross_profit, break_even = [float(v) for v in row]
    return {
        "impressions": impressions,
        "clicks": clicks,
        "visits": visits,
        "orders": orders,
        "gmv": round(gmv, 2),
        "ad_spend": round(ad_spend, 2),
        "gross_profit": round(gross_profit, 2),
        "break_even_sales": round(break_even, 2),
        "aov": round(gmv / orders, 2) if orders else None,
        "roi": round(gmv / ad_spend, 4) if ad_spend else None,
        "gpm": round(gmv * 1000 / impressions, 2) if impressions else None,
        "gross_margin": round(gross_profit / gmv, 4) if gmv else None,
        "break_even_rate": round(gmv / break_even, 4) if break_even else None,
        "ctr": round(clicks / impressions, 4) if impressions else None,
        "cvr": round(orders / clicks, 4) if clicks else None,
    }


@router.get("/overview")
async def overview(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    start: date | None = None,
    end: date | None = None,
):
    start_day, end_day = resolve_range(start, end)
    prev_start, prev_end = previous_range(start_day, end_day)
    await ensure_metrics(db, shop_id, prev_start, end_day)

    current = await _sum_metrics(db, shop_id, start_day, end_day)
    previous = await _sum_metrics(db, shop_id, prev_start, prev_end)
    deltas = {key: delta(current[key], previous[key]) for key in current}
    return ok(
        {
            "range": {
                "start": start_day.isoformat(),
                "end": end_day.isoformat(),
                "previous_start": prev_start.isoformat(),
                "previous_end": prev_end.isoformat(),
            },
            "current": current,
            "previous": previous,
            "deltas": deltas,
        }
    )


def _bucket(day: date, granularity: str) -> str:
    if granularity == "week":
        monday = day - timedelta(days=day.weekday())
        return f"{monday.isoformat()}周"
    if granularity == "month":
        return f"{day.year}-{day.month:02d}"
    return day.isoformat()


def _metric_value(raw: dict, metric: str) -> float | None:
    if metric == "roi":
        return round(raw["gmv"] / raw["ad_spend"], 4) if raw["ad_spend"] else None
    if metric == "gpm":
        return round(raw["gmv"] * 1000 / raw["impressions"], 2) if raw["impressions"] else None
    value = raw.get(metric, 0)
    return round(value, 2) if isinstance(value, float) else value


@router.get("/trend")
async def trend(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    metric: Literal["gmv", "orders", "ad_spend", "roi", "gpm", "gross_profit"] = "gmv",
    granularity: Literal["day", "week", "month"] = "day",
    start: date | None = None,
    end: date | None = None,
):
    start_day, end_day = resolve_range(start, end)
    prev_start, prev_end = previous_range(start_day, end_day)
    await ensure_metrics(db, shop_id, prev_start, end_day)

    async def load(range_start: date, range_end: date) -> list[DailyMetric]:
        return (
            await db.scalars(
                select(DailyMetric)
                .where(
                    DailyMetric.shop_id == shop_id,
                    DailyMetric.date >= range_start,
                    DailyMetric.date <= range_end,
                )
                .order_by(DailyMetric.date)
            )
        ).all()

    def aggregate(rows: list[DailyMetric]) -> list[tuple[str, float | None]]:
        buckets: dict[str, dict[str, float]] = defaultdict(
            lambda: {"gmv": 0.0, "orders": 0.0, "ad_spend": 0.0, "impressions": 0.0, "gross_profit": 0.0}
        )
        for row in rows:
            key = _bucket(row.date, granularity)
            buckets[key]["gmv"] += float(row.gmv)
            buckets[key]["orders"] += row.orders_count
            buckets[key]["ad_spend"] += float(row.ad_spend)
            buckets[key]["impressions"] += row.impressions
            buckets[key]["gross_profit"] += float(row.gross_profit or 0)
        return [(key, _metric_value(values, metric)) for key, values in buckets.items()]

    current_rows = await load(start_day, end_day)
    previous_rows = await load(prev_start, prev_end)
    current = aggregate(current_rows)
    previous = aggregate(previous_rows)

    return ok(
        {
            "metric": metric,
            "granularity": granularity,
            "dates": [key for key, _ in current],
            "current": [value for _, value in current],
            "previous": [value for _, value in previous][: len(current)],
            "previous_dates": [key for key, _ in previous][: len(current)],
        }
    )


@router.get("/funnel")
async def funnel(db: DbSession, _: AuthGuard, shop_id: int, start: date | None = None, end: date | None = None):
    start_day, end_day = resolve_range(start, end)
    prev_start, prev_end = previous_range(start_day, end_day)
    await ensure_metrics(db, shop_id, prev_start, end_day)

    async def steps(range_start: date, range_end: date) -> list[dict]:
        summary = await _sum_metrics(db, shop_id, range_start, range_end)
        values = [
            ("曝光", summary["impressions"]),
            ("点击", summary["clicks"]),
            ("进店", summary["visits"]),
            ("下单", summary["orders"]),
        ]
        result = []
        for index, (name, value) in enumerate(values):
            prev_value = values[index - 1][1] if index > 0 else None
            top_value = values[0][1]
            result.append(
                {
                    "name": name,
                    "value": value,
                    "rate_from_prev": round(value / prev_value, 4) if prev_value else None,
                    "rate_from_top": round(value / top_value, 4) if top_value else None,
                }
            )
        return result

    current = await steps(start_day, end_day)
    previous = await steps(prev_start, prev_end)
    return ok({"steps": current, "previous_steps": previous})


@router.get("/gpm-breakdown")
async def gpm_breakdown(db: DbSession, _: AuthGuard, shop_id: int, start: date | None = None, end: date | None = None):
    start_day, end_day = resolve_range(start, end)
    prev_start, prev_end = previous_range(start_day, end_day)
    await ensure_metrics(db, shop_id, prev_start, end_day)

    current = await _sum_metrics(db, shop_id, start_day, end_day)
    previous = await _sum_metrics(db, shop_id, prev_start, prev_end)

    series = (
        await db.scalars(
            select(DailyMetric)
            .where(DailyMetric.shop_id == shop_id, DailyMetric.date >= start_day, DailyMetric.date <= end_day)
            .order_by(DailyMetric.date)
        )
    ).all()

    waterfall = None
    ctr_prev, cvr_prev, aov_prev = previous["ctr"] or 0, previous["cvr"] or 0, previous["aov"] or 0
    ctr_now, cvr_now, aov_now = current["ctr"] or 0, current["cvr"] or 0, current["aov"] or 0
    if previous["gpm"] is not None and current["gpm"] is not None:
        base = round(1000 * ctr_prev * cvr_prev * aov_prev, 2)
        effect_ctr = round(1000 * (ctr_now - ctr_prev) * cvr_prev * aov_prev, 2)
        effect_cvr = round(1000 * ctr_now * (cvr_now - cvr_prev) * aov_prev, 2)
        effect_aov = round(1000 * ctr_now * cvr_now * (aov_now - aov_prev), 2)
        waterfall = [
            {"name": "上期 GPM", "value": base, "type": "base"},
            {"name": "CTR 影响", "value": effect_ctr, "type": "delta"},
            {"name": "CVR 影响", "value": effect_cvr, "type": "delta"},
            {"name": "AOV 影响", "value": effect_aov, "type": "delta"},
            {"name": "本期 GPM", "value": current["gpm"], "type": "total"},
        ]

    return ok(
        {
            "summary": {
                "impressions": current["impressions"],
                "clicks": current["clicks"],
                "orders": current["orders"],
                "gmv": current["gmv"],
                "ctr": current["ctr"],
                "cvr": current["cvr"],
                "aov": current["aov"],
                "gpm": current["gpm"],
            },
            "previous": {
                "ctr": previous["ctr"],
                "cvr": previous["cvr"],
                "aov": previous["aov"],
                "gpm": previous["gpm"],
            },
            "series": [
                {
                    "date": row.date.isoformat(),
                    "ctr": float(row.ctr) if row.ctr is not None else None,
                    "cvr": float(row.cvr) if row.cvr is not None else None,
                    "aov": float(row.aov) if row.aov is not None else None,
                    "gpm": float(row.gpm) if row.gpm is not None else None,
                }
                for row in series
            ],
            "waterfall": waterfall,
        }
    )


@router.get("/sentiment")
async def sentiment(db: DbSession, _: AuthGuard, shop_id: int, start: date | None = None, end: date | None = None):
    start_day, end_day = resolve_range(start, end)
    rows = (
        await db.scalars(
            select(Comment).where(
                Comment.shop_id == shop_id,
                Comment.comment_at >= start_day,
                Comment.comment_at <= end_day,
            )
        )
    ).all()

    distribution = Counter(row.sentiment or "unanalyzed" for row in rows)
    keywords: Counter[str] = Counter()
    for row in rows:
        for word in row.keywords or []:
            keywords[word] += 1

    total = len(rows)
    return ok(
        {
            "total": total,
            "distribution": [
                {
                    "sentiment": key,
                    "count": count,
                    "ratio": round(count / total, 4) if total else 0,
                }
                for key, count in distribution.most_common()
            ],
            "top_keywords": [{"word": word, "count": count} for word, count in keywords.most_common(15)],
        }
    )
