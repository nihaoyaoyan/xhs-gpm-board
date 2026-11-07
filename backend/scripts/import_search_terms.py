"""将搜索词月报 Excel 导入 SearchTerm 表。

Excel 字段：搜索词、支付金额、支付订单数、支付买家数、商卡曝光人数、
商品点击人数、商品点击率、支付转化率。月度汇总数据按单日快照写入指定日期。

用法：
    cd backend
    DATABASE_URL="sqlite+aiosqlite:////tmp/xhs_run.db" \
    /tmp/xhs-venv312/bin/python scripts/import_search_terms.py \
        --file "/path/to/搜索词数据(2026年10月).xlsx" --shop-id 1 --date 2026-10-31
"""

from __future__ import annotations

import argparse
import asyncio
import calendar
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import openpyxl
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import SearchTerm, Shop
from app.services.providers.mock import MockProvider
from app.services.sync.manager import SyncManager

REQUIRED_HEADERS = {
    "搜索词": "term",
    "支付金额": "gmv",
    "支付订单数": "orders",
    "支付买家数": "buyers",
    "商卡曝光人数": "impressions",
    "商品点击人数": "clicks",
}


def _number(value) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return 0.0
    return float(text)


def read_rows(path: Path) -> list[dict]:
    workbook = openpyxl.load_workbook(path, data_only=True)
    sheet = workbook.worksheets[0]
    header_row = next(sheet.iter_rows(min_row=1, max_row=1, values_only=True))
    headers = [str(cell).strip() if cell is not None else "" for cell in header_row]
    index = {}
    for name, key in REQUIRED_HEADERS.items():
        if name not in headers:
            raise ValueError(f"Excel 缺少字段：{name}（实际表头：{headers}）")
        index[key] = headers.index(name)

    rows: list[dict] = []
    for values in sheet.iter_rows(min_row=2, values_only=True):
        term = str(values[index["term"]] or "").strip()
        if not term:
            continue
        rows.append(
            {
                "term": term[:128],
                "gmv": round(_number(values[index["gmv"]]), 2),
                "orders": int(_number(values[index["orders"]])),
                "buyers": int(_number(values[index["buyers"]])),
                "impressions": int(_number(values[index["impressions"]])),
                "clicks": int(_number(values[index["clicks"]])),
            }
        )
    return rows


async def import_rows(args: argparse.Namespace) -> None:
    rows = read_rows(Path(args.file))
    deduped: dict[str, dict] = {}
    for row in rows:
        deduped[row["term"]] = row
    rows = list(deduped.values())

    async with SessionLocal() as db:
        shop = await db.scalar(select(Shop).where(Shop.id == args.shop_id))
        if shop is None:
            raise SystemExit(f"店铺不存在：id={args.shop_id}")

        replaced = 0
        if args.replace:
            result = await db.execute(
                delete(SearchTerm).where(
                    SearchTerm.shop_id == shop.id,
                    SearchTerm.channel == args.channel,
                    SearchTerm.date >= date(args.date.year, args.date.month, 1),
                    SearchTerm.date <= date(
                        args.date.year,
                        args.date.month,
                        calendar.monthrange(args.date.year, args.date.month)[1],
                    ),
                )
            )
            replaced = result.rowcount or 0
            await db.commit()

        mapped = [
            {
                "shop_id": shop.id,
                "date": args.date,
                "channel": args.channel,
                "term": row["term"],
                "impressions": row["impressions"],
                "clicks": row["clicks"],
                "visits": row["clicks"],
                "orders_count": row["orders"],
                "buyers": row["buyers"],
                "gmv": Decimal(str(row["gmv"])),
                "ad_spend": Decimal("0"),
            }
            for row in rows
        ]
        upserted = await SyncManager(db, MockProvider())._upsert(
            SearchTerm,
            mapped,
            ["shop_id", "date", "channel", "term"],
            ["impressions", "clicks", "visits", "orders_count", "buyers", "gmv", "ad_spend"],
        )

    total_gmv = sum(row["gmv"] for row in rows)
    total_orders = sum(row["orders"] for row in rows)
    total_buyers = sum(row["buyers"] for row in rows)
    print(f"店铺：{shop.name}（id={shop.id}）")
    print(f"读取 {len(deduped)} 个搜索词，替换旧记录 {replaced} 条，写入 {upserted} 条")
    print(f"支付金额合计 ¥{total_gmv:,.2f}，订单 {total_orders}，买家 {total_buyers}")
    print(f"数据日期：{args.date.isoformat()}，channel={args.channel}")


def main() -> None:
    parser = argparse.ArgumentParser(description="导入搜索词月报 Excel")
    parser.add_argument("--file", required=True, help="Excel 文件路径")
    parser.add_argument("--shop-id", type=int, default=1, help="目标店铺 id")
    parser.add_argument("--date", type=date.fromisoformat, default=date(2026, 10, 31), help="写入日期")
    parser.add_argument("--channel", default="shop", choices=["shop", "ad", "note"], help="搜索词渠道")
    parser.add_argument(
        "--replace",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="导入前清空该店铺当月同渠道旧数据（默认开启）",
    )
    asyncio.run(import_rows(parser.parse_args()))


if __name__ == "__main__":
    main()
