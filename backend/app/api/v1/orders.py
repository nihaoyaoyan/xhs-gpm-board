from datetime import date, time

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.v1._helpers import iso, resolve_range
from app.core.deps import AuthGuard, DbSession
from app.core.errors import ok
from app.models import Order

router = APIRouter(prefix="/orders", tags=["orders"])


@router.get("")
async def list_orders(
    db: DbSession,
    _: AuthGuard,
    shop_id: int,
    status: str | None = None,
    keyword: str | None = None,
    start: date | None = None,
    end: date | None = None,
    page: int = 1,
    page_size: int = 20,
):
    start_day, end_day = resolve_range(start, end)
    page = max(page, 1)
    page_size = min(max(page_size, 1), 100)

    conditions = [
        Order.shop_id == shop_id,
        func.date(Order.paid_at) >= start_day,
        func.date(Order.paid_at) <= end_day,
    ]
    if status:
        conditions.append(Order.status == status)
    if keyword:
        conditions.append(
            Order.product_title.ilike(f"%{keyword}%") | Order.external_id.ilike(f"%{keyword}%")
        )

    total = await db.scalar(select(func.count()).select_from(Order).where(*conditions))
    rows = (
        await db.scalars(
            select(Order)
            .where(*conditions)
            .order_by(Order.paid_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()

    return ok(
        {
            "items": [
                {
                    "id": row.id,
                    "external_id": row.external_id,
                    "product_title": row.product_title,
                    "sku_name": row.sku_name,
                    "qty": row.qty,
                    "amount": float(row.amount),
                    "refund_amount": float(row.refund_amount),
                    "status": row.status,
                    "paid_at": iso(row.paid_at),
                }
                for row in rows
            ],
            "total": total or 0,
            "page": page,
            "page_size": page_size,
        }
    )
