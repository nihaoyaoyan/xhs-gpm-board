from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "XHS Insight"
    api_prefix: str = "/api/v1"

    database_url: str = "postgresql+asyncpg://xhs:xhs_pass@localhost:5432/xhs_insight"

    jwt_secret: str = "please-change-this-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 720

    mcp_api_token: str = "dev-service-token"

    data_provider: Literal["mock", "qianfan"] = "mock"
    qianfan_base_url: str = "https://openapi.xiaohongshu.com"
    qianfan_app_key: str = ""
    qianfan_app_secret: str = ""

    analyzer_mode: Literal["auto", "local", "llm"] = "auto"
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"

    scheduler_enabled: bool = True
    seed_on_startup: bool = True
    auto_create_tables: bool = False

    sync_orders_minutes: int = 15
    sync_ads_minutes: int = 30
    sync_comments_minutes: int = 60
    metrics_recalc_cron_hour: int = 2
    products_sync_cron_hour: int = 3

    default_cost_rate: float = 0.45
    default_platform_fee_rate: float = 0.05
    default_return_rate: float = 0.08
    default_monthly_fixed_cost: float = 3000.0


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
