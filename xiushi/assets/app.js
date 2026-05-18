/* 休食组业绩看板 V3 — 视觉重做（去除大门偏向、修异常环比、商品/商家加链接） */
const STATE = {
  index: null,
  currentPeriod: "this_bimonth",
  currentTab: "tab1_team_overview",
  currentAM: "全组",  // "全组" | AM 名称
  cache: {},
  echarts: [],
};
const ALL_AMS = ["全组", "蕾塞(张嘉悦)", "莱拉(付艺迪)", "大门(朱锦程)", "路歌(李红红)", "秋罗(胡春秋)", "诺亚(单恩浩)"];

// AM 维度过滤工具：返回 AM 字段索引；找不到返回 -1
function findAMColIdx(cols) {
  if (!cols) return -1;
  for (let i = 0; i < cols.length; i++) {
    const c = String(cols[i] || "").trim();
    if (c === "AM" || c === "商家am名称" || c === "商家am名称(最新日期）" ||
        c === "商家am名称(最新日期)" || c === "AM五级部门" ||
        c === "最新分区AM用户名") return i;
  }
  return -1;
}

// 根据当前 AM 过滤 data；如果 AM=全组 或 chart 没 AM 列，原样返回
function applyAMFilter(data) {
  if (!data || STATE.currentAM === "全组") return data;
  const ai = findAMColIdx(data.columns);
  if (ai < 0) return data;  // chart 没 AM 维度，返回原数据
  const filtered = data.rows.filter(r => {
    if (!r || ai >= r.length) return false;
    const v = String(r[ai] || "").trim();
    return v === STATE.currentAM || v === "总计";
  });
  return Object.assign({}, data, {rows: filtered});
}

function currentAMHasFilter(data) {
  return STATE.currentAM !== "全组" && findAMColIdx(data && data.columns) >= 0;
}
const EL = {
  meta: document.getElementById("generated-at"),
  amButtons: document.getElementById("am-buttons"),
  amInfo: document.getElementById("am-info"),
  periodButtons: document.getElementById("period-buttons"),
  periodInfo: document.getElementById("period-info"),
  tabBar: document.getElementById("tab-bar"),
  main: document.getElementById("main-content"),
  customRange: document.getElementById("custom-range"),
  customStart: document.getElementById("custom-start"),
  customEnd: document.getElementById("custom-end"),
  customApply: document.getElementById("custom-apply"),
};

// ============ utils ============
const fmt = {
  money(v) {
    if (v == null) return "-";
    if (typeof v !== "number") return v;
    if (Math.abs(v) >= 1e8) return (v/1e8).toFixed(2)+"亿";
    if (Math.abs(v) >= 1e4) return (v/1e4).toFixed(2)+"万";
    return v.toLocaleString("zh-CN", {maximumFractionDigits: 0});
  },
  int(v) {
    if (v == null) return "-";
    if (typeof v !== "number") return v;
    return Math.round(v).toLocaleString("zh-CN");
  },
  int_w(v) {
    if (v == null) return "-";
    if (typeof v !== "number") return v;
    if (Math.abs(v) >= 1e8) return (v/1e8).toFixed(2)+"亿";
    if (Math.abs(v) >= 1e4) return (v/1e4).toFixed(2)+"万";
    return v.toLocaleString("zh-CN", {maximumFractionDigits: 0});
  },
  pct(v) {
    if (v == null || typeof v !== "number") return "-";
    return (v*100).toFixed(2)+"%";
  },
  num(v) {
    if (v == null) return "-";
    if (typeof v !== "number") return v;
    if (Math.abs(v) >= 10000) return v.toLocaleString("zh-CN", {maximumFractionDigits: 0});
    return v.toLocaleString("zh-CN", {maximumFractionDigits: 1});
  },
  ellipsize(s, n) {
    if (!s) return "";
    s = String(s);
    return s.length > n ? s.slice(0, n-1) + "…" : s;
  }
};

// 关键：渲染同比/环比变化率，带异常值兜底
function renderDelta(rate, opts={}) {
  if (rate == null || typeof rate !== "number" || isNaN(rate)) return "-";
  // 阈值收紧到 100%：超过则当 BI 口径不可信
  if (Math.abs(rate) > 1) {
    return `<span class="delta-abnormal" title="变化幅度过大，可能 BI 口径与本时段不匹配">—</span>`;
  }
  const cls = rate >= 0 ? "delta-up" : "delta-down";
  const arrow = rate >= 0 ? "↑" : "↓";
  return `<span class="${cls}">${arrow} ${(Math.abs(rate)*100).toFixed(1)}%</span>`;
}
function deltaInline(rate) {
  if (rate == null || typeof rate !== "number" || isNaN(rate)) return "";
  // ≤500% 都展示（阈值放宽，避免合理但大幅的同比被误屏蔽）
  if (Math.abs(rate) > 5) return `<div class="delta delta-abnormal">变化异常</div>`;
  const cls = rate >= 0 ? "delta-up" : "delta-down";
  const arrow = rate >= 0 ? "↑" : "↓";
  // >100% 仍展示，但用 "显著↑" 标示
  if (Math.abs(rate) > 1) {
    return `<div class="delta ${cls}">${arrow}${(Math.abs(rate)*100).toFixed(0)}%<span class="muted-mini"> 显著</span></div>`;
  }
  return `<div class="delta ${cls}">${arrow} ${(Math.abs(rate)*100).toFixed(1)}%</div>`;
}

function findColIdx(cols, name) {
  for (let i=0;i<cols.length;i++) if (cols[i] === name) return i;
  return -1;
}
function findColIdxLoose(cols, name) {
  const t = name.trim();
  for (let i=0;i<cols.length;i++) if (cols[i].trim() === t) return i;
  return -1;
}
function disposeAll() {
  STATE.echarts.forEach(c => { try{c.dispose();}catch(e){} });
  STATE.echarts = [];
}

const PALETTE = ["#5470c6","#91cc75","#fac858","#ee6666","#73c0de","#3ba272","#fc8452","#9a60b4","#ea7ccc","#5cabae"];

