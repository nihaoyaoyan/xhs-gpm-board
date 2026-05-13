/* 休食组业绩看板 V3 — 视觉重做（去除大门偏向、修异常环比、商品/商家加链接） */
const STATE = {
  index: null,
  currentPeriod: "this_bimonth",
  currentTab: "tab1_team_overview",
  cache: {},
  echarts: [],
};
const EL = {
  meta: document.getElementById("generated-at"),
  periodButtons: document.getElementById("period-buttons"),
  periodInfo: document.getElementById("period-info"),
  tabBar: document.getElementById("tab-bar"),
  main: document.getElementById("main-content"),
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
  if (Math.abs(rate) > 1) return "";
  const cls = rate >= 0 ? "delta-up" : "delta-down";
  const arrow = rate >= 0 ? "↑" : "↓";
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
function sellerSearchUrl(name) {
  // 小红书内部搜店暂无固定链接；回退到买家端搜索
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
    const r = await fetch(`data/${period}/${chartId}.json`);
    if (!r.ok) throw new Error("HTTP "+r.status);
    const d = await r.json();
    STATE.cache[key] = d;
    return d;
  } catch (e) { return null; }
}

// ============ init ============
async function init() {
  const r = await fetch("data/index.json");
  STATE.index = await r.json();
  EL.meta.textContent = `数据更新：${STATE.index.generated_at}`;
  renderPeriodButtons();
  renderTabBar();
  await renderActiveTab();
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
    EL.main.appendChild(buildHeroKpis(datas));
  }
  if (tab.key === "tab2_note") {
    const bd = datas.find(d => d && d.chart_id === "t2_note_breakdown");
    if (bd) EL.main.appendChild(renderKpiGridCard(bd));
  }
  if (tab.key === "tab4_kbroadcast") {
    const ov = datas.find(d => d && d.chart_id === "t4_k_overview");
    if (ov) EL.main.appendChild(renderKpiGridCard(ov));
  }

  tab.charts.forEach((cdef, i) => {
    const data = datas[i];
    if (!data) {
      EL.main.appendChild(emptyCard(cdef, "数据加载失败"));
      return;
    }
    if ((tab.key === "tab2_note" && cdef.id === "t2_note_breakdown") ||
        (tab.key === "tab4_kbroadcast" && cdef.id === "t4_k_overview")) {
      return;
    }
    EL.main.appendChild(renderChartCard(cdef, data));
  });
}

function emptyCard(cdef, msg) {
  const c = document.createElement("section");
  c.className = "chart-card";
  c.innerHTML = `<div class="chart-header"><div class="chart-title">${cdef.name}</div></div><div class="empty">${msg}</div>`;
  return c;
}

