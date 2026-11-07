"""清空业务数据，保留登录账号、店铺与成本参数。

用法：
    python scripts/reset_business_data.py --yes
    python scripts/reset_business_data.py --yes --shop-id 1
"""

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models import (
    AdRecord,
    Comment,
    DailyMetric,
    Order,
    Product,
    SearchTerm,
    SyncLog,
    SyncState,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="清空演示业务数据")
    parser.add_argument("--yes", action="store_true", help="确认执行，否则仅打印待清理范围")
    parser.add_argument("--shop-id", type=int, action="append", help="仅清理指定店铺，可重复")
    return parser.parse_args()


async def _run(shop_ids: list[int] | None, confirmed: bool) -> None:
    async with SessionLocal() as session:
        targets = [
            DailyMetric,
            Order,
            AdRecord,
            Comment,
            Product,
            SearchTerm,
            SyncState,
            SyncLog,
        ]
        for model in targets:
            statement = delete(model)
            if shop_ids:
                statement = statement.where(model.shop_id.in_(shop_ids))
            result = await session.execute(statement)
            print(f"{model.__tablename__}: 待删除 {result.rowcount if result.rowcount >= 0 else '?'} 条")
        if not confirmed:
            await session.rollback()
            print("未加 --yes，已回滚，未删除任何数据")
            return
        await session.commit()
        print("业务数据已清空；账号、店铺、成本参数保留")


def main() -> None:
    args = _parse_args()
    asyncio.run(_run(args.shop_id, args.yes))


if __name__ == "__main__":
    main()
