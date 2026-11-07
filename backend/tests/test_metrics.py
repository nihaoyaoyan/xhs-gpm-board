from app.services.metrics import CostRates, compute_metrics


def test_compute_metrics_core_formulas():
    result = compute_metrics(
        impressions=100_000,
        clicks=3_000,
        visits=2_000,
        orders_count=150,
        gmv=30_000.0,
        ad_spend=5_000.0,
        cost=CostRates(
            cost_rate=0.45, platform_fee_rate=0.05, return_rate=0.08, monthly_fixed_cost=3_000
        ),
        days_in_month=30,
    )

    assert result["ctr"] == 0.03
    assert result["cvr"] == 0.05
    assert result["aov"] == 200.0
    assert result["gpm"] == 300.0
    assert result["roi"] == 6.0
    # 毛利 = GMV×42% − 广告 − 固定成本日分摊 = 12600 − 5000 − 100
    assert result["gross_profit"] == 7_500.0
    assert result["gross_margin"] == 0.25
    # 保本销售额 = (固定成本日分摊 + 广告) / 42%
    assert result["break_even_sales"] == 12_142.86


def test_gpm_identity():
    result = compute_metrics(
        impressions=100_000,
        clicks=3_000,
        visits=2_000,
        orders_count=150,
        gmv=30_000.0,
        ad_spend=5_000.0,
        cost=CostRates(),
        days_in_month=30,
    )
    gpm_from_factors = 1000 * result["ctr"] * result["cvr"] * result["aov"]
    assert abs(result["gpm"] - gpm_from_factors) < 0.01


def test_zero_denominator_is_none():
    result = compute_metrics(
        impressions=0,
        clicks=0,
        visits=0,
        orders_count=0,
        gmv=0.0,
        ad_spend=0.0,
        cost=CostRates(),
        days_in_month=30,
    )
    assert result["ctr"] is None
    assert result["cvr"] is None
    assert result["aov"] is None
    assert result["gpm"] is None
    assert result["roi"] is None
