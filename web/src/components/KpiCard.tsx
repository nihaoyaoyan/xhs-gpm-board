import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Card, Statistic, Tooltip } from 'antd';
import type { ReactNode } from 'react';
import { fmtPct } from '@/utils/format';

interface KpiCardProps {
  title: string;
  value: number | string | null | undefined;
  delta?: number | null;
  suffix?: ReactNode;
  prefix?: ReactNode;
  precision?: number;
  formatter?: (value: number | string) => string;
  tip?: string;
}

export default function KpiCard({
  title,
  value,
  delta,
  suffix,
  prefix,
  precision = 0,
  formatter,
  tip,
}: KpiCardProps) {
  const hasDelta = delta !== null && delta !== undefined && Number.isFinite(delta);
  const positive = hasDelta && (delta as number) >= 0;

  return (
    <Card className="kpi-card" size="small">
      <Tooltip title={tip}>
        <Statistic
          title={title}
          value={value ?? '—'}
          precision={typeof value === 'number' ? precision : undefined}
          prefix={prefix}
          suffix={suffix}
          formatter={
            formatter
              ? (value) => formatter(value as number | string)
              : undefined
          }
        />
      </Tooltip>
      {hasDelta && (
        <div className={positive ? 'kpi-delta-up' : 'kpi-delta-down'} style={{ marginTop: 6, fontSize: 12 }}>
          {positive ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {fmtPct(Math.abs(delta as number))}
          <span style={{ color: '#bfbfbf', marginLeft: 4 }}>较上期</span>
        </div>
      )}
    </Card>
  );
}
