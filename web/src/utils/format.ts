export function fmtMoney(value: number | null | undefined, withSymbol = true): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const text = value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return withSymbol ? `¥${text}` : text;
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)}万`;
  return fmtNumber(value, 0);
}

/** ratio 数值（如 0.1234）转百分比字符串 */
export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function fmtRatio(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace('T', ' ').slice(0, 16);
}

export const SENTIMENT_LABELS: Record<string, { label: string; color: string }> = {
  positive: { label: '正向', color: 'green' },
  neutral: { label: '中性', color: 'gold' },
  negative: { label: '负向', color: 'red' },
  unanalyzed: { label: '未分析', color: 'default' },
};

export const ORDER_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  paid: { label: '已支付', color: 'blue' },
  shipped: { label: '已发货', color: 'cyan' },
  completed: { label: '已完成', color: 'green' },
  refunded: { label: '已退款', color: 'orange' },
  refunding: { label: '退款中', color: 'volcano' },
};

export const RESOURCE_LABELS: Record<string, string> = {
  products: '商品',
  orders: '订单',
  ads: '广告',
  comments: '评论',
  search_terms: '搜索词',
};
