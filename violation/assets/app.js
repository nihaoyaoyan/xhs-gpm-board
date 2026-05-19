// 违规预警看板 app.js
const CACHE_BUSTER = '?v=' + Date.now();
const AM_ORDER = ['大门(朱锦程)', '秋罗(胡春秋)', '路歌(李红红)', '诺亚(单恩浩)', '莱拉(付艺迪)', '蕾塞(张嘉悦)'];

let DATA = {};
let currentView = 'team'; // 'team' or AM name

async function fetchJson(name) {
  const r = await fetch(`data/${name}${CACHE_BUSTER}`, { cache: 'no-store' });
  return await r.json();
}

async function init() {
  try {
    const [summary, byAm, tags, avoid, meta, index] = await Promise.all([
      fetchJson('_summary.json'),
      fetchJson('_by_am.json'),
      fetchJson('_tags.json'),
      fetchJson('_avoid.json'),
      fetchJson('_meta.json'),
      fetchJson('index.json'),
    ]);
    DATA = { summary, byAm, tags, avoid, meta, index };
    renderSidebar();
    renderMeta();
    render();
  } catch (e) {
    document.getElementById('main-content').innerHTML = `<div class="loading">加载失败: ${e.message}</div>`;
    console.error(e);
  }
}

function renderSidebar() {
  const ams = DATA.index.am_list;
  const teamCount = DATA.summary.yest_total;
  const teamSevere = DATA.summary.yest_severe;
  const html = [
    `<div class="am-btn ${currentView==='team'?'active':''}" data-view="team">
       <span>👥 全组汇总</span>
       <span class="badge">${teamCount}${teamSevere?` <span class="severe">${teamSevere}重</span>`:''}</span>
     </div>`,
    ...ams.map(a => `<div class="am-btn ${currentView===a.am?'active':''}" data-view="${a.am}">
       <span>${a.am.split('(')[0]}</span>
       <span class="badge">${a.yest_count}${a.yest_severe?` <span class="severe">${a.yest_severe}重</span>`:''}</span>
     </div>`)
  ].join('');
  document.getElementById('am-buttons').innerHTML = html;
  document.querySelectorAll('.am-btn').forEach(btn => {
    btn.onclick = () => { currentView = btn.dataset.view; renderSidebar(); render(); };
  });
}

function renderMeta() {
  const m = DATA.meta;
  document.getElementById('meta-info').innerHTML = `
    📅 数据日期：${m.yest_date}<br>
    🔄 生成时间：${m.generated_at}<br>
    📊 14d 窗口：${m.d14_start} ~ ${m.d14_end}
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function l1Class(l1) {
  if (!l1) return '默认';
  if (l1.includes('违规营销')) return '违规营销';
  if (l1.includes('虚假宣传')) return '虚假宣传';
  if (l1.includes('主控侵权') || l1.includes('肖像') || l1.includes('版权')) return '主控侵权';
  if (l1.includes('内容生态')) return '内容生态';
  if (l1.includes('医疗')) return '医疗';
  if (l1.includes('合规') || l1.includes('准入')) return '合规';
  return '默认';
}

function deltaBadge(value, suffix = '%') {
  if (value == null || isNaN(value)) return '';
  const abs = Math.abs(value);
  // 阈值：>500% 视为异常不显示
  if (abs > 500) return `<span class="kpi-delta flat">环比异常波动</span>`;
  const arrow = value > 0 ? '↑' : (value < 0 ? '↓' : '→');
  const cls = value > 0 ? 'up' : (value < 0 ? 'down' : 'flat');
  return `<span class="kpi-delta ${cls}">${arrow} ${abs}${suffix}</span>`;
}

function cangqiongShopUrl(sellerId) {
  if (!sellerId) return '#';
  return `https://cangqiong.devops.xiaohongshu.com/customer/${sellerId}`;
}

