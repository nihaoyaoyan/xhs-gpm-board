#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书乘风 MAPI MCP Server
=========================

依据《小红书乘风MAPI接口清单》实现，覆盖 17 个开放接口：

  OAuth2.0 授权   1 个  刷新token(4808)
  账户服务        3 个  子账号列表(4112) / 转账结果(4301) / 资金流水(4302)
  离线报表        7 个  账户/计划/创意/笔记/关键词/直播间/商品(4023-4034)
  实时报表        6 个  账户/计划/创意实时(3995/4003/4019) + 账户/计划/创意小时(4075-4077)

统一网关 https://adapi.xiaohongshu.com ，鉴权 Header: Access-Token
token 生命周期：access_token 1 天 / refresh_token 30 天，本服务自动续期。

凭证配置（.env 文件或环境变量）：
  XHS_APP_ID          申请应用后小红书返回的 app_id
  XHS_SECRET          申请应用后小红书返回的 secret
  XHS_REFRESH_TOKEN   最近一次授权/刷新返回的 refresh_token
  XHS_ADVERTISER_ID   （可选）默认广告主ID，调用未显式传入时使用
  XHS_ACCESS_TOKEN    （可选）手动指定的 access_token；配置了应用三要素时自动刷新优先
"""

from __future__ import annotations

import asyncio
import datetime
import json
import os
import pathlib
import time
from typing import Any, Dict, List, Optional, Union

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

load_dotenv(pathlib.Path(__file__).parent / ".env")
load_dotenv()  # 兼容从其他工作目录启动

API_BASE = os.getenv("XHS_API_BASE", "https://adapi.xiaohongshu.com").rstrip("/")
HTTP_TIMEOUT = float(os.getenv("XHS_HTTP_TIMEOUT", "30"))

# 文档请求示例中的完整指标列（DataReportDTO），按需取用
ALL_COLUMNS: List[str] = [
    "fee", "impression", "click", "ctr", "acp", "cpm",
    "like", "comment", "collect", "follow", "share",
    "interaction", "cpi", "action_button_click", "action_button_ctr",
    "screenshot", "pic_save", "search_cmt_click", "search_cmt_click_cvr",
    "search_cmt_after_read_avg", "search_cmt_after_read", "reserve_pv",
    "live_subscribe_cnt", "live_subscribe_cnt_cost",
    "live_watch_cnt", "live_watch_cnt_cost", "live_watch_duration_avg",
    "live_follow_cnt", "live_5s_watch_cnt", "live_5s_watch_cnt_cost",
    "live_cmt_cnt", "live_30s_watch_cnt", "live_30s_watch_cnt_cost",
    "goods_view_num", "goods_view_num_cost",
    "goods_add_cart_num", "goods_add_cart_num_cost",
    "total_order_num_7d", "total_order_num_7d_cost",
    "total_order_gmv_7d", "total_order_roi_7d",
    "deal_order_num_7d", "deal_order_num_7d_cost",
    "deal_order_gmv_7d", "deal_order_roi_7d",
    "live_direct_purchase_order_num_24h", "live_direct_purchase_order_num_24h_cost",
    "live_direct_purchase_order_gmv_24h", "live_direct_purchase_order_roi_24h",
    "live_direct_deal_order_num_24h", "live_direct_deal_order_num_24h_cost",
    "live_direct_deal_order_gmv_24h", "live_direct_deal_order_roi_24h",
    "new_seller_goods_view_num", "new_seller_deal_order_num_7d",
    "new_seller_deal_order_gmv_7d",
]

# 判定 token 失效的响应特征（用于自动重刷一次）
_TOKEN_ERROR_CODES = {40001, 40002, 40100, 40101, 40300}
_TOKEN_ERROR_KEYWORDS = ("token", "access_token", "鉴权", "授权")

mcp = FastMCP("xhs-chengfeng-mapi")


# ---------------------------------------------------------------------------
# Token 管理：优先用应用三要素自动刷新；失败回退环境变量中的 access_token
# ---------------------------------------------------------------------------

class TokenManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._token: Optional[str] = None
        self._expires_at: float = 0.0
        self._source: str = "none"
        self._cache_file = pathlib.Path(__file__).parent / ".token_cache.json"
        self._load_cache()

    def _load_cache(self) -> None:
        try:
            data = json.loads(self._cache_file.read_text(encoding="utf-8"))
            if data.get("access_token") and data.get("expires_at", 0) > time.time() + 60:
                self._token = data["access_token"]
                self._expires_at = float(data["expires_at"])
                self._source = "cache"
        except Exception:
            pass

    def _save_cache(self) -> None:
        try:
            self._cache_file.write_text(
                json.dumps({"access_token": self._token, "expires_at": self._expires_at}),
                encoding="utf-8",
            )
        except Exception:
            pass

    def status(self) -> Dict[str, Any]:
        return {
            "has_token": bool(self._token),
            "source": self._source,
            "expires_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self._expires_at))
            if self._expires_at else None,
            "seconds_left": int(self._expires_at - time.time()) if self._expires_at else None,
            "app_creds_ready": bool(os.getenv("XHS_APP_ID") and os.getenv("XHS_SECRET") and os.getenv("XHS_REFRESH_TOKEN")),
        }

    async def _refresh(self) -> str:
        app_id_raw = os.getenv("XHS_APP_ID", "")
        secret = os.getenv("XHS_SECRET", "")
        refresh_token = os.getenv("XHS_REFRESH_TOKEN", "")
        if not (app_id_raw and secret and refresh_token):
            raise RuntimeError(
                "缺少凭证：请配置 XHS_APP_ID / XHS_SECRET / XHS_REFRESH_TOKEN"
                "（项目目录 .env 文件或环境变量），或直接设置 XHS_ACCESS_TOKEN"
            )
        payload: Dict[str, Any] = {"secret": secret, "refresh_token": refresh_token}
        payload["app_id"] = int(app_id_raw) if app_id_raw.isdigit() else app_id_raw
        async with httpx.AsyncClient(base_url=API_BASE, timeout=HTTP_TIMEOUT) as client:
            resp = await client.post("/api/open/oauth2/refresh_token", json=payload)
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f"刷新 token 返回非 JSON（HTTP {resp.status_code}）：{resp.text[:300]}")
        if not data.get("success") or data.get("code") not in (0, None):
            raise RuntimeError(f"刷新 token 被拒绝：code={data.get('code')} msg={data.get('msg')}")
        d = data.get("data") or {}
        token = d.get("access_token")
        if not token:
            raise RuntimeError(f"刷新 token 响应缺少 access_token：{json.dumps(d, ensure_ascii=False)[:300]}")
        expires_in = int(d.get("access_token_expires_in") or 0)
        self._token = token
        self._expires_at = time.time() + max(expires_in - 300, 60)  # 提前 5 分钟续
        self._source = "refreshed"
        self._save_cache()
        if d.get("refresh_token"):
            _persist_refresh_token(d["refresh_token"])
        return token

    async def get_token(self, force_refresh: bool = False) -> str:
        async with self._lock:
            if not force_refresh and self._token and time.time() < self._expires_at:
                return self._token
            try:
                return await self._refresh()
            except Exception:
                # 自动刷新失败时，回退到环境变量里手填的 access_token
                manual = os.getenv("XHS_ACCESS_TOKEN")
                if manual:
                    self._token = manual
                    self._expires_at = time.time() + 3600  # 手填 token 按 1 小时保守估计
                    self._source = "env"
                    return manual
                raise


TOKENS = TokenManager()


def _persist_refresh_token(new_token: str) -> None:
    """把轮换后的新 refresh_token 写回 .env（refresh_token 30 天有效且每次刷新会轮换，
    不落盘的话旧令牌失效后服务就哑了）。持久化失败不影响本次调用，内存缓存仍然有效。"""
    env_path = pathlib.Path(__file__).parent / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
        out, replaced = [], False
        for ln in lines:
            if ln.strip().startswith("XHS_REFRESH_TOKEN="):
                out.append(f"XHS_REFRESH_TOKEN={new_token}")
                replaced = True
            else:
                out.append(ln)
        if not replaced:
            out.append(f"XHS_REFRESH_TOKEN={new_token}")
        env_path.write_text("\n".join(out) + "\n", encoding="utf-8")
        os.environ["XHS_REFRESH_TOKEN"] = new_token
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 通用请求封装：带 token 失效自动重刷一次
# ---------------------------------------------------------------------------

def _looks_like_token_error(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    code = data.get("code")
    msg = str(data.get("msg") or "").lower()
    if code in _TOKEN_ERROR_CODES:
        return True
    return any(k in msg for k in _TOKEN_ERROR_KEYWORDS) and not data.get("success", True)


async def call_api(path: str, payload: Dict[str, Any], auth: bool = True) -> Dict[str, Any]:
    """调用乘风开放接口；token 失效时自动刷新并重试一次。返回原始响应 dict。"""
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Access-Token"] = await TOKENS.get_token()
    try:
        async with httpx.AsyncClient(base_url=API_BASE, timeout=HTTP_TIMEOUT) as client:
            resp = await client.post(path, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        return {"error": f"网络请求失败：{type(exc).__name__}: {exc}", "path": path}
    try:
        data = resp.json()
    except Exception:
        return {"error": f"HTTP {resp.status_code} 非 JSON 响应", "body": resp.text[:500], "path": path}

    if auth and _looks_like_token_error(data):
        # token 失效：强制刷新后重试一次
        try:
            headers["Access-Token"] = await TOKENS.get_token(force_refresh=True)
            async with httpx.AsyncClient(base_url=API_BASE, timeout=HTTP_TIMEOUT) as client:
                resp2 = await client.post(path, json=payload, headers=headers)
            try:
                return resp2.json()
            except Exception:
                return {"error": f"HTTP {resp2.status_code} 非 JSON 响应", "body": resp2.text[:500], "path": path}
        except Exception as exc:
            return {"error": f"token 刷新失败：{exc}", "path": path, "first_response": data}
    return data


def _clean(**kwargs: Any) -> Dict[str, Any]:
    """去掉值为 None 的参数，避免把空值传给接口。"""
    return {k: v for k, v in kwargs.items() if v is not None}


def _parse_list(value: Any) -> Any:
    """数组参数兼容层：实测部分 MCP 客户端无法按 schema 传数组，
    这里同时接受 JSON 数组字符串、单个 JSON 对象字符串、逗号分隔字符串与真实数组。"""
    if value is None or isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [value]
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s[0] in "[{":
            try:
                return json.loads(s)
            except Exception:
                pass
        return [x.strip() for x in s.split(",") if x.strip()]
    return value


def _advertiser_id(advertiser_id: Optional[int]) -> int:
    if advertiser_id is not None:
        return advertiser_id
    env_id = os.getenv("XHS_ADVERTISER_ID")
    if env_id and env_id.isdigit():
        return int(env_id)
    raise RuntimeError("缺少 advertiser_id：请在调用参数传入，或配置环境变量 XHS_ADVERTISER_ID")


# ---------------------------------------------------------------------------
# 1. OAuth2.0 授权
# ---------------------------------------------------------------------------

@mcp.tool()
async def oauth_refresh_token(
    app_id: Optional[int] = None,
    secret: Optional[str] = None,
    refresh_token: Optional[str] = None,
) -> Dict[str, Any]:
    """刷新token（文档ID 4808）。用 app_id + secret + refresh_token 换取新的 access_token / refresh_token。
    access_token 有效期 1 天，refresh_token 有效期 30 天。不传参数时默认读取环境变量 XHS_APP_ID / XHS_SECRET / XHS_REFRESH_TOKEN。
    返回 data.access_token、data.refresh_token、data.approval_advertisers（授权的广告主账号列表）等。"""
    payload = _clean(
        app_id=app_id if app_id is not None else (int(os.getenv("XHS_APP_ID", "0")) or None),
        secret=secret or os.getenv("XHS_SECRET"),
        refresh_token=refresh_token or os.getenv("XHS_REFRESH_TOKEN"),
    )
    if not payload.get("app_id") or not payload.get("secret") or not payload.get("refresh_token"):
        return {"error": "缺少参数：需要 app_id / secret / refresh_token（参数或环境变量）"}
    data = await call_api("/api/open/oauth2/refresh_token", payload, auth=False)
    # 刷新成功后立即采用新 token
    if isinstance(data, dict) and data.get("success") and (data.get("data") or {}).get("access_token"):
        d = data["data"]
        async with TOKENS._lock:
            TOKENS._token = d["access_token"]
            TOKENS._expires_at = time.time() + max(int(d.get("access_token_expires_in") or 0) - 300, 60)
            TOKENS._source = "manual_refresh"
            TOKENS._save_cache()
            if d.get("refresh_token"):
                _persist_refresh_token(d["refresh_token"])
    return data


@mcp.tool()
async def oauth_exchange_code(
    auth_code: str,
    redirect_uri: str = "http://localhost/oauth/callback",
) -> Dict[str, Any]:
    """授权码换 token（OAuth2.0 授权流程，端点 /api/open/oauth2/access_token，首次接入用）。
    流程：浏览器打开授权URL（https://ad-market.xiaohongshu.com/auth?appId=...&scope=[...]&redirectUri=...）
    -> 点授权 -> 跳转到 redirectUri?code=XXXX -> XXXX 就是 auth_code。
    返回 access_token / refresh_token（30 天有效，之后本服务自动续期）及授权广告主列表；
    新 refresh_token 会自动写回 .env。"""
    payload: Dict[str, Any] = {
        "secret": os.getenv("XHS_SECRET"),
        "auth_code": auth_code,
        "redirect_uri": redirect_uri,
    }
    app_id_raw = os.getenv("XHS_APP_ID", "")
    if app_id_raw.isdigit():
        payload["app_id"] = int(app_id_raw)
    else:
        payload["app_id"] = app_id_raw or None
    if not payload.get("app_id") or not payload.get("secret"):
        return {"error": "缺少 XHS_APP_ID / XHS_SECRET（.env 或环境变量）"}
    data = await call_api("/api/open/oauth2/access_token", payload, auth=False)
    if isinstance(data, dict) and data.get("success") and (data.get("data") or {}).get("access_token"):
        d = data["data"]
        async with TOKENS._lock:
            TOKENS._token = d["access_token"]
            TOKENS._expires_at = time.time() + max(int(d.get("access_token_expires_in") or 0) - 300, 60)
            TOKENS._source = "exchanged"
            TOKENS._save_cache()
            if d.get("refresh_token"):
                _persist_refresh_token(d["refresh_token"])
    return data


@mcp.tool()
async def check_auth() -> Dict[str, Any]:
    """检查当前鉴权状态：token 是否可用、来源、过期时间，并返回授权的广告主账号列表（approval_advertisers）。
    配置了应用三要素时会实际触发一次刷新；仅用于验证凭证是否配好。"""
    status = TOKENS.status()
    try:
        await TOKENS.get_token(force_refresh=True)
        status["refresh_ok"] = True
    except Exception as exc:
        status["refresh_ok"] = False
        status["refresh_error"] = str(exc)
    return status


# ---------------------------------------------------------------------------
# 2. 账户服务（3 个）
# ---------------------------------------------------------------------------

@mcp.tool()
async def list_agent_sub_accounts(
    user_id: str,
    page: int,
    page_size: int,
    virtual_seller_id: Optional[str] = None,
    create_time_start: Optional[int] = None,
    create_time_end: Optional[int] = None,
) -> Dict[str, Any]:
    """获取代理商子账号列表（文档ID 4112）。分页拉取代理商下的子账号。
    user_id: 代理商主账号ID；page/page_size: 分页（page_size 上限 500）；
    create_time_start/end: 子账户开户时间范围，毫秒时间戳。"""
    if page_size > 500:
        return {"error": "page_size 上限为 500"}
    return await call_api("/api/open/jg/account/sub/page", _clean(
        user_id=user_id, page=page, page_size=page_size,
        virtual_seller_id=virtual_seller_id,
        create_time_start=create_time_start, create_time_end=create_time_end,
    ))


@mcp.tool()
async def query_transfer_result(
    user_id: str,
    virtual_seller_id: str,
    request_no: str,
) -> Dict[str, Any]:
    """查询转账结果接口（文档ID 4301）。按转账时传入的 request_no 查询处理状态。
    status: PROCESSING 处理中 / SUCCESS 成功 / FAIL 失败。"""
    return await call_api("/api/open/finance/transfer/result/query", {
        "user_id": user_id, "virtual_seller_id": virtual_seller_id, "request_no": request_no,
    })


@mcp.tool()
async def query_finance_transaction_records(
    user_id: str,
    virtual_seller_id: str,
    start_date: str,
    end_date: str,
    page_index: int,
    page_size: int,
    date_key: Optional[int] = None,
    wallet_type_list: Optional[Union[List[int], str]] = None,
    trade_type_list: Optional[Union[List[int], str]] = None,
) -> Dict[str, Any]:
    """资金流水查询（文档ID 4302）。查询代理商/子账号的资金流水明细。
    日期格式 yyyy-MM-dd；date_key: 1=按投放日期拉取，2=按扣费日期拉取；
    wallet_type_list: 资金类型（0 现金/1 授信/2 常规返货/4 赔付返货）；
    trade_type_list: 交易类型（1 充值/5 转账/6 出款/11 订单支付/12 订单退款等）。
    注意：消耗流水在次日 6:00 之后才可查。"""
    return await call_api("/api/open/finance/transaction/record/query", _clean(
        user_id=user_id, virtual_seller_id=virtual_seller_id,
        start_date=start_date, end_date=end_date,
        page_index=page_index, page_size=page_size,
        date_key=date_key, wallet_type_list=_parse_list(wallet_type_list), trade_type_list=_parse_list(trade_type_list),
    ))


# ---------------------------------------------------------------------------
# 3. 离线报表（7 个）：/api/open/wind/data/report/offline/{level}
# ---------------------------------------------------------------------------

async def _offline_report(
    level: str,
    advertiser_id: Optional[int],
    start_date: str,
    end_date: str,
    time_unit: Optional[str],
    columns: Optional[List[str]],
    split_columns: Optional[List[str]],
    page_num: Optional[int],
    page_size: Optional[int],
    filters: Optional[List[Dict[str, Any]]],
) -> Dict[str, Any]:
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填，格式 yyyy-MM-dd"}
    # 实测约束（文档未写）：离线报表 end_date 不能是今天，否则 code=10002
    # 「结束时间不为空，不能为今天」。离线数据 T+1，要今天的数据请用实时/小时接口。
    today = datetime.date.today().strftime("%Y-%m-%d")
    if end_date >= today:
        return {
            "error": f"离线报表不能查今天（end_date={end_date}），数据 T+1。"
                     f"请把 end_date 设为昨天及更早，或改用实时/小时接口查今日数据。",
            "suggested_end_date": (datetime.date.today() - datetime.timedelta(days=1)).strftime("%Y-%m-%d"),
        }
    return await call_api(f"/api/open/wind/data/report/offline/{level}", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date,
        time_unit=time_unit, columns=_parse_list(columns), split_columns=_parse_list(split_columns),
        page_num=page_num, page_size=page_size, filters=_parse_list(filters),
    ))


@mcp.tool()
async def report_offline_account(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """账户层级离线报表（文档ID 4023）。广告主维度汇总数据。
    start/end_date: yyyy-MM-dd；time_unit: DAY 分天 / HOUR 分时 / SUMMARY 汇总（默认分天）；
    columns: 指标列（不传只返回基础指标 fee/impression/ctr/click/acp/cpm）；
    split_columns: 聚合维度（marketingTarget 营销场景 / campaignPlacement 广告类型 / optimizeTarget 推广目标）；
    page_size 最大 500；filters: [{column, operator:"in", values:[...]}]。
    advertiser_id 不传时取环境变量 XHS_ADVERTISER_ID。"""
    return await _offline_report("account", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


@mcp.tool()
async def report_offline_campaign(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """计划层级离线报表（文档ID 4029）。返回计划维度数据。
    实测响应结构为扁平行：维度字段（campaign_id / campaign_name / marketing_target / optimize_target / time）
    与指标字段同层并列，不存在文档中 base_campaign_dto 的嵌套结构。
    注意：离线报表 T+1，end_date 不能为今天；optimize_target 枚举文档不完整（实测出现 87 等未列值）。
    参数同账户层级离线报表；filters 可筛计划ID：column=campaignId, operator=in, values=[计划ID...]。"""
    return await _offline_report("campaign", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


@mcp.tool()
async def report_offline_creativity(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """创意层级离线报表（文档ID 4030）。返回创意维度数据。
    实测响应结构为扁平行：维度字段（creativity_id / note_id / campaign_id 等）与指标字段同层并列，
    不存在文档中 base_creativity_dto 的嵌套结构。
    注意：离线报表 T+1，end_date 不能为今天。
    参数同账户层级离线报表；filters 可筛创意ID：column=creativityId。"""
    return await _offline_report("creativity", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


@mcp.tool()
async def report_offline_note(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """笔记层级离线报表（文档ID 4031）。按笔记维度返回推广数据，用于评估单条笔记的投放效果。
    注意：同一条笔记可能挂在多个计划下，评估笔记整体效果需跨计划汇总（账户级口径）。
    参数同账户层级离线报表。"""
    return await _offline_report("note", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


@mcp.tool()
async def report_offline_keyword(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """关键词层级离线报表（文档ID 4032）。按搜索关键词维度返回推广数据，用于选词/否词分析。
    参数同账户层级离线报表。"""
    return await _offline_report("keyword", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


@mcp.tool()
async def report_offline_live(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """直播间层级离线报表（文档ID 4033）。按直播间维度返回推广数据（含直播观看/直接转化指标）。
    参数同账户层级离线报表。"""
    return await _offline_report("live", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


@mcp.tool()
async def report_offline_spu(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    time_unit: Optional[str] = None,
    columns: Optional[Union[List[str], str]] = None,
    split_columns: Optional[Union[List[str], str]] = None,
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """商品层级离线报表（文档ID 4034）。按 SPU（商品）维度返回推广数据，用于评估单品投放效率。
    参数同账户层级离线报表。"""
    return await _offline_report("spu", advertiser_id, start_date, end_date,
                                 time_unit, columns, split_columns, page_num, page_size, filters)


# ---------------------------------------------------------------------------
# 4. 实时报表（6 个）：/api/open/wind/data/report/realtime/{level} 与 .../hour/{level}
# ---------------------------------------------------------------------------

@mcp.tool()
async def report_realtime_account(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    columns: Optional[Union[List[str], str]] = None,
) -> Dict[str, Any]:
    """账户层级实时数据（文档ID 3995）。返回广告主维度汇总的一条数据。
    注意：start_date/end_date 仅允许查今日数据（格式 yyyy-MM-dd 或 yyyyMMdd）。"""
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填（实时/小时接口仅允许查今日数据）"}
    return await call_api("/api/open/wind/data/report/realtime/account", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date, columns=_parse_list(columns),
    ))


@mcp.tool()
async def report_realtime_campaign(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    columns: Optional[Union[List[str], str]] = None,
    campaign_filter_state: Optional[int] = None,
    campaign_create_begin_time: Optional[str] = None,
    campaign_create_end_time: Optional[str] = None,
    placement_list: Optional[Union[List[int], str]] = None,
    limit_day_budget_list: Optional[Union[List[int], str]] = None,
    optimize_target_list: Optional[Union[List[int], str]] = None,
    bidding_constraint_list: Optional[Union[List[int], str]] = None,
    delivery_mode_list: Optional[Union[List[int], str]] = None,
    promotion_type: int = 1,
) -> Dict[str, Any]:
    """计划层级实时数据（文档ID 4003）。返回分页的计划列表 + 各计划实时指标。
    日期格式 yyyy-MM-dd；page_size 默认 20 最大 200；promotion_type: 1=商品推广，2=直播推广；
    campaign_filter_state: 计划状态（1 有效/2 暂停/3 暂停时段/4 未开始/5 已结束/6 预算不足/7 账户日预算不足/8 现金余额不足/9 已删除）；
    placement_list: 广告类型（1 信息流/2 搜索/4 通投/7 视频流）；
    optimize_target_list: 推广目标（0 点击量/1 互动量/4 商品7日总下单订单量/11 商品访客量/17 商品7日总下单ROI 等）；
    bidding_constraint_list: 投放方式（2 手动/3 放量/7 控成本/701 点击成本约束）；
    limit_day_budget_list: 预算类型（0 不限/1 指定）；delivery_mode_list: 投放模式（0 自定义/1 托管）。"""
    if page_size is not None and page_size > 200:
        return {"error": "page_size 上限为 200"}
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填，格式 yyyy-MM-dd"}
    return await call_api("/api/open/wind/data/report/realtime/campaign", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date,
        page_num=page_num, page_size=page_size, columns=_parse_list(columns),
        campaign_filter_state=campaign_filter_state,
        campaign_create_begin_time=campaign_create_begin_time,
        campaign_create_end_time=campaign_create_end_time,
        placement_list=_parse_list(placement_list), limit_day_budget_list=_parse_list(limit_day_budget_list),
        optimize_target_list=_parse_list(optimize_target_list), bidding_constraint_list=_parse_list(bidding_constraint_list),
        delivery_mode_list=_parse_list(delivery_mode_list), promotion_type=promotion_type,
    ))


@mcp.tool()
async def report_realtime_creativity(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    page_num: Optional[int] = None,
    page_size: Optional[int] = None,
    creativity_create_begin_time: Optional[str] = None,
    creativity_create_end_time: Optional[str] = None,
    creativity_filter_state: Optional[int] = None,
    creativity_audit_state: Optional[int] = None,
    placement_list: Optional[Union[List[int], str]] = None,
    columns: Optional[Union[List[str], str]] = None,
) -> Dict[str, Any]:
    """创意层级实时数据（文档ID 4019）。返回分页的创意列表 + 各创意实时指标。
    creativity_filter_state: 创意状态（1 有效/2 暂停/3 商品状态异常/4 被计划暂停/5 计划未开始/6 计划已结束/7 计划暂停时段/8 计划预算不足/9 账户日预算不足/10 现金余额不足/11 已删除）；
    creativity_audit_state: 审核状态（0 待审核/1 通过/2 拒绝/3 修改待审核）；
    placement_list: 广告类型（1 信息流/2 搜索/4 通投/7 视频流）。"""
    if page_size is not None and page_size > 200:
        return {"error": "page_size 上限为 200"}
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填，格式 yyyy-MM-dd"}
    return await call_api("/api/open/wind/data/report/realtime/creativity", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date,
        page_num=page_num, page_size=page_size,
        creativity_create_begin_time=creativity_create_begin_time,
        creativity_create_end_time=creativity_create_end_time,
        creativity_filter_state=creativity_filter_state,
        creativity_audit_state=creativity_audit_state,
        placement_list=_parse_list(placement_list), columns=_parse_list(columns),
    ))


@mcp.tool()
async def report_hourly_account(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    columns: Optional[Union[List[str], str]] = None,
) -> Dict[str, Any]:
    """账户层级小时数据（文档ID 4075）。按小时返回广告主维度数据，用于日内消耗监控。
    注意：start_date/end_date 仅允许查今日数据；建议 columns 必传 impression、action_button_click。"""
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填（小时接口仅允许查今日数据）"}
    return await call_api("/api/open/wind/data/report/realtime/hour/account", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date, columns=columns,
    ))


@mcp.tool()
async def report_hourly_campaign(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    columns: Optional[Union[List[str], str]] = None,
    filters: Optional[Union[List[Dict[str, Any]], str]] = None,
) -> Dict[str, Any]:
    """计划层级小时数据（文档ID 4076）。按小时返回计划数据。
    注意：仅允许查今日数据；filters 筛计划ID：column=campaignId, operator=in, values=[...]（最多 50 个）。"""
    filters = _parse_list(filters)
    if filters and len(filters[0].get("values", [])) > 50:
        return {"error": "filters.values 最多传 50 个计划ID"}
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填（小时接口仅允许查今日数据）"}
    return await call_api("/api/open/wind/data/report/realtime/hour/campaign", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date, columns=_parse_list(columns), filters=_parse_list(filters),
    ))


@mcp.tool()
async def report_hourly_creativity(
    advertiser_id: Optional[int] = None,
    start_date: str = "",
    end_date: str = "",
    columns: Optional[Union[List[str], str]] = None,
    filters: Union[List[Dict[str, Any]], str] = [],
) -> Dict[str, Any]:
    """创意层级小时数据（文档ID 4077）。按小时返回创意数据。
    注意：仅允许查今日数据；filters 必传，筛创意ID：column=creativityId, operator=in, values=[...]（最多 50 个）。"""
    filters = _parse_list(filters)
    if not filters:
        return {"error": "filters 必传：[{column:'creativityId', operator:'in', values:[创意ID...]}]（最多 50 个）"}
    if len(filters[0].get("values", [])) > 50:
        return {"error": "filters.values 最多传 50 个创意ID"}
    if not start_date or not end_date:
        return {"error": "start_date / end_date 必填（小时接口仅允许查今日数据）"}
    return await call_api("/api/open/wind/data/report/realtime/hour/creativity", _clean(
        advertiser_id=_advertiser_id(advertiser_id),
        start_date=start_date, end_date=end_date, columns=columns, filters=filters,
    ))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()  # 默认 stdio 传输
