"""幂等种子数据：管理员、3 个店铺、90 天 Mock 订单/广告/评论与指标。"""

import asyncio

from sqlalchemy import func, select

from app.core.config import settings
from app.core.logging import logger
from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models import AdRecord, Comment, Order, Product, SearchTerm, Shop, ShopCostConfig, User
from app.services.providers.mock import MockProvider
from app.services.sync import SyncManager

DEMO_SHOPS = [
    ("鲜水湾旗舰店", "XHS-SHOP-001"),
    ("琪琪生鲜的店", "XHS-SHOP-002"),
    ("玺牛生鲜的店", "XHS-SHOP-003"),
]

SEED_DAYS = 90


async def seed() -> None:
    if not settings.seed_on_startup:
        logger.info("SEED_ON_STARTUP=false，跳过种子数据")
        return

    async with SessionLocal() as db:
        user = await db.scalar(select(User).where(User.username == "admin"))
        if user is None:
            db.add(User(username="admin", password_hash=hash_password("Admin@12345")))
            await db.commit()
            logger.info("创建管理员账号 admin")

        for name, qianfan_id in DEMO_SHOPS:
            shop = await db.scalar(select(Shop).where(Shop.qianfan_shop_id == qianfan_id))
            if shop is None:
                shop = Shop(name=name, qianfan_shop_id=qianfan_id, status="active")
                db.add(shop)
                await db.flush()
                db.add(
                    ShopCostConfig(
                        shop_id=shop.id,
                        cost_rate=settings.default_cost_rate,
                        platform_fee_rate=settings.default_platform_fee_rate,
                        return_rate=settings.default_return_rate,
                        monthly_fixed_cost=settings.default_monthly_fixed_cost,
                    )
                )
                await db.commit()
                await db.refresh(shop)
                logger.info("创建店铺 %s (%s)", name, qianfan_id)

            provider = MockProvider()
            models = {
                "products": Product,
                "orders": Order,
                "ads": AdRecord,
                "comments": Comment,
                "search_terms": SearchTerm,
            }
            for resource, model in models.items():
                existing = await db.scalar(
                    select(func.count()).select_from(model).where(model.shop_id == shop.id)
                )
                if existing:
                    continue
                try:
                    await SyncManager(db, provider).run(shop, resource, mode="backfill", days=SEED_DAYS)
                except Exception:
                    logger.exception("种子同步失败 shop=%s resource=%s", shop.id, resource)
                    await db.rollback()

    logger.info("种子数据初始化完成")


if __name__ == "__main__":
    asyncio.run(seed())
