from pydantic import BaseModel, Field


class ShopCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    qianfan_shop_id: str = Field(min_length=1, max_length=128)
    app_key: str | None = None
    app_secret: str | None = None


class ShopUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    app_key: str | None = None
    app_secret: str | None = None
    status: str | None = Field(default=None, pattern="^(active|disabled)$")


class CostConfigUpdate(BaseModel):
    cost_rate: float = Field(ge=0, le=1)
    platform_fee_rate: float = Field(ge=0, le=1)
    return_rate: float = Field(ge=0, le=1)
    monthly_fixed_cost: float = Field(ge=0)


class SyncRequest(BaseModel):
    resource: str = Field(pattern="^(products|orders|ads|comments|search_terms)$")
    mode: str = Field(default="incremental", pattern="^(incremental|backfill)$")
    days: int = Field(default=30, ge=1, le=365)


class ReanalyzeRequest(BaseModel):
    shop_id: int
    start: str | None = None
    end: str | None = None
    limit: int = Field(default=200, ge=1, le=2000)