// 商家/商品 链接生成
// 苍穹店铺直链（AM 视角，优先）
function sellerCangqiongUrl(sellerId) {
  return `https://crm.xiaohongshu.com/eccrm/merchant-detail/${sellerId}?isSellerId=true&type=basicInfo`;
}
// 苍穹商品直链
function productCangqiongUrl(itemId) {
  return `https://crm.xiaohongshu.com/crm/hawk/item/item/detail?itemId=${itemId}`;
}
// 兜底：搜索页（无 ID 时使用）
function sellerSearchUrl(name) {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(name)}&type=51`;
}
function productSearchUrl(name) {
  return `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(name)}&type=53`;
}
function noteUrl(noteId) {
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

async function fetchData(period, chartId) {
  const key = `${period}/${chartId}`;
  if (STATE.cache[key]) return STATE.cache[key];
  try {
    const r = await fetch(`data/${period}/${chartId}.json` + (STATE.cacheBuster || ""), {cache: "no-store"});
    if (!r.ok) throw new Error("HTTP "+r.status);
    const d = await r.json();
    STATE.cache[key] = d;
    return d;
  } catch (e) { return null; }
}

// ============ init ============
async function init() {
  // 防缓存：每分钟变一次的 cache-buster
  const cb = "?v=" + Math.floor(Date.now()/60000);
  STATE.cacheBuster = cb;
  const r = await fetch("data/index.json" + cb, {cache: "no-store"});
  STATE.index = await r.json();
  // 加载全组日序列 (供 hero KPI 自算环比)
  try {
    const gs = await fetch("data/_global_series.json" + cb, {cache: "no-store"});
    if (gs.ok) STATE.globalSeries = await gs.json();
  } catch(e) { STATE.globalSeries = null; }
  // 加载 per-period distinct 商家数/商品数（修复 chart limit 截断）
  try {
    const dc = await fetch("data/_distinct_counts.json" + cb, {cache: "no-store"});
    if (dc.ok) STATE.distinctCounts = await dc.json();
  } catch(e) { STATE.distinctCounts = null; }
  // V9: 店播 5 层乘数 / 笔记 benchmark / per-AM 商家数 / Summary
  try {
    const lb = await fetch("data/_live_breakdown.json" + cb, {cache: "no-store"});
    if (lb.ok) STATE.liveBreakdown = await lb.json();
  } catch(e) { STATE.liveBreakdown = null; }
  try {
    const nb = await fetch("data/_note_benchmark.json" + cb, {cache: "no-store"});
    if (nb.ok) STATE.noteBenchmark = await nb.json();
  } catch(e) { STATE.noteBenchmark = null; }
  try {
    const asc = await fetch("data/_am_seller_counts.json" + cb, {cache: "no-store"});
    if (asc.ok) STATE.amSellerCounts = await asc.json();
  } catch(e) { STATE.amSellerCounts = null; }
  try {
    const sm = await fetch("data/_summary.json" + cb, {cache: "no-store"});
    if (sm.ok) STATE.summary = await sm.json();
  } catch(e) { STATE.summary = null; }
  // V10: 新商家数据
  try {
    const ns = await fetch("data/_new_seller.json" + cb, {cache: "no-store"});
    if (ns.ok) STATE.newSeller = await ns.json();
  } catch(e) { STATE.newSeller = null; }
  // V10: 预加载 last_7d + this_bimonth 几个 chart 给周报版 Summary 用
  STATE.weeklyData = {last_7d: {}, this_bimonth: {}};
  const wkCharts = ["t1_bimonth_byAM","t2_note_byAM","t3_live_byAM","t4_k_overview"];
  await Promise.all(["last_7d","this_bimonth"].flatMap(p =>
    wkCharts.map(async c => {
      try {
        const r = await fetch(`data/${p}/${c}.json` + cb, {cache: "no-store"});
        if (r.ok) STATE.weeklyData[p][c] = await r.json();
      } catch(e) {}
    })
  ));
  EL.meta.textContent = `数据更新：${STATE.index.generated_at}`;
  renderAMButtons();
  renderPeriodButtons();
  initCustomRange();
  renderTabBar();
  await renderActiveTab();
}

function renderAMButtons() {
  EL.amButtons.innerHTML = "";
  ALL_AMS.forEach(am => {
    const btn = document.createElement("button");
    btn.textContent = am;
    if (am === STATE.currentAM) btn.classList.add("active");
    btn.onclick = async () => {
      STATE.currentAM = am;
      EL.amButtons.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      updateAMInfo();
      await renderActiveTab();
    };
    EL.amButtons.appendChild(btn);
  });
  updateAMInfo();
}
function updateAMInfo() {
  if (!EL.amInfo) return;
  if (STATE.currentAM === "全组") {
    EL.amInfo.innerHTML = `<span class="muted">全员视角（6 AM 合计）</span>`;
  } else {
    EL.amInfo.innerHTML = `<span>当前 AM：<b>${STATE.currentAM}</b></span>`;
  }
}

function renderPeriodButtons() {
  EL.periodButtons.innerHTML = "";
  STATE.index.periods.forEach(p => {
    const btn = document.createElement("button");
    btn.textContent = p.label;
    if (p.key === "yoy_bimonth") btn.classList.add("yoy-btn");
    if (p.key === STATE.currentPeriod) btn.classList.add("active");
    btn.onclick = async () => {
      STATE.currentPeriod = p.key;
      document.body.classList.toggle("period-yoy", p.key === "yoy_bimonth");
      EL.periodButtons.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      updatePeriodInfo();
      await renderActiveTab();
    };
    EL.periodButtons.appendChild(btn);
  });
  updatePeriodInfo();
}
function updatePeriodInfo() {
  const p = STATE.index.periods.find(x => x.key === STATE.currentPeriod);
  if (!p) return;
  EL.periodInfo.innerHTML = `<b>${p.start}</b> 至 <b>${p.end}</b>`;
}

// V9: 自定义时段（hero KPI 自由选段，chart 维持 8 时段）
function initCustomRange() {
  if (!EL.customRange) return;
  // 默认显示
  EL.customRange.style.display = "inline-flex";
  // 默认值 = last 14 days
  if (STATE.globalSeries && STATE.globalSeries.daily_dgmv) {
    const dates = STATE.globalSeries.daily_dgmv.map(r => r.date).sort();
    if (dates.length) {
      EL.customStart.value = dates[Math.max(0, dates.length-14)];
      EL.customEnd.value = dates[dates.length-1];
      EL.customStart.min = dates[0];
      EL.customStart.max = dates[dates.length-1];
      EL.customEnd.min = dates[0];
      EL.customEnd.max = dates[dates.length-1];
    }
  }
  EL.customApply.onclick = () => {
    const s = EL.customStart.value, e = EL.customEnd.value;
    if (!s || !e || s > e) { alert("请选择有效的日期范围"); return; }
    showCustomKPI(s, e);
  };
}

function showCustomKPI(start, end) {
  // 在主内容区顶部插入一个自定义 KPI 卡（不影响其他 chart）
  if (!STATE.globalSeries || !STATE.globalSeries.daily_dgmv) return;
  const series = STATE.globalSeries.daily_dgmv;
  const sumRange = (s, e) => {
    let total = 0, hit = 0;
    series.forEach(r => { if (r.date >= s && r.date <= e) { total += r.dgmv; hit++; } });
    return {sum: total, days: hit};
  };
  const cur = sumRange(start, end);
  const days = (function(){ const a = new Date(start), b = new Date(end); return Math.round((b-a)/86400000)+1; })();
  // 上一同长度时段
  const prevEnd = (function(){ const d = new Date(start); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
  const prevStart = (function(){ const d = new Date(prevEnd); d.setDate(d.getDate()-(days-1)); return d.toISOString().slice(0,10); })();
  const prev = sumRange(prevStart, prevEnd);
  const dod = (prev.sum > 0) ? (cur.sum - prev.sum) / prev.sum : null;

  // 移除已有的自定义卡
  const old = document.getElementById("custom-kpi-card");
  if (old) old.remove();

  const card = document.createElement("section");
  card.id = "custom-kpi-card";
  card.className = "summary-card";
  let dh = "";
  if (dod != null) {
    const cls = dod >= 0 ? "delta-up" : "delta-down";
    const arrow = dod >= 0 ? "↑" : "↓";
    const abs = Math.abs(dod);
    if (abs > 5) dh = `<span class='delta-abnormal'>异常</span>`;
    else if (abs > 1) dh = `<span class='${cls}'>${arrow} 显著 ${(abs*100).toFixed(0)}%</span>`;
    else dh = `<span class='${cls}'>${arrow} ${(abs*100).toFixed(1)}%</span>`;
  }
  card.innerHTML = `
    <div class='summary-header'>📅 自定义时段 KPI · 全组（仅 DGMV，chart 仍按上方时段）</div>
    <div class='summary-body'>
      <p><b>${start}</b> 至 <b>${end}</b>（${cur.days} 天）：DGMV <b>${fmt.money(cur.sum)}</b> ${dh}</p>
      <p class='muted'>对比上 ${days} 天（${prevStart} 至 ${prevEnd}）：${fmt.money(prev.sum)}</p>
      <p class='muted'>👉 自定义 KPI 用全组日序列计算，仅支持 DGMV；如需各 Tab 拆分，请用上方 8 个固定时段。</p>
    </div>
  `;
  EL.main.insertBefore(card, EL.main.firstChild);
  card.scrollIntoView({behavior: "smooth", block: "center"});
}

function renderTabBar() {
  EL.tabBar.innerHTML = "";
  STATE.index.tabs.forEach(t => {
    const btn = document.createElement("button");
    btn.textContent = t.name;
    if (t.key === STATE.currentTab) btn.classList.add("active");
    btn.onclick = async () => {
      STATE.currentTab = t.key;
      EL.tabBar.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      await renderActiveTab();
    };
    EL.tabBar.appendChild(btn);
  });
}

// ============ main render ============
async function renderActiveTab() {
  disposeAll();
  EL.main.innerHTML = `<div class="loading">加载中…</div>`;
  const tab = STATE.index.tabs.find(t => t.key === STATE.currentTab);
  if (!tab) return;
  const datas = await Promise.all(tab.charts.map(c => fetchData(STATE.currentPeriod, c.id)));
  EL.main.innerHTML = "";

  if (tab.key === "tab1_team_overview") {
    EL.main.appendChild(buildSummaryCard(datas, tab));  // V10: 业绩摘要（周报版）
    EL.main.appendChild(buildHeroKpis(datas.map(d => applyAMFilter(d))));
  }
  if (tab.key === "tab2_note") {
    EL.main.appendChild(buildNoteEfficiencyCard(datas, tab));  // V9: 勤奋度可比指标 + benchmark
    const bd = datas.find(d => d && d.chart_id === "t2_note_breakdown");
    if (bd) EL.main.appendChild(renderKpiGridCard(applyAMFilter(bd)));
  }
  if (tab.key === "tab3_live") {
    EL.main.appendChild(buildLiveBreakdownCard());  // V9: 店播 5 层乘数链
    EL.main.appendChild(buildLiveEfficiencyCard());  // V9.1: 店播勤奋度可比指标
  }
  if (tab.key === "tab4_kbroadcast") {
    const ov = datas.find(d => d && d.chart_id === "t4_k_overview");
    if (ov) EL.main.appendChild(renderKpiGridCard(ov));
  }
  if (tab.key === "tab6_seller") {
    EL.main.appendChild(buildNewSellerCard());  // V10: 新商家 by AM Top 5
  }

  tab.charts.forEach((cdef, i) => {
    const data = datas[i];
    if (!data) {
      EL.main.appendChild(emptyCard(cdef, "数据加载失败"));
      return;
    }
    if ((tab.key === "tab2_note" && cdef.id === "t2_note_breakdown") ||
        (tab.key === "tab4_kbroadcast" && cdef.id === "t4_k_overview") ||
        (tab.key === "tab3_live" && cdef.id === "t3_live_stopped")) {  // V9.1: 删店播商家清单
      return;
    }
    const filteredData = applyAMFilter(data);
    // 标记：AM 视角下，该 chart 无 AM 列 → 加"全组数据"角标
    const showFallbackBadge = (STATE.currentAM !== "全组") && (findAMColIdx(data && data.columns) < 0);
    EL.main.appendChild(renderChartCard(cdef, filteredData, {showFallbackBadge}));
  });
}

function emptyCard(cdef, msg) {
  const c = document.createElement("section");
  c.className = "chart-card";
  c.innerHTML = `<div class="chart-header"><div class="chart-title">${cdef.name}</div></div><div class="empty">${msg}</div>`;
  return c;
}

function renderChartCard(cdef, data, opts) {
  opts = opts || {};
  const card = document.createElement("section");
  card.className = "chart-card";
  const fallbackBadge = opts.showFallbackBadge
    ? `<span class="fallback-badge" title="该图表无 AM 维度，仍展示全组数据">⚠️ 全组数据</span>`
    : "";
  card.innerHTML = `
    <div class="chart-header">
      <div class="chart-title">${cdef.name} ${fallbackBadge}</div>
      <div class="chart-meta">
        <a href="${cdef.source_url}" target="_blank" rel="noopener">🔗 BI 原图</a>
      </div>
    </div>
  `;
  const body = document.createElement("div");
  body.className = "chart-body";
  card.appendChild(body);
  const cfg = data.config || {};
  const render = data.render;
  try {
    if (!data.rows || !data.rows.length) {
      body.innerHTML = `<div class="empty">该时段无数据</div>`;
    } else if (render === "donut_table_clean") renderers.donutTableClean(body, data, cfg);
    else if (render === "bar_h_byAM") renderers.barHByAM(body, data, cfg);
    else if (render === "bar_h_byAM_multi") renderers.barHByAMMulti(body, data, cfg);
    else if (render === "line_trend") renderers.lineTrend(body, data, cfg);
    else if (render === "rank_list") renderers.rankList(body, data, cfg);
    else if (render === "rank_list_note") renderers.rankListNote(body, data, cfg);
    else if (render === "card_grid") renderers.cardGrid(body, data, cfg);
    else if (render === "kpi_grid_from_total") renderers.kpiGridFromTotal(body, data, cfg);
    else if (render === "seller_change_cards") renderers.sellerChangeCards(body, data, cfg);
    else if (render === "category_treemap") renderers.categoryTreemap(body, data, cfg);
    else if (render === "category_treemap_value") renderers.categoryTreemapValue(body, data, cfg);
    else if (render === "category_change_table") renderers.categoryChangeTable(body, data, cfg);
    else if (render === "category_change_v2") renderers.categoryChangeV2(body, data, cfg);
    else if (render === "kpi_grid") body.appendChild(renderKpiGridCard(data).querySelector(".kpi-grid"));
    else if (render === "two_lists_change") renderers.twoListsChange(body, data, cfg);
    else if (render === "ams_count_grid") renderers.amsCountGrid(body, data, cfg);
    else renderers.fallbackTable(body, data, cfg);
  } catch (e) {
    console.error("render fail", cdef.id, e);
    body.innerHTML = `<div class="empty">渲染失败: ${e.message}</div>`;
  }
  return card;
}

// ============ Hero KPI（团队级，无大门偏向）============
function buildHeroKpis(datas) {
  const wrap = document.createElement("div");
  wrap.className = "hero-kpis";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;
  const isAM = STATE.currentAM !== "全组";
  const scopeLabel = isAM ? STATE.currentAM : "全组";

  // datas[0]: t1_yesterday_perf  -> 总 DGMV + 场域数（按场域分布，无 AM 列，AM 视角下不能用）
  // datas[1]: t1_bimonth_byAM   -> 按 AM 拆 + TGMV + DGMV
  // datas[3]: t1_bimonth_top_seller -> 商家数

  // ============ 1. 全组 DGMV / TGMV / 场域数 ============
  // AM 视角：从 byAM 中读对应 AM 的 DGMV/TGMV
  // 全组视角：从 yesterday_perf '总计' 行读 DGMV
  let totalGmv = "-", totalGmvNum = null, totalTgmv = null, scenes = "-";
  const byAM = datas[1];
  if (byAM && byAM.rows && byAM.rows.length) {
    const dimI = findColIdx(byAM.columns, "AM");
    const dgmvI = findColIdxLoose(byAM.columns, "DGMV");
    const tgmvI = findColIdx(byAM.columns, "TGMV");
    const rows = byAM.rows.filter(r => r[dimI] !== "总计");
    if (isAM) {
      const myRow = rows.find(r => r[dimI] === STATE.currentAM);
      if (myRow) {
        totalGmvNum = myRow[dgmvI];
        totalGmv = fmt.money(totalGmvNum);
        if (tgmvI >= 0) totalTgmv = myRow[tgmvI];
      }
    } else {
      totalGmvNum = rows.reduce((s,r)=>s+(r[dgmvI]||0),0);
      totalGmv = fmt.money(totalGmvNum);
      if (tgmvI >= 0) totalTgmv = rows.reduce((s,r)=>s+(r[tgmvI]||0), 0);
    }
  }
  // 全组视角下，scenes/totalGmv 优先从 yesterday_perf 取（更准）
  if (!isAM) {
    const yperf = datas[0];
    if (yperf && yperf.rows && yperf.rows.length) {
      const ci = findColIdxLoose(yperf.columns, "DGMV");
      const total = yperf.rows.find(r => r[0] === "总计");
      if (total) { totalGmvNum = total[ci]; totalGmv = fmt.money(totalGmvNum); }
      scenes = yperf.rows.filter(r => r[0] !== "总计").length;
    }
  } else {
    // AM 视角无场域细分 chart, 占位
    scenes = "-";
  }

  // ============ 2. 商家数 ============
  // 全组视角：用 distinct_counts (修复 100 行截断)
  // AM 视角：从 t1_bimonth_top_seller 数据 filter（已经被 applyAMFilter 过滤过）
  let sellerCount = "-";
  const sellerData = datas[3];
  if (isAM) {
    if (sellerData && sellerData.rows) {
      const dgmvI = findColIdxLoose(sellerData.columns, "DGMV");
      sellerCount = sellerData.rows.filter(r => r[0] !== "总计" && (r[dgmvI]||0) > 0).length;
    }
  } else {
    if (STATE.distinctCounts && STATE.distinctCounts[STATE.currentPeriod]) {
      sellerCount = STATE.distinctCounts[STATE.currentPeriod].seller_count;
    }
    if ((sellerCount === "-" || sellerCount == null) && sellerData && sellerData.rows) {
      const dgmvI = findColIdxLoose(sellerData.columns, "DGMV");
      sellerCount = sellerData.rows.filter(r => r[0] !== "总计" && (r[dgmvI]||0) > 0).length;
    }
  }

  // ============ 3. 周期天数 + 日均 ============
  const period = STATE.index.periods.find(p => p.key === STATE.currentPeriod);
  const days = (function(){
    if (!period) return 1;
    const s = new Date(period.start); const e = new Date(period.end);
    return Math.max(1, Math.round((e - s)/86400000)+1);
  })();

  // ============ 4. 自算环比 ============
  // 注意：日序列是全组的，AM 视角下无法精确算环比，所以 AM 视角时不显示环比
  let deltaPct = null, deltaLabel = "vs 上期";
  if (!isAM && STATE.globalSeries && STATE.globalSeries.daily_dgmv && period) {
    const series = STATE.globalSeries.daily_dgmv;
    const sumRange = (start, end) => {
      let total = 0, hit = 0;
      series.forEach(r => {
        if (r.date >= start && r.date <= end) { total += r.dgmv; hit++; }
      });
      return hit > 0 ? total : null;
    };
    const addDays = (d, n) => {
      const dt = new Date(d); dt.setDate(dt.getDate() + n);
      return dt.toISOString().slice(0,10);
    };
    const periodLen = days;
    const curSum = sumRange(period.start, period.end);
    let prevStart, prevEnd;
    if (period.key === "yesterday") {
      prevStart = prevEnd = addDays(period.start, -1);
      deltaLabel = "vs 前一日";
    } else if (period.key === "yoy_bimonth") {
      prevStart = null;
    } else {
      prevEnd = addDays(period.start, -1);
      prevStart = addDays(prevEnd, -(periodLen - 1));
      deltaLabel = `vs 上${periodLen}天`;
    }
    if (prevStart) {
      const prevSum = sumRange(prevStart, prevEnd);
      if (prevSum && prevSum > 0 && curSum != null) {
        deltaPct = (curSum - prevSum) / prevSum;
      }
    }
  }

  // ============ 卡片清单 ============
  const items = [];
  items.push({label: `${periodLabel} · ${scopeLabel} DGMV`, value: totalGmv,
    delta: deltaPct, deltaLabel});
  if (totalTgmv != null) {
    items.push({label: `${periodLabel} · ${scopeLabel} TGMV`, value: fmt.money(totalTgmv)});
  }
  items.push({label: "日均 DGMV", value: totalGmvNum != null ? fmt.money(totalGmvNum/days) : "-", sub: `${days} 天`});
  if (!isAM) {
    items.push({label: "动销商家数", value: (sellerCount === "-" || sellerCount == null) ? "-" : sellerCount + " 家"});
  } else {
    items.push({label: `${STATE.currentAM} 名下动销商家`, value: (sellerCount === "-" || sellerCount == null) ? "-" : sellerCount + " 家"});
  }
  if (!isAM && scenes !== "-") {
    items.push({label: "覆盖场域", value: scenes + " 个"});
  }

  items.forEach(it => {
    const c = document.createElement("div");
    c.className = "kpi-card hero";
    let dh = "";
    if (it.delta != null && typeof it.delta === "number" && !isNaN(it.delta)) {
      const abs = Math.abs(it.delta);
      const cls = it.delta >= 0 ? "delta-up" : "delta-down";
      const arrow = it.delta >= 0 ? "↑" : "↓";
      if (abs > 5) {
        dh = `<div class="delta delta-abnormal">${it.deltaLabel||""} 异常</div>`;
      } else if (abs > 1) {
        dh = `<div class="delta ${cls}">${arrow}${(abs*100).toFixed(0)}%<span class="muted-mini"> 显著</span> ${it.deltaLabel||""}</div>`;
      } else {
        dh = `<div class="delta ${cls}">${arrow} ${(abs*100).toFixed(1)}% ${it.deltaLabel||""}</div>`;
      }
    }
    let sh = it.sub ? `<div class="sub">${it.sub}</div>` : "";
    c.innerHTML = `<div class="label">${it.label}</div><div class="value">${it.value}</div>${dh}${sh}`;
    wrap.appendChild(c);
  });
  return wrap;
}

// ============ V9 新增模块 ============
function buildSummaryCard(datas, tab) {
  // V10: 周报版 Summary — 对标休食周报模板，AM/团队双视角
  const card = document.createElement("section");
  card.className = "summary-card weekly-report";
  const isAM = STATE.currentAM !== "全组";
  const scope = isAM ? STATE.currentAM : "五组（休食）全组";
  const sm = STATE.summary || {};

  // ============= 数据准备：always 用 last_7d + this_bimonth =============
  // 不管当前 period，固定算上周+本双月（周报真实场景）
  // 数据从 STATE.weeklyData 缓存里取（init 时预加载）
  const wd = STATE.weeklyData || {};
  const last7 = wd.last_7d || {};
  const bimonth = wd.this_bimonth || {};

  // 提取函数
  const findCol = (cols, name) => {
    if (!cols) return -1;
    return cols.findIndex(c => c === name || (c && c.startsWith(name)));
  };
  const getAMRow = (data, am) => {
    if (!data || !data.rows) return null;
    const ai = findCol(data.columns, "AM");
    if (ai < 0) return null;
    return data.rows.find(r => r[ai] === am);
  };
  const getTotalRow = (data) => {
    if (!data || !data.rows) return null;
    const ai = findCol(data.columns, "AM");
    if (ai < 0) return data.rows[0];
    return data.rows.find(r => r[ai] === "总计") || null;
  };
  const sumDGMV = (data, am, kw) => {
    // 通用：拿某行某列
    if (!data) return null;
    const cols = data.columns;
    const dgmvI = cols.findIndex(c => c && c.includes(kw) && !c.includes("环比") && !c.includes("年同比") && !c.includes("_1") && !c.includes("_2"));
    if (dgmvI < 0) return null;
    const row = am ? getAMRow(data, am) : getTotalRow(data);
    return row ? row[dgmvI] : null;
  };

  const am = isAM ? STATE.currentAM : null;  // null → 取"总计" 行

  // 笔记：DGMV / 环比 / 新发笔记数 / 曝光量 / 曝光环比
  const noteData7 = last7.t2_note_byAM, noteDataM = bimonth.t2_note_byAM;
  const note7 = (function(){
    if (!noteData7) return {};
    const cols = noteData7.columns;
    const row = am ? getAMRow(noteData7, am) : getTotalRow(noteData7);
    if (!row) return {};
    const findIdx = (kw, off=0) => {
      let cnt = 0;
      for (let i = 0; i < cols.length; i++) {
        if (cols[i] === kw || (cols[i] && cols[i].startsWith(kw + "_"))) {
          if (cnt === off) return i;
          cnt++;
        }
      }
      return -1;
    };
    return {
      dgmv: row[findCol(cols, "商笔DGMV")],
      wow: row[findCol(cols, "环比上期_环比-变化率")],  // 商笔DGMV 环比
      notes: row[findCol(cols, "新发商笔数")],
      exposure: row[findCol(cols, "商笔曝光量")],
    };
  })();

  // 店播：DGMV / 环比 / 时长 / 开播商家数
  const liveData7 = last7.t3_live_byAM;
  const live7 = (function(){
    if (!liveData7) return {};
    const cols = liveData7.columns;
    const row = am ? getAMRow(liveData7, am) : getTotalRow(liveData7);
    if (!row) return {};
    const dgmv = row[findCol(cols, "店播DGMV")];
    const wow = row[findCol(cols, "环比上期_环比-变化率")];
    const dur = row[findCol(cols, "店播--开播时长（小时）")];
    return { dgmv, wow, duration_h: dur };
  })();
  // 从 _live_breakdown 拿开播商家数
  const lb7 = (STATE.liveBreakdown || {}).last_7d || {};
  const lbScope = lb7[am || "全组"] || {};

  // K播：DGMV / 环比
  const kData7 = last7.t4_k_overview;
  const k7 = (function(){
    if (!kData7 || !kData7.rows || !kData7.rows[0]) return {};
    const cols = kData7.columns, r = kData7.rows[0];
    return {
      dgmv: r[findCol(cols, "DGMV（元）")],
      wow: r[findCol(cols, "DGMV（元）_环比-变化率")],
      anchors: r[findCol(cols, "动销主播数")],
      sessions: r[findCol(cols, "动销场次数")],
    };
  })();

  // 本双月 MTD DGMV
  const bimAMData = bimonth.t1_bimonth_byAM;
  const mtd = (function(){
    if (!bimAMData) return {};
    const cols = bimAMData.columns;
    const dgmvI = cols.findIndex(c => c && c.startsWith("DGMV"));
    const tgmvI = cols.findIndex(c => c === "TGMV");
    if (am) {
      const row = getAMRow(bimAMData, am);
      if (!row) return {};
      return { dgmv: row[dgmvI], tgmv: tgmvI>=0 ? row[tgmvI] : null };
    } else {
      // 总和
      const ai = findCol(cols, "AM");
      const dgmv = bimAMData.rows.filter(r => r[ai] !== "总计").reduce((s,r)=>s+(r[dgmvI]||0),0);
      const tgmv = tgmvI>=0 ? bimAMData.rows.filter(r => r[ai] !== "总计").reduce((s,r)=>s+(r[tgmvI]||0),0) : null;
      return { dgmv, tgmv };
    }
  })();
  // 时间进度
  const now = new Date();
  const bimStart = new Date(STATE.index.periods.find(p=>p.key==="this_bimonth").start);
  const bimEnd = new Date();
  bimEnd.setDate(1); bimEnd.setMonth(bimEnd.getMonth() + (bimEnd.getMonth()%2===0?2:1)); // 双月末
  const totalDays = Math.ceil((bimEnd - bimStart) / 86400000);
  const passedDays = Math.floor((now - bimStart) / 86400000);
  const timePct = passedDays / totalDays;

  // 笔记 last_7d 环比
  const noteDGMV = note7.dgmv || 0;
  // 笔记年同比/环比
  // ============= 渲染文本 =============
  const fmtMoney = v => v == null ? "—" : fmt.money(v);
  const fmtPct = v => v == null || isNaN(v) ? "—" : (v >= 0 ? "+" : "") + (v*100).toFixed(1) + "%";
  const trend = v => {
    if (v == null || isNaN(v)) return '<span class="muted">—</span>';
    const cls = v >= 0 ? "delta-up" : "delta-down";
    const arrow = v >= 0 ? "↑" : "↓";
    const abs = Math.abs(v);
    if (abs > 5) return '<span class="delta-abnormal">异常</span>';
    return '<span class="' + cls + '">' + arrow + (abs*100).toFixed(1) + '%</span>';
  };
  // 周日期范围
  const wrange = STATE.index.periods.find(p => p.key === "last_7d");
  const weekLabel = wrange ? (wrange.start + " ~ " + wrange.end) : "上周";

  const body = `
    <div class="wr-section">
      <div class="wr-section-title">📊 0、双月 DGMV 目标达成</div>
      <div class="wr-line">
        <b>MTD 达成 ${fmtMoney(mtd.dgmv)}</b>${mtd.tgmv ? ' · TGMV ' + fmtMoney(mtd.tgmv) : ''}，
        时间进度 ${(timePct*100).toFixed(1)}%
      </div>
    </div>
    <div class="wr-section">
      <div class="wr-section-title">🎯 1、场域进展（${weekLabel}）</div>
      <div class="wr-channel">
        <div class="wr-channel-name">🎬 店播</div>
        <div class="wr-line">
          DGMV <b>${fmtMoney(live7.dgmv)}</b> ${trend(live7.wow)}（环比上 7 天）
        </div>
        <div class="wr-sub">
          开播商家数 <b>${lbScope.live_seller_count != null ? lbScope.live_seller_count : "—"}</b> 家 ·
          开播时长 <b>${lbScope.duration_h ? Math.round(lbScope.duration_h) : "—"}</b> h ·
          CTR <b>${lbScope.ctr ? (lbScope.ctr*100).toFixed(2) + "%" : "—"}</b> ·
          客单价 <b>${lbScope.aov ? "¥" + Math.round(lbScope.aov) : "—"}</b>
        </div>
      </div>
      <div class="wr-channel">
        <div class="wr-channel-name">📺 K 播</div>
        <div class="wr-line">
          DGMV <b>${fmtMoney(k7.dgmv)}</b> ${trend(k7.wow)}（环比上 7 天）
          ${isAM ? '<span class="muted-mini"> · K 播暂无 AM 拆分，全组数据</span>' : ''}
        </div>
        <div class="wr-sub">
          动销主播 <b>${k7.anchors || "—"}</b> 位 · 动销场次 <b>${k7.sessions || "—"}</b> 场
        </div>
      </div>
      <div class="wr-channel">
        <div class="wr-channel-name">📝 商笔</div>
        <div class="wr-line">
          DGMV <b>${fmtMoney(note7.dgmv)}</b> ${trend(note7.wow)}（环比上 7 天）
        </div>
        <div class="wr-sub">
          新发笔记 <b>${note7.notes != null ? Math.round(note7.notes).toLocaleString() : "—"}</b> 篇 ·
          曝光量 <b>${note7.exposure != null ? fmtMoney(note7.exposure).replace('¥','') : "—"}</b> PV
        </div>
      </div>
    </div>
    <div class="wr-section">
      <div class="wr-section-title">📦 2、新商</div>
      ${(function(){
        const ns = STATE.newSeller || {};
        const new30d = (ns.new_30d && ns.new_30d.count) ? ns.new_30d.count[am || "全组"] : null;
        const new2026 = (ns.new2026_active && ns.new2026_active.count) ? ns.new2026_active.count[am || "全组"] : null;
        const new2026DGMV = (ns.new2026_active && ns.new2026_active.dgmv) ? ns.new2026_active.dgmv[am || "全组"] : null;
        if (new30d == null && new2026 == null) {
          return '<div class="wr-line muted">⚠️ 暂无新商家数据</div>';
        }
        return `
          <div class="wr-line">
            近 30 天新开商家 <b>${new30d != null ? new30d : "—"}</b> 家
          </div>
          <div class="wr-line">
            2026 年新开商家本月动销 <b>${new2026 != null ? new2026 : "—"}</b> 家 ·
            贡献 GMV <b>${new2026DGMV != null ? fmtMoney(new2026DGMV) : "—"}</b>
          </div>
        `;
      })()}
    </div>
    <div class="wr-footer muted">
      📌 ${isAM ? "当前 AM 视角，所有数字为大门个人名下商家" : "全组合计视角"} ·
      可直接截图作为周报「业绩部分」内容 ·
      详细数据请切换上方时段/Tab 查看
    </div>
  `;

  card.innerHTML = `
    <div class="summary-header">📋 业绩摘要（周报版）· ${scope}</div>
    <div class="summary-body">${body}</div>
  `;
  return card;
}

function buildNewSellerCard() {
  // V10: 新商家 by AM Top 5（动销新商家清单）
  // 数据来源：当前 period 的 t6_new_active chart
  const card = document.createElement("section");
  card.className = "chart-card new-seller-card";
  const isAM = STATE.currentAM !== "全组";
  const scope = isAM ? STATE.currentAM : "全组";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;
  const data = STATE.cache[`${STATE.currentPeriod}/t6_new_active`];

  if (!data || !data.rows) {
    card.innerHTML = `<div class='chart-header'><div class='chart-title'>🆕 新商家动销 Top（by AM）</div></div>
      <div class='empty'>当前时段无新商家数据</div>`;
    return card;
  }

  const cols = data.columns;
  const ai = cols.findIndex(c => c === "AM");
  const ni = cols.findIndex(c => c === "商家名称");
  const sidI = cols.findIndex(c => c === "商家ID");
  const gi = cols.findIndex(c => c === "DGMV " || c === "DGMV");
  const rows = data.rows.filter(r => r[ai] && r[ai] !== "总计" && r[ni] && (r[gi]||0) > 0);

  // by AM Top 5
  const byAM = {};
  rows.forEach(r => {
    const am = r[ai];
    if (!byAM[am]) byAM[am] = [];
    byAM[am].push(r);
  });
  Object.keys(byAM).forEach(am => {
    byAM[am] = byAM[am].sort((a,b)=>(b[gi]||0)-(a[gi]||0)).slice(0,5);
  });

  // 新商总数（来自 _new_seller）
  const ns = STATE.newSeller || {};
  const new30d = (ns.new_30d && ns.new_30d.count) ? ns.new_30d.count[scope] : null;
  const new2026 = (ns.new2026_active && ns.new2026_active.count) ? ns.new2026_active.count[scope] : null;
  const new2026DGMV = (ns.new2026_active && ns.new2026_active.dgmv) ? ns.new2026_active.dgmv[scope] : null;

  let cardListHTML = "";
  const orderedAMs = isAM ? [STATE.currentAM] : ["大门(朱锦程)","蕾塞(张嘉悦)","莱拉(付艺迪)","路歌(李红红)","秋罗(胡春秋)","诺亚(单恩浩)"];
  orderedAMs.forEach(am => {
    const list = byAM[am] || [];
    if (!list.length && !isAM) return;
    const items = list.length ? list.map((r,i) => {
      const sname = r[ni];
      const sid = r[sidI];
      const sgmv = r[gi];
      const url = sid ? `https://crm.xiaohongshu.com/eccrm/merchant-detail/${sid}?isSellerId=true&type=basicInfo` : "#";
      return `<li><span class='ns-rank'>${i+1}</span> <a href="${url}" target="_blank" rel="noopener">${sname}</a> <span class='ns-gmv'>${fmt.money(sgmv)}</span></li>`;
    }).join("") : '<li class="muted">暂无</li>';
    cardListHTML += `
      <div class="ns-am-card">
        <div class="ns-am-name">${am}</div>
        <ol class="ns-list">${items}</ol>
      </div>
    `;
  });

  const headerStats = `
    <div class="ns-stats">
      <span>近 30 天新开 <b>${new30d != null ? new30d : "—"}</b> 家</span>
      <span>· 2026 新开本月动销 <b>${new2026 != null ? new2026 : "—"}</b> 家</span>
      ${new2026DGMV != null ? `<span>· 贡献 <b>${fmt.money(new2026DGMV)}</b></span>` : ""}
    </div>
  `;

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>🆕 新商家动销 Top（by AM）· ${scope}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    ${headerStats}
    <div class="ns-grid">${cardListHTML}</div>
    <div class='bd-tip muted'>💡 点击商家名跳转苍穹后台；新商起量是周报"新商"模块的核心数据。</div>
  `;
  return card;
}

function buildLiveBreakdownCard() {
  // 店播 5 层乘数链：开播时长 → 单位时长曝光 → CTR → CVR → 客单价
  const card = document.createElement("section");
  card.className = "chart-card live-breakdown-card";
  const lb = STATE.liveBreakdown || {};
  const periodData = lb[STATE.currentPeriod] || {};
  const isAM = STATE.currentAM !== "全组";
  const scope = isAM ? STATE.currentAM : "全组";
  const data = periodData[scope];

  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;

  if (!data) {
    card.innerHTML = `
      <div class='chart-header'><div class='chart-title'>📺 店播效率拆解 · ${scope}</div></div>
      <div class='empty'>暂无 ${periodLabel} ${scope} 店播拆解数据</div>
    `;
    return card;
  }

  // 5 层乘数：
  // L1 开播时长(h) → L2 曝光/h → L3 CTR(购买PV/曝光PV) → L4 CVR(购买/观播) → L5 客单价 → DGMV
  const fmtN = (v, digits=0) => v == null ? "—" : v.toLocaleString("zh-CN",{maximumFractionDigits:digits});
  const fmtPct = (v) => v == null ? "—" : (v*100).toFixed(2) + "%";

  // 全组对比（AM 视角下显示 vs 全组的差异）
  const allGroup = periodData["全组"] || {};
  const cmp = (key) => {
    if (!isAM || !allGroup[key] || !data[key]) return "";
    const ratio = data[key] / (allGroup[key] / 6);  // vs 全组人均
    if (ratio > 1.1) return `<span class='delta-up muted-mini'>高于全组人均 ${((ratio-1)*100).toFixed(0)}%</span>`;
    if (ratio < 0.9) return `<span class='delta-down muted-mini'>低于全组人均 ${((1-ratio)*100).toFixed(0)}%</span>`;
    return `<span class='muted-mini'>≈ 全组人均</span>`;
  };

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>📺 店播效率拆解 · ${scope}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    <div class='breakdown-chain'>
      <div class='bd-step'>
        <div class='bd-num'>${fmtN(data.duration_h, 0)} h</div>
        <div class='bd-label'>① 总开播时长</div>
        <div class='bd-cmp'>${cmp("duration_h")}</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtN(data.exposure_per_hour, 0)}</div>
        <div class='bd-label'>② 单位时长曝光 PV/h</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtPct(data.ctr)}</div>
        <div class='bd-label'>③ 购买 CTR<br/><span class='muted-mini'>(购买PV/曝光PV)</span></div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtPct(data.cvr)}</div>
        <div class='bd-label'>④ UV 转化率</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${data.aov != null ? "¥" + fmtN(data.aov, 0) : "—"}</div>
        <div class='bd-label'>⑤ 客单价</div>
      </div>
      <div class='bd-arrow'>=</div>
      <div class='bd-step bd-result'>
        <div class='bd-num'>${data.dgmv != null ? fmt.money(data.dgmv) : "—"}</div>
        <div class='bd-label'>店播 DGMV</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 5 层乘数链定位短板：哪一层显著低于行业/全组均值，就是优化重点。</div>
  `;
  return card;
}

