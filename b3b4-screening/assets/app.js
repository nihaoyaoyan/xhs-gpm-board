// B3/B4 商家信号筛选 dashboard V2 前端
'use strict';

const CB = Math.floor(Date.now() / 60000);  // cache-buster: 分钟时间戳
const fetchJson = (p) => fetch(`${p}?v=${CB}`, { cache: 'no-store' }).then(r => r.json());

const SHOP_SEARCH = (name) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(name)}&type=51`;
const CANGQIONG_LINK = (sid) => `https://canghai.devops.xiaohongshu.com/seller-portrait?sid=${sid}`;

// === Builder 协作打标存储 ===
const BUILDER_BASE = 'https://builder.devops.xiaohongshu.com/builder-api/v1';
const BUILDER_APP_ID = 'bld_c34ff7082494448fa4ce936776fed002';
const MARK_TABLE = 'b3b4_seller_user_marks';
const NOTE_MAX = 50;

let state = {
  meta: null,
  sellers: [],
  categories: null,
  signalsDict: null,
  currentGrade: 'S',
  filters: { am: '', quadrant: '', cat: '', layer: '', growth: '', critical: '', search: '' },
  filter_important: false,
  marks: {},          // { sid: { id, is_important, note, author_name, updated_at } }
  marksLoaded: false,
  marksError: null,
  currentUser: null,  // 当前 AM（从 localStorage 取，未选则弹选择器）
};

const Q_CLASS = {
  '🌟 优等生': 'q-excellent',
  '⚡ 黑马': 'q-horse',
  '🐢 慢热': 'q-slow',
  '· 中间态': 'q-mid',
  '⚠️ 待观察': 'q-watch',
};

function fmtWan(v) {
  if (v == null || isNaN(v)) return '--';
  return (v / 10000).toFixed(1) + '万';
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return '--';
  return (v * 100).toFixed(1) + '%';
}
function fmtNum(v) {
  if (v == null || isNaN(v)) return '--';
  return Math.round(v).toLocaleString();
}
function escHTML(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// === 协作打标：Builder 存储 + 当前用户身份 + Toast + 防抖 ===
// ============================================================
function showToast(msg, kind) {
  kind = kind || 'info';
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function getStoredUser() {
  try { return localStorage.getItem('b3b4_current_am') || null; } catch (_) { return null; }
}
function setStoredUser(name) {
  try { localStorage.setItem('b3b4_current_am', name); } catch (_) {}
  state.currentUser = name;
  const badge = document.getElementById('current-am-badge');
  if (badge) badge.textContent = `👤 ${name}`;
}

function ensureCurrentUser() {
  if (state.currentUser) return Promise.resolve(state.currentUser);
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'user-picker-overlay';
    const ams = (state.meta && state.meta.am_list) ? state.meta.am_list : [];
    overlay.innerHTML = `
      <div class="user-picker">
        <h3>👋 请选择你是哪位 AM</h3>
        <p class="hint">仅本机记录，用于在打标记录上署名。可在右上角再次切换。</p>
        <div class="user-picker-list">
          ${ams.map(a => `<button class="user-pick-btn" data-am="${escHTML(a)}">${escHTML(a)}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.user-pick-btn').forEach(b => {
      b.addEventListener('click', () => {
        const am = b.dataset.am;
        setStoredUser(am);
        overlay.remove();
        resolve(am);
      });
    });
  });
}

