// 大门业绩看板 V2 — 7 Tab，全部基于 NL 取数（dataset 1922 / 5574 / 39664）
(function () {
  const M = window.MOCK;
  const COLORS = {
    kbo:  '#ff5577',
    dbo:  '#58a6ff',
    note: '#d2a8ff',
    cart: '#fb950b',
    other:'#6e7681',
    primary: '#ff2442',
    text: '#e6edf3',
    dim:  '#8b949e',
    grid: '#2d333b',
    success: '#2ea043',
    warning: '#d29922',
    danger: '#f85149',
  };
  const fieldColor = (name) => {
    if (name.includes('K播')) return COLORS.kbo;
    if (name.includes('店播')) return COLORS.dbo;
    if (name.includes('笔记')) return COLORS.note;
    if (name.includes('商卡')) return COLORS.cart;
    return COLORS.other;
  };

  // 工具
  const fmtNum = (n) => {
    if (n == null || isNaN(n)) return '-';
    const sign = n < 0 ? '-' : '';
    n = Math.abs(n);
    if (n >= 1e8) return sign + (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return sign + (n / 1e4).toFixed(1) + ' 万';
    if (n >= 1)   return sign + n.toLocaleString('en-US', {maximumFractionDigits: 0});
    return sign + n.toFixed(2);
  };
  const fmtPct = (v, withSign = true) => {
    if (v == null || isNaN(v)) return '-';
    const sign = withSign && v > 0 ? '+' : '';
    return `${sign}${(v * 100).toFixed(1)}%`;
  };
  const chipClass = (v) => v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const chipArrow = (v) => v == null ? '—' : v > 0 ? '↑' : v < 0 ? '↓' : '—';
  const rankBadge = (r) => {
    const cls = r === 1 ? 'top1' : r === 2 ? 'top2' : r === 3 ? 'top3' : '';
    return `<span class="rank-badge ${cls}">${r}</span>`;
  };
  const ellipsis = (s, max) => !s ? '' : s.length > max ? s.substring(0, max) + '...' : s;

  // ECharts 通用 theme
  const baseOpt = () => ({
    backgroundColor: 'transparent',
    textStyle: { color: COLORS.text, fontFamily: 'inherit' },
    grid: { left: 8, right: 16, top: 32, bottom: 28, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(28, 35, 45, 0.96)',
      borderColor: COLORS.grid,
      textStyle: { color: COLORS.text, fontSize: 12 },
      axisPointer: { lineStyle: { color: COLORS.grid } },
    },
    xAxis: {
      type: 'category',
      axisLine: { lineStyle: { color: COLORS.grid } },
      axisLabel: { color: COLORS.dim, fontSize: 11 },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisLabel: { color: COLORS.dim, fontSize: 11, formatter: (v) => fmtNum(v) },
      splitLine: { lineStyle: { color: COLORS.grid, type: 'dashed' } },
    },
  });

  const charts = []; // 收集所有 chart 实例方便统一 resize

  // ============ Tab 1: 昨日业绩 ============
  function renderTab1() {
    const t = M.tab1_yesterday;
    const root = document.getElementById('tab1');
    // 主力 4 场域 KPI
    const getF = (name) => {
      const r = t.breakdown.find(b => b.field === name);
      return r ? r.gmv : 0;
    };
    const kbo = getF('K播'), dbo = getF('店播'), note = getF('商品笔记'), cart = getF('普通商卡');

    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card primary">
          <div class="kpi-label">📅 昨日总 DGMV <span class="card-sub">${t.date}</span></div>
          <div class="kpi-value">${fmtNum(t.total)}<span class="unit">元</span></div>
          <div class="kpi-foot text-dim">9 个场域合计</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span class="dot kbo"></span>K播 DGMV</div>
          <div class="kpi-value">${fmtNum(kbo)}<span class="unit">元</span></div>
          <div class="kpi-foot text-dim">占比 ${fmtPct(kbo / t.total, false)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span class="dot dbo"></span>店播 DGMV</div>
          <div class="kpi-value">${fmtNum(dbo)}<span class="unit">元</span></div>
          <div class="kpi-foot text-dim">占比 ${fmtPct(dbo / t.total, false)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span class="dot note"></span>商品笔记 DGMV</div>
          <div class="kpi-value">${fmtNum(note)}<span class="unit">元</span></div>
          <div class="kpi-foot text-dim">占比 ${fmtPct(note / t.total, false)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span class="dot" style="background:${COLORS.cart}"></span>普通商卡 DGMV</div>
          <div class="kpi-value">${fmtNum(cart)}<span class="unit">元</span></div>
          <div class="kpi-foot text-dim">占比 ${fmtPct(cart / t.total, false)}</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div class="card-title">📊 昨日 9 场域 DGMV 分布</div></div>
          <div id="t1-pie" class="chart"></div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">🏆 昨日 Top10 商家</div></div>
          ${renderSimpleRankTable(t.topSellers, 'name', 'gmv')}
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div class="card-title">🛍️ 昨日 Top10 商品</div></div>
          ${renderSpuTable(t.topSpus)}
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">📝 昨日 Top10 笔记 <span class="card-sub">点击跳转</span></div></div>
          ${renderNoteTable(t.topNotes)}
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div class="card-title">💎 昨日 Top10 买手 × 商品 × 商家 <span class="card-sub">仅 K播</span></div></div>
          ${renderComboTable(t.topCombos)}
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">📺 昨日 Top10 店播 <span class="card-sub">按商家</span></div></div>
          ${renderDboTable(t.topDbo)}
        </div>
      </div>
    `;

    const c1 = echarts.init(document.getElementById('t1-pie'));
    c1.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(28,35,45,0.96)', borderColor: COLORS.grid,
        textStyle: { color: COLORS.text },
      },
      legend: { bottom: 0, textStyle: { color: COLORS.dim, fontSize: 11 }, itemWidth: 10, itemHeight: 10 },
      series: [{
        type: 'pie', radius: ['42%', '68%'], center: ['50%', '42%'],
        label: { show: true, color: COLORS.text, fontSize: 11, formatter: '{b}\n{d}%' },
        labelLine: { lineStyle: { color: COLORS.dim } },
        itemStyle: { borderColor: '#1c232d', borderWidth: 2 },
        data: t.breakdown.map(r => ({
          name: r.field, value: r.gmv,
          itemStyle: { color: fieldColor(r.field) },
        })),
      }],
    });
    charts.push(c1);
  }

  function renderSimpleRankTable(rows, nameKey, valueKey, labelName='商家') {
    if (!rows || rows.length === 0) return '<div class="empty">暂无数据</div>';
    return `<table class="table">
      <thead><tr><th width="40">#</th><th>${labelName}</th><th class="num">DGMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td>${r[nameKey]}</td>
            <td class="num">${fmtNum(r[valueKey])}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function renderSpuTable(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无数据</div>';
    return `<table class="table">
      <thead><tr><th width="40">#</th><th>商品</th><th class="num">DGMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td><div title="${(r.name||'').replace(/"/g,'&quot;')}" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.name}</div></td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function renderNoteTable(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无数据</div>';
    return `<table class="table">
      <thead><tr><th width="40">#</th><th>笔记 / 作者</th><th class="num">DGMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => {
          const url = r.url || (r.noteId ? `https://www.xiaohongshu.com/explore/${r.noteId}` : '');
          const titleHtml = url
            ? `<a href="${url}" target="_blank" rel="noopener" class="note-link" title="${(r.title||'').replace(/"/g,'&quot;')}">${r.title || '(无标题)'} <span class="link-arrow">↗</span></a>`
            : `<span title="${(r.title||'').replace(/"/g,'&quot;')}">${r.title || '(无标题)'}</span>`;
          return `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td>
              <div style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${titleHtml}</div>
              <div class="text-dim" style="font-size:11px">@${r.author}</div>
            </td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  function renderDboTable(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无数据</div>';
    return `<table class="table">
      <thead><tr><th width="40">#</th><th>商家</th><th class="num">店播 DGMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td>${r.seller}</td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function renderComboTable(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无数据</div>';
    return `<table class="table">
      <thead><tr><th width="40">#</th><th>买手</th><th>商家</th><th>商品</th><th class="num">DGMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td>${r.buyer === '—' ? '<span class="text-dim">—</span>' : '<b>'+r.buyer+'</b>'}</td>
            <td>${r.seller}</td>
            <td><div title="${(r.spu||'').replace(/"/g,'&quot;')}" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.spu}</div></td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // ============ Tab 2: 趋势 & 异动 ============
  function renderTab2() {
    const t = M.tab2_trend;
    const root = document.getElementById('tab2');
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">📈 近 14 天 DGMV 日趋势 <span class="card-sub">${t.dates[0]} ~ ${t.dates[t.dates.length-1]} · 按场域堆叠</span></div>
        </div>
        <div id="t2-trend" class="chart tall"></div>
      </div>

      <div class="grid-3">
        <div class="card">
          <div class="card-head">
            <div class="card-title">🚀 突增 Top10 <span class="card-sub">环比变化值 ↑</span></div>
          </div>
          ${renderChainTable(t.sellerSurge, 'up')}
        </div>
        <div class="card">
          <div class="card-head">
            <div class="card-title">✨ 新动销 Top10 <span class="card-sub">2026 入驻 + 本月有 GMV</span></div>
          </div>
          ${renderNewSeller2026Table(t.sellerNew)}
        </div>
        <div class="card">
          <div class="card-head">
            <div class="card-title">📉 突降 Top10 <span class="card-sub">环比变化值 ↓</span></div>
          </div>
          ${renderChainTable(t.sellerDrop, 'down')}
        </div>
      </div>
    `;

    const c1 = echarts.init(document.getElementById('t2-trend'));
    const opt = baseOpt();
    const seriesData = [...t.mainFields, '其他'].map(field => ({
      name: field,
      type: 'bar',
      stack: 'total',
      itemStyle: { color: fieldColor(field) },
      data: t.byField[field] || [],
    }));
    // 给最上面一条加 borderRadius
    if (seriesData.length > 0) {
      seriesData[seriesData.length - 1].itemStyle.borderRadius = [4, 4, 0, 0];
    }
    c1.setOption({
      ...opt,
      legend: { data: [...t.mainFields, '其他'], textStyle: { color: COLORS.dim }, top: 0, right: 8 },
      tooltip: {
        ...opt.tooltip,
        formatter: (params) => {
          const date = params[0].axisValue;
          let html = `<b>${date}</b><br/>`;
          let tot = 0;
          params.forEach(p => {
            html += `<span style="color:${p.color}">●</span> ${p.seriesName}: ${fmtNum(p.value)}<br/>`;
            tot += p.value;
          });
          html += `<b>总计: ${fmtNum(tot)} 元</b>`;
          return html;
        },
      },
      grid: { ...opt.grid, top: 40 },
      xAxis: { ...opt.xAxis, data: t.dates.map(d => d.substring(5)) },
      series: seriesData,
    });
    charts.push(c1);
  }

  function renderChainTable(rows, direction) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无</div>';
    return `<table class="table compact">
      <thead><tr><th width="32">#</th><th>商家</th><th class="num">近7天</th><th class="num">变化</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td><div style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${r.name}</div></td>
            <td class="num">${fmtNum(r.gmv)}</td>
            <td class="num">
              <div style="line-height:1.3">
                <span class="chip ${direction}">${chipArrow(r.change)} ${fmtNum(Math.abs(r.change))}</span>
              </div>
              <div class="text-dim" style="font-size:10px">${r.chain != null ? fmtPct(r.chain) : '新'}</div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function renderNewSellerTable(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无</div>';
    return `<table class="table compact">
      <thead><tr><th width="32">#</th><th>商家</th><th class="num">近7天 GMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td><div style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${r.name}</div></td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  function renderNewSeller2026Table(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无</div>';
    return `<table class="table compact">
      <thead><tr><th width="32">#</th><th>商家</th><th class="num">入驻日</th><th class="num">近30d GMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td><div style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name}">${r.name}</div></td>
            <td class="num text-dim" style="font-size:10px">${(r.settleDate||'').substring(5)}</td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // ============ Tab 3: 商家健康 ============
  function renderTab3() {
    const t = M.tab3_seller;
    const root = document.getElementById('tab3');
    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card primary">
          <div class="kpi-label">🏪 名下商家总数</div>
          <div class="kpi-value">${t.totalSellerCount}<span class="unit">家</span></div>
          <div class="kpi-foot text-dim">${M.meta.department}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">✨ 本月动销商家 <span class="card-sub">${M.meta.period.thisMonth || '本月'}</span></div>
          <div class="kpi-value">${t.monthActiveCount}<span class="unit">家</span></div>
          <div class="kpi-foot text-dim">动销率 ${fmtPct(t.monthActiveCount / t.totalSellerCount, false)} · 合计 ${fmtNum(t.monthActiveTotal)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">🆕 本月新动销 <span class="card-sub">2026 入驻</span></div>
          <div class="kpi-value">${t.newSellerCount}<span class="unit">家</span></div>
          <div class="kpi-foot text-dim">合计 GMV ${fmtNum(t.newSellerTotal)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">⚠️ 本月未动销</div>
          <div class="kpi-value">${t.totalSellerCount - t.monthActiveCount}<span class="unit">家</span></div>
          <div class="kpi-foot text-dim">占比 ${fmtPct((t.totalSellerCount - t.monthActiveCount) / t.totalSellerCount, false)}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">🏆 商家 DGMV Top15 <span class="card-sub">近 7 天 · 含环比近7天 vs 上7天</span></div>
        </div>
        <div id="t3-top15" class="chart tall"></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head">
            <div class="card-title">🆕 本月新动销商家 Top10 <span class="card-sub">2026 入驻 + 本月有 GMV</span></div>
          </div>
          ${renderNewSeller2026Table(t.newSellers)}
        </div>
        <div class="card">
          <div class="card-head">
            <div class="card-title">📊 商家本月动销分布</div>
          </div>
          <div id="t3-pie" class="chart"></div>
        </div>
      </div>
    `;

    // Top15 横向条形
    const c1 = echarts.init(document.getElementById('t3-top15'));
    const data = t.top15.slice().reverse();
    const opt = baseOpt();
    c1.setOption({
      ...opt,
      grid: { ...opt.grid, left: 200, right: 120 },
      tooltip: { ...opt.tooltip, formatter: (p) => {
        const row = t.top15[t.top15.length - 1 - p[0].dataIndex];
        return `<b>${row.name}</b><br/>近7天: ${fmtNum(row.gmv)}<br/>上7天: ${fmtNum(row.prevGmv)}<br/>变化: <span style="color:${row.change>0?'#2ea043':'#f85149'}">${row.change>0?'+':''}${fmtNum(row.change)}</span> (${row.chain != null ? fmtPct(row.chain) : '新'})`;
      }},
      yAxis: {
        type: 'category',
        data: data.map(r => r.name),
        axisLine: { lineStyle: { color: COLORS.grid } },
        axisLabel: { color: COLORS.dim, fontSize: 11, width: 180, overflow: 'truncate' },
        axisTick: { show: false },
      },
      xAxis: {
        type: 'value', axisLine: { show: false },
        axisLabel: { color: COLORS.dim, fontSize: 11, formatter: (v) => fmtNum(v) },
        splitLine: { lineStyle: { color: COLORS.grid, type: 'dashed' } },
      },
      series: [{
        type: 'bar', barWidth: '55%',
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: (p) => {
            const row = data[p.dataIndex];
            if (row.chain == null) return COLORS.warning; // 新
            return row.chain >= 0 ? COLORS.primary : '#9d4150';
          },
        },
        data: data.map(r => r.gmv),
        label: {
          show: true, position: 'right', color: COLORS.text, fontSize: 11,
          formatter: (p) => {
            const row = data[p.dataIndex];
            if (row.chain == null) return `${fmtNum(p.value)}  🆕`;
            const arrow = row.chain > 0 ? '↑' : row.chain < 0 ? '↓' : '—';
            return `${fmtNum(p.value)}  ${arrow}${fmtPct(Math.abs(row.chain), false)}`;
          },
        },
      }],
    });

    const c2 = echarts.init(document.getElementById('t3-pie'));
    c2.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', backgroundColor: 'rgba(28,35,45,0.96)', borderColor: COLORS.grid, textStyle: { color: COLORS.text } },
      legend: { bottom: 0, textStyle: { color: COLORS.dim } },
      series: [{
        type: 'pie', radius: ['55%', '78%'], center: ['50%', '45%'],
        label: { show: true, color: COLORS.text, fontSize: 12, formatter: '{b}\n{d}%' },
        itemStyle: { borderColor: '#1c232d', borderWidth: 2 },
        data: [
          { name: '本月动销', value: t.monthActiveCount, itemStyle: { color: COLORS.primary } },
          { name: '本月未动销', value: t.totalSellerCount - t.monthActiveCount, itemStyle: { color: '#3a4252' } },
        ],
      }],
    });
    charts.push(c1, c2);
  }

  // ============ Tab 4: 场域分析（近 7 天）============
  function renderTab4() {
    const t = M.tab4_field;
    const root = document.getElementById('tab4');
    const sum7d = t.fieldSummary7d;
    const total7d = sum7d.reduce((s, r) => s + r.gmv, 0);

    root.innerHTML = `
      <div class="kpi-grid">
        ${sum7d.map(f => `
          <div class="kpi-card">
            <div class="kpi-label"><span class="dot" style="background:${fieldColor(f.field)}"></span>${f.field}</div>
            <div class="kpi-value">${fmtNum(f.gmv)}<span class="unit">元</span></div>
            <div class="kpi-foot text-dim">占比 ${fmtPct(f.gmv/total7d, false)}</div>
          </div>`).join('')}
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div class="card-title">📺 近 7 天单场店播 GMV Top10 <span class="card-sub">日期 × 商家</span></div></div>
          ${renderSessionGmvTable(t.topSessionGmv)}
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">📝 近 7 天笔记 Top10</div></div>
          ${renderNoteTable(t.topNotes7d)}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">💎 近 7 天 Top10 买手 × 商品 × 商家 <span class="card-sub">仅 K播</span></div></div>
        ${renderComboTable(t.topCombos7d)}
      </div>
    `;
  }

  function renderSessionGmvTable(rows) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无数据</div>';
    return `<table class="table">
      <thead><tr><th width="40">#</th><th class="num">日期</th><th>商家</th><th class="num">单日店播 GMV</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td class="num text-dim" style="font-size:12px">${(r.date||'').substring(5)}</td>
            <td>${r.seller}</td>
            <td class="num">${fmtNum(r.gmv)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // ============ Tab 5: 类目盘子 ============
  function renderTab5() {
    const t = M.tab5_category;
    const root = document.getElementById('tab5');
    const totalChainCls = t.totalChain == null ? 'flat' : t.totalChain > 0 ? 'up' : 'down';
    const totalChainSign = t.totalChain == null ? '—' : t.totalChain > 0 ? '↑' : '↓';

    // 涨跌排序的类目
    const upL2 = t.l2List.filter(x => x.change > 0).sort((a,b) => b.change - a.change).slice(0, 5);
    const downL2 = t.l2List.filter(x => x.change < 0).sort((a,b) => a.change - b.change).slice(0, 5);

    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card primary">
          <div class="kpi-label">💰 本月 GMV <span class="card-sub">${M.meta.period.thisMonth || ''}</span></div>
          <div class="kpi-value">${fmtNum(t.totalGmv)}<span class="unit">元</span></div>
          <div class="kpi-foot text-dim">
            <span class="chip ${totalChainCls}">${totalChainSign} ${t.totalChain != null ? fmtPct(Math.abs(t.totalChain), false) : '—'}</span>
            vs 上月同期 ${fmtNum(t.totalGmvPrev)}
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">🏷️ 二级类目数</div>
          <div class="kpi-value">${t.totalCategories}<span class="unit">个</span></div>
          <div class="kpi-foot text-dim">本月有动销</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">📊 Top 5 类目占比</div>
          <div class="kpi-value">${fmtPct(t.l2List.slice(0,5).reduce((s,r)=>s+r.gmv,0)/t.totalGmv, false)}</div>
          <div class="kpi-foot text-dim">头部集中度</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">🚀 涨幅最大类目</div>
          <div class="kpi-value" style="font-size:18px">${upL2[0]?.name || '—'}</div>
          <div class="kpi-foot text-dim">${upL2[0] ? '<span class="chip up">↑ '+fmtNum(upL2[0].change)+'</span>' : ''}</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div class="card-title">🚀 涨幅 Top5 类目 <span class="card-sub">本月 vs 上月同期</span></div></div>
          ${renderL2ChangeTable(upL2, 'up')}
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">📉 降幅 Top5 类目</div></div>
          ${renderL2ChangeTable(downL2, 'down')}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">🏷️ 二级类目盘子 <span class="card-sub">本月 GMV、环比、商家归因</span></div>
        </div>
        <div style="overflow-x:auto">
        <table class="table">
          <thead><tr>
            <th width="40">#</th>
            <th>二级类目</th>
            <th class="num">本月 GMV</th>
            <th class="num">占比</th>
            <th class="num">环比</th>
            <th>主要拉动 / 拖累商家</th>
            <th class="num">动销商家</th>
          </tr></thead>
          <tbody>
            ${t.l2List.map((l2, i) => {
              const upStr = (l2.topUpSellers || []).slice(0,3).map(s => `<span class="chip up" style="margin-right:4px;font-size:10px">${s.name} +${fmtNum(s.change)}</span>`).join('');
              const downStr = (l2.topDownSellers || []).slice(0,2).map(s => `<span class="chip down" style="margin-right:4px;font-size:10px">${s.name} ${fmtNum(s.change)}</span>`).join('');
              const cls = l2.chain == null ? 'flat' : l2.chain > 0 ? 'up' : 'down';
              const arrow = l2.chain == null ? '—' : l2.chain > 0 ? '↑' : '↓';
              return `
                <tr>
                  <td>${rankBadge(i+1)}</td>
                  <td><b>${l2.name}</b></td>
                  <td class="num">${fmtNum(l2.gmv)}</td>
                  <td class="num">${fmtPct(l2.gmv / t.totalGmv, false)}</td>
                  <td class="num">
                    <span class="chip ${cls}">${arrow} ${l2.chain != null ? fmtPct(Math.abs(l2.chain), false) : '新'}</span>
                    <div class="text-dim" style="font-size:10px">${l2.change > 0 ? '+' : ''}${fmtNum(l2.change)}</div>
                  </td>
                  <td style="max-width:380px">${upStr}${downStr || '<span class="text-dim" style="font-size:11px">无下跌</span>'}</td>
                  <td class="num">${l2.sellers}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">🥧 二级类目 GMV 分布 <span class="card-sub">Top 20</span></div></div>
        <div id="t5-treemap" class="chart tall"></div>
      </div>
    `;

    const c1 = echarts.init(document.getElementById('t5-treemap'));
    c1.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        formatter: (p) => {
          const d = p.data;
          const chainStr = d.chain != null ? ` (${d.chain>0?'+':''}${(d.chain*100).toFixed(1)}%)` : '';
          return `<b>${p.name}</b><br/>本月: ${fmtNum(p.value)}${chainStr}<br/>上月: ${fmtNum(d.prev || 0)}<br/>商家: ${d.sellers || '-'}`;
        },
        backgroundColor: 'rgba(28,35,45,0.96)', borderColor: COLORS.grid, textStyle: { color: COLORS.text },
      },
      series: [{
        type: 'treemap',
        data: t.l2List.map(l2 => ({
          name: l2.name, value: l2.gmv,
          prev: l2.prevGmv, chain: l2.chain, sellers: l2.sellers,
          itemStyle: { color: l2.chain == null ? '#6e7681' : l2.chain > 0 ? COLORS.primary : '#9d4150' },
        })),
        roam: false, nodeClick: false, breadcrumb: { show: false },
        label: { show: true, color: COLORS.text, fontSize: 12, formatter: (p) => `${p.name}\n${fmtNum(p.value)}` },
        itemStyle: { borderColor: '#1c232d', borderWidth: 2, gapWidth: 2 },
      }],
    });
    charts.push(c1);
  }

  function renderL2ChangeTable(rows, dir) {
    if (!rows || rows.length === 0) return '<div class="empty">暂无</div>';
    return `<table class="table compact">
      <thead><tr><th width="32">#</th><th>类目</th><th class="num">本月 GMV</th><th class="num">变化</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${rankBadge(i+1)}</td>
            <td><b>${r.name}</b></td>
            <td class="num">${fmtNum(r.gmv)}</td>
            <td class="num">
              <span class="chip ${dir}">${dir === 'up' ? '↑' : '↓'} ${fmtNum(Math.abs(r.change))}</span>
              <div class="text-dim" style="font-size:10px">${r.chain != null ? fmtPct(r.chain) : '新'}</div>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  // ============ Tab 6: 违规预警 ============
  function renderTab6() {
    const t = M.tab6_violation;
    const root = document.getElementById('tab6');
    if (!t.list || t.list.length === 0) {
      root.innerHTML = `
        <div class="card" style="text-align:center;padding:60px 20px">
          <div style="font-size:48px;margin-bottom:16px">✅</div>
          <div class="card-title" style="margin-bottom:8px">近 7 天名下商家无违规处罚</div>
          <div class="text-dim">暂未检测到违规消息</div>
        </div>`;
      return;
    }
    root.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card" style="background:linear-gradient(135deg, rgba(248,81,73,0.12) 0%, var(--bg-card) 100%);border-color:rgba(248,81,73,0.25)">
          <div class="kpi-label" style="color:var(--danger)">⚠️ 近 7 天违规商家数</div>
          <div class="kpi-value">${t.totalSellers}<span class="unit">家</span></div>
          <div class="kpi-foot text-dim">需关注</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">📨 总处罚次数 <span class="card-sub">含黑+白盒</span></div>
          <div class="kpi-value">${t.totalCount}<span class="unit">次</span></div>
          <div class="kpi-foot text-dim">${t.source || 'Themis 25094'}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">🔴 黑盒处罚</div>
          <div class="kpi-value">${t.totalBlack || 0}<span class="unit">次</span></div>
          <div class="kpi-foot text-dim">系统强制</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">🟡 白盒处罚</div>
          <div class="kpi-value">${t.totalWhite || 0}<span class="unit">次</span></div>
          <div class="kpi-foot text-dim">人工/可申诉</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">⚠️ 近 7 天违规处罚商家明细 <span class="card-sub">建议联系商家了解情况</span></div>
        </div>
        <table class="table">
          <thead><tr>
            <th width="40">#</th><th>商家名称</th><th class="num">总次数</th><th class="num">🔴 黑盒</th><th class="num">🟡 白盒</th><th>主因</th><th>预警等级</th>
          </tr></thead>
          <tbody>
            ${t.list.map((r, i) => {
              const level = r.totalCount >= 15 ? 'high' : r.totalCount >= 5 ? 'mid' : 'low';
              const levelTag = level === 'high'
                ? '<span class="chip down">🔴 高</span>'
                : level === 'mid'
                  ? '<span class="chip" style="color:#d29922;background:rgba(210,153,34,.12)">🟡 中</span>'
                  : '<span class="chip" style="color:#58a6ff;background:rgba(88,166,255,.12)">🔵 低</span>';
              return `
                <tr>
                  <td>${rankBadge(i+1)}</td>
                  <td><b>${r.name}</b></td>
                  <td class="num"><b>${r.totalCount}</b></td>
                  <td class="num" style="color:#f85149">${r.blackCount || 0}</td>
                  <td class="num" style="color:#d29922">${r.whiteCount || 0}</td>
                  <td><span style="font-size:12px">${r.topReason}</span> <span class="text-dim" style="font-size:10px">×${r.topReasonCount}</span></td>
                  <td>${levelTag}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // ============ Tab 7: 小红书 GPM 数据看板 ============
  function renderTab7() {
    const root = document.getElementById('tab7');
    root.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;overflow:hidden;height:calc(100vh - 200px);min-height:750px;">
        <iframe src="./xhs-gpm/" style="width:100%;height:100%;border:none;" title="小红书商品笔记GPM数据看板" loading="lazy"></iframe>
      </div>
      <div style="text-align:center;margin-top:12px;color:var(--text-dim);font-size:12px;">
        📊 数据来源：小红书商家后台 · 2025-11-06 ~ 2026-05-31 · 1,192 篇商品笔记 · 9 个商品 · <a href="./xhs-gpm/report.html" target="_blank" style="color:var(--primary);">打开洞察报告 ↗</a>
      </div>`;
  }

  // ============ Tab 切换 ============
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === name));
    setTimeout(() => charts.forEach(c => c.resize()), 30);
  }

  // ============ 初始化 ============
  function init() {
    document.getElementById('owner-name').textContent = `${M.meta.ownerName}（${M.meta.ownerAlias}）`;
    document.getElementById('owner-dept').textContent = M.meta.department;
    document.getElementById('updated-at').textContent = M.meta.updatedAt;
    const srcEl = document.getElementById('data-source');
    if (srcEl) {
      srcEl.textContent = '✅ 真实数据 V4';
      srcEl.style.color = '#2ea043';
    }

    renderTab1();
    renderTab2();
    renderTab3();
    renderTab4();
    renderTab5();
    renderTab6();
    renderTab7();

    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });

    switchTab('tab1');

    window.addEventListener('resize', () => charts.forEach(c => c.resize()));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
