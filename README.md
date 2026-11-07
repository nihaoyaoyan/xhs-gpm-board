# 小红书数据分析系统（XHS Insight）

一套面向小红书店铺的数据分析与经营决策系统：前端可视化工作台 + FastAPI REST 服务 + 独立 FastMCP 服务，数据默认由内置 Mock 数据源提供，可切换为千帆开放平台真实数据。

## 能力概览

- 多店铺切换，按店铺沉淀订单 / 广告 / 评论 / 商品数据
- 增量同步与回填，幂等 upsert，重复同步不产生重复数据
- 核心指标：GMV、订单数、GPM、ROI、客单价、毛利率、毛利、保本销售额、保本倍数
- GPM 三因子拆解：`GPM = 1000 × CTR × CVR × AOV`，含上期对比瀑布图
- 四级转化漏斗：曝光 → 点击 → 进店 → 下单
- 搜索词分析：广告搜索词（消耗 / ROI / GPM）、店铺搜索词（按月查看：支付金额 / 订单 / 买家 / 商卡曝光 / 点击 / 点击率 / 支付转化率）、笔记搜索词（曝光 / 点击 / 进店 / 成交转化）
- 评论情感分析（本地 SnowNLP / 大模型双通道可切换）与关键词提取
- 前端 Excel 导出，MCP 11 个 Tools 供大模型直接调用

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 18 + TypeScript + Vite、Ant Design 5（小红书红 `#FF2442`）、Zustand、React Query、React Router v6、ECharts、React Hook Form + Zod、xlsx、dayjs、axios |
| 后端 | FastAPI + SQLAlchemy 2.0 async + asyncpg + Alembic、Pydantic v2、PyJWT + passlib(bcrypt)、APScheduler |
| MCP | FastMCP（独立进程，streamable-http） |
| 数据库 | PostgreSQL 16 |
| 部署 | Docker Compose（db / api / mcp / web 四服务） |

## 目录结构

```
.
├── backend/                # FastAPI 服务
│   ├── app/
│   │   ├── api/v1/         # REST 路由（auth/shops/sync/dashboard/orders/ads/comments/metrics/search-terms）
│   │   ├── core/           # 配置、鉴权、异常、日志
│   │   ├── db/             # 引擎、模型基类、种子数据
│   │   ├── models/         # ORM 模型
│   │   ├── schemas/        # Pydantic 模型
│   │   └── services/       # providers / sync / metrics / nlp
│   ├── alembic/            # 数据库迁移
│   └── tests/              # pytest（SQLite 内存外测试库）
├── mcp_server/             # 独立 FastMCP 服务 + 后端 HTTP 客户端
│   └── servers/            # 广告侧 MCP：xhs-chengfeng-mapi-mcp / xhs-juguang-mcp
├── web/                    # React 前端
├── docker-compose.yml
└── .env.example
```

## 快速开始（Docker Compose）

前置：安装 Docker 与 Docker Compose v2。

```bash
cp .env.example .env
docker compose up --build -d
docker compose ps          # 六个服务均应为 healthy
```

访问：

- 前端工作台：http://localhost:8080
- 后端 API 文档：http://localhost:8000/docs
- 店铺分析 MCP：http://localhost:9000/mcp/
- 乘风广告 MCP：http://localhost:9101/mcp/
- 聚光广告 MCP：http://localhost:9102/mcp/

演示账号：`admin / Admin@12345`

首次启动会自动执行 Alembic 迁移；演示数据默认不灌入，需要时设 `SEED_ON_STARTUP=true` 或手动执行 seed。

> 端口被占用时，在 `.env` 中修改 `WEB_PORT / API_PORT / MCP_PORT / MCP_CHENGFENG_PORT / MCP_JUGUANG_PORT / POSTGRES_PORT` 后重新 `docker compose up -d`。

## 本地开发（不使用 Docker）

### 1. 数据库

```bash
docker run -d --name xhs-pg -p 5432:5432 \
  -e POSTGRES_USER=xhs -e POSTGRES_PASSWORD=xhs_pass -e POSTGRES_DB=xhs_insight \
  postgres:16-alpine
```

或使用本机已有 PostgreSQL，并保证 `.env` 中 `DATABASE_URL` 指向它。

### 2. 后端

推荐 Python 3.12。

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
python -m app.db.seed                # 灌入演示数据（幂等）
uvicorn app.main:app --reload --port 8000
```

### 3. 前端

```bash
cd web
npm install
npm run dev                          # http://localhost:5173，/api 代理到 http://localhost:8000
```

代理目标可通过 `VITE_API_TARGET` 覆盖。

### 4. MCP 服务

在项目根目录（`/workspace`）执行：

```bash
MCP_TRANSPORT=streamable-http \
FASTMCP_STATELESS_HTTP=true \
FASTMCP_HOST=0.0.0.0 FASTMCP_PORT=9000 \
BACKEND_BASE_URL=http://127.0.0.1:8000 \
MCP_API_TOKEN=dev-service-token \
python -m mcp_server.server
```

服务地址 `http://localhost:9000/mcp/`，使用 Streamable HTTP 传输。

