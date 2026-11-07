import { DownloadOutlined, InfoCircleOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, DatePicker, Empty, Input, Select, Space, Table, Tabs, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import ReactECharts from 'echarts-for-react';
import { useEffect, useState } from 'react';
import { api } from '@/api';
import type { AdLevel, AdReportItem, AdReportMetrics } from '@/api/types';
import { useFilterStore, useRangeParams } from '@/stores/filter';
import { exportXlsx } from '@/utils/exportXlsx';
import { fmtMoney, fmtNumber, fmtPct, fmtRatio } from '@/utils/format';

const { RangePicker } = DatePicker;

const LEVEL_TABS: { key: AdLevel; label: string }[] = [
  { key: 'account', label: '广告账户' },
  { key: 'campaign', label: '广告计划' },
  { key: 'creativity', label: '广告创意' },
  { key: 'note', label: '笔记/素材' },
  { key: 'keyword', label: '关键词' },
  { key: 'live', label: '直播间' },
  { key: 'spu', label: '商品' },
];

const DIMENSION_COLUMNS: Record<string, { id?: string; name: string }> = {
  campaign: { id: '计划ID', name: '计划名称' },
  creativity: { id: '创意ID', name: '创意名称' },
  note: { id: '笔记ID', name: '笔记标题' },
  keyword: { name: '关键词' },
  live: { id: '直播间ID', name: '直播间名称' },
  spu: { id: '商品ID', name: '商品名称' },
};

function StatCard({
  title,
  value,
  delta,
  tone,
  tip,
}: {
  title: string;
  value: string;
  delta?: number | null;
  tone?: 'blue' | 'orange';
  tip?: string;
}) {
  const hasDelta = delta !== null && delta !== undefined && Number.isFinite(delta);
  return (
    <div className={`report-stat ${tone ?? ''}`}>
      <div className="report-stat-title">
        <span>{title}</span>
        {tip ? (
          <Tooltip title={tip}>
            <InfoCircleOutlined style={{ color: '#bfbfbf', fontSize: 12 }} />
          </Tooltip>
        ) : null}
      </div>
      <div className="report-stat-value">{value}</div>
      <div className="report-stat-delta">
        环比{' '}
        <span className={hasDelta ? ((delta as number) >= 0 ? 'up' : 'down') : ''}>
          {hasDelta ? `${(delta as number) >= 0 ? '+' : ''}${fmtPct(delta, 2)}` : '—'}
        </span>
      </div>
    </div>
  );
}

function Overview({ summary, deltas }: { summary: AdReportMetrics; deltas: Record<string, number | null> }) {
  return (
    <div className="report-stat-grid">
      <StatCard title="消耗" value={fmtMoney(summary.spend)} delta={deltas.spend} tone="blue" />
      <StatCard title="展现量" value={fmtNumber(summary.impressions)} delta={deltas.impressions} tone="orange" />
      <StatCard title="点击率" value={fmtPct(summary.ctr)} delta={deltas.ctr} />
      <StatCard title="7日总支付ROI" value={fmtRatio(summary.roi)} delta={deltas.roi} tip="7天归因总支付金额 / 消耗" />
      <StatCard title="7日总下单数" value={fmtNumber(summary.total_orders)} delta={deltas.total_orders} />
      <StatCard title="归因支付金额" value={fmtMoney(summary.total_gmv)} delta={deltas.total_gmv} />
      <StatCard title="归因成交订单" value={fmtNumber(summary.deal_orders)} />
      <StatCard title="点击量" value={fmtNumber(summary.clicks)} delta={deltas.clicks} />
      <StatCard title="平均点击成本" value={fmtMoney(summary.acp)} />
      <StatCard title="平均千次展现费用" value={fmtMoney(summary.cpm)} />
    </div>
  );
}

export default function Ads() {
  const { shop_id, start, end, enabled } = useRangeParams();
  const setRange = useFilterStore((state) => state.setRange);
  const [level, setLevel] = useState<AdLevel>('account');
  const [granularity, setGranularity] = useState<'day' | 'hour'>('day');
  const [keyword, setKeyword] = useState('');
  const [pageSize, setPageSize] = useState(10);

  const query = useQuery({
    queryKey: ['ad-reports', shop_id, start, end, level, granularity],
    queryFn: () => api.adReports({ shop_id, start, end, level, granularity }),
    enabled,
  });

  const data = query.data;
  const summary = data?.summary;
  const hourRange = data?.hour_range ?? null;

  useEffect(() => {
    if (granularity === 'hour' && data && !hourRange) setGranularity('day');
  }, [data, granularity, hourRange]);

  const isAccount = level === 'account';
  const isHour = granularity === 'hour';
  const timeMode = isAccount || isHour;
  const dimColumns = DIMENSION_COLUMNS[level] ?? { name: '名称' };
  const rows = (data?.rows ?? []).filter((row) =>
    timeMode || !keyword ? true : (row.name ?? '').toLowerCase().includes(keyword.toLowerCase()),
  );
  const series = data?.series ?? [];
  const latest = series.length ? series[series.length - 1].date : undefined;

  const timeLabel = (row: AdReportItem) =>
    isHour && row.hour !== undefined && row.hour !== null
      ? `${row.date} ${String(row.hour).padStart(2, '0')}:00`
      : (row.date ?? '');

  const presets = [
    { label: '近 7 天', value: [dayjs().subtract(6, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: '近 30 天', value: [dayjs().subtract(29, 'day'), dayjs()] as [Dayjs, Dayjs] },
    { label: '近 90 天', value: [dayjs().subtract(89, 'day'), dayjs()] as [Dayjs, Dayjs] },
  ];
  if (data?.data_range) {
    presets.push({
      label: '全部数据',
      value: [dayjs(data.data_range.start), dayjs(data.data_range.end)] as [Dayjs, Dayjs],
    });
  }

  const option = {
    color: ['#4c6ef5', '#ff9f43'],
    tooltip: { trigger: 'axis' },
    legend: { right: 8, top: 0, itemWidth: 14, data: ['消耗', '展现量'] },
    grid: { left: 8, right: 12, top: 40, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: series.map((row) =>
        isHour
          ? `${(row.date ?? '').slice(5)} ${String(row.hour ?? 0).padStart(2, '0')}:00`
          : (row.date ?? '').slice(5),
      ),
      axisLabel: { color: '#8c8c8c', hideOverlap: true },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    yAxis: [
      {
        type: 'value',
        name: '消耗',
        nameTextStyle: { color: '#8c8c8c', align: 'right' },
        axisLabel: { color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
      {
        type: 'value',
        name: '展现量',
        nameTextStyle: { color: '#8c8c8c', align: 'left' },
        axisLabel: { color: '#8c8c8c' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '消耗',
        type: 'line',
        smooth: false,
        symbol: 'none',
        lineStyle: { width: 1.6 },
        data: series.map((row) => row.spend),
      },
      {
        name: '展现量',
        type: 'line',
        yAxisIndex: 1,
        smooth: false,
        symbol: 'none',
        lineStyle: { width: 1.6 },
        data: series.map((row) => row.impressions),
      },
    ],
  };

  const metricColumns: ColumnsType<AdReportItem> = [
    { title: '消耗', dataIndex: 'spend', width: 110, align: 'right', render: (value) => fmtMoney(value as number) },
    {
      title: '展现量',
      dataIndex: 'impressions',
      width: 100,
      align: 'right',
      render: (value) => fmtNumber(value as number),
    },
    { title: '点击率', dataIndex: 'ctr', width: 90, align: 'right', render: (value) => fmtPct(value as number) },
    { title: '点击量', dataIndex: 'clicks', width: 90, align: 'right', render: (value) => fmtNumber(value as number) },
    {
      title: '归因支付金额',
      dataIndex: 'total_gmv',
      width: 130,
      align: 'right',
      render: (value) => fmtMoney(value as number),
    },
    {
      title: '平均点击成本',
      dataIndex: 'acp',
      width: 120,
      align: 'right',
      render: (value) => fmtMoney(value as number),
    },
    {
      title: '平均千次展现费用',
      dataIndex: 'cpm',
      width: 140,
      align: 'right',
      render: (value) => fmtMoney(value as number),
    },
    {
      title: '7日总下单数',
      dataIndex: 'total_orders',
      width: 110,
      align: 'right',
      render: (value) => fmtNumber(value as number),
    },
    {
      title: '7日总支付ROI',
      dataIndex: 'roi',
      width: 120,
      align: 'right',
      render: (value) => fmtRatio(value as number),
    },
  ];

  const columns: ColumnsType<AdReportItem> = timeMode
    ? [
        {
          title: isHour ? '时间' : '日期',
          dataIndex: 'date',
          width: isHour ? 150 : 120,
          fixed: 'left',
          render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{timeLabel(row)}</span>,
        },
        ...metricColumns,
      ]
    : [
        ...(dimColumns.id
          ? [
              {
                title: dimColumns.id,
                dataIndex: 'dimension_id',
                width: 170,
                fixed: 'left' as const,
                ellipsis: true,
                render: (value: unknown) => <span title={value as string}>{value as string}</span>,
              },
            ]
          : []),
        {
          title: dimColumns.name,
          dataIndex: 'name',
          width: dimColumns.id ? 320 : 240,
          fixed: dimColumns.id ? undefined : ('left' as const),
          ellipsis: true,
          render: (value) => <span title={value as string}>{value as string}</span>,
        },
        ...metricColumns,
      ];

  const exportClick = () => {
    exportXlsx(
      `广告投放_${LEVEL_TABS.find((item) => item.key === level)?.label ?? level}${isHour ? '_分时' : ''}`,
      timeMode
        ? [
            {
              title: isHour ? '时间' : '日期',
              dataIndex: 'date',
              formatter: (_, row) => timeLabel(row as unknown as AdReportItem),
            },
            { title: '消耗', dataIndex: 'spend' },
            { title: '展现量', dataIndex: 'impressions' },
            { title: '点击率', dataIndex: 'ctr', formatter: (value) => fmtPct(value as number) },
            { title: '点击量', dataIndex: 'clicks' },
            { title: '归因支付金额', dataIndex: 'total_gmv' },
            { title: '平均点击成本', dataIndex: 'acp' },
            { title: '平均千次展现费用', dataIndex: 'cpm' },
            { title: '7日总下单数', dataIndex: 'total_orders' },
            { title: '7日总支付ROI', dataIndex: 'roi' },
          ]
        : [
            ...(dimColumns.id ? [{ title: dimColumns.id, dataIndex: 'dimension_id' }] : []),
            { title: dimColumns.name, dataIndex: 'name' },
            { title: '消耗', dataIndex: 'spend' },
            { title: '展现量', dataIndex: 'impressions' },
            { title: '点击率', dataIndex: 'ctr', formatter: (value) => fmtPct(value as number) },
            { title: '点击量', dataIndex: 'clicks' },
            { title: '归因支付金额', dataIndex: 'total_gmv' },
            { title: '平均点击成本', dataIndex: 'acp' },
            { title: '平均千次展现费用', dataIndex: 'cpm' },
            { title: '7日总下单数', dataIndex: 'total_orders' },
            { title: '7日总支付ROI', dataIndex: 'roi' },
          ],
      rows as unknown as Record<string, unknown>[],
    );
  };

  const totals = summary ?? {
    spend: 0,
    impressions: 0,
    clicks: 0,
    ctr: null,
    acp: null,
    cpm: null,
    total_orders: 0,
    total_gmv: 0,
    deal_orders: 0,
    deal_gmv: 0,
    roi: null,
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Typography.Title level={5} style={{ margin: 0 }}>
            标准投报表
          </Typography.Title>
          <span style={{ color: '#8c8c8c', fontSize: 12 }}>
            {latest ? `更新时间：${latest}` : ''}
            {data ? `　区间 ${data.range.start} ~ ${data.range.end}` : ''}
          </span>
        </div>
        <Tabs
          activeKey={level}
          onChange={(key) => {
            setLevel(key as AdLevel);
            setKeyword('');
          }}
          items={LEVEL_TABS.map((item) => ({ key: item.key, label: item.label }))}
          style={{ marginBottom: 4 }}
        />
        <Space wrap size={12}>
          <Space size={6}>
            <span style={{ color: '#8c8c8c', fontSize: 13 }}>日期</span>
            <RangePicker
              allowClear={false}
              value={[dayjs(start), dayjs(end)]}
              presets={presets}
              onChange={(values) => {
                if (!values || !values[0] || !values[1]) return;
                setRange(values[0].format('YYYY-MM-DD'), values[1].format('YYYY-MM-DD'));
              }}
              style={{ width: 260 }}
            />
          </Space>
          <Space size={6}>
            <span style={{ color: '#8c8c8c', fontSize: 13 }}>时间粒度</span>
            <Select
              value={granularity}
              style={{ width: 150 }}
              onChange={(value) => setGranularity(value as 'day' | 'hour')}
              options={[
                { value: 'day', label: '按日' },
                { value: 'hour', label: hourRange ? '分时' : '分时（未同步）', disabled: !hourRange },
              ]}
            />
          </Space>
          {isHour && hourRange ? (
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>
              分时数据 {hourRange.start} ~ {hourRange.end}
            </span>
          ) : null}
          <Space size={6}>
            <span style={{ color: '#8c8c8c', fontSize: 13 }}>聚合维度</span>
            <Select
              value={isHour ? 'time' : isAccount ? 'date' : 'object'}
              style={{ width: 150 }}
              options={[
                { value: 'date', label: '日期' },
                { value: 'time', label: '时间（分时）' },
                { value: 'object', label: '投放对象' },
              ]}
              disabled
            />
          </Space>
          {!isAccount && !isHour && (
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder={`搜索${dimColumns.name}`}
              style={{ width: 220 }}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          )}
        </Space>
      </Card>

      <Card size="small" title="数据概览" loading={query.isLoading}>
        <Overview summary={totals} deltas={data?.deltas ?? {}} />
      </Card>

      <Card size="small" title="消耗与展现趋势" loading={query.isLoading}>
        {series.length ? (
          <ReactECharts option={option} style={{ height: 320 }} notMerge lazyUpdate />
        ) : (
          <div className="chart-empty">该区间暂无投放数据</div>
        )}
      </Card>

      <Card
        size="small"
        title="数据明细"
        extra={
          <Space>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              disabled={!rows.length}
              onClick={exportClick}
            >
              导出
            </Button>
          </Space>
        }
      >
        <Table<AdReportItem>
          rowKey={(row) =>
            timeMode ? (isHour ? `${row.date}-${row.hour}` : (row.date as string)) : (row.dimension_id as string)
          }
          size="small"
          loading={query.isLoading}
          columns={columns}
          dataSource={rows}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该区间暂无数据" />,
          }}
          pagination={{
            defaultPageSize: 10,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            showTotal: (total) => `共 ${total} 条`,
            onChange: (_, size) => size && setPageSize(size),
          }}
          scroll={{ x: 1400 }}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={timeMode ? 1 : dimColumns.id ? 2 : 1}>
                  合计 {rows.length} 条记录
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  {fmtMoney(totals.spend)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right">
                  {fmtNumber(totals.impressions)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right">
                  {fmtPct(totals.ctr)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  {fmtNumber(totals.clicks)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  {fmtMoney(totals.total_gmv)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} align="right">
                  {fmtMoney(totals.acp)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={7} align="right">
                  {fmtMoney(totals.cpm)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={8} align="right">
                  {fmtNumber(totals.total_orders)}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={9} align="right">
                  {fmtRatio(totals.roi)}
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </Card>
    </Space>
  );
}