function buildLiveEfficiencyCard() {
  // 店播勤奋度可比指标（老板要求：去掉绝对值，全用占比/比率/平均）
  const card = document.createElement("section");
  card.className = "chart-card live-efficiency-card";
  const lb = STATE.liveBreakdown || {};
  const periodData = lb[STATE.currentPeriod] || {};
  const isAM = STATE.currentAM !== "全组";
  const scope = isAM ? STATE.currentAM : "全组";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;
  const data = periodData[scope];
  const allGroup = periodData["全组"];

  // 名下总商家数 (来自 _am_seller_counts) - 用于"开播商家占比"
  const ascAll = (STATE.amSellerCounts || {})[STATE.currentPeriod] || {};
  const totalSellers = ascAll[scope];

  // hero KPI 中的全组 DGMV，用于"店播 GMV 占比"
  // 简化：用 _summary 或 _global_series 的 7d 均估算；这里用当前时段总 DGMV
  let totalDGMV = null;
  if (allGroup && allGroup.dgmv) {
    if (isAM && data && data.dgmv) {
      // AM 视角：用大盘（datas 里 t1_bimonth_byAM 总 DGMV）
      // 简化：用 noteByAM 总 + live 总
      totalDGMV = data._scope_total_dgmv || null;  // 可选 inject
    } else {
      // 全组：直接用 hero 总 DGMV，但暂不取，用 live DGMV 算店播占比
      totalDGMV = null;
    }
  }

  if (!data) {
    card.innerHTML = `
      <div class='chart-header'><div class='chart-title'>🎯 店播勤奋度（可比指标）· ${scope}</div></div>
      <div class='empty'>暂无 ${periodLabel} ${scope} 店播勤奋度数据</div>
    `;
    return card;
  }

  const fmtN = (v, d=0) => v == null ? "—" : v.toLocaleString("zh-CN",{maximumFractionDigits:d});
  const fmtPct = (v) => v == null ? "—" : (v*100).toFixed(2) + "%";

  // 6 个可比指标
  const liveSellerCount = data.live_seller_count;
  const openRatio = (liveSellerCount && totalSellers) ? liveSellerCount / totalSellers : null;
  const avgDurationPerSeller = (data.duration_h && liveSellerCount) ? data.duration_h / liveSellerCount : null;
  const expPerHour = data.exposure_per_hour;
  const ctr = data.ctr;
  const cvr = data.cvr;
  const aov = data.aov;

  // 对比：vs 全组人均
  const cmp = (key, val) => {
    if (!isAM || !allGroup) return "";
    let benchVal = null;
    if (key === "openRatio") {
      benchVal = (allGroup.live_seller_count && ascAll["全组"]) ? allGroup.live_seller_count / ascAll["全组"] : null;
    } else if (key === "avgDurationPerSeller") {
      benchVal = (allGroup.duration_h && allGroup.live_seller_count) ? allGroup.duration_h / allGroup.live_seller_count : null;
    } else {
      benchVal = allGroup[key];
    }
    if (!benchVal || !val) return "";
    const ratio = val / benchVal;
    if (ratio > 1.1) return `<span class='delta-up muted-mini'>↑ 高于全组 ${((ratio-1)*100).toFixed(0)}%</span>`;
    if (ratio < 0.9) return `<span class='delta-down muted-mini'>↓ 低于全组 ${((1-ratio)*100).toFixed(0)}%</span>`;
    return `<span class='muted-mini'>≈ 全组</span>`;
  };

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>🎯 店播勤奋度（可比指标）· ${scope}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    <div class='efficiency-grid'>
      <div class='eff-cell highlight'>
        <div class='eff-label'>① 开播商家占比<span class='hint'>（覆盖率）</span></div>
        <div class='eff-num'>${fmtPct(openRatio)}</div>
        <div class='eff-sub'>${liveSellerCount != null ? fmtN(liveSellerCount) : "—"} / ${totalSellers != null ? fmtN(totalSellers) : "—"} 家 · ${cmp("openRatio", openRatio)}</div>
      </div>
      <div class='eff-cell highlight'>
        <div class='eff-label'>② 商均开播时长<span class='hint'>（投入度）</span></div>
        <div class='eff-num'>${fmtN(avgDurationPerSeller, 0)}<span class='unit'> h/商家</span></div>
        <div class='eff-sub'>${cmp("avgDurationPerSeller", avgDurationPerSeller)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>③ 单位时长曝光</div>
        <div class='eff-num'>${fmtN(expPerHour, 0)}<span class='unit'> PV/h</span></div>
        <div class='eff-sub'>${cmp("exposure_per_hour", expPerHour)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>④ 购买 CTR</div>
        <div class='eff-num'>${fmtPct(ctr)}</div>
        <div class='eff-sub'>${cmp("ctr", ctr)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>⑤ UV 转化率</div>
        <div class='eff-num'>${fmtPct(cvr)}</div>
        <div class='eff-sub'>${cmp("cvr", cvr)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>⑥ 客单价</div>
        <div class='eff-num'>${aov != null ? "¥" + fmtN(aov, 0) : "—"}</div>
        <div class='eff-sub'>${cmp("aov", aov)}</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 与"店播商家清单"绝对值不同，这里指标都已归一化，可横向对比 AM。</div>
  `;
  return card;
}

function buildNoteEfficiencyCard(datas, tab) {
  // 勤奋度可比指标：商家平均发笔记数 / 笔记平均曝光 / CVR vs 全平台 benchmark
  const card = document.createElement("section");
  card.className = "chart-card note-efficiency-card";
  const isAM = STATE.currentAM !== "全组";
  const scope = isAM ? STATE.currentAM : "全组";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;

  // 数据源：
  // _am_seller_counts[period][scope] -> 名下动销商家数
  // datas (按 chart 顺序) -> 找 t2_note_byAM / t2_note_breakdown
  // _note_benchmark[period] -> 全平台 CVR
  const ascAll = (STATE.amSellerCounts || {})[STATE.currentPeriod] || {};
  const sellerCount = ascAll[scope];

  // 从 datas 数组里找 chart（不依赖 cache 时机）
  const findData = (cid) => {
    if (!tab || !tab.charts) return null;
    const idx = tab.charts.findIndex(c => c.id === cid);
    return idx >= 0 ? datas[idx] : null;
  };
  const noteByAM = findData("t2_note_byAM");
  const noteBd = findData("t2_note_breakdown");
  let noteCount = null, exposure = null, dgmv = null, cvr = null;
  if (noteByAM && noteByAM.rows) {
    const cols = noteByAM.columns;
    const findIdx = (kw) => {
      for (let i = 0; i < cols.length; i++) {
        if (String(cols[i] || "").includes(kw)) return i;
      }
      return -1;
    };
    const ai = findIdx("AM");
    const dgmvI = findIdx("商笔DGMV");
    const cntI = findIdx("新发商笔数");
    const expI = findIdx("商笔曝光量");
    if (isAM) {
      const myRow = noteByAM.rows.find(r => r[ai] === STATE.currentAM);
      if (myRow) {
        dgmv = myRow[dgmvI]; noteCount = myRow[cntI]; exposure = myRow[expI];
      }
    } else {
      const tot = noteByAM.rows.find(r => r[ai] === "总计");
      if (tot) {
        dgmv = tot[dgmvI]; noteCount = tot[cntI]; exposure = tot[expI];
      }
    }
  }
  if (noteBd && noteBd.rows && noteBd.rows[0]) {
    const bdCols = noteBd.columns;
    const cvrI = bdCols.findIndex(c => c.includes("商品转化率") && !c.includes("环比") && !c.includes("年同比"));
    if (cvrI >= 0) cvr = noteBd.rows[0][cvrI];
  }

  const benchmark = (STATE.noteBenchmark || {})[STATE.currentPeriod] || {};
  const benchCvr = benchmark.cvr;
  const benchCtr = benchmark.ctr;
  // 五组的 CTR：从 t2_note_breakdown 取
  let ctr = null;
  if (noteBd && noteBd.rows && noteBd.rows[0]) {
    const ctrI = noteBd.columns.findIndex(c => c && c.includes("阅读率") && !c.includes("环比") && !c.includes("年同比"));
    if (ctrI >= 0) ctr = noteBd.rows[0][ctrI];
  }

  const avgPerSeller = (sellerCount && noteCount) ? noteCount / sellerCount : null;
  const avgExpPerNote = (noteCount && exposure) ? exposure / noteCount : null;
  const fmtN = (v, digits=1) => v == null ? "—" : v.toLocaleString("zh-CN",{maximumFractionDigits:digits});
  const fmtPct = (v) => v == null ? "—" : (v*100).toFixed(2) + "%";

  // CTR / CVR vs benchmark
  const cmpVsBench = (val, bench) => {
    if (val == null || !bench) return "";
    const ratio = val / bench;
    if (ratio > 1.05) return `<span class='delta-up'>↑ 高于全平台 ${((ratio-1)*100).toFixed(0)}%</span>`;
    if (ratio < 0.95) return `<span class='delta-down'>↓ 低于全平台 ${((1-ratio)*100).toFixed(0)}%</span>`;
    return `<span class='muted'>≈ 全平台</span>`;
  };
  const ctrCmp = cmpVsBench(ctr, benchCtr);
  const cvrCmp = cmpVsBench(cvr, benchCvr);

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>📝 商品笔记勤奋度 · 可比指标 · ${scope}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    <div class='efficiency-grid'>
      <div class='eff-cell'>
        <div class='eff-label'>📚 名下动销商家</div>
        <div class='eff-num'>${sellerCount != null ? sellerCount : "—"}<span class='unit'> 家</span></div>
      </div>
      <div class='eff-cell highlight'>
        <div class='eff-label'>① 商家平均发商品笔记数<span class='hint'>（数量勤奋度）</span></div>
        <div class='eff-num'>${avgPerSeller != null ? fmtN(avgPerSeller, 1) : "—"}<span class='unit'> 篇/商家</span></div>
        <div class='eff-sub muted'>共 ${noteCount != null ? fmtN(noteCount, 0) : "—"} 篇</div>
      </div>
      <div class='eff-cell highlight'>
        <div class='eff-label'>② 笔记平均曝光<span class='hint'>（质量勤奋度）</span></div>
        <div class='eff-num'>${avgExpPerNote != null ? fmtN(avgExpPerNote/1000, 1) : "—"}<span class='unit'>k PV/篇</span></div>
        <div class='eff-sub muted'>总曝光 ${exposure != null ? fmt.money(exposure).replace("¥","") : "—"} PV</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>③ 笔记 CTR<span class='hint'>（曝光→商详）</span></div>
        <div class='eff-num'>${fmtPct(ctr)}</div>
        <div class='eff-sub'>${ctrCmp || `<span class='muted'>—</span>`}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>④ 笔记 CVR<span class='hint'>（商详→购买）</span></div>
        <div class='eff-num'>${fmtPct(cvr)}</div>
        <div class='eff-sub'>${cvrCmp || `<span class='muted'>—</span>`}</div>
      </div>
      <div class='eff-cell benchmark-cell'>
        <div class='eff-label'>📊 全平台 benchmark</div>
        <div class='eff-num benchmark'>${fmtPct(benchCtr)} / ${fmtPct(benchCvr)}</div>
        <div class='eff-sub muted'>CTR / CVR · 全平台均值</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 数量勤奋度（商家平均发笔记数）+ 质量勤奋度（笔记平均曝光 / CTR / CVR）；红/绿对比全平台 benchmark。</div>
  `;
  return card;
}

// ============ 渲染器 ============
const renderers = {};

renderers.donutTableClean = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = findColIdx(data.columns, cfg.rate);
  let rows = data.rows.filter(r => r[dimI] !== "总计");
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const total = rows.reduce((s,r)=>s+(r[valI]||0),0);

  const grid = document.createElement("div");
  grid.className = "grid-donut";
  const chartBox = document.createElement("div");
  chartBox.className = "echarts-box";
  chartBox.style.height = "320px";
  grid.appendChild(chartBox);

  const tbl = document.createElement("div");
  tbl.className = "side-table";
  let html = `<table class="data-table"><thead><tr><th>场域</th><th class="num">DGMV</th><th class="num">占比</th><th class="num">环比</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const v = r[valI];
    const rate = rateI>=0 ? r[rateI] : null;
    const pct = total > 0 ? (v/total*100).toFixed(1)+"%" : "-";
    html += `<tr><td>${r[dimI]}</td><td class="num">${fmt.money(v)}</td><td class="num">${pct}</td><td class="num">${renderDelta(rate)}</td></tr>`;
  });
  html += "</tbody></table>";
  tbl.innerHTML = html;
  grid.appendChild(tbl);
  body.appendChild(grid);

  setTimeout(()=>{
    const c = echarts.init(chartBox);
    STATE.echarts.push(c);
    c.setOption({
      tooltip: {trigger:"item", formatter: p => `${p.name}<br><b>${fmt.money(p.value)}</b> (${p.percent}%)`},
      legend: {orient:"horizontal", bottom: 0, type: "scroll", textStyle: {fontSize: 11}},
      series: [{
        type: "pie",
        radius: ["45%","72%"],
        center: ["50%","45%"],
        avoidLabelOverlap: true,
        itemStyle: {borderRadius: 6, borderColor:"#fff", borderWidth: 2},
        label: {show: true, formatter: "{b}\n{d}%", fontSize: 11},
        data: rows.map((r,i)=>({name: r[dimI], value: r[valI], itemStyle:{color: PALETTE[i%PALETTE.length]}}))
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

renderers.barHByAM = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  let rows = data.rows.filter(r => r[dimI] !== "总计");
  const vals = (cfg.values||[]).map(([col,name]) => ({col, name, idx: findColIdxLoose(data.columns, col)}));
  if (vals[0]) rows = rows.sort((a,b)=>(b[vals[0].idx]||0)-(a[vals[0].idx]||0));
  const dims = rows.map(r => r[dimI]);

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = (Math.max(rows.length*46, 220)) + "px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echarts.push(c);
    c.setOption({
      tooltip: {trigger:"axis", axisPointer:{type:"shadow"}, formatter: params => {
        return params[0].name + "<br>" + params.map(p=>`${p.marker}${p.seriesName}: <b>${fmt.money(p.value)}</b>`).join("<br>");
      }},
      legend: {top: 0, textStyle: {fontSize: 12}},
      grid: {left: 80, right: 90, top: 30, bottom: 20, containLabel: true},
      xAxis: {type: "value", axisLabel: {formatter: v => fmt.money(v)}},
      yAxis: {type: "category", data: dims, inverse: true, axisLabel: {fontSize: 12}},
      series: vals.map((v,i)=>({
        name: v.name, type:"bar",
        data: rows.map(r => r[v.idx]),
        itemStyle: {color: PALETTE[i]},
        label: {show: true, position: "right", formatter: p => fmt.money(p.value), fontSize: 11},
      }))
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

renderers.barHByAMMulti = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  let rows = data.rows.filter(r => r[dimI] !== "总计");
  const metrics = cfg.metrics.map(([col, name, fmtType]) => ({col, name, fmtType, idx: findColIdxLoose(data.columns, col)}));
  const dims = rows.map(r => r[dimI]);

  const grid = document.createElement("div");
  grid.className = "grid-three";
  metrics.forEach((m, mi) => {
    if (m.idx < 0) return;
    const sub = document.createElement("div");
    sub.className = "mini-chart-wrap";
    const title = document.createElement("div");
    title.className = "mini-chart-title";
    title.textContent = m.name;
    sub.appendChild(title);
    const box = document.createElement("div");
    box.className = "echarts-box";
    box.style.height = (Math.max(rows.length*32, 160))+"px";
    sub.appendChild(box);
    grid.appendChild(sub);

    const sorted = [...rows].sort((a,b)=>(b[m.idx]||0)-(a[m.idx]||0));
    setTimeout(()=>{
      const c = echarts.init(box);
      STATE.echarts.push(c);
      const fmtFn = m.fmtType === "money" ? fmt.money : (m.fmtType === "int_w" ? fmt.int_w : fmt.int);
      c.setOption({
        tooltip: {trigger:"axis", formatter: p => `${p[0].name}<br><b>${fmtFn(p[0].value)}</b>`},
        grid: {left: 80, right: 60, top: 10, bottom: 10, containLabel: true},
        xAxis: {type: "value", axisLabel: {formatter: fmtFn, fontSize: 10}},
        yAxis: {type: "category", data: sorted.map(r=>r[dimI]), inverse: true, axisLabel: {fontSize: 11}},
        series: [{
          type: "bar",
          data: sorted.map(r => r[m.idx]),
          itemStyle: {color: PALETTE[mi+1]},
          label: {show: true, position: "right", formatter: p => fmtFn(p.value), fontSize: 10},
        }]
      });
      window.addEventListener("resize", ()=>c.resize());
    },0);
  });
  body.appendChild(grid);
};

renderers.lineTrend = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  let rows = data.rows.filter(r => r[dimI] !== "总计");
  rows = rows.sort((a,b)=> String(a[dimI]).localeCompare(String(b[dimI])));
  if (rows.length <= 1) {
    body.innerHTML = `<div class="empty">该时段仅 ${rows.length} 个数据点，趋势图不适用。请切换到&quot;近7天&quot;或更长时段</div>`;
    return;
  }
  const dims = rows.map(r => r[dimI]);
  const vals = rows.map(r => r[valI]);
  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = "320px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echarts.push(c);
    c.setOption({
      tooltip: {trigger:"axis", formatter: p => `${p[0].name}<br><b>${fmt.money(p[0].value)}</b>`},
      grid: {left: 60, right: 30, top: 30, bottom: 50, containLabel: true},
      xAxis: {type: "category", data: dims, axisLabel: {rotate: dims.length>10?30:0, fontSize: 11}},
      yAxis: {type: "value", axisLabel: {formatter: v => fmt.money(v)}},
      series: [{
        type: "line", smooth: true, symbol: "circle", symbolSize: 8,
        data: vals,
        itemStyle: {color: "#5470c6"},
        lineStyle: {color: "#5470c6", width: 2.5},
        areaStyle: {color: {type:"linear", x:0,y:0,x2:0,y2:1, colorStops:[{offset:0,color:"rgba(84,112,198,0.3)"},{offset:1,color:"rgba(84,112,198,0.02)"}]}},
        markPoint: {data: [{type:"max",name:"最高"},{type:"min",name:"最低"}], label:{formatter: p => fmt.money(p.value)}},
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

// ★ rank_list — TOP 商家/商品/笔记，纯文本列表 + 链接
renderers.rankList = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const extra2I = cfg.extra_dim2 ? findColIdx(data.columns, cfg.extra_dim2) : -1;
  const linkColI = cfg.link_col ? findColIdx(data.columns, cfg.link_col) : -1;
  const sellerIdI = cfg.link_col_seller ? findColIdx(data.columns, cfg.link_col_seller) : -1;
  const itemIdI = cfg.link_col_item ? findColIdx(data.columns, cfg.link_col_item) : -1;

  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 25);
  const totalVal = rows.reduce((s,r)=>s+(r[valI]||0), 0);
  const topVal = top.reduce((s,r)=>s+(r[valI]||0), 0);

  // 顶部 summary
  const summary = document.createElement("div");
  summary.className = "rank-summary";
  summary.innerHTML = `
    <span><b>${rows.length}</b> 项 · 合计 <b>${fmt.money(totalVal)}</b></span>
    <span class="muted">展示 Top ${top.length} (占 ${((topVal/totalVal*100)||0).toFixed(0)}%)</span>
  `;
  body.appendChild(summary);

  // 列表
  const list = document.createElement("ol");
  list.className = "rank-list";
  top.forEach((r,idx) => {
    const li = document.createElement("li");
    const name = String(r[dimI]||"");
    const displayName = cfg.name_max ? fmt.ellipsize(name, cfg.name_max) : name;
    let link = null;
    const sellerIdVal = sellerIdI >= 0 ? r[sellerIdI] : null;
    const itemIdVal = itemIdI >= 0 ? r[itemIdI] : null;
    if (cfg.link_type === "seller") link = sellerIdVal ? sellerCangqiongUrl(sellerIdVal) : sellerSearchUrl(name);
    else if (cfg.link_type === "product") link = itemIdVal ? productCangqiongUrl(itemIdVal) : productSearchUrl(name);
    else if (cfg.link_type === "note" && linkColI>=0 && r[linkColI]) link = noteUrl(r[linkColI]);

    let extraHtml = "";
    if (extraI >= 0 && r[extraI]) extraHtml += `<span class="extra">${r[extraI]}</span>`;
    if (extra2I >= 0 && r[extra2I]) extraHtml += `<span class="extra">${r[extra2I]}</span>`;

    const nameEl = link ? `<a href="${link}" target="_blank" rel="noopener" title="${name}">${displayName} <span class="ext-icon">↗</span></a>` : `<span title="${name}">${displayName}</span>`;
    const valWidth = Math.max(2, ((r[valI]||0)/Math.max(top[0][valI]||1, 1) * 100));

    li.innerHTML = `
      <span class="rank-no">${idx+1}</span>
      <div class="rank-main">
        <div class="rank-name">${nameEl}</div>
        ${extraHtml ? `<div class="rank-extra">${extraHtml}</div>` : ""}
      </div>
      <div class="rank-bar">
        <div class="rank-bar-fill" style="width:${valWidth}%"></div>
      </div>
      <div class="rank-value">${fmt.money(r[valI])}</div>
    `;
    list.appendChild(li);
  });
  body.appendChild(list);

  // 折叠完整列表
  if (rows.length > top.length) {
    const fold = document.createElement("details");
    fold.className = "fold";
    fold.innerHTML = `<summary>查看后 ${rows.length - top.length} 项</summary>`;
    const tbl = document.createElement("div");
    tbl.className = "table-wrap";
    let html = `<table class="data-table"><thead><tr><th>#</th><th>${cfg.dim}</th>${extraI>=0?`<th>${cfg.extra_dim}</th>`:""}<th class="num">${cfg.value.trim()}</th></tr></thead><tbody>`;
    rows.slice(top.length, top.length+200).forEach((r,i) => {
      const name = r[dimI];
      let link = null;
      if (cfg.link_type === "seller") link = sellerSearchUrl(name);
      else if (cfg.link_type === "product") link = productSearchUrl(name);
      const nameEl = link ? `<a href="${link}" target="_blank" rel="noopener">${fmt.ellipsize(String(name||""), cfg.name_max||40)}</a>` : (fmt.ellipsize(String(name||""), cfg.name_max||40));
      html += `<tr><td>${top.length+i+1}</td><td>${nameEl}</td>${extraI>=0?`<td>${r[extraI]||"-"}</td>`:""}<td class="num">${fmt.money(r[valI])}</td></tr>`;
    });
    html += "</tbody></table>";
    tbl.innerHTML = html;
    fold.appendChild(tbl);
    body.appendChild(fold);
  }
};

// ★ category_treemap — 类目用 treemap，块面积=GMV
renderers.categoryTreemap = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;
  let rows = data.rows.filter(r => r[dimI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 25);
  const others_sum = rows.slice(cfg.top || 25).reduce((s,r)=>s+(r[valI]||0),0);
  const total = rows.reduce((s,r)=>s+(r[valI]||0),0);

  // treemap 数据，颜色根据 rate
  const tdata = top.map((r,i) => {
    const rate = rateI>=0 ? r[rateI] : null;
    let color;
    if (rate == null || Math.abs(rate) > 5) color = "#999";
    else if (rate > 0.1) color = "#d63031";
    else if (rate > 0) color = "#f8b8b8";
    else if (rate > -0.1) color = "#b8e0c2";
    else color = "#2c8a47";
    return {
      name: r[dimI], value: r[valI],
      itemStyle: {color},
      _rate: rate,
    };
  });
  if (others_sum > 0) tdata.push({name: `其他 ${rows.length-top.length} 项`, value: others_sum, itemStyle: {color:"#ddd"}});

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = "440px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echarts.push(c);
    c.setOption({
      tooltip: {formatter: p => {
        const rate = p.data._rate;
        let rateStr = "";
        if (rate != null && typeof rate === "number") {
          if (Math.abs(rate) > 5) rateStr = `<br>变化异常`;
          else rateStr = `<br>同比: ${rate>=0?"↑":"↓"} ${(Math.abs(rate)*100).toFixed(1)}%`;
        }
        return `<b>${p.name}</b><br>DGMV: <b>${fmt.money(p.value)}</b><br>占比: ${(p.value/total*100).toFixed(1)}%${rateStr}`;
      }},
      series: [{
        type: "treemap", roam: false,
        breadcrumb: {show: false},
        label: {show: true, formatter: p => `${p.name}\n${fmt.money(p.value)}`, fontSize: 12, color: "#333"},
        data: tdata,
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);

  // 加颜色图例
  const legend = document.createElement("div");
  legend.className = "treemap-legend";
  legend.innerHTML = `<span>颜色：</span>
    <span class="lg"><i style="background:#2c8a47"></i>同比↓>10%</span>
    <span class="lg"><i style="background:#b8e0c2"></i>↓0~10%</span>
    <span class="lg"><i style="background:#f8b8b8"></i>↑0~10%</span>
    <span class="lg"><i style="background:#d63031"></i>↑>10%</span>
    <span class="lg"><i style="background:#999"></i>无对比/异常</span>`;
  body.appendChild(legend);
};

// 类目环比 TOP 表格
renderers.categoryChangeTable = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = findColIdx(data.columns, cfg.rate);
  let rows = data.rows.filter(r => r[dimI] !== "总计" && (r[valI]||0) > 0 && rateI>=0 && r[rateI] != null && Math.abs(r[rateI]) <= 5);
  // 涨幅 + 跌幅 各 Top
  const ups = [...rows].sort((a,b)=>(b[rateI]||0)-(a[rateI]||0)).slice(0, cfg.top||10);
  const downs = [...rows].sort((a,b)=>(a[rateI]||0)-(b[rateI]||0)).slice(0, cfg.top||10);

  const grid = document.createElement("div");
  grid.className = "two-cols";
  function makeCol(title, list, isUp) {
    const col = document.createElement("div");
    col.className = "change-col";
    let html = `<h4 class="${isUp?'up':'down'}">${isUp?'📈 涨幅榜':'📉 跌幅榜'} TOP ${list.length}</h4><table class="data-table"><thead><tr><th>类目</th><th class="num">DGMV</th><th class="num">环比</th></tr></thead><tbody>`;
    list.forEach(r => {
      html += `<tr><td>${r[dimI]}</td><td class="num">${fmt.money(r[valI])}</td><td class="num">${renderDelta(r[rateI])}</td></tr>`;
    });
    html += "</tbody></table>";
    col.innerHTML = html;
    return col;
  }
  grid.appendChild(makeCol("涨幅", ups, true));
  grid.appendChild(makeCol("跌幅", downs, false));
  body.appendChild(grid);
};

function renderKpiGridCard(data) {
  const cfg = data.config || {};
  const wrap = document.createElement("section");
  wrap.className = "chart-card";
  wrap.innerHTML = `<div class="chart-header"><div class="chart-title">${cfg.title || data.chart_name}</div><div class="chart-meta"><a href="${data.source_url}" target="_blank">🔗 BI 原图</a></div></div>`;
  const grid = document.createElement("div");
  grid.className = "kpi-grid";
  const row = data.rows && data.rows[0];
  (cfg.groups || []).forEach(g => {
    const ci = findColIdx(data.columns, g.col);
    const di = g.delta_col ? findColIdx(data.columns, g.delta_col) : -1;
    if (ci < 0 || !row) return;
    const v = row[ci];
    const delta = di>=0 ? row[di] : null;
    let valStr;
    if (g.fmt === "money") valStr = fmt.money(v);
    else if (g.fmt === "int") valStr = fmt.int(v);
    else if (g.fmt === "int_w") valStr = fmt.int_w(v);
    else if (g.fmt === "pct") valStr = fmt.pct(v);
    else valStr = fmt.num(v);
    const dh = deltaInline(delta);
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `<div class="label">${g.label}</div><div class="value">${valStr}</div>${dh}`;
    grid.appendChild(card);
  });
  wrap.appendChild(grid);
  return wrap;
}

renderers.twoListsChange = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const valI = findColIdxLoose(data.columns, cfg.value);
  const deltaI = cfg.delta_col ? findColIdx(data.columns, cfg.delta_col) : -1;
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;
  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0 && deltaI>=0 && r[deltaI] != null);
  const top = cfg.top || 15;
  const ups = [...rows].sort((a,b)=>(b[deltaI]||0)-(a[deltaI]||0)).slice(0, top);
  const downs = [...rows].sort((a,b)=>(a[deltaI]||0)-(b[deltaI]||0)).slice(0, top);

  const grid = document.createElement("div");
  grid.className = "two-cols";
  function makeList(title, list, isUp) {
    const col = document.createElement("div");
    col.className = "change-col";
    let html = `<h4 class="${isUp?'up':'down'}">${isUp?'📈 突增':'📉 突降'} TOP ${list.length}</h4><table class="data-table"><thead><tr><th>商家</th><th>AM</th><th class="num">${cfg.value.trim()}</th><th class="num">变化</th></tr></thead><tbody>`;
    list.forEach(r => {
      const delta = r[deltaI];
      const rate = rateI>=0 ? r[rateI] : null;
      const sellerLink = sellerSearchUrl(r[dimI]);
      html += `<tr><td><a href="${sellerLink}" target="_blank" rel="noopener">${r[dimI]}</a></td><td>${extraI>=0?(r[extraI]||"-"):"-"}</td><td class="num">${fmt.money(r[valI])}</td><td class="num">${(delta>=0?'↑':'↓')} ${fmt.money(Math.abs(delta))}<br><span class="muted-mini">${rate!=null?renderDelta(rate):""}</span></td></tr>`;
    });
    html += "</tbody></table>";
    col.innerHTML = html;
    return col;
  }
  grid.appendChild(makeList("突增", ups, true));
  grid.appendChild(makeList("突降", downs, false));
  body.appendChild(grid);
};

renderers.amsCountGrid = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const amI = findColIdx(data.columns, cfg.am_col);
  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计");
  const byAM = {};
  rows.forEach(r => {
    const am = r[amI] || "未知";
    byAM[am] = (byAM[am]||0)+1;
  });
  const ams = Object.keys(byAM).sort((a,b)=>byAM[b]-byAM[a]);

  const kpiRow = document.createElement("div");
  kpiRow.className = "kpi-grid";
  ams.forEach((am, i) => {
    const c = document.createElement("div");
    c.className = "kpi-card";
    c.innerHTML = `<div class="label">${am}</div><div class="value">${byAM[am]}</div><div class="sub">家</div>`;
    kpiRow.appendChild(c);
  });
  body.appendChild(kpiRow);

  const fold = document.createElement("details");
  fold.className = "fold";
  fold.innerHTML = `<summary>查看完整商家列表（${rows.length} 家）</summary><div class="table-wrap"><table class="data-table"><thead><tr><th>商家</th><th>AM</th></tr></thead><tbody>${
    rows.slice(0, 500).map(r => `<tr><td><a href="${sellerSearchUrl(r[dimI])}" target="_blank">${r[dimI]}</a></td><td>${r[amI]||"-"}</td></tr>`).join("")
  }</tbody></table></div>${rows.length>500?`<div class="table-info">仅显示前 500 家</div>`:""}`;
  body.appendChild(fold);
};

// 笔记专属：标题为主、商家为副、DGMV 突出、跳转 explore
renderers.rankListNote = function(body, data, cfg) {
  const titleI = findColIdx(data.columns, cfg.dim);
  const sellerI = findColIdx(data.columns, cfg.extra_dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const linkI = findColIdx(data.columns, cfg.link_col);

  let rows = data.rows.filter(r => r[titleI] && r[titleI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 30);
  const totalVal = rows.reduce((s,r)=>s+(r[valI]||0), 0);

  const summary = document.createElement("div");
  summary.className = "rank-summary";
  summary.innerHTML = `
    <span><b>${rows.length}</b> 条新发笔记 · 合计 DGMV <b>${fmt.money(totalVal)}</b></span>
    <span class="muted">显示 Top ${top.length}</span>
  `;
  body.appendChild(summary);

  const list = document.createElement("div");
  list.className = "note-list";
  top.forEach((r, idx) => {
    const li = document.createElement("div");
    li.className = "note-item";
    const title = String(r[titleI] || "");
    const seller = String(r[sellerI] || "");
    const noteId = linkI >= 0 ? r[linkI] : null;
    const link = noteId ? noteUrl(noteId) : null;
    const titleHtml = link
      ? `<a href="${link}" target="_blank" rel="noopener" class="note-title">${title} <span class="ext-icon">↗</span></a>`
      : `<span class="note-title">${title}</span>`;
    li.innerHTML = `
      <div class="note-rank">${idx+1}</div>
      <div class="note-main">
        ${titleHtml}
        <div class="note-seller">📦 ${seller}</div>
      </div>
      <div class="note-value">
        <div class="note-gmv">${fmt.money(r[valI])}</div>
        <div class="note-gmv-label">DGMV</div>
      </div>
    `;
    list.appendChild(li);
  });
  body.appendChild(list);
};

// ============================================================
// V5 派生：从总计行生成 KPI grid（用于店播/K播组级总览）
// ============================================================
renderers.kpiGridFromTotal = function(body, data, cfg) {
  const grid = document.createElement("div");
  grid.className = "kpi-grid";
  const row = data.rows && data.rows[0];
  (cfg.groups || []).forEach(g => {
    const ci = findColIdx(data.columns, g.col);
    const di = g.delta_col ? findColIdx(data.columns, g.delta_col) : -1;
    if (ci < 0 || !row) return;
    const v = row[ci];
    const delta = di>=0 ? row[di] : null;
    let valStr;
    if (g.fmt === "money") valStr = fmt.money(v);
    else if (g.fmt === "int") valStr = fmt.int(v);
    else if (g.fmt === "int_w") valStr = fmt.int_w(v);
    else if (g.fmt === "pct") valStr = fmt.pct(v);
    else valStr = fmt.num(v);
    if (g.unit) valStr += `<span class="unit">${g.unit}</span>`;
    const dh = deltaInline(delta);
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `<div class="label">${g.label}</div><div class="value">${valStr}</div>${dh}`;
    grid.appendChild(card);
  });
  body.appendChild(grid);
};

// ============================================================
// V4 业务卡片化：通用 cardGrid（适配 商家/商品/店播/K播）
// ============================================================
renderers.cardGrid = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const extra2I = cfg.extra_dim2 ? findColIdx(data.columns, cfg.extra_dim2) : -1;
  const valI = findColIdxLoose(data.columns, cfg.value);
  // ID 列（用于直链跳苍穹）
  const itemIdI = cfg.link_col_item ? findColIdx(data.columns, cfg.link_col_item) : -1;
  const sellerIdI = cfg.link_col_seller ? findColIdx(data.columns, cfg.link_col_seller) : -1;
  if (dimI < 0 || valI < 0) {
    body.innerHTML = `<div class="empty">字段缺失：dim=${cfg.dim} val=${cfg.value}</div>`;
    return;
  }

  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 30);
  const totalVal = rows.reduce((s,r)=>s+(r[valI]||0), 0);

  const summary = document.createElement("div");
  summary.className = "rank-summary";
  summary.innerHTML = `
    <span><b>${rows.length}</b> 条 · 合计 ${cfg.value.trim()} <b>${fmt.money(totalVal)}</b></span>
    <span class="muted">显示 Top ${top.length}</span>
  `;
  body.appendChild(summary);

  const list = document.createElement("div");
  list.className = "card-grid card-grid-" + (cfg.card_type || "default");

  const cardType = cfg.card_type || "default";

  top.forEach((r, idx) => {
    const li = document.createElement("div");
    li.className = "biz-card";
    const mainName = String(r[dimI] || "");
    const extra = extraI >= 0 ? String(r[extraI] || "") : "";
    const extra2 = extra2I >= 0 ? String(r[extra2I] || "") : "";
    const val = r[valI];

    // 链接：优先用 ID 直链跳苍穹
    let mainHref = null;
    const itemIdVal = itemIdI >= 0 ? r[itemIdI] : null;
    const sellerIdVal = sellerIdI >= 0 ? r[sellerIdI] : null;
    if (cfg.link_type === "seller" || cardType === "seller" || cardType === "live") {
      mainHref = sellerIdVal ? sellerCangqiongUrl(sellerIdVal) : sellerSearchUrl(mainName);
    } else if (cfg.link_type === "product" || cardType === "product") {
      mainHref = itemIdVal ? productCangqiongUrl(itemIdVal) : productSearchUrl(mainName);
    } else if (cardType === "kbroadcast") {
      // K 播大场：主播昵称仍用搜索（无主播 ID 路径），但商家 chip 可以单独走苍穹
      mainHref = sellerSearchUrl(mainName);
    }

    // 卡片正文（按 card_type 决定布局）
    let bodyHtml = "";
    if (cardType === "live") {
      // 店播大场: 商家(主) + AM + 日期 + GMV
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">${mainName}</span>`}
          <div class="card-sub">
            <span class="tag tag-am">👤 ${extra || "-"}</span>
            <span class="tag tag-date">📅 ${extra2 || "-"}</span>
          </div>
        </div>
        <div class="card-value">
          <div class="vbig">${fmt.money(val)}</div>
          <div class="vlabel">单场 GMV</div>
        </div>`;
    } else if (cardType === "kbroadcast") {
      // K 播大场: 主播(主) + 商家(可跳苍穹) + AM + 日期
      const extra3 = cfg.extra_dim3 ? (() => { const i = findColIdx(data.columns, cfg.extra_dim3); return i>=0 ? r[i] : ""; })() : "";
      const shopChip = sellerIdVal
        ? `<a class="tag tag-shop tag-link" href="${sellerCangqiongUrl(sellerIdVal)}" target="_blank" rel="noopener">🏪 ${extra || "-"} ↗</a>`
        : `<span class="tag tag-shop">🏪 ${extra || "-"}</span>`;
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">🎙 ${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">🎙 ${mainName}</span>`}
          <div class="card-sub">
            ${shopChip}
            <span class="tag tag-am">👤 ${extra2 || "-"}</span>
            ${extra3 ? `<span class="tag tag-date">📅 ${extra3}</span>` : ""}
          </div>
        </div>
        <div class="card-value">
          <div class="vbig">${fmt.money(val)}</div>
          <div class="vlabel">单场 DGMV</div>
        </div>`;
    } else if (cardType === "product") {
      // TOP 商品: 商品(主，跳商品苍穹) + 商家(跳店铺苍穹) + AM
      const shopChip = sellerIdVal
        ? `<a class="tag tag-shop tag-link" href="${sellerCangqiongUrl(sellerIdVal)}" target="_blank" rel="noopener">🏪 ${extra || "-"} ↗</a>`
        : `<span class="tag tag-shop">🏪 ${extra || "-"}</span>`;
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">${mainName}</span>`}
          <div class="card-sub">
            ${shopChip}
            ${extra2 ? `<span class="tag tag-am">👤 ${extra2}</span>` : ""}
          </div>
        </div>
        <div class="card-value">
          <div class="vbig">${fmt.money(val)}</div>
          <div class="vlabel">DGMV</div>
        </div>`;
    } else if (cardType === "seller") {
      // TOP 商家: 商家(主) + AM + 核心场域
      let coreCarrier = "";
      const sxc = data.attribution_seller_carrier;
      if (sxc && sxc[mainName] && sxc[mainName].length) {
        const total = sxc[mainName].reduce((s,x)=>s+(x[1]||0),0);
        const top = sxc[mainName][0];
        const pct = total>0 ? Math.round((top[1]||0)/total*100) : 0;
        coreCarrier = `<span class="tag tag-carrier">🎯 ${top[0]} ${pct}%</span>`;
      }
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">${mainName}</span>`}
          <div class="card-sub">
            ${extra ? `<span class="tag tag-am">👤 ${extra}</span>` : ""}
            ${coreCarrier}
          </div>
        </div>
        <div class="card-value">
          <div class="vbig">${fmt.money(val)}</div>
          <div class="vlabel">DGMV</div>
        </div>`;
    } else {
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          <span class="card-title">${mainName}</span>
          ${extra ? `<div class="card-sub">${extra}</div>` : ""}
        </div>
        <div class="card-value"><div class="vbig">${fmt.money(val)}</div></div>`;
    }
    li.innerHTML = bodyHtml;
    list.appendChild(li);
  });
  body.appendChild(list);
};

