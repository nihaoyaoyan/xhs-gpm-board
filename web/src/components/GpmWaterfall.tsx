import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { WaterfallItem } from '@/api/types';

interface GpmWaterfallProps {
  items: WaterfallItem[];
  height?: number;
}

interface Bar {
  value: number;
  base: number;
  item: WaterfallItem;
  color: string;
}

export default function GpmWaterfall({ items, height = 340 }: GpmWaterfallProps) {
  let running = 0;
  const bars: Bar[] = items.map((item) => {
    if (item.type === 'base') {
      running = item.value;
      return { value: item.value, base: 0, item, color: '#8c8c8c' };
    }
    if (item.type === 'total') {
      running = item.value;
      return { value: item.value, base: 0, item, color: '#FF2442' };
    }
    const next = running + item.value;
    const bar =
      item.value >= 0
        ? { value: item.value, base: running, color: '#FF2442' }
        : { value: Math.abs(item.value), base: next, color: '#16a34a' };
    running = next;
    return { ...bar, item };
  });

  const option: EChartsOption = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as { dataIndex: number }[];
        const bar = bars[list[0].dataIndex];
        const sign = bar.item.type === 'delta' && bar.item.value > 0 ? '+' : '';
        return `${bar.item.name}<br/>${sign}${bar.item.value.toFixed(2)}`;
      },
    },
    grid: { left: 12, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: items.map((item) => item.name),
      axisLabel: { color: '#595959', interval: 0, fontSize: 12 },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#8c8c8c' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    series: [
      {
        name: '占位',
        type: 'bar',
        stack: 'total',
        silent: true,
        itemStyle: { color: 'transparent' },
        data: bars.map((bar) => bar.base),
      },
      {
        name: 'GPM',
        type: 'bar',
        stack: 'total',
        barMaxWidth: 48,
        label: {
          show: true,
          position: 'top',
          fontSize: 11,
          formatter: (params: unknown) => {
            const bar = bars[(params as { dataIndex: number }).dataIndex];
            return bar.item.type === 'delta'
              ? `${bar.item.value > 0 ? '+' : ''}${bar.item.value.toFixed(1)}`
              : bar.item.value.toFixed(1);
          },
        },
        data: bars.map((bar) => ({ value: bar.value, itemStyle: { color: bar.color, borderRadius: 3 } })),
      },
    ],
  };

  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}
