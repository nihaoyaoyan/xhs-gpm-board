"""确定性 Mock 数据源：无千帆凭证也能完整演示系统。

同一店铺 + 同一日期始终生成相同数据，避免重复同步造成数据漂移。
"""

from __future__ import annotations

import hashlib
import random
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.models import Shop
from app.services.providers.base import PageResult, SyncProvider

TZ = ZoneInfo("Asia/Shanghai")

PRODUCTS = [
    ("P1001", "鲜冻大虾仁 500g 免浆去虾线", 89.0, 3),
    ("P1002", "挪威三文鱼刺身中段 300g", 128.0, 2),
    ("P1003", "谷饲黄膘牛肋排 1.5kg", 168.0, 4),
    ("P1004", "低脂鸡胸肉即食装 10袋", 69.0, 5),
    ("P1005", "春日轻食蔬菜组合箱 5斤", 49.0, 6),
]

COMMENT_POSITIVE = [
    "虾仁个头很均匀，解冻后没有缩水，炒蛋特别鲜",
    "三文鱼油脂分布漂亮，切面新鲜，在家吃很划算",
    "牛肋排炖了一锅，肉香很足，孩子吃了两碗饭",
    "包装扎实，冰袋还没化，收到的时候还是硬邦邦的",
    "轻食餐搭配这个虾仁，一周午餐都解决了，很省心",
    "复购第三次了，品质稳定，处理得也干净",
]
COMMENT_NEUTRAL = [
    "整体还行，就是配送比预计晚了一天",
    "分量和描述差不多，口感中规中矩",
    "包装有点简单，好在食材没受影响",
    "价格小贵，等活动的时候再囤",
]
COMMENT_NEGATIVE = [
    "收到的时候冰袋已经化了，体验不太好",
    "这次虾仁腥味有点重，焯水之后还是能闻到",
    "牛肋排肥肉比上次多，切得也不均匀",
    "客服回复太慢，退款流程走了三天",
]

AD_SEARCH_TERMS = [
    "虾仁低脂餐",
    "三文鱼刺身",
    "牛肋排家常做法",
    "轻食代餐食材",
    "高蛋白减脂餐",
    "春日轻食食谱",
    "即食鸡胸肉",
    "海鲜礼盒送礼",
    "宝宝辅食虾仁",
    "空气炸锅食材",
]

SHOP_SEARCH_TERMS = [
    "虾仁",
    "三文鱼",
    "牛肋排",
    "轻食",
    "低脂高蛋白",
    "春日食谱",
    "即食海鲜",
    "减脂餐食材",
    "生鲜礼盒",
    "宝宝辅食",
]

NOTE_SEARCH_TERMS = [
    "虾仁减脂餐教程",
    "三文鱼刺身摆盘",
    "牛肋排家常做法",
    "春日轻食食谱",
    "空气炸锅食谱",
    "打工人带饭日记",
    "低卡晚餐合集",
    "宝宝辅食虾仁",
    "生鲜开箱测评",
    "减脂期吃什么",
]


def _rng(shop: Shop, day: date) -> random.Random:
    seed = f"{shop.qianfan_shop_id}:{day.isoformat()}"
    return random.Random(int(hashlib.md5(seed.encode()).hexdigest()[:12], 16))


def _term_rng(shop: Shop, day: date, channel: str) -> random.Random:
    seed = f"{shop.qianfan_shop_id}:{day.isoformat()}:{channel}:terms"
    return random.Random(int(hashlib.md5(seed.encode()).hexdigest()[:12], 16))


def _start_of(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=TZ)


def _end_of(day: date) -> datetime:
    return datetime.combine(day, time.max, tzinfo=TZ)


