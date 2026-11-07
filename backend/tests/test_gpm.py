from datetime import date, datetime, time, timezone
from decimal import Decimal

from app.db.session import SessionLocal
from app.models import AdRecord, Order
from app.services.metrics import refresh_daily_metrics


async def test_gpm_breakdown_matches_daily_metrics(api_ctx):
    client, shop_id = api_ctx.client, api_ctx.shop_id
    today = date.today()

    async with SessionLocal() as session:
        session.add(
            Order(
                shop_id=shop_id,
                external_id="TEST-ORDER-1",
                qty=1,
                amount=Decimal("300.00"),
                refund_amount=Decimal("0.00"),
                status="paid",
                paid_at=datetime.combine(today, time(10), tzinfo=timezone.utc),
            )
        )
        session.add(
            AdRecord(
                shop_id=shop_id,
                date=today,
                campaign_id="C001",
                campaign_name="测试计划",
                spend=Decimal("100.00"),
                impressions=10_000,
                clicks=300,
                visits=200,
                gmv=Decimal("300.00"),
                order_count=2,
            )
        )
        await session.commit()
        await refresh_daily_metrics(session, shop_id, today, today)

    params = {"shop_id": shop_id, "start": today.isoformat(), "end": today.isoformat()}
    gpm_response = await client.get("/api/v1/dashboard/gpm-breakdown", params=params)
    overview_response = await client.get("/api/v1/dashboard/overview", params=params)
    metrics_response = await client.get("/api/v1/metrics/daily", params=params)

    assert gpm_response.status_code == 200
    assert overview_response.status_code == 200
    assert metrics_response.status_code == 200

    summary = gpm_response.json()["data"]["summary"]
    overview = overview_response.json()["data"]["current"]
    daily = metrics_response.json()["data"]["items"]

    assert summary["gmv"] == 300.0
    assert summary["gpm"] == 30.0
    assert daily[0]["gpm"] == 30.0
    assert overview["gmv"] == 300.0
    assert overview["orders"] == 1
    # 毛利按日分摊固定成本：GMV×42% − 广告 − 3000/当月天数，应与日指标一致
    assert round(overview["gross_profit"], 2) == round(daily[0]["gross_profit"], 2)


async def test_funnel_and_trend_are_consistent(api_ctx):
    client, shop_id = api_ctx.client, api_ctx.shop_id
    today = date.today()

    async with SessionLocal() as session:
        session.add(
            Order(
                shop_id=shop_id,
                external_id="TEST-ORDER-2",
                qty=1,
                amount=Decimal("240.00"),
                refund_amount=Decimal("0.00"),
                status="paid",
                paid_at=datetime.combine(today, time(11), tzinfo=timezone.utc),
            )
        )
        session.add(
            AdRecord(
                shop_id=shop_id,
                date=today,
                campaign_id="C002",
                spend=Decimal("80.00"),
                impressions=8_000,
                clicks=240,
                visits=160,
                gmv=Decimal("240.00"),
                order_count=1,
            )
        )
        await session.commit()
        await refresh_daily_metrics(session, shop_id, today, today)

    params = {"shop_id": shop_id, "start": today.isoformat(), "end": today.isoformat()}
    funnel = (await client.get("/api/v1/dashboard/funnel", params=params)).json()["data"]
    trend = (
        await client.get("/api/v1/dashboard/trend", params={**params, "metric": "gmv"})
    ).json()["data"]

    assert [step["name"] for step in funnel["steps"]] == ["曝光", "点击", "进店", "下单"]
    assert funnel["steps"][0]["value"] == 8_000
    assert funnel["steps"][1]["value"] == 240
    assert trend["dates"] == [today.isoformat()]
    assert trend["current"][0] == 240.0
