"""从乘风 MAPI 拉取广告主账户下的计划层级投放报表，写入 ad_records，并重算 daily_metrics。

报表接口单次查询跨度上限 30 天，脚本按 30 天分段，逐页拉取；
以 (shop_id, date, campaign_id) 为唯一键做增量更新，可重复执行。

用法：
    cd backend
    DATABASE_URL="sqlite+aiosqlite:////tmp/xhs_run.db" \
    /tmp/xhs-venv312/bin/python scripts/sync_chengfeng_ads.py \
        --shop-id 1 --advertiser-id 8737051 --start 2025-11-01 --end 2026-11-06
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models import AdRecord
from app.services.metrics import refresh_daily_metrics

MAX_PAGES = 30


def _int(value) -> int:
    try:
        return int(float(str(value).replace(",", ""))) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def _money(value) -> Decimal:
    try:
        return Decimal(str(round(float(str(value).replace(",", "")), 2))) if value not in (None, "") else Decimal("0")
    except (TypeError, ValueError):
        return Decimal("0")


def _num(value) -> float:
    try:
        return float(str(value).replace(",", "")) if value not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def split_chunks(start: date, end: date, days: int = 30) -> list[tuple[date, date]]:
    chunks = []
    cursor = start
    while cursor <= end:
        stop = min(cursor + timedelta(days=days - 1), end)
        chunks.append((cursor, stop))
        cursor = stop + timedelta(days=1)
    return chunks


async def fetch_chunk(session: ClientSession, advertiser_id: int, start: date, end: date, page_size: int) -> list[dict]:
    rows: list[dict] = []
    page = 1
    while page <= MAX_PAGES:
        result = await session.call_tool(
            "report_offline_campaign",
            {
                "advertiser_id": advertiser_id,
                "start_date": start.isoformat(),
                "end_date": end.isoformat(),
                "time_unit": "DAY",
                "page_size": page_size,
                "page_num": page,
            },
        )
        text = "\n".join(getattr(item, "text", str(item)) for item in result.content)
        payload = json.loads(text)
        if not payload.get("success"):
            raise RuntimeError(f"{start}~{end} 第 {page} 页失败: {payload.get('code')} {payload.get('msg')}")
        data = payload.get("data") or {}
        page_rows = data.get("data_list") or []
        rows.extend(page_rows)
        total = int(data.get("total_count") or 0)
        if len(page_rows) < page_size or len(rows) >= total:
            break
        page += 1
    return rows


async def upsert(db, shop_id: int, rows: list[dict]) -> tuple[int, int]:
    mapped: dict[tuple[date, str], dict] = {}
    for row in rows:
        campaign_id = str(row.get("campaign_id") or "").strip()
        if not campaign_id or not row.get("time"):
            continue
        day = date.fromisoformat(str(row["time"])[:10])
        mapped[(day, campaign_id)] = {
            "shop_id": shop_id,
            "date": day,
            "campaign_id": campaign_id,
            "campaign_name": (row.get("campaign_name") or None),
            "spend": _money(row.get("fee")),
            "impressions": _int(row.get("impression")),
            "clicks": _int(row.get("click")),
            "visits": 0,
            "gmv": Decimal("0"),
            "order_count": 0,
        }

    created = updated = 0
    for (day, campaign_id), values in mapped.items():
        existing = await db.scalar(
            select(AdRecord).where(
                AdRecord.shop_id == shop_id,
                AdRecord.date == day,
                AdRecord.campaign_id == campaign_id,
            )
        )
        if existing is None:
            db.add(AdRecord(**values))
            created += 1
        else:
            for key, value in values.items():
                setattr(existing, key, value)
            updated += 1
    await db.commit()
    return created, updated


async def main() -> None:
    parser = argparse.ArgumentParser(description="同步乘风投放报表到 ad_records")
    parser.add_argument("--shop-id", type=int, required=True)
    parser.add_argument("--advertiser-id", type=int, required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--mcp-url", default="http://127.0.0.1:9101/mcp")
    parser.add_argument("--page-size", type=int, default=200)
    parser.add_argument("--skip-metrics", action="store_true")
    args = parser.parse_args()

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    if start > end:
        raise SystemExit("开始日期不能晚于结束日期")

    chunks = split_chunks(start, end)
    total_rows = created = updated = 0
    total_spend = total_imp = total_click = 0.0

    async with streamablehttp_client(args.mcp_url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for cstart, cend in chunks:
                rows = await fetch_chunk(session, args.advertiser_id, cstart, cend, args.page_size)
                async with SessionLocal() as db:
                    c, u = await upsert(db, args.shop_id, rows)
                total_rows += len(rows)
                created += c
                updated += u
                total_spend += sum(_num(r.get("fee")) for r in rows)
                total_imp += sum(_int(r.get("impression")) for r in rows)
                total_click += sum(_int(r.get("click")) for r in rows)
                print(f"{cstart} ~ {cend}: 拉取 {len(rows)} 行, 新增 {c}, 更新 {u}")

    print(
        f"合计: 拉取 {total_rows} 行, 新增 {created}, 更新 {updated}, "
        f"消耗 {total_spend:.2f}, 曝光 {int(total_imp)}, 点击 {int(total_click)}"
    )

    if not args.skip_metrics:
        async with SessionLocal() as db:
            written = await refresh_daily_metrics(db, args.shop_id, start, end)
        print(f"daily_metrics 重算 {written} 天")


if __name__ == "__main__":
    asyncio.run(main())
