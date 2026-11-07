#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书聚光 MAPI MCP Server（自动生成，勿手改）
===============================================

由 _endpoints.json（提取自官方 Go SDK github.com/jundaychan/spotlight-mapi，
对齐聚光开放文档 bizType=943）自动生成为 MCP 工具。

安全设计：写操作（创建/修改/删除/改价/转账等 %d 个）必须显式传 confirm=true 才会真正发起，
否则只返回待确认提示——防止 AI 误调用造成真实投放或预算变更。

统一网关 https://adapi.xiaohongshu.com，鉴权 Header: Access-Token。
与乘风 MCP 共用同一套 app_id / secret / refresh_token（同一 OAuth 体系），
但需要不同的 scope 授权才能调通聚光接口。

凭证配置（.env 或环境变量）：
  XHS_APP_ID / XHS_SECRET / XHS_REFRESH_TOKEN
  XHS_ADVERTISER_ID   默认广告主ID
  XHS_ALLOW_WRITE    设为 1 才允许写操作真正执行（未设置时写操作一律拦截）
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

load_dotenv(pathlib.Path(__file__).parent / ".env")
load_dotenv()

API_BASE = os.getenv("XHS_API_BASE", "https://adapi.xiaohongshu.com").rstrip("/")
HTTP_TIMEOUT = float(os.getenv("XHS_HTTP_TIMEOUT", "30"))

_TOKEN_ERROR_CODES = {40001, 40002, 40100, 40101, 40300, 410019}
_TOKEN_ERROR_KEYWORDS = ("token", "access_token", "鉴权", "授权")
# 并发去重窗口：此窗口内的重复 refresh 视为同一次，直接复用已刷新的 token
_REFRESH_DEDUP_WINDOW = 10.0
_SCOPE_ERROR_CODES = {410023}

mcp = FastMCP("xhs-juguang-mapi")


# ---------------------------------------------------------------------------
# Token 管理（与乘风 MCP 同构）
# ---------------------------------------------------------------------------

class TokenManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._token: Optional[str] = None
        self._expires_at: float = 0.0
        self._source: str = "none"
        self._meta: Dict[str, Any] = {}
        self._last_refresh_at: float = 0.0
        self._cache_file = pathlib.Path(__file__).parent / ".token_cache.json"
        self._load_cache()

    def _load_cache(self) -> None:
        try:
            data = json.loads(self._cache_file.read_text(encoding="utf-8"))
            self._meta = data.get("meta") or {}
            if data.get("access_token") and data.get("expires_at", 0) > time.time() + 60:
                self._token = data["access_token"]
                self._expires_at = float(data["expires_at"])
                self._source = "cache"
        except Exception:
            pass

    def _save_cache(self) -> None:
        try:
            self._cache_file.write_text(
                json.dumps({"access_token": self._token, "expires_at": self._expires_at,
                            "meta": self._meta}),
                encoding="utf-8")
        except Exception:
            pass

    def meta(self) -> Dict[str, Any]:
        """本次授权的元信息：scope / 授权广告主 / 公司名。

        随每次刷新一起落盘到 .token_cache.json —— 判断「哪些接口能调」的唯一
        依据是 authorized_scopes，不要靠猜接口路径。
        """
        return dict(self._meta)

    def status(self) -> Dict[str, Any]:
        return {
            "has_token": bool(self._token),
            "source": self._source,
            "expires_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self._expires_at))
            if self._expires_at else None,
            "seconds_left": int(self._expires_at - time.time()) if self._expires_at else None,
            "app_creds_ready": bool(os.getenv("XHS_APP_ID") and os.getenv("XHS_SECRET")
                                    and os.getenv("XHS_REFRESH_TOKEN")),
            "write_enabled": os.getenv("XHS_ALLOW_WRITE", "") in ("1", "true", "True"),
        }

    async def _refresh(self) -> str:
        app_id_raw = os.getenv("XHS_APP_ID", "")
        secret = os.getenv("XHS_SECRET", "")
        refresh_token = os.getenv("XHS_REFRESH_TOKEN", "")
        if not (app_id_raw and secret and refresh_token):
            raise RuntimeError(
                "缺少凭证：请配置 XHS_APP_ID / XHS_SECRET / XHS_REFRESH_TOKEN"
                "（项目目录 .env 或环境变量），或直接设置 XHS_ACCESS_TOKEN")
        payload: Dict[str, Any] = {"secret": secret, "refresh_token": refresh_token}
        payload["app_id"] = int(app_id_raw) if app_id_raw.isdigit() else app_id_raw
        async with httpx.AsyncClient(base_url=API_BASE, timeout=HTTP_TIMEOUT) as client:
            resp = await client.post("/api/open/oauth2/refresh_token", json=payload)
        try:
            data = resp.json()
        except Exception:
            raise RuntimeError(f"刷新 token 返回非 JSON（HTTP {resp.status_code}）")
        if not data.get("success"):
            raise RuntimeError(f"刷新 token 被拒绝：code={data.get('code')} msg={data.get('msg')}")
        d = data.get("data") or {}
        token = d.get("access_token")
        if not token:
            raise RuntimeError("刷新 token 响应缺少 access_token")
        self._token = token
        self._expires_at = time.time() + max(int(d.get("access_token_expires_in") or 0) - 300, 60)
        self._source = "refreshed"
        # 授权元信息随刷新落盘，供 check_auth 返回 scope / 授权广告主
        self._meta = {
            "scope": d.get("scope"),
            "approval_advertisers": d.get("approval_advertisers"),
            "corporation_name": d.get("corporation_name"),
            "user_id": d.get("user_id"),
            "role_type": d.get("role_type"),
        }
        self._save_cache()
        if d.get("refresh_token"):
            _persist_refresh_token(d["refresh_token"])
        return token

    async def get_token(self, force_refresh: bool = False) -> str:
        # 单飞(single-flight)：并发请求共享同一次刷新。
        #
        # ⚠️ refresh_token 每次刷新都被平台轮换，旧值立即作废。若 N 个并发请求
        # 同时判定 token 失效就会触发 N 次刷新 -> N-1 枚 refresh_token 被作废
        # -> 整条链路哑掉（实测：并发 8 次刷新 = 丢 7 枚 token）。
        # 因此拿到锁后必须二次检查：若前一个协程刚刷新过，直接复用它的结果。
        async with self._lock:
            if self._token and time.time() < self._expires_at:
                if not force_refresh:
                    return self._token
                if self._last_refresh_at and time.time() - self._last_refresh_at < _REFRESH_DEDUP_WINDOW:
                    return self._token
            try:
                token = await self._refresh()
                self._last_refresh_at = time.time()
                return token
            except Exception:
                manual = os.getenv("XHS_ACCESS_TOKEN")
                if manual:
                    self._token = manual
                    self._expires_at = time.time() + 3600
                    self._source = "env"
                    return manual
                raise


TOKENS = TokenManager()


def _persist_refresh_token(new_token: str) -> None:
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
# 通用请求
# ---------------------------------------------------------------------------

def _parse_val(value: Any) -> Any:
    """数组/对象参数兼容层：接受真实数组、JSON 字符串、逗号分隔字符串。

    兼容三种客户端传参形态：
      1) 已解析的 list / dict（部分客户端能按 schema 传数组）
      2) JSON 字符串 '"[1,2]"' / '{"a":1}'
      3) 逗号分隔字符串 "1,2,3"（无法传数组的客户端的唯一选择）
    """
    if value is None or isinstance(value, (list, dict)):
        return value
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s[0] in "[{":
            try:
                return json.loads(s)
            except Exception as exc:
                # ⚠️ 墨菲场景：用户传了畸形 JSON（如 "[1,2,"）。
                # 【绝不能】退回逗号切分——那会得到["[1","2"] 这种含垃圾的数组，
                # 并被原样发给平台，变成静默数据损坏（比报错危险得多）。
                # 开头是 [ 或 { 说明用户意图就是 JSON，就明确报错让调用方改。
                raise ValueError(
                    f"参数是畸形 JSON（以 {s[0]} 开头但解析失败）：{s[:60]}... "
                    f"解析错误 {type(exc).__name__}。请改成合法 JSON 数组/对象，"
                    f"或改用逗号分隔写法（如 1,2,3）。") from exc
        return [x.strip() for x in s.split(",") if x.strip()]
    return value


