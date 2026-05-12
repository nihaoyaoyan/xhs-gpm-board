/* 休食组业绩看板 V2 — 每个 chart 走专属渲染器 */
const STATE = {
  index: null,
  currentPeriod: "this_bimonth",
  currentTab: "tab1_team_overview",
  cache: {},
  echartInstances: [],
};
const EL = {
  meta: document.getElementById("generated-at"),
  periodButtons: document.getElementById("period-buttons"),
  periodInfo: document.getElementById("period-info"),
  tabBar: document.getElementById("tab-bar"),
  main: document.getElementById("main-content"),
};

// ============= utils =============
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
    if (v == null) return "-";
    if (typeof v !== "number") return v;
    return (v*100).toFixed(2)+"%";
  },
  pctSigned(v) {
    if (v == null) return "-";
    if (typeof v !== "number") return v;
    const s = v >= 0 ? "+" : "";
    return s + (v*100).toFixed(1)+"%";
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
    if (s.length <= n) return s;
    return s.slice(0, n-1) + "…";
  }
};
function colorByDelta(v) {
  if (v == null || isNaN(v)) return "#999";
  return v >= 0 ? "#d63031" : "#2c8a47";
}
function arrowByDelta(v) {
  if (v == null || isNaN(v)) return "";
  return v >= 0 ? "▲" : "▼";
}
function findColIdx(cols, name) {
  for (let i=0; i<cols.length; i++) if (cols[i] === name) return i;
  return -1;
}
function findColIdxLoose(cols, name) {
  const target = name.trim();
  for (let i=0; i<cols.length; i++) if (cols[i].trim() === target) return i;
  return -1;
}
function disposeAllCharts() {
  STATE.echartInstances.forEach(c => { try{c.dispose();}catch(e){} });
  STATE.echartInstances = [];
}

const COLOR_PALETTE = [
  "#ff5f6d", "#ffc371", "#6c63ff", "#11998e", "#ee0979",
  "#fc6076", "#a8e063", "#56ccf2", "#f7971e", "#bb377d"
];

// ============= fetch =============
async function fetchData(period, chartId) {
  const key = `${period}/${chartId}`;
  if (STATE.cache[key]) return STATE.cache[key];
  try {
    const r = await fetch(`data/${period}/${chartId}.json`);
    if (!r.ok) throw new Error("HTTP "+r.status);
    const d = await r.json();
    STATE.cache[key] = d;
    return d;
  } catch (e) {
    return null;
  }
}

// ============= init =============
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

// ============= main render =============
async function renderActiveTab() {
  disposeAllCharts();
  EL.main.innerHTML = `<div class="loading">加载中…</div>`;
  const tab = STATE.index.tabs.find(t => t.key === STATE.currentTab);
  if (!tab) return;

  const datas = await Promise.all(tab.charts.map(c => fetchData(STATE.currentPeriod, c.id)));

  EL.main.innerHTML = "";

  // Tab1 顶部 KPI
  if (tab.key === "tab1_team_overview" && datas[0]) {
    EL.main.appendChild(buildHeroKpis(datas));
  }
  // Tab2 顶部用 t2_note_breakdown 做 KPI
  if (tab.key === "tab2_note") {
    const bd = datas.find(d => d && d.chart_id === "t2_note_breakdown");
    if (bd) EL.main.appendChild(renderKpiGrid(bd));
  }
  // Tab4 顶部用 t4_k_overview
  if (tab.key === "tab4_kbroadcast") {
    const ov = datas.find(d => d && d.chart_id === "t4_k_overview");
    if (ov) EL.main.appendChild(renderKpiGrid(ov));
  }

  // 渲染剩余 chart cards
  tab.charts.forEach((cdef, i) => {
    const data = datas[i];
    if (!data) {
      EL.main.appendChild(makeEmptyCard(cdef, "数据加载失败"));
      return;
    }
    // 已经在顶部 KPI 渲染过的跳过
    if ((tab.key === "tab2_note" && cdef.id === "t2_note_breakdown") ||
        (tab.key === "tab4_kbroadcast" && cdef.id === "t4_k_overview")) {
      return;
    }
    EL.main.appendChild(renderChartCard(cdef, data));
  });
}

