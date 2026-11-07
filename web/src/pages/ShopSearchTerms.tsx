import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import ReactECharts from 'echarts-for-react';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { api } from '@/api';
import type { SearchTermRow, SearchTermSummary } from '@/api/types';
import KpiCard from '@/components/KpiCard';
import { useRangeParams } from '@/stores/filter';
import { exportXlsx } from '@/utils/exportXlsx';
import { fmtCompact, fmtMoney, fmtNumber, fmtPct } from '@/utils/format';

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

function summarizeTerms(rows: SearchTermRow[]): SearchTermSummary {
  const sum = (key: 'impressions' | 'clicks' | 'visits' | 'orders' | 'buyers') =>
    rows.reduce((total, row) => total + row[key], 0);
  const gmv = round(rows.reduce((total, row) => total + row.gmv, 0), 2);
  const adSpend = round(rows.reduce((total, row) => total + row.ad_spend, 0), 2);
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const orders = sum('orders');
  return {
    terms: rows.length,
    impressions,
    clicks,
    visits: sum('visits'),
    orders,
    buyers: sum('buyers'),
    gmv,
    ad_spend: adSpend,
    ctr: impressions ? round(clicks / impressions) : null,
    cvr: clicks ? round(orders / clicks) : null,
    gpm: impressions ? round(gmv * 1000 / impressions, 2) : null,
    roi: adSpend ? round(gmv / adSpend) : null,
  };
}

