import { DownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Col, Input, Row, Select, Space, Table, Tag } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useState } from 'react';
import { api } from '@/api';
import type { SearchTermRow } from '@/api/types';
import KpiCard from '@/components/KpiCard';
import { useRangeParams } from '@/stores/filter';
import { exportXlsx } from '@/utils/exportXlsx';
import { fmtCompact, fmtMoney, fmtNumber, fmtPct } from '@/utils/format';

export default function NoteSearchTerms() {
  const { shop_id, start, end, enabled } = useRangeParams();
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState('impressions');

  const query = useQuery({
    queryKey: ['search-terms-note', shop_id, start, end, keyword, sort],
    queryFn: () =>
      api.searchTerms({
        shop_id,
        channel: 'note',
        start,
        end,
        keyword: keyword || undefined,
        sort,
      }),
    enabled,
  });

  const summary = query.data?.summary;
  const items = query.data?.items ?? [];
  const top = items.slice(0, 10);

  const chartOption = {
    grid: { left: 128, right: 28, top: 20, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value: number) => fmtCompact(value),
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
      axisLabel: { width: 118, overflow: 'truncate', color: '#595959' },
    },
    series: [
      {
        type: 'bar',
        data: top.map((item) => item.impressions).reverse(),
        barMaxWidth: 18,
        itemStyle: { color: '#FF2442', borderRadius: [0, 4, 4, 0] },
      },
    ],
  };

  const columns = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 64,
      render: (_: unknown, __: SearchTermRow, index: number) => (
        <span style={{ fontWeight: index < 3 ? 600 : 400, color: index < 3 ? '#FF2442' : '#595959' }}>
          {index + 1}
        </span>
      ),
    },
    {
      title: '搜索词',
      dataIndex: 'term',
      render: (value: string) => <Tag color="red">{value}</Tag>,
    },
    {
      title: '搜索曝光',
      dataIndex: 'impressions',
      align: 'right' as const,
      sorter: (a: SearchTermRow, b: SearchTermRow) => a.impressions - b.impressions,
      render: (value: number) => fmtCompact(value),
    },
    {
      title: '笔记点击',
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
      title: '进店',
      dataIndex: 'visits',
      align: 'right' as const,
      render: (value: number) => fmtNumber(value),
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
      title: 'GMV 占比',
      dataIndex: 'gmv_share',
      align: 'right' as const,
      render: (value: number) => fmtPct(value),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="笔记搜索词分析"
        description="围绕笔记被搜索到的关键词，拆解搜索曝光、点击效率与进店成交表现，定位高潜力选题与标题关键词。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="搜索曝光" value={summary?.impressions} formatter={(v) => fmtCompact(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="笔记点击" value={summary?.clicks} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="点击率 CTR" value={summary?.ctr} formatter={(v) => fmtPct(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="进店" value={summary?.visits} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="成交订单" value={summary?.orders} formatter={(v) => fmtNumber(Number(v))} />
        </Col>
        <Col xs={24} sm={12} xl={4}>
          <KpiCard title="搜索 GMV" value={summary?.gmv} formatter={(v) => fmtMoney(Number(v))} />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card size="small" title="搜索曝光 Top 10 笔记搜索词">
            {top.length ? (
              <ReactECharts option={chartOption} style={{ height: 380 }} notMerge />
            ) : (
              <div className="chart-empty">暂无笔记搜索词数据</div>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card size="small" title="筛选与说明">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Input.Search
                allowClear
                placeholder="输入笔记搜索词关键词"
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
                  { value: 'impressions', label: '按搜索曝光排序' },
                  { value: 'clicks', label: '按笔记点击排序' },
                  { value: 'orders', label: '按成交订单排序' },
                  { value: 'gmv', label: '按 GMV 排序' },
                ]}
              />
              <div style={{ color: '#8c8c8c', fontSize: 12, lineHeight: 1.9 }}>
                <div>· 搜索曝光 → 笔记点击 → 进店 → 成交</div>
                <div>· CTR = 笔记点击 / 搜索曝光</div>
                <div>· CVR = 成交订单 / 笔记点击</div>
                <div>· 共匹配 {summary?.terms ?? 0} 个搜索词</div>
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
                '笔记搜索词分析',
                [
                  { title: '搜索词', dataIndex: 'term' },
                  { title: '搜索曝光', dataIndex: 'impressions' },
                  { title: '笔记点击', dataIndex: 'clicks' },
                  { title: 'CTR', dataIndex: 'ctr', formatter: (v) => fmtPct(v as number) },
                  { title: '进店', dataIndex: 'visits' },
                  { title: '成交订单', dataIndex: 'orders' },
                  { title: 'CVR', dataIndex: 'cvr', formatter: (v) => fmtPct(v as number) },
                  { title: 'GMV', dataIndex: 'gmv' },
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
