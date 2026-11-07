from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.deps import AuthGuard, CurrentUser, DbSession
from app.core.errors import ok
from app.models import DailyMetric, Shop, ShopCostConfig
from app.schemas.shop import CostConfigUpdate, ShopCreate, ShopUpdate
from app.services.metrics import refresh_daily_metrics

router = APIRouter(prefix="/shops", tags=["shops"])


def _shop_payload(shop: Shop) -> dict:
    return {
        "id": shop.id,
        "name": shop.name,
        "qianfan_shop_id": shop.qianfan_shop_id,
        "status": shop.status,
        "has_credentials": bool(shop.app_key and shop.app_secret),
    }


def _cost_payload(config: ShopCostConfig) -> dict:
    return {
        "shop_id": config.shop_id,
        "cost_rate": float(config.cost_rate),
        "platform_fee_rate": float(config.platform_fee_rate),
        "return_rate": float(config.return_rate),
        "monthly_fixed_cost": float(config.monthly_fixed_cost),
    }


async def _get_shop(db, shop_id: int) -> Shop:
    shop = await db.get(Shop, shop_id)
    if shop is None:
        raise HTTPException(status_code=404, detail="店铺不存在")
    return shop


@router.get("")
async def list_shops(db: DbSession, _: AuthGuard):
    shops = (await db.scalars(select(Shop).order_by(Shop.id))).all()
    return ok([_shop_payload(shop) for shop in shops])


@router.post("")
async def create_shop(payload: ShopCreate, db: DbSession, _: CurrentUser):
    shop = Shop(
        name=payload.name,
        qianfan_shop_id=payload.qianfan_shop_id,
        app_key=payload.app_key,
        app_secret=payload.app_secret,
    )
    db.add(shop)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="千帆店铺 ID 已存在")
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
    return ok(_shop_payload(shop))


@router.patch("/{shop_id}")
async def update_shop(shop_id: int, payload: ShopUpdate, db: DbSession, _: CurrentUser):
    shop = await _get_shop(db, shop_id)
    if payload.name is not None:
        shop.name = payload.name
    if payload.app_key is not None:
        shop.app_key = payload.app_key
    if payload.app_secret is not None:
        shop.app_secret = payload.app_secret
    if payload.status is not None:
        shop.status = payload.status
    await db.commit()
    return ok(_shop_payload(shop))


@router.get("/{shop_id}/cost-config")
async def get_cost_config(shop_id: int, db: DbSession, _: AuthGuard):
    await _get_shop(db, shop_id)
    config = await db.scalar(select(ShopCostConfig).where(ShopCostConfig.shop_id == shop_id))
    if config is None:
        config = ShopCostConfig(
            shop_id=shop_id,
            cost_rate=settings.default_cost_rate,
            platform_fee_rate=settings.default_platform_fee_rate,
            return_rate=settings.default_return_rate,
            monthly_fixed_cost=settings.default_monthly_fixed_cost,
        )
        db.add(config)
        await db.commit()
        await db.refresh(config)
    return ok(_cost_payload(config))


@router.put("/{shop_id}/cost-config")
async def update_cost_config(shop_id: int, payload: CostConfigUpdate, db: DbSession, _: CurrentUser):
    await _get_shop(db, shop_id)
    config = await db.scalar(select(ShopCostConfig).where(ShopCostConfig.shop_id == shop_id))
    if config is None:
        config = ShopCostConfig(shop_id=shop_id)
        db.add(config)
    config.cost_rate = payload.cost_rate
    config.platform_fee_rate = payload.platform_fee_rate
    config.return_rate = payload.return_rate
    config.monthly_fixed_cost = payload.monthly_fixed_cost
    await db.commit()
    await db.refresh(config)

    # 成本参数变更后重算既有日指标，保证仪表盘毛利 / 保本指标即时联动
    span = (
        await db.execute(
            select(func.min(DailyMetric.date), func.max(DailyMetric.date)).where(
                DailyMetric.shop_id == shop_id
            )
        )
    ).one()
    if span[0] and span[1]:
        await refresh_daily_metrics(db, shop_id, span[0], span[1])

    return ok(_cost_payload(config))
