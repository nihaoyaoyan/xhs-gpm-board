import { useQuery } from '@tanstack/react-query';
import { Card, Col, Empty, Row, Spin, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { api } from '@/api';
import FunnelChart from '@/components/FunnelChart';
import KpiCard from '@/components/KpiCard';
import TrendChart from '@/components/TrendChart';
import { useRangeParams } from '@/stores/filter';
import {
  SENTIMENT_LABELS,
  fmtCompact,
  fmtMoney,
  fmtNumber,
  fmtPct,
  fmtRatio,
} from '@/utils/format';

const MONEY = (value: number | string) => fmtMoney(Number(value));
const NUM = (value: number | string) => fmtNumber(Number(value));

export default function Dashboard() {
  const { shop_id, start, end, enabled } = useRangeParams();

  const overview = useQuery({
    queryKey: ['overview', shop_id, start, end],
    queryFn: () => api.overview({ shop_id, start, end }),
    enabled,
  });
  const trend = useQuery({
    queryKey: ['trend', shop_id, start, end, 'gmv'],
    queryFn: () => api.trend({ shop_id, start, end, metric: 'gmv', granularity: 'day' }),
    enabled,
  });
  const funnel = useQuery({
    queryKey: ['funnel', shop_id, start, end],
    queryFn: () => api.funnel({ shop_id, start, end }),
    enabled,
  });
  const sentiment = useQuery({
    queryKey: ['sentiment', shop_id, start, end],
    queryFn: () => api.sentiment({ shop_id, start, end }),
    enabled,
  });

  if (!enabled) {
    return <Empty description="请先在店铺管理中添加店铺" style={{ marginTop: 80 }} />;
  }

  const loading = overview.isLoading;
  const current = overview.data?.current;
  const deltas = overview.data?.deltas ?? {};

  const pieOption = {
    color: ['#16a34a', '#f59e0b', '#FF2442', '#c9cdd4'],
    tooltip: { trigger: 'item', formatter: '{b}：{c} 条（{d}%）' },
    legend: { bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10 },
    series: [
      {
        type: 'pie',
        radius: ['45%', '68%'],
        center: ['50%', '44%'],
        label: { show: false },
        data: (sentiment.data?.distribution ?? []).map((item) => ({
          name: SENTIMENT_LABELS[item.sentiment]?.label ?? item.sentiment,
          value: item.count,
        })),
      },
    ],
  };

  return (
    <Spin spinning={loading}>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <KpiCard title="成交金额 GMV" value={current?.gmv} formatter={MONEY} delta={deltas.gmv} tip="选中区间内订单实付金额（扣除退款）" />
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <KpiCard title="订单量" value={current?.orders} formatter={NUM} delta={deltas.orders} />
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <KpiCard title="GPM" value={current?.gpm} formatter={MONEY} delta={deltas.gpm} tip="每千次曝光产生的成交金额" />
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <KpiCard title="投放 ROI" value={current?.roi} formatter={(v) => `${fmtRatio(Number(v))}x`} delta={deltas.roi} tip="GMV / 广告消耗" />
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <KpiCard title="预估毛利" value={current?.gross_profit} formatter={MONEY} delta={deltas.gross_profit} tip="扣除商品成本、平台佣金、退款与广告后的毛利" />
        </Col>
        <Col xs={24} sm={12} lg={8} xl={4}>
          <KpiCard
            title="保本倍数"
            value={current?.break_even_rate}
            formatter={(v) => `${fmtRatio(Number(v))}x`}
            delta={deltas.break_even_rate}
            tip="GMV / 保本销售额，大于 1 即盈利"
          />
        </Col>

        <Col xs={24} lg={16}>
          <Card title="GMV 日趋势" size="small">
            {trend.data ? (
              <TrendChart
                dates={trend.data.dates}
                current={trend.data.current}
                previous={trend.data.previous}
                label="GMV"
                height={330}
                valueFormatter={(value) => fmtMoney(value)}
              />
            ) : (
              <div className="chart-empty">加载中…</div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card title="转化漏斗" size="small">
            {funnel.data ? <FunnelChart steps={funnel.data.steps} height={330} /> : <div className="chart-empty">加载中…</div>}
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="评论情感分布" size="small">
            {sentiment.data && sentiment.data.total > 0 ? (
              <ReactECharts option={pieOption} style={{ height: 300 }} />
            ) : (
              <div className="chart-empty">该区间暂无评论数据</div>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            title="高频关键词"
            size="small"
            extra={<Typography.Text type="secondary">共 {sentiment.data?.total ?? 0} 条评论</Typography.Text>}
          >
            {(sentiment.data?.top_keywords ?? []).length ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 300, alignContent: 'flex-start' }}>
                {(sentiment.data?.top_keywords ?? []).map((item, index) => (
                  <Tag key={item.word} className="keyword-tag" color={index < 5 ? 'red' : 'default'}>
                    {item.word} · {item.count}
                  </Tag>
                ))}
              </div>
            ) : (
              <div className="chart-empty">暂无关键词，试试在评论洞察页重新分析</div>
            )}
          </Card>
        </Col>

        <Col span={24}>
          <Card size="small">
            <Row gutter={16}>
              <Col xs={12} md={6}>
                <Typography.Text type="secondary">曝光量</Typography.Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtCompact(current?.impressions)}</div>
              </Col>
              <Col xs={12} md={6}>
                <Typography.Text type="secondary">点击率 CTR</Typography.Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtPct(current?.ctr)}</div>
              </Col>
              <Col xs={12} md={6}>
                <Typography.Text type="secondary">转化率 CVR</Typography.Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtPct(current?.cvr)}</div>
              </Col>
              <Col xs={12} md={6}>
                <Typography.Text type="secondary">客单价 AOV</Typography.Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtMoney(current?.aov)}</div>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>
    </Spin>
  );
}
