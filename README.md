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
└── report.html          ← 📋 GPM 综合分析报告
      5大板块 · 执行摘要 → 诊断 → 搜索 → 商品 → 建议
      A4打印友好 · 面向决策
```

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
```

### 一键更新命令

导出新 Excel 后运行：
```bash
python data/merge_v3.py && python data/compute_diagnosis.py
python data/build_diagnosis.py
python data/XX_keyword_gen.py      # 搜索词JSON生成（新月份时运行）
python data/build_search.py
python data/build_summary.py && python data/build_report.py
```

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