export default function ShopSearchTerms() {
  const { shop_id, enabled } = useRangeParams();
  const [month, setMonth] = useState<Dayjs>(() => dayjs().subtract(1, 'month'));
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState('gmv');

  const start = month.startOf('month').format('YYYY-MM-DD');
  const end = month.endOf('month').format('YYYY-MM-DD');

  const query = useQuery({
    queryKey: ['search-terms-shop', shop_id, month.format('YYYY-MM'), sort],
    queryFn: () =>
      api.searchTerms({
        shop_id,
        channel: 'shop',
        start,
        end,
        sort,
        limit: 800,
      }),
    enabled,
  });

  const summary = query.data?.summary;
  const items = query.data?.items ?? [];
  const filteredItems = keyword ? items.filter((item) => item.term.includes(keyword)) : items;
  const activeSummary = keyword ? summarizeTerms(filteredItems) : summary;
  const top = filteredItems.slice(0, 10);

  const chartOption = {
    grid: { left: 126, right: 28, top: 20, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value: number) => fmtMoney(value),
    },
    xAxis: {
      type: 'value',
      axisLabel: { formatter: (value: number) => fmtCompact(value) },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    yAxis: {
      type: 'category',
      data: top.map((item) => item.term).reverse(),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { width: 116, overflow: 'truncate', color: '#595959' },
    },
    series: [
      {
        type: 'bar',
        data: top.map((item) => item.gmv).reverse(),
        barMaxWidth: 18,
        itemStyle: { color: '#FF2442', borderRadius: [0, 4, 4, 0] },
      },
    ],
  };

  const columns = [
    {
      title: '搜索词',
      dataIndex: 'term',
      render: (value: string) => <Tag color="red">{value}</Tag>,
    },
    {
      title: '支付金额',
      dataIndex: 'gmv',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.gmv - b.gmv,
      render: (value: number) => fmtMoney(value),
    },
    {
      title: '支付订单数',
      dataIndex: 'orders',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.orders - b.orders,
      render: (value: number) => fmtNumber(value),
    },
    {
      title: '支付买家数',
      dataIndex: 'buyers',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.buyers - b.buyers,
      render: (value: number) => fmtNumber(value),
    },
    {
      title: '商卡曝光人数',
      dataIndex: 'impressions',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.impressions - b.impressions,
      render: (value: number) => fmtCompact(value),
    },
    {
      title: '商品点击人数',
      dataIndex: 'clicks',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.clicks - b.clicks,
      render: (value: number) => fmtNumber(value),
    },
    {
      title: '商品点击率',
      dataIndex: 'ctr',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => (a.ctr ?? 0) - (b.ctr ?? 0),
      render: (value: number | null) => fmtPct(value),
    },
    {
      title: '支付转化率',
      dataIndex: 'cvr',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => (a.cvr ?? 0) - (b.cvr ?? 0),
      render: (value: number | null) => fmtPct(value),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="店铺搜索词分析"
        description="按月查看搜索词的商卡曝光、商品点击与支付转化表现，辅助选品与标题关键词优化。"
      />

      <Space wrap align="center">
        <Typography.Text type="secondary">统计月份</Typography.Text>
        <DatePicker
          picker="month"
          allowClear={false}
          value={month}
          onChange={(value) => {
            if (value) setMonth(value);
          }}
          disabledDate={(current) => current.isAfter(dayjs(), 'month')}
          style={{ width: 160 }}
        />
        <Typography.Text type="secondary">店铺搜索词为月度汇总数据，仅支持按月查看</Typography.Text>
      </Space>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="支付金额" value={activeSummary?.gmv} formatter={(v) => fmtMoney(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="支付订单数" value={activeSummary?.orders} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="支付买家数" value={activeSummary?.buyers} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard
            title="商卡曝光人数"
            value={activeSummary?.impressions}
            formatter={(v) => fmtCompact(Number(v))}
          />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="商品点击人数" value={activeSummary?.clicks} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="支付转化率" value={activeSummary?.cvr} formatter={(v) => fmtPct(Number(v))} />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card size="small" title="支付金额 Top 10 搜索词">
            {top.length ? (
              <ReactECharts option={chartOption} style={{ height: 380 }} notMerge />
            ) : (
              <div className="chart-empty">暂无搜索词数据</div>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card size="small" title="筛选与说明">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Input.Search
                allowClear
                placeholder="输入搜索词关键词"
                prefix={<SearchOutlined />}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onSearch={(value) => setKeyword(value.trim())}
                enterButton="筛选"
              />
              <Select
                value={sort}
                onChange={setSort}
                style={{ width: '100%' }}
                options={[
                  { value: 'gmv', label: '按支付金额排序' },
                  { value: 'orders', label: '按支付订单数排序' },
                  { value: 'buyers', label: '按支付买家数排序' },
                  { value: 'impressions', label: '按商卡曝光人数排序' },
                  { value: 'clicks', label: '按商品点击人数排序' },
                ]}
              />
              <div style={{ color: '#8c8c8c', fontSize: 12, lineHeight: 1.9 }}>
                <div>· 商卡曝光人数 → 商品点击人数 → 支付订单/买家</div>
                <div>· 商品点击率 = 商品点击人数 / 商卡曝光人数</div>
                <div>· 支付转化率 = 支付订单数 / 商品点击人数</div>
                <div>· 共匹配 {activeSummary?.terms ?? 0} 个搜索词</div>
              </div>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title="搜索词明细"
        extra={
          <Button
            icon={<DownloadOutlined />}
            disabled={!filteredItems.length}
            onClick={() =>
              exportXlsx(
                '店铺搜索词分析',
                [
                  { title: '搜索词', dataIndex: 'term' },
                  { title: '支付金额', dataIndex: 'gmv' },
                  { title: '支付订单数', dataIndex: 'orders' },
                  { title: '支付买家数', dataIndex: 'buyers' },
                  { title: '商卡曝光人数', dataIndex: 'impressions' },
                  { title: '商品点击人数', dataIndex: 'clicks' },
                  { title: '商品点击率', dataIndex: 'ctr', formatter: (v) => fmtPct(v as number) },
                  { title: '支付转化率', dataIndex: 'cvr', formatter: (v) => fmtPct(v as number) },
                ],
                filteredItems as unknown as Record<string, unknown>[],
              )
            }
          >
            导出 Excel
          </Button>
        }
      >
        <Table<SearchTermRow>
          rowKey="term"
          size="small"
          loading={query.isLoading}
          columns={columns as never}
          dataSource={filteredItems}
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </Card>
    </Space>
  );
}
