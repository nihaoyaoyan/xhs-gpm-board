from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from app.core.config import settings
from app.models import Shop


@dataclass
class PageResult:
    rows: list[dict[str, Any]] = field(default_factory=list)
    next_cursor: str | None = None


class SyncProvider(Protocol):
    async def fetch_products(self, shop: Shop, since: datetime, until: datetime) -> list[dict[str, Any]]: ...

    async def fetch_orders(
        self, shop: Shop, since: datetime, until: datetime, cursor: str | None = None
    ) -> PageResult: ...

    async def fetch_ads(self, shop: Shop, since: datetime, until: datetime) -> list[dict[str, Any]]: ...

    async def fetch_comments(
        self, shop: Shop, since: datetime, until: datetime, cursor: str | None = None
    ) -> PageResult: ...

    async def fetch_search_terms(self, shop: Shop, since: datetime, until: datetime) -> list[dict[str, Any]]: ...


def get_provider() -> SyncProvider:
    """按 DATA_PROVIDER 返回数据源实现，同步层不感知具体来源。"""
    if settings.data_provider == "qianfan":
        from app.services.providers.qianfan import QianfanProvider

        return QianfanProvider()
    from app.services.providers.mock import MockProvider

    return MockProvider()
