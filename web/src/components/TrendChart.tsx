import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

interface TrendChartProps {
  dates: string[];
  current: (number | null)[];
  previous?: (number | null)[];
  label?: string;
  previousLabel?: string;
  height?: number;
  valueFormatter?: (value: number) => string;
}

export default function TrendChart({
  dates,
  current,
  previous,
  label = '本期',
  previousLabel = '上期',
  height = 340,
  valueFormatter,
}: TrendChartProps) {
  const isCurrency = label.includes('GMV') || label.includes('销售额') || label.includes('毛利');
  const option: EChartsOption = {
    color: ['#FF2442', '#c9cdd4'],
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) =>
        value === null || value === undefined
          ? '—'
          : valueFormatter
            ? valueFormatter(Number(value))
            : Number(value).toLocaleString('zh-CN'),
    },
    legend: { data: [label, previousLabel], right: 0, top: 0, icon: 'roundRect', itemWidth: 12 },
    grid: { left: 12, right: 16, top: 40, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: dates,
      axisLabel: { color: '#8c8c8c', hideOverlap: true },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#8c8c8c',
        formatter: (value: number) =>
          isCurrency && Math.abs(value) >= 10_000
            ? `${(value / 10_000).toFixed(1)}万`
            : value.toLocaleString('zh-CN'),
      },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    series: [
      {
        name: label,
        type: 'line',
        smooth: true,
        showSymbol: false,
        data: current,
        lineStyle: { width: 2.5 },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(255,36,66,0.20)' },
              { offset: 1, color: 'rgba(255,36,66,0.02)' },
            ],
          },
        },
      },
      ...(previous && previous.length
        ? [
            {
              name: previousLabel,
              type: 'line' as const,
              smooth: true,
              showSymbol: false,
              data: previous,
              lineStyle: { width: 1.5, type: 'dashed' as const },
            },
          ]
        : []),
    ],
  };

  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}
