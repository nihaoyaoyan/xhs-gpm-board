# 小红书 GPM 数据看板 · 晚风店铺

小红书商品笔记绩效全链路分析，基于商家后台导出数据自动生成交互式看板与结构化报告。

## 📁 目录

### 📊 [GPM 交互看板 →](https://nihaoyaoyan.github.io/xhs-gpm-board/gpm-report/)
> 8 个 KPI 卡片 + 2 张交互式图表 + 明细表（10 字段 / 行业对比）+ 筛选 / 搜索 / CSV 导出

| 文件 | 说明 |
|------|------|
| `gpm-report/index.html` | 落地页：KPI 摘要 + 导航 + 核心洞察 |
| `gpm-report/dashboard.html` | 交互看板：ECharts 图表 + 明细表 |
| `gpm-report/report.html` | 分析报告：6 大板块 + 5 条行动建议 |

### 📈 [旧版参考看板 →](https://nihaoyaoyan.github.io/xhs-gpm-board/xhs-gpm/)
> 早期版本，包含更多图表（商品 GMV 排名、每日趋势、笔记类型雷达图等）

### 🔧 构建工具
| 文件 | 说明 |
|------|------|
| `gpm-report/build_dashboard.py` | Python 构建脚本 |
| `gpm-report/template.html` | HTML 模板 |

---

## 📊 当前数据（2026-06）

| 指标 | 数值 |
|------|------|
| 笔记数 | 1,669 |
| 时间范围 | 2025-11 ~ 2026-06 |
| 总 GMV | ¥17,147 |
| 总订单 | 169 |
| 平均封面点击率 | 8.02% |
| 平均商品卡点击率 | 10.97% |
| 平均支付转化率 | 2.36% |

---

## 🏷️ 行业基准（食品生鲜类目）

| 指标 | 行业平均 | 行业优秀 |
|------|:---:|:---:|
| 封面点击率 | 6% | — |
| 商品卡点击率 | 3% | 15.43% |
| 支付转化率 | 1.5% | 6.12% |
| 客单价 | ¥90 | — |

---

## 🔄 更新方式

1. 从小红书商家后台导出 Excel（商品笔记数据 + 笔记维度数据）
2. 放入 `data/` 目录
3. 运行 `merge_cover_ctr.py` 合并封面点击率
4. 运行 `build_dashboard.py` 重建看板
5. Push 到 `main` 分支 → GitHub Pages 自动发布
