import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { FunnelStep } from '@/api/types';

interface FunnelChartProps {
  steps: FunnelStep[];
  height?: number;
}

export default function FunnelChart({ steps, height = 340 }: FunnelChartProps) {
  const option: EChartsOption = {
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const item = params as { name: string; value: number };
        const step = steps.find((s) => s.name === item.name);
        const rate = step?.rate_from_prev;
        return `${item.name}<br/>数量：${item.value.toLocaleString('zh-CN')}${
          rate !== null && rate !== undefined ? `<br/>转化率：${(rate * 100).toFixed(2)}%` : ''
        }`;
      },
    },
    series: [
      {
        type: 'funnel',
        left: '8%',
        right: '8%',
        top: 16,
        bottom: 16,
        minSize: '28%',
        maxSize: '100%',
        sort: 'descending',
        gap: 2,
        label: {
          show: true,
          position: 'inside',
          formatter: (params: unknown) => {
            const item = params as { name: string; value: number };
            return `${item.name} ${item.value.toLocaleString('zh-CN')}`;
          },
          color: '#fff',
          fontWeight: 600,
        },
        itemStyle: { borderColor: '#fff', borderWidth: 1 },
        color: ['#FF2442', '#ff5c73', '#ff8b9c', '#ffb8c4'],
        data: steps.map((step) => ({ name: step.name, value: step.value })),
      },
    ],
  };

  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}
