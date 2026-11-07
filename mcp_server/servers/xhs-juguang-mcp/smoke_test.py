#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""聚光 MCP 冒烟测试：stdio 握手 + 工具注册数 + 写操作拦截。"""
import asyncio
import os
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
PYTHON = r"C:\Users\z1786\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
EXPECTED_TOOLS = 106


async def main() -> None:
    params = StdioServerParameters(command=PYTHON, args=[SERVER])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print("INIT_OK:", init.serverInfo.name, init.serverInfo.version)

            tools = await session.list_tools()
            n = len(tools.tools)
            print("TOOLS:", n)
            assert n == EXPECTED_TOOLS, f"expect {EXPECTED_TOOLS}, got {n}"

            # 写操作必须被拦截（不能真发）。
            # 数组类参数三种传法都要过：真实数组 / JSON 字符串 / 逗号分隔字符串。
            # （FastMCP 会把 JSON 字符串预解析成 list 再校验，注解必须是联合类型）
            for label, ids in (("list", [1, 2, 3]), ("json", "[1,2,3]"), ("csv", "1,2,3")):
                r = await session.call_tool("unit_update_status", {
                    "advertiser_id": 8737051, "unit_ids": ids, "status": 1})
                txt = r.content[0].text if r.content else ""
                print(f"WRITE_GUARD[{label}]:", txt[:120])
                assert "need_confirm" in txt, f"write guard failed ({label}): {txt[:200]}"

            # 第二道开关：confirm=true 但服务端未开 XHS_ALLOW_WRITE 时必须仍被拒
            r = await session.call_tool("unit_update_status", {
                "advertiser_id": 8737051, "unit_ids": [1, 2, 3], "status": 1, "confirm": True})
            txt = r.content[0].text if r.content else ""
            print("WRITE_GUARD[server-off]:", txt[:160])
            assert "XHS_ALLOW_WRITE" in txt, f"server-side write guard failed: {txt[:200]}"

            # 只读工具缺参应给出本地校验错误而非崩溃
            r2 = await session.call_tool("check_auth", {})
            txt2 = r2.content[0].text if r2.content else ""
            print("CHECK_AUTH:", txt2[:220])
            assert "app_creds_ready" in txt2, "check_auth failed"

    print("SMOKE_TEST_PASSED")


if __name__ == "__main__":
    asyncio.run(main())