function makeEmptyCard(cdef, msg) {
  const card = document.createElement("section");
  card.className = "chart-card";
  card.innerHTML = `<div class="chart-header"><div class="chart-title">${cdef.name}</div></div><div class="empty">${msg}</div>`;
  return card;
}

// 通用 chart-card 容器
function renderChartCard(cdef, data) {
  const card = document.createElement("section");
  card.className = "chart-card";
  const header = document.createElement("div");
  header.className = "chart-header";
  header.innerHTML = `
    <div class="chart-title">${cdef.name}</div>
    <div class="chart-meta">
      <a href="${cdef.source_url}" target="_blank" rel="noopener" title="${data.chart_name||''}">🔗 BI 原图</a>
      <span>共 ${data.total_rows} 行</span>
    </div>
  `;
  card.appendChild(header);
  const body = document.createElement("div");
  body.className = "chart-body";
  card.appendChild(body);

  const cfg = data.config || {};
  const render = data.render || cdef.render;
  try {
    if (!data.rows || !data.rows.length) {
      body.innerHTML = `<div class="empty">该时段无数据</div>`;
    } else if (render === "donut_table") renderers.donutTable(body, data, cfg);
    else if (render === "bar_h_byAM") renderers.barHByAM(body, data, cfg);
    else if (render === "bar_h_byAM_multi") renderers.barHByAMMulti(body, data, cfg);
    else if (render === "line_trend") renderers.lineTrend(body, data, cfg);
    else if (render === "bar_h_top") renderers.barHTop(body, data, cfg);
    else if (render === "bar_h_with_yoy") renderers.barHWithYoy(body, data, cfg);
    else if (render === "kpi_grid") body.appendChild(renderKpiGrid(data).querySelector(".kpi-grid"));
    else if (render === "treemap") renderers.treemap(body, data, cfg);
    else if (render === "two_lists_change") renderers.twoListsChange(body, data, cfg);
    else if (render === "table_grouped_by_am") renderers.tableGroupedByAM(body, data, cfg);
    else renderers.fallbackTable(body, data, cfg);
  } catch (e) {
    console.error("render fail", cdef.id, e);
    body.innerHTML = `<div class="empty">渲染失败: ${e.message}</div>`;
  }

  // 筛选条件
  if (data.filters && data.filters.length) {
    const f = document.createElement("div");
    f.className = "filters";
    f.textContent = "口径：" + data.filters.join("；");
    card.appendChild(f);
  }
  return card;
}

