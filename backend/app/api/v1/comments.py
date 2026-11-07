from datetime import date, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from app.api.v1._helpers import iso, resolve_range
from app.core.deps import AuthGuard, CurrentUser, DbSession
from app.core.errors import ok
from app.models import Comment
from app.schemas.shop import ReanalyzeRequest
from app.services.nlp.factory import get_analyzer

router = APIRouter(prefix="/comments", tags=["comments"])


def _payload(row: Comment) -> dict:
    return {
        "id": row.id,
        "external_id": row.external_id,
        "product_title": row.product_title,
        "content": row.content,
        "rating": row.rating,
        "like_count": row.like_count,
        "comment_at": iso(row.comment_at),
        "sentiment": row.sentiment,
        "sentiment_score": float(row.sentiment_score) if row.sentiment_score is not None else None,
        "keywords": row.keywords or [],
        "analyzer_type": row.analyzer_type,
    }


@router.get("")
async def list_comments(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    sentiment: str | None = None,
    keyword: str | None = None,
    start: date | None = None,
    end: date | None = None,
    page: int = 1,
    page_size: int = 20,
):
    start_day, end_day = resolve_range(start, end)
    page = max(page, 1)
    page_size = min(max(page_size, 1), 100)

    conditions = [
        Comment.shop_id == shop_id,
        Comment.comment_at >= datetime.combine(start_day, datetime.min.time()),
        Comment.comment_at <= datetime.combine(end_day, datetime.max.time()),
    ]
    if sentiment:
        conditions.append(Comment.sentiment == sentiment)
    if keyword:
        conditions.append(Comment.content.ilike(f"%{keyword}%"))

    total = await db.scalar(select(func.count()).select_from(Comment).where(*conditions))
    rows = (
        await db.scalars(
            select(Comment)
            .where(*conditions)
            .order_by(Comment.comment_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return ok({"items": [_payload(row) for row in rows], "total": total or 0, "page": page, "page_size": page_size})


@router.post("/{comment_id}/analyze")
async def analyze_one(comment_id: int, db: DbSession, _: CurrentUser):
    row = await db.get(Comment, comment_id)
    if row is None:
        raise HTTPException(status_code=404, detail="评论不存在")
    result = await get_analyzer().analyze(row.content)
    row.sentiment = result.sentiment
    row.sentiment_score = result.score
    row.keywords = result.keywords
    row.analyzer_type = result.analyzer_type
    row.analyzed_at = datetime.now()
    await db.commit()
    return ok(_payload(row))


@router.post("/reanalyze")
async def reanalyze(payload: ReanalyzeRequest, db: DbSession, _: CurrentUser):
    conditions = [Comment.shop_id == payload.shop_id]
    if payload.start:
        conditions.append(Comment.comment_at >= datetime.combine(date.fromisoformat(payload.start), datetime.min.time()))
    if payload.end:
        conditions.append(Comment.comment_at <= datetime.combine(date.fromisoformat(payload.end), datetime.max.time()))

    rows = (
        await db.scalars(select(Comment).where(*conditions).order_by(Comment.id.desc()).limit(payload.limit))
    ).all()
    analyzer = get_analyzer()
    for start in range(0, len(rows), 20):
        batch = list(rows[start : start + 20])
        results = await analyzer.analyze_batch([item.content for item in batch])
        for item, result in zip(batch, results, strict=False):
            item.sentiment = result.sentiment
            item.sentiment_score = result.score
            item.keywords = result.keywords
            item.analyzer_type = result.analyzer_type
            item.analyzed_at = datetime.now()
    await db.commit()
    return ok({"analyzed": len(rows)})