### 5. 广告侧 MCP（乘风 / 聚光）

两个自包含的官方 MAPI MCP 运行包已放在 `mcp_server/servers/`：

| 目录 | 工具数 | 端口 | 说明 |
| --- | --- | --- | --- |
| `xhs-chengfeng-mapi-mcp` | 19 | 9101 | 乘风/千帆报表与资金，只读 |
| `xhs-juguang-mcp` | 106 | 9102 | 聚光单元/创意/关键词/人群管理，含 31 个写工具（默认全部拦截） |

凭证写入各自目录下的 `.env`（已被 `.gitignore` / `.dockerignore` 排除，不会入库或打进镜像）：

```bash
# mcp_server/servers/xhs-chengfeng-mapi-mcp/.env 与 .../xhs-juguang-mcp/.env
XHS_APP_ID=<开放平台应用 appId>
XHS_SECRET=<应用 secret>
XHS_REFRESH_TOKEN=<OAuth 授权换取的 refresh_token>
XHS_ADVERTISER_ID=<默认广告主 ID，可选>
```

> refresh_token 一次性轮换、30 天有效，同一凭据全局只允许一个进程持有。两个服务使用不同应用与 scope，必须分别配置，不能共用同一份 refresh_token。凭证是否可用一律调 `check_auth` 判断。

本地启动（依赖 `mcp>=1.30,<2`、`httpx`、`python-dotenv`）：

```bash
cd mcp_server/servers/xhs-chengfeng-mapi-mcp && python serve_http.py --host 127.0.0.1 --port 9101
cd mcp_server/servers/xhs-juguang-mcp && python serve_http.py --host 127.0.0.1 --port 9102
```

> 运行包要求 `mcp>=1.30,<2`，其依赖的 pydantic 版本高于后端锁定值；本地同时开发时建议为广告 MCP 单独建 venv，避免与后端依赖互相覆盖。

Docker Compose 已内置 `mcp-chengfeng` / `mcp-juguang` 两个服务，`.env` 以只读方式挂载进容器。HTTP 端点默认仅绑回环地址，不要直接暴露公网；如需对外必须前置带鉴权的反向代理，并将写工具从 `tools/list` 中剔除。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql+asyncpg://xhs:xhs_pass@localhost:5432/xhs_insight` |
| `JWT_SECRET` | JWT 签名密钥，生产必须修改 | `please-change-this-in-production` |
| `JWT_EXPIRE_MINUTES` | Token 有效期（分钟） | `720` |
| `MCP_API_TOKEN` | MCP → 后端服务令牌（请求头 `X-Service-Token`） | `dev-service-token` |
| `MCP_CHENGFENG_PORT` / `MCP_JUGUANG_PORT` | 广告侧 MCP 宿主机端口 | `9101` / `9102` |
| `SCHEDULER_ENABLED` | 是否启用 APScheduler 定时同步 | `true` |
| `DATA_PROVIDER` | 数据源：`mock` / `qianfan` | `mock` |
| `QIANFAN_APP_KEY` / `QIANFAN_APP_SECRET` | 千帆应用凭证 | 空 |
| `ANALYZER_MODE` | 情感分析：`auto` / `local` / `llm` | `auto` |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 大模型通道配置，缺失时自动降级本地 | 空 / `gpt-4o-mini` |
| `SEED_ON_STARTUP` | 是否首次启动灌入演示数据 | `false` |

## 数据同步与调度

- 手动同步：店铺页 → 同步按钮，或 `POST /api/v1/shops/{id}/sync`
  - `resource`: `products | orders | ads | comments | search_terms`
  - `mode`: `incremental`（默认，按天数回溯）/ `backfill`
- 幂等：按业务唯一键 upsert，重复执行不会新增重复订单 / 评论 / 广告 / 搜索词记录
- 定时：APScheduler 在 `Asia/Shanghai` 时区按间隔/每日执行增量同步，可在 `SCHEDULER_ENABLED=false` 关闭

### 导入搜索词 Excel 月报

支持将「搜索词 / 支付金额 / 支付订单数 / 支付买家数 / 商卡曝光人数 / 商品点击人数 / 商品点击率 / 支付转化率」格式的月报导入指定店铺（按单日快照写入，默认清空当月同渠道旧数据）：

```bash
cd backend
DATABASE_URL="sqlite+aiosqlite:////tmp/xhs_run.db" \
python scripts/import_search_terms.py \
  --file "/path/to/搜索词数据.xlsx" --shop-id 1 --date 2026-10-31
```

可选参数：`--channel shop|ad|note`、`--no-replace`（保留当月旧数据，仅覆盖同名词）。导入后在「店铺搜索词」页面选择对应月份查看；该页面仅支持按月查看，月份选择器默认上一个自然月。

## 指标口径

