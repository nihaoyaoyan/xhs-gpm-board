"""独立 FastMCP 服务：为大模型提供小红书店铺分析工具。

启动：
    MCP_TRANSPORT=streamable-http FASTMCP_HOST=0.0.0.0 FASTMCP_PORT=9000 python -m mcp_server.server
"""

from __future__ import annotations

import os
from datetime import date, timedelta

from fastmcp import FastMCP

from mcp_server.client import BackendError, get, post

mcp = FastMCP("xhs-insight")


def _range(start_date: str | None, end_date: str | None) -> tuple[str, str]:
    today = date.today()
    end = date.fromisoformat(end_date) if end_date else today
    start = date.fromisoformat(start_date) if start_date else end - timedelta(days=29)
    return start.isoformat(), end.isoformat()


def _error(exc: Exception) -> dict:
    return {"error": str(exc)}


@mcp.tool()
async def list_shops() -> list | dict:
    """列出所有小红书店铺（返回 id、名称、千帆店铺 ID 与是否已配置凭证）。"""
    try:
        return await get("/shops")
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_shop_overview(
    shop_id: int, start_date: str | None = None, end_date: str | None = None
) -> dict:
    """获取店铺核心 KPI 概览（GMV、订单数、客单价、ROI、GPM、毛利率、保本销售额与达成率），
    并与上一个等长周期对比。start_date/end_date 格式 YYYY-MM-DD，默认近 30 天。"""
    start, end = _range(start_date, end_date)
    try:
        return await get("/dashboard/overview", {"shop_id": shop_id, "start": start, "end": end})
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_sales_trend(
    shop_id: int,
    metric: str = "gmv",
    granularity: str = "day",
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """获取销售趋势序列。metric 可选 gmv/orders/ad_spend/roi/gpm/gross_profit；
    granularity 可选 day/week/month；返回本期与上期两条序列。"""
    start, end = _range(start_date, end_date)
    try:
        return await get(
            "/dashboard/trend",
            {"shop_id": shop_id, "metric": metric, "granularity": granularity, "start": start, "end": end},
        )
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_conversion_funnel(
    shop_id: int, start_date: str | None = None, end_date: str | None = None
) -> dict:
    """获取曝光 → 点击 → 进店 → 下单 四级转化漏斗，含每级转化率与上期对比。"""
    start, end = _range(start_date, end_date)
    try:
        return await get("/dashboard/funnel", {"shop_id": shop_id, "start": start, "end": end})
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_gpm_breakdown(
    shop_id: int, start_date: str | None = None, end_date: str | None = None
) -> dict:
    """GPM 三因子拆解：GPM = 1000 × CTR × CVR × AOV，返回汇总、逐日序列与上期对比瀑布贡献。"""
    start, end = _range(start_date, end_date)
    try:
        return await get("/dashboard/gpm-breakdown", {"shop_id": shop_id, "start": start, "end": end})
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_profit_report(
    shop_id: int, start_date: str | None = None, end_date: str | None = None
) -> dict:
    """获取毛利、毛利率、保本销售额与保本达成率，并附当前成本参数口径。"""
    start, end = _range(start_date, end_date)
    try:
        data = await get("/metrics/daily", {"shop_id": shop_id, "start": start, "end": end})
        items = data.get("items", [])
        gmv = sum(item["gmv"] for item in items)
        gross_profit = sum(item.get("gross_profit") or 0 for item in items)
        break_even = sum(item.get("break_even_sales") or 0 for item in items)
        return {
            "range": {"start": start, "end": end},
            "gmv": round(gmv, 2),
            "gross_profit": round(gross_profit, 2),
            "gross_margin": round(gross_profit / gmv, 4) if gmv else None,
            "break_even_sales": round(break_even, 2),
            "break_even_rate": round(gmv / break_even, 4) if break_even else None,
            "cost_config": data.get("cost_config"),
            "daily": items,
        }
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_ad_performance(
    shop_id: int, start_date: str | None = None, end_date: str | None = None
) -> list | dict:
    """获取按日广告投放表现（消耗、曝光、点击、ROI、GPM）。"""
    start, end = _range(start_date, end_date)
    try:
        return await get("/ads", {"shop_id": shop_id, "start": start, "end": end})
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def list_comments(
    shop_id: int,
    sentiment: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 20,
) -> dict:
    """分页查看评论，可按情感（positive/neutral/negative）筛选。返回评论内容、情感分与关键词。"""
    start, end = _range(start_date, end_date)
    params = {"shop_id": shop_id, "start": start, "end": end, "page": 1, "page_size": min(limit, 100)}
    if sentiment:
        params["sentiment"] = sentiment
    try:
        return await get("/comments", params)
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def get_comment_insights(
    shop_id: int, start_date: str | None = None, end_date: str | None = None
) -> dict:
    """评论洞察：情感分布占比 + Top15 高频关键词。"""
    start, end = _range(start_date, end_date)
    try:
        return await get("/dashboard/sentiment", {"shop_id": shop_id, "start": start, "end": end})
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def query_orders(
    shop_id: int,
    status: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 20,
) -> dict:
    """查询订单明细，可按状态（paid/shipped/refunded）筛选。"""
    start, end = _range(start_date, end_date)
    params = {"shop_id": shop_id, "start": start, "end": end, "page": 1, "page_size": min(limit, 100)}
    if status:
        params["status"] = status
    try:
        return await get("/orders", params)
    except BackendError as exc:
        return _error(exc)


@mcp.tool()
async def trigger_sync(shop_id: int, resource: str = "orders") -> dict:
    """触发一次店铺数据增量同步。resource 可选 orders/ads/comments/products。"""
    try:
        return await post(f"/shops/{shop_id}/sync", json={"resource": resource, "mode": "incremental", "days": 30})
    except BackendError as exc:
        return _error(exc)


def main() -> None:
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run()
    else:
        mcp.run(transport=transport)


if __name__ == "__main__":
    main()