// ============================================================
// V4 异动商家卡片（双列）+ 简单归因（按 AM 拆分）
// ============================================================
renderers.sellerChangeCards = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const valI = findColIdxLoose(data.columns, cfg.value);
  const deltaI = cfg.delta_col ? findColIdx(data.columns, cfg.delta_col) : -1;
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;
  const sellerIdI = cfg.link_col_seller ? findColIdx(data.columns, cfg.link_col_seller) : -1;
  if (deltaI < 0) { body.innerHTML = `<div class="empty">变化值字段缺失</div>`; return; }

  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0 && r[deltaI] != null);
  const top = cfg.top || 15;
  const ups = [...rows].sort((a,b)=>(b[deltaI]||0)-(a[deltaI]||0)).slice(0, top);
  const downs = [...rows].sort((a,b)=>(a[deltaI]||0)-(b[deltaI]||0)).slice(0, top);

  // 归因摘要：突增/突降里 AM 分布
  function attribAM(list) {
    if (extraI < 0) return null;
    const byAM = {};
    list.forEach(r => {
      const am = r[extraI] || "未知";
      if (!byAM[am]) byAM[am] = {count: 0, delta: 0};
      byAM[am].count += 1;
      byAM[am].delta += r[deltaI] || 0;
    });
    return Object.entries(byAM).sort((a,b)=>Math.abs(b[1].delta)-Math.abs(a[1].delta)).slice(0,5);
  }

  // 归因: 商家 -> 主要场域
  const sxc = data.attribution_seller_carrier || {};
  function carrierTagOf(seller) {
    if (!sxc[seller] || !sxc[seller].length) return "";
    const total = sxc[seller].reduce((s,x)=>s+(x[1]||0),0);
    const top = sxc[seller][0];
    const pct = total>0 ? Math.round((top[1]||0)/total*100) : 0;
    return `<span class="tag tag-carrier">🎯 ${top[0]} ${pct}%</span>`;
  }
  function makeCol(list, isUp) {
    const col = document.createElement("div");
    col.className = "change-col";
    let html = `<h4 class="${isUp?'up':'down'}">${isUp?'📈 突增':'📉 突降'} TOP ${list.length}</h4><div class="card-grid card-grid-change">`;
    list.forEach((r, idx) => {
      const seller = String(r[dimI] || "");
      const am = extraI>=0 ? (r[extraI] || "-") : "-";
      const val = r[valI];
      const delta = r[deltaI];
      const rate = rateI>=0 ? r[rateI] : null;
      const sellerIdVal = sellerIdI >= 0 ? r[sellerIdI] : null;
      const link = sellerIdVal ? sellerCangqiongUrl(sellerIdVal) : sellerSearchUrl(seller);
      const rateHtml = rate != null && Math.abs(rate) <= 50 ? renderDelta(rate) : (rate != null ? `<span class="muted">×${rate>0?'+':''}${rate.toFixed(1)}</span>` : "");
      const carrierTag = carrierTagOf(seller);
      html += `
        <div class="biz-card change-card ${isUp?'up':'down'}">
          <div class="card-rank">${idx+1}</div>
          <div class="card-body">
            <a href="${link}" target="_blank" rel="noopener" class="card-title">${seller} <span class="ext-icon">↗</span></a>
            <div class="card-sub"><span class="tag tag-am">👤 ${am}</span>${carrierTag}</div>
          </div>
          <div class="card-value">
            <div class="vbig ${isUp?'up':'down'}">${isUp?'+':''}${fmt.money(delta)}</div>
            <div class="vlabel">${rateHtml || (isUp?'增量':'减量')}</div>
            <div class="vsmall">现期 ${fmt.money(val)}</div>
          </div>
        </div>`;
    });
    html += `</div>`;
    // 归因 by AM
    const attribAMRes = attribAM(list);
    if (attribAMRes && attribAMRes.length) {
      html += `<div class="attrib-box ${isUp?'up':'down'}"><b>${isUp?'增量':'减量'}主要来自 AM：</b>`;
      html += attribAMRes.map(([am, info]) => `<span class="attrib-tag">${am} <b>${info.count}</b>家 / ${info.delta>=0?'+':''}${fmt.money(info.delta)}</span>`).join(" ");
      html += `</div>`;
    }
    // 归因 by 场域：聚合所有 list 商家的场域分布
    const carrierAgg = {};
    list.forEach(r => {
      const seller = String(r[dimI] || "");
      const arr = sxc[seller] || [];
      arr.forEach(([carrier, gmv]) => {
        carrierAgg[carrier] = (carrierAgg[carrier]||0) + (gmv||0);
      });
    });
    const carrierTop = Object.entries(carrierAgg).sort((a,b)=>b[1]-a[1]).slice(0,5);
    if (carrierTop.length) {
      const totalC = carrierTop.reduce((s,x)=>s+x[1],0);
      html += `<div class="attrib-box ${isUp?'up':'down'}"><b>主要场域分布：</b>`;
      html += carrierTop.map(([c, v]) => {
        const pct = totalC>0 ? Math.round(v/totalC*100) : 0;
        return `<span class="attrib-tag">${c} ${fmt.money(v)} <b>${pct}%</b></span>`;
      }).join(" ");
      html += `</div>`;
    }
    col.innerHTML = html;
    return col;
  }
  const grid = document.createElement("div");
  grid.className = "two-cols";
  grid.appendChild(makeCol(ups, true));
  grid.appendChild(makeCol(downs, false));
  body.appendChild(grid);

  // V9.1: by AM 拆分突增/突降（每 AM 各 5 条）
  // 仅全组视角下展示（AM 视角下已经 filter）
  if (STATE.currentAM === "全组" && extraI >= 0) {
    const byAMRows = {};
    rows.forEach(r => {
      const am = r[extraI];
      if (!am) return;
      if (!byAMRows[am]) byAMRows[am] = [];
      byAMRows[am].push(r);
    });
    const amWrap = document.createElement("div");
    amWrap.className = "byam-change-wrap";
    amWrap.innerHTML = `<div class="byam-title">📋 按 AM 拆分（每 AM Top 10 突增 / Top 10 突降）</div>`;
    const amGrid = document.createElement("div");
    amGrid.className = "byam-change-grid";
    const orderedAMs = ["大门(朱锦程)","蕾塞(张嘉悦)","莱拉(付艺迪)","路歌(李红红)","秋罗(胡春秋)","诺亚(单恩浩)"];
    orderedAMs.forEach(am => {
      const list = byAMRows[am] || [];
      if (!list.length) return;
      const ups5 = [...list].sort((a,b)=>(b[deltaI]||0)-(a[deltaI]||0)).slice(0,10).filter(r=>(r[deltaI]||0)>0);
      const dns5 = [...list].sort((a,b)=>(a[deltaI]||0)-(b[deltaI]||0)).slice(0,10).filter(r=>(r[deltaI]||0)<0);
      const card = document.createElement("div");
      card.className = "byam-am-card";
      const liItem = (r, isUp) => {
        const sname = String(r[dimI]||"").replace(/<[^>]+>/g,"");
        const delta = r[deltaI]||0;
        const arrow = isUp ? "📈" : "📉";
        const cls = isUp ? "up" : "down";
        return `<li class="${cls}">${arrow} ${sname} <span class="d">${isUp?"+":""}${fmt.money(delta)}</span></li>`;
      };
      card.innerHTML = `
        <div class="byam-am-name">${am}</div>
        <div class="byam-sub-cols">
          <div class="byam-sub-col">
            <div class="byam-sub-title up">突增 Top 10</div>
            <ul class="byam-list">${ups5.length ? ups5.map(r=>liItem(r,true)).join("") : '<li class="muted">无</li>'}</ul>
          </div>
          <div class="byam-sub-col">
            <div class="byam-sub-title down">突降 Top 10</div>
            <ul class="byam-list">${dns5.length ? dns5.map(r=>liItem(r,false)).join("") : '<li class="muted">无</li>'}</ul>
          </div>
        </div>
      `;
      amGrid.appendChild(card);
    });
    amWrap.appendChild(amGrid);
    body.appendChild(amWrap);
  }
};

