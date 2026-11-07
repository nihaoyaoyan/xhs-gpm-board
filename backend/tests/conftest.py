"""测试环境：SQLite + 覆盖数据库依赖，避免依赖外部 PostgreSQL。"""

import os
from dataclasses import dataclass

os.environ.update(
    {
        "DATABASE_URL": "sqlite+aiosqlite:////tmp/xhs_pytest.db",
        "AUTO_CREATE_TABLES": "false",
        "SCHEDULER_ENABLED": "false",
        "DATA_PROVIDER": "mock",
        "ANALYZER_MODE": "local",
        "SEED_ON_STARTUP": "false",
    }
)

import pytest_asyncio
from httpx import ASGITransport, AsyncClient

import app.models  # noqa: F401  确保模型注册到 metadata
from app.core.deps import get_db
from app.core.security import hash_password
from app.db.base import Base
from app.db.session import SessionLocal, engine
from app.main import app
from app.models import Shop, ShopCostConfig, User


@dataclass
class ApiContext:
    client: AsyncClient
    shop_id: int


@pytest_asyncio.fixture
async def api_ctx() -> ApiContext:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with SessionLocal() as session:
        session.add(
            User(username="admin", password_hash=hash_password("Admin@12345"), is_active=True)
        )
        shop = Shop(name="测试店铺", qianfan_shop_id="TEST-001")
        session.add(shop)
        await session.flush()
        session.add(
            ShopCostConfig(
                shop_id=shop.id,
                cost_rate=0.45,
                platform_fee_rate=0.05,
                return_rate=0.08,
                monthly_fixed_cost=3000,
            )
        )
        await session.commit()
        shop_id = shop.id

    async def override_get_db():
        async with SessionLocal() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/v1/auth/login", json={"username": "admin", "password": "Admin@12345"}
        )
        token = response.json()["data"]["access_token"]
        client.headers["Authorization"] = f"Bearer {token}"
        yield ApiContext(client=client, shop_id=shop_id)

    app.dependency_overrides.clear()
    await engine.dispose()