class MockProvider(SyncProvider):
    async def fetch_products(self, shop: Shop, since: datetime, until: datetime) -> list[dict]:
        return [
            {"external_id": pid, "title": title, "price": price, "sku_count": sku}
            for pid, title, price, sku in PRODUCTS
        ]

    async def fetch_orders(
        self, shop: Shop, since: datetime, until: datetime, cursor: str | None = None
    ) -> PageResult:
        rows: list[dict] = []
        day = since.date()
        last = until.date()
        while day <= last:
            rng = _rng(shop, day)
            weekday = day.weekday()
            base = rng.randint(22, 38)
            if weekday >= 5:
                base = int(base * 1.35)
            for i in range(base):
                pid, title, price, _ = rng.choice(PRODUCTS)
                qty = rng.choices([1, 1, 1, 2, 2, 3], k=1)[0]
                amount = round(price * qty * rng.uniform(0.92, 1.0), 2)
                roll = rng.random()
                if roll < 0.06:
                    status, refund = "refunded", amount
                elif roll < 0.12:
                    status, refund = "shipped", 0.0
                else:
                    status, refund = "paid", 0.0
                paid_at = datetime.combine(day, time(rng.randint(8, 23), rng.randint(0, 59)), tzinfo=TZ)
                if paid_at < since or paid_at > until:
                    continue
                rows.append(
                    {
                        "external_id": f"MOCK-{shop.qianfan_shop_id}-{day.isoformat()}-{i:04d}",
                        "product_title": title,
                        "sku_name": f"{qty}件装",
                        "qty": qty,
                        "amount": amount,
                        "refund_amount": refund,
                        "status": status,
                        "paid_at": paid_at,
                        "raw": {"source": "mock", "product_code": pid},
                    }
                )
            day += timedelta(days=1)
        return PageResult(rows=rows, next_cursor=None)

    async def fetch_ads(self, shop: Shop, since: datetime, until: datetime) -> list[dict]:
        rows: list[dict] = []
        day = since.date()
        last = until.date()
        campaigns = [("C001", "信息流推广"), ("C002", "搜索推广")]
        while day <= last:
            rng = _rng(shop, day)
            for campaign_id, campaign_name in campaigns:
                impressions = rng.randint(3200, 9200)
                clicks = int(impressions * rng.uniform(0.015, 0.042))
                visits = int(clicks * rng.uniform(0.5, 0.72))
                spend = round(rng.uniform(60, 320), 2)
                order_count = int(clicks * rng.uniform(0.03, 0.09))
                gmv = round(spend * rng.uniform(1.6, 4.2), 2)
                rows.append(
                    {
                        "date": day,
                        "campaign_id": campaign_id,
                        "campaign_name": campaign_name,
                        "spend": spend,
                        "impressions": impressions,
                        "clicks": clicks,
                        "visits": visits,
                        "gmv": gmv,
                        "order_count": order_count,
                    }
                )
            day += timedelta(days=1)
        return rows

    async def fetch_comments(
        self, shop: Shop, since: datetime, until: datetime, cursor: str | None = None
    ) -> PageResult:
        rows: list[dict] = []
        day = since.date()
        last = until.date()
        while day <= last:
            rng = _rng(shop, day)
            for i in range(rng.randint(5, 9)):
                pool = rng.choices(
                    [COMMENT_POSITIVE, COMMENT_NEUTRAL, COMMENT_NEGATIVE], weights=[0.66, 0.2, 0.14]
                )[0]
                content = rng.choice(pool)
                if pool is COMMENT_POSITIVE:
                    rating = rng.choice([5, 5, 4])
                elif pool is COMMENT_NEUTRAL:
                    rating = 3
                else:
                    rating = rng.choice([2, 1])
                product = rng.choice(PRODUCTS)
                comment_at = datetime.combine(day, time(rng.randint(9, 22), rng.randint(0, 59)), tzinfo=TZ)
                if comment_at < since or comment_at > until:
                    continue
                rows.append(
                    {
                        "external_id": f"MOCKC-{shop.qianfan_shop_id}-{day.isoformat()}-{i:03d}",
                        "product_title": product[1],
                        "content": content,
                        "rating": rating,
                        "like_count": rng.randint(0, 32),
                        "comment_at": comment_at,
                    }
                )
            day += timedelta(days=1)
        return PageResult(rows=rows, next_cursor=None)

    async def fetch_search_terms(self, shop: Shop, since: datetime, until: datetime) -> list[dict]:
        rows: list[dict] = []
        day = since.date()
        last = until.date()
        while day <= last:
            for channel, terms in (
                ("ad", AD_SEARCH_TERMS),
                ("shop", SHOP_SEARCH_TERMS),
                ("note", NOTE_SEARCH_TERMS),
            ):
                rng = _term_rng(shop, day, channel)
                for term in terms:
                    if channel == "ad":
                        impressions = rng.randint(600, 6500)
                        clicks = int(impressions * rng.uniform(0.012, 0.05))
                        visits = int(clicks * rng.uniform(0.5, 0.7))
                        order_count = int(clicks * rng.uniform(0.02, 0.09))
                        spend = round(clicks * rng.uniform(0.35, 1.1), 2)
                        gmv = round(spend * rng.uniform(1.6, 4.5), 2)
                    elif channel == "note":
                        impressions = rng.randint(2500, 18000)
                        clicks = int(impressions * rng.uniform(0.03, 0.09))
                        visits = int(clicks * rng.uniform(0.7, 0.9))
                        order_count = int(clicks * rng.uniform(0.008, 0.04))
                        spend = 0.0
                        gmv = round(order_count * rng.uniform(65, 175), 2)
                    else:
                        impressions = rng.randint(1500, 12000)
                        clicks = int(impressions * rng.uniform(0.02, 0.07))
                        visits = int(clicks * rng.uniform(0.6, 0.8))
                        order_count = int(clicks * rng.uniform(0.01, 0.06))
                        spend = 0.0
                        gmv = round(order_count * rng.uniform(60, 160), 2)
                    rows.append(
                        {
                            "date": day,
                            "channel": channel,
                            "term": term,
                            "impressions": impressions,
                            "clicks": clicks,
                            "visits": visits,
                            "order_count": order_count,
                            "buyers": order_count,
                            "gmv": gmv,
                            "spend": spend,
                        }
                    )
            day += timedelta(days=1)
        return rows