// ============================================================
// V4 类目 treemap：颜色用 GMV 量级渐变（深→浅），不再全红
// ============================================================
renderers.categoryTreemapValue = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;
  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = cfg.top || 30;
  const head = rows.slice(0, top);
  const tail = rows.slice(top);
  const tailSum = tail.reduce((s,r)=>s+(r[valI]||0),0);

  const data1 = head.map(r => {
    const v = r[valI];
    const rate = rateI>=0 ? r[rateI] : null;
    let rateLabel = "";
    if (rate != null && Math.abs(rate) <= 5) {
      rateLabel = (rate>=0?'+':'') + (rate*100).toFixed(0) + '%';
    } else if (rate != null) {
      rateLabel = "—";
    }
    return {
      name: String(r[dimI]).slice(0, 12),
      value: v,
      rate: rate,
      rateLabel,
    };
  });
  if (tailSum > 0) data1.push({name: `其他 ${tail.length} 项`, value: tailSum, rate: null, rateLabel: ""});

  const div = document.createElement("div");
  div.style.height = "460px";
  div.style.width = "100%";
  body.appendChild(div);
  const chart = echarts.init(div);
  chart.setOption({
    tooltip: {
      formatter: (p) => {
        const d = p.data;
        let s = `<b>${d.name}</b><br/>${cfg.value.trim()}: ${fmt.money(d.value)}`;
        if (d.rate != null) s += `<br/>环比: ${d.rateLabel || '—'}`;
        return s;
      }
    },
    series: [{
      type: "treemap",
      roam: false,
      breadcrumb: {show: false},
      data: data1,
      levels: [{
        itemStyle: {
          borderColor: '#fff',
          borderWidth: 2,
          gapWidth: 2,
        },
        upperLabel: {show: false},
        colorMappingBy: 'index',
      }],
      label: {
        show: true,
        formatter: (p) => {
          const d = p.data;
          let lines = [d.name, fmt.money(d.value)];
          if (d.rateLabel) lines.push(d.rateLabel);
          return lines.join("\n");
        },
        fontSize: 12,
        color: '#fff',
        textShadowColor: 'rgba(0,0,0,0.4)',
        textShadowBlur: 2,
      },
      // 多色：每个类目独立色，按 GMV 量级深→浅 但跨色相
      color: [
        '#5470c6', '#fac858', '#ee6666', '#73c0de', '#3ba272',
        '#fc8452', '#9a60b4', '#ea7ccc', '#a9bdf4', '#f3a683',
        '#778beb', '#fed8a4', '#e15f41', '#bcd0c7', '#ffb142',
        '#ff5252', '#9c88ff', '#00bcd4', '#7bed9f', '#70a1ff',
      ],
    }],
  });
  setTimeout(() => chart.resize(), 100);
  window.addEventListener("resize", () => chart.resize());
};