| 指标 | 公式 |
| --- | --- |
| CTR | `clicks / impressions` |
| CVR | `orders_count / clicks` |
| AOV | `gmv / orders_count` |
| GPM | `gmv / impressions × 1000 = 1000 × CTR × CVR × AOV` |
| ROI | `gmv / ad_spend` |
| 毛利 | `gmv × (1 − 成本率 − 平台费率 − 退货率) − 广告消耗 − 月固定成本 / 当月天数` |
| 毛利率 | `毛利 / gmv` |
| 保本销售额 | `(日固定成本 + 广告消耗) / (1 − 成本率 − 平台费率 − 退货率)` |
| 保本倍数 | `gmv / 保本销售额` |

成本参数按店铺维护（成本率 / 平台费率 / 退货率 / 月固定成本），修改后仪表盘与指标明细自动联动。

## REST 接口

统一响应包裹：`{ "code": 0, "data": ..., "message": "ok" }`，业务错误 `code != 0`，HTTP 状态码同步语义。

- `POST /api/v1/auth/login`、`GET /api/v1/auth/me`
- `GET /api/v1/shops`、`POST /api/v1/shops`、`PATCH /api/v1/shops/{id}`
- `GET /api/v1/shops/{id}/cost-config`、`PUT /api/v1/shops/{id}/cost-config`
- `POST /api/v1/shops/{id}/sync`、`GET /api/v1/shops/{id}/sync-logs`
- `GET /api/v1/dashboard/overview|trend|funnel|gpm-breakdown|sentiment`
- `GET /api/v1/orders`、`GET /api/v1/ads`、`GET /api/v1/comments`
- `GET /api/v1/search-terms?shop_id=&channel=ad|shop|note&start=&end=&keyword=&sort=&limit=`
  - `channel=ad`：广告搜索词，含消耗、ROI、GPM；`channel=shop`：店铺搜索词，按「搜索词 / 支付金额 / 支付订单数 / 支付买家数 / 商卡曝光人数 / 商品点击人数 / 商品点击率 / 支付转化率」口径返回；`channel=note`：笔记搜索词，含曝光、点击、进店与成交转化
- `POST /api/v1/comments/{id}/analyze`、`POST /api/v1/comments/reanalyze`
- `GET /api/v1/metrics/daily`

除登录外均需 `Authorization: Bearer <token>`；MCP 服务使用 `X-Service-Token` 访问同一组接口。完整参数见 `/docs`。

## MCP Tools（11 个）

| Tool | 说明 |
| --- | --- |
| `list_shops` | 店铺列表 |
| `get_shop_overview` | 核心 KPI 与环比 |
| `get_sales_trend` | 销售趋势（日/周/月） |
| `get_conversion_funnel` | 四级转化漏斗 |
| `get_gpm_breakdown` | GPM 三因子与瀑布贡献 |
| `get_profit_report` | 毛利 / 毛利率 / 保本销售额 / 保本倍数 |
| `get_ad_performance` | 广告投放表现 |
| `list_comments` | 评论列表，可按情感筛选 |
| `get_comment_insights` | 情感分布 + Top 关键词 |
| `query_orders` | 订单查询，可按状态筛选 |
| `trigger_sync` | 触发增量同步 |

接入示例（任意 MCP 客户端）：`http://localhost:9000/mcp/`，工具入参以 `shop_id` 为主，日期可选 `start_date / end_date`（`YYYY-MM-DD`，默认近 30 天）。

## 接入真实千帆数据

将 `.env` 中 `DATA_PROVIDER=qianfan`，并填写 `QIANFAN_APP_KEY / QIANFAN_APP_SECRET`。接口路径、签名、字段映射集中在 [qianfan.py](backend/app/services/providers/qianfan.py)，上线前按官方最新文档替换 5 处：

1. `PATHS` 接口路径
2. `_sign()` 签名算法
3. `_headers()` 鉴权头名称
4. `_map_order / _map_comment` 字段映射
5. `_extract_list()` 响应结构解析

## 测试与校验

```bash
# 后端测试（使用独立 SQLite 测试库，不依赖 PostgreSQL）
cd backend
DATABASE_URL="sqlite+aiosqlite:////tmp/xhs_pytest.db" \
SCHEDULER_ENABLED=false DATA_PROVIDER=mock ANALYZER_MODE=local \
pytest -q

# 前端静态检查 + 生产构建
cd web
npm run lint
npm run build
```

当前测试覆盖：指标公式与 GPM 恒等、漏斗 / 趋势口径一致性、鉴权与错误包裹、NLP 情感阈值与关键词。

## 常见问题

- **登录 401**：确认已执行 `python -m app.db.seed`（Docker 启动会自动执行），账号为 `admin / Admin@12345`。
- **前端接口 404 / 跨域**：开发模式确认 Vite 代理目标；生产由 `web/nginx.conf` 将 `/api` 反代到 `api:8000`。
- **同步成功但没有新数据**：Mock 数据具有确定性，同一店铺同一日期重复同步结果一致；可切换店铺或调整同步天数验证。
- **修改成本参数后数据未变化**：保存后仪表盘会自动重算；如仍显示旧值，刷新页面重试（接口读路径会兜底回算当日指标）。
