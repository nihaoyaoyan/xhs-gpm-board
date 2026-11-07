from datetime import date, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import select

from app.core.config import settings
from app.core.logging import logger
from app.db.session import SessionLocal
from app.models import Shop
from app.services.metrics import refresh_daily_metrics
from app.services.sync import SyncManager

TZ = ZoneInfo("Asia/Shanghai")
scheduler = AsyncIOScheduler(timezone=TZ)


async def sync_all(resource: str) -> None:
    async with SessionLocal() as db:
        shops = (await db.scalars(select(Shop).where(Shop.status == "active"))).all()
        for shop in shops:
            try:
                await SyncManager(db).run(shop, resource, mode="incremental")
            except Exception:
                logger.exception("定时同步失败 shop=%s resource=%s", shop.id, resource)


async def recalc_recent_metrics() -> None:
    async with SessionLocal() as db:
        shops = (await db.scalars(select(Shop).where(Shop.status == "active"))).all()
        today = date.today()
        for shop in shops:
            try:
                await refresh_daily_metrics(db, shop.id, today - timedelta(days=6), today)
            except Exception:
                logger.exception("指标重算失败 shop=%s", shop.id)


def start_scheduler() -> None:
    if not settings.scheduler_enabled or scheduler.running:
        return

    scheduler.add_job(
        sync_all,
        IntervalTrigger(minutes=settings.sync_orders_minutes),
        args=["orders"],
        id="sync_orders",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    scheduler.add_job(
        sync_all,
        IntervalTrigger(minutes=settings.sync_ads_minutes),
        args=["ads"],
        id="sync_ads",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    scheduler.add_job(
        sync_all,
        IntervalTrigger(minutes=settings.sync_comments_minutes),
        args=["comments"],
        id="sync_comments",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=300,
    )
    scheduler.add_job(
        sync_all,
        CronTrigger(hour=settings.products_sync_cron_hour, minute=0, timezone=TZ),
        args=["products"],
        id="sync_products",
        max_instances=1,
        coalesce=True,
    )
    scheduler.add_job(
        recalc_recent_metrics,
        CronTrigger(hour=settings.metrics_recalc_cron_hour, minute=0, timezone=TZ),
        id="recalc_metrics",
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    logger.info("APScheduler started with %s jobs", len(scheduler.get_jobs()))


def stop_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("APScheduler stopped")
