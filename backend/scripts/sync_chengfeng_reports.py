"""拉取乘风 7 类离线报表（账户/计划/创意/笔记/关键词/商品/直播间），写入 ad_report_rows。

接口单次查询跨度上限 30 天，脚本按 30 天分段、按页拉取；
按日行 hour=-1，分时行 hour=0..23，以 (shop_id, date, hour, level, dimension_id) 为唯一键增量更新。

用法：
    cd backend
    DATABASE_URL="sqlite+aiosqlite:////workspace/backend/data/xhs.db" \
    /tmp/xhs-venv312/bin/python scripts/sync_chengfeng_reports.py \
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
from app.models import AdReportRow

COLUMNS = [
    "fee",
    "impression",
    "click",
    "ctr",
    "acp",
    "cpm",
    "goods_view_num",
    "goods_add_cart_num",
    "total_order_num_7d",
    "total_order_gmv_7d",
    "deal_order_num_7d",
    "deal_order_gmv_7d",
]

LEVELS = {
    "account": {"tool": "report_offline_account", "id": None, "name": None, "label": "账户"},
    "campaign": {"tool": "report_offline_campaign", "id": "campaign_id", "name": "campaign_name", "label": "计划"},
    "creativity": {"tool": "report_offline_creativity", "id": "creativity_id", "name": "creativity_name", "label": "创意"},
    "note": {"tool": "report_offline_note", "id": "note_id", "name": "note_title", "label": "笔记"},
    "keyword": {"tool": "report_offline_keyword", "id": "keyword", "name": "keyword", "label": "关键词"},
    "spu": {"tool": "report_offline_spu", "id": "spu_id", "name": "spu_name", "label": "商品"},
    "live": {"tool": "report_offline_live", "id": "live_room_id", "name": "live_room_title", "label": "直播间"},
}

MAX_PAGES = 500


def _int(value) -> int:
    try:
        return int(float(str(value).replace(",", ""))) if value not in (None, "") else 0
    except (TypeError, ValueError):
        return 0


def _dec(value) -> Decimal:
    try:
        return Decimal(str(round(float(str(value).replace(",", "")), 2))) if value not in (None, "") else Decimal("0")
    except (TypeError, ValueError):
        return Decimal("0")


def _float(value) -> float:
    text = str(value or "").replace(",", "").strip()
    try:
        if text.endswith("%"):
            return round(float(text[:-1]) / 100, 6)
        return float(text) if text else 0.0
    except ValueError:
        return 0.0


def split_chunks(start: date, end: date, days: int = 30) -> list[tuple[date, date]]:
    chunks, cursor = [], start
    while cursor <= end:
        stop = min(cursor + timedelta(days=days - 1), end)
        chunks.append((cursor, stop))
        cursor = stop + timedelta(days=1)
    return chunks


def parse_time(value, time_unit: str) -> tuple[date, int] | None:
    """解析接口 time 字段：按日为 2026-11-01，分时为 26-11-01 00:00。"""
    text = str(value or "").strip()
    if not text:
        return None
    date_part, _, clock = text.partition(" ")
    if len(date_part) == 8:  # YY-MM-DD
        date_part = f"20{date_part}"
    try:
        day = date.fromisoformat(date_part)
    except ValueError:
        return None
    if time_unit != "HOUR":
        return day, -1
    hour = int(clock[:2]) if clock[:2].isdigit() else -1
    return (day, hour) if 0 <= hour <= 23 else None


def _dimension(level: str, spec: dict, row: dict, advertiser_id: int) -> tuple[str, str]:
    if spec["id"] is None:
        return str(advertiser_id), spec["label"]
    if level == "keyword":
        keyword = str(row.get("keyword") or "").strip()
        campaign_id = str(row.get("campaign_id") or "").strip()
        return f"{campaign_id}:{keyword}", keyword
    if level == "live" and not row.get(spec["id"]):
        dim_id = str(row.get("live_id") or row.get("room_id") or "").strip()
        return dim_id, str(row.get("live_room_title") or row.get("title") or "")
    dim_id = str(row.get(spec["id"]) or "").strip()
    return dim_id, str(row.get(spec["name"]) or "")


async def fetch_chunk(
    session: ClientSession,
    tool: str,
    advertiser_id: int,
    start: date,
    end: date,
    page_size: int,
    time_unit: str = "DAY",
) -> list[dict]:
    rows: list[dict] = []
    page = 1
    while page <= MAX_PAGES:
        payload = None
        for attempt in range(3):
            result = await session.call_tool(
                tool,
                {
                    "advertiser_id": advertiser_id,
                    "start_date": start.isoformat(),
                    "end_date": end.isoformat(),
                    "time_unit": time_unit,
                    "columns": COLUMNS,
                    "page_size": page_size,
                    "page_num": page,
                },
            )
            text = "\n".join(getattr(item, "text", str(item)) for item in result.content)
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = None
            if payload is not None and payload.get("code") == 0:
                break
            print(f"  重试 {tool} {start}~{end} 第 {page} 页 (第 {attempt + 1} 次)")
            await asyncio.sleep(2 * (attempt + 1))
        if payload is None or payload.get("code") != 0:
            raise RuntimeError(f"{tool} {start}~{end} 第 {page} 页失败: {payload and payload.get('code')} {payload and payload.get('msg')}")
        data = payload.get("data") or {}
        page_rows = data.get("data_list") or []
        rows.extend(page_rows)
        total = int(data.get("total_count") or 0)
        if len(page_rows) < page_size or len(rows) >= total:
            break
        page += 1
    return rows


async def upsert(
    db,
    shop_id: int,
    level: str,
    spec: dict,
    rows: list[dict],
    advertiser_id: int,
    time_unit: str = "DAY",
) -> tuple[int, int]:
    mapped: dict[tuple[date, int, str], dict] = {}
    for row in rows:
        dim_id, dim_name = _dimension(level, spec, row, advertiser_id)
        parsed = parse_time(row.get("time"), time_unit)
        if not dim_id or parsed is None:
            continue
        day, hour = parsed
        mapped[(day, hour, dim_id)] = {
            "shop_id": shop_id,
            "date": day,
            "hour": hour,
            "level": level,
            "dimension_id": dim_id,
            "dimension_name": dim_name or None,
            "spend": _dec(row.get("fee")),
            "impressions": _int(row.get("impression")),
            "clicks": _int(row.get("click")),
            "ctr": _float(row.get("ctr")),
            "acp": _float(row.get("acp")),
            "cpm": _float(row.get("cpm")),
            "goods_views": _int(row.get("goods_view_num")),
            "add_cart": _int(row.get("goods_add_cart_num")),
            "total_orders": _int(row.get("total_order_num_7d")),
            "total_gmv": _dec(row.get("total_order_gmv_7d")),
            "deal_orders": _int(row.get("deal_order_num_7d")),
            "deal_gmv": _dec(row.get("deal_order_gmv_7d")),
            "raw_json": json.dumps(row, ensure_ascii=False),
        }

    created = updated = 0
    for (day, hour, dim_id), values in mapped.items():
        existing = await db.scalar(
            select(AdReportRow).where(
                AdReportRow.shop_id == shop_id,
                AdReportRow.date == day,
                AdReportRow.hour == hour,
                AdReportRow.level == level,
                AdReportRow.dimension_id == dim_id,
            )
        )
        if existing is None:
            db.add(AdReportRow(**values))
            created += 1
        else:
            for key, value in values.items():
                setattr(existing, key, value)
            updated += 1
    await db.commit()
    return created, updated


async def main() -> None:
    parser = argparse.ArgumentParser(description="同步乘风 7 类离线报表")
    parser.add_argument("--shop-id", type=int, required=True)
    parser.add_argument("--advertiser-id", type=int, required=True)
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--mcp-url", default="http://127.0.0.1:9101/mcp")
    parser.add_argument("--page-size", type=int, default=200)
    parser.add_argument("--levels", default="account,campaign,creativity,note,keyword,spu,live")
    parser.add_argument("--hour-days", type=int, default=30, help="分时数据回溯天数，0 表示不拉分时")
    parser.add_argument("--skip-day", action="store_true", help="只补分时，不重拉按日")
    parser.add_argument("--skip-hour", action="store_true", help="只拉按日，不拉分时")
    args = parser.parse_args()

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    if start > end:
        raise SystemExit("开始日期不能晚于结束日期")
    levels = [item.strip() for item in args.levels.split(",") if item.strip() in LEVELS]
    if not levels:
        raise SystemExit("未指定有效层级")

    day_chunks = split_chunks(start, end)
    hour_start = max(start, end - timedelta(days=args.hour_days - 1)) if args.hour_days > 0 else None
    hour_chunks = split_chunks(hour_start, end, days=7) if hour_start else []
    stats = {
        level: {"day_rows": 0, "day_created": 0, "day_updated": 0, "hour_rows": 0, "hour_created": 0, "hour_updated": 0}
        for level in levels
    }

    async with streamablehttp_client(args.mcp_url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            for level in levels:
                spec = LEVELS[level]
                st = stats[level]
                if not args.skip_day:
                    for cstart, cend in day_chunks:
                        rows = await fetch_chunk(
                            session, spec["tool"], args.advertiser_id, cstart, cend, args.page_size, "DAY"
                        )
                        async with SessionLocal() as db:
                            c, u = await upsert(db, args.shop_id, level, spec, rows, args.advertiser_id, "DAY")
                        st["day_rows"] += len(rows)
                        st["day_created"] += c
                        st["day_updated"] += u
                        print(f"[{level}][按日] {cstart} ~ {cend}: 拉取 {len(rows)} 行, 新增 {c}, 更新 {u}")
                if hour_chunks and not args.skip_hour:
                    for cstart, cend in hour_chunks:
                        rows = await fetch_chunk(
                            session, spec["tool"], args.advertiser_id, cstart, cend, args.page_size, "HOUR"
                        )
                        async with SessionLocal() as db:
                            c, u = await upsert(db, args.shop_id, level, spec, rows, args.advertiser_id, "HOUR")
                        st["hour_rows"] += len(rows)
                        st["hour_created"] += c
                        st["hour_updated"] += u
                        print(f"[{level}][分时] {cstart} ~ {cend}: 拉取 {len(rows)} 行, 新增 {c}, 更新 {u}")

    for level, st in stats.items():
        print(
            f"合计[{level}]: 按日 {st['day_rows']} 行(新增 {st['day_created']}/更新 {st['day_updated']}), "
            f"分时 {st['hour_rows']} 行(新增 {st['hour_created']}/更新 {st['hour_updated']})"
        )


if __name__ == "__main__":
    asyncio.run(main())
