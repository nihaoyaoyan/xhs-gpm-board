# 聚光 MAPI MCP · 自包含运行包 1.0.0

- 应用 appId：`13494`
- 授权 scope：`report_service`, `ad_query`, `ad_manage`, `account_manage`
- 工具数：106
- 用途：单元 / 创意 / 关键词 / 人群全套管理，含 31 个写操作
- 构建日期：20261106

**本包不含任何真实凭据。** `.env` 与 `.token_cache.json` 由使用者在本机自行生成，永不外发。

---

## 1. 安装

需要 Python 3.10+。

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows；Linux/macOS 用 source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` 里锁了 `mcp>=1.2.0,<2`。**不要装 mcp 2.x**：它把 `FastMCP` 改名为
`MCPServer`，`from mcp.server.fastmcp import FastMCP` 会直接 ImportError。
本包在 mcp 1.30.0 上验证过。

## 2. 配置

```bash
copy .env.example .env            # Windows；Linux/macOS 用 cp
```

填入 `XHS_APP_ID` / `XHS_SECRET` / `XHS_REFRESH_TOKEN` 三要素，以及可选的
`XHS_ADVERTISER_ID`。授权入口：

```
https://ad-market.xiaohongshu.com/auth?appId=<APP_ID>&scope=<SCOPE>&redirectUri=http://localhost/oauth/callback&state=abcd
```

拿到 `auth_code` 后调 MCP 的 `oauth_access_token(auth_code=...)`，服务会自动把新
`refresh_token` 写回 `.env`。

> ⚠️ **refresh_token 是一次性的**：每次刷新都会轮换、旧值立即作废，30 天有效。
> 全局**只允许一个进程**持有这份凭据。禁止用 curl / 独立脚本手搓 refresh 接口，
> 禁止两个实例同时跑 —— 会互相把授权顶掉，只能重新走 OAuth。
> 判断凭证是否可用一律调 `check_auth`，不要相信 `has_token` 字段。

## 3. 启动

### A. stdio（默认，供 IDE / WorkBuddy 拉起）

把 `mcp.json.example` 里的路径改成本机绝对路径，合并进客户端的 `mcpServers` 配置。
stdio 由客户端拉起子进程，**不要手动双击 `start_stdio.bat` 长期挂着**（它会等 stdin）。

```bash
python smoke_test.py              # 握手 + 工具注册 + 写保护自检
```

### B. Streamable HTTP（可选，给网站 / 第三方平台）

```bash
start_http.bat                    # 或 python serve_http.py --host 127.0.0.1 --port 8001
```

端点 `http://127.0.0.1:8001/mcp`，默认只绑回环地址，并开启 Origin 校验与
DNS rebinding 防护。

**别把它直接暴露到公网。** 上一轮的结论仍然成立：网站前端不该做 MCP 客户端。
正确做法是本机进程独占凭据、定时拉报表落成只读 `snapshot.json`，网站只 fetch 那个
JSON。确实需要在线调用时，前面必须有带鉴权的反向代理，并且把 31 个写工具从
`tools/list` 里剔除。

## 4. 数据口径

离线报表是 T+1（次日）数据，`end_date` 不能填今天。取报表时传完整指标列，
否则返回结果里没有订单和 GMV（成交总额），ROI（投入产出比）也算不出来。


### 写操作双闸（本包含 31 个写工具）

1. 工具级：调用时必须显式传 `confirm: true`，否则只返回预览、不发请求。
2. 服务级：`.env` 里 `XHS_ALLOW_WRITE=1` 才真正执行，**默认空 = 全部拦截**。

`finance_transfer`（资金转账）与 `targettemplate_apply` 即使开了总闸也不建议启用。
网站侧一律不开放写操作 —— 改出价、删单元、转账只走人工确认通道。

## 5. 维护纪律

`server.py` 是自动生成物，**不要直接改**。逻辑改动去源仓库改 `gen_server.py` 的
`HEADER` 常量后重新生成，否则下次生成会被覆盖。

原开发文档（接口清单、授权事故记录、内部广告主标识）不在本包内 —— 需要时回源仓库查，
避免把账户信息随包外发。

## 6. 文件清单

见 `manifest.json`（含每个文件的 SHA-256 与字节数）。
