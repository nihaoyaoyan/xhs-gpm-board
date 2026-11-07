from datetime import date
from decimal import Decimal

from app.db.session import SessionLocal
from app.models import SearchTerm


async def test_ad_search_terms_aggregation(api_ctx):
    client, shop_id = api_ctx.client, api_ctx.shop_id
    today = date.today()

    async with SessionLocal() as session:
        session.add_all(
            [
                SearchTerm(
                    shop_id=shop_id,
                    date=today,
                    channel="ad",
                    term="虾仁低脂餐",
                    impressions=1000,
                    clicks=50,
                    visits=35,
                    orders_count=5,
                    gmv=Decimal("500.00"),
                    ad_spend=Decimal("100.00"),
                ),
                SearchTerm(
                    shop_id=shop_id,
                    date=today,
                    channel="ad",
                    term="三文鱼刺身",
                    impressions=2000,
                    clicks=40,
                    visits=28,
                    orders_count=2,
                    gmv=Decimal("200.00"),
                    ad_spend=Decimal("80.00"),
                ),
                SearchTerm(
                    shop_id=shop_id,
                    date=today,
                    channel="shop",
                    term="牛肋排",
                    impressions=5000,
                    clicks=300,
                    visits=200,
                    orders_count=10,
                    gmv=Decimal("1200.00"),
                    ad_spend=Decimal("0.00"),
                ),
            ]
        )
        await session.commit()

    params = {"shop_id": shop_id, "start": today.isoformat(), "end": today.isoformat()}
    ad = (await client.get("/api/v1/search-terms", params={**params, "channel": "ad"})).json()["data"]
    shop = (await client.get("/api/v1/search-terms", params={**params, "channel": "shop"})).json()["data"]

    assert ad["summary"]["terms"] == 2
    assert ad["summary"]["gmv"] == 700.0
    assert ad["summary"]["ad_spend"] == 180.0
    assert ad["summary"]["orders"] == 7
    assert ad["summary"]["ctr"] == 0.03
    assert ad["summary"]["cvr"] == round(7 / 90, 4)
    assert ad["summary"]["gpm"] == round(700 * 1000 / 3000, 2)
    assert ad["summary"]["roi"] == round(700 / 180, 4)

    assert ad["items"][0]["term"] == "虾仁低脂餐"
    assert ad["items"][0]["gmv_share"] == round(500 / 700, 4)
    assert ad["items"][1]["term"] == "三文鱼刺身"

    assert shop["summary"]["terms"] == 1
    assert shop["summary"]["gmv"] == 1200.0
    assert shop["summary"]["roi"] is None
    assert shop["items"][0]["term"] == "牛肋排"


async def test_search_terms_keyword_filter(api_ctx):
    client, shop_id = api_ctx.client, api_ctx.shop_id
    today = date.today()

    async with SessionLocal() as session:
        session.add_all(
            [
                SearchTerm(
                    shop_id=shop_id,
                    date=today,
                    channel="shop",
                    term="虾仁",
                    impressions=100,
                    clicks=10,
                    orders_count=1,
                    gmv=Decimal("80.00"),
                ),
                SearchTerm(
                    shop_id=shop_id,
                    date=today,
                    channel="shop",
                    term="三文鱼",
                    impressions=100,
                    clicks=8,
                    orders_count=1,
                    gmv=Decimal("60.00"),
                ),
            ]
        )
        await session.commit()

    params = {
        "shop_id": shop_id,
        "channel": "shop",
        "start": today.isoformat(),
        "end": today.isoformat(),
        "keyword": "虾",
    }
    data = (await client.get("/api/v1/search-terms", params=params)).json()["data"]
    assert data["summary"]["terms"] == 1
    assert data["items"][0]["term"] == "虾仁"