// Builder API 调用：始终带 credentials: 'include'，失败必抛
async function builderPost(path, body) {
  const url = `${BUILDER_BASE}${path}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Builder-App-Id': BUILDER_APP_ID,
      },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    // 网络层失败：通常是 CORS / 公司内网代理 / 浏览器拦截 / 离线
    throw new Error(`网络连不上 Builder（${netErr.message || netErr}）— 检查是否在公司内网、是否开了广告/隐私拦截插件`);
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = ' · ' + (await resp.text()).slice(0, 120); } catch (_) {}
    throw new Error(`Builder 返回 HTTP ${resp.status}${detail}`);
  }
  const json = await resp.json();
  if (json.code !== 0) throw new Error(json.message || `Builder code ${json.code}`);
  return json.data;
}

async function loadAllMarks() {
  // 一次性拉全表（全表 ≤ 952 行规模，可以全拉）
  state.marksError = null;
  try {
    let offset = 0;
    const pageSize = 1000;
    const acc = {};
    // 一次拉 1000，5 AM × 952 量级一页就够
    const data = await builderPost('/supabase/rows/query', {
      table_name: MARK_TABLE,
      limit: pageSize,
      offset,
      query: { order: 'id.desc' },
    });
    (data.rows || []).forEach(r => {
      // 同 sid 可能出现并发多行，取 id desc 第一条（已 order 过）
      if (!acc[r.sid]) acc[r.sid] = r;
    });
    state.marks = acc;
    state.marksLoaded = true;
  } catch (err) {
    console.warn('[marks] load failed:', err);
    state.marksError = err.message || String(err);
    state.marksLoaded = false;
    showToast('⚠️ 打标数据加载失败，仅展示原始数据：' + state.marksError, 'err');
  }
}

// upsert：先查 → 有则 update by id / 无则 insert
async function upsertMark(sid, patch) {
  const user = await ensureCurrentUser();
  const now = new Date().toISOString();
  const existed = state.marks[sid];
  if (existed && existed.id) {
    const data = await builderPost('/supabase/rows/update', {
      table_name: MARK_TABLE,
      values: { ...patch, author_name: user, updated_at: now },
      filters: { id: `eq.${existed.id}` },
    });
    const row = (data.rows && data.rows[0]) || { ...existed, ...patch, author_name: user, updated_at: now };
    state.marks[sid] = row;
    return row;
  } else {
    const data = await builderPost('/supabase/rows/insert', {
      table_name: MARK_TABLE,
      rows: [{ sid, ...patch, author_name: user, created_at: now, updated_at: now }],
    });
    const row = (data.rows && data.rows[0]) || { sid, ...patch, author_name: user, created_at: now, updated_at: now };
    state.marks[sid] = row;
    return row;
  }
}

// 切换 ⭐：optimistic update + 失败回滚
async function toggleImportant(sid) {
  if (!state.marksLoaded) { showToast('⚠️ 打标功能离线中', 'err'); return; }
  await ensureCurrentUser();
  const before = state.marks[sid] ? { ...state.marks[sid] } : null;
  const newVal = !(before && before.is_important);
  // optimistic
  state.marks[sid] = {
    ...(before || { sid, note: '' }),
    sid,
    is_important: newVal,
    author_name: state.currentUser,
    updated_at: new Date().toISOString(),
  };
  refreshOneSellerCard(sid);
  refreshKPI();
  try {
    await upsertMark(sid, {
      is_important: newVal,
      note: (before && before.note) || '',
    });
    refreshOneSellerCard(sid);
    refreshKPI();
  } catch (err) {
    // 回滚
    if (before) state.marks[sid] = before; else delete state.marks[sid];
    refreshOneSellerCard(sid);
    refreshKPI();
    showToast('❌ 保存失败：' + (err.message || err), 'err');
  }
}

// 保存备注：防抖 500ms
const saveNoteDebounced = debounce(async function (sid, note) {
  if (!state.marksLoaded) { showToast('⚠️ 打标功能离线中', 'err'); return; }
  await ensureCurrentUser();
  const before = state.marks[sid] ? { ...state.marks[sid] } : null;
  state.marks[sid] = {
    ...(before || { sid, is_important: false }),
    sid,
    note,
    author_name: state.currentUser,
    updated_at: new Date().toISOString(),
  };
  refreshOneSellerCard(sid);
  try {
    await upsertMark(sid, {
      is_important: !!(before && before.is_important),
      note,
    });
    refreshOneSellerCard(sid);
    showToast('✅ 备注已保存', 'ok');
  } catch (err) {
    if (before) state.marks[sid] = before; else delete state.marks[sid];
    refreshOneSellerCard(sid);
    showToast('❌ 备注保存失败：' + (err.message || err), 'err');
  }
}, 500);

function openNoteEditor(sid) {
  const seller = state.sellers.find(s => s.sid === sid);
  if (!seller) return;
  const cur = state.marks[sid] || {};
  const overlay = document.createElement('div');
  overlay.className = 'note-editor-overlay';
  overlay.innerHTML = `
    <div class="note-editor">
      <div class="ne-head">
        <h3>📝 备注 · ${escHTML(seller.name)}</h3>
        <button class="ne-close">✕</button>
      </div>
      <textarea class="ne-textarea" maxlength="${NOTE_MAX}" placeholder="≤${NOTE_MAX} 字，全组可见">${escHTML(cur.note || '')}</textarea>
      <div class="ne-foot">
        <span class="ne-counter"><span class="ne-cnt">0</span>/${NOTE_MAX}</span>
        <div>
          <button class="ne-cancel">取消</button>
          <button class="ne-save">保存</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const ta = overlay.querySelector('.ne-textarea');
  const cnt = overlay.querySelector('.ne-cnt');
  const updateCnt = () => { cnt.textContent = ta.value.length; };
  updateCnt();
  ta.addEventListener('input', updateCnt);
  setTimeout(() => ta.focus(), 30);
  const close = () => overlay.remove();
  overlay.querySelector('.ne-close').addEventListener('click', close);
  overlay.querySelector('.ne-cancel').addEventListener('click', close);
  overlay.querySelector('.ne-save').addEventListener('click', async () => {
    const note = ta.value.slice(0, NOTE_MAX);
    close();
    saveNoteDebounced(sid, note);
  });
}

