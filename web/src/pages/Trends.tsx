import { DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Segmented, Select, Space, Table, Tag } from 'antd';
import { useState } from 'react';
import { api } from '@/api';
import TrendChart from '@/components/TrendChart';
import type { DailyMetricItem } from '@/api/types';
import { useRangeParams } from '@/stores/filter';
import { exportXlsx, type ExportColumn } from '@/utils/exportXlsx';
import { fmtMoney, fmtNumber, fmtPct, fmtRatio } from '@/utils/format';

const METRICS = [
  { value: 'gmv', label: '成交金额 GMV', money: true },
  { value: 'orders', label: '订单量', money: false },
  { value: 'ad_spend', label: '广告消耗', money: true },
  { value: 'gross_profit', label: '预估毛利', money: true },
  { value: 'roi', label: 'ROI', money: false },
  { value: 'gpm', label: 'GPM', money: true },
];

export default function Trends() {
  const { shop_id, start, end, enabled } = useRangeParams();
  const [metric, setMetric] = useState('gmv');
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('day');

  const trend = useQuery({
    queryKey: ['trend', shop_id, start, end, metric, granularity],
    queryFn: () => api.trend({ shop_id, start, end, metric, granularity }),
    enabled,
  });

  const daily = useQuery({
    queryKey: ['metrics-daily', shop_id, start, end],
    queryFn: () => api.dailyMetrics({ shop_id, start, end }),
    enabled,
  });

  const currentMeta = METRICS.find((item) => item.value === metric) ?? METRICS[0];

  const columns = [
    { title: '日期', dataIndex: 'date', fixed: 'left' as const, width: 120 },
    {
      title: '曝光量',
      dataIndex: 'impressions',
      width: 110,
      render: (value: number) => fmtNumber(value),
    },
    { title: '点击量', dataIndex: 'clicks', width: 100, render: (value: number) => fmtNumber(value) },
    { title: '订单量', dataIndex: 'orders', width: 90, render: (value: number) => fmtNumber(value) },
    { title: 'GMV', dataIndex: 'gmv', width: 120, render: (value: number) => fmtMoney(value) },
    {
      title: '广告消耗',
      dataIndex: 'ad_spend',
      width: 120,
      render: (value: number) => fmtMoney(value),
    },
    { title: 'CTR', dataIndex: 'ctr', width: 90, render: (value: number | null) => fmtPct(value) },
    { title: 'CVR', dataIndex: 'cvr', width: 90, render: (value: number | null) => fmtPct(value) },
    { title: 'AOV', dataIndex: 'aov', width: 110, render: (value: number | null) => fmtMoney(value) },
    { title: 'GPM', dataIndex: 'gpm', width: 110, render: (value: number | null) => fmtMoney(value) },
    {
      title: 'ROI',
      dataIndex: 'roi',
      width: 90,
      render: (value: number | null) => (value === null ? '—' : `${fmtRatio(value)}x`),
    },
    {
      title: '预估毛利',
      dataIndex: 'gross_profit',
      width: 120,
      render: (value: number | null) => fmtMoney(value),
    },
    {
      title: '保本销售额',
      dataIndex: 'break_even_sales',
      width: 130,
      render: (value: number | null) => fmtMoney(value),
    },
  ];

  const exportColumns: ExportColumn[] = columns.map((column) => ({
    title: column.title,
    dataIndex: column.dataIndex,
    formatter: (value) => (typeof value === 'number' ? Number(value.toFixed(2)) : (value as string)),
  }));

  const rows = (daily.data?.items ?? []) as unknown as Record<string, unknown>[];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={`${currentMeta.label} 趋势`}
        extra={
          <Space wrap>
            <Select
              value={metric}
              onChange={setMetric}
              options={METRICS.map((item) => ({ value: item.value, label: item.label }))}
              style={{ width: 160 }}
            />
            <Segmented
              value={granularity}
              onChange={(value) => setGranularity(value as 'day' | 'week' | 'month')}
              options={[
                { value: 'day', label: '按日' },
                { value: 'week', label: '按周' },
                { value: 'month', label: '按月' },
              ]}
            />
            <Button
              icon={<DownloadOutlined />}
              disabled={!rows.length}
              onClick={() =>
                exportXlsx(`趋势明细_${currentMeta.label}`, exportColumns, rows)
              }
            >
              导出 Excel
            </Button>
          </Space>
        }
      >
        {trend.data ? (
          <TrendChart
            dates={trend.data.dates}
            current={trend.data.current}
            previous={trend.data.previous}
            label={currentMeta.label}
            height={380}
            valueFormatter={(value) => (currentMeta.money ? fmtMoney(value) : fmtNumber(value, 2))}
          />
        ) : (
          <div className="chart-empty">暂无数据</div>
        )}
      </Card>

      <Card
        size="small"
        title="每日指标明细"
        extra={
          daily.data ? (
            <Space>
              <Tag color="red">成本率 {fmtPct(daily.data.cost_config.cost_rate)}</Tag>
              <Tag>平台佣金 {fmtPct(daily.data.cost_config.platform_fee_rate)}</Tag>
              <Tag>退款率 {fmtPct(daily.data.cost_config.return_rate)}</Tag>
            </Space>
          ) : null
        }
      >
        <Table<DailyMetricItem>
          rowKey="date"
          size="small"
          loading={daily.isLoading}
          columns={columns as never}
          dataSource={daily.data?.items ?? []}
          pagination={{ pageSize: 31, showSizeChanger: false }}
          scroll={{ x: 1350 }}
        />
      </Card>
    </Space>
  );
}