// ============= 顶部 hero kpi (Tab1) =============
function buildHeroKpis(datas) {
  // 用 t1_yesterday_perf 总计 + t1_bimonth_byAM 大门行
  const wrap = document.createElement("div");
  wrap.className = "hero-kpis";

  const periodLabel = STATE.index.periods.find(p => p.key === STATE.currentPeriod).label;

  const yperf = datas[0]; // t1_yesterday_perf
  const byAM = datas[1];  // t1_bimonth_byAM
  const trend = datas[2]; // t1_14d_trend

  let totalGmv = "-", deltaPct = null, scenes = "-";
  if (yperf && yperf.rows && yperf.rows.length) {
    const ci = findColIdxLoose(yperf.columns, "DGMV");
    const ri = findColIdx(yperf.columns, "DGMV _环比-变化率");
    const total = yperf.rows.find(r => r[0] === "总计");
    if (total) {
      totalGmv = fmt.money(total[ci]);
      deltaPct = total[ri];
    }
    scenes = yperf.rows.length - 1;
  }

  let dagateGmv = "-", dagateRank = "-";
  if (byAM && byAM.rows && byAM.rows.length) {
    const dimI = findColIdx(byAM.columns, "AM");
    const dgmvI = findColIdxLoose(byAM.columns, "DGMV");
    const rows = byAM.rows.filter(r => r[dimI] !== "总计").sort((a,b)=>(b[dgmvI]||0)-(a[dgmvI]||0));
    const idx = rows.findIndex(r => r[dimI] === "大门(朱锦程)");
    if (idx >= 0) {
      dagateGmv = fmt.money(rows[idx][dgmvI]);
      dagateRank = `第 ${idx+1} / ${rows.length}`;
    }
  }

  let trendCount = trend && trend.rows ? trend.rows.length : 0;

  const items = [
    {label: `${periodLabel} · 全组 DGMV`, value: totalGmv, delta: deltaPct, deltaLabel: "vs 上期"},
    {label: "大门(朱锦程) 业绩", value: dagateGmv, sub: `AM 排名 ${dagateRank}`},
    {label: "覆盖场域", value: scenes + " 个"},
    {label: "时间窗口天数", value: trendCount + " 天"},
  ];
  items.forEach(it => {
    const c = document.createElement("div");
    c.className = "kpi-card hero";
    let dh = "";
    if (it.delta != null && typeof it.delta === "number") {
      dh = `<div class="delta" style="color:${colorByDelta(it.delta)}">${arrowByDelta(it.delta)} ${fmt.pctSigned(Math.abs(it.delta))} ${it.deltaLabel||""}</div>`;
    }
    let sh = "";
    if (it.sub) sh = `<div class="sub">${it.sub}</div>`;
    c.innerHTML = `<div class="label">${it.label}</div><div class="value">${it.value}</div>${dh}${sh}`;
    wrap.appendChild(c);
  });
  return wrap;
}

// ============= renderers =============
const renderers = {};