def _looks_like_token_error(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    if data.get("code") in _TOKEN_ERROR_CODES:
        return True
    msg = str(data.get("msg") or "").lower()
    return any(k in msg for k in _TOKEN_ERROR_KEYWORDS) and not data.get("success", True)


def _parse_val_or_error(value: Any, field: str) -> Any:
    """_parse_val 的安全包装：畸形入参转成结构化错误，而不是抛到框架层。

    _parse_val 遇到畸形 JSON 会主动抛 ValueError（因为退回逗号切分会造成
    静默数据损坏）。若直接冒泡，MCP 框架只会显示
    "Error executing tool xxx: ..." 并丢掉字段名，排查成本高。
    这里把异常收敛成 {"_param_error": ...} 并附上出错字段名与原始值。
    """
    try:
        return _parse_val(value)
    except ValueError as exc:
        return {"_param_error": str(exc), "_field": field, "_raw": str(value)[:120]}


def _strip_param_errors(payload: Dict[str, Any], tool: str) -> Optional[Dict[str, Any]]:
    """若payload 里有字段解析失败，直接返回错误，绝不把脏数据发给平台。"""
    bad = {k: v for k, v in payload.items()
           if isinstance(v, dict) and v.get("_param_error")}
    if not bad:
        return None
    return {
        "error": "参数解析失败，已拦截请求（未向平台发送任何数据）",
        "tool": tool,
        "bad_fields": {k: v for k, v in bad.items()},
        "hint": "数组/对象类参数可传：真实数组、合法 JSON 字符串，或逗号分隔字符串。",
    }


# ---------------------------------------------------------------------------
# 路径安全：歧义路径必须拒绝，而不是「猜一个」
# ---------------------------------------------------------------------------
# SDK 里存在【不同接口共用同一 path】的情况（实测：/common 同时被
# advertiser.AccessToken 与 conversion.AuroraLeads 使用）。若按path 分发，
# 调用 conversion 回传却打到了取 token 的接口，且两边都返回 HTTP 200，
# 属于「静默打错接口」——比报错更危险。因此显式登记歧义路径并拒绝。
_AMBIGUOUS_PATHS = {
    "/common": "advertiser.AccessToken(取accessToken) 与 conversion.AuroraLeads(线索转化回传) 共用",
}
# 命名空间守卫：本 MCP 面向聚光(/jg)与乘风(/wind)，其余前缀属其他业务域，
# 误拼路径会 404，直接在本地拦下并给出正确前缀提示。
_NS_RULES = (
    ("/jg/", "聚光"),
    ("/wind/", "乘风"),
    ("/oauth2/", "OAuth 鉴权"),
)


def _guard_path(path: str) -> Optional[Dict[str, Any]]:
    """调用前校验路径；有问题就返回错误 dict，不发请求。"""
    if path in _AMBIGUOUS_PATHS:
        return {
            "error": f"路径歧义，已拒绝发送：{path} 同时对应 {_AMBIGUOUS_PATHS[path]}，"
                     f"无法判断应调用哪一个。请改用明确的完整路径。",
            "ambiguous_path": path,
            "ambiguous_owners": _AMBIGUOUS_PATHS[path],
        }
    if path.startswith("/ad_material_note/") or path in ("/app", "/conversion", "/finance",
                                                          "/finance/agent/transfer",
                                                          "/finance/balance/query",
                                                          "/finance/transaction/record/query",
                                                          "/finance/transfer/result/query"):
        return {
            "error": f"路径不属于聚光(/jg)或乘风(/wind)命名空间：{path}。"
                     f"本 MCP 只暴露 /jg/* 与 /wind/* 接口，该路径请用对应系统的官方客户端。",
            "rejected_path": path,
        }
    if not any(path.startswith(p) for p, _ in _NS_RULES):
        return {
            "error": f"未识别的路径前缀：{path}。本 MCP 支持 /jg/*（聚光）、"
                     f"/wind/*（乘风）、/oauth2/*（鉴权）。",
            "rejected_path": path,
        }
    return None


async def call_api(path: str, payload: Dict[str, Any], auth: bool = True) -> Dict[str, Any]:
    """调用聚光开放接口；token 失效自动刷新重试一次。返回原始响应。

    ⚠️ 顺序很重要：先 _guard_path 拦掉歧义/越界路径，再取 token——
    否则一次非法路径调用就会白白消耗一次 refresh_token 轮换。
    """
    blocked = _guard_path(path)
    if blocked is not None:
        return blocked

    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Access-Token"] = await TOKENS.get_token()
    try:
        async with httpx.AsyncClient(base_url=API_BASE, timeout=HTTP_TIMEOUT) as client:
            resp = await client.post(f"/api/open{path}", json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        # 超时必须与「其他 HTTP 错误」区分：前者通常是上游慢/网络抖动，可原样重试
        return {"error": f"请求超时（>{HTTP_TIMEOUT}s）：{type(exc).__name__}: {exc}",
                "path": path, "retryable": True, "timeout_seconds": HTTP_TIMEOUT}
    except httpx.HTTPError as exc:
        return {"error": f"网络请求失败：{type(exc).__name__}: {exc}",
                "path": path, "retryable": True}
    except Exception as exc:
        # 墨菲定律：一定会出现没预料到的异常。绝不能让异常冒泡打死 MCP 进程 ——
        # 一旦 server 崩了，所有工具连带整个会话的 MCP 连接全部失效。
        return {"error": f"未预期异常：{type(exc).__name__}: {exc}", "path": path,
                "payload_keys": sorted(payload.keys())}
    try:
        data = resp.json()
    except Exception:
        return {"error": f"HTTP {resp.status_code} 非 JSON 响应", "body": resp.text[:500],
                "path": path, "http_status": resp.status_code}
    # 墨菲场景：JSON 解析成功但顶层不是对象（数组 / null / 字符串），
    # 后续 data.get() 会抛 AttributeError。加类型守卫并原样回传。
    if not isinstance(data, dict):
        return {"_non_dict_response": True, "http_status": resp.status_code,
                "data_type": type(data).__name__, "path": path,
                "data": data if len(repr(data)) <= 2000 else str(data)[:2000]}

    if auth and _looks_like_token_error(data):
        try:
            headers["Access-Token"] = await TOKENS.get_token(force_refresh=True)
            async with httpx.AsyncClient(base_url=API_BASE, timeout=HTTP_TIMEOUT) as client:
                resp2 = await client.post(f"/api/open{path}", json=payload, headers=headers)
            try:
                data2 = resp2.json()
                if data2.get("code") in _SCOPE_ERROR_CODES:
                    data2["_hint"] = ("该接口未在当前授权 scope 内。聚光与乘风的 scope 分开，"
                                       "需到开放平台为应用追加聚光相关权限后重新授权。")
                return data2
            except Exception:
                return {"error": f"HTTP {resp2.status_code} 非 JSON 响应", "path": path}
        except Exception as exc:
            return {"error": f"token 刷新失败：{exc}", "path": path, "first_response": data}
    if isinstance(data, dict) and data.get("code") in _SCOPE_ERROR_CODES:
        data["_hint"] = ("该接口未在当前授权 scope 内。聚光与乘风的 scope 分开，"
                         "需到开放平台为应用追加聚光相关权限后重新授权。")
    return data


@mcp.tool()
async def check_auth() -> Dict[str, Any]:
    """检查鉴权状态：token、来源、过期时间、**实际授权的 scope 与广告主列表**、写操作开关。

    authorized_scopes 是判断某接口能否调的唯一依据，不要靠猜接口路径。
    """
    status = TOKENS.status()
    try:
        await TOKENS.get_token(force_refresh=True)
        status["refresh_ok"] = True
    except Exception as exc:
        status["refresh_ok"] = False
        status["refresh_error"] = str(exc)
        return status
    # 授权详情（scope / 广告主列表）随每次刷新一起落盘，读缓存即可
    meta = TOKENS.meta()
    status["app_id"] = os.getenv("XHS_APP_ID")
    status["authorized_scopes"] = meta.get("scope")
    status["approved_advertisers"] = meta.get("approval_advertisers")
    status["corporation_name"] = meta.get("corporation_name")
    status["user_id"] = meta.get("user_id")

    adv = os.getenv("XHS_ADVERTISER_ID")
    if adv:
        today = datetime.date.today().strftime("%Y-%m-%d")
        probe = await call_api("/jg/data/report/realtime/account",
                               {"advertiser_id": int(adv), "start_date": today, "end_date": today})
        status["juguang_scope_ok"] = bool(probe.get("success"))
        status["probe_code"] = probe.get("code")
        status["probe_msg"] = probe.get("msg") or probe.get("_hint")
    return status




@mcp.tool()
async def advertiser_balance_info(
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """获取账号余额接口（只读｜SDK advertiser.BalanceInfo）
    端点: POST /api/open/jg/account/balance/info
获取账号余额接口
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "advertiser_balance_info")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/account/balance/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def advertiser_white_list(
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """账户白名单（只读｜SDK advertiser.WhiteList）
    端点: POST /api/open/jg/white/list
账户白名单
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "advertiser_white_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/white/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_unit(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
columns: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """AI 智能笔记详情，获取 AIGC 广告单元维度的实时报表数据（只读｜SDK ainote.Detail）
    端点: POST /api/open/jg/data/report/realtime/unit/aigc
AI 智能笔记详情，获取 AIGC 广告单元维度的实时报表数据
只读查询接口。
    参数:
    advertiser_id: 广告主 ID
    start_date（可选）: 查询开始日期，格式 YYYY-MM-DD
    end_date（可选）: 查询结束日期，格式 YYYY-MM-DD
    columns（可选）: 需要返回的指标字段列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 过滤条件列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "columns": _parse_val_or_error(columns, "columns"),
        "filters": _parse_val_or_error(filters, "filters"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_unit")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/unit/aigc", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def asset_wechat_mini_app_list(
advertiser_id: Optional[int] = None,
page_index: Optional[int] = None,
page_size: Optional[int] = None,
item_id_list: Optional[Union[str, List, Dict]] = None,
keyword: Optional[str] = None
) -> Dict[str, Any]:
    """获取微信小程序/小游戏列表（只读｜SDK asset.WechatMiniAppList）
    端点: POST /api/open/jg/app/industry_item/list
获取微信小程序/小游戏列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    page_index（可选）: 页码
    page_size（可选）: 页大小建议第一次不超过20
    item_id_list（可选）: 搜索 itemId（小程序的itemid）（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    keyword（可选）: 搜索关键词小程序名称
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_index": _parse_val_or_error(page_index, "page_index"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "item_id_list": _parse_val_or_error(item_id_list, "item_id_list"),
        "keyword": _parse_val_or_error(keyword, "keyword"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "asset_wechat_mini_app_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/app/industry_item/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def asset_mobile_app_list(
advertiser_id: Optional[int] = None,
page_index: Optional[int] = None,
page_size: Optional[int] = None,
platform: Optional[int] = None,
app_id: Optional[str] = None,
app_name: Optional[str] = None
) -> Dict[str, Any]:
    """获取移动应用列表（只读｜SDK asset.MobileAppList）
    端点: POST /api/open/jg/data/app/info
获取移动应用列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    page_index（可选）: 页码
    page_size（可选）: 页大小建议第一次不超过20
    platform（可选）: 平台类型1:ios, 2:androd(包含唤起商店和直接下载)
    app_id（可选）: appid:ios是官方id android是包名
    app_name（可选）: 应用包名
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_index": _parse_val_or_error(page_index, "page_index"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "platform": _parse_val_or_error(platform, "platform"),
        "app_id": _parse_val_or_error(app_id, "app_id"),
        "app_name": _parse_val_or_error(app_name, "app_name"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "asset_mobile_app_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/app/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def asset_industry_item_list(
advertiser_id: Optional[int] = None,
page_index: Optional[int] = None,
page_size: Optional[int] = None,
industry_item_ids: Optional[Union[str, List, Dict]] = None,
platforms: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """获取行业商品列表（只读｜SDK asset.IndustryItemList）
    端点: POST /api/open/jg/data/product/search
获取行业商品列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    page_index（可选）: 页码
    page_size（可选）: 页大小建议第一次不超过20
    industry_item_ids（可选）: 行业商品主键id（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    platforms（可选）: 行业商品平台：1淘宝；2京东；3拼多多；6：淘宝ud；7京东ud。默认不传，会返回账号下所有商品（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_index": _parse_val_or_error(page_index, "page_index"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "industry_item_ids": _parse_val_or_error(industry_item_ids, "industry_item_ids"),
        "platforms": _parse_val_or_error(platforms, "platforms"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "asset_industry_item_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/product/search", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def asset_redbook_mini_app_list(
advertiser_id: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
playlet_type: Optional[int] = None,
scene_type: Optional[int] = None
) -> Dict[str, Any]:
    """获取红书小程序列表（只读｜SDK asset.RedbookMiniAppList）
    端点: POST /api/open/jg/query/mini_program
获取红书小程序列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    page_num（可选）: 页码
    page_size（可选）: 页大小
    playlet_type（可选）: 小程序类型：1-RED_MINI_PROGRAM（小红书小程序）2-WECHAT_MINI_PROGRAM（微信小程序）
    scene_type（可选）: 场景类型（2-授权小程序，0-我的小程序）默认 0
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "playlet_type": _parse_val_or_error(playlet_type, "playlet_type"),
        "scene_type": _parse_val_or_error(scene_type, "scene_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "asset_redbook_mini_app_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/query/mini_program", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaign_create(
advertiser_id: Optional[int] = None,
marketing_target: Optional[int] = None,
campaign_name: Optional[str] = None,
placement: Optional[int] = None,
promotion_target: Optional[int] = None,
enable: Optional[int] = None,
time_type: Optional[int] = None,
start_time: Optional[str] = None,
expire_time: Optional[str] = None,
time_peroid_type: Optional[int] = None,
time_period: Optional[int] = None,
bidding_strategy: Optional[int] = None,
limit_day_budget: Optional[int] = None,
campaign_day_budget: Optional[int] = None,
optimize_target: Optional[int] = None,
constraint_type: Optional[int] = None,
smart_switch: Optional[int] = None,
pacing_mode: Optional[int] = None,
feed_flag: Optional[int] = None,
build_type: Optional[int] = None,
event_asset_id: Optional[int] = None,
asset_event: Optional[int] = None,
asset_event_id: Optional[int] = None,
page_category: Optional[int] = None,
search_flag: Optional[int] = None,
target_extension_switch: Optional[int] = None,
search_bid_ratio: Optional[float] = None,
deeplink_id: Optional[int] = None,
universal_link_id: Optional[int] = None,
detect_url_link: Optional[str] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """创建计划（写操作｜SDK campaign.Create）
    端点: POST /api/open/jg/campaign/create
创建计划
⚠️写操作：创建计划。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    marketing_target（可选）: 营销目标（4：笔记种草，9：客资收集，16：应用推广）
    campaign_name（可选）: 计划名称（长度不超过50个字符）
    placement（可选）: 广告类型（1：信息流，2：搜索推广））
    promotion_target（可选）: 推广标的类型，（1：笔记）
    enable（可选）: 计划创建后默认开启状态，1-开启，0-不开启，不传默认开启
    time_type: 推广时时间类型,，0:长期投放，1:自定义设置开始结束时间
    start_time（可选）: 推广开始时间，格式 yyyy-MM-dd
    expire_time（可选）: 推广结束时间，格式 yyyy-MM-dd
    time_peroid_type: 推广时段类型, 0: 全时段，1:自定义时间段
    time_period（可选）: 高级设置-自定义时间段（全时段可不传）
    bidding_strategy（可选）: 出价方式，2: 手动出价，3: 自动出价-成本自动控制，7: 自动出价-成本手动控制 自动出价-成本手动控制时设置（即bidding_strategy=7）唤端场景下传7
    limit_day_budget: 预算类型，0：不限预算，1：指定预算
    campaign_day_budget（可选）: 计划日预算，单位分，范围 [10000~99999900)，>=10000, < 99999900 指定预算时设置
    optimize_target: 推广目标，0: 点击量，1: 互动量，35:APP打开，36：APP进店37：APP互动 38：APP成交43：APP打开按钮点击量 唤端只需要关注35、36、37、38和43
    constraint_type（可选）: 成本控制类型，0: 点击成本控制，1: 互动成本控制35:APP打开，36：APP进店37：APP互动 38：APP成交43：APP打开按钮点击量 唤端只需要关注35、36、37、38和43
    smart_switch（可选）: 节假日预算上浮, 0:关闭，1:开启 不限预算不支持节假日上浮(不传或传0都可）
    pacing_mode（可选）: 投放速率, 1:匀速，2:加速 不限预算可不填，默认是加速，自动出价-成本自动控制，固定匀速
    feed_flag（可选）: 搜索追投 是否开启搜索追投：（搜索推广-普通投放下，互动成本控制和手动出价下支持搜索追投功能）0：关闭1：开启
    build_type（可选）: 搭建类型 0：普通搭建 （标准搭建）1：智能搭建 （省心智投）默认为0（普通搭建），唤端下支持智能搭建
    event_asset_id（可选）: 资产id 默认0见/api/open/jg/data/event/asset/info 接口返回。这里对应返回值的event_asset_id.唤端下需要关注
    asset_event（可选）: 资产事件类型，这里和推广目标一一对应。401：APP打开（唤起）402：APP进店（唤起）403：APP互动（唤起）404：APP成交-订单数（唤起） 默认0。见/api/open/jg/data/event/asset/info 接口返回。这里对应返回值的event_type.唤端下需要关注
    asset_event_id（可选）: 资产事件id 默认0见/api/open/jg/data/event/asset/info 接口返回。这里对应返回值的event_id.唤端下需要关注
    page_category（可选）: 落地页类型 默认01：聚光落地页2：自研落地页3：原生落地页
    search_flag（可选）: 搜索快投 0：开启后关闭，1：开启
    target_extension_switch（可选）: 搜索快投定向拓展
    search_bid_ratio（可选）: 搜索快投-出价系数
    deeplink_id（可选）: deeplink链接id 唤端场景下需要
    universal_link_id（可选）: ulk的链接id 唤端场景下需要
    detect_url_link（可选）: 监测链接 唤端场景下需要关注。optimize_target如果是35、36、37、38，则必填
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "campaign_name": _parse_val_or_error(campaign_name, "campaign_name"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "enable": _parse_val_or_error(enable, "enable"),
        "time_type": _parse_val_or_error(time_type, "time_type"),
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "expire_time": _parse_val_or_error(expire_time, "expire_time"),
        "time_peroid_type": _parse_val_or_error(time_peroid_type, "time_peroid_type"),
        "time_period": _parse_val_or_error(time_period, "time_period"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "limit_day_budget": _parse_val_or_error(limit_day_budget, "limit_day_budget"),
        "campaign_day_budget": _parse_val_or_error(campaign_day_budget, "campaign_day_budget"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "constraint_type": _parse_val_or_error(constraint_type, "constraint_type"),
        "smart_switch": _parse_val_or_error(smart_switch, "smart_switch"),
        "pacing_mode": _parse_val_or_error(pacing_mode, "pacing_mode"),
        "feed_flag": _parse_val_or_error(feed_flag, "feed_flag"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "event_asset_id": _parse_val_or_error(event_asset_id, "event_asset_id"),
        "asset_event": _parse_val_or_error(asset_event, "asset_event"),
        "asset_event_id": _parse_val_or_error(asset_event_id, "asset_event_id"),
        "page_category": _parse_val_or_error(page_category, "page_category"),
        "search_flag": _parse_val_or_error(search_flag, "search_flag"),
        "target_extension_switch": _parse_val_or_error(target_extension_switch, "target_extension_switch"),
        "search_bid_ratio": _parse_val_or_error(search_bid_ratio, "search_bid_ratio"),
        "deeplink_id": _parse_val_or_error(deeplink_id, "deeplink_id"),
        "universal_link_id": _parse_val_or_error(universal_link_id, "universal_link_id"),
        "detect_url_link": _parse_val_or_error(detect_url_link, "detect_url_link"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaign_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：创建计划。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/campaign/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/campaign/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaign_list(
advertiser_id: Optional[int] = None,
campaign_ids: Optional[Union[str, List, Dict]] = None,
start_time: Optional[str] = None,
expire_time: Optional[str] = None,
status: Optional[int] = None,
creation_type: Optional[Union[str, List, Dict]] = None,
page: Optional[int] = None
) -> Dict[str, Any]:
    """查询计划（只读｜SDK campaign.List）
    端点: POST /api/open/jg/campaign/list
查询计划
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_ids（可选）: 计划ID列表 至少传一个限制单次查询计划数量，最多传20（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    start_time（可选）: 开始时间 示例：2023-09-20，和expire_time配套填写，创建时间查询范围-开始时间
    expire_time（可选）: 结束时间 示例：2023-09-21，start_time配套填写，创建时间查询范围-结束时间
    status（可选）: 创意状态 1-有效 2-暂停 3-已删除 4-计划预算不足，5-现金余额不足，7-账户日预算不足 8-处于暂停阶段
    creation_type（可选）: 创建方式过滤：0-标准投 1-简单投全自动 2-留资快投 4-简单投半自动； 不传默认查全部（2026-08-19 起，此前只回标准投）（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page（可选）: Page
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_ids": _parse_val_or_error(campaign_ids, "campaign_ids"),
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "expire_time": _parse_val_or_error(expire_time, "expire_time"),
        "status": _parse_val_or_error(status, "status"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
        "page": _parse_val_or_error(page, "page"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaign_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaign_status_update(
advertiser_id: Optional[int] = None,
campaign_ids: Optional[Union[str, List, Dict]] = None,
action_type: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """修改计划状态（写操作｜SDK campaign.StatusUpdate）
    端点: POST /api/open/jg/campaign/status/update
修改计划状态
⚠️写操作：修改计划状态。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_ids（可选）: 计划ID列表 至少传一个限制单次变更计划数量，最多传20（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    action_type（可选）: 操作类型 1：开启2：暂停3：删除
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_ids": _parse_val_or_error(campaign_ids, "campaign_ids"),
        "action_type": _parse_val_or_error(action_type, "action_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaign_status_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：修改计划状态。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/campaign/status/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/campaign/status/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/status/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaign_update(
advertiser_id: Optional[int] = None,
campaign_id: Optional[int] = None,
campaign_name: Optional[str] = None,
limit_day_budget: Optional[int] = None,
campaign_day_budget: Optional[int] = None,
smart_switch: Optional[int] = None,
time_type: Optional[int] = None,
start_time: Optional[str] = None,
expire_time: Optional[str] = None,
time_peroid_type: Optional[int] = None,
time_period: Optional[int] = None,
pacing_mode: Optional[int] = None,
feed_flag: Optional[int] = None,
bidding_strategy: Optional[int] = None,
search_flag: Optional[int] = None,
target_extension_switch: Optional[int] = None,
search_bid_ratio: Optional[float] = None,
deeplink_id: Optional[int] = None,
universal_link_id: Optional[int] = None,
detect_url_link: Optional[str] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """编辑计划（写操作｜SDK campaign.Update）
    端点: POST /api/open/jg/campaign/update
编辑计划
⚠️写操作：编辑计划。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_id（可选）: 计划ID
    campaign_name（可选）: 计划名称（长度不超过50个字符）
    limit_day_budget: 预算类型，0：不限预算，1：指定预算
    campaign_day_budget（可选）: 计划日预算，单位分，范围 [10000~99999900)，>=10000, < 99999900 指定预算时设置
    smart_switch（可选）: 节假日预算上浮, 0:关闭，1:开启 不限预算不支持节假日上浮(不传或传0都可）
    time_type: 推广时时间类型,，0:长期投放，1:自定义设置开始结束时间
    start_time（可选）: 推广开始时间，格式 yyyy-MM-dd
    expire_time（可选）: 推广结束时间，格式 yyyy-MM-dd
    time_peroid_type: 推广时段类型, 0: 全时段，1:自定义时间段
    time_period（可选）: 高级设置-自定义时间段（全时段可不传）
    pacing_mode（可选）: 投放速率, 1:匀速，2:加速 不限预算可不填，默认是加速，自动出价-成本自动控制，固定匀速
    feed_flag（可选）: 搜索追投 是否开启搜索追投：（搜索推广-普通投放下，互动成本控制和手动出价下支持搜索追投功能）0：关闭1：开启
    bidding_strategy（可选）: 出价方式，2: 手动出价，3: 自动出价-成本自动控制，7: 自动出价-成本手动控制 自动出价-成本手动控制时设置（即bidding_strategy=7）唤端场景下传7
    search_flag（可选）: 搜索快投 0：开启后关闭，1：开启
    target_extension_switch（可选）: 搜索快投定向拓展
    search_bid_ratio（可选）: 搜索快投-出价系数
    deeplink_id（可选）: deeplink链接id 唤端场景下需要
    universal_link_id（可选）: ulk的链接id 唤端场景下需要
    detect_url_link（可选）: 监测链接 唤端场景下需要关注。optimize_target如果是35、36、37、38，则必填
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_id": _parse_val_or_error(campaign_id, "campaign_id"),
        "campaign_name": _parse_val_or_error(campaign_name, "campaign_name"),
        "limit_day_budget": _parse_val_or_error(limit_day_budget, "limit_day_budget"),
        "campaign_day_budget": _parse_val_or_error(campaign_day_budget, "campaign_day_budget"),
        "smart_switch": _parse_val_or_error(smart_switch, "smart_switch"),
        "time_type": _parse_val_or_error(time_type, "time_type"),
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "expire_time": _parse_val_or_error(expire_time, "expire_time"),
        "time_peroid_type": _parse_val_or_error(time_peroid_type, "time_peroid_type"),
        "time_period": _parse_val_or_error(time_period, "time_period"),
        "pacing_mode": _parse_val_or_error(pacing_mode, "pacing_mode"),
        "feed_flag": _parse_val_or_error(feed_flag, "feed_flag"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "search_flag": _parse_val_or_error(search_flag, "search_flag"),
        "target_extension_switch": _parse_val_or_error(target_extension_switch, "target_extension_switch"),
        "search_bid_ratio": _parse_val_or_error(search_bid_ratio, "search_bid_ratio"),
        "deeplink_id": _parse_val_or_error(deeplink_id, "deeplink_id"),
        "universal_link_id": _parse_val_or_error(universal_link_id, "universal_link_id"),
        "detect_url_link": _parse_val_or_error(detect_url_link, "detect_url_link"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaign_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：编辑计划。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/campaign/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/campaign/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaigngroup_list(
advertiser_id: Optional[int] = None,
ids: Optional[Union[str, List, Dict]] = None,
name: Optional[str] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None
) -> Dict[str, Any]:
    """查询广告组列表（只读｜SDK campaigngroup.List）
    端点: POST /api/open/jg/campaign/group/base/list
查询广告组列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    ids（可选）: 广告组ID列表，name传值后ids不可传值（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    name（可选）: 广告组名称，ids传值后name不可传值
    page_num（可选）: 页码
    page_size（可选）: 页大小
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "ids": _parse_val_or_error(ids, "ids"),
        "name": _parse_val_or_error(name, "name"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaigngroup_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/group/base/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaigngroup_create(
advertiser_id: Optional[int] = None,
campaign_group_name: Optional[str] = None,
limit_day_budget: Optional[int] = None,
origin_group_day_budget: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """创建广告组（写操作｜SDK campaigngroup.Create）
    端点: POST /api/open/jg/campaign/group/create
创建广告组
⚠️写操作：创建广告组。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_group_name（可选）: 广告组名称，最多50个字符
    limit_day_budget（可选）: 是否限制预算，0-不限制，1-限制
    origin_group_day_budget（可选）: 单位分，最小值10000，最大值99999900
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_group_name": _parse_val_or_error(campaign_group_name, "campaign_group_name"),
        "limit_day_budget": _parse_val_or_error(limit_day_budget, "limit_day_budget"),
        "origin_group_day_budget": _parse_val_or_error(origin_group_day_budget, "origin_group_day_budget"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaigngroup_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：创建广告组。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/campaign/group/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/campaign/group/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/group/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaigngroup_delete(
advertiser_id: Optional[int] = None,
groups: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """删除广告组（写操作｜SDK campaigngroup.Delete）
    端点: POST /api/open/jg/campaign/group/delete
删除广告组
⚠️写操作：删除广告组。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    groups（可选）: 广告组列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "groups": _parse_val_or_error(groups, "groups"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaigngroup_delete")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：删除广告组。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/campaign/group/delete",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/campaign/group/delete",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/group/delete", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def campaigngroup_update(
advertiser_id: Optional[int] = None,
groups: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """更新广告组（写操作｜SDK campaigngroup.Update）
    端点: POST /api/open/jg/campaign/group/update
更新广告组
⚠️写操作：更新广告组。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    groups（可选）: 广告组列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "groups": _parse_val_or_error(groups, "groups"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "campaigngroup_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：更新广告组。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/campaign/group/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/campaign/group/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/campaign/group/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def wind_offline_raw(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
marketing_strategy: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None,
columns: Optional[Union[str, List, Dict]] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """note_title/note_image/note_jump_url 等强类型未覆盖字段的场景。（只读｜SDK chengfeng.OfflineRaw）
    端点: POST /api/open/wind/data/report/offline/
note_title/note_image/note_jump_url 等强类型未覆盖字段的场景。
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度： "DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    marketing_strategy（可选）: 营销诉求过滤条件： 3：商品销售日常推广 4：产品种草 8：直播推广_日常推广 9：客资收集 10：抢占赛道 14：直播推广_直播预热（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件： 0：点击量 1：互动量 3：表单提交量 4：商品成单量 5：私信咨询量 6：直播间观看量 11：商品访客量 12：落地页访问量 13：私信开口量 14：有效观看量 18：站外转化量 20：TI人群规模 21：行业商品成单 23：直播预热量 24：直播间成交 25：直播间支付ROI（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间 商品、落地页、直播间笔记只能三选一（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by) marketingTarget：营销诉求 buildType：搭建方式 placement：广告类型 optimizeTarget：推广目标 biddingStrategy：出价方式 promotionTarget：推广标的类型 jumpType：创意跳转类型 i（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_target（可选）: 营销诉求过滤条件 3-商品推广_日常推广 4-产品种草 8-直播推广_日常推广 9-客资收集 10-抢占赛道 14-直播推广_直播预告 15-商品推广_店铺拉新 16-应用推广_应用唤起 17-外溢种草（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 通用筛选条件(乘风用)。如按投放方式 deliveryMode(自定义:0/托管:1)筛选： {Column:"deliveryMode", Operator:"in", Values:[]int{1}}（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    columns（可选）: 查询指标（camelCase，如 fee / msgLeadsNum）。2026-09-20 起按需查询， 10-01 之后不传只回基础指标；各报表口可用的列见 report.Columns(gateway)， 本包 api 函数在它为空时自动补全。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creation_type（可选）: 创建方式，仅账户层级离线报表：不传只查标准投；全部 = [0,1,2,4] （实测单独传 [0] / [1] 等会被拒「创建方式参数不正确」）。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "marketing_strategy": _parse_val_or_error(marketing_strategy, "marketing_strategy"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "filters": _parse_val_or_error(filters, "filters"),
        "columns": _parse_val_or_error(columns, "columns"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "wind_offline_raw")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/wind/data/report/offline/", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_account(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
columns: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
delivery_mode_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """账户层级实时数据(返回单条汇总)。（只读｜SDK chengfeng.RealtimeAccount）
    端点: POST /api/open/wind/data/report/realtime/account
账户层级实时数据(返回单条汇总)。
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    columns（可选）: 数据指标展示列，默认只返回基础指标（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    delivery_mode_list（可选）: 投放模式过滤(仅计划层级实时支持)：自定义:0 / 托管(简单投):1（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "columns": _parse_val_or_error(columns, "columns"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "delivery_mode_list": _parse_val_or_error(delivery_mode_list, "delivery_mode_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_account")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/wind/data/report/realtime/account", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_campaign(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
columns: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
delivery_mode_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """计划层级实时数据。（只读｜SDK chengfeng.RealtimeCampaign）
    端点: POST /api/open/wind/data/report/realtime/campaign
计划层级实时数据。
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    columns（可选）: 数据指标展示列，默认只返回基础指标（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    delivery_mode_list（可选）: 投放模式过滤(仅计划层级实时支持)：自定义:0 / 托管(简单投):1（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "columns": _parse_val_or_error(columns, "columns"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "delivery_mode_list": _parse_val_or_error(delivery_mode_list, "delivery_mode_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_campaign")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/wind/data/report/realtime/campaign", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_creativity(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
columns: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
delivery_mode_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """创意层级实时数据。（只读｜SDK chengfeng.RealtimeCreativity）
    端点: POST /api/open/wind/data/report/realtime/creativity
创意层级实时数据。
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    columns（可选）: 数据指标展示列，默认只返回基础指标（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    delivery_mode_list（可选）: 投放模式过滤(仅计划层级实时支持)：自定义:0 / 托管(简单投):1（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "columns": _parse_val_or_error(columns, "columns"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "delivery_mode_list": _parse_val_or_error(delivery_mode_list, "delivery_mode_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_creativity")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/wind/data/report/realtime/creativity", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def conversion_app(
advertiser_id: Optional[int] = None,
version: Optional[str] = None,
timestamp: Optional[int] = None,
oaid_md5: Optional[str] = None,
caid_md5: Optional[str] = None,
token_code: Optional[str] = None,
event_type: Optional[int] = None,
conv_time: Optional[int] = None,
report_source: Optional[str] = None,
for_test: Optional[bool] = None,
access_token: Optional[str] = None,
sign: Optional[str] = None
) -> Dict[str, Any]:
    """APP口令码数据回传（只读｜SDK conversion.App）
    端点: POST /api/open/app
APP口令码数据回传
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    version（可选）: 接口版本, 固定为"1.0"
    timestamp（可选）: 当前时间戳, 时间戳格式，毫秒
    oaid_md5（可选）: 安卓广告标识符, 高版本，32位大写md5加密
    caid_md5（可选）: 苹果广告标识符(20230330版), 高版本，32位大写md5加密
    token_code（可选）: 口令码
    event_type（可选）: 转化事件类型id
    conv_time（可选）: 转化事件发生时间
    report_source（可选）: 数据来源
    for_test（可选）: 是否是联调环境
    access_token（可选）: access_token
    sign（可选）: 签名
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "version": _parse_val_or_error(version, "version"),
        "timestamp": _parse_val_or_error(timestamp, "timestamp"),
        "oaid_md5": _parse_val_or_error(oaid_md5, "oaid_md5"),
        "caid_md5": _parse_val_or_error(caid_md5, "caid_md5"),
        "token_code": _parse_val_or_error(token_code, "token_code"),
        "event_type": _parse_val_or_error(event_type, "event_type"),
        "conv_time": _parse_val_or_error(conv_time, "conv_time"),
        "report_source": _parse_val_or_error(report_source, "report_source"),
        "for_test": _parse_val_or_error(for_test, "for_test"),
        "access_token": _parse_val_or_error(access_token, "access_token"),
        "sign": _parse_val_or_error(sign, "sign"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "conversion_app")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/app", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def conversion_aurora_leads(
advertiser_id: Optional[int] = None,
version: Optional[str] = None,
timestamp: Optional[int] = None,
token: Optional[str] = None,
event_type: Optional[int] = None,
conv_time: Optional[int] = None,
click_id: Optional[str] = None,
access_token: Optional[str] = None,
sign: Optional[str] = None
) -> Dict[str, Any]:
    """线索转化数据回传（只读｜SDK conversion.AuroraLeads）
    端点: POST /api/open/common
线索转化数据回传
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    version（可选）: 接口版本, 固定为"1.0"
    timestamp（可选）: 当前时间戳, 时间戳格式，毫秒
    token（可选）: 转发方法, 固定为"aurora.leads" Token access_token
    event_type（可选）: 转化事件类型 id
    conv_time（可选）: 转化发生时间, 时间戳格式，毫秒
    click_id（可选）: 事件对应的click_id，同页面跳转click_id
    access_token（可选）: access_token
    sign（可选）: 签名
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "version": _parse_val_or_error(version, "version"),
        "timestamp": _parse_val_or_error(timestamp, "timestamp"),
        "token": _parse_val_or_error(token, "token"),
        "event_type": _parse_val_or_error(event_type, "event_type"),
        "conv_time": _parse_val_or_error(conv_time, "conv_time"),
        "click_id": _parse_val_or_error(click_id, "click_id"),
        "access_token": _parse_val_or_error(access_token, "access_token"),
        "sign": _parse_val_or_error(sign, "sign"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "conversion_aurora_leads")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/common", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def conversion_conversion(
app_id: Optional[str] = None,
access_token: Optional[str] = None,
event_type: Optional[int] = None,
timestamp: Optional[int] = None,
click_id: Optional[str] = None,
platform: Optional[str] = None,
context: Optional[int] = None
) -> Dict[str, Any]:
    """.数据进入您的广告模型，优化您的广告效果。（只读｜SDK conversion.Conversion）
    端点: POST /api/open/conversion
.数据进入您的广告模型，优化您的广告效果。
只读查询接口。
    参数:
    app_id（可选）: 开发组id，联系运营获取
    access_token（可选）: 开发者id对应的验证token，联系运营获取
    event_type（可选）: 事件类型
    timestamp（可选）: 事件发生时间, 时间戳格式，毫秒
    click_id（可选）: 事件对应的track_id，同页面跳转track_id，进行回传，最长不超过30位
    platform（可选）: 电商平台 京东电商平台，淘宝电商平台，客户名称+微信小程序（自定义命名，eg 小红书微信小程序） - 注意：当电商平台 = 淘宝时，订单id需要回传【子订单号】，举例：假设1个父订单内含3个子订单，则 -> 回传3个不同的「子订单号」，每个子订单对应的购买件数=1，各自对应3条gmv数据。 - 当电
    context（可选）: 转化回传上下文
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "app_id": _parse_val_or_error(app_id, "app_id"),
        "access_token": _parse_val_or_error(access_token, "access_token"),
        "event_type": _parse_val_or_error(event_type, "event_type"),
        "timestamp": _parse_val_or_error(timestamp, "timestamp"),
        "click_id": _parse_val_or_error(click_id, "click_id"),
        "platform": _parse_val_or_error(platform, "platform"),
        "context": _parse_val_or_error(context, "context"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "conversion_conversion")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/conversion", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def creativity_create(
advertiser_id: Optional[int] = None,
unit_id: Optional[int] = None,
creativity_name: Optional[str] = None,
note_id: Optional[str] = None,
click_urls: Optional[Union[str, List, Dict]] = None,
expo_urls: Optional[Union[str, List, Dict]] = None,
mask_perfer: Optional[int] = None,
title_mask_perfer: Optional[int] = None,
conversion_type: Optional[int] = None,
jump_url: Optional[str] = None,
landing_page_type: Optional[int] = None,
bar_content: Optional[str] = None,
conversion_component_types: Optional[Union[str, List, Dict]] = None,
comment: Optional[str] = None,
app_comp_icon: Optional[str] = None,
fall_back_jump_url: Optional[str] = None,
qual_info: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """创建笔记创意（写操作｜SDK creativity.Create）
    端点: POST /api/open/jg/creativity/create
创建笔记创意
⚠️写操作：创建笔记创意。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    unit_id（可选）: 单元ID
    creativity_name（可选）: 创意名称
    note_id（可选）: 笔记id
    click_urls（可选）: 点击链接, 唤端场景不传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    expo_urls（可选）: 曝光链接，唤端场景不传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    mask_perfer（可选）: 是否开启封面优选。默认0，开启传1
    title_mask_perfer（可选）: 是否开启标题优选，默认0，开启传1
    conversion_type（可选）: 组件类型，0: 无组件，2: 落地页组件，3: 私信组件，5: poi门店组件，8: 搜索组件，9: 小程序组件，10: 留资组件，11：唤端组件
    jump_url（可选）: 落地页/外链url
    landing_page_type（可选）: 落地页链接类型，1：站内落地页，2：外链
    bar_content（可选）: 按钮文案内容，包括： 落地页组件类型：立即参与、立即购买、立即领取、立即预约； 私信组件类型：立即咨询、立即参与、立即领取、立即预约； 唤端组件类型：了解详情，购买同款，领取补贴，优惠下单。 如果是搜索组件则是搜索词，1~20个字符
    conversion_component_types（可选）: 组件位置，0：默认位置，1：置顶评论 两者可以同时选择，默认位置具体为： 落地页组件的是图片底表， 私信组件的是互动胶囊， 搜索组件的是图片或视频； 底部唤端组件是互动胶囊（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    comment（可选）: 置顶评论文案 当conversion_component_types包含置顶评论时，评论文案
    app_comp_icon（可选）: 唤端下，商品主图的地址，必传
    fall_back_jump_url（可选）: 唤端下，兜底链接，必选
    qual_info（可选）: 创意对应的资质信息,信息见：/api/open/jg/data/qual/info 传了能加快审核速度
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "creativity_name": _parse_val_or_error(creativity_name, "creativity_name"),
        "note_id": _parse_val_or_error(note_id, "note_id"),
        "click_urls": _parse_val_or_error(click_urls, "click_urls"),
        "expo_urls": _parse_val_or_error(expo_urls, "expo_urls"),
        "mask_perfer": _parse_val_or_error(mask_perfer, "mask_perfer"),
        "title_mask_perfer": _parse_val_or_error(title_mask_perfer, "title_mask_perfer"),
        "conversion_type": _parse_val_or_error(conversion_type, "conversion_type"),
        "jump_url": _parse_val_or_error(jump_url, "jump_url"),
        "landing_page_type": _parse_val_or_error(landing_page_type, "landing_page_type"),
        "bar_content": _parse_val_or_error(bar_content, "bar_content"),
        "conversion_component_types": _parse_val_or_error(conversion_component_types, "conversion_component_types"),
        "comment": _parse_val_or_error(comment, "comment"),
        "app_comp_icon": _parse_val_or_error(app_comp_icon, "app_comp_icon"),
        "fall_back_jump_url": _parse_val_or_error(fall_back_jump_url, "fall_back_jump_url"),
        "qual_info": _parse_val_or_error(qual_info, "qual_info"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "creativity_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：创建笔记创意。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/creativity/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/creativity/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/creativity/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def creativity_search(
advertiser_id: Optional[int] = None,
campaign_id: Optional[int] = None,
unit_id: Optional[int] = None,
creative_ids: Optional[Union[str, List, Dict]] = None,
status: Optional[int] = None,
start_time: Optional[str] = None,
end_time: Optional[str] = None,
page: Optional[int] = None
) -> Dict[str, Any]:
    """创意查询（只读｜SDK creativity.Search）
    端点: POST /api/open/jg/creativity/search
创意查询
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_id（可选）: 计划 ID
    unit_id（可选）: 单元 ID
    creative_ids（可选）: 创意ID列表 一次查询不超过 20 个，当有创意id时会忽略其他字段（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    status（可选）: 创意状态 1 已删除2 所有未删除状态3 暂停4 已被单元暂停5 已被计划暂停8 有效9 商品状态异常10 单元未开始11 单元已结束12 单元处于暂停时段
    start_time（可选）: 开始时间	start_time 和 end_time同时传或同时不传，过滤筛选条件，格式为"yyyy-MM-dd"，参数值对应 modifier_time 信息(创意更新时间)
    end_time（可选）: 结束时间
    page（可选）: 分页
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_id": _parse_val_or_error(campaign_id, "campaign_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "creative_ids": _parse_val_or_error(creative_ids, "creative_ids"),
        "status": _parse_val_or_error(status, "status"),
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "end_time": _parse_val_or_error(end_time, "end_time"),
        "page": _parse_val_or_error(page, "page"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "creativity_search")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/creativity/search", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def creativity_status_update(
advertiser_id: Optional[int] = None,
creativity_ids: Optional[Union[str, List, Dict]] = None,
action_type: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """修改创意状态（写操作｜SDK creativity.StatusUpdate）
    端点: POST /api/open/jg/creativity/status/update
修改创意状态
⚠️写操作：修改创意状态。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    creativity_ids（可选）: 创意ID, 上限20个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    action_type（可选）: 操作类型	必填1-开启2-暂停3-删除
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "creativity_ids": _parse_val_or_error(creativity_ids, "creativity_ids"),
        "action_type": _parse_val_or_error(action_type, "action_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "creativity_status_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：修改创意状态。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/creativity/status/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/creativity/status/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/creativity/status/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def creativity_update(
advertiser_id: Optional[int] = None,
creativity_id: Optional[int] = None,
creativity_name: Optional[str] = None,
click_urls: Optional[Union[str, List, Dict]] = None,
expo_urls: Optional[Union[str, List, Dict]] = None,
mask_perfer: Optional[bool] = None,
title_mask_perfer: Optional[bool] = None,
jump_url: Optional[str] = None,
bar_content: Optional[str] = None,
item_id: Optional[str] = None,
h5_infos: Optional[Any] = None,
conversion_component_types: Optional[Union[str, List, Dict]] = None,
comment: Optional[str] = None,
h5_material_info: Optional[Any] = None,
poi_id: Optional[str] = None,
poi_jump_type: Optional[str] = None,
monitor_company: Optional[str] = None,
monitor_params: Optional[str] = None,
ad_biz_item_id: Optional[str] = None,
app_comp_icon: Optional[str] = None,
fall_back_jump_url: Optional[str] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """编辑创意（写操作｜SDK creativity.Update）
    端点: POST /api/open/jg/creativity/update
编辑创意
⚠️写操作：编辑创意。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    creativity_id（可选）: 创意ID
    creativity_name（可选）: 创意名称
    click_urls（可选）: 点击链接, 唤端场景不传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    expo_urls（可选）: 曝光链接，唤端场景不传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    mask_perfer（可选）: 是否开启封面优选。默认0，开启传1
    title_mask_perfer（可选）: 是否开启标题优选，默认0，开启传1
    jump_url（可选）: 落地页/外链url
    bar_content（可选）: 按钮文案内容，包括： 落地页组件类型：立即参与、立即购买、立即领取、立即预约； 私信组件类型：立即咨询、立即参与、立即领取、立即预约； 唤端组件类型：了解详情，购买同款，领取补贴，优惠下单。 如果是搜索组件则是搜索词，1~20个字符
    item_id（可选）: 商品id
    h5_infos（可选）: 前链h5信息（任意 JSON 值：字符串/数字/布尔/对象均可）
    conversion_component_types（可选）: 组件位置，0：默认位置，1：置顶评论 两者可以同时选择，默认位置具体为： 落地页组件的是图片底表， 私信组件的是互动胶囊， 搜索组件的是图片或视频； 底部唤端组件是互动胶囊（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    comment（可选）: 置顶评论文案 当conversion_component_types包含置顶评论时，评论文案
    h5_material_info（可选）: 程序化创意素材（任意 JSON 值：字符串/数字/布尔/对象均可）
    poi_id（可选）: poiId
    poi_jump_type（可选）: poi组件跳转类型
    monitor_company（可选）: MonitorCompany
    monitor_params（可选）: 监测参数配置
    ad_biz_item_id（可选）: 广告侧绑定商品id
    app_comp_icon（可选）: 唤端下，商品主图的地址
    fall_back_jump_url（可选）: 唤端下，兜底链接
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "creativity_id": _parse_val_or_error(creativity_id, "creativity_id"),
        "creativity_name": _parse_val_or_error(creativity_name, "creativity_name"),
        "click_urls": _parse_val_or_error(click_urls, "click_urls"),
        "expo_urls": _parse_val_or_error(expo_urls, "expo_urls"),
        "mask_perfer": _parse_val_or_error(mask_perfer, "mask_perfer"),
        "title_mask_perfer": _parse_val_or_error(title_mask_perfer, "title_mask_perfer"),
        "jump_url": _parse_val_or_error(jump_url, "jump_url"),
        "bar_content": _parse_val_or_error(bar_content, "bar_content"),
        "item_id": _parse_val_or_error(item_id, "item_id"),
        "h5_infos": _parse_val_or_error(h5_infos, "h5_infos"),
        "conversion_component_types": _parse_val_or_error(conversion_component_types, "conversion_component_types"),
        "comment": _parse_val_or_error(comment, "comment"),
        "h5_material_info": _parse_val_or_error(h5_material_info, "h5_material_info"),
        "poi_id": _parse_val_or_error(poi_id, "poi_id"),
        "poi_jump_type": _parse_val_or_error(poi_jump_type, "poi_jump_type"),
        "monitor_company": _parse_val_or_error(monitor_company, "monitor_company"),
        "monitor_params": _parse_val_or_error(monitor_params, "monitor_params"),
        "ad_biz_item_id": _parse_val_or_error(ad_biz_item_id, "ad_biz_item_id"),
        "app_comp_icon": _parse_val_or_error(app_comp_icon, "app_comp_icon"),
        "fall_back_jump_url": _parse_val_or_error(fall_back_jump_url, "fall_back_jump_url"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "creativity_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：编辑创意。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/creativity/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/creativity/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/creativity/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def crowd_estimate(
target_config: Optional[int] = None,
advertiser_id: Optional[int] = None,
marketing_target: Optional[int] = None,
placement: Optional[int] = None,
optimize_target: Optional[int] = None,
target_type: Optional[int] = None
) -> Dict[str, Any]:
    """人群预估（只读｜SDK crowd.Estimate）
    端点: POST /api/open/jg/crowd/estimate
人群预估
只读查询接口。
    参数:
    target_config（可选）: 定向配置
    advertiser_id（可选）: 广告主id
    marketing_target（可选）: 营销目标3：商品销量4：笔记种草8：直播推广9：客资收集10：抢占赛道13：种草直达14：直播预热
    placement（可选）: 广告类型1：信息流2：搜索推广4：全站智投7：视频内流
    optimize_target（可选）: 推广目标：0：点击量1：互动量3：表单提交量4：商品成单量5：私信咨询量6：直播间观看量11：商品访客量12：落地页访问量13：私信开口量14：有效观看量18：站外转化量20：TI人群规模21：行业商品成单23：直播预热量24：直播间成交25：直播间支付ROI
    target_type（可选）: 定向类型，1-通投,2-智能定向, 3-高级定向
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "target_config": _parse_val_or_error(target_config, "target_config"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "target_type": _parse_val_or_error(target_type, "target_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "crowd_estimate")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/crowd/estimate", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def data_check_name_dup(
name: Optional[Union[str, List, Dict]] = None,
advertiser_id: Optional[int] = None,
type: Optional[int] = None
) -> Dict[str, Any]:
    """计划单元名称重复性校验（只读｜SDK data.CheckNameDup）
    端点: POST /api/open/jg/data/check/name/dup
计划单元名称重复性校验
只读查询接口。
    参数:
    name（可选）: 计划名称/单元名称集合 单次查询上限100（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    advertiser_id（可选）: 广告主id
    type（可选）: 查询类型：1：计划，2：单元
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "name": _parse_val_or_error(name, "name"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "type": _parse_val_or_error(type, "type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "data_check_name_dup")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/check/name/dup", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def data_event_asset_info(
page: Optional[int] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """资产事件获取（只读｜SDK data.EventAssetInfo）
    端点: POST /api/open/jg/data/event/asset/info
资产事件获取
只读查询接口。
    参数:
    page（可选）: Page
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "page": _parse_val_or_error(page, "page"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "data_event_asset_info")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/event/asset/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def data_poi_list(
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """门店信息列表（只读｜SDK data.PoiList）
    端点: POST /api/open/jg/data/poi/list
门店信息列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "data_poi_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/poi/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def data_qual_info(
page: Optional[int] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """获取资质列表（只读｜SDK data.QualInfo）
    端点: POST /api/open/jg/data/qual/info
获取资质列表
只读查询接口。
    参数:
    page（可选）: Page
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "page": _parse_val_or_error(page, "page"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "data_qual_info")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/qual/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def directlink_create(
advertiser_id: Optional[int] = None,
direct_link_list: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """创建直达链接（写操作｜SDK directlink.Create）
    端点: POST /api/open/jg/direct-link/create
创建直达链接
⚠️写操作：创建直达链接。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    direct_link_list（可选）: 直达链接信息（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "direct_link_list": _parse_val_or_error(direct_link_list, "direct_link_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "directlink_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：创建直达链接。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/direct-link/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/direct-link/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/direct-link/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def directlink_delete(
advertiser_id: Optional[int] = None,
id: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """删除直达链接（写操作｜SDK directlink.Delete）
    端点: POST /api/open/jg/direct-link/delete
删除直达链接
⚠️写操作：删除直达链接。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    id（可选）: 直达链接ID
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "id": _parse_val_or_error(id, "id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "directlink_delete")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：删除直达链接。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/direct-link/delete",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/direct-link/delete",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/direct-link/delete", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def directlink_list(
advertiser_id: Optional[int] = None,
id: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
remark_name: Optional[str] = None,
type_str: Optional[str] = None,
status_str: Optional[str] = None
) -> Dict[str, Any]:
    """获取直达链接（只读｜SDK directlink.List）
    端点: POST /api/open/jg/direct-link/list
获取直达链接
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    id（可选）: 直达链接id
    page_num（可选）: 页码，从1开始
    page_size（可选）: 页大小，最大100
    remark_name（可选）: 备注名称，传了会模糊匹配
    type_str（可选）: 传了会按照类型查找，	1-deeplink，2-ulk
    status_str（可选）: 传了会按照状态搜索，如果想查多个状态的，用英文逗号分隔，比如：1,2	1-审核中，2-审核通过，3-审核拒绝
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "id": _parse_val_or_error(id, "id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "remark_name": _parse_val_or_error(remark_name, "remark_name"),
        "type_str": _parse_val_or_error(type_str, "type_str"),
        "status_str": _parse_val_or_error(status_str, "status_str"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "directlink_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/direct-link/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def directlink_update(
advertiser_id: Optional[int] = None,
direct_link: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """编辑直达链接（写操作｜SDK directlink.Update）
    端点: POST /api/open/jg/direct-link/update
编辑直达链接
⚠️写操作：编辑直达链接。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主id
    direct_link（可选）: 直达链接信息
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "direct_link": _parse_val_or_error(direct_link, "direct_link"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "directlink_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：编辑直达链接。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/direct-link/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/direct-link/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/direct-link/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_transfer(
user_id: Optional[str] = None,
from_wallet: Optional[int] = None,
to_wallet: Optional[int] = None,
business_no: Optional[str] = None,
request_no: Optional[str] = None,
amount: Optional[str] = None,
remark: Optional[str] = None,
part_transfer: Optional[bool] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """转账接口（写操作｜SDK finance.Transfer）
    端点: POST /api/open/finance/agent/transfer
转账接口
⚠️写操作：转账接口。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    user_id（可选）: 代理商主账号ID
    from_wallet（可选）: 转出账户
    to_wallet（可选）: 转入账户
    business_no（可选）: 业务单号，64字符，同request_no
    request_no（可选）: 请求单号，64字符，必须包含业务前缀，且每次请求重新生成，确保全局唯一
    amount（可选）: 转账金额，单位元，保留两位小数
    remark（可选）: 备注
    part_transfer（可选）: 应转尽转
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "user_id": _parse_val_or_error(user_id, "user_id"),
        "from_wallet": _parse_val_or_error(from_wallet, "from_wallet"),
        "to_wallet": _parse_val_or_error(to_wallet, "to_wallet"),
        "business_no": _parse_val_or_error(business_no, "business_no"),
        "request_no": _parse_val_or_error(request_no, "request_no"),
        "amount": _parse_val_or_error(amount, "amount"),
        "remark": _parse_val_or_error(remark, "remark"),
        "part_transfer": _parse_val_or_error(part_transfer, "part_transfer"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_transfer")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：转账接口。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/finance/agent/transfer",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/finance/agent/transfer",
        }
    payload.pop("confirm", None)
    return await call_api("/finance/agent/transfer", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_agent_balance(
user_id: Optional[str] = None,
virtual_seller_id_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """代理商主子账号余额查询（只读｜SDK finance.AgentBalance）
    端点: POST /api/open/finance/balance/query
代理商主子账号余额查询
只读查询接口。
    参数:
    user_id（可选）: 代理商主账号ID
    virtual_seller_id_list（可选）: 子账号ID/代理商vsellerId，最多传100个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "user_id": _parse_val_or_error(user_id, "user_id"),
        "virtual_seller_id_list": _parse_val_or_error(virtual_seller_id_list, "virtual_seller_id_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_agent_balance")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/finance/balance/query", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_fund_flow(
user_id: Optional[str] = None,
virtual_seller_id: Optional[str] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
page_index: Optional[int] = None,
page_size: Optional[int] = None,
date_key: Optional[int] = None,
wallet_type_list: Optional[Union[str, List, Dict]] = None,
trade_type_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """资金流水查询（只读｜SDK finance.FundFlow）
    端点: POST /api/open/finance/transaction/record/query
资金流水查询
只读查询接口。
    参数:
    user_id（可选）: 代理商主账号ID
    virtual_seller_id（可选）: 代理商/子账号vsellerId
    start_date（可选）: 起始日期，yyyy-MM-dd
    end_date（可选）: 结束日期，yyyy-MM-dd
    page_index（可选）: 页码
    page_size（可选）: 每页条数
    date_key（可选）: 1: 按投放日期拉取 2: 按扣费日期拉取
    wallet_type_list（可选）: 资金类型，CASH = 0 // 现金；CREDIT = 1 // 授信；COMPENSATION_RETURN = 4 // 赔付返货；（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    trade_type_list（可选）: 交易类型（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "user_id": _parse_val_or_error(user_id, "user_id"),
        "virtual_seller_id": _parse_val_or_error(virtual_seller_id, "virtual_seller_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "page_index": _parse_val_or_error(page_index, "page_index"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "date_key": _parse_val_or_error(date_key, "date_key"),
        "wallet_type_list": _parse_val_or_error(wallet_type_list, "wallet_type_list"),
        "trade_type_list": _parse_val_or_error(trade_type_list, "trade_type_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_fund_flow")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/finance/transaction/record/query", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_transfer_result(
user_id: Optional[str] = None,
virtual_seller_id: Optional[str] = None,
request_no: Optional[str] = None
) -> Dict[str, Any]:
    """查询转账结果接口（只读｜SDK finance.TransferResult）
    端点: POST /api/open/finance/transfer/result/query
查询转账结果接口
只读查询接口。
    参数:
    user_id（可选）: 代理商主账号ID
    virtual_seller_id（可选）: 转出账户的子账号ID/代理商vsellerId
    request_no（可选）: 调用转账接口传入的request_no
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "user_id": _parse_val_or_error(user_id, "user_id"),
        "virtual_seller_id": _parse_val_or_error(virtual_seller_id, "virtual_seller_id"),
        "request_no": _parse_val_or_error(request_no, "request_no"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_transfer_result")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/finance/transfer/result/query", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_campaign_flow(
start_time: Optional[str] = None,
end_time: Optional[str] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """获取计划流水接口（只读｜SDK finance.CampaignFlow）
    端点: POST /api/open/jg/account/ad/order/info
获取计划流水接口
只读查询接口。
    参数:
    start_time（可选）: 开始时间，格式需为yyyy-mm-dd
    end_time（可选）: 结束时间，格式需为yyyy-mm-dd
    page（可选）: 第几页
    page_size（可选）: 页大小
    advertiser_id（可选）: 品牌方ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "end_time": _parse_val_or_error(end_time, "end_time"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_campaign_flow")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/account/ad/order/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_daily_budget_balance(
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """获取账户日预算余额接口（只读｜SDK finance.DailyBudgetBalance）
    端点: POST /api/open/jg/account/budget/info
获取账户日预算余额接口
只读查询接口。
    参数:
    advertiser_id（可选）: 品牌方ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_daily_budget_balance")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/account/budget/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_update_daily_budget(
advertiser_id: Optional[int] = None,
limit_day_budget: Optional[int] = None,
account_budget: Optional[int] = None,
smart_switch: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """修改账户日预算（写操作｜SDK finance.UpdateDailyBudget）
    端点: POST /api/open/jg/account/budget/update
修改账户日预算
⚠️写操作：修改账户日预算。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 品牌方ID
    limit_day_budget（可选）: 是否限制预算，不限预算：0 指定预算：1
    account_budget（可选）: 账户日预算，单位为分，指定预算时必填
    smart_switch（可选）: 是否开启节假日上浮，关闭预算上浮：0 开启预算上浮：1 指定预算时必填
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "limit_day_budget": _parse_val_or_error(limit_day_budget, "limit_day_budget"),
        "account_budget": _parse_val_or_error(account_budget, "account_budget"),
        "smart_switch": _parse_val_or_error(smart_switch, "smart_switch"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_update_daily_budget")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：修改账户日预算。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/account/budget/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/account/budget/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/account/budget/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_account_flow(
start_time: Optional[str] = None,
end_time: Optional[str] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
advertiser_id: Optional[int] = None,
account_types: Optional[Union[str, List, Dict]] = None,
type: Optional[int] = None
) -> Dict[str, Any]:
    """获取账户流水接口（只读｜SDK finance.AccountFlow）
    端点: POST /api/open/jg/account/order/info
获取账户流水接口
只读查询接口。
    参数:
    start_time（可选）: 开始时间，格式需为yyyy-mm-dd
    end_time（可选）: 结束时间，格式需为yyyy-mm-dd
    page（可选）: 第几页
    page_size（可选）: 页大小
    advertiser_id（可选）: 品牌方ID
    account_types（可选）: 资金账户类型 0-现金 1-常规返货 2-授信 6-赔付返货 不传，默认值为[0,1,2,6]（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    type（可选）: 数据类型，账户为服务商时必传，传type=2
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "end_time": _parse_val_or_error(end_time, "end_time"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "account_types": _parse_val_or_error(account_types, "account_types"),
        "type": _parse_val_or_error(type, "type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_account_flow")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/account/order/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def finance_agent_sub_account_list(
user_id: Optional[str] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
virtual_seller_id: Optional[str] = None,
create_time_start: Optional[int] = None,
create_time_end: Optional[int] = None
) -> Dict[str, Any]:
    """获取代理商子账号列表（只读｜SDK finance.AgentSubAccountList）
    端点: POST /api/open/jg/account/sub/page
获取代理商子账号列表
只读查询接口。
    参数:
    user_id（可选）: 代理商主账号ID
    page（可选）: 第几页
    page_size（可选）: 页大小，上限500
    virtual_seller_id（可选）: 子账户ID
    create_time_start（可选）: 子账户开户开始时间，时间戳（ms）
    create_time_end（可选）: 子账户开户结束时间，时间戳（ms）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "user_id": _parse_val_or_error(user_id, "user_id"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "virtual_seller_id": _parse_val_or_error(virtual_seller_id, "virtual_seller_id"),
        "create_time_start": _parse_val_or_error(create_time_start, "create_time_start"),
        "create_time_end": _parse_val_or_error(create_time_end, "create_time_end"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "finance_agent_sub_account_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/account/sub/page", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def history_list(
advertiser_id: Optional[int] = None,
start_time: Optional[str] = None,
end_time: Optional[str] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
ids: Optional[Union[str, List, Dict]] = None,
name: Optional[str] = None,
opt_type: Optional[int] = None,
level: Optional[int] = None
) -> Dict[str, Any]:
    """历史操作记录（只读｜SDK history.List）
    端点: POST /api/open/jg/history/list
历史操作记录
只读查询接口。
    参数:
    advertiser_id（可选）: 品牌方ID
    start_time（可选）: 开始时间，格式需为yyyy-mm-dd，最早为90天前
    end_time（可选）: 结束时间，格式需为yyyy-mm-dd
    page（可选）: 第几页，默认为1
    page_size（可选）: 页大小，默认为20，最大50
    ids（可选）: 操作对象ID，仅当操作层级为计划、单元、创意、关键词时可传值 最多50个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    name（可选）: 操作对象名称
    opt_type（可选）: 操作内容，-1:全部，详见接口文档枚举说明，默认为-1
    level（可选）: 操作层级，-1:全部 0:账户 1:计划 2:单元 3:创意 4:关键词 5:定向 6:工具 7:报表 8:广告组 默认为-1
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "end_time": _parse_val_or_error(end_time, "end_time"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "ids": _parse_val_or_error(ids, "ids"),
        "name": _parse_val_or_error(name, "name"),
        "opt_type": _parse_val_or_error(opt_type, "opt_type"),
        "level": _parse_val_or_error(level, "level"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "history_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/history/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def keyword_common_recommend(
request_type: Optional[str] = None,
keyword: Optional[str] = None,
taxonomy_id: Optional[str] = None,
attribute_list: Optional[str] = None,
attribute_name_list: Optional[str] = None,
recommend_reason_filter: Optional[Union[str, List, Dict]] = None,
item_ids: Optional[Union[str, List, Dict]] = None,
advertiser_id: Optional[int] = None,
promotion_target: Optional[int] = None,
rank: Optional[int] = None
) -> Dict[str, Any]:
    """定向推词-以词推词（只读｜SDK keyword.CommonRecommend）
    端点: POST /api/open/jg/keyword/common/recommend
定向推词-以词推词
只读查询接口。
    参数:
    request_type（可选）: 推词类型 note：智能推词-笔记推词industry：行业推词search：以词推词session：上下游推词
    keyword（可选）: 以词推词(search)、上下游推词(session)必填
    taxonomy_id（可选）: 行业id,通过/api/open/jg/keyword/industry/taxonomy接口获取，行业推词下必传
    attribute_list（可选）: 行业属性列表，通过/api/open/jg/keyword/industry/taxonomy/attribute接口获取
    attribute_name_list（可选）: 行业属性名称列表，通过/api/open/jg/keyword/industry/taxonomy/attribute接口获取
    recommend_reason_filter（可选）: 智能推词-笔记推词：高点击行业推词：高点击以词推词：高点击上下游推词：上游、下游（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    item_ids（可选）: 笔记ids，智能推词-笔记推词必传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    advertiser_id（可选）: 广告主id
    promotion_target（可选）: 推广目标 智能推词-笔记推词必传 1: 笔记 2: 商品 7: 自由链接 9: 落地页 18: 直播间
    rank（可选）: 排序 1：pv降序 2：pv升序 3：竞争指数降序 4：竞争指数升序
    返回接口原始 JSON（含 code/msg/success）。"""
    # 标量字符串参数不能走 _parse_val：它会把 "search" 按逗号切成 ["search"]，
    # 后端只认字符串，收到数组直接判 request_type 不正确。
    payload: Dict[str, Any] = {
        "request_type": request_type if isinstance(request_type, str) else _parse_val_or_error(request_type, "request_type"),
        "keyword": keyword if isinstance(keyword, str) else _parse_val_or_error(keyword, "keyword"),
        "taxonomy_id": taxonomy_id if isinstance(taxonomy_id, str) else _parse_val_or_error(taxonomy_id, "taxonomy_id"),
        "attribute_list": attribute_list if isinstance(attribute_list, str) else _parse_val_or_error(attribute_list, "attribute_list"),
        "attribute_name_list": attribute_name_list if isinstance(attribute_name_list, str) else _parse_val_or_error(attribute_name_list, "attribute_name_list"),
        "recommend_reason_filter": _parse_val_or_error(recommend_reason_filter, "recommend_reason_filter"),
        "item_ids": _parse_val_or_error(item_ids, "item_ids"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "rank": _parse_val_or_error(rank, "rank"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "keyword_common_recommend")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/keyword/common/recommend", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def keyword_industry_taxonomy(
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """行业类目（只读｜SDK keyword.IndustryTaxonomy）
    端点: POST /api/open/jg/keyword/industry/taxonomy
行业类目
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "keyword_industry_taxonomy")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/keyword/industry/taxonomy", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def keyword_industry_taxonomy_attribute(
taxonomy_id: Optional[str] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """行业类目属性（只读｜SDK keyword.IndustryTaxonomyAttribute）
    端点: POST /api/open/jg/keyword/industry/taxonomy/attribute
行业类目属性
只读查询接口。
    参数:
    taxonomy_id（可选）: 行业类目id,通过/api/open/jg/keyword/industry/taxonomy获取
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "taxonomy_id": _parse_val_or_error(taxonomy_id, "taxonomy_id"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "keyword_industry_taxonomy_attribute")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/keyword/industry/taxonomy/attribute", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def keyword_word_bag_list(
name: Optional[str] = None,
category: Optional[str] = None,
start_time: Optional[str] = None,
end_time: Optional[str] = None,
advertiser_id: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None
) -> Dict[str, Any]:
    """词包推荐（只读｜SDK keyword.WordBagList）
    端点: POST /api/open/jg/keyword/word/bag/list
词包推荐
只读查询接口。
    参数:
    name（可选）: 搜索名称
    category（可选）: 状态枚举通用：通用型词包其他：通过接口/api/open/jg/keyword/industry/taxonomy获取，一级类目taxonomy_id
    start_time（可选）: 开始时间，示例："2024-02-01"
    end_time（可选）: 结束时间，示例："2024-02-01"
    advertiser_id（可选）: 广告主id
    page_num（可选）: 页数，默认10
    page_size（可选）: 页码页，默认1
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "name": _parse_val_or_error(name, "name"),
        "category": _parse_val_or_error(category, "category"),
        "start_time": _parse_val_or_error(start_time, "start_time"),
        "end_time": _parse_val_or_error(end_time, "end_time"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "keyword_word_bag_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/keyword/word/bag/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def landingpage_list(
keyword: Optional[str] = None,
advertiser_id: Optional[int] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
status: Optional[int] = None
) -> Dict[str, Any]:
    """落地页表单查询（只读｜SDK landingpage.List）
    端点: POST /api/open/jg/landing_page/list_landing_page
落地页表单查询
只读查询接口。
    参数:
    keyword（可选）: 搜索词
    advertiser_id（可选）: 广告主id
    page（可选）: 请求的页码，默认为 1
    page_size（可选）: 每页行数，默认为 10
    status（可选）: 固定传2(审核通过)
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "keyword": _parse_val_or_error(keyword, "keyword"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "status": _parse_val_or_error(status, "status"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "landingpage_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/landing_page/list_landing_page", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def material_delete_comment(
commentId: Optional[str] = None,
advertiserId: Optional[int] = None
) -> Dict[str, Any]:
    """删除广告素材评论（只读｜SDK material.DeleteComment）
    端点: POST /api/open/ad_material_note/comment/del
删除广告素材评论
只读查询接口。
    参数:
    commentId（可选）: 评论ID
    advertiserId（可选）: 广告主ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "commentId": _parse_val_or_error(commentId, "commentId"),
        "advertiserId": _parse_val_or_error(advertiserId, "advertiserId"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "material_delete_comment")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/ad_material_note/comment/del", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def material_get_comments(
pageReqDTO: Optional[int] = None,
orderClauseInfo: Optional[Union[str, List, Dict]] = None,
noteIds: Optional[Union[str, List, Dict]] = None,
content: Optional[str] = None,
commentLevel: Optional[Union[str, List, Dict]] = None,
replyStatus: Optional[Union[str, List, Dict]] = None,
createStartTime: Optional[str] = None,
createEndTime: Optional[str] = None,
includeSelfComment: Optional[bool] = None,
advertiserId: Optional[int] = None
) -> Dict[str, Any]:
    """获取广告素材评论（只读｜SDK material.GetComments）
    端点: POST /api/open/ad_material_note/comment/getlist
获取广告素材评论
只读查询接口。
    参数:
    pageReqDTO（可选）: 分页信息
    orderClauseInfo（可选）: 排序规则（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    noteIds（可选）: 笔记ID列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    content（可选）: 评论内容关键词检索
    commentLevel（可选）: 评论层级 1:一级评论 2:二级评论（回复）（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    replyStatus（可选）: 被回复状态 1:未被回复 2:已被回复（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    createStartTime（可选）: 笔记创建的查询范围开始时间 (yyyy-MM-dd格式)
    createEndTime（可选）: 笔记创建的查询范围结束时间 (yyyy-MM-dd格式)
    includeSelfComment（可选）: 是否包含作者评论，默认为否
    advertiserId（可选）: 广告主ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "pageReqDTO": _parse_val_or_error(pageReqDTO, "pageReqDTO"),
        "orderClauseInfo": _parse_val_or_error(orderClauseInfo, "orderClauseInfo"),
        "noteIds": _parse_val_or_error(noteIds, "noteIds"),
        "content": _parse_val_or_error(content, "content"),
        "commentLevel": _parse_val_or_error(commentLevel, "commentLevel"),
        "replyStatus": _parse_val_or_error(replyStatus, "replyStatus"),
        "createStartTime": _parse_val_or_error(createStartTime, "createStartTime"),
        "createEndTime": _parse_val_or_error(createEndTime, "createEndTime"),
        "includeSelfComment": _parse_val_or_error(includeSelfComment, "includeSelfComment"),
        "advertiserId": _parse_val_or_error(advertiserId, "advertiserId"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "material_get_comments")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/ad_material_note/comment/getlist", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def material_publish(
type: Optional[int] = None,
advertiserId: Optional[int] = None,
imageList: Optional[Union[str, List, Dict]] = None,
coverImage: Optional[int] = None,
video: Optional[int] = None,
content: Optional[int] = None,
tagList: Optional[Union[str, List, Dict]] = None,
userId: Optional[str] = None,
userType: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """发布广告素材（写操作｜SDK material.Publish）
    端点: POST /api/open/ad_material_note/save
发布广告素材
⚠️写操作：发布广告素材。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    type（可选）: 笔记类型：1图文，2视频
    advertiserId（可选）: 广告主ID
    imageList（可选）: 图文笔记的图片列表（图文笔记必传）（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    coverImage（可选）: 视频笔记的封面信息（视频笔记必传）
    video（可选）: 视频笔记的视频信息（视频笔记必传）
    content（可选）: 笔记的基本信息
    tagList（可选）: 笔记的话题列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    userId（可选）: 笔记作者UID(注意不是小红书号), 不传默认是品牌账号
    userType（可选）: 笔记作者类型, 1:品牌账号 2:KOS账号, 默认是品牌账号
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "type": _parse_val_or_error(type, "type"),
        "advertiserId": _parse_val_or_error(advertiserId, "advertiserId"),
        "imageList": _parse_val_or_error(imageList, "imageList"),
        "coverImage": _parse_val_or_error(coverImage, "coverImage"),
        "video": _parse_val_or_error(video, "video"),
        "content": _parse_val_or_error(content, "content"),
        "tagList": _parse_val_or_error(tagList, "tagList"),
        "userId": _parse_val_or_error(userId, "userId"),
        "userType": _parse_val_or_error(userType, "userType"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "material_publish")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：发布广告素材。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/ad_material_note/save",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/ad_material_note/save",
        }
    payload.pop("confirm", None)
    return await call_api("/ad_material_note/save", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def material_creative_info(
material_info_dtos: Optional[Union[str, List, Dict]] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """创意标题和图片信息（只读｜SDK material.CreativeInfo）
    端点: POST /api/open/jg/material/prefer/info
创意标题和图片信息
只读查询接口。
    参数:
    material_info_dtos（可选）: 查询物料信息（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "material_info_dtos": _parse_val_or_error(material_info_dtos, "material_info_dtos"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "material_creative_info")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/material/prefer/info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def negativekeyword_batch_add(
advertiser_id: Optional[int] = None,
unit_id: Optional[int] = None,
keywords: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """批量添加否定词（写操作｜SDK negativekeyword.BatchAdd）
    端点: POST /api/open/jg/negative/keyword/batch/add
批量添加否定词
⚠️写操作：批量添加否定词。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    unit_id（可选）: 单元ID
    keywords（可选）: 否定词列表，同一个单元下精确匹配和短语匹配的否定词的个数分别最多为200个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "keywords": _parse_val_or_error(keywords, "keywords"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "negativekeyword_batch_add")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：批量添加否定词。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/negative/keyword/batch/add",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/negative/keyword/batch/add",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/negative/keyword/batch/add", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def negativekeyword_batch_delete(
advertiser_id: Optional[int] = None,
unit_id: Optional[int] = None,
negative_keyword_ids: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """批量删除否定词（写操作｜SDK negativekeyword.BatchDelete）
    端点: POST /api/open/jg/negative/keyword/batch/delete
批量删除否定词
⚠️写操作：批量删除否定词。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    unit_id（可选）: 单元ID
    negative_keyword_ids（可选）: 否定词id列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "negative_keyword_ids": _parse_val_or_error(negative_keyword_ids, "negative_keyword_ids"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "negativekeyword_batch_delete")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：批量删除否定词。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/negative/keyword/batch/delete",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/negative/keyword/batch/delete",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/negative/keyword/batch/delete", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def negativekeyword_list(
advertiser_id: Optional[int] = None,
unit_id: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None
) -> Dict[str, Any]:
    """查询否定词列表（只读｜SDK negativekeyword.List）
    端点: POST /api/open/jg/negative/keyword/list
查询否定词列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    unit_id（可选）: 单元ID
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "negativekeyword_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/negative/keyword/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def newcreate_create(
advertiser_id: Optional[int] = None,
create_type: Optional[int] = None,
create_cascade_info_list: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """新创编（级联创建计划/单元/创意）（写操作｜SDK newcreate.Create）
    端点: POST /api/open/jg/cascade/create
新创编（级联创建计划/单元/创意）
⚠️写操作：新创编（级联创建计划/单元/创意）。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    create_type（可选）: 创建类型，1-创建三层、2-在已有计划下创建单元+创意、3-在已有单元下创建创意，默认1
    create_cascade_info_list（可选）: 新创编数据（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "create_type": _parse_val_or_error(create_type, "create_type"),
        "create_cascade_info_list": _parse_val_or_error(create_cascade_info_list, "create_cascade_info_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "newcreate_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：新创编（级联创建计划/单元/创意）。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/cascade/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/cascade/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/cascade/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def newcreate_update(
advertiser_id: Optional[int] = None,
modify_type: Optional[int] = None,
mod_cascade_info_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """新创编编辑（目前只支持产品种草营销诉求）（只读｜SDK newcreate.Update）
    端点: POST /api/open/jg/cascade/modify
新创编编辑（目前只支持产品种草营销诉求）
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    modify_type（可选）: 编辑类型，1-编辑计划、2-编辑单元、3-编辑创意
    mod_cascade_info_list（可选）: 新创编数据（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "modify_type": _parse_val_or_error(modify_type, "modify_type"),
        "mod_cascade_info_list": _parse_val_or_error(mod_cascade_info_list, "mod_cascade_info_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "newcreate_update")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/cascade/modify", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def note_delete(
advertiser_id: Optional[int] = None,
note_id: Optional[str] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """删除笔记（写操作｜SDK note.Delete）
    端点: POST /api/open/jg/note/delete
删除笔记
⚠️写操作：删除笔记。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    note_id（可选）: 笔记ID
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "note_id": _parse_val_or_error(note_id, "note_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "note_delete")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：删除笔记。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/note/delete",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/note/delete",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/note/delete", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def note_list(
advertiser_id: Optional[int] = None,
note_type: Optional[int] = None,
keyword: Optional[str] = None,
order_field: Optional[str] = None,
order_type: Optional[str] = None,
note_content_type: Optional[int] = None,
placement_type: Optional[int] = None,
spu_id: Optional[str] = None,
filter_taobao: Optional[int] = None,
market_target: Optional[int] = None,
spu_type: Optional[int] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
base_only: Optional[bool] = None,
create_start_time: Optional[str] = None,
create_end_time: Optional[str] = None,
update_start_time: Optional[str] = None,
update_end_time: Optional[str] = None
) -> Dict[str, Any]:
    """获取笔记列表（只读｜SDK note.List）
    端点: POST /api/open/jg/note/list
获取笔记列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    note_type（可选）: 笔记类型 1：我的笔记 2：合作笔记 4：主理人笔记 6:员工笔记 11：授权笔记 12:素材笔记 13:合作码笔记（参数已传13系统自动转换为14，后续合作码笔记传14） 14:合作码笔记
    keyword（可选）: 搜索关键词 笔记id或者笔记名称，传多个笔记id时以','分隔，最大数量不超过100
    order_field（可选）: 排序字段，可选 阅读数:read_count 互动数:interact_count 阅读率:read_rate 互动率:interact_rate 创建时间:create_time
    order_type（可选）: 升降序 正排:asc 倒排:desc 默认desc
    note_content_type（可选）: 1：图文笔记 2：视频笔记
    placement_type（可选）: 推广场景：1：信息流推广 2：搜索推广 3：开屏推广 4：全站智投 7：视频内流
    spu_id（可选）: spu_id（白名单支持）
    filter_taobao（可选）: 是否只展示小红星笔记 0:展示所有 1:仅小红星
    market_target（可选）: 营销诉求 4：产品种草 9：客资收集 16：应用换端
    spu_type（可选）: 1：spu 2：非标品 3：品牌推广（白名单支持）
    page（可选）: 请求的页码，默认为1
    page_size（可选）: 每页行数，默认为20，最大100
    base_only（可选）: 是否只取笔记基本信息，开启后只拉取笔记基本信息不拉取指标信息，默认为false
    create_start_time（可选）: 笔记创建的查询范围开始时间 (yyyy-MM-dd格式，例：2025-10-20)
    create_end_time（可选）: 笔记创建的查询范围结束时间 (yyyy-MM-dd格式，例：2025-10-21)
    update_start_time（可选）: 笔记更新的查询范围开始时间 (我的笔记、合作码和广告素材不支持更新时间字段筛选)
    update_end_time（可选）: 笔记更新的查询范围结束时间 (我的笔记、合作码和广告素材不支持更新时间字段筛选)
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "note_type": _parse_val_or_error(note_type, "note_type"),
        "keyword": _parse_val_or_error(keyword, "keyword"),
        "order_field": _parse_val_or_error(order_field, "order_field"),
        "order_type": _parse_val_or_error(order_type, "order_type"),
        "note_content_type": _parse_val_or_error(note_content_type, "note_content_type"),
        "placement_type": _parse_val_or_error(placement_type, "placement_type"),
        "spu_id": _parse_val_or_error(spu_id, "spu_id"),
        "filter_taobao": _parse_val_or_error(filter_taobao, "filter_taobao"),
        "market_target": _parse_val_or_error(market_target, "market_target"),
        "spu_type": _parse_val_or_error(spu_type, "spu_type"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "base_only": _parse_val_or_error(base_only, "base_only"),
        "create_start_time": _parse_val_or_error(create_start_time, "create_start_time"),
        "create_end_time": _parse_val_or_error(create_end_time, "create_end_time"),
        "update_start_time": _parse_val_or_error(update_start_time, "update_start_time"),
        "update_end_time": _parse_val_or_error(update_end_time, "update_end_time"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "note_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/note/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def note_query_id(
temporary_id: Optional[str] = None
) -> Dict[str, Any]:
    """获取笔记ID（只读｜SDK note.QueryID）
    端点: POST /api/open/jg/noteid/query
获取笔记ID
只读查询接口。
    参数:
    temporary_id（可选）: 临时笔记ID
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "temporary_id": _parse_val_or_error(temporary_id, "temporary_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "note_query_id")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/noteid/query", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def oauth_access_token(
auth_code: Optional[str] = None,
redirect_uri: str = "http://localhost/oauth/callback"
) -> Dict[str, Any]:
    """auth_code，请求小红书服务器，获取 access_token 和 refresh_token 及当前账户的广告主 ID。（只读｜SDK oauth.AccessToken）
    端点: POST /api/open/oauth2/access_token
auth_code，请求小红书服务器，获取 access_token 和 refresh_token 及当前账户的广告主 ID。
只读查询接口。
    参数:
    auth_code（可选）: 授权时返回的 auth_code
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "secret": os.getenv("XHS_SECRET"),
        "auth_code": _parse_val_or_error(auth_code, "auth_code"),
        "redirect_uri": redirect_uri,
    }
    app_id_raw = os.getenv("XHS_APP_ID", "")
    if app_id_raw.isdigit():
        payload["app_id"] = int(app_id_raw)
    else:
        payload["app_id"] = app_id_raw or None
    if not payload.get("app_id") or not payload.get("secret"):
        return {"error": "缺少 XHS_APP_ID / XHS_SECRET（.env 或环境变量）"}
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "oauth_access_token")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    data = await call_api(
        "/oauth2/access_token", {k: v for k, v in payload.items() if v is not None}, auth=False
    )
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
async def oauth_refresh_token(
refresh_token: Optional[str] = None
) -> Dict[str, Any]:
    """，刷新 access_token 和 refresh_token 及 token 过期时间。（只读｜SDK oauth.RefreshToken）
    端点: POST /api/open/oauth2/refresh_token
，刷新 access_token 和 refresh_token 及 token 过期时间。
只读查询接口。
    参数:
    refresh_token（可选）: 最近一次小红书返回的 refresh_token
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "refresh_token": _parse_val_or_error(refresh_token, "refresh_token"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "oauth_refresh_token")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/oauth2/refresh_token", {k: v for k, v in payload.items() if v is not None}, auth=False)


@mcp.tool()
async def report_offline_account(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
marketing_strategy: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None,
columns: Optional[Union[str, List, Dict]] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """账户层级离线数据（只读｜SDK offline.Advertiser）
    端点: POST /api/open/jg/data/report/offline/account
账户层级离线数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度： "DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    marketing_strategy（可选）: 营销诉求过滤条件： 3：商品销售日常推广 4：产品种草 8：直播推广_日常推广 9：客资收集 10：抢占赛道 14：直播推广_直播预热（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件： 0：点击量 1：互动量 3：表单提交量 4：商品成单量 5：私信咨询量 6：直播间观看量 11：商品访客量 12：落地页访问量 13：私信开口量 14：有效观看量 18：站外转化量 20：TI人群规模 21：行业商品成单 23：直播预热量 24：直播间成交 25：直播间支付ROI（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间 商品、落地页、直播间笔记只能三选一（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by) marketingTarget：营销诉求 buildType：搭建方式 placement：广告类型 optimizeTarget：推广目标 biddingStrategy：出价方式 promotionTarget：推广标的类型 jumpType：创意跳转类型 i（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_target（可选）: 营销诉求过滤条件 3-商品推广_日常推广 4-产品种草 8-直播推广_日常推广 9-客资收集 10-抢占赛道 14-直播推广_直播预告 15-商品推广_店铺拉新 16-应用推广_应用唤起 17-外溢种草（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 通用筛选条件(乘风用)。如按投放方式 deliveryMode(自定义:0/托管:1)筛选： {Column:"deliveryMode", Operator:"in", Values:[]int{1}}（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    columns（可选）: 查询指标（camelCase，如 fee / msgLeadsNum）。2026-09-20 起按需查询， 10-01 之后不传只回基础指标；各报表口可用的列见 report.Columns(gateway)， 本包 api 函数在它为空时自动补全。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creation_type（可选）: 创建方式，仅账户层级离线报表：不传只查标准投；全部 = [0,1,2,4] （实测单独传 [0] / [1] 等会被拒「创建方式参数不正确」）。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "marketing_strategy": _parse_val_or_error(marketing_strategy, "marketing_strategy"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "filters": _parse_val_or_error(filters, "filters"),
        "columns": _parse_val_or_error(columns, "columns"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_account")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/account", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_campaign(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
marketing_strategy: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None,
columns: Optional[Union[str, List, Dict]] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """广告计划层级离线数据（只读｜SDK offline.Campaign）
    端点: POST /api/open/jg/data/report/offline/campaign
广告计划层级离线数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度： "DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    marketing_strategy（可选）: 营销诉求过滤条件： 3：商品销售日常推广 4：产品种草 8：直播推广_日常推广 9：客资收集 10：抢占赛道 14：直播推广_直播预热（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件： 0：点击量 1：互动量 3：表单提交量 4：商品成单量 5：私信咨询量 6：直播间观看量 11：商品访客量 12：落地页访问量 13：私信开口量 14：有效观看量 18：站外转化量 20：TI人群规模 21：行业商品成单 23：直播预热量 24：直播间成交 25：直播间支付ROI（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间 商品、落地页、直播间笔记只能三选一（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by) marketingTarget：营销诉求 buildType：搭建方式 placement：广告类型 optimizeTarget：推广目标 biddingStrategy：出价方式 promotionTarget：推广标的类型 jumpType：创意跳转类型 i（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_target（可选）: 营销诉求过滤条件 3-商品推广_日常推广 4-产品种草 8-直播推广_日常推广 9-客资收集 10-抢占赛道 14-直播推广_直播预告 15-商品推广_店铺拉新 16-应用推广_应用唤起 17-外溢种草（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 通用筛选条件(乘风用)。如按投放方式 deliveryMode(自定义:0/托管:1)筛选： {Column:"deliveryMode", Operator:"in", Values:[]int{1}}（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    columns（可选）: 查询指标（camelCase，如 fee / msgLeadsNum）。2026-09-20 起按需查询， 10-01 之后不传只回基础指标；各报表口可用的列见 report.Columns(gateway)， 本包 api 函数在它为空时自动补全。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creation_type（可选）: 创建方式，仅账户层级离线报表：不传只查标准投；全部 = [0,1,2,4] （实测单独传 [0] / [1] 等会被拒「创建方式参数不正确」）。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "marketing_strategy": _parse_val_or_error(marketing_strategy, "marketing_strategy"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "filters": _parse_val_or_error(filters, "filters"),
        "columns": _parse_val_or_error(columns, "columns"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_campaign")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/campaign", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_creative(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
marketing_strategy: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None,
columns: Optional[Union[str, List, Dict]] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """广告创意层级离线数据。官方路径是 .../offline/creative，旧写法 .../creativity 上游回 404。（只读｜SDK offline.Creativity）
    端点: POST /api/open/jg/data/report/offline/creative
    ⚠️ 路径陷阱：广告创意层级离线数据。官方路径是 .../offline/creative，旧写法 .../creativity 上游回 404。
广告创意层级离线数据。官方路径是 .../offline/creative，旧写法 .../creativity 上游回 404。
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度： "DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    marketing_strategy（可选）: 营销诉求过滤条件： 3：商品销售日常推广 4：产品种草 8：直播推广_日常推广 9：客资收集 10：抢占赛道 14：直播推广_直播预热（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件： 0：点击量 1：互动量 3：表单提交量 4：商品成单量 5：私信咨询量 6：直播间观看量 11：商品访客量 12：落地页访问量 13：私信开口量 14：有效观看量 18：站外转化量 20：TI人群规模 21：行业商品成单 23：直播预热量 24：直播间成交 25：直播间支付ROI（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间 商品、落地页、直播间笔记只能三选一（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by) marketingTarget：营销诉求 buildType：搭建方式 placement：广告类型 optimizeTarget：推广目标 biddingStrategy：出价方式 promotionTarget：推广标的类型 jumpType：创意跳转类型 i（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_target（可选）: 营销诉求过滤条件 3-商品推广_日常推广 4-产品种草 8-直播推广_日常推广 9-客资收集 10-抢占赛道 14-直播推广_直播预告 15-商品推广_店铺拉新 16-应用推广_应用唤起 17-外溢种草（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 通用筛选条件(乘风用)。如按投放方式 deliveryMode(自定义:0/托管:1)筛选： {Column:"deliveryMode", Operator:"in", Values:[]int{1}}（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    columns（可选）: 查询指标（camelCase，如 fee / msgLeadsNum）。2026-09-20 起按需查询， 10-01 之后不传只回基础指标；各报表口可用的列见 report.Columns(gateway)， 本包 api 函数在它为空时自动补全。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creation_type（可选）: 创建方式，仅账户层级离线报表：不传只查标准投；全部 = [0,1,2,4] （实测单独传 [0] / [1] 等会被拒「创建方式参数不正确」）。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "marketing_strategy": _parse_val_or_error(marketing_strategy, "marketing_strategy"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "filters": _parse_val_or_error(filters, "filters"),
        "columns": _parse_val_or_error(columns, "columns"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_creative")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/creative", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_keyword(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
marketing_strategy: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None,
columns: Optional[Union[str, List, Dict]] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """关键词层级离线数据（只读｜SDK offline.Keyword）
    端点: POST /api/open/jg/data/report/offline/keyword
关键词层级离线数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度： "DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    marketing_strategy（可选）: 营销诉求过滤条件： 3：商品销售日常推广 4：产品种草 8：直播推广_日常推广 9：客资收集 10：抢占赛道 14：直播推广_直播预热（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件： 0：点击量 1：互动量 3：表单提交量 4：商品成单量 5：私信咨询量 6：直播间观看量 11：商品访客量 12：落地页访问量 13：私信开口量 14：有效观看量 18：站外转化量 20：TI人群规模 21：行业商品成单 23：直播预热量 24：直播间成交 25：直播间支付ROI（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间 商品、落地页、直播间笔记只能三选一（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by) marketingTarget：营销诉求 buildType：搭建方式 placement：广告类型 optimizeTarget：推广目标 biddingStrategy：出价方式 promotionTarget：推广标的类型 jumpType：创意跳转类型 i（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_target（可选）: 营销诉求过滤条件 3-商品推广_日常推广 4-产品种草 8-直播推广_日常推广 9-客资收集 10-抢占赛道 14-直播推广_直播预告 15-商品推广_店铺拉新 16-应用推广_应用唤起 17-外溢种草（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 通用筛选条件(乘风用)。如按投放方式 deliveryMode(自定义:0/托管:1)筛选： {Column:"deliveryMode", Operator:"in", Values:[]int{1}}（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    columns（可选）: 查询指标（camelCase，如 fee / msgLeadsNum）。2026-09-20 起按需查询， 10-01 之后不传只回基础指标；各报表口可用的列见 report.Columns(gateway)， 本包 api 函数在它为空时自动补全。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creation_type（可选）: 创建方式，仅账户层级离线报表：不传只查标准投；全部 = [0,1,2,4] （实测单独传 [0] / [1] 等会被拒「创建方式参数不正确」）。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "marketing_strategy": _parse_val_or_error(marketing_strategy, "marketing_strategy"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "filters": _parse_val_or_error(filters, "filters"),
        "columns": _parse_val_or_error(columns, "columns"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_keyword")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/keyword", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_unit(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
marketing_strategy: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
filters: Optional[Union[str, List, Dict]] = None,
columns: Optional[Union[str, List, Dict]] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """广告单元层级离线数据（只读｜SDK offline.Unit）
    端点: POST /api/open/jg/data/report/offline/unit
广告单元层级离线数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度： "DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    marketing_strategy（可选）: 营销诉求过滤条件： 3：商品销售日常推广 4：产品种草 8：直播推广_日常推广 9：客资收集 10：抢占赛道 14：直播推广_直播预热（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件： 0：点击量 1：互动量 3：表单提交量 4：商品成单量 5：私信咨询量 6：直播间观看量 11：商品访客量 12：落地页访问量 13：私信开口量 14：有效观看量 18：站外转化量 20：TI人群规模 21：行业商品成单 23：直播预热量 24：直播间成交 25：直播间支付ROI（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间 商品、落地页、直播间笔记只能三选一（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by) marketingTarget：营销诉求 buildType：搭建方式 placement：广告类型 optimizeTarget：推广目标 biddingStrategy：出价方式 promotionTarget：推广标的类型 jumpType：创意跳转类型 i（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_target（可选）: 营销诉求过滤条件 3-商品推广_日常推广 4-产品种草 8-直播推广_日常推广 9-客资收集 10-抢占赛道 14-直播推广_直播预告 15-商品推广_店铺拉新 16-应用推广_应用唤起 17-外溢种草（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filters（可选）: 通用筛选条件(乘风用)。如按投放方式 deliveryMode(自定义:0/托管:1)筛选： {Column:"deliveryMode", Operator:"in", Values:[]int{1}}（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    columns（可选）: 查询指标（camelCase，如 fee / msgLeadsNum）。2026-09-20 起按需查询， 10-01 之后不传只回基础指标；各报表口可用的列见 report.Columns(gateway)， 本包 api 函数在它为空时自动补全。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creation_type（可选）: 创建方式，仅账户层级离线报表：不传只查标准投；全部 = [0,1,2,4] （实测单独传 [0] / [1] 等会被拒「创建方式参数不正确」）。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "marketing_strategy": _parse_val_or_error(marketing_strategy, "marketing_strategy"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "filters": _parse_val_or_error(filters, "filters"),
        "columns": _parse_val_or_error(columns, "columns"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_unit")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/unit", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_account_2(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
columns: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """账户层级实时数据（只读｜SDK realtime.Advertiser）
    端点: POST /api/open/jg/data/report/realtime/account
账户层级实时数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    columns（可选）: 查询指标（camelCase），为空时本包 api 函数按 report.Columns(gateway) 补全（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "columns": _parse_val_or_error(columns, "columns"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_account_2")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/account", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_campaign_2(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
market_targeting_list: Optional[Union[str, List, Dict]] = None,
campaign_filter_state: Optional[int] = None,
campaign_create_begin_time: Optional[str] = None,
campaign_create_end_time: Optional[str] = None,
placement_list: Optional[Union[str, List, Dict]] = None,
limit_day_budget_list: Optional[Union[str, List, Dict]] = None,
optimize_target_list: Optional[Union[str, List, Dict]] = None,
build_type_list: Optional[Union[str, List, Dict]] = None,
bidding_strategy_list: Optional[Union[str, List, Dict]] = None,
constraint_type_list: Optional[Union[str, List, Dict]] = None,
promotion_target_list: Optional[Union[str, List, Dict]] = None,
combine_audit_status: Optional[int] = None,
migrate_status_list: Optional[Union[str, List, Dict]] = None,
name: Optional[str] = None,
id: Optional[int] = None,
columns: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """计划层级实时数据（只读｜SDK realtime.Campaign）
    端点: POST /api/open/jg/data/report/realtime/campaign
计划层级实时数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    market_targeting_list（可选）: 营销诉求筛选，3：商品销量_日常推广告，4：产品种草，8：直播推广_日常推广，9：客资收集，10：抢占赛道，14：直播推广_直播预热，15：商品销量_店铺拉新（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    campaign_filter_state（可选）: 计划状态过滤，1：有效，2：暂停，4：计划预算不足，7：账户日预算不足，5：现金余额不足，8：处于暂停时段，3：已删除，6：所有未删除状态
    campaign_create_begin_time（可选）: 计划创建时间范围的开始
    campaign_create_end_time（可选）: 计划创建时间范围的结束
    placement_list（可选）: 广告类型：1：信息流广告，2：搜索广告，4：全站智投，7：视频流广告（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    limit_day_budget_list（可选）: 预算类型：0：不限预算，1：指定预算（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target_list（可选）: 推广目标：0：点击量，1：互动量，16：种草值，11：商品访客量，12：落地页访问量，3：表单提交量，4：商品成单量，5：私信咨询量，6：观看量，13：私信开口量，14：有效观看量，17：ROI，站外转化量，20：TI人群规模（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type_list（可选）: 搭建方式：0：标准投放，1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy_list（可选）: 出价方式：2：手动出价，101: 自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    constraint_type_list（可选）: 成本控制方式：-1: 无，101: 自动控制，0: 点击成本控制，1: 互动成本控制，3: 表单提交成本控制，5: 私信咨询成本控制，11: 访客成本控制，13: 私信开口成本控制，14: 有效观播成本控制，17: ROI控制，23: 预热成本控制，50: 私信留资成本控制（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target_list（可选）: 投放标的类型：1: 笔记，2: 商品，7: 外链落地页，9: 落地页，18: 直播间（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    combine_audit_status（可选）: 创意审核状态，1：审核拒绝，2：审核中，3：审核通过，4：审核通过（私密）
    migrate_status_list（可选）: 计划迁移状态，0：非迁移计划，2：迁移计划（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    name（可选）: 搜索计划名称
    id（可选）: 搜索计划id
    columns（可选）: 查询指标（camelCase），为空时本包 api 函数按 report.Columns(gateway) 补全（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "market_targeting_list": _parse_val_or_error(market_targeting_list, "market_targeting_list"),
        "campaign_filter_state": _parse_val_or_error(campaign_filter_state, "campaign_filter_state"),
        "campaign_create_begin_time": _parse_val_or_error(campaign_create_begin_time, "campaign_create_begin_time"),
        "campaign_create_end_time": _parse_val_or_error(campaign_create_end_time, "campaign_create_end_time"),
        "placement_list": _parse_val_or_error(placement_list, "placement_list"),
        "limit_day_budget_list": _parse_val_or_error(limit_day_budget_list, "limit_day_budget_list"),
        "optimize_target_list": _parse_val_or_error(optimize_target_list, "optimize_target_list"),
        "build_type_list": _parse_val_or_error(build_type_list, "build_type_list"),
        "bidding_strategy_list": _parse_val_or_error(bidding_strategy_list, "bidding_strategy_list"),
        "constraint_type_list": _parse_val_or_error(constraint_type_list, "constraint_type_list"),
        "promotion_target_list": _parse_val_or_error(promotion_target_list, "promotion_target_list"),
        "combine_audit_status": _parse_val_or_error(combine_audit_status, "combine_audit_status"),
        "migrate_status_list": _parse_val_or_error(migrate_status_list, "migrate_status_list"),
        "name": _parse_val_or_error(name, "name"),
        "id": _parse_val_or_error(id, "id"),
        "columns": _parse_val_or_error(columns, "columns"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_campaign_2")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/campaign", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_creativity_2(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
placement_list: Optional[Union[str, List, Dict]] = None,
creativity_filter_state: Optional[int] = None,
creativity_create_begin_time: Optional[str] = None,
creativity_create_end_time: Optional[str] = None,
conversion_type: Optional[int] = None,
programmatic_list: Optional[Union[str, List, Dict]] = None,
creativity_audit_status: Optional[Union[str, List, Dict]] = None,
name: Optional[str] = None,
id: Optional[int] = None,
columns: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """创意层级实时数据（只读｜SDK realtime.Creativity）
    端点: POST /api/open/jg/data/report/realtime/creativity
创意层级实时数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    placement_list（可选）: 广告类型：1：信息流广告，2：搜索广告，4：全站智投，7：视频流广告（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creativity_filter_state（可选）: 创意状态过滤，8：有效，3：暂停，9：商品状态异常，4：已被单元暂停，10：单元未开始，11：单元已结束，12：单元处于暂停时段，5：已被计划暂停，13：计划预算不足，16：账户日预算不足，14：现金余额不足，1：已删除，2：所有未删除状态，
    creativity_create_begin_time（可选）: 创意创建开始时间
    creativity_create_end_time（可选）: 创意创建结束时间
    conversion_type（可选）: 创意类型：30：商品，20：落地页，4：直播间笔记，7：直播间，0：笔记（无组件），1：笔记（商品组件），2：笔记（落地页组件）
    programmatic_list（可选）: 创意组合方式，0：自定义创意，1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    creativity_audit_status（可选）: 创意审核状态，1：审核拒绝，2：审核中，3：审核通过，4：审核通过（私密）（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    name（可选）: 搜索创意名称
    id（可选）: 创意ID
    columns（可选）: 查询指标（camelCase），为空时本包 api 函数按 report.Columns(gateway) 补全（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "placement_list": _parse_val_or_error(placement_list, "placement_list"),
        "creativity_filter_state": _parse_val_or_error(creativity_filter_state, "creativity_filter_state"),
        "creativity_create_begin_time": _parse_val_or_error(creativity_create_begin_time, "creativity_create_begin_time"),
        "creativity_create_end_time": _parse_val_or_error(creativity_create_end_time, "creativity_create_end_time"),
        "conversion_type": _parse_val_or_error(conversion_type, "conversion_type"),
        "programmatic_list": _parse_val_or_error(programmatic_list, "programmatic_list"),
        "creativity_audit_status": _parse_val_or_error(creativity_audit_status, "creativity_audit_status"),
        "name": _parse_val_or_error(name, "name"),
        "id": _parse_val_or_error(id, "id"),
        "columns": _parse_val_or_error(columns, "columns"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_creativity_2")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/creativity", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_keyword(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
keyword_filter_state: Optional[int] = None,
user_bid_strategy: Optional[int] = None,
keyword_name: Optional[str] = None,
campaign_name: Optional[str] = None,
unit_name: Optional[str] = None,
columns: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """关键词层级实时数据（只读｜SDK realtime.Keyword）
    端点: POST /api/open/jg/data/report/realtime/keyword
关键词层级实时数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    keyword_filter_state（可选）: 关键词状态过滤2：删除3：暂停4：已被单元暂停5：已被计划暂停6：现金余额不足7：计划预算不足8：有效9：计划未开始10：计划已结束11：计划处于暂停阶段12：账户日预算不足
    user_bid_strategy（可选）: 出价策略：0：未使用出价策略1：已使用出价策略
    keyword_name（可选）: 搜索关键词名词
    campaign_name（可选）: 搜索计划名称
    unit_name（可选）: 搜索单元名称
    columns（可选）: 查询指标（camelCase），为空时本包 api 函数按 report.Columns(gateway) 补全（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "keyword_filter_state": _parse_val_or_error(keyword_filter_state, "keyword_filter_state"),
        "user_bid_strategy": _parse_val_or_error(user_bid_strategy, "user_bid_strategy"),
        "keyword_name": _parse_val_or_error(keyword_name, "keyword_name"),
        "campaign_name": _parse_val_or_error(campaign_name, "campaign_name"),
        "unit_name": _parse_val_or_error(unit_name, "unit_name"),
        "columns": _parse_val_or_error(columns, "columns"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_keyword")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/keyword", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_unit_2(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
market_targeting_list: Optional[Union[str, List, Dict]] = None,
unit_filter_state: Optional[int] = None,
unit_create_begin_time: Optional[str] = None,
unit_create_end_time: Optional[str] = None,
placement_list: Optional[Union[str, List, Dict]] = None,
bidding_strategy_list: Optional[Union[str, List, Dict]] = None,
promotion_target_list: Optional[Union[str, List, Dict]] = None,
combine_audit_status: Optional[int] = None,
name: Optional[str] = None,
id: Optional[int] = None,
columns: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """单元层级实时数据（只读｜SDK realtime.Unit）
    端点: POST /api/open/jg/data/report/realtime/unit
单元层级实时数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大1000
    market_targeting_list（可选）: 营销诉求筛选，3：商品销量_日常推广告，4：产品种草，8：直播推广_日常推广，9：客资收集，10：抢占赛道，14：直播推广_直播预热，15：商品销量_店铺拉新（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    unit_filter_state（可选）: 单元状态过滤，10：有效，4：暂停，2：未开始，3： 已结束，5：处于暂停时段，6：已被计划暂停，8：计划预算不足，11：账户日预算不足，7：现金余额不足，1：已删除，9：所有未删除状态
    unit_create_begin_time（可选）: 单元创建时间范围的开始
    unit_create_end_time（可选）: 单元创建时间范围的结束
    placement_list（可选）: 广告类型：1：信息流广告，2：搜索广告，4：全站智投，7：视频流广告（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy_list（可选）: 出价方式：2：手动出价，101: 自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target_list（可选）: 投放标的类型：1: 笔记，2: 商品，7: 外链落地页，9: 落地页，18: 直播间（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    combine_audit_status（可选）: 创意审核状态，1：审核拒绝，2：审核中，3：审核通过，4：审核通过（私密）
    name（可选）: 搜索单元名称
    id（可选）: 单元ID
    columns（可选）: 查询指标（camelCase），为空时本包 api 函数按 report.Columns(gateway) 补全（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "market_targeting_list": _parse_val_or_error(market_targeting_list, "market_targeting_list"),
        "unit_filter_state": _parse_val_or_error(unit_filter_state, "unit_filter_state"),
        "unit_create_begin_time": _parse_val_or_error(unit_create_begin_time, "unit_create_begin_time"),
        "unit_create_end_time": _parse_val_or_error(unit_create_end_time, "unit_create_end_time"),
        "placement_list": _parse_val_or_error(placement_list, "placement_list"),
        "bidding_strategy_list": _parse_val_or_error(bidding_strategy_list, "bidding_strategy_list"),
        "promotion_target_list": _parse_val_or_error(promotion_target_list, "promotion_target_list"),
        "combine_audit_status": _parse_val_or_error(combine_audit_status, "combine_audit_status"),
        "name": _parse_val_or_error(name, "name"),
        "id": _parse_val_or_error(id, "id"),
        "columns": _parse_val_or_error(columns, "columns"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_unit_2")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/unit", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_note(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
delivery_mode: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
data_caliber: Optional[int] = None,
filters: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """笔记层级离线报表数据（只读｜SDK reportoffline2.Note）
    端点: POST /api/open/jg/data/report/offline/note
笔记层级离线报表数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度："DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    marketing_target（可选）: 营销目标过滤条件（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价 3：自动出价 4：MCB 7：OCPX（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流 2：搜索 4：全站智投 7：视频流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 7：外链落地页 9：落地页 18：直播间 19：不限（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    delivery_mode（可选）: 投放模式过滤条件 0：手动投放 1：自动投放（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(相当于group by)（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大500
    data_caliber（可选）: 数据指标归因时间类型 0-点击时间 1-转化时间
    filters（可选）: 过滤条件（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "delivery_mode": _parse_val_or_error(delivery_mode, "delivery_mode"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "filters": _parse_val_or_error(filters, "filters"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_note")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/note", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_search(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
marketing_target: Optional[Union[str, List, Dict]] = None,
bidding_strategy: Optional[Union[str, List, Dict]] = None,
optimize_target: Optional[Union[str, List, Dict]] = None,
placement: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[Union[str, List, Dict]] = None,
programmatic: Optional[Union[str, List, Dict]] = None,
build_type: Optional[Union[str, List, Dict]] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
data_caliber: Optional[int] = None
) -> Dict[str, Any]:
    """搜索词层级离线报表数据（只读｜SDK reportoffline2.SearchWord）
    端点: POST /api/open/jg/data/report/offline/search/word
搜索词层级离线报表数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度："DAY"：分天 "HOUR"：分时 "SUMMARY"：汇总,默认分天
    marketing_target（可选）: 营销目标过滤条件（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    bidding_strategy（可选）: 出价方式过滤条件：2：手动出价 3：自动出价（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_target（可选）: 推广目标过滤条件（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    placement（可选）: 广告类型过滤条件 1：信息流推广 2：搜索推广 4：全站智投 7：视频内流（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的类型过滤条件 1：笔记 2：商品 9：落地页 18：直播间（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    programmatic（可选）: 创意组合方式过滤条件 0：自定义创意 1：程序化创意（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    build_type（可选）: 搭建方式过滤条件 0：标准搭建 1：省心智投（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大500
    data_caliber（可选）: 数据指标归因时间类型 0-计费时间 1-转化时间
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "bidding_strategy": _parse_val_or_error(bidding_strategy, "bidding_strategy"),
        "optimize_target": _parse_val_or_error(optimize_target, "optimize_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "programmatic": _parse_val_or_error(programmatic, "programmatic"),
        "build_type": _parse_val_or_error(build_type, "build_type"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_search")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/search/word", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_spu(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None
) -> Dict[str, Any]:
    """SPU层级离线报表数据（只读｜SDK reportoffline2.SPU）
    端点: POST /api/open/jg/data/report/offline/spu
SPU层级离线报表数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度："DAY"：分天 "SUMMARY"：汇总,默认分天
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大500
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_spu")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/spu", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_target(
advertiser_id: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
sort_column: Optional[str] = None,
sort: Optional[int] = None,
name: Optional[str] = None,
marketing_target_list: Optional[Union[str, List, Dict]] = None,
need_hourly_data: Optional[bool] = None
) -> Dict[str, Any]:
    """定向层级实时数据（只读｜SDK reportrealtime2.Target）
    端点: POST /api/open/jg/data/report/realtime/target
定向层级实时数据
只读查询接口。
    参数:
    advertiser_id: 广告主ID
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20,最大100
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    sort_column（可选）: 排序字段见附录column字段
    sort（可选）: 升降序asc：升序desc：降序
    name（可选）: 搜索定向名称
    marketing_target_list（可选）: 营销目标过滤条件（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    need_hourly_data（可选）: 是否拉取小时数据，默认为 false; 只支持拉取今日数据
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "sort_column": _parse_val_or_error(sort_column, "sort_column"),
        "sort": _parse_val_or_error(sort, "sort"),
        "name": _parse_val_or_error(name, "name"),
        "marketing_target_list": _parse_val_or_error(marketing_target_list, "marketing_target_list"),
        "need_hourly_data": _parse_val_or_error(need_hourly_data, "need_hourly_data"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_target")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/target", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def series_create(
advertiser_id: Optional[int] = None,
episodes: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """剧集创建（写操作｜SDK series.Create）
    端点: POST /api/open/jg/data/episodes/create
剧集创建
⚠️写操作：剧集创建。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主/企业账户ID
    episodes（可选）: 剧集信息数组，可批量创建（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "episodes": _parse_val_or_error(episodes, "episodes"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "series_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：剧集创建。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/data/episodes/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/data/episodes/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/data/episodes/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def series_list(
advertiser_id: Optional[int] = None,
type: Optional[int] = None,
ids: Optional[Union[str, List, Dict]] = None,
name: Optional[str] = None,
pageNum: Optional[int] = None,
pageSize: Optional[int] = None
) -> Dict[str, Any]:
    """可投剧集列表（只读｜SDK series.List）
    端点: POST /api/open/jg/data/episodes/list
可投剧集列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    type（可选）: 剧集形态（1=小说 2=短剧 3=漫剧）
    ids（可选）: 剧集ID集合，精确查询，单次最多20个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    name（可选）: 剧集名称，支持模糊查询
    pageNum（可选）: 页码，从1开始
    pageSize（可选）: 每页数量
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "type": _parse_val_or_error(type, "type"),
        "ids": _parse_val_or_error(ids, "ids"),
        "name": _parse_val_or_error(name, "name"),
        "pageNum": _parse_val_or_error(pageNum, "pageNum"),
        "pageSize": _parse_val_or_error(pageSize, "pageSize"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "series_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/episodes/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def series_update(
advertiser_id: Optional[int] = None,
episodes: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """剧集修改（写操作｜SDK series.Update）
    端点: POST /api/open/jg/data/episodes/update
剧集修改
⚠️写操作：剧集修改。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主/企业账户ID
    episodes（可选）: 待更新的剧集信息数组（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "episodes": _parse_val_or_error(episodes, "episodes"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "series_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：剧集修改。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/data/episodes/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/data/episodes/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/data/episodes/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_easy(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
campaign_ids: Optional[Union[str, List, Dict]] = None,
marketing_scene: Optional[Union[str, List, Dict]] = None,
optimize_objective: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
data_caliber: Optional[int] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """简单投计划报表（离线）（只读｜SDK simpledelivery.CampaignReport）
    端点: POST /api/open/jg/data/report/offline/easy/promotion/base
简单投计划报表（离线）
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度，DAY/HOUR/WEEK/MONTH/SUMMARY，默认分天
    campaign_ids（可选）: 标的ID，最多100个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_scene（可选）: 营销场景过滤条件，1-产品种草、2-客资收集、3-种草直达-CID、4-种草直达-UD、5-应用推广（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_objective（可选）: 优化目标过滤条件，当 marketing_scene 不为空时必须为空（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(group by)，noteId/countryName/city/gender/age/keyword（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大500
    data_caliber（可选）: 数据指标归因时间类型，0-计费时间、1-转化时间，默认计费时间
    creation_type（可选）: 托管模式，1-全自动、4-半自动，默认查全部（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "campaign_ids": _parse_val_or_error(campaign_ids, "campaign_ids"),
        "marketing_scene": _parse_val_or_error(marketing_scene, "marketing_scene"),
        "optimize_objective": _parse_val_or_error(optimize_objective, "optimize_objective"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_easy")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/easy/promotion/base", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_easy_2(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
creation_type: Optional[Union[str, List, Dict]] = None,
marketing_scene: Optional[Union[str, List, Dict]] = None,
optimize_objective: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
data_caliber: Optional[int] = None
) -> Dict[str, Any]:
    """简单投标的报表（离线）（只读｜SDK simpledelivery.TargetReport）
    端点: POST /api/open/jg/data/report/offline/easy/promotion/group
简单投标的报表（离线）
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度，DAY/HOUR/WEEK/MONTH/SUMMARY，默认分天
    creation_type（可选）: 投放模式，1-全自动、4-半自动（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    marketing_scene（可选）: 营销场景过滤条件，1-产品种草、2-客资收集、3-种草直达-CID、4-种草直达-UD、5-应用推广（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    optimize_objective（可选）: 优化目标过滤条件，当 marketing_scene 不为空时必须为空（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(group by)，noteId/campaignId/countryName/city/gender/age/keyword（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大500
    data_caliber（可选）: 数据指标归因时间类型，0-计费时间、1-转化时间，默认计费时间
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
        "marketing_scene": _parse_val_or_error(marketing_scene, "marketing_scene"),
        "optimize_objective": _parse_val_or_error(optimize_objective, "optimize_objective"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_easy_2")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/easy/promotion/group", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_offline_easy_3(
advertiser_id: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
time_unit: Optional[int] = None,
note_ids: Optional[Union[str, List, Dict]] = None,
split_columns: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
data_caliber: Optional[int] = None,
creation_type: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """简单投笔记报表（离线）（只读｜SDK simpledelivery.NoteReport）
    端点: POST /api/open/jg/data/report/offline/easy/promotion/note
简单投笔记报表（离线）
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    time_unit（可选）: 时间维度，DAY/HOUR/WEEK/MONTH/SUMMARY，默认分天
    note_ids（可选）: 笔记ID列表，最多100个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    split_columns（可选）: 细分条件(group by)，campaignId/keyword/campaignGroupId（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大500
    data_caliber（可选）: 数据指标归因时间类型，0-计费时间、1-转化时间，默认计费时间
    creation_type（可选）: 托管模式，1-全自动、4-半自动，默认查全部（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "time_unit": _parse_val_or_error(time_unit, "time_unit"),
        "note_ids": _parse_val_or_error(note_ids, "note_ids"),
        "split_columns": _parse_val_or_error(split_columns, "split_columns"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "creation_type": _parse_val_or_error(creation_type, "creation_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_offline_easy_3")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/offline/easy/promotion/note", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_ube(
advertiser_id: Optional[int] = None,
campaign_group_id_list: Optional[Union[str, List, Dict]] = None,
id: Optional[int] = None,
name: Optional[str] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
data_caliber: Optional[int] = None,
campaign_filter_state_list: Optional[Union[str, List, Dict]] = None,
combine_audit_status: Optional[int] = None
) -> Dict[str, Any]:
    """简单投计划层级实时数据（只读｜SDK simpledelivery.CampaignRealtime）
    端点: POST /api/open/jg/data/report/realtime/ube/campaign
简单投计划层级实时数据
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_group_id_list（可选）: 广告组ID，必传且只能传一个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    id（可选）: 计划ID，根据计划ID查询时其它筛选条件无效
    name（可选）: 计划名称，根据计划名查询时其它筛选条件无效
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大100
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    data_caliber（可选）: 数据指标归因时间类型，0-计费时间、1-转化时间
    campaign_filter_state_list（可选）: 计划状态，见枚举说明（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    combine_audit_status（可选）: 审核状态，1-部分审核拒绝、2-部分审核中、3-审核通过、4-审核通过（私密）、99-不满足审核条件
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_group_id_list": _parse_val_or_error(campaign_group_id_list, "campaign_group_id_list"),
        "id": _parse_val_or_error(id, "id"),
        "name": _parse_val_or_error(name, "name"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "campaign_filter_state_list": _parse_val_or_error(campaign_filter_state_list, "campaign_filter_state_list"),
        "combine_audit_status": _parse_val_or_error(combine_audit_status, "combine_audit_status"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_ube")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/ube/campaign", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_ube_2(
advertiser_id: Optional[int] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
data_caliber: Optional[int] = None,
columns: Optional[Union[str, List, Dict]] = None,
filter: Optional[int] = None,
marketing_target_list: Optional[Union[str, List, Dict]] = None,
group_type_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """简单投标的层级实时数据（只读｜SDK simpledelivery.TargetRealtime）
    端点: POST /api/open/jg/data/report/realtime/ube/group
简单投标的层级实时数据
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大200
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    data_caliber（可选）: 数据指标归因时间类型，0-点击时间、1-转化时间
    columns（可选）: 数据指标展示列，传驼峰式的字段名（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    filter（可选）: 筛选项
    marketing_target_list（可选）: 营销诉求，4-产品种草、9-客资收集、13-种草直达、16-应用唤起、20-应用下载、21-小程序推广（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    group_type_list（可选）: 标的类型，1-全自动托管、4-半自动托管（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "columns": _parse_val_or_error(columns, "columns"),
        "filter": _parse_val_or_error(filter, "filter"),
        "marketing_target_list": _parse_val_or_error(marketing_target_list, "marketing_target_list"),
        "group_type_list": _parse_val_or_error(group_type_list, "group_type_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_ube_2")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/ube/group", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_ube_3(
advertiser_id: Optional[int] = None,
campaign_group_id_list: Optional[Union[str, List, Dict]] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
data_caliber: Optional[int] = None,
keyword_filter_state: Optional[int] = None,
phrase_match_type: Optional[int] = None,
keyword_name: Optional[str] = None,
match_type: Optional[int] = None
) -> Dict[str, Any]:
    """简单投关键词层级实时数据（只读｜SDK simpledelivery.KeywordRealtime）
    端点: POST /api/open/jg/data/report/realtime/ube/keyword
简单投关键词层级实时数据
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_group_id_list（可选）: 广告组ID，必传且只能传一个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大100
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    data_caliber（可选）: 数据指标归因时间类型，0-计费时间、1-转化时间
    keyword_filter_state（可选）: 关键词状态，见枚举说明
    phrase_match_type（可选）: 关键词匹配类型，0-精准匹配、1-短语匹配
    keyword_name（可选）: 关键词
    match_type（可选）: 搜索匹配类型，与 keyword_name 配合，0-包含、1-等于
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_group_id_list": _parse_val_or_error(campaign_group_id_list, "campaign_group_id_list"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "keyword_filter_state": _parse_val_or_error(keyword_filter_state, "keyword_filter_state"),
        "phrase_match_type": _parse_val_or_error(phrase_match_type, "phrase_match_type"),
        "keyword_name": _parse_val_or_error(keyword_name, "keyword_name"),
        "match_type": _parse_val_or_error(match_type, "match_type"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_ube_3")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/ube/keyword", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def report_realtime_ube_4(
advertiser_id: Optional[int] = None,
campaign_group_id_list: Optional[Union[str, List, Dict]] = None,
note_id: Optional[str] = None,
page_num: Optional[int] = None,
page_size: Optional[int] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
data_caliber: Optional[int] = None,
creativity_filter_state: Optional[int] = None,
creativity_audit_state: Optional[int] = None
) -> Dict[str, Any]:
    """简单投笔记层级实时数据（只读｜SDK simpledelivery.NoteRealtime）
    端点: POST /api/open/jg/data/report/realtime/ube/note
简单投笔记层级实时数据
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_group_id_list（可选）: 广告组ID，必传且只能传一个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    note_id（可选）: 笔记ID，根据笔记ID查询时其它筛选条件无效
    page_num（可选）: 页数，默认1
    page_size（可选）: 页大小，默认20，最大100
    start_date（可选）: 开始时间，格式 yyyy-MM-dd
    end_date（可选）: 结束时间，格式 yyyy-MM-dd
    data_caliber（可选）: 数据指标归因时间类型，0-计费时间、1-转化时间
    creativity_filter_state（可选）: 笔记状态，见枚举说明
    creativity_audit_state（可选）: 笔记审核状态，1-审核拒绝、2-审核中、3-审核通过、4-审核通过（私密）、99-不满足审核条件
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_group_id_list": _parse_val_or_error(campaign_group_id_list, "campaign_group_id_list"),
        "note_id": _parse_val_or_error(note_id, "note_id"),
        "page_num": _parse_val_or_error(page_num, "page_num"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "data_caliber": _parse_val_or_error(data_caliber, "data_caliber"),
        "creativity_filter_state": _parse_val_or_error(creativity_filter_state, "creativity_filter_state"),
        "creativity_audit_state": _parse_val_or_error(creativity_audit_state, "creativity_audit_state"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "report_realtime_ube_4")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/data/report/realtime/ube/note", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def ube_ube_extra_query(
advertiser_id: Optional[int] = None,
campaign_group_id_list: Optional[Union[str, List, Dict]] = None
) -> Dict[str, Any]:
    """批量查询简单投标的ID（只读｜SDK simpledelivery.BatchQueryTargetID）
    端点: POST /api/open/jg/ube/extra/query
批量查询简单投标的ID
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_group_id_list（可选）: 广告组ID列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_group_id_list": _parse_val_or_error(campaign_group_id_list, "campaign_group_id_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "ube_ube_extra_query")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/ube/extra/query", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def ube_semi_auto_create(
advertiser_id: Optional[int] = None,
base_config: Optional[int] = None,
target_config: Optional[int] = None,
creativity_config: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """新建简单投（写操作｜SDK simpledelivery.Create）
    端点: POST /api/open/jg/ube/semi/auto/create
新建简单投
⚠️写操作：新建简单投。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    base_config（可选）: 计划
    target_config（可选）: 定向
    creativity_config（可选）: 创意
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "base_config": _parse_val_or_error(base_config, "base_config"),
        "target_config": _parse_val_or_error(target_config, "target_config"),
        "creativity_config": _parse_val_or_error(creativity_config, "creativity_config"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "ube_semi_auto_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：新建简单投。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/ube/semi/auto/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/ube/semi/auto/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/ube/semi/auto/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def spu_list(
keyword: Optional[str] = None,
advertiser_id: Optional[int] = None,
page: Optional[int] = None,
page_size: Optional[int] = None,
can_bind: Optional[bool] = None
) -> Dict[str, Any]:
    """获取spu列表（只读｜SDK spu.List）
    端点: POST /api/open/jg/spu/list
获取spu列表
只读查询接口。
    参数:
    keyword（可选）: 搜索词
    advertiser_id（可选）: 广告主id
    page（可选）: 请求的页码，默认为 1
    page_size（可选）: 每页行数，默认为 10
    can_bind（可选）: 是否可以绑定
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "keyword": _parse_val_or_error(keyword, "keyword"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
        "can_bind": _parse_val_or_error(can_bind, "can_bind"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "spu_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/spu/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def target_get_available_target_info(
advertiser_id: Optional[int] = None,
marketing_target: Optional[int] = None
) -> Dict[str, Any]:
    """获取定向信息（只读｜SDK target.GetAvailableTargetInfo）
    端点: POST /api/open/jg/target/get_available_target_info
获取定向信息
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    marketing_target（可选）: 营销目标 (第一期只支持4) 旧计划 OLD = 0, 应用下载 APP = 1, 销售线索 CLUE = 2, 商品推广 ITEM = 3, 笔记推广 NOTE = 4, 私信营销 MESSAGE = 5, 直播推广 LIVE_BROCAST = 8, 客资收集 USER_DATA_COLLECT
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "target_get_available_target_info")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/target/get_available_target_info", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def target_keyword_match(
keywords: Optional[Union[str, List, Dict]] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """获取关键词匹配词库信息（只读｜SDK target.KeywordMatch）
    端点: POST /api/open/jg/target/keyword/match
获取关键词匹配词库信息
只读查询接口。
    参数:
    keywords（可选）: 关键词列表 不能超过150个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "keywords": _parse_val_or_error(keywords, "keywords"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "target_keyword_match")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/target/keyword/match", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def target_keyword_recommend(
keyword: Optional[str] = None,
note_ids: Optional[Union[str, List, Dict]] = None,
advertiser_id: Optional[int] = None
) -> Dict[str, Any]:
    """获取推荐关键词信息（只读｜SDK target.KeywordRecommend）
    端点: POST /api/open/jg/target/keyword/recommend
获取推荐关键词信息
只读查询接口。
    参数:
    keyword（可选）: 搜索词
    note_ids（可选）: 笔记Id列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    advertiser_id（可选）: 广告主id
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "keyword": _parse_val_or_error(keyword, "keyword"),
        "note_ids": _parse_val_or_error(note_ids, "note_ids"),
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "target_keyword_recommend")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/target/keyword/recommend", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def targettemplate_apply(
advertiser_id: Optional[int] = None,
target_template_id: Optional[int] = None,
unit_ids: Optional[Union[str, List, Dict]] = None,
action: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """定向包关联单元（写操作｜SDK targettemplate.Apply）
    端点: POST /api/open/jg/target/template/apply
定向包关联单元
⚠️写操作：定向包关联单元。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主id
    target_template_id（可选）: 定向包id
    unit_ids（可选）: 单元 id 列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    action（可选）: 关联：1 取消关联：2
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "target_template_id": _parse_val_or_error(target_template_id, "target_template_id"),
        "unit_ids": _parse_val_or_error(unit_ids, "unit_ids"),
        "action": _parse_val_or_error(action, "action"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "targettemplate_apply")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：定向包关联单元。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/target/template/apply",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/target/template/apply",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/target/template/apply", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def targettemplate_create(
advertiser_id: Optional[int] = None,
name: Optional[str] = None,
desc: Optional[str] = None,
target_type: Optional[int] = None,
target_config: Optional[int] = None,
marketing_target: Optional[int] = None,
placement: Optional[int] = None,
delivery_mode: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """创建定向包（写操作｜SDK targettemplate.Create）
    端点: POST /api/open/jg/target/template/create
创建定向包
⚠️写操作：创建定向包。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    name（可选）: 定向包名称，最多20个字符
    desc（可选）: 定向包描述，最多50个字符
    target_type（可选）: 定向类型，1-通投,2-智能定向, 3-高级定向
    target_config（可选）: 定向配置
    marketing_target（可选）: 营销诉求
    placement（可选）: 广告类型 1-信息流2-搜索推广4-全站智投7-视频内流
    delivery_mode（可选）: 投放模式 0：手动投放，1：自动投放
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "name": _parse_val_or_error(name, "name"),
        "desc": _parse_val_or_error(desc, "desc"),
        "target_type": _parse_val_or_error(target_type, "target_type"),
        "target_config": _parse_val_or_error(target_config, "target_config"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "delivery_mode": _parse_val_or_error(delivery_mode, "delivery_mode"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "targettemplate_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：创建定向包。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/target/template/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/target/template/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/target/template/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def targettemplate_delete(
advertiser_id: Optional[int] = None,
template_ids: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """删除定向包（写操作｜SDK targettemplate.Delete）
    端点: POST /api/open/jg/target/template/delete
删除定向包
⚠️写操作：删除定向包。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主id
    template_ids（可选）: 定向包id列表，最多5个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "template_ids": _parse_val_or_error(template_ids, "template_ids"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "targettemplate_delete")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：删除定向包。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/target/template/delete",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/target/template/delete",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/target/template/delete", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def targettemplate_list(
advertiser_id: Optional[int] = None,
target_template_id: Optional[int] = None,
marketing_target: Optional[int] = None,
placement: Optional[int] = None,
page: Optional[int] = None,
page_size: Optional[int] = None
) -> Dict[str, Any]:
    """获取定向包列表（只读｜SDK targettemplate.List）
    端点: POST /api/open/jg/target/template/query
获取定向包列表
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    target_template_id（可选）: 定向包id，当根据定向包ID查询时，其他入参无效
    marketing_target（可选）: 营销诉求
    placement（可选）: 广告类型 1-信息流 2-搜索推广 4-全站智投 7-视频内流
    page（可选）: 请求的页码数，默认1
    page_size（可选）: 请求的每页行数，默认20，最大100
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "target_template_id": _parse_val_or_error(target_template_id, "target_template_id"),
        "marketing_target": _parse_val_or_error(marketing_target, "marketing_target"),
        "placement": _parse_val_or_error(placement, "placement"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "targettemplate_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/target/template/query", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def targettemplate_update(
advertiser_id: Optional[int] = None,
template_list: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """更新定向包（写操作｜SDK targettemplate.Update）
    端点: POST /api/open/jg/target/template/update
更新定向包
⚠️写操作：更新定向包。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    template_list（可选）: 定向包列表，目前只支持传一个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "template_list": _parse_val_or_error(template_list, "template_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "targettemplate_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：更新定向包。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/target/template/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/target/template/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/target/template/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def unit_update_bid(
advertiser_id: Optional[int] = None,
event_bid_list: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """修改单元出价（写操作｜SDK unit.UpdateBid）
    端点: POST /api/open/jg/unit/batch/update/bid
修改单元出价
⚠️写操作：修改单元出价。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主id
    event_bid_list（可选）: 调价单元列表，最多100个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "event_bid_list": _parse_val_or_error(event_bid_list, "event_bid_list"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "unit_update_bid")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：修改单元出价。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/unit/batch/update/bid",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/unit/batch/update/bid",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/unit/batch/update/bid", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def unit_create(
advertiser_id: Optional[int] = None,
campaign_id: Optional[int] = None,
unit_name: Optional[str] = None,
event_bid: Optional[int] = None,
note_ids: Optional[Union[str, List, Dict]] = None,
promotion_target: Optional[int] = None,
target_type: Optional[int] = None,
target_config: Optional[int] = None,
keyword_target_period: Optional[int] = None,
keyword_target_action: Optional[Union[str, List, Dict]] = None,
business_tree_name: Optional[str] = None,
spu_note_info: Optional[Union[str, List, Dict]] = None,
keyword_with_bid: Optional[Union[str, List, Dict]] = None,
substituted_user_id: Optional[str] = None,
keyword_gen_type: Optional[int] = None,
page_id: Optional[str] = None,
landing_page_url: Optional[str] = None,
unit_external_page_url: Optional[str] = None,
unit_landing_page_desc: Optional[str] = None,
target_template_id: Optional[str] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """创建单元（写操作｜SDK unit.Create）
    端点: POST /api/open/jg/unit/create
创建单元
⚠️写操作：创建单元。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    campaign_id（可选）: 计划ID
    unit_name（可选）: 单元名称
    event_bid（可选）: 出价/目标成本，单位分，自动控制不需要传
    note_ids（可选）: 标的-笔记id(帮助定向推荐，创意里的笔记会单独填写)非种草人群规模、深度种草人群规模下必填（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    promotion_target（可选）: 推广标的（笔记1）
    target_type（可选）: 定向类型，1-通投,2-智能定向, 3-高级定向
    target_config（可选）: 定向配置
    keyword_target_period（可选）: 关键词时间周期，单位天，枚举包括 3，7，15，30
    keyword_target_action（可选）: 关键词目标行为 1: 搜索，2: 互动，3: 阅读（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    business_tree_name（可选）: 推广业务信息示例：生活服务>婚纱摄影;美妆个护;母婴>母婴食品>奶粉具体参看/api/open/jg/keyword/industry/taxonomy接口返回词。
    spu_note_info（可选）: spu&笔记标的信息推广目标是种草人群规模、深度种草人群规模下必传。spu只能一个，至少绑定5篇笔记，最多50(api限制)只能选择合作笔记与我的笔记，笔记违规不能选，spu审核不通过也可以选，选择的笔记一定是绑定在该spu上。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    keyword_with_bid（可选）: 关键词，通过(关键词词包)/api/open/jg/keyword/word/bag/list (智能推词、行业推词、以词推词)/api/open/jg/keyword/common/recommend 接口获取搜索推广-标准投放下必传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    substituted_user_id（可选）: 代投账号b的userId，代投笔记与其他笔记互斥,，需要校验是否有代投账号权限
    keyword_gen_type（可选）: 单元选词方式： -1:无意义默认值 0:手动选词 1:智能拓词 2:手动+智能 关键词定向且在白名单中才支持
    page_id（可选）: 落地页ID，聚光落地页下必填
    landing_page_url（可选）: 落地页Url，自研落地页下必填
    unit_external_page_url（可选）: 外链Url，标的是外链落地页时必填
    unit_landing_page_desc（可选）: 落地页表单描述
    target_template_id（可选）: 定向包id
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_id": _parse_val_or_error(campaign_id, "campaign_id"),
        "unit_name": _parse_val_or_error(unit_name, "unit_name"),
        "event_bid": _parse_val_or_error(event_bid, "event_bid"),
        "note_ids": _parse_val_or_error(note_ids, "note_ids"),
        "promotion_target": _parse_val_or_error(promotion_target, "promotion_target"),
        "target_type": _parse_val_or_error(target_type, "target_type"),
        "target_config": _parse_val_or_error(target_config, "target_config"),
        "keyword_target_period": _parse_val_or_error(keyword_target_period, "keyword_target_period"),
        "keyword_target_action": _parse_val_or_error(keyword_target_action, "keyword_target_action"),
        "business_tree_name": _parse_val_or_error(business_tree_name, "business_tree_name"),
        "spu_note_info": _parse_val_or_error(spu_note_info, "spu_note_info"),
        "keyword_with_bid": _parse_val_or_error(keyword_with_bid, "keyword_with_bid"),
        "substituted_user_id": _parse_val_or_error(substituted_user_id, "substituted_user_id"),
        "keyword_gen_type": _parse_val_or_error(keyword_gen_type, "keyword_gen_type"),
        "page_id": _parse_val_or_error(page_id, "page_id"),
        "landing_page_url": _parse_val_or_error(landing_page_url, "landing_page_url"),
        "unit_external_page_url": _parse_val_or_error(unit_external_page_url, "unit_external_page_url"),
        "unit_landing_page_desc": _parse_val_or_error(unit_landing_page_desc, "unit_landing_page_desc"),
        "target_template_id": _parse_val_or_error(target_template_id, "target_template_id"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "unit_create")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：创建单元。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/unit/create",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/unit/create",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/unit/create", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def unit_add_keyword(
advertiser_id: Optional[int] = None,
unit_id: Optional[int] = None,
add_type: Optional[int] = None,
phrase_match_type_upgrade: Optional[int] = None,
keyword_with_bid: Optional[Union[str, List, Dict]] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """修改单元关键词（写操作｜SDK unit.AddKeyword）
    端点: POST /api/open/jg/unit/keyword/add
修改单元关键词
⚠️写操作：修改单元关键词。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主id
    unit_id（可选）: 单元id
    add_type（可选）: 添加关键词的方式 0-如果已有词不包括本次添加的词，则将原来已有词删除、1-只是进行添加操作，不删除 默认值0 指针：0 是「替换」1 是「追加」，两者后果差别很大，一律显式传
    phrase_match_type_upgrade（可选）: 关键词匹配方式升级开关(精确匹配->精确包含) 0-关闭、1-开启、默认值-1
    keyword_with_bid（可选）: 关键词列表（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "add_type": _parse_val_or_error(add_type, "add_type"),
        "phrase_match_type_upgrade": _parse_val_or_error(phrase_match_type_upgrade, "phrase_match_type_upgrade"),
        "keyword_with_bid": _parse_val_or_error(keyword_with_bid, "keyword_with_bid"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "unit_add_keyword")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：修改单元关键词。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/unit/keyword/add",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/unit/keyword/add",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/unit/keyword/add", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def unit_list(
advertiser_id: Optional[int] = None,
campaign_id: Optional[int] = None,
unit_ids: Optional[Union[str, List, Dict]] = None,
status: Optional[int] = None,
unit_name: Optional[str] = None,
start_date: Optional[str] = None,
end_date: Optional[str] = None,
page: Optional[int] = None,
page_size: Optional[int] = None
) -> Dict[str, Any]:
    """获取单元列表接口（只读｜SDK unit.List）
    端点: POST /api/open/jg/unit/list
获取单元列表接口
只读查询接口。
    参数:
    advertiser_id（可选）: 广告主id
    campaign_id（可选）: 广告计划id
    unit_ids（可选）: 单元id,不超过10个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    status（可选）: 投放状态：1：投放中2：暂停
    unit_name（可选）: 单元名称
    start_date（可选）: 创建单元开始时间
    end_date（可选）: 创建单元结束时间
    page（可选）: 请求的页码数，默认1
    page_size（可选）: 请求的每页行数，默认20
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "campaign_id": _parse_val_or_error(campaign_id, "campaign_id"),
        "unit_ids": _parse_val_or_error(unit_ids, "unit_ids"),
        "status": _parse_val_or_error(status, "status"),
        "unit_name": _parse_val_or_error(unit_name, "unit_name"),
        "start_date": _parse_val_or_error(start_date, "start_date"),
        "end_date": _parse_val_or_error(end_date, "end_date"),
        "page": _parse_val_or_error(page, "page"),
        "page_size": _parse_val_or_error(page_size, "page_size"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "unit_list")
    if _bad is not None:
        return _bad
    payload.pop("confirm", None)
    return await call_api("/jg/unit/list", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def unit_update(
advertiser_id: Optional[int] = None,
unit_id: Optional[int] = None,
unit_name: Optional[str] = None,
event_bid: Optional[int] = None,
note_ids: Optional[Union[str, List, Dict]] = None,
target_type: Optional[int] = None,
target_config: Optional[int] = None,
keyword_target_period: Optional[int] = None,
keyword_target_action: Optional[Union[str, List, Dict]] = None,
business_tree_name: Optional[str] = None,
spu_note_info: Optional[Union[str, List, Dict]] = None,
keyword_with_bid: Optional[Union[str, List, Dict]] = None,
substituted_user_id: Optional[str] = None,
keyword_gen_type: Optional[int] = None,
page_id: Optional[str] = None,
landing_page_url: Optional[str] = None,
unit_external_page_url: Optional[str] = None,
unit_landing_page_desc: Optional[str] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """编辑单元（写操作｜SDK unit.Update）
    端点: POST /api/open/jg/unit/update
编辑单元
⚠️写操作：编辑单元。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    unit_id（可选）: 单元ID
    unit_name（可选）: 单元名称
    event_bid（可选）: 出价/目标成本，单位分，自动控制不需要传
    note_ids（可选）: 标的-笔记id(帮助定向推荐，创意里的笔记会单独填写)非种草人群规模、深度种草人群规模下必填（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    target_type（可选）: 定向类型，1-通投,2-智能定向, 3-高级定向
    target_config（可选）: 定向配置
    keyword_target_period（可选）: 关键词时间周期，单位天，枚举包括 3，7，15，30
    keyword_target_action（可选）: 关键词目标行为 1: 搜索，2: 互动，3: 阅读（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    business_tree_name（可选）: 推广业务信息示例：生活服务>婚纱摄影;美妆个护;母婴>母婴食品>奶粉具体参看/api/open/jg/keyword/industry/taxonomy接口返回词。
    spu_note_info（可选）: spu&笔记标的信息推广目标是种草人群规模、深度种草人群规模下必传。spu只能一个，至少绑定5篇笔记，最多50(api限制)只能选择合作笔记与我的笔记，笔记违规不能选，spu审核不通过也可以选，选择的笔记一定是绑定在该spu上。（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    keyword_with_bid（可选）: 关键词，通过(关键词词包)/api/open/jg/keyword/word/bag/list (智能推词、行业推词、以词推词)/api/open/jg/keyword/common/recommend 接口获取搜索推广-标准投放下必传（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    substituted_user_id（可选）: 代投账号b的userId，代投笔记与其他笔记互斥,，需要校验是否有代投账号权限
    keyword_gen_type（可选）: 单元选词方式： -1:无意义默认值 0:手动选词 1:智能拓词 2:手动+智能 关键词定向且在白名单中才支持
    page_id（可选）: 落地页ID，聚光落地页下必填
    landing_page_url（可选）: 落地页Url，自研落地页下必填
    unit_external_page_url（可选）: 外链Url，标的是外链落地页时必填
    unit_landing_page_desc（可选）: 落地页表单描述
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_id": _parse_val_or_error(unit_id, "unit_id"),
        "unit_name": _parse_val_or_error(unit_name, "unit_name"),
        "event_bid": _parse_val_or_error(event_bid, "event_bid"),
        "note_ids": _parse_val_or_error(note_ids, "note_ids"),
        "target_type": _parse_val_or_error(target_type, "target_type"),
        "target_config": _parse_val_or_error(target_config, "target_config"),
        "keyword_target_period": _parse_val_or_error(keyword_target_period, "keyword_target_period"),
        "keyword_target_action": _parse_val_or_error(keyword_target_action, "keyword_target_action"),
        "business_tree_name": _parse_val_or_error(business_tree_name, "business_tree_name"),
        "spu_note_info": _parse_val_or_error(spu_note_info, "spu_note_info"),
        "keyword_with_bid": _parse_val_or_error(keyword_with_bid, "keyword_with_bid"),
        "substituted_user_id": _parse_val_or_error(substituted_user_id, "substituted_user_id"),
        "keyword_gen_type": _parse_val_or_error(keyword_gen_type, "keyword_gen_type"),
        "page_id": _parse_val_or_error(page_id, "page_id"),
        "landing_page_url": _parse_val_or_error(landing_page_url, "landing_page_url"),
        "unit_external_page_url": _parse_val_or_error(unit_external_page_url, "unit_external_page_url"),
        "unit_landing_page_desc": _parse_val_or_error(unit_landing_page_desc, "unit_landing_page_desc"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "unit_update")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：编辑单元。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/unit/update",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/unit/update",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/unit/update", {k: v for k, v in payload.items() if v is not None})


@mcp.tool()
async def unit_update_status(
advertiser_id: Optional[int] = None,
unit_ids: Optional[Union[str, List, Dict]] = None,
status: Optional[int] = None,
confirm: bool = False
) -> Dict[str, Any]:
    """修改单元状态（写操作｜SDK unit.UpdateStatus）
    端点: POST /api/open/jg/unit/update/status
修改单元状态
⚠️写操作：修改单元状态。需 confirm=true 才会真正执行，且需在 .env 设置 XHS_ALLOW_WRITE=1。
    参数:
    advertiser_id（可选）: 广告主ID
    unit_ids（可选）: 单元id，最多20个（数组/对象，可传 JSON 字符串、真实数组，或逗号分隔字符串）
    status（可选）: 单元状态 状态枚举1：开启2：暂停3：删除
    confirm: 必须显式传 true 才会真正执行（写操作安全开关）
    返回接口原始 JSON（含 code/msg/success）。"""
    payload: Dict[str, Any] = {
        "advertiser_id": _parse_val_or_error(advertiser_id, "advertiser_id"),
        "unit_ids": _parse_val_or_error(unit_ids, "unit_ids"),
        "status": _parse_val_or_error(status, "status"),
    }
    # 参数校验必须【紧跟 payload 构建】：畸形 JSON 会在 _parse_val_or_error 里
    # 被标记，若等到 confirm 分支之后才校验，写保护的 payload_preview 会把脏数据
    # 原样展示给调用方，且 confirm=true 时报错太晚。
    _bad = _strip_param_errors(payload, "unit_update_status")
    if _bad is not None:
        return _bad
    if not confirm:
        return {
            "need_confirm": True,
            "message": "写操作已拦截：修改单元状态。确认无误后重新调用并传 confirm=true。",
            "endpoint": "/api/open/jg/unit/update/status",
            "method": "POST",
            "payload_preview": _parse_val(payload),
        }
    if os.getenv("XHS_ALLOW_WRITE", "") not in ("1", "true", "True"):
        return {
            "error": "写操作已在服务端全局禁用。请在 .env 设置 XHS_ALLOW_WRITE=1 后重启 MCP 才允许执行。",
            "endpoint": "/api/open/jg/unit/update/status",
        }
    payload.pop("confirm", None)
    return await call_api("/jg/unit/update/status", {k: v for k, v in payload.items() if v is not None})


if __name__ == "__main__":
    mcp.run()