// 重渲染单张商家卡（标注变更后用，比整页重绘便宜）
function refreshOneSellerCard(sid) {
  const old = document.getElementById(`card-${sid}`);
  if (!old) return;
  const seller = state.sellers.find(s => s.sid === sid);
  if (!seller) return;
  // 旧 echarts 实例必须 dispose，否则新 dom 节点会拿不到图
  const oldRadar = document.getElementById(`radar-${sid}`);
  if (oldRadar) {
    const inst = echarts.getInstanceByDom(oldRadar);
    if (inst) inst.dispose();
  }
  const html = sellerCardHTML(seller);
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const newNode = tmp.firstElementChild;
  old.replaceWith(newNode);
  // 在新 dom 节点上重新 init radar
  const newRadar = document.getElementById(`radar-${sid}`);
  if (newRadar) {
    const isMobile = window.innerWidth <= 768;
    const chart = echarts.init(newRadar);
    chart.setOption({
      radar: {
        indicator: [
          { name: '🏗️底盘', max: 100 },
          { name: '🚀动能', max: 100 },
          { name: '🎬场域纯', max: 100 },
          { name: '🎬场域约束', max: 100 },
        ],
        radius: isMobile ? '62%' : '60%',
        center: ['50%', '52%'],
        splitNumber: 2,
        axisName: { color: '#475569', fontSize: isMobile ? 10 : 9 },
        splitArea: { areaStyle: { color: ['#fafafa', '#fff'] } },
        splitLine: { lineStyle: { color: '#e5e7eb' } },
      },
      series: [{
        type: 'radar',
        data: [{
          value: [seller.fund, seller.mom, seller.field_pure, seller.field_cons],
          symbol: 'circle',
          symbolSize: 4,
          areaStyle: { color: 'rgba(37,99,235,0.22)' },
          lineStyle: { color: '#2563eb', width: 2 },
          itemStyle: { color: '#2563eb' },
        }],
      }],
    });
  }
}

function refreshKPI() {
  const total = Object.values(state.marks).filter(m => m && m.is_important).length;
  const el = document.getElementById('marks-kpi');
  if (el) el.textContent = `⭐ 全组已标重要 ${total} 个`;
}

// 暴露给 inline handler
window.toggleImportant = toggleImportant;
window.openNoteEditor = openNoteEditor;

// === Tabs ===
function initTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'sellers') {
        setTimeout(() => {
          document.querySelectorAll('.sc-radar').forEach(el => {
            const inst = echarts.getInstanceByDom(el);
            if (inst) inst.resize();
          });
        }, 50);
      }
    });
  });
}

// === Topbar meta ===
function renderTopbar() {
  document.getElementById('snapshot').textContent = `📅 ${state.meta.gmv_period}`;
  document.getElementById('pool-info').textContent =
    `池总数 ${state.meta.pool_total}（B3 ${state.meta.n_b3} / B4 ${state.meta.n_b4}）`;
  document.getElementById('version').textContent = `${state.meta.version} · ${state.meta.generated_at}`;
}

// === Tab 1: 赛道清单 ===
function renderTracks() {
  const growthDiv = document.getElementById('growth-list');
  const declineDiv = document.getElementById('decline-list');

  growthDiv.innerHTML = state.categories.growth.map(c => trackCardHTML(c, 'growth')).join('') ||
    '<div class="hint">暂无环比 ≥+10% 的赛道</div>';

  declineDiv.innerHTML = state.categories.decline_horse.map(c => trackCardHTML(c, 'decline')).join('') ||
    '<div class="hint">暂无衰退中带黑马的赛道</div>';

  document.querySelectorAll('.track-card').forEach(card => {
    card.addEventListener('click', () => openTrackDetail(card.dataset.cat));
  });
}