function cangqiongNoteUrl(noteId) {
  if (!noteId) return '#';
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function render() {
  const main = document.getElementById('main-content');
  if (currentView === 'team') {
    main.innerHTML = renderTeamView();
  } else {
    main.innerHTML = renderAmView(currentView);
  }
  // 渲染 chart
  setTimeout(() => {
    document.querySelectorAll('.chart-container[data-chart]').forEach(el => {
      const chart = echarts.init(el);
      const opt = JSON.parse(el.dataset.chart);
      chart.setOption(opt);
      window.addEventListener('resize', () => chart.resize());
    });
  }, 50);
}

function renderTeamView() {
  const s = DATA.summary;
  const tags = DATA.tags;
  const avoid = DATA.avoid;
  const byAm = DATA.byAm;

  // Hero
  let hero = `
    <div class="hero">
      <div class="hero-title">🚨 全组违规预警 · ${s.yest_date}</div>
      <div class="hero-subtitle">五组（休食）昨日新增违规处罚汇总 · 仅含未撤销处罚</div>
      <div class="hero-kpi">
        <div class="kpi-card">
          <div class="kpi-label">昨日新增违规</div>
          <div class="kpi-value danger">${s.yest_total}</div>
          ${s.mom != null ? deltaBadge(s.mom) + ' vs 前日' : ''}
        </div>
        <div class="kpi-card">
          <div class="kpi-label">重度违规</div>
          <div class="kpi-value ${s.yest_severe>0?'danger':''}">${s.yest_severe}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">涉及商家</div>
          <div class="kpi-value warn">${s.yest_seller_count}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">涉及 AM</div>
          <div class="kpi-value">${s.yest_am_count} / 6</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">近 14 天累计</div>
          <div class="kpi-value">${s.d14_total}</div>
          <div class="muted-mini">涉及 ${s.d14_seller_count} 商家</div>
        </div>
      </div>
    </div>`;

  // AM 矩阵
  let amGrid = `<div class="am-grid">`;
  for (const am of AM_ORDER) {
    const a = byAm[am];
    if (!a) continue;
    const tagsHtml = a.tag_l1_top5_14d && a.tag_l1_top5_14d.length
      ? a.tag_l1_top5_14d.slice(0,3).map(([t,c]) => `<span class="tag-pill l1-${l1Class(t)}">${escapeHtml(t)} ${c}</span>`).join('')
      : '<span class="muted-mini">无</span>';
    amGrid += `
      <div class="am-card">
        <div class="am-card-header">
          <span class="am-card-name">${a.am}</span>
          <span class="am-card-count">${a.yest_count}${a.yest_severe?` <small style="color:#fa8c16">(${a.yest_severe}重)</small>`:''}</span>
        </div>
        <div class="am-card-meta">昨日涉及 ${a.yest_seller_count} 商家 · 14d 累计 ${a.d14_count} 起 / ${a.d14_seller_count} 商家</div>
        <div class="am-card-meta" style="margin-bottom:6px">14d 高频违规类型：</div>
        <div class="am-card-tags">${tagsHtml}</div>
      </div>`;
  }
  amGrid += `</div>`;

  // 标签 Top10
  const maxCount = tags.tag_top20[0] ? tags.tag_top20[0][1] : 1;
  const tagRank = tags.tag_top20.slice(0, 15).map((t, i) => `
    <div class="tag-rank-item">
      <span class="tag-rank-num top${i<3?i+1:''}">${i+1}</span>
      <span class="tag-rank-name">${escapeHtml(t[0])}</span>
      <span class="tag-rank-bar"><span class="tag-rank-bar-fill" style="width:${t[1]/maxCount*100}%"></span></span>
      <span class="tag-rank-count">${t[1]}</span>
    </div>
  `).join('');

  // 规避指南
  const avoidHtml = avoid.slice(0, 8).map(g => `
    <div class="avoid-item l1-${l1Class(g.tag_l1)}">
      <div class="avoid-header">
        <span class="avoid-title">${escapeHtml(g.tag_l1)}</span>
        <span class="avoid-pct">14d ${g.count} 起 · 占比 ${g.pct}%</span>
      </div>
      <div class="avoid-risk">⚠️ 风险点：${escapeHtml(g.risk)}</div>
      ${g.tips && g.tips.length ? `<ul class="avoid-tips">${g.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
      <div class="avoid-subtags">
        子标签：${g.top_sub_tags.slice(0,3).map(t => `${escapeHtml(t[0])} (${t[1]})`).join('、')}
        ${g.top_ams ? ` · 主要 AM：${g.top_ams.slice(0,3).map(t => t[0].split('(')[0]).join('、')}` : ''}
      </div>
    </div>
  `).join('');

  // AM 14d 累计柱图
  const amDist = tags.am_dist_14d;
  const amChartOpt = {
    grid: { top: 20, right: 20, bottom: 30, left: 90 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: amDist.map(x => x[0].split('(')[0]) },
    series: [{ type: 'bar', data: amDist.map(x => x[1]), itemStyle: { color: '#ff7875' }, label: { show: true, position: 'right' } }]
  };

  return hero + `
    <div class="section">
      <div class="section-title">🎯 AM 矩阵 <span class="badge">昨日 ${s.yest_date}</span></div>
      ${amGrid}
    </div>
    <div class="section">
      <div class="section-title">📊 近 14 天 AM 违规累计</div>
      <div class="chart-container" data-chart='${JSON.stringify(amChartOpt).replace(/'/g, "&#39;")}'></div>
    </div>
    <div class="section">
      <div class="section-title">🏷️ 高频违规标签 Top15 <span class="badge">14 天</span></div>
      <div class="tag-rank">${tagRank}</div>
    </div>
    <div class="section">
      <div class="section-title">💡 违规根因 & 规避指南 <span class="badge">基于 14 天数据自动生成</span></div>
      <div class="section-subtitle">建议 AM 据此提醒商家自查；与商家沟通时可直接引用这些条目</div>
      <div class="avoid-list">${avoidHtml}</div>
    </div>
  `;
}

function renderAmView(am) {
  const a = DATA.byAm[am];
  if (!a) return `<div class="loading">无数据</div>`;
  const s = DATA.summary;

  // Hero
  let hero = `
    <div class="hero">
      <div class="hero-title">👤 ${a.am}</div>
      <div class="hero-subtitle">📧 ${a.email} · 数据日期 ${s.yest_date}</div>
      <div class="hero-kpi">
        <div class="kpi-card">
          <div class="kpi-label">昨日新增违规</div>
          <div class="kpi-value danger">${a.yest_count}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">重度违规</div>
          <div class="kpi-value ${a.yest_severe>0?'danger':''}">${a.yest_severe}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">涉及商家</div>
          <div class="kpi-value warn">${a.yest_seller_count}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">14d 累计</div>
          <div class="kpi-value">${a.d14_count}</div>
          <div class="muted-mini">${a.d14_seller_count} 商家</div>
        </div>
      </div>
    </div>`;

  // 商家清单
  let sellerHtml = '';
  if (a.sellers.length === 0) {
    sellerHtml = `<div class="am-card-empty">🎉 昨日名下无新增违规</div>`;
  } else {
    sellerHtml = `<table class="detail">
      <thead>
        <tr><th style="width:200px">店铺</th><th style="width:60px">违规数</th><th>主要违规标签</th><th style="width:130px">实体类型</th></tr>
      </thead><tbody>`;
    for (const s of a.sellers) {
      const isSevere = s.severe > 0;
      const tagsList = s.top_tags.map(t => `<span class="tag-pill">${escapeHtml(t[0])} ×${t[1]}</span>`).join(' ');
      const entities = Object.entries(s.entities).map(([k,v]) => `${k} ${v}`).join(' / ');
      const tipText = s.samples.length ? s.samples.map(x => `[${x.tag}] ${x.desc||''}`).join('\n\n') : '';
      const tipAttr = tipText ? `data-tip="${escapeHtml(tipText)}"` : '';
      sellerHtml += `
        <tr ${isSevere?'class="severe-row"':''}>
          <td>
            <div class="cell-shop">
              <a href="${cangqiongShopUrl(s.seller_id)}" target="_blank" class="shop-link" ${tipAttr}>${escapeHtml(s.shop_name)}</a>
              ${isSevere?'<span class="level-severe"> [重度]</span>':''}
            </div>
            <div class="seller-detail">${s.seller_id}</div>
          </td>
          <td><strong>${s.count}</strong>${s.severe?` <small class="level-severe">(${s.severe}重)</small>`:''}</td>
          <td>${tagsList}</td>
          <td><span class="entity-label">${escapeHtml(entities)}</span></td>
        </tr>`;
    }
    sellerHtml += '</tbody></table>';
  }

  // 14d 高频标签
  const tagRank = a.tag_top10_14d.length === 0 ? '<div class="muted-mini">近 14 天无违规</div>' :
    a.tag_top10_14d.map((t, i) => `
    <div class="tag-rank-item">
      <span class="tag-rank-num top${i<3?i+1:''}">${i+1}</span>
      <span class="tag-rank-name">${escapeHtml(t[0])}</span>
      <span class="tag-rank-count">${t[1]}</span>
    </div>`).join('');

  // 个性化规避建议（基于该 AM Top 标签匹配 avoid 模板）
  const amL1Tags = a.tag_l1_top5_14d.map(t => t[0]);
  const myAvoid = DATA.avoid.filter(g => amL1Tags.includes(g.tag_l1));
  const avoidHtml = myAvoid.length === 0 ? '<div class="muted-mini">无</div>' :
    myAvoid.slice(0, 5).map(g => `
    <div class="avoid-item l1-${l1Class(g.tag_l1)}">
      <div class="avoid-header">
        <span class="avoid-title">${escapeHtml(g.tag_l1)}</span>
        <span class="avoid-pct">你名下 14d ${a.tag_l1_top5_14d.find(t=>t[0]===g.tag_l1)?.[1]||0} 起</span>
      </div>
      <div class="avoid-risk">⚠️ ${escapeHtml(g.risk)}</div>
      ${g.tips && g.tips.length ? `<ul class="avoid-tips">${g.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
    </div>
  `).join('');

  // 完整明细表
  let detailHtml = '';
  if (a.detail_yest.length > 0) {
    detailHtml = `<table class="detail">
      <thead>
        <tr><th style="width:160px">店铺</th><th style="width:80px">类型</th><th>违规标签</th><th style="width:80px">等级</th><th style="width:120px">处罚动作</th><th style="width:300px">违规描述</th></tr>
      </thead><tbody>`;
    for (const d of a.detail_yest) {
      const isSevere = d.level_label === '重度';
      const entityLink = d.entity_label === '笔记' && d.entity_id
        ? `<a href="${cangqiongNoteUrl(d.entity_id)}" target="_blank" class="shop-link">笔记</a>`
        : `<span class="entity-label">${d.entity_label}</span>`;
      const actionsHtml = (d.actions_short||[]).map(a => `<span class="action-pill ${a.includes('重')||a==='下架'||a==='清退'||a==='封禁'?'heavy':''}">${a}</span>`).join('');
      detailHtml += `
        <tr ${isSevere?'class="severe-row"':''}>
          <td>
            <a href="${cangqiongShopUrl(d.seller_id)}" target="_blank" class="shop-link">${escapeHtml(d.shop_name)}</a>
            <div class="seller-detail">${d.punish_type}</div>
          </td>
          <td>${entityLink}</td>
          <td>${escapeHtml(d.tag)}<br><span class="muted-mini">${escapeHtml(d.tag_l1)}</span></td>
          <td><span class="${isSevere?'level-severe':'level-light'}">${d.level_label}</span></td>
          <td>${actionsHtml}</td>
          <td><span style="font-size:11px;color:#6b7280">${escapeHtml(d.desc || '(无描述)')}</span></td>
        </tr>`;
    }
    detailHtml += '</tbody></table>';
  }

  return hero + `
    <div class="section">
      <div class="section-title">🏪 你名下昨日违规商家 <span class="badge">${a.sellers.length} 家 / ${a.yest_count} 起</span></div>
      <div class="section-subtitle">点击店铺名跳转苍穹 CRM · 重度违规已高亮 · 鼠标悬停店铺名可看违规描述</div>
      ${sellerHtml}
    </div>
    <div class="section">
      <div class="section-title">💡 你名下高频违规规避建议</div>
      <div class="section-subtitle">基于你名下近 14 天高频违规类型，建议优先与对应商家沟通</div>
      <div class="avoid-list">${avoidHtml}</div>
    </div>
    <div class="section">
      <div class="section-title">🏷️ 你名下 14d 高频违规标签</div>
      <div class="tag-rank">${tagRank}</div>
    </div>
    ${detailHtml ? `<div class="section">
      <div class="section-title">📋 昨日违规完整明细 <span class="badge">${a.detail_yest.length} 条</span></div>
      ${detailHtml}
    </div>` : ''}
  `;
}

document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

init();
