# 鲜水湾 · 小红书 GPM 数据看板

小红书食品生鲜店铺经营分析看板，管线驱动自动构建，GitHub Pages 部署。

**🔗 入口：https://nihaoyaoyan.github.io/xhs-gpm-board/reports/2026-06-13/?v=20260613**

---

## 📑 页面导航

```
reports/2026-06-13/
├── index.html           ← 🏠 落地页（KPI摘要 + 四卡片导航 + 核心洞察）
│
├── diagnosis.html       ← 🔍 笔记诊断看板
│    5因子漏斗 × 双线基准 × 逐条瓶颈定位
│    "补X单达标"建议 + 推荐衰减监控
│
├── search.html          ← 🔎 搜索词分析看板
│    7个月 1,431个搜索词 × ¥10.2万GMV
│    长尾金词 + 机会缺口 + 新星词
│
├── dashboard.html       ← 📊 综合数据看板
│    笔记诊断 + 搜索词双数据源整合
│    商品榜 · 作者贡献 · 月度趋势 · 衰减分布 · 金词热力图
│
├── report.html          ← 📋 GPM 综合分析报告
│    5大板块 · 执行摘要 → 诊断 → 搜索 → 商品 → 建议
│    A4打印友好 · 面向决策
│
├── competitor-shrimp.html ← 🦐 虾仁爆款（蒲公英 100 条真实数据）
│    5 Tab: 爆款全貌 / 公式拆解 / 博主矩阵 / 100条标题库 / 🐟 三文鱼(待数据)
│    11 种爆款公式 + TOP 30 博主 + 真实互动数据（点赞/收藏/评论/分享）
│```

**页面关联关系：**

```
┌──────────────────────────────────────────────┐
│                 🏠 落地页 (index)              │
│   KPI: 笔记GMV ¥8,911 | 搜索GMV ¥10.2万     │
├──────────┬──────────┬───────────┬────────────┤
│ 📊综合看板 │ 🔍诊断看板 │ 🔎搜索词看板│ 📋分析报告  │
│ dashboard │diagnosis │  search   │  report    │
└─────┬─────┴────┬─────┴─────┬─────┴──────┬─────┘
      │          │           │            │
      ▼          ▼           ▼            ▼
 双源整合     笔记漏斗     关键词掘金    综合建议
      │                                       
      ▼                                       
 🔥 竞品爆款 (competitor-shrimp · 未来扩展三文鱼等品类)
      │                                       
      ▼                                       
 4 Tab 拆解：封面+标题+评论区                  
 推导出"可复用爆款公式"                        
```

---

## 📊 当前数据快照（2026-06-13）

| 维度 | 指标 | 数值 |
|------|------|------|
| 笔记 | 总笔记数 | 1,669 篇 |
| | 有GMV笔记 | 45 篇 (2.7%) |
| | 笔记直接GMV | ¥8,911 |
| | 推荐中笔记(≤3天) | 50 篇 |
| | 搜索续命笔记 | 1,619 篇 |
| 搜索 | 搜索GMV | ¥101,862 |
| | 搜索订单 | 1,024 单 |
| | 独立搜索词 | 1,431 个 |
| | 搜索/笔记倍率 | 11.4× |

---

## 🏷️ 行业基准值

| 因子 | 行业平均 | 行业优秀 | 数据来源 |
|------|:---:|:---:|------|
| 封面点击率 | 6% | 10.1% | 多源交叉验证 ✅ |
| 商品转化率（商品卡CTR）| 3% | 15.43% | 基于历史数据推算 |
| 笔记支付转化率（CVR）| 1.5% | 6.12% | 基于历史数据推算 |
| 客单价 | ¥90 | ¥100 | 参考值 |

---

## 🔧 数据管线

### 输入数据源

| 文件 | 用途 |
|------|------|
| `商品笔记数据-(日期).xlsx` | 笔记GMV/订单/商品CTR/CVR |
| `笔记分析_笔记维度数据.xlsx` | 笔记曝光量/阅读量(封面CTR) |
| `搜索词数据(YYYY年MM月).xlsx` | 每月搜索关键词表现 |

### 构建管线

```
Excel文件（商家后台导出）
│
├─ merge_v3.py ──────────→ dashboard_payload.json
│   (合并笔记+曝光)             │
│                          compute_diagnosis.py
│                          (5因子瓶颈诊断)
│                               │
│                          diagnosis_data.json
│                          ┌──────┴──────┐
│                          │             │
│                   build_diagnosis.py   │
│                   (笔记诊断看板)        │
│                          │             │
│                   diagnosis.html       │
│                                        │
├─ search_kw_gen.py ─────→ search_keywords.json
│   (搜索词聚合+长尾分析)         │
│                          build_search.py
│                          (搜索词看板)
│                               │
│                          search.html
│                               │
└─ compute_summary.py ────→ summary_data.json
    (诊断+搜索双源整合)         │
                    ┌──────┴──────┐
                    │             │
             build_summary.py  build_report.py
             (综合数据看板)    (分析报告)
                    │             │
             dashboard.html   report.html

└─ 【蒲公英导出 CSV/Excel】 → transform_shrimp_excel.py → competitor_shrimp.json
   (虾仁爆款 100 条 + 真实互动)        │
                                build_competitor_shrimp.py
                                (竞品爆款看板·虾仁真实数据)
                                     │
                                competitor-shrimp.html
   (后续扩展: 三文鱼爆款 → transform_salmon.py → 新增 tab)
```

