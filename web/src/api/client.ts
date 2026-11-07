import axios, { type AxiosRequestConfig } from 'axios';
import { message } from 'antd';

const TOKEN_KEY = 'xhs-auth';

function readToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } };
    return parsed.state?.token ?? null;
  } catch {
    return null;
  }
}

export const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api/v1',
  timeout: 30_000,
});

http.interceptors.request.use((config) => {
  const token = readToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => {
    const body = response.data as { code?: number; data?: unknown; message?: string };
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        message.error(body.message || '请求失败');
        return Promise.reject(new Error(body.message || '请求失败'));
      }
      return body.data as never;
    }
    return response.data as never;
  },
  (error) => {
    const status = error?.response?.status as number | undefined;
    const detail =
      (error?.response?.data as { detail?: string; message?: string } | undefined)?.detail ||
      (error?.response?.data as { message?: string } | undefined)?.message ||
      error?.message ||
      '网络异常';
    if (status === 401) {
      message.error('登录已失效，请重新登录');
      localStorage.removeItem(TOKEN_KEY);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    } else if (status === 403) {
      message.error('没有权限执行该操作');
    } else {
      message.error(detail);
    }
    return Promise.reject(error);
  },
);

export async function get<T>(url: string, params?: Record<string, unknown>, config?: AxiosRequestConfig): Promise<T> {
  return http.get(url, { params, ...config }) as unknown as Promise<T>;
}

export async function post<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return http.post(url, data, config) as unknown as Promise<T>;
}

export async function put<T>(url: string, data?: unknown): Promise<T> {
  return http.put(url, data) as unknown as Promise<T>;
}

export async function patch<T>(url: string, data?: unknown): Promise<T> {
  return http.patch(url, data) as unknown as Promise<T>;
}
