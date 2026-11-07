import { get, patch, post, put } from './client';
import type {
  AdReportData,
  AdRow,
  CommentItem,
  CostConfig,
  DailyMetrics,
  FunnelData,
  GpmBreakdown,
  LoginResult,
  Overview,
  Paged,
  SearchTermsData,
  SentimentData,
  Shop,
  SyncLogItem,
  SyncResult,
  TrendData,
} from './types';

export const api = {
  login: (username: string, password: string) =>
    post<LoginResult>('/auth/login', { username, password }),

  listShops: () => get<Shop[]>('/shops'),

  createShop: (payload: {
    name: string;
    qianfan_shop_id: string;
    app_key?: string;
    app_secret?: string;
  }) => post<Shop>('/shops', payload),

  updateShop: (
    shopId: number,
    payload: { name?: string; app_key?: string; app_secret?: string; status?: string },
  ) => patch<Shop>(`/shops/${shopId}`, payload),

  getCostConfig: (shopId: number) => get<CostConfig>(`/shops/${shopId}/cost-config`),

  updateCostConfig: (shopId: number, payload: Omit<CostConfig, 'shop_id'>) =>
    put<CostConfig>(`/shops/${shopId}/cost-config`, payload),

  syncShop: (shopId: number, resource: string, mode: string, days = 30) =>
    post<SyncResult>(`/shops/${shopId}/sync`, { resource, mode, days }),

  syncLogs: (shopId: number, limit = 50) =>
    get<SyncLogItem[]>(`/shops/${shopId}/sync-logs`, { limit }),

  overview: (params: Record<string, unknown>) => get<Overview>('/dashboard/overview', params),

  trend: (params: Record<string, unknown>) => get<TrendData>('/dashboard/trend', params),

  funnel: (params: Record<string, unknown>) => get<FunnelData>('/dashboard/funnel', params),

  gpmBreakdown: (params: Record<string, unknown>) =>
    get<GpmBreakdown>('/dashboard/gpm-breakdown', params),

  sentiment: (params: Record<string, unknown>) =>
    get<SentimentData>('/dashboard/sentiment', params),

  searchTerms: (params: Record<string, unknown>) =>
    get<SearchTermsData>('/search-terms', params),

  ads: (params: Record<string, unknown>) => get<AdRow[]>('/ads', params),

  adReports: (params: Record<string, unknown>) => get<AdReportData>('/ad-reports', params),

  comments: (params: Record<string, unknown>) =>
    get<Paged<CommentItem>>('/comments', params),

  analyzeComment: (commentId: number) => post<CommentItem>(`/comments/${commentId}/analyze`),

  reanalyzeComments: (shopId: number, limit = 200) =>
    post<{ analyzed: number }>('/comments/reanalyze', { shop_id: shopId, limit }),

  dailyMetrics: (params: Record<string, unknown>) =>
    get<DailyMetrics>('/metrics/daily', params),
};