### 一键更新命令

导出新 Excel 后运行：
```bash
python data/merge_v3.py && python data/compute_diagnosis.py
python data/build_diagnosis.py
python data/XX_keyword_gen.py      # 搜索词JSON生成（新月份时运行）
python data/build_search.py
python data/build_summary.py && python data/build_report.py

# 虾仁爆款（蒲公英 Excel/CSV 导出后）
python data/transform_shrimp_excel.py    # Excel/CSV → JSON
python data/build_competitor_shrimp.py    # 构建看板

# 三文鱼爆款（蒲公英数据导出后 · 后续扩展）
# python data/transform_salmon.py
# python data/build_competitor_salmon.py
```

---

## 🔥 竞品爆款笔记看板

**唯一页面**：`competitor-shrimp.html`（虾仁真实数据 + 三文鱼占位 tab）

**🗑️ 已下架**：`competitor-demo.html`（脱敏样板）于 2026-06-13 删除，虾仁真实数据已能完整覆盖 4-Tab 拆解需求。

### competitor-shrimp.html（虾仁真实数据 · 100 条蒲公英导出）

**入口**：`reports/2026-06-13/competitor-shrimp.html`

**数据源**：蒲公英【社媒助手】热门商业笔记 · 2026-06-13 导出 · 关键词"虾仁" · 100 条
**数据升级**：v2 通过【笔记分析】模块重新导出，补全真实互动数据（点赞/收藏/评论/分享），互动量 20~6,461。

#### 5 个 Tab

| Tab | 内容 | 价值 |
|-----|------|------|
| 📊 爆款全貌 | 7 个 KPI（笔记数/独立账号/主要公式/主导话题/主导层级/高频钩子/黄金时段）+ 7 个图表（公式分布/话题 TOP/24h发布/星期分布/层级/封面/月度） + 7 条核心洞察 | 速览虾仁品类全貌 |
| 🎯 公式拆解 | 11 种爆款公式聚合（每种含代表笔记 3 篇 + 平均图片/话题/粉丝数） | 学习虾仁专属打法 |
| 👥 博主矩阵 | 30 个 TOP 博主详情卡 + 笔记数 vs 粉丝数散点图 + TOP 10 横向条形图 | 找对标账号 |
| 📚 100条标题库 | 全 100 条笔记的可搜索/筛选/排序表（按公式/博主/发布时间/粉丝数/图片数） | 选题灵感库 |
| 🐟 三文鱼爆款 | **占位 tab** — 数据待补（用户后续通过【社媒助手】导出三文鱼数据后接入，复用 4-Tab 框架） | 即将上线 |

#### 11 种虾仁爆款公式（启发式分类）

| 公式 | 占比 | 关键钩子 |
|------|----:|--------|
| 一人食小包装 | 18% | 小包装/独立/独食/早八人 |
| 场景种草型 | 15% | 早餐/晚餐/减脂/健身/宿舍 |
| 反差型 | 12% | 以为/结果/没想到/低估 |
| 数字+反差型 | 9% | 数字+单位+反差词 |
| 情绪共鸣型 | 6% | 震惊/yyds/救命 |
| 对话钩子型 | 4% | 引用/我爸妈/老爸/顾客/粉丝 |
| 剧情对话型 | 3% | 引用+回购/被安利 |
| 剧情反转型 | 3% | 我也不想/家人们谁懂 |
| 回购+故事型 | 2% | 第N次/被安利 |
| 数字+落差型 | 2% | 数字+价值词 |
| 反常识警告型 | 1% | 警告/别再/避雷 |

### 数据采集

- **数据 Schema**：`data/competitor_data_dictionary.md`（30+ 字段详细说明）
- **虾仁数据**：`data/competitor_shrimp.json`（蒲公英导出 100 条 + 真实互动）
- **更新方式**：
  - 虾仁：蒲公英导出 Excel/CSV → `transform_shrimp_excel.py` → `build_competitor_shrimp.py`
  - 三文鱼（后续）：蒲公英导出 → `transform_salmon.py` → `build_competitor_salmon.py`（占位 tab 已就绪）
- **采集频率**：每周一次（每周一上午统一采集上周爆款）

---

## 🚀 部署

- **仓库**：https://github.com/nihaoyaoyan/xhs-gpm-board
- **分支**：`main` → GitHub Pages 自动发布
- **路径**：`reports/YYYY-MM-DD/`
- **缓存策略**：所有看板含 `<meta http-equiv="Cache-Control">` + 链接带 `?v=YYYYMMDD`

---

## ⚠️ 维护须知

1. **每次更新代码或页面后，必须同步更新本 README**
2. 新增/删除/重命名页面时，更新「页面导航」目录树和关联关系图
3. 管线脚本变更时，更新「构建管线」流程图和一键命令
4. 数据指标或基准值变更时，更新「数据快照」和「行业基准值」表格