function renderChartCard(cdef, data) {
  const card = document.createElement("section");
  card.className = "chart-card";
  card.innerHTML = `
    <div class="chart-header">
      <div class="chart-title">${cdef.name}</div>
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

  // datas[0]: t1_yesterday_perf  -> 总 DGMV + 环比
  // datas[1]: t1_bimonth_byAM   -> AM 数 + Top1
  // datas[3]: t1_bimonth_top_seller -> 商家数

  const yperf = datas[0];
  let totalGmv = "-", deltaPct = null, scenes = "-";
  if (yperf && yperf.rows && yperf.rows.length) {
    const ci = findColIdxLoose(yperf.columns, "DGMV");
    const ri = findColIdx(yperf.columns, "DGMV _环比-变化率");
    const total = yperf.rows.find(r => r[0] === "总计");
    if (total) { totalGmv = fmt.money(total[ci]); deltaPct = total[ri]; }
    scenes = yperf.rows.filter(r => r[0] !== "总计").length;
  }

  const byAM = datas[1];
  let amCount = "-", topAM = "-", topAMValue = "";
  if (byAM && byAM.rows && byAM.rows.length) {
    const dimI = findColIdx(byAM.columns, "AM");
    const dgmvI = findColIdxLoose(byAM.columns, "DGMV");
    const rows = byAM.rows.filter(r => r[dimI] !== "总计");
    amCount = rows.length;
    if (rows.length) {
      const top = rows.slice().sort((a,b)=>(b[dgmvI]||0)-(a[dgmvI]||0))[0];
      topAM = top[dimI];
      topAMValue = fmt.money(top[dgmvI]);
    }
  }

  const sellerData = datas[3];
  let sellerCount = "-";
  if (sellerData && sellerData.rows) {
    sellerCount = sellerData.rows.filter(r => r[0] !== "总计" && (r[findColIdxLoose(sellerData.columns,"DGMV")]||0) > 0).length;
  }

  // 算"日均 DGMV" — 用周期天数
  const period = STATE.index.periods.find(p => p.key === STATE.currentPeriod);
  const days = (function(){
    if (!period) return 1;
    const s = new Date(period.start); const e = new Date(period.end);
    return Math.max(1, Math.round((e - s)/86400000)+1);
  })();

  // 环比仅在"昨日"展示（chart 自带环比口径只对单日有意义；其他时段切换后口径错乱）
  const showDelta = STATE.currentPeriod === "yesterday" && deltaPct != null && Math.abs(deltaPct) <= 1;
  const items = [
    {label: `${periodLabel} · 全组 DGMV`, value: totalGmv, delta: showDelta ? deltaPct : null, deltaLabel: "vs 前一日"},
    {label: "日均 DGMV", value: yperf && totalGmv !== "-" ? fmt.money((yperf.rows.find(r=>r[0]==="总计")[findColIdxLoose(yperf.columns,"DGMV")])/days) : "-", sub: `${days} 天`},
    {label: `Top AM`, value: topAM, sub: topAMValue},
    {label: "动销商家数", value: sellerCount === "-" ? "-" : sellerCount + " 家"},
    {label: "覆盖场域", value: scenes + " 个"},
  ];
  items.forEach(it => {
    const c = document.createElement("div");
    c.className = "kpi-card hero";
    let dh = "";
    if (it.delta != null && typeof it.delta === "number" && Math.abs(it.delta) <= 1) {
      const cls = it.delta >= 0 ? "delta-up" : "delta-down";
      const arrow = it.delta >= 0 ? "↑" : "↓";
      dh = `<div class="delta ${cls}">${arrow} ${(Math.abs(it.delta)*100).toFixed(1)}% ${it.deltaLabel||""}</div>`;
    }
    let sh = it.sub ? `<div class="sub">${it.sub}</div>` : "";
    c.innerHTML = `<div class="label">${it.label}</div><div class="value">${it.value}</div>${dh}${sh}`;
    wrap.appendChild(c);
  });
  return wrap;
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
    if (cfg.link_type === "seller") link = sellerSearchUrl(name);
    else if (cfg.link_type === "product") link = productSearchUrl(name);
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
// V4 业务卡片化：通用 cardGrid（适配 商家/商品/店播/K播）
// ============================================================
renderers.cardGrid = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const extra2I = cfg.extra_dim2 ? findColIdx(data.columns, cfg.extra_dim2) : -1;
  const valI = findColIdxLoose(data.columns, cfg.value);
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

    // 链接
    let mainHref = null;
    if (cfg.link_type === "seller" || cardType === "seller" || cardType === "live") {
      mainHref = sellerSearchUrl(mainName);
    } else if (cfg.link_type === "product" || cardType === "product") {
      mainHref = productSearchUrl(mainName);
    } else if (cardType === "kbroadcast") {
      mainHref = sellerSearchUrl(mainName); // 主播昵称也能搜
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
      // K 播大场: 主播(主) + AM 商家 + 日期
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">🎙 ${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">🎙 ${mainName}</span>`}
          <div class="card-sub">
            <span class="tag tag-am">归属 ${extra || "-"}</span>
            <span class="tag tag-date">📅 ${extra2 || "-"}</span>
          </div>
        </div>
        <div class="card-value">
          <div class="vbig">${fmt.money(val)}</div>
          <div class="vlabel">单场 DGMV</div>
        </div>`;
    } else if (cardType === "product") {
      // TOP 商品: 商品(主) + 商家 + AM
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">${mainName}</span>`}
          <div class="card-sub">
            <span class="tag tag-shop">🏪 ${extra || "-"}</span>
            ${extra2 ? `<span class="tag tag-am">👤 ${extra2}</span>` : ""}
          </div>
        </div>
        <div class="card-value">
          <div class="vbig">${fmt.money(val)}</div>
          <div class="vlabel">DGMV</div>
        </div>`;
    } else if (cardType === "seller") {
      // TOP 商家: 商家(主) + AM 归属
      bodyHtml = `
        <div class="card-rank">${idx+1}</div>
        <div class="card-body">
          ${mainHref ? `<a href="${mainHref}" target="_blank" rel="noopener" class="card-title">${mainName} <span class="ext-icon">↗</span></a>` : `<span class="card-title">${mainName}</span>`}
          ${extra ? `<div class="card-sub"><span class="tag tag-am">👤 ${extra}</span></div>` : ""}
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
      const link = sellerSearchUrl(seller);
      const rateHtml = rate != null && Math.abs(rate) <= 50 ? renderDelta(rate) : (rate != null ? `<span class="muted">×${rate>0?'+':''}${rate.toFixed(1)}</span>` : "");
      html += `
        <div class="biz-card change-card ${isUp?'up':'down'}">
          <div class="card-rank">${idx+1}</div>
          <div class="card-body">
            <a href="${link}" target="_blank" rel="noopener" class="card-title">${seller} <span class="ext-icon">↗</span></a>
            <div class="card-sub"><span class="tag tag-am">👤 ${am}</span></div>
          </div>
          <div class="card-value">
            <div class="vbig ${isUp?'up':'down'}">${isUp?'+':''}${fmt.money(delta)}</div>
            <div class="vlabel">${rateHtml || (isUp?'增量':'减量')}</div>
            <div class="vsmall">现期 ${fmt.money(val)}</div>
          </div>
        </div>`;
    });
    html += `</div>`;
    // 归因
    const attrib = attribAM(list);
    if (attrib && attrib.length) {
      html += `<div class="attrib-box ${isUp?'up':'down'}"><b>${isUp?'增量':'减量'}主要来自 AM：</b>`;
      html += attrib.map(([am, info]) => `<span class="attrib-tag">${am} <b>${info.count}</b>家 / ${info.delta>=0?'+':''}${fmt.money(info.delta)}</span>`).join(" ");
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
      visualDimension: 0,
      visualMin: data1[data1.length-1].value,
      visualMax: data1[0].value,
      levels: [{
        itemStyle: {
          borderColor: '#fff',
          borderWidth: 2,
          gapWidth: 2,
        },
        upperLabel: {show: false},
        colorMappingBy: 'value',
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
      // 量级渐变：深紫(大) → 浅紫(小)
      color: ['#4a148c', '#6a1b9a', '#7b1fa2', '#8e24aa', '#9c27b0', '#ab47bc', '#ba68c8', '#ce93d8', '#e1bee7', '#f3e5f5'],
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

  function makeCol(list, isUp, label, hint) {
    const col = document.createElement("div");
    col.className = "change-col";
    let html = `<h4 class="${isUp?'up':'down'}">${label} TOP ${list.length}</h4>${hint}<table class="data-table"><thead><tr><th>类目</th><th class="num">DGMV</th><th class="num">环比</th></tr></thead><tbody>`;
    list.forEach(r => {
      const rate = r[rateI];
      const rateHtml = Math.abs(rate) <= 5
        ? `<span class="${rate>=0?'delta-up':'delta-down'}">${rate>=0?'↑':'↓'} ${(Math.abs(rate)*100).toFixed(1)}%</span>`
        : `<span class="delta-abnormal">×${rate>0?'+':''}${rate.toFixed(0)}</span>`;
      html += `<tr><td>${r[dimI]}</td><td class="num">${fmt.money(r[valI])}</td><td class="num">${rateHtml}</td></tr>`;
    });
    html += "</tbody></table>";
    // 归因
    const top3 = list.slice(0,3).map(r=>r[dimI]).join(" / ");
    if (top3) {
      html += `<div class="attrib-box ${isUp?'up':'down'}"><b>主要类目：</b>${top3}</div>`;
    }
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