renderers.donutTable = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = findColIdx(data.columns, cfg.rate);
  let rows = data.rows;
  if (cfg.exclude_total) rows = rows.filter(r => r[dimI] !== "总计");
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
  let html = `<table class="data-table"><thead><tr><th>${cfg.dim}</th><th class="num">${cfg.value.trim()}</th><th class="num">占比</th><th class="num">环比</th></tr></thead><tbody>`;
  rows.forEach(r => {
    const v = r[valI];
    const rate = rateI>=0 ? r[rateI] : null;
    const pct = total > 0 ? (v/total*100).toFixed(1)+"%" : "-";
    const rateHtml = rate==null ? "-" : `<span style="color:${colorByDelta(rate)}">${arrowByDelta(rate)} ${fmt.pctSigned(Math.abs(rate))}</span>`;
    html += `<tr><td>${r[dimI]}</td><td class="num">${fmt.money(v)}</td><td class="num">${pct}</td><td class="num">${rateHtml}</td></tr>`;
  });
  html += "</tbody></table>";
  tbl.innerHTML = html;
  grid.appendChild(tbl);
  body.appendChild(grid);

  setTimeout(()=>{
    const c = echarts.init(chartBox);
    STATE.echartInstances.push(c);
    c.setOption({
      tooltip: {trigger: "item", formatter: p => `${p.name}<br><b>${fmt.money(p.value)}</b> (${p.percent}%)`},
      legend: {orient:"horizontal", bottom: 0, type: "scroll"},
      series: [{
        type: "pie",
        radius: ["40%","70%"],
        center: ["50%","45%"],
        avoidLabelOverlap: true,
        itemStyle: {borderRadius: 6, borderColor:"#fff", borderWidth: 2},
        label: {show: true, formatter: "{b}\n{d}%", fontSize: 11},
        labelLine: {show: true, length: 8, length2: 8},
        data: rows.map((r,i)=>({name: r[dimI], value: r[valI], itemStyle:{color: COLOR_PALETTE[i%COLOR_PALETTE.length]}}))
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

renderers.barHByAM = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  let rows = data.rows.filter(r => r[dimI] !== "总计");
  // values: 多个指标
  const vals = (cfg.values||[]).map(([col,name]) => ({col, name, idx: findColIdxLoose(data.columns, col)}));
  // 按第一个指标排序
  if (vals[0]) rows = rows.sort((a,b)=>(b[vals[0].idx]||0)-(a[vals[0].idx]||0));
  const dims = rows.map(r => r[dimI]);

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = (Math.max(rows.length*45, 200)) + "px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echartInstances.push(c);
    c.setOption({
      tooltip: {trigger: "axis", axisPointer:{type:"shadow"}, formatter: params => {
        return params[0].name + "<br>" + params.map(p=>`${p.marker}${p.seriesName}: <b>${fmt.money(p.value)}</b>`).join("<br>");
      }},
      legend: {top: 0},
      grid: {left: 100, right: 80, top: 30, bottom: 20, containLabel: true},
      xAxis: {type: "value", axisLabel: {formatter: v => fmt.money(v)}},
      yAxis: {type: "category", data: dims, inverse: true, axisLabel: {
        fontWeight: (function(){return function(v){return v===cfg.highlight?"700":"normal"}})(),
        color: function(v){ return v===cfg.highlight?"#ff5f6d":"#444"; },
      }},
      series: vals.map((v,i)=>({
        name: v.name, type:"bar",
        data: rows.map(r => r[v.idx]),
        itemStyle: {color: COLOR_PALETTE[i]},
        label: {show: true, position: "right", formatter: p => fmt.money(p.value), fontSize: 11},
      }))
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

renderers.barHByAMMulti = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  let rows = data.rows;
  if (cfg.exclude_total) rows = rows.filter(r => r[dimI] !== "总计");
  // 取每个指标的列
  const metrics = cfg.metrics.map(([col, name, fmtType]) => ({col, name, fmtType, idx: findColIdxLoose(data.columns, col)}));
  const dims = rows.map(r => r[dimI]);

  // 三个指标一行 → 三张并排 mini bar
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
      STATE.echartInstances.push(c);
      const fmtFn = m.fmtType === "money" ? fmt.money : (m.fmtType === "int_w" ? fmt.int_w : fmt.int);
      c.setOption({
        tooltip: {trigger:"axis", formatter: p => `${p[0].name}<br><b>${fmtFn(p[0].value)}</b>`},
        grid: {left: 80, right: 60, top: 10, bottom: 10, containLabel: true},
        xAxis: {type: "value", axisLabel: {formatter: fmtFn, fontSize: 10}},
        yAxis: {type: "category", data: sorted.map(r=>r[dimI]), inverse: true, axisLabel: {
          color: function(v){ return v===cfg.highlight?"#ff5f6d":"#444"; },
          fontWeight: function(v){ return v===cfg.highlight?"700":"normal";},
          fontSize: 11,
        }},
        series: [{
          type: "bar",
          data: sorted.map(r => r[m.idx]),
          itemStyle: {color: function(p){return sorted[p.dataIndex][dimI]===cfg.highlight?"#ff5f6d":COLOR_PALETTE[mi+1]}},
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
  // 按日期排序
  rows = rows.sort((a,b)=> String(a[dimI]).localeCompare(String(b[dimI])));
  const dims = rows.map(r => r[dimI]);
  const vals = rows.map(r => r[valI]);

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = "320px";
  body.appendChild(box);

  if (rows.length <= 1) {
    body.innerHTML = `<div class="empty">该时段仅 ${rows.length} 个数据点，趋势图不适用</div>`;
    return;
  }

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echartInstances.push(c);
    c.setOption({
      tooltip: {trigger:"axis", formatter: p => `${p[0].name}<br><b>${fmt.money(p[0].value)}</b>`},
      grid: {left: 60, right: 30, top: 30, bottom: 50, containLabel: true},
      xAxis: {type: "category", data: dims, axisLabel: {rotate: dims.length>10?30:0, fontSize: 11}},
      yAxis: {type: "value", axisLabel: {formatter: v => fmt.money(v)}},
      series: [{
        type: "line", smooth: true, symbol: "circle", symbolSize: 8,
        data: vals,
        itemStyle: {color: "#ff5f6d"},
        lineStyle: {color: "#ff5f6d", width: 3},
        areaStyle: {color: {type:"linear", x:0,y:0,x2:0,y2:1, colorStops:[{offset:0,color:"rgba(255,95,109,0.35)"},{offset:1,color:"rgba(255,95,109,0.02)"}]}},
        markPoint: {data: [{type:"max",name:"最高"},{type:"min",name:"最低"}], label:{formatter: p => fmt.money(p.value)}},
        label: {show: dims.length<=14, position: "top", formatter: p => fmt.money(p.value), fontSize: 10},
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

renderers.barHTop = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const extra2I = cfg.extra_dim2 ? findColIdx(data.columns, cfg.extra_dim2) : -1;
  const hlI = cfg.highlight_col ? findColIdx(data.columns, cfg.highlight_col) : -1;

  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 20);

  const dims = top.map((r,idx) => {
    let label = String(r[dimI]||"");
    if (cfg.name_max) label = fmt.ellipsize(label, cfg.name_max);
    return `${idx+1}. ${label}`;
  });

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = (Math.max(top.length*30, 220))+"px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echartInstances.push(c);
    c.setOption({
      tooltip: {trigger:"axis", axisPointer:{type:"shadow"}, formatter: params => {
        const p = params[0];
        const r = top[p.dataIndex];
        let html = `<b>${r[dimI]}</b><br>`;
        if (extraI >= 0) html += `${cfg.extra_dim}: ${r[extraI]||"-"}<br>`;
        if (extra2I >= 0) html += `${cfg.extra_dim2}: ${r[extra2I]||"-"}<br>`;
        html += `${cfg.value.trim()}: <b>${fmt.money(r[valI])}</b>`;
        if (rateI>=0 && r[rateI]!=null) html += `<br>环比: <span style="color:${colorByDelta(r[rateI])}">${arrowByDelta(r[rateI])} ${fmt.pctSigned(r[rateI])}</span>`;
        return html;
      }},
      grid: {left: 200, right: 90, top: 10, bottom: 20, containLabel: true},
      xAxis: {type: "value", axisLabel: {formatter: v => fmt.money(v)}},
      yAxis: {type: "category", data: dims, inverse: true, axisLabel: {fontSize: 11}},
      series: [{
        type: "bar",
        data: top.map((r,idx) => ({
          value: r[valI],
          itemStyle: {color: (hlI>=0 && r[hlI]===cfg.highlight_val) ? "#ff5f6d" : COLOR_PALETTE[idx%4+1]}
        })),
        label: {show: true, position: "right", formatter: p => fmt.money(p.value), fontSize: 11},
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);

  // 折叠完整表格
  const fold = document.createElement("details");
  fold.className = "fold";
  fold.innerHTML = `<summary>查看完整表格（共 ${rows.length} 行）</summary>`;
  const fullCols = [cfg.dim];
  const colIdxs = [dimI];
  if (extraI>=0) { fullCols.push(cfg.extra_dim); colIdxs.push(extraI); }
  if (extra2I>=0) { fullCols.push(cfg.extra_dim2); colIdxs.push(extra2I); }
  fullCols.push(cfg.value.trim()); colIdxs.push(valI);
  if (rateI>=0) { fullCols.push("环比"); colIdxs.push(rateI); }

  let html = `<div class="table-wrap"><table class="data-table"><thead><tr>${fullCols.map(c=>`<th>${c}</th>`).join("")}</tr></thead><tbody>`;
  rows.slice(0, 200).forEach(r => {
    html += "<tr>" + colIdxs.map((ci, i) => {
      const v = r[ci];
      if (i === colIdxs.length-1 && rateI>=0 && cfg.rate && fullCols[i]==="环比") {
        return `<td class="num" style="color:${colorByDelta(v)}">${arrowByDelta(v)} ${v==null?"-":fmt.pctSigned(v)}</td>`;
      }
      if (typeof v === "number") return `<td class="num">${fmt.money(v)}</td>`;
      return `<td>${v==null?"-":v}</td>`;
    }).join("") + "</tr>";
  });
  html += "</tbody></table></div>";
  if (rows.length > 200) html += `<div class="table-info">仅显示前 200 行</div>`;
  fold.insertAdjacentHTML("beforeend", html);
  body.appendChild(fold);
};

renderers.barHWithYoy = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;

  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0);
  rows = rows.sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 15);

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = (Math.max(top.length*36, 240))+"px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echartInstances.push(c);
    c.setOption({
      tooltip: {trigger:"axis", formatter: params => {
        const idx = params[0].dataIndex;
        const r = top[idx];
        let html = `<b>${r[dimI]}</b><br>${cfg.value.trim()}: <b>${fmt.money(r[valI])}</b>`;
        if (rateI>=0 && r[rateI]!=null) html += `<br>同比: <span style="color:${colorByDelta(r[rateI])}">${arrowByDelta(r[rateI])} ${fmt.pctSigned(r[rateI])}</span>`;
        return html;
      }},
      grid: {left: 140, right: 100, top: 10, bottom: 20, containLabel: true},
      xAxis: {type: "value", axisLabel: {formatter: v => fmt.money(v)}},
      yAxis: {type: "category", data: top.map(r=>r[dimI]), inverse: true, axisLabel: {fontSize: 11}},
      series: [{
        type: "bar",
        data: top.map((r,i) => ({value: r[valI], itemStyle: {color: COLOR_PALETTE[i%COLOR_PALETTE.length]}})),
        label: {
          show: true, position: "right",
          formatter: function(p) {
            const r = top[p.dataIndex];
            const yoy = rateI>=0 ? r[rateI] : null;
            const yoyStr = (yoy!=null && typeof yoy === "number") ? `  ${arrowByDelta(yoy)}${fmt.pctSigned(Math.abs(yoy))}` : "";
            return `${fmt.money(p.value)}${yoyStr}`;
          },
          fontSize: 11,
          rich: {},
        },
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

function renderKpiGrid(data) {
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
    let dh = "";
    if (delta != null && typeof delta === "number") {
      dh = `<div class="delta" style="color:${colorByDelta(delta)}">${arrowByDelta(delta)} ${fmt.pctSigned(Math.abs(delta))}</div>`;
    }
    const card = document.createElement("div");
    card.className = "kpi-card";
    card.innerHTML = `<div class="label">${g.label}</div><div class="value">${valStr}</div>${dh}`;
    grid.appendChild(card);
  });
  wrap.appendChild(grid);
  return wrap;
}

renderers.treemap = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const valI = findColIdxLoose(data.columns, cfg.value);
  let rows = data.rows;
  if (cfg.exclude_total) rows = rows.filter(r => r[dimI] !== "总计");
  rows = rows.filter(r => (r[valI]||0) > 0).sort((a,b)=>(b[valI]||0)-(a[valI]||0));
  const top = rows.slice(0, cfg.top || 25);
  const others = rows.slice(cfg.top || 25);
  const others_sum = others.reduce((s,r)=>s+(r[valI]||0),0);
  const treeData = top.map((r,i)=>({
    name: r[dimI], value: r[valI],
    itemStyle: {color: COLOR_PALETTE[i%COLOR_PALETTE.length]}
  }));
  if (others_sum > 0) treeData.push({name: `其他 ${others.length} 个`, value: others_sum, itemStyle: {color: "#ccc"}});

  const box = document.createElement("div");
  box.className = "echarts-box";
  box.style.height = "440px";
  body.appendChild(box);

  setTimeout(()=>{
    const c = echarts.init(box);
    STATE.echartInstances.push(c);
    const total = treeData.reduce((s,t)=>s+t.value,0);
    c.setOption({
      tooltip: {formatter: p => `${p.name}<br><b>${fmt.money(p.value)}</b><br>占比: ${(p.value/total*100).toFixed(1)}%`},
      series: [{
        type: "treemap", roam: false,
        breadcrumb: {show: false},
        data: treeData,
        label: {show: true, formatter: p => `${p.name}\n${fmt.money(p.value)}`, fontSize: 12},
      }]
    });
    window.addEventListener("resize", ()=>c.resize());
  },0);
};

renderers.twoListsChange = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const extraI = cfg.extra_dim ? findColIdx(data.columns, cfg.extra_dim) : -1;
  const valI = findColIdxLoose(data.columns, cfg.value);
  const deltaI = cfg.delta_col ? findColIdx(data.columns, cfg.delta_col) : -1;
  const rateI = cfg.rate ? findColIdx(data.columns, cfg.rate) : -1;
  // 过滤
  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计" && (r[valI]||0) > 0 && deltaI>=0 && r[deltaI]!=null);
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
      html += `<tr><td>${r[dimI]}</td><td>${extraI>=0?(r[extraI]||"-"):"-"}</td><td class="num">${fmt.money(r[valI])}</td><td class="num" style="color:${colorByDelta(delta)}">${arrowByDelta(delta)} ${fmt.money(Math.abs(delta))} ${rate!=null?`(${fmt.pctSigned(rate)})`:""}</td></tr>`;
    });
    html += "</tbody></table>";
    col.innerHTML = html;
    return col;
  }
  grid.appendChild(makeList("突增", ups, true));
  grid.appendChild(makeList("突降", downs, false));
  body.appendChild(grid);
};

renderers.tableGroupedByAM = function(body, data, cfg) {
  const dimI = findColIdx(data.columns, cfg.dim);
  const amI = findColIdx(data.columns, cfg.am_col);
  let rows = data.rows.filter(r => r[dimI] && r[dimI] !== "总计");
  // 按 AM 分组计数
  const byAM = {};
  rows.forEach(r => {
    const am = r[amI] || "未知";
    byAM[am] = (byAM[am]||0)+1;
  });
  const ams = Object.keys(byAM).sort((a,b)=>byAM[b]-byAM[a]);

  // KPI bar：每个 AM 一卡
  const kpiRow = document.createElement("div");
  kpiRow.className = "kpi-grid";
  ams.forEach(am => {
    const c = document.createElement("div");
    c.className = "kpi-card";
    if (am === cfg.highlight) c.classList.add("highlighted");
    c.innerHTML = `<div class="label">${am}</div><div class="value">${byAM[am]}</div><div class="sub">家</div>`;
    kpiRow.appendChild(c);
  });
  body.appendChild(kpiRow);

  // 完整列表（折叠）
  const fold = document.createElement("details");
  fold.className = "fold";
  fold.innerHTML = `<summary>查看完整商家列表（${rows.length} 家）</summary><div class="table-wrap"><table class="data-table"><thead><tr><th>商家</th><th>AM</th></tr></thead><tbody>${
    rows.slice(0, 500).map(r => `<tr><td>${r[dimI]}</td><td>${r[amI]||"-"}</td></tr>`).join("")
  }</tbody></table></div>${rows.length>500?`<div class="table-info">仅显示前 500 家</div>`:""}`;
  body.appendChild(fold);
};

renderers.fallbackTable = function(body, data, cfg) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  let html = `<table class="data-table"><thead><tr>${data.columns.map(c=>`<th>${c}</th>`).join("")}</tr></thead><tbody>`;
  data.rows.slice(0, 100).forEach(r => {
    html += "<tr>"+r.map(v => {
      if (typeof v === "number") return `<td class="num">${fmt.money(v)}</td>`;
      return `<td>${v==null?"-":v}</td>`;
    }).join("")+"</tr>";
  });
  html += "</tbody></table>";
  wrap.innerHTML = html;
  body.appendChild(wrap);
};

init();
