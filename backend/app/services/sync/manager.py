"""同步编排：游标增量、幂等 upsert、同步审计、评论分析与指标回算。"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import logger
from app.models import AdRecord, Comment, Order, Product, SearchTerm, SyncLog, SyncState
from app.services.metrics import refresh_daily_metrics
from app.services.nlp.factory import get_analyzer
from app.services.providers.base import SyncProvider, get_provider

TZ = ZoneInfo("Asia/Shanghai")
RESOURCES = {"products", "orders", "ads", "comments", "search_terms"}
MAX_PAGES = 200


class SyncManager:
    def __init__(self, db: AsyncSession, provider: SyncProvider | None = None) -> None:
        self.db = db
        self.provider = provider or get_provider()

    async def run(
        self, shop, resource: str, mode: str = "incremental", days: int = 90
    ) -> dict[str, Any]:
        if resource not in RESOURCES:
            raise ValueError(f"不支持的同步资源: {resource}")

        log = SyncLog(
            shop_id=shop.id,
            resource=resource,
            mode=mode,
            status="running",
            started_at=datetime.now(TZ),
        )
        self.db.add(log)
        await self.db.commit()
        await self.db.refresh(log)
        log_id = log.id

        try:
            since, until = await self._window(shop, resource, mode, days)
            fetched, cursor = await self._sync_resource(shop, resource, since, until)

            if resource == "comments":
                await self._analyze_comments(shop, since, until)
            if resource in ("orders", "ads"):
                end_day = min(until.date(), date.today())
                await refresh_daily_metrics(self.db, shop.id, since.date(), end_day)

            await self._save_state(shop, resource, cursor, until)

            row = await self.db.get(SyncLog, log_id)
            if row is not None:
                row.status = "success"
                row.fetched_count = fetched
                row.finished_at = datetime.now(TZ)
                row.message = f"{since.date()} ~ {until.date()} 拉取 {fetched} 条"
            await self.db.commit()
            logger.info("sync ok shop=%s resource=%s fetched=%s", shop.id, resource, fetched)
            return {"log_id": log_id, "resource": resource, "fetched": fetched, "status": "success"}
        except Exception as exc:
            await self.db.rollback()
            row = await self.db.get(SyncLog, log_id)
            if row is not None:
                row.status = "failed"
                row.finished_at = datetime.now(TZ)
                row.message = str(exc)[:500]
                await self.db.commit()
            logger.exception("sync failed shop=%s resource=%s", shop.id, resource)
            raise

    async def _window(self, shop, resource: str, mode: str, days: int):
        now = datetime.now(TZ)
        state = await self.db.scalar(
            select(SyncState).where(SyncState.shop_id == shop.id, SyncState.resource == resource)
        )
        if mode == "backfill" or state is None or state.last_synced_at is None:
            since = datetime.combine((now - timedelta(days=days)).date(), time.min, tzinfo=TZ)
        else:
            since = state.last_synced_at
            if since.tzinfo is None:
                since = since.replace(tzinfo=TZ)
            # 回溯 1 天，覆盖迟到订单 / 状态变更
            since = since - timedelta(days=1)
        return since, now

    async def _sync_resource(self, shop, resource: str, since: datetime, until: datetime):
        if resource == "products":
            rows = await self.provider.fetch_products(shop, since, until)
            mapped = [
                {
                    "shop_id": shop.id,
                    "external_id": row["external_id"],
                    "title": row["title"],
                    "price": Decimal(str(round(float(row["price"]), 2))),
                    "sku_count": int(row.get("sku_count") or 1),
                }
                for row in rows
                if row.get("external_id")
            ]
            await self._upsert(Product, mapped, ["shop_id", "external_id"], ["title", "price", "sku_count"])
            return len(mapped), None

        if resource == "ads":
            rows = await self.provider.fetch_ads(shop, since, until)
            mapped = [
                {
                    "shop_id": shop.id,
                    "date": row["date"],
                    "campaign_id": row["campaign_id"],
                    "campaign_name": row.get("campaign_name"),
                    "spend": Decimal(str(round(float(row["spend"]), 2))),
                    "impressions": int(row.get("impressions") or 0),
                    "clicks": int(row.get("clicks") or 0),
                    "visits": int(row.get("visits") or 0),
                    "gmv": Decimal(str(round(float(row.get("gmv") or 0), 2))),
                    "order_count": int(row.get("order_count") or 0),
                }
                for row in rows
                if row.get("campaign_id")
            ]
            await self._upsert(
                AdRecord,
                mapped,
                ["shop_id", "date", "campaign_id"],
                ["campaign_name", "spend", "impressions", "clicks", "visits", "gmv", "order_count"],
            )
            return len(mapped), None

        if resource == "search_terms":
            rows = await self.provider.fetch_search_terms(shop, since, until)
            mapped = [
                {
                    "shop_id": shop.id,
                    "date": row["date"],
                    "channel": str(row["channel"]),
                    "term": str(row["term"]),
                    "impressions": int(row.get("impressions") or 0),
                    "clicks": int(row.get("clicks") or 0),
                    "visits": int(row.get("visits") or 0),
                    "orders_count": int(row.get("order_count") or 0),
                    "buyers": int(row.get("buyers") or row.get("order_count") or 0),
                    "gmv": Decimal(str(round(float(row.get("gmv") or 0), 2))),
                    "ad_spend": Decimal(str(round(float(row.get("spend") or 0), 2))),
                }
                for row in rows
                if row.get("term")
            ]
            await self._upsert(
                SearchTerm,
                mapped,
                ["shop_id", "date", "channel", "term"],
                ["impressions", "clicks", "visits", "orders_count", "buyers", "gmv", "ad_spend"],
            )
            return len(mapped), None

        cursor: str | None = None
        fetched = 0
        for _ in range(MAX_PAGES):
            if resource == "orders":
                page = await self.provider.fetch_orders(shop, since, until, cursor)
                mapped = [self._order_row(shop.id, row) for row in page.rows if row.get("external_id")]
                await self._upsert(
                    Order,
                    mapped,
                    ["shop_id", "external_id"],
                    ["product_id", "product_title", "sku_name", "qty", "amount", "refund_amount", "status", "paid_at", "raw"],
                )
            else:
                page = await self.provider.fetch_comments(shop, since, until, cursor)
                mapped = [self._comment_row(shop.id, row) for row in page.rows if row.get("external_id")]
                await self._upsert(
                    Comment,
                    mapped,
                    ["shop_id", "external_id"],
                    ["product_id", "product_title", "content", "rating", "like_count", "comment_at"],
                )
            fetched += len(mapped)
            cursor = page.next_cursor
            if not cursor:
                break

        return fetched, cursor

    @staticmethod
    def _order_row(shop_id: int, row: dict) -> dict:
        return {
            "shop_id": shop_id,
            "external_id": str(row["external_id"]),
            "product_id": row.get("product_id"),
            "product_title": row.get("product_title"),
            "sku_name": row.get("sku_name"),
            "qty": int(row.get("qty") or 1),
            "amount": Decimal(str(round(float(row.get("amount") or 0), 2))),
            "refund_amount": Decimal(str(round(float(row.get("refund_amount") or 0), 2))),
            "status": str(row.get("status") or "paid"),
            "paid_at": row["paid_at"],
            "raw": row.get("raw"),
        }

    @staticmethod
    def _comment_row(shop_id: int, row: dict) -> dict:
        return {
            "shop_id": shop_id,
            "external_id": str(row["external_id"]),
            "product_id": row.get("product_id"),
            "product_title": row.get("product_title"),
            "content": str(row.get("content") or ""),
            "rating": int(row.get("rating") or 5),
            "like_count": int(row.get("like_count") or 0),
            "comment_at": row["comment_at"],
        }

    async def _upsert(
        self,
        model,
        rows: list[dict],
        conflict_cols: list[str],
        update_cols: list[str],
    ) -> int:
        if not rows:
            return 0

        bind = self.db.bind
        dialect = getattr(getattr(bind, "dialect", None), "name", "") or "postgresql"

        if dialect == "postgresql":
            for start in range(0, len(rows), 300):
                chunk = rows[start : start + 300]
                stmt = pg_insert(model).values(chunk)
                stmt = stmt.on_conflict_do_update(
                    index_elements=conflict_cols,
                    set_={col: getattr(stmt.excluded, col) for col in update_cols},
                )
                await self.db.execute(stmt)
        else:
            # 本地 SQLite 冒烟运行时的逐行兼容分支
            for row in rows:
                conditions = [getattr(model, col) == row[col] for col in conflict_cols]
                existing = await self.db.scalar(select(model).where(*conditions))
                if existing is None:
                    self.db.add(model(**row))
                else:
                    for col in update_cols:
                        setattr(existing, col, row[col])

        await self.db.commit()
        return len(rows)

    async def _analyze_comments(self, shop, since: datetime, until: datetime) -> None:
        comments = (
            await self.db.scalars(
                select(Comment)
                .where(
                    Comment.shop_id == shop.id,
                    Comment.comment_at >= since,
                    Comment.comment_at <= until,
                    Comment.analyzed_at.is_(None),
                )
                .limit(5000)
            )
        ).all()
        if not comments:
            return

        analyzer = get_analyzer()
        batch_size = 20
        for start in range(0, len(comments), batch_size):
            batch = list(comments[start : start + batch_size])
            results = await analyzer.analyze_batch([item.content for item in batch])
            for item, result in zip(batch, results, strict=False):
                item.sentiment = result.sentiment
                item.sentiment_score = Decimal(str(round(result.score, 4)))
                item.keywords = result.keywords
                item.analyzer_type = result.analyzer_type
                item.analyzed_at = datetime.now(TZ)
        await self.db.commit()

    async def _save_state(self, shop, resource: str, cursor: str | None, until: datetime) -> None:
        state = await self.db.scalar(
            select(SyncState).where(SyncState.shop_id == shop.id, SyncState.resource == resource)
        )
        if state is None:
            state = SyncState(shop_id=shop.id, resource=resource)
            self.db.add(state)
        state.cursor = cursor
        state.last_synced_at = until
        await self.db.commit()