function trackCardHTML(c, type) {
  const qoqClass = c.qoq >= 0 ? 'up' : 'down';
  const qoqStr = (Math.abs(c.qoq) > 500)
    ? (c.qoq >= 0 ? '↑ 异常(基数极小)' : '↓ 异常(基数极小)')
    : (c.qoq >= 0 ? '+' : '') + c.qoq.toFixed(1) + '%';
  const top20 = c.is_top20 ? '<span class="top20-badge">✨</span>' : '';
  const horseInfo = c.pool_horse > 0 ? `<b>${c.pool_horse}</b>个黑马 / ` : '';
  return `
  <div class="track-card" data-cat="${escHTML(c.cat)}">
    <div class="track-card-head">
      <span class="track-name">${top20}${escHTML(c.cat)}</span>
      <span class="track-qoq ${qoqClass}">${qoqStr}</span>
    </div>
    <div class="track-stats">
      <span>GMV <b>${c.gmv_2m.toFixed(0)}万</b></span>
      <span>池内商家 <b>${c.pool_total}</b></span>
      <span>${horseInfo}<b>${c.pool_s}</b>个 S 档</span>
      <span>CR5 <b>${c.cr5 ? c.cr5.toFixed(0) + '%' : '--'}</b></span>
    </div>
    <div class="track-recommend">💡 ${escHTML(c.recommend)}</div>
  </div>`;
}

function openTrackDetail(cat) {
  const c = state.categories.all.find(x => x.cat === cat);
  if (!c) return;
  const sellersInCat = state.sellers.filter(s => s.cat3 === cat);
  const topSellers = [...sellersInCat].sort((a, b) => b.gmv_30d - a.gmv_30d).slice(0, 12);

  const horseCount = sellersInCat.filter(s => s.quadrant.startsWith('⚡')).length;
  const sCount = sellersInCat.filter(s => s.grade === 'S').length;

  document.getElementById('track-detail-content').innerHTML = `
    <h2>${c.is_top20 ? '✨' : ''}${escHTML(c.cat)}</h2>
    <div style="color:#6b7280;font-size:12px;margin:6px 0 16px">${escHTML(c.recommend)}</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">
      <div style="background:#f1f5f9;padding:10px;border-radius:6px">
        <div style="font-size:11px;color:#6b7280">当期 GMV</div>
        <div style="font-size:18px;font-weight:600;color:#2563eb">${c.gmv_2m.toFixed(0)}万</div>
      </div>
      <div style="background:#f1f5f9;padding:10px;border-radius:6px">
        <div style="font-size:11px;color:#6b7280">环比</div>
        <div style="font-size:18px;font-weight:600;color:${c.qoq >= 0 ? '#dc2626' : '#16a34a'}">${Math.abs(c.qoq) > 500 ? (c.qoq >= 0 ? '↑ 异常' : '↓ 异常') : ((c.qoq >= 0 ? '+' : '') + c.qoq.toFixed(1) + '%')}</div>
      </div>
      <div style="background:#f1f5f9;padding:10px;border-radius:6px">
        <div style="font-size:11px;color:#6b7280">B3/B4 池</div>
        <div style="font-size:18px;font-weight:600">${c.pool_total}</div>
      </div>
      <div style="background:#f1f5f9;padding:10px;border-radius:6px">
        <div style="font-size:11px;color:#6b7280">黑马 / S 档</div>
        <div style="font-size:18px;font-weight:600">${horseCount} / ${sCount}</div>
      </div>
    </div>
    <h3 style="font-size:14px;margin-bottom:6px">Top GMV 商家（前 12）</h3>
    <table class="track-detail-table">
      <thead><tr><th>商家</th><th>AM</th><th>层</th><th>象限</th><th>档</th><th style="text-align:right">GMV(30d)</th></tr></thead>
      <tbody>
      ${topSellers.map(s => `
        <tr>
          <td><a href="${SHOP_SEARCH(s.name)}" target="_blank">${escHTML(s.name)} ↗</a>${s.gmv_near_b5 ? ' <span title="GMV ≥40万临界商家">⚠️</span>' : ''}</td>
          <td>${escHTML(s.am)}</td>
          <td>${s.layer}</td>
          <td><span class="sc-quadrant ${Q_CLASS[s.quadrant] || ''}">${s.quadrant}</span></td>
          <td><b>${s.grade}</b></td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtWan(s.gmv_30d)}</td>
        </tr>
      `).join('')}
      </tbody>
    </table>
  `;
  document.getElementById('track-detail').style.display = 'block';
}

function closeTrackDetail() {
  document.getElementById('track-detail').style.display = 'none';
}
window.closeTrackDetail = closeTrackDetail;

