from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.core.logging import logger
from app.core.deps import AuthGuard, DbSession
from app.core.errors import ProviderError, ok
from app.models import Shop, SyncLog
from app.schemas.shop import SyncRequest
from app.services.sync import SyncManager

router = APIRouter(prefix="/shops", tags=["sync"])


@router.post("/{shop_id}/sync")
async def trigger_sync(shop_id: int, payload: SyncRequest, db: DbSession, _: AuthGuard):
    shop = await db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=404, detail="店铺不存在")
    try:
        result = await SyncManager(db).run(shop, payload.resource, payload.mode, payload.days)
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=exc.message)
    except Exception as exc:
        logger.exception("manual sync failed")
        raise HTTPException(status_code=500, detail=f"同步失败: {exc}")
    return ok(result)


@router.get("/{shop_id}/sync-logs")
async def list_sync_logs(shop_id: int, db: DbSession, _: AuthGuard, limit: int = 50):
    logs = (
        await db.scalars(
            select(SyncLog).where(SyncLog.shop_id == shop_id).order_by(SyncLog.id.desc()).limit(limit)
        )
    ).all()
    return ok(
        [
            {
                "id": log.id,
                "resource": log.resource,
                "mode": log.mode,
                "started_at": log.started_at.isoformat() if log.started_at else None,
                "finished_at": log.finished_at.isoformat() if log.finished_at else None,
                "fetched_count": log.fetched_count,
                "status": log.status,
                "message": log.message,
            }
            for log in logs
        ]
    )
