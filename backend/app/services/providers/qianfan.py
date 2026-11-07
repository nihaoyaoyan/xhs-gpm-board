"""千帆开放平台真实数据源 Adapter（骨架）。

接口路径、签名算法、字段名需以官方最新文档为准，全部集中在本文件常量区，
上线前只需替换以下 5 处：
1. PATHS 中的接口路径
2. _sign() 的签名算法
3. _headers() 的鉴权头名称
4. _map_order / _map_comment 的字段映射
5. _extract_list() 的响应结构解析
"""

from __future__ import annotations

import hashlib
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin

import httpx

from app.core.config import settings
from app.core.errors import ProviderError
from app.core.logging import logger
from app.models import Shop
from app.services.providers.base import PageResult, SyncProvider

PATHS = {
    # TODO: 按千帆开放平台文档核对真实路径
    "products": "/api/open/v1/product/list",
    "orders": "/api/open/v1/order/list",
    "ads": "/api/open/v1/ad/report",
    "comments": "/api/open/v1/comment/list",
    "search_terms": "/api/open/v1/search/term/report",
}

TIMEOUT = httpx.Timeout(20.0, connect=10.0)
PAGE_SIZE = 100


class QianfanProvider(SyncProvider):
    def __init__(self) -> None:
        self.base_url = settings.qianfan_base_url.rstrip("/") + "/"
        self.app_key = settings.qianfan_app_key
        self.app_secret = settings.qianfan_app_secret

    def _ensure_credentials(self) -> None:
        if not self.app_key or not self.app_secret:
            raise ProviderError(
                "千帆 AppKey/AppSecret 未配置。请在 .env 中填写 QIANFAN_APP_KEY / QIANFAN_APP_SECRET，"
                "或将 DATA_PROVIDER 切换为 mock。",
                code="qianfan_credentials_missing",
            )

    def _sign(self, params: dict[str, Any]) -> str:
        """TODO: 按官方文档核对签名算法（当前为通用 md5(secret + 排序参数 + secret)）。"""
        parts = [f"{key}={params[key]}" for key in sorted(params)]
        raw = f"{self.app_secret}&{'&'.join(parts)}&{self.app_secret}"
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def _headers(self, params: dict[str, Any]) -> dict[str, str]:
        return {
            "X-App-Key": self.app_key,
            "X-Timestamp": str(int(time.time() * 1000)),
            "X-Sign": self._sign(params),
            "Content-Type": "application/json",
        }

    async def _request(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        self._ensure_credentials()
        url = urljoin(self.base_url, path.lstrip("/"))
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                response = await client.get(url, params=params, headers=self._headers(params))
        except httpx.HTTPError as exc:
            raise ProviderError(f"千帆接口网络异常: {exc}", code="qianfan_network_error") from exc

        if response.status_code == 401:
            raise ProviderError("千帆鉴权失败，请检查 AppKey/AppSecret 与签名算法", code="qianfan_auth_error")
        if response.status_code == 429:
            raise ProviderError("千帆接口触发限流，请稍后重试", code="qianfan_rate_limited")
        if response.status_code >= 400:
            raise ProviderError(f"千帆接口返回 {response.status_code}: {response.text[:200]}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderError("千帆接口返回非 JSON 内容", code="qianfan_bad_response") from exc

        code = payload.get("code", payload.get("error_code", 0))
        if code not in (0, "0", None):
            raise ProviderError(f"千帆业务错误 {code}: {payload.get('msg') or payload.get('message')}")

        logger.info("qianfan request path=%s params=%s", path, params)
        return payload

    @staticmethod
    def _extract_list(payload: dict[str, Any]) -> tuple[list[dict], bool]:
        """TODO: 按官方响应结构调整（兼容 data.list / data.items / result.records 三种常见形态）。"""
        data = payload.get("data") or payload.get("result") or {}
        rows = data.get("list") or data.get("items") or data.get("records") or []
        has_more = bool(data.get("has_more") or data.get("has_next"))
        return rows, has_more

    @staticmethod
    def _parse_dt(value: Any) -> datetime:
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        text = str(value or "")
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(text[:19], fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        return datetime.now(timezone.utc)

    async def fetch_products(self, shop: Shop, since: datetime, until: datetime) -> list[dict]:
        params = {
            "app_key": self.app_key,
            "shop_id": shop.qianfan_shop_id,
            "page_no": 1,
            "page_size": PAGE_SIZE,
        }
        payload = await self._request(PATHS["products"], params)
        rows, _ = self._extract_list(payload)
        # TODO: 字段映射按官方文档核对
        return [
            {
                "external_id": str(row.get("item_id") or row.get("product_id") or ""),
                "title": row.get("title") or row.get("name") or "",
                "price": float(row.get("price") or row.get("sale_price") or 0),
                "sku_count": int(row.get("sku_count") or 1),
            }
            for row in rows
        ]

    async def fetch_orders(
        self, shop: Shop, since: datetime, until: datetime, cursor: str | None = None
    ) -> PageResult:
        page_no = int(cursor or 1)
        params = {
            "app_key": self.app_key,
            "shop_id": shop.qianfan_shop_id,
            "start_time": since.strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": until.strftime("%Y-%m-%d %H:%M:%S"),
            "page_no": page_no,
            "page_size": PAGE_SIZE,
        }
        payload = await self._request(PATHS["orders"], params)
        rows, has_more = self._extract_list(payload)
        mapped = [
            {
                "external_id": str(row.get("order_id") or ""),
                "product_title": row.get("item_title") or row.get("product_name"),
                "sku_name": row.get("sku_name"),
                "qty": int(row.get("quantity") or 1),
                "amount": float(row.get("payment_amount") or row.get("order_amount") or 0),
                "refund_amount": float(row.get("refund_amount") or 0),
                "status": row.get("order_status") or "paid",
                "paid_at": self._parse_dt(row.get("pay_time") or row.get("created_at")),
                "raw": row,
            }
            for row in rows
        ]
        return PageResult(rows=mapped, next_cursor=str(page_no + 1) if has_more else None)

    async def fetch_ads(self, shop: Shop, since: datetime, until: datetime) -> list[dict]:
        params = {
            "app_key": self.app_key,
            "shop_id": shop.qianfan_shop_id,
            "start_date": since.strftime("%Y-%m-%d"),
            "end_date": until.strftime("%Y-%m-%d"),
        }
        payload = await self._request(PATHS["ads"], params)
        rows, _ = self._extract_list(payload)
        return [
            {
                "date": self._parse_dt(row.get("date") or row.get("stat_date")).date(),
                "campaign_id": str(row.get("campaign_id") or ""),
                "campaign_name": row.get("campaign_name"),
                "spend": float(row.get("spend") or row.get("cost") or 0),
                "impressions": int(row.get("impressions") or row.get("show_count") or 0),
                "clicks": int(row.get("clicks") or row.get("click_count") or 0),
                "visits": int(row.get("visits") or row.get("view_count") or 0),
                "gmv": float(row.get("gmv") or row.get("order_amount") or 0),
                "order_count": int(row.get("order_count") or row.get("pay_order_count") or 0),
            }
            for row in rows
        ]

    async def fetch_comments(
        self, shop: Shop, since: datetime, until: datetime, cursor: str | None = None
    ) -> PageResult:
        page_no = int(cursor or 1)
        params = {
            "app_key": self.app_key,
            "shop_id": shop.qianfan_shop_id,
            "start_time": since.strftime("%Y-%m-%d %H:%M:%S"),
            "end_time": until.strftime("%Y-%m-%d %H:%M:%S"),
            "page_no": page_no,
            "page_size": PAGE_SIZE,
        }
        payload = await self._request(PATHS["comments"], params)
        rows, has_more = self._extract_list(payload)
        mapped = [
            {
                "external_id": str(row.get("comment_id") or ""),
                "product_title": row.get("item_title") or row.get("product_name"),
                "content": row.get("content") or "",
                "rating": int(row.get("rating") or row.get("star") or 5),
                "like_count": int(row.get("like_count") or 0),
                "comment_at": self._parse_dt(row.get("create_time") or row.get("comment_time")),
            }
            for row in rows
        ]
        return PageResult(rows=mapped, next_cursor=str(page_no + 1) if has_more else None)

    async def fetch_search_terms(self, shop: Shop, since: datetime, until: datetime) -> list[dict]:
        rows: list[dict] = []
        for channel in ("ad", "shop", "note"):
            params = {
                "app_key": self.app_key,
                "shop_id": shop.qianfan_shop_id,
                "channel": channel,
                "start_date": since.strftime("%Y-%m-%d"),
                "end_date": until.strftime("%Y-%m-%d"),
            }
            payload = await self._request(PATHS["search_terms"], params)
            items, _ = self._extract_list(payload)
            for row in items:
                rows.append(
                    {
                        "date": self._parse_dt(row.get("date") or row.get("stat_date")).date(),
                        "channel": channel,
                        "term": str(row.get("keyword") or row.get("search_word") or row.get("term") or ""),
                        "impressions": int(row.get("impressions") or row.get("show_count") or 0),
                        "clicks": int(row.get("clicks") or row.get("click_count") or 0),
                        "visits": int(row.get("visits") or row.get("view_count") or 0),
                        "order_count": int(row.get("order_count") or row.get("pay_order_count") or 0),
                        "gmv": float(row.get("gmv") or row.get("order_amount") or 0),
                        "spend": float(row.get("spend") or row.get("cost") or 0),
                    }
                )
        return [row for row in rows if row["term"]]