// ============================================================
// V4 类目环比异动 V2：涨幅榜（大涨）+ 承压榜（涨幅最低/真跌）+ 归因
// ============================================================
renderers.categoryChangeV2 = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = findColIdx(data.columns, cfg.rate);
  // 阈值放宽到 ±500% (=5)
  let rows = data.rows.filter(r => r[dimI] !== "总计" && (r[valI]||0) > 0 && rateI>=0 && r[rateI] != null && Math.abs(r[rateI]) <= 5);

  const ups = [...rows].sort((a,b)=>(b[rateI]||0)-(a[rateI]||0)).slice(0, cfg.top||15);
  const downs = [...rows].sort((a,b)=>(a[rateI]||0)-(b[rateI]||0)).slice(0, cfg.top||15);

  // 判断是否所有都在涨
  const hasReal = downs.some(r => r[rateI] < 0);
  const downLabel = hasReal ? "📉 跌幅榜" : "🪫 涨幅垫底榜";
  const downHint = hasReal ? "" : `<span class="hint">本时段全市场上涨，无负值类目</span>`;

  function attribCategory(list) {
    // 拼成简短文字：列出涨/跌前 3 类目占整体变化的份额
    if (!list.length) return "";
    const totalRate = list.reduce((s,r)=>s+(r[valI]||0)*(r[rateI]||0),0);
    const top3 = list.slice(0,3).map(r=>r[dimI]);
    return top3.join(" / ");
  }

  // 归因: 类目 -> Top3 商家
  const cxs = data.attribution_cat_seller || {};
  function topSellersOf(category) {
    const arr = cxs[category];
    if (!arr || !arr.length) return [];
    return arr.slice(0,3);
  }
  function makeCol(list, isUp, label, hint) {
    const col = document.createElement("div");
    col.className = "change-col";
    let html = `<h4 class="${isUp?'up':'down'}">${label} TOP ${list.length}</h4>${hint}<table class="data-table cat-change-table"><thead><tr><th>类目</th><th class="num">DGMV</th><th class="num">环比</th></tr></thead><tbody>`;
    list.forEach(r => {
      const cat = r[dimI];
      const rate = r[rateI];
      const rateHtml = Math.abs(rate) <= 5
        ? `<span class="${rate>=0?'delta-up':'delta-down'}">${rate>=0?'↑':'↓'} ${(Math.abs(rate)*100).toFixed(1)}%</span>`
        : `<span class="delta-abnormal">×${rate>0?'+':''}${rate.toFixed(0)}</span>`;
      html += `<tr class="cat-row"><td>${cat}</td><td class="num">${fmt.money(r[valI])}</td><td class="num">${rateHtml}</td></tr>`;
      // 归因行：类目下 Top3 商家
      const tops = topSellersOf(cat);
      if (tops.length) {
        const tagsHtml = tops.map(([s, g]) => {
          const link = sellerSearchUrl(s);
          return `<a href="${link}" target="_blank" rel="noopener" class="attrib-mini-tag">${s} ${fmt.money(g)}</a>`;
        }).join("");
        html += `<tr class="cat-attrib-row"><td colspan="3"><span class="attrib-mini-label">主要商家：</span>${tagsHtml}</td></tr>`;
      }
    });
    html += "</tbody></table>";
    col.innerHTML = html;
    return col;
  }

  const grid = document.createElement("div");
  grid.className = "two-cols";
  grid.appendChild(makeCol(ups, true, "📈 涨幅榜", ""));
  grid.appendChild(makeCol(downs, false, downLabel, downHint));
  body.appendChild(grid);
};

renderers.fallbackTable = function(body, data) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  let html = `<table class="data-table"><thead><tr>${data.columns.map(c=>`<th>${c}</th>`).join("")}</tr></thead><tbody>`;
  data.rows.slice(0, 100).forEach(r => {
    html += "<tr>"+r.map(v => typeof v === "number" ? `<td class="num">${fmt.money(v)}</td>` : `<td>${v==null?"-":v}</td>`).join("")+"</tr>";
  });
  html += "</tbody></table>";
  wrap.innerHTML = html;
  body.appendChild(wrap);
};

init();
