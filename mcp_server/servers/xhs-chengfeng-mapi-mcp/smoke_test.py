#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""冒烟测试：以 stdio 方式真实拉起 server.py，走完整 MCP 握手 + 调用一个工具。"""
import asyncio
import json
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
PYTHON = r"C:\Users\z1786\.workbuddy\binaries\python\envs\default\Scripts\python.exe"


async def main() -> None:
    params = StdioServerParameters(command=PYTHON, args=[SERVER])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print("INIT_OK:", init.serverInfo.name, init.serverInfo.version)

            tools = await session.list_tools()
            print("TOOLS:", len(tools.tools))
            assert len(tools.tools) == 19, f"expect 19 tools, got {len(tools.tools)}"

            # 调用一个纯本地校验路径的工具（不触网）：缺少日期应返回结构化错误
            result = await session.call_tool("report_offline_account", {"advertiser_id": 12345})
            print("CALL_MISSING_DATE:", json.dumps(result.content[0].text if result.content else None, ensure_ascii=False)[:200])
            assert "error" in (result.content[0].text if result.content else ""), "missing-date guard failed"

            # 调用 check_auth：无凭证时应返回 refresh_ok=false 及明确错误，不崩溃
            result2 = await session.call_tool("check_auth", {})
            txt2 = result2.content[0].text if result2.content else ""
            print("CALL_CHECK_AUTH:", txt2[:300])
            assert "refresh_ok" in txt2, "check_auth guard failed"

    print("SMOKE_TEST_PASSED")


if __name__ == "__main__":
    asyncio.run(main())
