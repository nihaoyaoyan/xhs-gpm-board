#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可选：以 Streamable HTTP 方式启动本 MCP（默认只绑 127.0.0.1）。

不修改自动生成的 server.py —— 只调整已构造好的 FastMCP 实例的 settings。
规范要求的 Origin 校验 / DNS rebinding 防护由 transport_security 显式开启。

警告：默认仅本机可用。若要对公网或第三方平台开放，必须在前面加反向代理，
自行实现 Bearer 鉴权、Origin 白名单、审计日志，并把写工具从 tools/list 剔除。
"""
from __future__ import annotations

import argparse
import pathlib
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description="Start this MCP over Streamable HTTP")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="extra allowed Origin, repeatable")
    ap.add_argument("--allow-host", action="append", default=[],
                    help="extra allowed Host, repeatable")
    args = ap.parse_args()

    here = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(here))

    import server as srv
    from mcp.server.fastmcp.server import TransportSecuritySettings

    m = srv.mcp
    m.settings.host = args.host
    m.settings.port = args.port

    port = args.port
    hosts = ["127.0.0.1", "localhost",
             "127.0.0.1:%d" % port, "localhost:%d" % port,
             "%s:%d" % (args.host, port)] + list(args.allow_host)
    origins = ["http://127.0.0.1", "http://localhost",
               "http://127.0.0.1:%d" % port, "http://localhost:%d" % port,
               "http://%s" % args.host, "http://%s:%d" % (args.host, port)] \
        + list(args.allow_origin)
    m.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=sorted(set(hosts)),
        allowed_origins=sorted(set(origins)),
    )

    print("MCP %s  |  http://%s:%d/mcp  |  localhost only" %
          (m.name, args.host, port), flush=True)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: non-loopback bind. Put an authenticated reverse proxy in front.",
              flush=True)
    m.run(transport="streamable-http")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