// === Tab 2: 商家 ===
function initSellersTab() {
  document.querySelectorAll('.grade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.grade-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentGrade = btn.dataset.grade;
      renderSellerCards();
    });
  });
  document.getElementById('cnt-s').textContent = state.meta.n_s;
  document.getElementById('cnt-a').textContent = state.meta.n_a;
  document.getElementById('cnt-b').textContent = state.meta.n_b;

  const amSel = document.getElementById('filter-am');
  state.meta.am_list.forEach(am => {
    amSel.innerHTML += `<option value="${escHTML(am)}">${escHTML(am)}</option>`;
  });
  const catSel = document.getElementById('filter-cat');
  state.meta.cat_list.forEach(c => {
    catSel.innerHTML += `<option value="${escHTML(c)}">${escHTML(c)}</option>`;
  });

  ['filter-am', 'filter-quadrant', 'filter-cat', 'filter-layer', 'filter-growth', 'filter-critical', 'filter-search', 'filter-important'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const ev = (id === 'filter-important') ? 'change' : 'input';
    el.addEventListener(ev, () => {
      state.filters.am = document.getElementById('filter-am').value;
      state.filters.quadrant = document.getElementById('filter-quadrant').value;
      state.filters.cat = document.getElementById('filter-cat').value;
      state.filters.layer = document.getElementById('filter-layer').value;
      state.filters.growth = document.getElementById('filter-growth').value;
      state.filters.critical = document.getElementById('filter-critical').value;
      state.filters.search = document.getElementById('filter-search').value.toLowerCase();
      state.filter_important = document.getElementById('filter-important').checked;
      renderSellerCards();
    });
  });
}

function renderSellerCards() {
  const f = state.filters;
  let list = state.sellers.filter(s => s.grade === state.currentGrade);
  if (f.am) list = list.filter(s => s.am === f.am);
  if (f.quadrant) list = list.filter(s => s.quadrant === f.quadrant);
  if (f.cat) list = list.filter(s => s.cat3 === f.cat);
  if (f.layer) list = list.filter(s => s.layer === f.layer);
  if (f.growth === '1') list = list.filter(s => s.in_growth_track === 1);
  else if (f.growth === 'top20') list = list.filter(s => s.in_top20_track === 1);
  if (f.critical === '1') list = list.filter(s => s.gmv_near_b5 === 1);
  else if (f.critical === '0') list = list.filter(s => s.gmv_near_b5 === 0);
  if (f.search) list = list.filter(s => s.name.toLowerCase().includes(f.search));
  if (state.filter_important) {
    list = list.filter(s => {
      const m = state.marks[s.sid];
      return m && m.is_important;
    });
  }

  // 排序：被标记重要的排前；其次按 combo 降序
  list.sort((a, b) => {
    const am = state.marks[a.sid] && state.marks[a.sid].is_important ? 1 : 0;
    const bm = state.marks[b.sid] && state.marks[b.sid].is_important ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.combo - a.combo;
  });
  const baseTotal = state.sellers.filter(s => s.grade === state.currentGrade).length;
  document.getElementById('filter-result-cnt').textContent = list.length;
  document.getElementById('filter-total-cnt').textContent = baseTotal;

  const LIMIT = state.currentGrade === 'S' ? 100 : (state.currentGrade === 'A' ? 80 : 60);
  const truncated = list.length > LIMIT;
  list = list.slice(0, LIMIT);

  const container = document.getElementById('seller-cards');
  container.innerHTML = list.map(sellerCardHTML).join('') ||
    '<div class="hint" style="padding:30px;text-align:center;grid-column:1/-1">无匹配商家</div>';

  if (truncated) {
    container.innerHTML += `<div style="grid-column:1/-1;text-align:center;padding:14px;color:#6b7280;font-size:12px">显示前 ${LIMIT} 个；缩小筛选范围可看完整。</div>`;
  }

  // 渲染 4 维雷达图
  const isMobile = window.innerWidth <= 768;
  list.forEach(s => {
    const el = document.getElementById(`radar-${s.sid}`);
    if (!el) return;
    const chart = echarts.init(el);
    chart.setOption({
      radar: {
        indicator: [
          { name: '🏗️底盘', max: 100 },
          { name: '🚀动能', max: 100 },
          { name: '🎬场域纯', max: 100 },
          { name: '🎬场域约束', max: 100 },
        ],
        radius: isMobile ? '62%' : '60%',
        center: ['50%', '52%'],
        splitNumber: isMobile ? 2 : 2,
        axisName: { color: '#475569', fontSize: isMobile ? 10 : 9 },
        splitArea: { areaStyle: { color: ['#fafafa', '#fff'] } },
        splitLine: { lineStyle: { color: '#e5e7eb' } },
      },
      series: [{
        type: 'radar',
        data: [{
          value: [s.fund, s.mom, s.field_pure, s.field_cons],
          symbol: 'circle',
          symbolSize: 4,
          areaStyle: { color: 'rgba(37,99,235,0.22)' },
          lineStyle: { color: '#2563eb', width: 2 },
          itemStyle: { color: '#2563eb' },
        }],
      }],
    });
  });
}

