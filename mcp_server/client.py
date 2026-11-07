"""MCP 到后端 REST 的轻量客户端（X-Service-Token 鉴权）。"""

from __future__ import annotations

import os
from typing import Any

import httpx

BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:8000").rstrip("/")
SERVICE_TOKEN = os.getenv("MCP_API_TOKEN", "dev-service-token")
TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class BackendError(Exception):
    pass


async def _request(method: str, path: str, params: dict | None = None, json: dict | None = None) -> Any:
    headers = {"X-Service-Token": SERVICE_TOKEN}
    url = f"{BASE_URL}/api/v1{path}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.request(method, url, params=params, json=json, headers=headers)
    except httpx.HTTPError as exc:
        raise BackendError(f"后端服务不可达: {exc}") from exc

    try:
        payload = response.json()
    except ValueError:
        raise BackendError(f"后端返回非 JSON 内容（HTTP {response.status_code}）")

    if response.status_code >= 400:
        raise BackendError(str(payload.get("message") or payload.get("detail") or response.text[:200]))
    if payload.get("code") != 0:
        raise BackendError(str(payload.get("message") or "后端返回业务错误"))
    return payload.get("data")


async def get(path: str, params: dict | None = None) -> Any:
    return await _request("GET", path, params=params)


async def post(path: str, json: dict | None = None, params: dict | None = None) -> Any:
    return await _request("POST", path, params=params, json=json)
