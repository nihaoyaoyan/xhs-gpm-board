import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Input, Row, Space, Table, Tag } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useState } from 'react';
import { api } from '@/api';
import type { SearchTermRow } from '@/api/types';
import KpiCard from '@/components/KpiCard';
import { useRangeParams } from '@/stores/filter';
import { exportXlsx } from '@/utils/exportXlsx';
import { fmtCompact, fmtMoney, fmtNumber, fmtPct, fmtRatio } from '@/utils/format';

export default function AdSearchTerms() {
  const { shop_id, start, end, enabled } = useRangeParams();
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');

  const query = useQuery({
    queryKey: ['search-terms-ad', shop_id, start, end, keyword],
    queryFn: () =>
      api.searchTerms({
        shop_id,
        channel: 'ad',
        start,
        end,
        keyword: keyword || undefined,
      }),
    enabled,
  });

  const summary = query.data?.summary;
  const items = query.data?.items ?? [];
  const top = items.slice(0, 10);

  const chartOption = {
    grid: { left: 118, right: 28, top: 20, bottom: 20 },
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
      axisLabel: { width: 108, overflow: 'truncate', color: '#595959' },
    },
    series: [
      {
        type: 'bar',
        data: top.map((item) => item.ad_spend).reverse(),
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
      title: '消耗',
      dataIndex: 'ad_spend',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.ad_spend - b.ad_spend,
      render: (value: number) => fmtMoney(value),
    },
    {
      title: '曝光',
      dataIndex: 'impressions',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.impressions - b.impressions,
      render: (value: number) => fmtCompact(value),
    },
    {
      title: '点击',
      dataIndex: 'clicks',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.clicks - b.clicks,
      render: (value: number) => fmtNumber(value),
    },
    {
      title: 'CTR',
      dataIndex: 'ctr',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => (a.ctr ?? 0) - (b.ctr ?? 0),
      render: (value: number | null) => fmtPct(value),
    },
    {
      title: '成交订单',
      dataIndex: 'orders',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.orders - b.orders,
      render: (value: number) => fmtNumber(value),
    },
    {
      title: 'CVR',
      dataIndex: 'cvr',
      align: 'right' as const,
      render: (value: number | null) => fmtPct(value),
    },
    {
      title: 'GMV',
      dataIndex: 'gmv',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.gmv - b.gmv,
      render: (value: number) => fmtMoney(value),
    },
    {
      title: 'ROI',
      dataIndex: 'roi',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => (a.roi ?? 0) - (b.roi ?? 0),
      render: (value: number | null) => `${fmtRatio(value)}x`,
    },
    {
      title: 'GPM',
      dataIndex: 'gpm',
      align: 'right' as const,
      render: (value: number | null) => fmtMoney(value),
    },
    {
      title: 'GMV 占比',
      dataIndex: 'gmv_share',
      align: 'right' as const,
      render: (value: number) => fmtPct(value),
    },
  ];

  const handleSearch = (value: string) => setKeyword(value.trim());

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="广告搜索词分析"
        description="按投放搜索词聚合曝光、点击、消耗与成交表现，用于识别高消耗低转化的词与值得加投的词。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="广告消耗" value={summary?.ad_spend} formatter={(v) => fmtMoney(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="广告 GMV" value={summary?.gmv} formatter={(v) => fmtMoney(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="整体 ROI" value={summary?.roi} formatter={(v) => `${fmtRatio(Number(v))}x`} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="成交订单" value={summary?.orders} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="点击量" value={summary?.clicks} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard
            title="平均 CPC"
            value={summary?.clicks ? summary.ad_spend / summary.clicks : null}
            formatter={(v) => fmtMoney(Number(v))}
            tip="广告消耗 / 点击量"
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card size="small" title="消耗 Top 10 搜索词">
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
                onSearch={handleSearch}
                enterButton="筛选"
              />
              <div style={{ color: '#8c8c8c', fontSize: 12, lineHeight: 1.9 }}>
                <div>· CTR = 点击 / 曝光，CVR = 成交订单 / 点击</div>
                <div>· ROI = 广告 GMV / 广告消耗</div>
                <div>· GPM = 广告 GMV / 曝光 × 1000</div>
                <div>· 共匹配 {summary?.terms ?? 0} 个搜索词，按 GMV 降序展示</div>
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
            disabled={!items.length}
            onClick={() =>
              exportXlsx(
                '广告搜索词分析',
                [
                  { title: '搜索词', dataIndex: 'term' },
                  { title: '消耗', dataIndex: 'ad_spend' },
                  { title: '曝光', dataIndex: 'impressions' },
                  { title: '点击', dataIndex: 'clicks' },
                  { title: 'CTR', dataIndex: 'ctr', formatter: (v) => fmtPct(v as number) },
                  { title: '成交订单', dataIndex: 'orders' },
                  { title: 'CVR', dataIndex: 'cvr', formatter: (v) => fmtPct(v as number) },
                  { title: 'GMV', dataIndex: 'gmv' },
                  { title: 'ROI', dataIndex: 'roi', formatter: (v) => fmtRatio(v as number) },
                  { title: 'GPM', dataIndex: 'gpm' },
                  { title: 'GMV 占比', dataIndex: 'gmv_share', formatter: (v) => fmtPct(v as number) },
                ],
                items as unknown as Record<string, unknown>[],
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
          dataSource={items}
          pagination={{ pageSize: 10, showSizeChanger: false }}
        />
      </Card>
    </Space>
  );
}