function sellerCardHTML(s) {
  const trackBadges = [];
  if (s.in_growth_track) trackBadges.push('<span class="sc-tag tag-growth">📈 增长赛道</span>');
  if (s.in_top20_track && !s.in_growth_track) trackBadges.push('<span class="sc-tag tag-top20">✨ Top20赛道</span>');
  const criticalIcon = s.gmv_near_b5
    ? `<span class="critical-icon" title="GMV ≥40万 临界商家：模型预测力较弱，建议结合常规跟进">⚠️</span>` : '';

  // —— 协作打标 UI ——
  const mark = state.marks[s.sid];
  const isMarked = !!(mark && mark.is_important);
  const note = (mark && mark.note) || '';
  const author = (mark && mark.author_name) || '';
  const updated = (mark && mark.updated_at) ? mark.updated_at.replace('T', ' ').slice(0, 16) : '';
  const tip = author
    ? `最后修改：${author} · ${updated}`
    : '点亮 ⭐ 标为重要';
  const offline = state.marksError ? ' mark-offline' : '';
  const markBtnDisabled = state.marksError ? ' disabled title="打标功能离线"' : ` title="${escHTML(tip)}"`;
  const noteBtnDisabled = state.marksError ? ' disabled' : '';
  const cardCls = `seller-card${isMarked ? ' is-marked' : ''}`;
  const notePreview = note
    ? `<div class="sc-note-line" title="${escHTML(author)} · ${escHTML(updated)}">📝 ${escHTML(note)}</div>`
    : '';

  return `
  <div class="${cardCls}" id="card-${s.sid}">
    <div class="sc-mark-bar${offline}">
      <button class="mark-btn star-btn ${isMarked ? 'on' : ''}"${markBtnDisabled} onclick="toggleImportant('${s.sid}')">
        ${isMarked ? '⭐ 重要' : '☆ 标重要'}
      </button>
      <button class="mark-btn note-btn"${noteBtnDisabled} onclick="openNoteEditor('${s.sid}')" title="${note ? '编辑备注' : '加备注'}">
        📝${note ? '<span class="dot-indicator"></span>' : ''}
      </button>
      ${author ? `<span class="mark-author" title="${escHTML(tip)}">· ${escHTML(author.split('(')[0])}</span>` : ''}
    </div>
    <div class="sc-head">
      <div class="sc-name-block">
        <h3 class="sc-name">
          <a href="${SHOP_SEARCH(s.name)}" target="_blank">${escHTML(s.name)} ↗</a>
          ${criticalIcon}
        </h3>
        <div class="sc-meta">
          <span class="am-tag">${escHTML(s.am)}</span>
          <span>${escHTML(s.cat3)}</span>
        </div>
      </div>
      <div class="sc-gmv">
        ${fmtWan(s.gmv_30d)}
        <div><span class="layer-pill">${s.layer}</span></div>
      </div>
    </div>
    <div class="sc-quad-line">
      <span class="sc-quadrant ${Q_CLASS[s.quadrant] || ''}">${s.quadrant}</span>
      <span class="combo-kpi" title="组合分 = 0.4×场域约束 + 0.6×动能">组合分 <b>${s.combo.toFixed(1)}</b></span>
    </div>
    <div id="radar-${s.sid}" class="sc-radar"></div>
    <div class="sc-signal">💡 ${escHTML(s.key_signal)}</div>
    ${notePreview}
    <div class="sc-tags">
      ${trackBadges.join('')}
      <a class="sc-tag tag-link" href="${CANGQIONG_LINK(s.sid)}" target="_blank">🔗 跳转苍穹</a>
    </div>
  </div>`;
}

