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

// V12: 通用环比 + tooltip 工具
// ----- 计算"上一同长度时段"DGMV（用 _global_series 日序列）-----
function getPrevPeriodDGMV(periodKey) {
  // 返回 {curSum, prevSum, prevLabel, days}
  const series = (STATE.globalSeries || {}).daily_dgmv;
  if (!series || !series.length) return null;
  const period = STATE.index.periods.find(p => p.key === periodKey);
  if (!period) return null;
  const s = period.start, e = period.end;
  const dateSum = (start, end) => {
    let sum = 0, hit = 0;
    series.forEach(r => { if (r.date >= start && r.date <= end) { sum += r.dgmv; hit++; } });
    return {sum, days: hit};
  };
  const cur = dateSum(s, e);
  const days = (function(){ const a=new Date(s), b=new Date(e); return Math.round((b-a)/86400000)+1; })();
  // 上一同长度时段
  const prevEnd = (function(){ const d=new Date(s); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
  const prevStart = (function(){ const d=new Date(prevEnd); d.setDate(d.getDate()-(days-1)); return d.toISOString().slice(0,10); })();
  const prev = dateSum(prevStart, prevEnd);
  return {
    curSum: cur.sum, curDays: cur.days,
    prevSum: prev.sum, prevDays: prev.days,
    prevStart, prevEnd, days,
    prevLabel: `上 ${days} 天 (${prevStart} ~ ${prevEnd})`
  };
}

// ----- 渲染"带 tooltip 的对比徽章" -----
// kind: 'mom' (环比) | 'bench' (对比 benchmark) | 'avg' (vs 全组人均)
// curVal / refVal 同口径数值；refLabel 显示 "vs xxx"
function deltaBadge(curVal, refVal, refLabel, opts={}) {
  if (curVal == null || refVal == null || refVal == 0) return "";
  const rate = (curVal - refVal) / Math.abs(refVal);
  const fmtRef = opts.fmt || (v => v.toLocaleString("zh-CN", {maximumFractionDigits: 1}));
  // 异常阈值：>500% 不显示具体数字
  if (Math.abs(rate) > 5) {
    return `<span class="delta-badge delta-abnormal" title="对比 ${refLabel}：${fmtRef(refVal)}，变化异常">⚠ 异常</span>`;
  }
  const arrow = rate >= 0 ? "↑" : "↓";
  let cls = rate >= 0 ? "delta-up" : "delta-down";
  let mag = "";
  if (Math.abs(rate) > 1) mag = " 显著";
  const tip = `对比 ${refLabel}：${fmtRef(refVal)}（当前 ${fmtRef(curVal)}）`;
  return `<span class="delta-badge ${cls}" data-tip="${tip.replace(/"/g,'&quot;')}">${arrow}${mag} ${(Math.abs(rate)*100).toFixed(1)}%</span>`;
}

// ----- 通用 hover tooltip 注释（小问号图标）-----
function hint(text) {
  return `<span class="hint-tip" data-tip="${String(text).replace(/"/g,'&quot;')}">ⓘ</span>`;
}

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
  // V10: 每 AM 笔记 CTR/CVR
  try {
    const ncc = await fetch("data/_note_ctr_cvr_byam.json" + cb, {cache: "no-store"});
    if (ncc.ok) STATE.noteCtrCvrByAM = await ncc.json();
  } catch(e) { STATE.noteCtrCvrByAM = null; }
  // V10: K 播 by AM
  try {
    const kb = await fetch("data/_k_byam.json" + cb, {cache: "no-store"});
    if (kb.ok) STATE.kByAM = await kb.json();
  } catch(e) { STATE.kByAM = null; }
  // V10: 类目 by AM
  try {
    const cb2 = await fetch("data/_category_byam.json" + cb, {cache: "no-store"});
    if (cb2.ok) STATE.categoryByAM = await cb2.json();
  } catch(e) { STATE.categoryByAM = null; }
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
  initSidebarToggle();
  await renderActiveTab();
}

function initSidebarToggle() {
  const tgl = document.getElementById("sidebar-toggle");
  const sb = document.getElementById("sidebar");
  if (!tgl || !sb) return;
  tgl.onclick = () => sb.classList.toggle("open");
  // 移动端：选 AM 后自动收起
  sb.addEventListener("click", e => {
    if (e.target.tagName === "BUTTON" && window.innerWidth < 900) {
      sb.classList.remove("open");
    }
  });
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
    if (ov) {
      // V10: AM 视角下用 _k_byam 派生 KPI 卡
      if (STATE.currentAM !== "全组") {
        EL.main.appendChild(buildKByAMCard());
      } else {
        EL.main.appendChild(renderKpiGridCard(ov));
      }
    }
  }
  if (tab.key === "tab6_seller") {
    EL.main.appendChild(buildNewSellerCard());  // V10: 新商家 by AM Top 5
  }
  if (tab.key === "tab5_category" && STATE.currentAM !== "全组") {
    EL.main.appendChild(buildCategoryByAMCard());  // V10: AM 视角类目 Top 15
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

  // V13: 邻居 period 算 TGMV/动销商家数/覆盖场域 环比（仅双月类时段可用）
  const prevKeyHero = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
  const prevLabelHero = prevKeyHero ? (STATE.index.periods.find(p => p.key === prevKeyHero)?.label || prevKeyHero) : "";
  const heroDelta = (curVal, prevVal, label) => {
    if (curVal == null || prevVal == null || prevVal === 0) return null;
    const rate = (curVal - prevVal) / Math.abs(prevVal);
    return {rate, prevVal, label};
  };
  // TGMV 上一时段：从 STATE.cache[prevKey/t1_bimonth_byAM] 拿
  let prevTgmv = null, prevSellerCount = null, prevScenes = null;
  if (prevKeyHero) {
    const prevBy = STATE.cache[`${prevKeyHero}/t1_bimonth_byAM`];
    if (prevBy && prevBy.columns) {
      const tgmvI = findColIdx(prevBy.columns, "TGMV");
      const amI = findColIdx(prevBy.columns, "AM");
      let pTgmv = 0;
      prevBy.rows.forEach(r => {
        const am = r[amI];
        if (am === "总计") return;
        if (isAM && am !== STATE.currentAM) return;
        pTgmv += (r[tgmvI] || 0);
      });
      prevTgmv = pTgmv || null;
    }
    // 动销商家数 — 全组用 _distinct_counts；AM 视角暂时跳过
    if (!isAM) {
      const prevDC = (STATE.distinctCounts || {})[prevKeyHero];
      if (prevDC && prevDC.seller_count != null) {
        prevSellerCount = prevDC.seller_count;
      }
    }
    const prevPerf = STATE.cache[`${prevKeyHero}/t1_yesterday_perf`];
    if (prevPerf && prevPerf.rows) {
      // 覆盖场域 = 非"总计"行的去重数（DGMV > 0）
      const dimI = findColIdx(prevPerf.columns, "载体小类");
      const valI = findColIdxLoose(prevPerf.columns, "DGMV");
      const sceneSet = new Set();
      prevPerf.rows.forEach(r => {
        if (r[dimI] === "总计") return;
        if ((r[valI] || 0) > 0) sceneSet.add(r[dimI]);
      });
      prevScenes = sceneSet.size || null;
    }
  }
  const tgmvDelta = heroDelta(totalTgmv, prevTgmv, prevLabelHero);
  const scDelta = heroDelta(sellerCount === "-" || sellerCount == null ? null : sellerCount, prevSellerCount, prevLabelHero);
  const scenesDelta = heroDelta(scenes === "-" || scenes == null ? null : scenes, prevScenes, prevLabelHero);

  // ============ 卡片清单 ============
  const items = [];
  items.push({label: `${periodLabel} · ${scopeLabel} DGMV`, value: totalGmv,
    delta: deltaPct, deltaLabel});
  if (totalTgmv != null) {
    items.push({label: `${periodLabel} · ${scopeLabel} TGMV`, value: fmt.money(totalTgmv),
      delta: tgmvDelta ? tgmvDelta.rate : null,
      deltaLabel: tgmvDelta ? `vs ${prevLabelHero}` : null,
      prevTip: tgmvDelta ? `vs ${prevLabelHero} TGMV: ${fmt.money(tgmvDelta.prevVal)}（当前 ${fmt.money(totalTgmv)}）` : null});
  }
  items.push({label: "日均 DGMV", value: totalGmvNum != null ? fmt.money(totalGmvNum/days) : "-", sub: `${days} 天`});
  const scLabel = isAM ? `${STATE.currentAM} 名下动销商家` : "动销商家数";
  items.push({label: scLabel, value: (sellerCount === "-" || sellerCount == null) ? "-" : sellerCount + " 家",
    delta: scDelta ? scDelta.rate : null,
    deltaLabel: scDelta ? `vs ${prevLabelHero}` : null,
    prevTip: scDelta ? `vs ${prevLabelHero} 动销商家: ${scDelta.prevVal} 家（当前 ${sellerCount} 家）` : null});
  if (!isAM && scenes !== "-") {
    items.push({label: "覆盖场域", value: scenes + " 个",
      delta: scenesDelta ? scenesDelta.rate : null,
      deltaLabel: scenesDelta ? `vs ${prevLabelHero}` : null,
      prevTip: scenesDelta ? `vs ${prevLabelHero} 覆盖场域: ${scenesDelta.prevVal} 个（当前 ${scenes} 个）` : null});
  }

  items.forEach(it => {
    const c = document.createElement("div");
    c.className = "kpi-card hero";
    let dh = "";
    if (it.delta != null && typeof it.delta === "number" && !isNaN(it.delta)) {
      const abs = Math.abs(it.delta);
      const cls = it.delta >= 0 ? "delta-up" : "delta-down";
      const arrow = it.delta >= 0 ? "↑" : "↓";
      const tipAttr = it.prevTip ? ` data-tip="${it.prevTip}"` : '';
      if (abs > 5) {
        dh = `<div class="delta delta-abnormal"${tipAttr}>${it.deltaLabel||""} 异常</div>`;
      } else if (abs > 1) {
        dh = `<div class="delta ${cls}"${tipAttr}>${arrow}${(abs*100).toFixed(0)}%<span class="muted-mini"> 显著</span> ${it.deltaLabel||""}</div>`;
      } else {
        dh = `<div class="delta ${cls}"${tipAttr}>${arrow} ${(abs*100).toFixed(1)}% ${it.deltaLabel||""}</div>`;
      }
    } else if (it.delta === null && !it.sub) {
      // 双月外时段无环比 — 标注一下
      dh = `<div class="delta muted-mini hint-tip" data-tip="该时段无邻居对照（仅本双月/上双月/去年同期可显示环比）">— 无环比</div>`;
    }
    let sh = it.sub ? `<div class="sub">${it.sub}</div>` : "";
    c.innerHTML = `<div class="label">${it.label}</div><div class="value">${it.value}</div>${dh}${sh}`;
    wrap.appendChild(c);
  });
  return wrap;
}

// ============ V9 新增模块 ============
async function ensureSummaryData(periodKey) {
  // V11: 业绩摘要需要跨 tab 的 chart 数据，按需 fetch
  const needed = ["t1_bimonth_byAM", "t2_note_byAM", "t3_live_byAM", "t4_k_overview"];
  let dirty = false;
  for (const cid of needed) {
    const key = `${periodKey}/${cid}`;
    if (!STATE.cache[key]) {
      await fetchData(periodKey, cid);
      dirty = true;
    }
  }
  // 若 fetch 到新数据且当前页是团队总览，重渲染 summary
  if (dirty && STATE.currentTab === "tab1_team_overview" && STATE.currentPeriod === periodKey) {
    const old = document.querySelector(".summary-card.weekly-report");
    if (old) {
      const tab = STATE.index.tabs.find(t => t.key === STATE.currentTab);
      const datas = await Promise.all(tab.charts.map(c => fetchData(STATE.currentPeriod, c.id)));
      const fresh = buildSummaryCard(datas, tab);
      old.replaceWith(fresh);
    }
  }
}

function buildSummaryCard(datas, tab) {
  // V12: 业绩摘要带环比 + benchmark tooltip
  ensureSummaryData(STATE.currentPeriod);
  const card = document.createElement("section");
  card.className = "summary-card weekly-report";
  const isAM = STATE.currentAM !== "全组";
  const scope = isAM ? STATE.currentAM : "五组（休食）全组";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;
  const am = isAM ? STATE.currentAM : null;
  const period = STATE.index.periods.find(p => p.key === STATE.currentPeriod);

  // 通用 helper
  const findCol = (cols, name) => {
    if (!cols) return -1;
    return cols.findIndex(c => c === name || (c && c.startsWith(name)));
  };
  const getAMRow = (data, amName) => {
    if (!data || !data.rows) return null;
    const ai = findCol(data.columns, "AM");
    if (ai < 0) return null;
    return data.rows.find(r => r[ai] === amName);
  };
  const getTotalRow = (data) => {
    if (!data || !data.rows) return null;
    const ai = findCol(data.columns, "AM");
    if (ai < 0) return data.rows[0];
    return data.rows.find(r => r[ai] === "总计") || null;
  };
  const findDataInCurrent = (cid) => {
    if (tab && tab.charts) {
      const i = tab.charts.findIndex(c => c.id === cid);
      if (i >= 0 && datas[i]) return datas[i];
    }
    return STATE.cache[`${STATE.currentPeriod}/${cid}`] || null;
  };

  // ============= 0、业绩总览 + DGMV 环比（用全组日序列自算） =============
  const bimonthByAM = findDataInCurrent("t1_bimonth_byAM");
  let dgmv = null, tgmv = null;
  if (bimonthByAM) {
    const dgmvI = findCol(bimonthByAM.columns, "DGMV");
    const tgmvI = findCol(bimonthByAM.columns, "TGMV");
    const exclude = new Set(["休食(虚拟员工)","UNKNOWN","总计","",null,undefined]);
    if (am) {
      const r = getAMRow(bimonthByAM, am);
      if (r) { if (dgmvI >= 0) dgmv = r[dgmvI]; if (tgmvI >= 0) tgmv = r[tgmvI]; }
    } else {
      const ai = findCol(bimonthByAM.columns, "AM");
      let sumD = 0, sumT = 0;
      bimonthByAM.rows.forEach(r => {
        if (exclude.has(r[ai])) return;
        if (dgmvI >= 0 && r[dgmvI] != null) sumD += Number(r[dgmvI]) || 0;
        if (tgmvI >= 0 && r[tgmvI] != null) sumT += Number(r[tgmvI]) || 0;
      });
      dgmv = sumD; tgmv = sumT;
    }
  }

  // 用日序列算全组 DGMV 环比（仅全组视角准确）
  const dgmvMoM = (!isAM) ? getPrevPeriodDGMV(STATE.currentPeriod) : null;
  const dgmvBadge = dgmvMoM ? deltaBadge(dgmvMoM.curSum, dgmvMoM.prevSum, dgmvMoM.prevLabel, {fmt: fmt.money}) : "";

  let bimonthSection = "";
  if (STATE.currentPeriod === "this_bimonth" && tgmv) {
    const now = new Date();
    const day = now.getDate();
    const totalDays = 61;
    const elapsed = (now.getMonth() === 4) ? day : 30 + day;
    const pct = (elapsed / totalDays * 100).toFixed(1);
    const gapHint = hint(`MTD = 当前本双月累计 DGMV；TGMV = 本双月目标；时间进度 = 已过天数/61天，理想节奏下 MTD 应≥ TGMV × 时间进度`);
    bimonthSection = `
      <div class="wr-section">
        <div class="wr-section-title">📊 0、双月 DGMV 目标达成 ${gapHint}</div>
        <div class="wr-line">
          MTD 达成 <b>${fmt.money(dgmv || 0)}</b> ${dgmvBadge} ·
          TGMV <b>${fmt.money(tgmv)}</b>，时间进度 <b>${pct}%</b>
        </div>
      </div>
    `;
  } else if (dgmv != null) {
    const dHint = hint(`DGMV = 当前时段 ${period.start} ~ ${period.end} 内动销 GMV；TGMV = 同期 GMV 总盘`);
    bimonthSection = `
      <div class="wr-section">
        <div class="wr-section-title">📊 0、业绩总览（${periodLabel}） ${dHint}</div>
        <div class="wr-line">
          DGMV <b>${fmt.money(dgmv)}</b> ${dgmvBadge}
          ${tgmv ? ` · TGMV <b>${fmt.money(tgmv)}</b>` : ""}
        </div>
      </div>
    `;
  }

  // ============= 场域进展 =============
  const noteByAM = findDataInCurrent("t2_note_byAM");
  const kOv = findDataInCurrent("t4_k_overview");
  const findColI = (cols, kw) => cols.findIndex(c => c && c.includes(kw) && !c.includes("环比") && !c.includes("年同比") && !c.includes("_"));
  const findRateI = (cols, kw) => cols.findIndex(c => c && c === "环比上期_环比-变化率");

  // 笔记
  let noteLine = "—";
  if (noteByAM) {
    const row = am ? getAMRow(noteByAM, am) : getTotalRow(noteByAM);
    if (row) {
      const cols = noteByAM.columns;
      const ndgmvI = findColI(cols, "商笔DGMV");
      const cntI = findColI(cols, "新发商笔数");
      const expI = findColI(cols, "商笔曝光量");
      const ndgmv = ndgmvI >= 0 ? row[ndgmvI] : null;
      const cnt = cntI >= 0 ? row[cntI] : null;
      const exp = expI >= 0 ? row[expI] : null;
      // 环比字段（chart 自带）：第一个 "环比上期_环比-变化率" 是 DGMV 的；其它字段同样模式 _环比-变化率_1/_2
      const dgmvRateI = cols.indexOf("环比上期_环比-变化率");
      const cntRateI = cols.indexOf("环比上期_环比-变化率_1");
      const expRateI = cols.indexOf("环比上期_环比-变化率_2");
      const dgmvRate = (dgmvRateI >= 0) ? row[dgmvRateI] : null;
      const cntRate = (cntRateI >= 0) ? row[cntRateI] : null;
      const expRate = (expRateI >= 0) ? row[expRateI] : null;
      const renderRate = (r, label) => {
        if (r == null) return "";
        if (Math.abs(r) > 5) return ` <span class='delta-badge delta-abnormal' data-tip='${label} 变化异常'>⚠</span>`;
        const cls = r >= 0 ? "delta-up" : "delta-down", a = r >= 0 ? "↑" : "↓";
        return ` <span class='delta-badge ${cls}' data-tip='${label}'>${a} ${Math.abs(r*100).toFixed(1)}%</span>`;
      };
      noteLine = `DGMV <b>${fmt.money(ndgmv || 0)}</b>${renderRate(dgmvRate, "vs 上一同长度时段 DGMV 环比")}${hint("商笔 DGMV = 商品笔记带来的动销 GMV；环比来自 BI chart 同口径计算")}<br/>
        <span class='wr-sub'>新发笔记 <b>${cnt ? cnt.toLocaleString("zh-CN") : "—"}</b> 篇${renderRate(cntRate, "vs 上一同长度时段 新发笔记数 环比")} · 曝光 <b>${exp ? (exp > 1e8 ? (exp/1e8).toFixed(2)+"亿" : (exp/1e4).toFixed(0)+"万") + " PV" : "—"}</b>${renderRate(expRate, "vs 上一同长度时段 曝光量 环比")}</span>`;
    }
  }

  // 店播
  let liveLine = "—";
  const lbAll = (STATE.liveBreakdown || {})[STATE.currentPeriod] || {};
  const lb = lbAll[am || "全组"];
  if (lb) {
    // 计算店播 DGMV 环比：用上一时段 _live_breakdown
    const prevKey = (function(){
      const map = {yesterday: null, last_7d: null, last_14d: null, last_30d: null,
                   this_month: null, this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth", yoy_bimonth: null};
      return map[STATE.currentPeriod];
    })();
    const prevLb = prevKey ? (((STATE.liveBreakdown || {})[prevKey] || {})[am || "全组"]) : null;
    // V13 优先用 chart 自带 mom（全 8 时段）
    let liveBadge = "", durBadge = "", sellersBadge = "";
    if (lb.dgmv_mom != null) {
      liveBadge = deltaBadge(lb.dgmv, lb.dgmv/(1+lb.dgmv_mom), "上一同长度时段（chart 自算）", {fmt: fmt.money});
    } else if (prevLb && prevLb.dgmv != null) {
      liveBadge = deltaBadge(lb.dgmv, prevLb.dgmv, `${STATE.index.periods.find(p=>p.key===prevKey)?.label||prevKey} 店播 DGMV`, {fmt: fmt.money});
    }
    if (lb.duration_mom != null) {
      durBadge = deltaBadge(lb.duration_h, lb.duration_h/(1+lb.duration_mom), "上一同长度时段（chart 自算）", {fmt: v => v.toLocaleString("zh-CN",{maximumFractionDigits:0})+"h"});
    }
    if (lb.live_seller_count_mom != null) {
      sellersBadge = deltaBadge(lb.live_seller_count, lb.live_seller_count/(1+lb.live_seller_count_mom), "上一同长度时段（chart 自算）", {fmt: v => Math.round(v)+"家"});
    }
    const tipDur = "开播时长 = 商家直播间累计开播小时数（dataset 5574）";
    const tipCTR = "CTR = 店播卡片点击 PV / 曝光 PV";
    const tipAov = "客单 = 店播 DGMV / 购买 PV";
    liveLine = `DGMV <b>${fmt.money(lb.dgmv || 0)}</b> ${liveBadge}<br/>
      <span class='wr-sub'>开播商家 <b>${lb.live_seller_count || "—"}</b> 家 ${sellersBadge}${hint("当时段内有过开播的商家去重数（dataset 5574 店铺ID distinct）")} · 时长 <b>${(lb.duration_h||0).toLocaleString("zh-CN",{maximumFractionDigits:0})} h</b> ${durBadge}${hint(tipDur)} · CTR <b>${((lb.card_ctr||0)*100).toFixed(2)}%</b>${hint(tipCTR)} · 客单 <b>¥${(lb.aov||0).toFixed(1)}</b>${hint(tipAov)}</span>`;
  }

  // K 播
  let kLine = "—";
  const kbyAM = ((STATE.kByAM || {})[STATE.currentPeriod] || {})[am || "全组"];
  if (kbyAM && kbyAM.dgmv != null) {
    // 同样基于上一时段
    const prevKey = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
    const prevK = prevKey ? (((STATE.kByAM || {})[prevKey] || {})[am || "全组"]) : null;
    const kBadge = prevK ? deltaBadge(kbyAM.dgmv, prevK.dgmv, `${STATE.index.periods.find(p=>p.key===prevKey)?.label||prevKey} K播 DGMV`, {fmt: fmt.money}) : "";
    kLine = `DGMV <b>${fmt.money(kbyAM.dgmv)}</b> ${kBadge}<br/>
      <span class='wr-sub'>动销商家 <b>${(kbyAM.active_sellers||0).toLocaleString("zh-CN")}</b> 家${hint("当时段内有过 K 播带货成交的商家数（dataset 1922 载体=K播 去重）")} · 订单 <b>${(kbyAM.orders||0).toLocaleString("zh-CN")}</b> 单${hint("K 播带来的购买订单总数")}</span>`;
  } else if (kOv && !isAM) {
    const cols = kOv.columns;
    const dgmvI2 = cols.findIndex(c => c === "DGMV（元）");
    const showI = cols.findIndex(c => c.includes("场次"));
    const anchorI = cols.findIndex(c => c.includes("主播"));
    const dgmvRateI = cols.findIndex(c => c === "DGMV（元）_环比-变化率");
    const r = kOv.rows[0];
    if (r) {
      const dgmvRate = dgmvRateI >= 0 ? r[dgmvRateI] : null;
      const renderRate = (rt, lbl) => {
        if (rt == null) return "";
        if (Math.abs(rt) > 5) return ` <span class='delta-badge delta-abnormal' data-tip='${lbl} 变化异常'>⚠</span>`;
        const cls = rt >= 0 ? "delta-up" : "delta-down", a = rt >= 0 ? "↑" : "↓";
        return ` <span class='delta-badge ${cls}' data-tip='${lbl}'>${a} ${Math.abs(rt*100).toFixed(1)}%</span>`;
      };
      kLine = `DGMV <b>${fmt.money(r[dgmvI2] || 0)}</b>${renderRate(dgmvRate, "vs 上一同长度时段 K播 DGMV 环比（chart 自带）")}<br/>
        <span class='wr-sub'>动销主播 <b>${r[anchorI] ? r[anchorI].toLocaleString("zh-CN") : "—"}</b> 位${hint("当时段内有过带货成交的 K 播主播数")} · 场次 <b>${r[showI] ? r[showI].toLocaleString("zh-CN") : "—"}</b> 场${hint("K 播开播场次数")}</span>`;
    }
  }

  // ============= 新商 =============
  const ns = STATE.newSeller || {};
  const new30d = (ns.new_30d && ns.new_30d.count) ? ns.new_30d.count[am || "全组"] : null;
  const new2026 = (ns.new2026_active && ns.new2026_active.count) ? ns.new2026_active.count[am || "全组"] : null;
  const new2026DGMV = (ns.new2026_active && ns.new2026_active.dgmv) ? ns.new2026_active.dgmv[am || "全组"] : null;
  const newHint = hint("新商家数据与时段无关：近 30 天 = 最近 30 天新入驻的商家；2026 新开本月动销 = 2026 年新入驻且本月有成交的商家");

  const body = `
    ${bimonthSection}
    <div class="wr-section">
      <div class="wr-section-title">🎯 1、场域进展（${period.start} ~ ${period.end}）${hint(`所有场域 DGMV 均按 ${period.start} ~ ${period.end} 时段聚合；环比基准 = 上一同长度时段`)}</div>
      <div class="wr-channel"><div class="wr-channel-name">🎬 店播</div><div class="wr-line">${liveLine}</div></div>
      <div class="wr-channel"><div class="wr-channel-name">📺 K 播</div><div class="wr-line">${kLine}</div></div>
      <div class="wr-channel"><div class="wr-channel-name">📝 商笔</div><div class="wr-line">${noteLine}</div></div>
    </div>
    <div class="wr-section">
      <div class="wr-section-title">📦 2、新商（近 30 天）${newHint}</div>
      <div class="wr-line">
        近 30 天新开商家 <b>${new30d != null ? new30d : "—"}</b> 家 ·
        2026 新开商家本月动销 <b>${new2026 != null ? new2026 : "—"}</b> 家
        ${new2026DGMV != null ? ` · 贡献 <b>${fmt.money(new2026DGMV)}</b>` : ""}
      </div>
    </div>
    <div class="wr-footer muted">
      📌 当前时段：<b>${periodLabel}</b> · 切换顶部时段筛选可联动所有数据 ·
      鼠标悬停 <span class="hint-tip">ⓘ</span> 查看字段口径；悬停 <span class="delta-badge delta-up">↑ 12%</span> 看对比基准
    </div>
  `;

  card.innerHTML = `
    <div class="summary-header">📋 业绩摘要 · ${scope} · ${periodLabel}</div>
    <div class="summary-body">${body}</div>
  `;
  return card;
}
function buildCategoryByAMCard() {
  // V10: AM 视角下二级类目 DGMV Top 15（笔记）
  const card = document.createElement("section");
  card.className = "chart-card category-byam-card";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;
  const am = STATE.currentAM;
  const data = ((STATE.categoryByAM || {})[STATE.currentPeriod] || {})[am] || [];
  if (!data.length) {
    card.innerHTML = `<div class='chart-header'><div class='chart-title'>📦 ${am} · 二级类目 Top 15（笔记 DGMV）</div></div>
      <div class='empty'>暂无该 AM 类目数据</div>`;
    return card;
  }
  const top = data.slice(0, 15);
  const total = top.reduce((s,x)=>s+x.dgmv, 0);
  const max = top[0].dgmv;
  const rowsHTML = top.map((x,i) => {
    const pct = (x.dgmv / total * 100).toFixed(1);
    const bar = (x.dgmv / max * 100).toFixed(0);
    return `
      <li class="cb-row">
        <span class="cb-rank">${i+1}</span>
        <span class="cb-cat">${x.category}</span>
        <span class="cb-bar-wrap"><span class="cb-bar" style="width:${bar}%"></span></span>
        <span class="cb-gmv">${fmt.money(x.dgmv)}</span>
        <span class="cb-pct muted">${pct}%</span>
      </li>
    `;
  }).join("");
  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>📦 ${am} · 二级类目 Top 15（笔记 DGMV）</div>
      <div class='chart-meta muted'>${periodLabel} · 合计 ${fmt.money(total)}</div>
    </div>
    <ol class="cb-list">${rowsHTML}</ol>
    <div class='bd-tip muted'>💡 AM 视角下二级类目细分。本卡为 by AM 派生，下方"全组类目分布"卡仍展示全组（带角标）。</div>
  `;
  return card;
}

function buildKByAMCard() {
  // V10: K 播 AM 派生 KPI 卡
  const card = document.createElement("section");
  card.className = "chart-card k-byam-card";
  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;
  const am = STATE.currentAM;
  const all = (STATE.kByAM || {})[STATE.currentPeriod] || {};
  const data = all[am];
  const grp = all["全组"];
  if (!data) {
    card.innerHTML = `<div class='chart-header'><div class='chart-title'>📺 K 播核心指标 · ${am}</div></div>
      <div class='empty'>暂无该 AM 的 K 播 by AM 数据</div>`;
    return card;
  }
  const ratio = (data.dgmv && grp && grp.dgmv) ? data.dgmv / grp.dgmv : null;
  // V12 环比
  const prevKey = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
  const prev = prevKey ? ((STATE.kByAM || {})[prevKey] || {})[am] : null;
  const prevLabel = prevKey ? (STATE.index.periods.find(p=>p.key===prevKey)?.label || prevKey) : "";
  const dgmvBadge = prev ? deltaBadge(data.dgmv, prev.dgmv, `${prevLabel} K播 DGMV`, {fmt: fmt.money}) : "";
  const sBadge = prev ? deltaBadge(data.active_sellers, prev.active_sellers, `${prevLabel} K播 动销商家数`, {fmt: v=>v.toLocaleString("zh-CN")}) : "";
  const oBadge = prev ? deltaBadge(data.orders, prev.orders, `${prevLabel} K播 订单数`, {fmt: v=>v.toLocaleString("zh-CN")}) : "";
  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>📺 K 播核心指标 · ${am} ${hint("AM 视角下 K 播指标（dataset 1922 载体=K播 按 AM 分组）；环比 = vs 同 AM 上一时段")}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    <div class='kpi-grid'>
      <div class='kpi-cell'>
        <div class='kpi-label'>K 播 DGMV ${hint("当 AM 名下 K 播带货成交 GMV")}</div>
        <div class='kpi-num'>${fmt.money(data.dgmv || 0)} ${dgmvBadge}</div>
        ${ratio != null ? `<div class='kpi-sub muted' data-tip='全组 K 播 DGMV ${fmt.money(grp.dgmv)}'>占全组 ${(ratio*100).toFixed(1)}%</div>` : ""}
      </div>
      <div class='kpi-cell'>
        <div class='kpi-label'>动销商家数 ${hint("当 AM 名下有过 K 播带货成交的商家数（distinct）")}</div>
        <div class='kpi-num'>${(data.active_sellers||0).toLocaleString("zh-CN")} <span class='unit'>家</span> ${sBadge}</div>
      </div>
      <div class='kpi-cell'>
        <div class='kpi-label'>购买订单数 ${hint("K 播带来的购买订单总数（订单维度）")}</div>
        <div class='kpi-num'>${(data.orders||0).toLocaleString("zh-CN")} <span class='unit'>单</span> ${oBadge}</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 K 播主播榜在下方（K 播是主播维度业务，无 AM 直接拆分，全组维度看主播个体）。</div>
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
      <span>近 30 天新开 <b>${new30d != null ? new30d : "—"}</b> 家${hint("最近 30 天内入驻平台的商家数（dataset 2479 商家入驻时间 distinct）")}</span>
      <span>· 2026 新开本月动销 <b>${new2026 != null ? new2026 : "—"}</b> 家${hint("2026 年新入驻 + 本月有过成交的商家数")}</span>
      ${new2026DGMV != null ? `<span>· 贡献 <b>${fmt.money(new2026DGMV)}</b>${hint("2026 新商家本月成交 GMV 总和；衡量新商起量速度")}</span>` : ""}
    </div>
  `;

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>🆕 新商家动销 Top（by AM）· ${scope} ${hint("当前时段内 ${scope} 名下 2026 新开商家的成交 Top 5；用于跟踪新商起量、做周报「新商」模块素材")}</div>
      <div class='chart-meta muted'>${periodLabel} · 时段内成交</div>
    </div>
    ${headerStats}
    <div class="ns-grid">${cardListHTML}</div>
    <div class='bd-tip muted'>💡 点击商家名跳转苍穹后台。新商家无环比（新开商家本就在变化），看绝对量级。</div>
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

  // V12: 全组对比（AM 视角下）+ 上一时段环比（任意视角）
  const allGroup = periodData["全组"] || {};
  // AM 视角下用 6 AM 算人均 base（dgmv/duration_h/exposure_per_hour 是加法/平均，其它率指标本身可比）
  const cmpAvg = (key, isRate) => {
    if (!isAM || data[key] == null) return "";
    if (allGroup[key] == null) return "";
    const base = isRate ? allGroup[key] : (allGroup[key] / 6);
    const ratio = data[key] / base;
    if (ratio > 1.1) return `<span class='delta-badge delta-up' data-tip='vs 全组${isRate?'均值':'人均'} ${isRate ? (base*100).toFixed(2)+'%' : fmtN(base,1)}'>↑ ${((ratio-1)*100).toFixed(0)}%</span>`;
    if (ratio < 0.9) return `<span class='delta-badge delta-down' data-tip='vs 全组${isRate?'均值':'人均'} ${isRate ? (base*100).toFixed(2)+'%' : fmtN(base,1)}'>↓ ${((1-ratio)*100).toFixed(0)}%</span>`;
    return `<span class='delta-badge' data-tip='vs 全组${isRate?'均值':'人均'} ${isRate ? (base*100).toFixed(2)+'%' : fmtN(base,1)}' style='background:#f1f5f9;color:#64748b;'>≈</span>`;
  };
  // V12 环比 — 双月类时段（this_bimonth / last_bimonth）用 _live_breakdown 上时段
  const prevKey = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
  const prevData = prevKey ? (periodData === lb[STATE.currentPeriod] ? (lb[prevKey] || {})[scope] : null) : null;
  // V13 升级 — DGMV / 时长 / 商家数 用 chart 自带 _mom（全 8 时段可用）
  const momKeyMap = {dgmv: "dgmv_mom", duration_h: "duration_mom", live_seller_count: "live_seller_count_mom"};
  const cmpMoM = (key, isRate) => {
    // 优先走 chart 自带 mom
    const momKey = momKeyMap[key];
    if (momKey && data[momKey] != null) {
      const rate = data[momKey];
      const prevVal = data[key] / (1 + rate);  // 反推上一时段值给 tooltip
      const fmtRef = isRate ? (v => (v*100).toFixed(2)+'%') : (v => fmtN(v,1));
      return deltaBadge(data[key], prevVal, "上一同长度时段（chart 自算）", {fmt: fmtRef});
    }
    // 后备：双月类时段才有的 prevData
    if (!prevData || prevData[key] == null || data[key] == null) return "";
    const prevLabel = STATE.index.periods.find(p => p.key === prevKey)?.label || prevKey;
    const fmtRef = isRate ? (v => (v*100).toFixed(2)+'%') : (v => fmtN(v,1));
    return deltaBadge(data[key], prevData[key], `${prevLabel} 同口径`, {fmt: fmtRef});
  };

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>📺 店播效率拆解 · ${scope} ${hint("公式：开播时长 × 曝光/h × 卡片CTR × 商详率 × 购买CVR × 客单价 = 店播 DGMV；数据源 dataset 5574")}</div>
      <div class='chart-meta muted'>${periodLabel} · 数据源 dataset 5574</div>
    </div>
    <div class='breakdown-chain'>
      <div class='bd-step'>
        <div class='bd-num'>${fmtN(data.duration_h, 0)} h</div>
        <div class='bd-label'>① 总开播时长 ${hint("商家累计直播开播秒数 ÷ 3600；越大说明供给越足")}</div>
        <div class='bd-cmp'>${cmpAvg("duration_h", false)}${cmpMoM("duration_h", false)}</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtN(data.exposure_per_hour, 0)}</div>
        <div class='bd-label'>② 曝光 PV/h ${hint("店播商卡曝光 PV ÷ 总开播时长；衡量平台推流强度")}</div>
        <div class='bd-cmp'>${cmpAvg("exposure_per_hour", true)}${cmpMoM("exposure_per_hour", false)}</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtPct(data.card_ctr)}</div>
        <div class='bd-label'>③ 卡片 CTR ${hint("商卡点击 PV / 商卡曝光 PV；商品的卡片吸引力")}</div>
        <div class='bd-cmp'>${cmpAvg("card_ctr", true)}${cmpMoM("card_ctr", true)}</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtPct(data.detail_rate)}</div>
        <div class='bd-label'>④ 商详率 ${hint("商详曝光 UV / 商卡点击 PV；点击后是否真去看商详")}</div>
        <div class='bd-cmp'>${cmpAvg("detail_rate", true)}${cmpMoM("detail_rate", true)}</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${fmtPct(data.purchase_cvr)}</div>
        <div class='bd-label'>⑤ 购买 CVR ${hint("购买 PV / 商详曝光 UV；商详到购买的最终转化")}</div>
        <div class='bd-cmp'>${cmpAvg("purchase_cvr", true)}${cmpMoM("purchase_cvr", true)}</div>
      </div>
      <div class='bd-arrow'>×</div>
      <div class='bd-step'>
        <div class='bd-num'>${data.aov != null ? "¥" + fmtN(data.aov, 1) : "—"}</div>
        <div class='bd-label'>⑥ 客单价 ${hint("店播 DGMV / 购买 PV；客户购买的平均订单价值")}</div>
        <div class='bd-cmp'>${cmpAvg("aov", true)}${cmpMoM("aov", true)}</div>
      </div>
      <div class='bd-arrow'>=</div>
      <div class='bd-step bd-result'>
        <div class='bd-num'>${data.dgmv != null ? fmt.money(data.dgmv) : "—"}</div>
        <div class='bd-label'>店播 DGMV ${hint("当前时段店播带来的动销 GMV")}</div>
        <div class='bd-cmp'>${cmpAvg("dgmv", false)}${cmpMoM("dgmv", false)}</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 6 层完整漏斗。badge 上数字悬停可看对比基准。哪层最低就是优化重点。</div>
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

  // V12: 上一时段环比
  const prevKey = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
  const prevPD = prevKey ? ((STATE.liveBreakdown || {})[prevKey] || {}) : {};
  const prevData = prevPD[scope];
  const prevAscAll = prevKey ? ((STATE.amSellerCounts || {})[prevKey] || {}) : {};
  const prevTotalSellers = prevAscAll[scope];
  const cmpMoM = (key, curVal, isRate, isDerived) => {
    // V13: 优先用 chart 自带 mom（覆盖全 8 时段）
    if (key === "duration_h" && data.duration_mom != null) {
      const rate = data.duration_mom;
      const prevVal = curVal / (1 + rate);
      return deltaBadge(curVal, prevVal, "上一同长度时段（chart 自算）", {fmt: v => fmtN(v,1)});
    }
    if (!prevData || curVal == null) return "";
    let benchVal = null;
    if (key === "openRatio") {
      benchVal = (prevData.live_seller_count && prevTotalSellers) ? prevData.live_seller_count / prevTotalSellers : null;
    } else if (key === "avgDurationPerSeller") {
      benchVal = (prevData.duration_h && prevData.live_seller_count) ? prevData.duration_h / prevData.live_seller_count : null;
    } else {
      benchVal = prevData[key];
    }
    if (benchVal == null) return "";
    const prevLabel = STATE.index.periods.find(p => p.key === prevKey)?.label || prevKey;
    const fmtRef = isRate ? (v => (v*100).toFixed(2)+'%') : (v => fmtN(v,1));
    return deltaBadge(curVal, benchVal, `${prevLabel} 同口径`, {fmt: fmtRef});
  };

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>🎯 店播勤奋度（可比指标）· ${scope} ${hint("vs 全组 = 当前 AM vs 五组全平均；vs 上时段 = 同 scope 上一时段同口径环比")}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    <div class='efficiency-grid'>
      <div class='eff-cell highlight'>
        <div class='eff-label'>① 开播商家占比 ${hint("开播商家数 / 名下动销商家数；衡量直播覆盖率")}</div>
        <div class='eff-num'>${fmtPct(openRatio)}</div>
        <div class='eff-sub'>${liveSellerCount != null ? fmtN(liveSellerCount) : "—"} / ${totalSellers != null ? fmtN(totalSellers) : "—"} 家 ${cmp("openRatio", openRatio)} ${cmpMoM("openRatio", openRatio, true)}</div>
      </div>
      <div class='eff-cell highlight'>
        <div class='eff-label'>② 商均开播时长 ${hint("总开播时长 / 开播商家数；衡量商家投入度")}</div>
        <div class='eff-num'>${fmtN(avgDurationPerSeller, 0)}<span class='unit'> h/商家</span></div>
        <div class='eff-sub'>${cmp("avgDurationPerSeller", avgDurationPerSeller)} ${cmpMoM("avgDurationPerSeller", avgDurationPerSeller, false)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>③ 单位时长曝光 ${hint("店播商卡曝光 PV / 总开播时长；衡量平台推流密度")}</div>
        <div class='eff-num'>${fmtN(expPerHour, 0)}<span class='unit'> PV/h</span></div>
        <div class='eff-sub'>${cmp("exposure_per_hour", expPerHour)} ${cmpMoM("exposure_per_hour", expPerHour, false)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>④ 购买 CTR ${hint("店播购买 PV / 曝光 PV；端到端转化率（旧口径，下方店播效率拆解中拆得更细）")}</div>
        <div class='eff-num'>${fmtPct(ctr)}</div>
        <div class='eff-sub'>${cmp("ctr", ctr)} ${cmpMoM("ctr", ctr, true)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>⑤ UV 转化率 ${hint("购买 PV / 观播 UV；商家流量转化效率")}</div>
        <div class='eff-num'>${fmtPct(cvr)}</div>
        <div class='eff-sub'>${cmp("cvr", cvr)} ${cmpMoM("cvr", cvr, true)}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>⑥ 客单价 ${hint("店播 DGMV / 购买 PV；平均订单金额")}</div>
        <div class='eff-num'>${aov != null ? "¥" + fmtN(aov, 0) : "—"}</div>
        <div class='eff-sub'>${cmp("aov", aov)} ${cmpMoM("aov", aov, false)}</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 所有指标已归一化，可横向对比 AM。悬停 ⓘ 看定义；悬停 ↑↓ 徽章看对比基准数值。</div>
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
  // V10: AM 视角下覆盖 ctr/cvr 用 _note_ctr_cvr_byam（dataset 1922 按 AM 分组）
  if (isAM) {
    const amCC = ((STATE.noteCtrCvrByAM || {})[STATE.currentPeriod] || {})[STATE.currentAM];
    if (amCC) {
      if (amCC.ctr != null) ctr = amCC.ctr;
      if (amCC.cvr != null) cvr = amCC.cvr;
    }
  }

  const avgPerSeller = (sellerCount && noteCount) ? noteCount / sellerCount : null;
  const avgExpPerNote = (noteCount && exposure) ? exposure / noteCount : null;
  const fmtN = (v, digits=1) => v == null ? "—" : v.toLocaleString("zh-CN",{maximumFractionDigits:digits});
  const fmtPct = (v) => v == null ? "—" : (v*100).toFixed(2) + "%";

  // CTR / CVR vs benchmark（带 tooltip 标准）
  const cmpVsBench = (val, bench, label) => {
    if (val == null || !bench) return "";
    const ratio = val / bench;
    const tip = `${label}：${(bench*100).toFixed(2)}%（当前 ${(val*100).toFixed(2)}%）`;
    if (ratio > 1.05) return `<span class='delta-badge delta-up' data-tip='${tip}'>↑ 高于全平台 ${((ratio-1)*100).toFixed(0)}%</span>`;
    if (ratio < 0.95) return `<span class='delta-badge delta-down' data-tip='${tip}'>↓ 低于全平台 ${((1-ratio)*100).toFixed(0)}%</span>`;
    return `<span class='delta-badge' style='background:#f1f5f9;color:#64748b;' data-tip='${tip}'>≈ 全平台</span>`;
  };
  const ctrCmp = cmpVsBench(ctr, benchCtr, "全平台 CTR benchmark");
  const cvrCmp = cmpVsBench(cvr, benchCvr, "全平台 CVR benchmark");

  // V12: vs 上一时段笔记勤奋度环比
  const prevKey = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
  const prevAscAll = prevKey ? ((STATE.amSellerCounts || {})[prevKey] || {}) : {};
  const prevSC = prevAscAll[isAM ? STATE.currentAM : "全组"];
  const prevNCC = prevKey ? (((STATE.noteCtrCvrByAM || {})[prevKey] || {})[isAM ? STATE.currentAM : null]) : null;
  const prevBench = prevKey ? ((STATE.noteBenchmark || {})[prevKey] || {}) : {};
  const prevLabel = prevKey ? (STATE.index.periods.find(p => p.key === prevKey)?.label || prevKey) : "";
  const prevCtr = (isAM && prevNCC) ? prevNCC.ctr : prevBench.ctr;
  const prevCvr = (isAM && prevNCC) ? prevNCC.cvr : prevBench.cvr;
  const ctrMoM = prevCtr ? deltaBadge(ctr, prevCtr, `${prevLabel} 同 scope CTR`, {fmt: v => (v*100).toFixed(2)+'%'}) : "";
  const cvrMoM = prevCvr ? deltaBadge(cvr, prevCvr, `${prevLabel} 同 scope CVR`, {fmt: v => (v*100).toFixed(2)+'%'}) : "";
  const scMoM = (prevSC != null && sellerCount) ? deltaBadge(sellerCount, prevSC, `${prevLabel} 同 scope 动销商家`, {fmt: v => fmtN(v,0)}) : "";

  card.innerHTML = `
    <div class='chart-header'>
      <div class='chart-title'>📝 商品笔记勤奋度 · 可比指标 · ${scope} ${hint("勤奋度指标都是归一化的，避免被商家盘子大小绑架；红绿徽章悬停可看对比基准")}</div>
      <div class='chart-meta muted'>${periodLabel}</div>
    </div>
    <div class='efficiency-grid'>
      <div class='eff-cell'>
        <div class='eff-label'>📚 名下动销商家 ${hint("当时段内 ${scope} 名下有过商品笔记成交的商家数（distinct count，过滤虚拟员工/未知）")}</div>
        <div class='eff-num'>${sellerCount != null ? sellerCount : "—"}<span class='unit'> 家</span></div>
        <div class='eff-sub'>${scMoM || `<span class='muted'>—</span>`}</div>
      </div>
      <div class='eff-cell highlight'>
        <div class='eff-label'>① 商家平均发商品笔记数 ${hint("数量勤奋度 = 时段内新发笔记数 / 动销商家数；衡量商家发笔记的活跃度")}</div>
        <div class='eff-num'>${avgPerSeller != null ? fmtN(avgPerSeller, 1) : "—"}<span class='unit'> 篇/商家</span></div>
        <div class='eff-sub muted'>共 ${noteCount != null ? fmtN(noteCount, 0) : "—"} 篇</div>
      </div>
      <div class='eff-cell highlight'>
        <div class='eff-label'>② 笔记平均曝光 ${hint("质量勤奋度 = 总曝光 PV / 笔记数；衡量笔记的内容质量+推荐效率")}</div>
        <div class='eff-num'>${avgExpPerNote != null ? fmtN(avgExpPerNote/1000, 1) : "—"}<span class='unit'>k PV/篇</span></div>
        <div class='eff-sub muted'>总曝光 ${exposure != null ? fmt.money(exposure).replace("¥","") : "—"} PV</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>③ 笔记 CTR ${hint("商品笔记 CTR ≈ 商详 UV 转化率（曝光 → 商详 UV），数据源 dataset 1922")}</div>
        <div class='eff-num'>${fmtPct(ctr)}</div>
        <div class='eff-sub'>${ctrCmp || `<span class='muted'>—</span>`} ${ctrMoM}</div>
      </div>
      <div class='eff-cell'>
        <div class='eff-label'>④ 笔记 CVR ${hint("商品笔记 CVR ≈ 购买转化率（商详 → 购买），数据源 dataset 1922")}</div>
        <div class='eff-num'>${fmtPct(cvr)}</div>
        <div class='eff-sub'>${cvrCmp || `<span class='muted'>—</span>`} ${cvrMoM}</div>
      </div>
      <div class='eff-cell benchmark-cell'>
        <div class='eff-label'>📊 全平台 benchmark ${hint("全平台 = 整个小红书电商所有商家在当前时段的均值（dataset 1922 不分组）；判断五组水平的参照系")}</div>
        <div class='eff-num benchmark'>${fmtPct(benchCtr)} / ${fmtPct(benchCvr)}</div>
        <div class='eff-sub muted'>CTR / CVR · 全平台均值</div>
      </div>
    </div>
    <div class='bd-tip muted'>💡 悬停 <span class="hint-tip">ⓘ</span> 看指标定义；悬停红/绿徽章看对比基准（vs 全平台 / vs 上时段）。</div>
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

  // V13: chart 自带 rate 字段不可信（148倍涨幅离谱），改用邻居 period chart 数据算
  // 仅对 this_bimonth/last_bimonth 可对照（其它时段无邻居 chart 数据）
  const prevKey = ({this_bimonth: "last_bimonth", last_bimonth: "yoy_bimonth"})[STATE.currentPeriod];
  const prevChartKey = prevKey ? `${prevKey}/t1_yesterday_perf` : null;
  const prevData = prevChartKey ? STATE.cache[prevChartKey] : null;
  const prevDimVal = {};
  if (prevData && prevData.columns) {
    const pDimI = findColIdx(prevData.columns, cfg.dim);
    const pValI = findColIdxLoose(prevData.columns, cfg.value);
    prevData.rows.forEach(r => {
      const dim = r[pDimI];
      if (dim && dim !== "总计") prevDimVal[dim] = r[pValI];
    });
  }
  const prevLabel = prevKey ? (STATE.index.periods.find(p => p.key === prevKey)?.label || prevKey) : "";

  const grid = document.createElement("div");
  grid.className = "grid-donut";
  const chartBox = document.createElement("div");
  chartBox.className = "echarts-box";
  chartBox.style.height = "320px";
  grid.appendChild(chartBox);

  const tbl = document.createElement("div");
  tbl.className = "side-table";
  const envTip = prevKey ? `vs ${prevLabel}（同口径）` : "暂无邻居时段对照（仅本双月/上双月/去年同期可显示环比）";
  let html = `<table class="data-table"><thead><tr><th>场域</th><th class="num">DGMV</th><th class="num">占比</th><th class="num" data-tip="${envTip}">环比 ${prevKey?'<span class="hint-tip">ⓘ</span>':'<span class="hint-tip" data-tip="'+envTip+'">ⓘ</span>'}</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const v = r[valI];
    const pct = total > 0 ? (v/total*100).toFixed(1)+"%" : "-";
    // V13: 改用邻居 period 算 delta
    const dim = r[dimI];
    const prevV = prevDimVal[dim];
    let envCell = '<span class="muted">—</span>';
    if (prevKey && prevV != null && v != null && prevV !== 0) {
      const rate = (v - prevV) / Math.abs(prevV);
      envCell = `<span class="${rate>=0?'delta-up':'delta-down'}" data-tip="vs ${prevLabel}: ${fmt.money(prevV)}（当前 ${fmt.money(v)}）">${rate>=0?'↑':'↓'} ${Math.abs(rate*100).toFixed(1)}%</span>`;
    }
    html += `<tr><td>${dim}</td><td class="num">${fmt.money(v)}</td><td class="num">${pct}</td><td class="num">${envCell}</td></tr>`;
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
