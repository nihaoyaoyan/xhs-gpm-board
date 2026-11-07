export interface Shop {
  id: number;
  name: string;
  qianfan_shop_id: string;
  status: string;
  has_credentials: boolean;
}

export interface CostConfig {
  shop_id: number;
  cost_rate: number;
  platform_fee_rate: number;
  return_rate: number;
  monthly_fixed_cost: number;
}

export interface MetricSummary {
  impressions: number;
  clicks: number;
  visits: number;
  orders: number;
  gmv: number;
  ad_spend: number;
  gross_profit: number;
  break_even_sales: number;
  aov: number | null;
  roi: number | null;
  gpm: number | null;
  gross_margin: number | null;
  break_even_rate: number | null;
  ctr: number | null;
  cvr: number | null;
}

export interface Overview {
  range: { start: string; end: string; previous_start: string; previous_end: string };
  current: MetricSummary;
  previous: MetricSummary;
  deltas: Record<string, number | null>;
}

export interface TrendData {
  metric: string;
  granularity: string;
  dates: string[];
  current: (number | null)[];
  previous: (number | null)[];
  previous_dates: string[];
}

export interface FunnelStep {
  name: string;
  value: number;
  rate_from_prev: number | null;
  rate_from_top: number | null;
}

export interface FunnelData {
  steps: FunnelStep[];
  previous_steps: FunnelStep[];
}

export interface GpmSeriesItem {
  date: string;
  ctr: number | null;
  cvr: number | null;
  aov: number | null;
  gpm: number | null;
}

export interface WaterfallItem {
  name: string;
  value: number;
  type: 'base' | 'delta' | 'total';
}

export interface GpmBreakdown {
  summary: {
    impressions: number;
    clicks: number;
    orders: number;
    gmv: number;
    ctr: number | null;
    cvr: number | null;
    aov: number | null;
    gpm: number | null;
  };
  previous: { ctr: number | null; cvr: number | null; aov: number | null; gpm: number | null };
  series: GpmSeriesItem[];
  waterfall: WaterfallItem[] | null;
}

export interface SentimentData {
  total: number;
  distribution: { sentiment: string; count: number; ratio: number }[];
  top_keywords: { word: string; count: number }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface SearchTermRow {
  term: string;
  impressions: number;
  clicks: number;
  visits: number;
  orders: number;
  buyers: number;
  gmv: number;
  ad_spend: number;
  ctr: number | null;
  cvr: number | null;
  gpm: number | null;
  roi: number | null;
  gmv_share: number;
}

export interface SearchTermSummary {
  terms: number;
  impressions: number;
  clicks: number;
  visits: number;
  orders: number;
  buyers: number;
  gmv: number;
  ad_spend: number;
  ctr: number | null;
  cvr: number | null;
  gpm: number | null;
  roi: number | null;
}

export interface SearchTermsData {
  channel: 'ad' | 'shop' | 'note';
  range: { start: string; end: string };
  summary: SearchTermSummary;
  items: SearchTermRow[];
}

export interface AdRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  visits: number;
  gmv: number;
  order_count: number;
  ctr: number | null;
  cvr: number | null;
  roi: number | null;
  gpm: number | null;
}

export type AdLevel = 'account' | 'campaign' | 'creativity' | 'note' | 'keyword' | 'spu' | 'live';

export interface AdReportMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number | null;
  acp: number | null;
  cpm: number | null;
  total_orders: number;
  total_gmv: number;
  deal_orders: number;
  deal_gmv: number;
  roi: number | null;
}

export interface AdReportItem extends AdReportMetrics {
  date?: string;
  hour?: number;
  dimension_id?: string;
  name?: string;
}

export interface AdReportData {
  level: AdLevel;
  level_label: string;
  granularity: 'day' | 'hour';
  range: { start: string; end: string };
  previous_range: { start: string; end: string };
  hour_range: { start: string; end: string } | null;
  data_range: { start: string; end: string } | null;
  summary: AdReportMetrics;
  previous: AdReportMetrics;
  deltas: Record<string, number | null>;
  series: AdReportItem[];
  rows: AdReportItem[];
}

export interface CommentItem {
  id: number;
  external_id: string;
  product_title: string | null;
  content: string;
  rating: number;
  like_count: number;
  comment_at: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  keywords: string[];
  analyzer_type: string | null;
}

export interface DailyMetricItem {
  date: string;
  impressions: number;
  clicks: number;
  visits: number;
  orders: number;
  gmv: number;
  ad_spend: number;
  ctr: number | null;
  cvr: number | null;
  aov: number | null;
  gpm: number | null;
  roi: number | null;
  gross_profit: number | null;
  gross_margin: number | null;
  break_even_sales: number | null;
}

export interface DailyMetrics {
  cost_config: Omit<CostConfig, 'shop_id'>;
  items: DailyMetricItem[];
}

export interface SyncLogItem {
  id: number;
  resource: string;
  mode: string;
  started_at: string | null;
  finished_at: string | null;
  fetched_count: number;
  status: string;
  message: string | null;
}

export interface SyncResult {
  log_id: number;
  resource: string;
  fetched: number;
  status: string;
}

export interface LoginResult {
  access_token: string;
  user: { id: number; username: string };
}