// === Tab 3: 信号字典 + 模型说明 (V2 大改) ===
function renderDict() {
  const d = state.signalsDict;
  const container = document.getElementById('dict-content');
  let html = `
    <div class="dict-section">
      <h3>📅 数据快照</h3>
      <p style="color:#6b7280;font-size:12px">${escHTML(d.snapshot)}</p>
      <p style="color:#6b7280;font-size:12px">版本：${escHTML(d.version)}</p>
    </div>
  `;

  // V2 公式总览
  if (d.formula_overview) {
    const fo = d.formula_overview;
    html += `
    <div class="dict-section formula-overview">
      <h3>${escHTML(fo.title)}</h3>
      <div class="formula-tree">`;
    fo.components.forEach(c => {
      html += `
        <div class="formula-card">
          <div class="fc-name">${escHTML(c.name)}</div>
          <div class="fc-formula">${escHTML(c.formula)}</div>
          <div class="fc-purpose">🎯 ${escHTML(c.purpose)}</div>
          <div class="fc-why">💡 ${escHTML(c.why_design)}</div>
        </div>`;
    });
    html += `</div>`;
    if (fo.combo_formula) {
      html += `
        <div class="combo-formula-card">
          <div class="fc-name">${escHTML(fo.combo_formula.name)}</div>
          <div class="fc-formula" style="font-size:14px">${escHTML(fo.combo_formula.formula)}</div>
          <div class="fc-why">💡 ${escHTML(fo.combo_formula.why_design)}</div>
        </div>`;
    }
    html += `</div>`;
  }

  // 维度信号详情
  d.dimensions.forEach(dim => {
    html += `
    <div class="dict-section">
      <h3>${escHTML(dim.name)}</h3>
      <p style="color:#6b7280;font-size:12px;margin:4px 0">${escHTML(dim.purpose)}</p>
      <div class="formula">公式：${escHTML(dim.formula)}</div>
      <table>
        <thead><tr><th>信号</th><th>取数字段</th><th>阈值</th><th>说明</th></tr></thead>
        <tbody>
        ${dim.signals.map(s => `<tr>
          <td><b>${escHTML(s.name)}</b></td><td>${escHTML(s.field)}</td><td>${escHTML(s.threshold)}</td><td>${escHTML(s.note)}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  });

  // 四象限规则
  html += `
    <div class="dict-section">
      <h3>📐 四象限分类规则</h3>
      <p style="color:#6b7280;font-size:12px">坐标轴：${escHTML(d.quadrant_rules.axes)}</p>
      <p style="color:#6b7280;font-size:12px">阈值：${escHTML(d.quadrant_rules.thresholds)}</p>
      <div class="quadrant-grid">
        ${d.quadrant_rules.rules.map(r => `
          <div class="quad-card">
            <div class="qc-name">${escHTML(r.name)}</div>
            <div class="qc-rule">${escHTML(r.rule)}</div>
            <div class="qc-play">${escHTML(r.playbook)}</div>
          </div>
        `).join('')}
      </div>
    </div>`;

  // S/A/B 分级
  html += `
    <div class="dict-section">
      <h3>🎖️ S/A/B 分级规则 <span style="font-size:12px;color:#6b7280">(${escHTML(d.grade_rules.scheme || '')})</span></h3>
      <div class="grade-card-list">
        ${['S', 'A', 'B'].map(g => {
          const r = d.grade_rules[g];
          return `<div class="grade-card ${g.toLowerCase()}">
            <div class="gc-name">${g}</div>
            <div class="gc-count">${r.count} 商家</div>
            <div>
              <div class="gc-rule">${escHTML(r.rule)}</div>
              <div class="gc-aud">${escHTML(r.audience)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

  // GMV 临界商家说明
  if (d.gmv_near_b5_note) {
    const n = d.gmv_near_b5_note;
    html += `
    <div class="dict-section warning-section">
      <h3>${escHTML(n.title)}</h3>
      <p><b>定义：</b>${escHTML(n.what)}</p>
      <p><b>为什么标记：</b>${escHTML(n.why_flag)}</p>
      <p><b>UI 标识：</b>${escHTML(n.ui_marker)}</p>
    </div>`;
  }

  // 6 个月回测复验
  if (d.backtest_summary) {
    const b = d.backtest_summary;
    html += `
    <div class="dict-section backtest-section">
      <h3>${escHTML(b.title)}</h3>
      <p style="color:#6b7280;font-size:12px">${escHTML(b.method)}</p>
      <div class="backtest-headline">${escHTML(b.headline)}</div>

      <h4 style="margin-top:16px;font-size:14px">📊 主表（分组 × GMV 分层）</h4>
      <table class="backtest-table">
        <thead><tr><th>分组</th><th>n</th><th>跳档率</th><th>对照-同区间</th><th>净提升</th><th>p 值</th><th>显著</th></tr></thead>
        <tbody>
        ${b.key_rows.map(r => {
          const sig = r.p < 0.05 ? '✅' : (r.p < 0.1 ? '·' : '');
          const liftStr = r.lift_pct == null ? 'N/A' : (r.lift_pct >= 0 ? '+' : '') + r.lift_pct.toFixed(0) + '%';
          return `<tr>
            <td>${escHTML(r.label)}</td>
            <td>${r.n}</td>
            <td>${r.rate.toFixed(1)}%</td>
            <td>${r.ctl_rate.toFixed(1)}%</td>
            <td><b>${liftStr}</b></td>
            <td>${r.p.toFixed(4)}</td>
            <td>${sig}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>

      <h4 style="margin-top:16px;font-size:14px">🆚 V1 vs V2 对比</h4>
      <table class="backtest-table">
        <thead><tr><th>指标</th><th>V1</th><th>V2</th><th>V2 优劣</th></tr></thead>
        <tbody>
        ${b.v1_vs_v2.map(r => `<tr>
          <td>${escHTML(r['指标'])}</td>
          <td>${escHTML(r.V1)}</td>
          <td><b>${escHTML(r.V2)}</b></td>
          <td>${escHTML(r['V2 优劣'])}</td>
        </tr>`).join('')}
        </tbody>
      </table>

      <p style="margin-top:14px;color:#374151"><b>📝 解读：</b>${escHTML(b.interpretation)}</p>
    </div>`;
  }

  // 仅展示标签
  html += `
    <div class="dict-section">
      <h3>🏷️ 仅展示标签（不入打分）</h3>
      <p style="color:#6b7280;font-size:12px">${escHTML(d.no_score_note)}</p>
      <div class="sc-tags" style="margin-top:10px">
        ${d.no_score_tags.map(t => {
          let cls = 'sc-tag';
          if (t.startsWith('✨')) cls += ' tag-top20';
          else if (t === '📈 增长赛道') cls += ' tag-growth';
          else if (t === '📉 衰退赛道') cls += ' tag-decline';
          else if (t.includes('NPL')) cls += ' tag-npl';
          else if (t.includes('临界')) cls += ' tag-critical';
          return `<span class="${cls}">${escHTML(t)}</span>`;
        }).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

// === Boot ===
async function boot() {
  initTabs();
  const [meta, sellers, categories, signalsDict] = await Promise.all([
    fetchJson('data/meta.json'),
    fetchJson('data/sellers.json'),
    fetchJson('data/categories.json'),
    fetchJson('data/signals_dict.json'),
  ]);
  state.meta = meta;
  state.sellers = sellers;
  state.categories = categories;
  state.signalsDict = signalsDict;

  // 当前 AM 身份（localStorage）+ 顶栏切换按钮
  state.currentUser = getStoredUser();
  const badge = document.getElementById('current-am-badge');
  if (badge) {
    if (state.currentUser) badge.textContent = `👤 ${state.currentUser}`;
    badge.addEventListener('click', () => {
      try { localStorage.removeItem('b3b4_current_am'); } catch (_) {}
      state.currentUser = null;
      badge.textContent = '👤 未设置';
      ensureCurrentUser();
    });
  }

  // 先拉打标缓存（失败不阻塞主流程）
  await loadAllMarks();
  renderMarksErrorBanner();

  renderTopbar();
  renderTracks();
  initSellersTab();
  renderSellerCards();
  renderDict();
  refreshKPI();
}

// 顶部持久横幅：打标失败时显眼提示 + 重试
function renderMarksErrorBanner() {
  const existing = document.getElementById('marks-error-banner');
  if (existing) existing.remove();
  if (!state.marksError) return;
  const banner = document.createElement('div');
  banner.id = 'marks-error-banner';
  banner.className = 'marks-error-banner';
  banner.innerHTML = `
    <span class="meb-icon">⚠️</span>
    <span class="meb-text">
      <strong>协作打标功能离线</strong> · ${escHTML(state.marksError)}
      <span class="meb-hint">（仅影响 ⭐ 标重要 / 📝 备注，其他数据正常）</span>
    </span>
    <button class="meb-retry" id="meb-retry-btn">🔄 重试</button>
    <button class="meb-close" id="meb-close-btn" title="关闭">×</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);
  document.getElementById('meb-retry-btn').addEventListener('click', async () => {
    const btn = document.getElementById('meb-retry-btn');
    btn.textContent = '⏳ 重试中...';
    btn.disabled = true;
    await loadAllMarks();
    renderMarksErrorBanner();
    if (!state.marksError) {
      renderSellerCards();
      refreshKPI();
      showToast('✅ 打标功能已恢复', 'ok');
    }
  });
  document.getElementById('meb-close-btn').addEventListener('click', () => {
    banner.remove();
  });
}

boot().catch(err => {
  console.error(err);
  document.body.innerHTML += `<div style="background:#fee;color:#900;padding:20px;font-family:monospace">${err.message}</div>`;
});

// === 监听窗口 resize，重新调整所有 echarts 实例 ===
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    document.querySelectorAll('.sc-radar').forEach(el => {
      const inst = echarts.getInstanceByDom(el);
      if (inst) inst.resize();
    });
  }, 200);
});
