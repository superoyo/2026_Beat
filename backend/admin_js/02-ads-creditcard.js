// ============== v1.9.157 — Ads (ยอดใช้จ่ายค่าโฆษณา จาก Windsor) ==============
let _adsDays = 7;
let _adsFrom = '';          // v1.9.188 — ช่วงวันแบบกำหนดเอง (ปฏิทิน)
let _adsTo = '';
let _adsData = null;
let _adsSearch = '';
let _adsType = '__all__';   // v1.9.165 — filter ตาม ad type (objective)
let _benchData = null;      // v1.9.170 — cache benchmark (ใช้ใน slide-out จาก Report)
let _benchMode = 'brand';   // v1.9.176 — 'brand' | 'category'
let _audData = null;        // v1.9.180 — Audience Report (age breakdown)
let _audSearch = '';
let _audSort = {};          // v1.9.182 — sort ต่อตาราง { age:{col,dir}, placement:{...}, region:{...} }
let _campData = null;       // v1.9.198 — Ads Campaign (Google Sheet)
let _campObj = '__all__';
let _campBid = '__all__';   // v1.9.203 — filter ตามคนที่ทำหน้าที่ Bid
let _campFrom = '';
let _campTo = '';
let _campSearch = '';
let _campFiltered = [];
let _campView = 'gantt';    // v1.9.202 — 'gantt' | 'table'
let _campExpanded = new Set(); // v1.9.204 — project codes ที่ขยายใน Gantt
function _campSpan(ads) {
  let s = null, e = null;
  ads.forEach(a => { if (a.start && (!s || a.start < s)) s = a.start; if (a.end && (!e || a.end > e)) e = a.end; });
  return { start: s, end: e };
}
function _campBudgetNum(b) { const n = parseFloat(String(b || '').replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; }
function _campGroupProjects(list) {
  const map = new Map();
  list.forEach((c, idx) => {
    const code = (c.project_code || '').trim();
    const key = code || ('__none_' + idx);
    if (!map.has(key)) map.set(key, { key, code: code || '(ไม่มีรหัส)', name: c.project_name || '', ads: [], objMap: new Map() });
    const g = map.get(key);
    g.ads.push(c);
    if (!g.name && c.project_name) g.name = c.project_name;
    const ob = c.objective || '(ไม่ระบุ)';
    if (!g.objMap.has(ob)) g.objMap.set(ob, { objective: ob, ads: [] });
    g.objMap.get(ob).ads.push(c);
  });
  const res = [];
  map.forEach(g => {
    const sp = _campSpan(g.ads);
    const objectives = [];
    g.objMap.forEach(o => { const s = _campSpan(o.ads); objectives.push({ objective: o.objective, ads: o.ads, start: s.start, end: s.end }); });
    objectives.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    res.push({ key: g.key, code: g.code, name: g.name, ads: g.ads, objectives, start: sp.start, end: sp.end });
  });
  return res;
}
const _CAMP_OBJ_COLORS = {
  'Video Views': '#2563eb', 'Video Thruplay': '#0891b2', 'Reach': '#10b981',
  'Engagement': '#f59e0b', 'CPAS': '#8b5cf6', 'Conversions': '#ef4444',
  'Traffic': '#06b6d4', 'Awareness': '#ec4899', 'Message': '#14b8a6',
  'Page Like': '#a855f7', 'Lead Gen': '#f97316',
};
function _campObjColor(o) { return _CAMP_OBJ_COLORS[o] || '#64748b'; }
// v1.9.170 — แยก brand/adtype จากชื่อ campaign (มิเรอร์ logic backend benchmark)
const _BENCH_ADTYPES = ['Video Thruplay', 'Video Views', 'Page Likes', 'Page Like', 'CPAS', 'Reach', 'Engagement', 'Traffic', 'Awareness', 'Messages', 'Message', 'Conversions', 'Conversion', 'Purchases', 'Purchase', 'Leads', 'Lead'];
function _benchBrandOf(camp) {
  const i = (camp || '').indexOf(']');
  if (i < 0) return '(ไม่ระบุ)';
  const rest = camp.slice(i + 1).replace(/^[\s\-–—​ ]+/, '');
  const tok = (rest.split(/\s+/)[0] || '').replace(/^[.,:]+|[.,:]+$/g, '');
  return tok || '(ไม่ระบุ)';
}
function _benchAdTypeOf(camp) {
  const low = (camp || '').toLowerCase();
  for (const t of _BENCH_ADTYPES) if (low.includes(t.toLowerCase())) return t;
  return '(ไม่ระบุ)';
}
// v1.9.189 — benchmark avg CPM (brand × adtype) ของแคมเปญ — null ถ้าไม่มี/ยังไม่โหลด
function _benchAvgFor(campaign) {
  if (!_benchData || !_benchData.matrix) return null;
  const b = _benchBrandOf(campaign), t = _benchAdTypeOf(campaign);
  const cell = _benchData.matrix[b] && _benchData.matrix[b][t];
  return (cell && cell.avg != null) ? cell.avg : null;
}
// v1.9.190 — benchmark avg CPV (brand × adtype) ของแคมเปญ
function _benchCpvAvgFor(campaign) {
  if (!_benchData || !_benchData.matrix) return null;
  const b = _benchBrandOf(campaign), t = _benchAdTypeOf(campaign);
  const cell = _benchData.matrix[b] && _benchData.matrix[b][t];
  return (cell && cell.cpv && cell.cpv.avg != null) ? cell.cpv.avg : null;
}
const _ADS_OBJ = {
  OUTCOME_AWARENESS: 'Awareness', OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_SALES: 'Sales',
  OUTCOME_TRAFFIC: 'Traffic', OUTCOME_LEADS: 'Leads', OUTCOME_APP_PROMOTION: 'App Promotion',
  REACH: 'Reach', VIDEO_VIEWS: 'Video Views', LINK_CLICKS: 'Link Clicks', POST_ENGAGEMENT: 'Post Engagement',
};
function _adsTypeLabel(t) { return _ADS_OBJ[t] || t; }
// v1.9.166 — ad format (creative) labels — ใช้ใน filter
const _ADS_FMT = { image: '🖼️ ภาพนิ่ง', video: '🎬 วิดีโอ', carousel: '🎠 หลายภาพ', other: 'อื่น ๆ / ไม่ระบุ' };
const _ADS_FMT_ICON = { image: '🖼️', video: '🎬', carousel: '🎠', other: '' };
function _adsFmtLabel(f) { return _ADS_FMT[f] || f; }
function _adsAllTypes() {
  const set = new Set();
  (_adsData && _adsData.platforms || []).forEach(p => (p.accounts || []).forEach(a => (a.campaigns || []).forEach(c => { if (c.ad_format) set.add(c.ad_format); })));
  const order = ['image', 'video', 'carousel', 'other'];
  return order.filter(f => set.has(f)).concat([...set].filter(f => !order.includes(f)));
}
function _adsAgg(camps) {
  let spend = 0, impr = 0, clk = 0, reach = 0, views = 0, eng = 0;
  camps.forEach(c => { spend += c.spend || 0; impr += c.impressions || 0; clk += c.clicks || 0; reach += c.reach || 0; views += c.views || 0; eng += c.engagements || 0; });
  return {
    spend, impressions: impr, clicks: clk, reach, views, engagements: eng,
    ctr: impr ? +(clk / impr * 100).toFixed(2) : null,
    cpc: clk ? +(spend / clk).toFixed(2) : null,
    cpm: impr ? +(spend / impr * 1000).toFixed(2) : null,
    cpv: views ? +(spend / views).toFixed(4) : null,
    cpe: eng ? +(spend / eng).toFixed(4) : null,
    frequency: reach ? +(impr / reach).toFixed(2) : null,
  };
}
function _adsMoney4(n) { return (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }
const _ADS_SRC = {
  facebook:   { icon: '📘', label: 'Meta Ads' },
  meta:       { icon: '📘', label: 'Meta Ads' },
  tiktok:     { icon: '🎵', label: 'TikTok Ads' },
  twitter:    { icon: '𝕏',  label: 'X (Twitter) Ads' },
  google_ads: { icon: '🔍', label: 'Google Ads' },
  bing:       { icon: '🅱️', label: 'Microsoft Ads' },
  linkedin:   { icon: '💼', label: 'LinkedIn Ads' },
};
const _ADS_COLORS = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
function _adsSrcMeta(s) { return _ADS_SRC[s] || { icon: '📊', label: s }; }
function _adsMoney(n) { return (Number(n) || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _adsInt(n) { return (Number(n) || 0).toLocaleString('th-TH'); }
function _adsTotalTxt(byCur) {
  const keys = Object.keys(byCur || {});
  if (keys.length === 0) return '0.00';
  return keys.map(c => `${_adsMoney(byCur[c])} ${escapeHtml(c)}`).join(' · ');
}
function _adsMetricsLine(m) {
  const parts = [];
  if (m.impressions) parts.push(`👁 ${_adsInt(m.impressions)}`);
  if (m.reach) parts.push(`🙋 reach ${_adsInt(m.reach)}`);
  if (m.frequency != null) parts.push(`freq ${m.frequency}`);
  if (m.clicks) parts.push(`🖱 ${_adsInt(m.clicks)}`);
  if (m.ctr != null) parts.push(`CTR ${m.ctr}%`);
  if (m.cpc != null) parts.push(`CPC ${_adsMoney(m.cpc)}`);
  if (m.cpm != null) parts.push(`CPM ${_adsMoney(m.cpm)}`);
  return parts.join(' · ');
}
function _adsTrendSvg(trend) {
  const dates = (trend && trend.dates) || [];
  const sources = (trend && trend.sources) || [];
  if (dates.length < 2 || sources.length === 0) return '';
  let max = 0;
  sources.forEach(s => (trend.series[s] || []).forEach(v => { if (v > max) max = v; }));
  if (max <= 0) return '';
  const W = 760, H = 200, padL = 6, padR = 6, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB, n = dates.length;
  const x = i => padL + (i / (n - 1)) * innerW;
  const y = v => padT + innerH - (v / max) * innerH;
  const lines = sources.map((s, si) => {
    const col = _ADS_COLORS[si % _ADS_COLORS.length];
    const ser = trend.series[s] || [];
    const pts = ser.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const dots = ser.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="${col}"/>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>${dots}`;
  }).join('');
  const xl = dates.map((d, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" font-size="9" fill="#8895ab" text-anchor="middle">${escapeHtml(d.slice(5))}</text>`).join('');
  const legend = sources.map((s, si) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text-muted)"><span style="width:11px;height:11px;border-radius:3px;background:${_ADS_COLORS[si % _ADS_COLORS.length]}"></span>${escapeHtml(_adsSrcMeta(s).label)}</span>`).join('');
  return `
    <div class="card" style="display:block;margin-bottom:16px">
      <div style="font-size:13.5px;font-weight:700;margin-bottom:10px">📈 แนวโน้มค่าใช้จ่ายรายวัน</div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:200px;display:block">${lines}${xl}</svg>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">${legend}</div>
      <div style="font-size:10.5px;color:var(--text-soft);margin-top:5px">* แต่ละเส้นเป็นสกุลเงินของแพลตฟอร์มนั้น ๆ (สเกลตามยอดสูงสุด)</div>
    </div>`;
}
// v1.9.167 — Ads เป็น submenu: Report (เดิม) + Benchmark
function renderAdsSection(active) {
  return renderSubmenuPage({ title: '💰 Ads', active: active || 'ads', items: [
    { route: 'ads',           ico: '📊', label: 'Report',          render: () => renderAdsReport() },
    { route: 'ads-audience',  ico: '👥', label: 'Audience Report', render: () => renderAdsAudience() },
    { route: 'ads-campaigns', ico: '📋', label: 'Campaign',         render: () => renderAdsCampaigns() },
    { route: 'ads-benchmark', ico: '📈', label: 'Benchmark',       render: () => renderAdsBenchmark() },
  ]});
}
async function renderAdsReport() {
  const isCustom = !!(_adsFrom && _adsTo);
  const todayStr = new Date().toISOString().slice(0, 10);
  const inStyle = 'padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text)';
  _subMain().innerHTML = `
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <select id="ads-days" style="padding:8px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text);cursor:pointer">
        <option value="1">วันนี้</option>
        <option value="7">7 วันล่าสุด</option>
        <option value="14">14 วันล่าสุด</option>
        <option value="30">30 วันล่าสุด</option>
        <option value="custom">📅 กำหนดเอง…</option>
      </select>
      <span id="ads-range" style="display:${isCustom ? 'inline-flex' : 'none'};align-items:center;gap:6px">
        <input type="date" id="ads-from" max="${todayStr}" value="${escapeHtml(_adsFrom || todayStr)}" style="${inStyle}">
        <span style="color:var(--text-soft)">–</span>
        <input type="date" id="ads-to" max="${todayStr}" value="${escapeHtml(_adsTo || todayStr)}" style="${inStyle}">
        <button class="btn" id="ads-apply" style="font-size:13px;padding:7px 13px">ใช้</button>
      </span>
      <button class="btn" id="ads-refresh" style="font-size:13px;padding:8px 14px">🔄 รีเฟรช</button>
    </div>
    <div id="ads-body"><div class="empty">กำลังโหลด…</div></div>`;
  const sel = $('ads-days'), range = $('ads-range');
  if (sel) {
    sel.value = isCustom ? 'custom' : String(_adsDays);
    sel.onchange = () => {
      if (sel.value === 'custom') { if (range) range.style.display = 'inline-flex'; return; }
      if (range) range.style.display = 'none';
      _adsFrom = ''; _adsTo = ''; _adsDays = parseInt(sel.value, 10) || 7;
      _adsSearch = ''; _adsType = '__all__'; loadAdsSpend();
    };
  }
  const apply = $('ads-apply');
  if (apply) apply.onclick = () => {
    const f = $('ads-from'), t = $('ads-to');
    if (!f || !t || !f.value || !t.value) { alert('เลือกวันเริ่มและวันสิ้นสุด'); return; }
    _adsFrom = f.value > t.value ? t.value : f.value;
    _adsTo = f.value > t.value ? f.value : t.value;
    _adsSearch = ''; _adsType = '__all__'; loadAdsSpend();
  };
  const rb = $('ads-refresh');
  if (rb) rb.onclick = () => loadAdsSpend();
  loadAdsSpend();
}
// ===== Audience Report (ใช้จ่ายแยกตามกลุ่มอายุ → breakdown แคมเปญ) =====
async function renderAdsAudience() {
  _subMain().innerHTML = `
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <select id="aud-days" style="padding:8px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text);cursor:pointer">
        <option value="7">7 วันล่าสุด</option>
        <option value="14">14 วันล่าสุด</option>
        <option value="30">30 วันล่าสุด</option>
      </select>
      <button class="btn" id="aud-refresh" style="font-size:13px;padding:8px 14px">🔄 รีเฟรช</button>
    </div>
    <div id="aud-body"><div class="empty">กำลังโหลด…</div></div>`;
  const sel = $('aud-days');
  if (sel) { sel.value = String(_adsDays); sel.onchange = () => { _adsDays = parseInt(sel.value, 10) || 7; _audSearch = ''; loadAudience(); }; }
  const rb = $('aud-refresh');
  if (rb) rb.onclick = () => loadAudience();
  loadAudience();
}
async function loadAudience() {
  const body = $('aud-body');
  if (!body) return;
  body.innerHTML = '<div class="empty">⏳ กำลังดึงข้อมูลจาก Windsor… (เฉพาะ Meta · อาจช้าสักครู่)</div>';
  try { _audData = await fetchJson(`/api/ads-audience?days=${_adsDays}`); }
  catch (e) {
    const msg = e.message || '';
    if (/WINDSOR_API_KEY/.test(msg)) {
      body.innerHTML = `<div class="card" style="display:block;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.06)">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">⚙️ ยังไม่ได้ตั้งค่า Windsor API</div>
        <div style="font-size:13.5px;color:var(--text-muted);line-height:1.7">ต้องตั้งค่า <code style="background:var(--bg-soft);padding:1px 6px;border-radius:5px;font-family:ui-monospace,Menlo,monospace">WINDSOR_API_KEY</code> บน Railway ก่อน</div></div>`;
      return;
    }
    body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(msg)}</div>`;
    return;
  }
  renderAudienceBody();
}
// v1.9.181 — 3 ตาราง: Demographic (age) / Placement / Region
const _AUD_TABLES = [
  { key: 'age',       title: 'Demographic — กลุ่มอายุ', icon: '👤', col: 'กลุ่มอายุ', pretty: s => s },
  { key: 'placement', title: 'Placement',               icon: '📍', col: 'Placement', pretty: s => (s || '').replace(/_/g, ' ') },
  { key: 'region',    title: 'Region',                  icon: '🗺️', col: 'ภูมิภาค',  pretty: s => s },
];
// v1.9.184 — คอลัมน์ตาราง Audience (ลำดับ: CPM · CPV · CPE · Spend · …) — group ใช้ x.oneCur, campaign ใช้ค่าตรง
const _AUD_COLS = [
  { k: 'cpm', l: 'CPM', bold: true, cell: (m, x) => (x.isGroup && !x.oneCur) ? _adsDash() : (m.cpm != null ? _adsMoney(m.cpm) : _adsDash()) },
  { k: 'cpv', l: 'CPV', cell: (m, x) => (x.isGroup && !x.oneCur) ? _adsDash() : (m.cpv != null ? _adsMoney4(m.cpv) : _adsDash()) },
  { k: 'cpe', l: 'CPE', cell: (m, x) => (x.isGroup && !x.oneCur) ? _adsDash() : (m.cpe != null ? _adsMoney4(m.cpe) : _adsDash()) },
  { k: 'spend', l: 'Spend', cell: (m, x) => x.isGroup ? _adsTotalTxt(x.byCur) : (m.spend != null ? `${_adsMoney(m.spend)} <span style="color:var(--text-soft);font-size:10px;font-weight:400">${escapeHtml(x.currency || '')}</span>` : _adsDash()) },
  { k: 'impressions', l: 'Impr.', cell: m => m.impressions ? _adsInt(m.impressions) : _adsDash() },
  { k: 'reach', l: 'Reach', cell: m => m.reach ? _adsInt(m.reach) : _adsDash() },
  { k: 'frequency', l: 'Freq.', cell: m => m.frequency != null ? m.frequency : _adsDash() },
  { k: 'clicks', l: 'Clicks', cell: m => m.clicks ? _adsInt(m.clicks) : _adsDash() },
  { k: 'ctr', l: 'CTR', cell: m => m.ctr != null ? m.ctr + '%' : _adsDash() },
  { k: 'cpc', l: 'CPC', cell: (m, x) => (x.isGroup && !x.oneCur) ? _adsDash() : (m.cpc != null ? _adsMoney(m.cpc) : _adsDash()) },
];
function renderAudienceBody() {
  const body = $('aud-body');
  if (!body || !_audData) return;
  const tables = _audData.tables || {};
  const dateRange = `${escapeHtml(_audData.date_from)} → ${escapeHtml(_audData.date_to)}`;
  const anyRows = _AUD_TABLES.some(t => tables[t.key] && (tables[t.key].rows || []).length);
  if (!anyRows) {
    body.innerHTML = `<div class="empty" style="padding:30px;text-align:center">— ไม่มีข้อมูลในช่วง ${dateRange} (breakdown มีเฉพาะ Meta) —</div>`;
    return;
  }
  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div style="font-size:12.5px;color:var(--text-muted)">📅 ${dateRange} · 👥 Audience (Meta) · รวม <strong style="color:var(--primary)">${_adsTotalTxt(_audData.total_by_cur)}</strong></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="aud-search" type="text" value="${escapeHtml(_audSearch)}" placeholder="🔍 ค้นหาแคมเปญ..." autocomplete="off"
               style="padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text);min-width:200px" />
        <button class="btn" id="aud-export" style="font-size:13px;padding:8px 14px">⬇ CSV</button>
      </div>
    </div>
    <div id="aud-cards"></div>`;
  const si = $('aud-search');
  if (si) { let _t; si.addEventListener('input', e => { clearTimeout(_t); const v = e.target.value; _t = setTimeout(() => { _audSearch = v; renderAudienceCards(); }, 220); }); }
  const ex = $('aud-export');
  if (ex) ex.onclick = exportAudienceCsv;
  renderAudienceCards();
}
function renderAudienceCards() {
  const wrap = $('aud-cards');
  if (!wrap || !_audData) return;
  const q = _audSearch.trim().toLowerCase();
  const tables = _audData.tables || {};
  const html = _AUD_TABLES.map(c => _audTableHtml(tables[c.key], c, q)).join('');
  wrap.innerHTML = html || '<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">— ไม่พบแคมเปญที่ตรงกับคำค้น —</div>';
  wrap.querySelectorAll('table.ads-table').forEach(tbl => {
    tbl.querySelectorAll('.aud-grp-row').forEach(row => {
      row.addEventListener('click', () => {
        const gi = row.dataset.grp;
        const caret = row.querySelector('.aud-caret');
        const subs = tbl.querySelectorAll(`.aud-sub-row[data-grp-of="${gi}"]`);
        const isOpen = subs.length && subs[0].style.display !== 'none';
        subs.forEach(s => { s.style.display = isOpen ? 'none' : ''; });
        if (caret) caret.style.transform = isOpen ? '' : 'rotate(90deg)';
      });
    });
  });
  // คลิกหัวคอลัมน์ → จัดเรียงตาราง (สลับ asc/desc)
  wrap.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const tbl = th.dataset.tbl, col = th.dataset.sort, cur = _audSort[tbl];
      _audSort[tbl] = { col, dir: (cur && cur.col === col) ? (cur.dir === 'asc' ? 'desc' : 'asc') : (col === 'label' ? 'asc' : 'desc') };
      renderAudienceCards();
    });
  });
  // ปุ่มดูการกระจายท้ายแถวกลุ่มอายุ (เฉพาะตาราง Demographic)
  wrap.querySelectorAll('.aud-dist-row').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openDemoDistPanel(btn.dataset.distAge); });
  });
}
function _audTableHtml(table, c, q) {
  if (!table) return '';
  const filtering = q !== '';
  const grpRows = (table.rows || []).map((g, gi) => {
    const camps = (g.campaigns || []).filter(cp => !q || (cp.campaign || '').toLowerCase().includes(q));
    if (camps.length === 0) return null;
    const byCur = {};
    camps.forEach(cp => { byCur[cp.currency] = (byCur[cp.currency] || 0) + (cp.spend || 0); });
    return { label: g.label, camps, byCur, agg: _adsAgg(camps), oneCur: Object.keys(byCur).length === 1, open: filtering, gi };
  }).filter(Boolean);
  if (grpRows.length === 0) return '';   // ตารางนี้ไม่มี match → ซ่อน
  // ---- จัดเรียงตามคอลัมน์ที่คลิก (ถ้ายังไม่คลิก = ลำดับจาก backend) ----
  const sort = _audSort[c.key];
  const _sv = {
    label: g => g.label,
    spend: g => Object.values(g.byCur).reduce((s, v) => s + v, 0),
    cpm: g => g.agg.cpm, cpv: g => g.agg.cpv, cpe: g => g.agg.cpe,
    impressions: g => g.agg.impressions, reach: g => g.agg.reach,
    frequency: g => g.agg.frequency, clicks: g => g.agg.clicks, ctr: g => g.agg.ctr, cpc: g => g.agg.cpc,
  };
  if (sort && _sv[sort.col]) {
    const dir = sort.dir === 'asc' ? 1 : -1, get = _sv[sort.col];
    grpRows.sort((a, b) => {
      if (sort.col === 'label') return dir * String(c.pretty(get(a))).localeCompare(String(c.pretty(get(b))), 'th', { numeric: true });
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;   // null ไปท้ายเสมอ
      if (vb == null) return -1;
      return dir * (va - vb);
    });
  }
  const thBtn = (k, l, align) => {
    const on = sort && sort.col === k;
    const ind = on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th data-sort="${k}" data-tbl="${escapeHtml(c.key)}" style="text-align:${align};cursor:pointer;user-select:none;white-space:nowrap;${on ? 'color:var(--primary)' : ''}" title="คลิกเพื่อจัดเรียง">${escapeHtml(l)}${ind}</th>`;
  };
  const hasDist = c.key === 'age';   // ปุ่มดูการกระจาย เฉพาะตาราง Demographic
  const thead = `<thead><tr>${thBtn('label', c.col, 'left')}${_AUD_COLS.map(col => thBtn(col.k, col.l, 'right')).join('')}${hasDist ? '<th style="text-align:center;width:46px">📊</th>' : ''}</tr></thead>`;
  const cellTd = (col, m, x) => `<td class="tnum"${col.bold ? ' style="font-weight:600"' : ''}>${col.cell(m, x)}</td>`;
  const distBtnTd = g => `<td style="text-align:center"><button class="aud-dist-row" data-dist-age="${escapeHtml(g.label)}" title="ดูการกระจาย CPM/CPV/CPE ของกลุ่มนี้" style="border:1px solid var(--border);background:var(--bg-card);border-radius:7px;cursor:pointer;font-size:12px;padding:3px 8px;line-height:1">📊</button></td>`;
  const rowsHtml = grpRows.map(g => {
    const gx = { isGroup: true, oneCur: g.oneCur, byCur: g.byCur };
    const grpRow = `
      <tr class="aud-grp-row" data-grp="${g.gi}" style="cursor:pointer">
        <td><span style="display:inline-flex;align-items:center;gap:7px;max-width:340px">
          <span class="aud-caret" style="font-size:9px;color:var(--text-soft);transition:transform .15s;transform:${g.open ? 'rotate(90deg)' : ''}">▶</span>
          <span style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(c.pretty(g.label))}">${escapeHtml(c.pretty(g.label))}</span>
          <span style="font-size:10.5px;color:var(--text-soft);white-space:nowrap">· ${g.camps.length}</span>
        </span></td>
        ${_AUD_COLS.map(col => cellTd(col, g.agg, gx)).join('')}${hasDist ? distBtnTd(g) : ''}
      </tr>`;
    const subRows = g.camps.map(cp => {
      const cx = { isGroup: false, currency: cp.currency };
      return `
      <tr class="aud-sub-row" data-grp-of="${g.gi}" style="display:${g.open ? '' : 'none'}">
        <td style="padding-left:32px;max-width:420px"><span style="color:var(--text-muted);display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;vertical-align:bottom" title="${escapeHtml(cp.campaign)}">${escapeHtml(cp.campaign)}</span></td>
        ${_AUD_COLS.map(col => cellTd(col, cp, cx)).join('')}${hasDist ? '<td></td>' : ''}
      </tr>`;
    }).join('');
    return grpRow + subRows;
  }).join('');
  const gByCur = {};
  grpRows.forEach(g => Object.entries(g.byCur).forEach(([k, v]) => { gByCur[k] = (gByCur[k] || 0) + v; }));
  const gAgg = _adsAgg(grpRows.flatMap(g => g.camps));
  const gOne = Object.keys(gByCur).length === 1;
  const totRow = `<tr class="ads-tot-row"><td>รวม</td>${_AUD_COLS.map(col => cellTd(col, gAgg, { isGroup: true, oneCur: gOne, byCur: gByCur })).join('')}${hasDist ? '<td></td>' : ''}</tr>`;
  const note = (table.truncated && !filtering) ? `<div style="font-size:10.5px;color:var(--text-soft);padding:8px 16px;border-top:1px solid var(--border)">* แสดง top ${table.shown} จาก ${table.total} (เรียงตาม spend)</div>` : '';
  const errNote = table.err ? `<div style="font-size:10.5px;color:#dc2626;padding:8px 16px;border-top:1px solid var(--border)">⚠️ ดึงไม่สำเร็จ: ${escapeHtml(String(table.err).slice(0, 80))}</div>` : '';
  return `
    <div class="card" style="display:block;margin-bottom:16px;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:13px 16px;background:var(--bg-soft);border-bottom:1px solid var(--border)">
        <div style="font-size:15px;font-weight:700">${c.icon} ${escapeHtml(c.title)} <span style="font-size:12px;color:var(--text-muted);font-weight:500">· ${grpRows.length} รายการ</span></div>
        <div style="font-size:15px;font-weight:800;color:var(--primary)">${_adsTotalTxt(gByCur)}</div>
      </div>
      <div style="overflow-x:auto">
        <table class="ads-table">${thead}<tbody>${rowsHtml}${totRow}</tbody></table>
      </div>
      ${note}${errNote}
    </div>`;
}
function exportAudienceCsv() {
  if (!_audData || !_audData.tables) return;
  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const nz = v => (v == null ? '' : v);
  const lines = [['Breakdown', 'Value', 'Campaign', 'Spend', 'Currency', 'Impressions', 'Reach', 'Frequency', 'Clicks', 'CTR(%)', 'CPC', 'CPM', 'Views', 'CPV', 'Engagements', 'CPE'].join(',')];
  _AUD_TABLES.forEach(cfg => {
    const t = _audData.tables[cfg.key];
    if (!t) return;
    (t.rows || []).forEach(g => {
      (g.campaigns || []).forEach(c => {
        lines.push([cfg.title, cfg.pretty(g.label), c.campaign, c.spend, c.currency, c.impressions, c.reach, nz(c.frequency), c.clicks, nz(c.ctr), nz(c.cpc), nz(c.cpm), nz(c.views), nz(c.cpv), nz(c.engagements), nz(c.cpe)].map(esc).join(','));
      });
    });
  });
  const csv = '﻿' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ads-audience_${_audData.date_from}_${_audData.date_to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// v1.9.185 — กราฟ histogram + เส้นโค้งปกติ (ระฆัง) + สถิติ min/max/mean/median/mode
function _distChart(values, fmt, weighted) {
  const vals = (values || []).filter(v => v != null && isFinite(v));
  if (vals.length < 3) return `<div class="empty" style="padding:18px;font-size:12px;text-align:center">— ข้อมูลไม่พอสำหรับกราฟ (${vals.length} จุด) —</div>`;
  const a = vals.slice().sort((x, y) => x - y), n = a.length;
  const min = a[0], max = a[n - 1], range = (max - min) || 1;
  const mean = vals.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n);
  const NB = Math.min(22, Math.max(8, Math.round(Math.sqrt(n))));
  const bw = range / NB;
  const bins = new Array(NB).fill(0);
  vals.forEach(v => { let i = Math.floor((v - min) / range * NB); if (i >= NB) i = NB - 1; if (i < 0) i = 0; bins[i]++; });
  const maxCount = Math.max(...bins) || 1;
  const modeBin = bins.indexOf(Math.max(...bins));
  const mode = min + (modeBin + 0.5) * bw;
  const W = 330, H = 152, padL = 8, padR = 8, padT = 12, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const X = v => padL + (v - min) / range * innerW;
  const barW = innerW / NB;
  const bars = bins.map((cnt, i) => {
    const bh = (cnt / maxCount) * innerH;
    return `<rect x="${(padL + i * barW + 0.5).toFixed(1)}" y="${(padT + innerH - bh).toFixed(1)}" width="${Math.max(0.5, barW - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--primary)" opacity="0.16" rx="1"/>`;
  }).join('');
  let curve = '';
  if (std > 0) {
    const pts = [];
    for (let s = 0; s <= 64; s++) {
      const v = min + range * s / 64;
      const pdf = Math.exp(-((v - mean) * (v - mean)) / (2 * std * std));
      pts.push(`${X(v).toFixed(1)},${(padT + innerH - pdf * innerH).toFixed(1)}`);
    }
    curve = `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--primary)" stroke-width="2"/>`;
  }
  const vline = (v, col) => `<line x1="${X(v).toFixed(1)}" y1="${padT}" x2="${X(v).toFixed(1)}" y2="${padT + innerH}" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
  const axis = `<line x1="${padL}" y1="${padT + innerH}" x2="${W - padR}" y2="${padT + innerH}" stroke="var(--border)" stroke-width="1"/>
    <text x="${padL}" y="${H - 6}" font-size="9" fill="#8895ab">${fmt(min)}</text>
    <text x="${W - padR}" y="${H - 6}" font-size="9" fill="#8895ab" text-anchor="end">${fmt(max)}</text>`;
  // เส้น "ค่าในตาราง (ถ่วงน้ำหนัก)" — สีหลัก เส้นทึบ (clamp ไว้ในกรอบกราฟ)
  const hasW = (weighted != null && isFinite(weighted));
  const wClamp = hasW ? Math.max(min, Math.min(max, weighted)) : null;
  const wLine = hasW ? `<line x1="${X(wClamp).toFixed(1)}" y1="${padT}" x2="${X(wClamp).toFixed(1)}" y2="${padT + innerH}" stroke="var(--primary)" stroke-width="2.4"/>` : '';
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:152px;display:block">${bars}${curve}${vline(mean, '#ef4444')}${vline(median, '#10b981')}${wLine}${axis}</svg>`;
  const stat = (lbl, val, col) => `<div style="text-align:center"><div style="font-size:8.5px;color:var(--text-soft);text-transform:uppercase;letter-spacing:.3px">${lbl}</div><div style="font-size:12px;font-weight:700${col ? `;color:${col}` : ''}">${fmt(val)}</div></div>`;
  const stats = `
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:5px;margin-top:8px">
      ${stat('Min', min)}${stat('Max', max)}${stat('Mean', mean, '#ef4444')}${stat('Median', median, '#10b981')}${stat('Mode', mode)}${hasW ? stat('ตาราง', weighted, 'var(--primary)') : '<div></div>'}
    </div>
    <div style="display:flex;gap:13px;justify-content:center;flex-wrap:wrap;margin-top:7px;font-size:9.5px;color:var(--text-soft)">
      ${hasW ? '<span><span style="color:var(--primary);font-weight:700">▬</span> ค่าในตาราง (ถ่วงน้ำหนัก)</span>' : ''}
      <span><span style="color:#ef4444;font-weight:700">┊</span> mean (เฉลี่ยอย่างง่าย)</span><span><span style="color:#10b981;font-weight:700">┊</span> median</span><span>n = ${n}</span>
    </div>`;
  return svg + stats;
}
function openDemoDistPanel(ageLabel) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const rows = (_audData && _audData.tables && _audData.tables.age && _audData.tables.age.rows) || [];
  const grp = rows.find(r => String(r.label) === String(ageLabel));
  const camps = (grp && grp.campaigns) || [];
  const vals = { cpm: [], cpv: [], cpe: [] };
  camps.forEach(c => {
    if (c.cpm != null) vals.cpm.push(c.cpm);
    if (c.cpv != null) vals.cpv.push(c.cpv);
    if (c.cpe != null) vals.cpe.push(c.cpe);
  });
  const section = (title, sub, arr, fmt, weighted) => `
    <div style="margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <div style="font-size:13.5px;font-weight:700">${title} <span style="font-size:11px;color:var(--text-soft);font-weight:500">· ${arr.length} แคมเปญ</span></div>
        <div style="font-size:11px;color:var(--text-soft);white-space:nowrap">ในตาราง <b style="color:var(--primary);font-size:13px">${weighted != null ? fmt(weighted) : '—'}</b></div>
      </div>
      <div style="font-size:11px;color:var(--text-soft);margin-bottom:8px">${sub}</div>
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px 12px 14px">${_distChart(arr, fmt, weighted)}</div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:440px">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 22px 28px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">📊 การกระจายตัว (Distribution)</div>
        <div style="font-size:16px;font-weight:800;margin:3px 0 4px">กลุ่มอายุ ${escapeHtml(String(ageLabel || '—'))}</div>
        <div style="font-size:11.5px;color:var(--text-soft);margin-bottom:10px">การกระจายของค่าจาก ${camps.length} แคมเปญในกลุ่มอายุนี้ · เส้นโค้ง = การกระจายแบบปกติ (fit ด้วย mean/SD)</div>
        <div style="font-size:11px;color:var(--text-muted);background:var(--bg-soft);border:1px solid var(--border);border-radius:9px;padding:9px 11px;line-height:1.6;margin-bottom:18px">
          💡 <b>"ค่าในตาราง"</b> เป็นค่า<b>ถ่วงน้ำหนัก</b>ด้วยปริมาณ (ค่าใช้จ่ายรวม ÷ impression/view/engagement รวม) — แคมเปญที่ยอดเยอะมีน้ำหนักมากกว่า จึงมัก<b>ต่าง</b>จาก <b>mean</b> (เฉลี่ยอย่างง่าย ที่ทุกแคมเปญน้ำหนักเท่ากัน) ในกราฟ
        </div>
        ${section('CPM', 'Cost per 1,000 impressions', vals.cpm, _adsMoney, grp && grp.cpm)}
        ${section('CPV', 'Cost per video view', vals.cpv, _adsMoney4, grp && grp.cpv)}
        ${section('CPE', 'Cost per engagement', vals.cpe, _adsMoney4, grp && grp.cpe)}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
}
// ===== TV Ad Monitor (embed iframe ผ่าน Beat SSO) =====
function renderTvSection(active) {
  return renderSubmenuPage({ title: '📺 TV', active: active || 'tv-scheduling', items: [
    { route: 'tv-scheduling', ico: '🗓️', label: 'Scheduling', render: () => renderTvScheduling() },
  ]});
}
async function renderTvScheduling() {
  const root = _subMain();
  if (!root) return;
  root.innerHTML = '<div class="empty">กำลังเชื่อมต่อ TV Monitor…</div>';
  let cfg, tok;
  try {
    cfg = await fetchJson('/api/tv-config');
    tok = (await fetchJson('/api/sso/embed-token?client_id=' + encodeURIComponent(cfg.client_id))).id_token;
  } catch (e) {
    const need404 = /404/.test(e.message || '');
    root.innerHTML = `<div class="empty" style="padding:24px;text-align:center;line-height:1.7">เชื่อม TV Monitor ไม่สำเร็จ: ${escapeHtml(e.message || '')}${need404 ? '<br><span style="font-size:12px;color:var(--text-soft)">ต้องสร้าง SSO client ใน Setting › SSO ให้ client_id ตรงกับ TV_MONITOR_CLIENT_ID ก่อน</span>' : ''}</div>`;
    return;
  }
  const src = `${cfg.base}/spotmon?embed=1&beat_token=${encodeURIComponent(tok)}`;
  const popUrl = `${cfg.base}/spotmon?beat_token=${encodeURIComponent(tok)}`;
  const mixed = cfg.base.startsWith('http://') && location.protocol === 'https:';
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text-soft)">📺 TV Ad Monitor · ${escapeHtml(cfg.base)}</span>
      <button class="btn" id="tvOpenNew" title="เปิด TV Monitor แบบเต็มหน้าต่าง (auto-login · ไม่ติดปัญหา cookie ใน iframe)">🔗 เปิดในหน้าต่างใหม่ ↗</button>
    </div>
    ${mixed ? `<div style="font-size:11.5px;color:#b45309;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:9px;padding:9px 12px;margin-bottom:10px">⚠️ TV Monitor base เป็น <code>http://</code> แต่หน้านี้ <code>https://</code> — ถ้า iframe ไม่ขึ้น/cookie ไม่ติด ให้กด “เปิดในหน้าต่างใหม่” หรือตั้ง <code>TV_MONITOR_BASE_URL</code> เป็น https · base: ${escapeHtml(cfg.base)}</div>` : ''}
    <iframe src="${escapeHtml(src)}" title="TV Spot Monitoring" referrerpolicy="no-referrer" allow="fullscreen"
            style="width:100%;height:calc(100vh - 230px);min-height:480px;border:1px solid var(--border);border-radius:12px;background:#fff;display:block"></iframe>`;
  const btn = document.getElementById('tvOpenNew');
  if (btn) btn.onclick = () => window.open(popUrl, '_blank', 'noopener,noreferrer');
}
// ===== Credit Card reconciliation (Platform tab) — v1.9.218 =====
let _ccState = { view: 'bills', billId: null, bills: [], selInvoice: null, summaryBillId: null };
const _CC_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
function _ccMoney(n){ if(n==null||isNaN(n))return '—'; return Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function _ccMonthLabel(m,y){ const mm=(m>=1&&m<=12)?_CC_MONTHS[m-1]:'—'; return `${mm} ${y||'—'}`; }
function _ccMonthSelect(id,sel){ return `<select id="${id}" style="width:100%"><option value="">—</option>${_CC_MONTHS.map((m,i)=>`<option value="${i+1}" ${sel===i+1?'selected':''}>${m}</option>`).join('')}</select>`; }
function _ccMonthSelectCls(cls,sel){ return `<select class="${cls}" style="width:100%"><option value="">—</option>${_CC_MONTHS.map((m,i)=>`<option value="${i+1}" ${sel===i+1?'selected':''}>${m}</option>`).join('')}</select>`; }
// v1.9.224 — ผู้อัพโหลด/เจ้าของเอกสาร (profile)
let _ccMembers=[];
async function _ccLoadMembers(){ try{ _ccMembers=(await fetchJson('/api/creditcard/members')).members||[]; }catch(e){ _ccMembers=[]; } }
// ผู้อัพโหลด/เจ้าของเอกสาร: ใช้ searchable member picker (รูป+ชื่อ) — _memberPickerHtml/_initMemberPicker (v1.9.137)
function _ccUploaderChip(inv,px){
  px=px||15; const fs=Math.round(px*0.6), va='-'+Math.round(px*0.2)+'px';
  const m=_ccMembers.find(x=>x.id===inv.uploaded_by_id);
  const name=(m&&m.name)||inv.uploaded_by||'—';
  const av=(m&&m.avatar)
    ? `<img src="${m.avatar}" style="width:${px}px;height:${px}px;border-radius:50%;object-fit:cover;vertical-align:${va}" />`
    : `<span style="display:inline-flex;width:${px}px;height:${px}px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:${fs}px;align-items:center;justify-content:center;vertical-align:${va}">${escapeHtml((String(name).trim().charAt(0)||'?').toUpperCase())}</span>`;
  return `${av} ${escapeHtml(name)}`;
}
function _ccFileToDataUrl(file){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(new Error('อ่านไฟล์ไม่ได้')); r.readAsDataURL(file); }); }
function _ccDownscale(dataUrl,maxW){ return new Promise((res)=>{ const img=new Image(); img.onload=()=>{ const scale=Math.min(1,maxW/img.width); if(scale>=1){ res(dataUrl); return; } const c=document.createElement('canvas'); c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale); c.getContext('2d').drawImage(img,0,0,c.width,c.height); try{ res(c.toDataURL('image/jpeg',0.82)); }catch(_){ res(dataUrl); } }; img.onerror=()=>res(dataUrl); img.src=dataUrl; }); }

// ---- pdf.js lazy loader ----
let _pdfjsLoading = null;
function ensurePdfJs(){
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsLoading) return _pdfjsLoading;
  _pdfjsLoading = new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload=()=>{ try{ window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; }catch(_){} resolve(window.pdfjsLib); };
    s.onerror=()=>{ _pdfjsLoading=null; reject(new Error('โหลด pdf.js ไม่สำเร็จ (เช็คอินเทอร์เน็ต)')); };
    document.head.appendChild(s);
  });
  return _pdfjsLoading;
}
async function _ccPdfToText(arrayBuffer, onProgress){
  const pdfjs = await ensurePdfJs();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  let text='';
  const maxPages=Math.min(pdf.numPages,6);
  for (let p=1;p<=maxPages;p++){
    const page=await pdf.getPage(p);
    const tc=await page.getTextContent();
    text += tc.items.map(it=>it.str).join(' ') + '\n';
    onProgress && onProgress(p,maxPages);
  }
  if (text.replace(/\s/g,'').length < 25){   // PDF สแกน (ไม่มี text layer) → OCR หน้าแรก
    onProgress && onProgress(0,1);
    const page=await pdf.getPage(1);
    const viewport=page.getViewport({scale:2});
    const canvas=document.createElement('canvas');
    canvas.width=viewport.width; canvas.height=viewport.height;
    await page.render({ canvasContext:canvas.getContext('2d'), viewport }).promise;
    text = await ocrImage(canvas.toDataURL('image/png'),'eng');
  }
  return text;
}

// ---- OCR text parsers (heuristic — ผู้ใช้ตรวจ/แก้ก่อนบันทึก) ----
function _ccParseStatement(text){
  text=text||''; const lines=text.split(/\r?\n/); const txns=[]; const monthCount={};
  for (const raw of lines){
    const line=raw.replace(/\s+/g,' ').trim();
    if (line.length<6) continue;
    const dm=line.match(/^(\d{1,2})[\/\.\-](\d{1,2})(?:[\/\.\-](\d{2,4}))?\b/);
    if (!dm) continue;
    const am=line.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})\s*(?:CR|DR|-)?\s*$/i);
    if (!am) continue;
    const amount=parseFloat(am[1].replace(/,/g,''));
    if (isNaN(amount)) continue;
    let desc=line.slice(dm[0].length, line.length-am[0].length).replace(/\s+/g,' ').trim();
    desc=desc.replace(/^\d{1,2}[\/\.\-]\d{1,2}(?:[\/\.\-]\d{2,4})?\s*/,'');
    const t={ txn_date: dm[0], description: desc||'(ไม่ระบุ)', amount };
    const mo=parseInt(dm[2],10); if(mo>=1&&mo<=12) monthCount[mo]=(monthCount[mo]||0)+1;
    if (dm[3]){ let y=parseInt(dm[3],10); if(y<100)y+=(y>70?1900:2000); t._y=y; }
    txns.push(t);
  }
  let card=null;
  const cm=text.match(/(\d{4}[\sxX\*]{0,2}[\dxX\*]{4}[\sxX\*]{0,2}[\dxX\*]{4}[\sxX\*]{0,2}\d{4})/)||text.match(/[xX\*]{4,}\s?\d{4}/);
  if (cm) card=(cm[1]||cm[0]).replace(/\s+/g,'');
  let bm=null,best=0; for(const k in monthCount){ if(monthCount[k]>best){best=monthCount[k];bm=parseInt(k,10);} }
  const years=txns.map(t=>t._y).filter(Boolean); const by=years.length?years.sort((a,b)=>b-a)[0]:null;
  txns.forEach(t=>delete t._y);
  return { card_number:card, bill_month:bm, bill_year:by, transactions:txns };
}
// v1.9.221 — จับชื่อ platform/บริษัทที่รู้จักจากข้อความ OCR (alias + fuzzy กัน OCR เพี้ยน)
const _CC_PLATFORMS = [
  { name:'Google',          aliases:['google','google ads','google cloud','google asia pacific','google ireland','youtube','admob','google workspace','gcp'] },
  { name:'Meta (Facebook)', aliases:['facebook','meta platforms','meta platforms ireland','facebook ireland','instagram','whatsapp'] },
  { name:'Anthropic',       aliases:['anthropic','claude ai','claude'] },
  { name:'OpenAI',          aliases:['openai','chatgpt'] },
  { name:'TikTok',          aliases:['tiktok','tik tok','tiktok ads','bytedance','tiktok pte'] },
  { name:'LINE',            aliases:['line company','line man','line ads','line for business','line oa','ly corporation','line plus','line official account'] },
  { name:'Microsoft',       aliases:['microsoft','azure','microsoft advertising','bing ads','linkedin','github'] },
  { name:'Amazon (AWS)',    aliases:['amazon web services','aws','amazon.com','amazon advertising','amazon'] },
  { name:'X (Twitter)',     aliases:['x corp','x ads','twitter'] },
  { name:'Adobe',           aliases:['adobe'] },
  { name:'Canva',           aliases:['canva'] },
  { name:'Apple',           aliases:['apple','app store','itunes'] },
  { name:'Shopee',          aliases:['shopee'] },
  { name:'Lazada',          aliases:['lazada'] },
  { name:'Grab',            aliases:['grab'] },
  { name:'Cloudflare',      aliases:['cloudflare'] },
  { name:'Shopify',         aliases:['shopify'] },
  { name:'Netflix',         aliases:['netflix'] },
  { name:'Spotify',         aliases:['spotify'] },
  { name:'Notion',          aliases:['notion'] },
  { name:'Figma',           aliases:['figma'] },
  { name:'Zoom',            aliases:['zoom'] },
  { name:'Slack',           aliases:['slack'] },
  { name:'Dropbox',         aliases:['dropbox'] },
];
function _ccLeven(a,b){
  const m=a.length,n=b.length; if(!m)return n; if(!n)return m;
  let prev=Array.from({length:n+1},(_,j)=>j), cur=new Array(n+1);
  for(let i=1;i<=m;i++){ cur[0]=i; for(let j=1;j<=n;j++){ const c=a[i-1]===b[j-1]?0:1; cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+c); } [prev,cur]=[cur,prev]; }
  return prev[n];
}
function _ccDetectPlatform(text){
  const norm=' '+(text||'').toLowerCase().replace(/[^a-z0-9ก-๙]+/g,' ').trim()+' ';
  for(const p of _CC_PLATFORMS){
    for(const a of p.aliases){
      const al=' '+a.toLowerCase().replace(/[^a-z0-9ก-๙]+/g,' ').trim()+' ';
      if(norm.includes(al)) return p.name;   // word-boundary match (กัน metadata/online/deadline ฯลฯ)
    }
  }
  const words=norm.split(' ').filter(w=>w.length>=5);   // fuzzy: คำที่ OCR อ่านเพี้ยนเล็กน้อย
  for(const p of _CC_PLATFORMS){
    const key=p.aliases[0].toLowerCase().replace(/[^a-z0-9]/g,'');
    if(key.length<5) continue;
    const lim=key.length>=8?2:1;
    for(const w of words){ if(Math.abs(w.length-key.length)<=lim && _ccLeven(w,key)<=lim) return p.name; }
  }
  return null;
}
function _ccParseInvoice(text){
  text=text||''; const lines=text.split(/\r?\n/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  let company=_ccDetectPlatform(text);   // จับ platform ที่รู้จักก่อน (Google/Facebook/Anthropic/…)
  if(!company){
    company=lines.find(l=>/(บริษัท|company|co\.?,?\s*ltd|จำกัด|inc\.|corporation)/i.test(l)) || lines.find(l=>l.length>=4&&/[A-Za-zก-๙]/.test(l)) || null;
    if (company) company=company.slice(0,80);
  }
  let totalAmt=null;
  for (const l of lines){
    if (/(grand\s*total|total|รวมทั้งสิ้น|ยอดรวม|จำนวนเงินรวม|amount\s*due|net\s*total)/i.test(l)){
      const m=l.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})/g);
      if(m) totalAmt=parseFloat(m[m.length-1].replace(/,/g,''));
    }
  }
  const amts=[]; let mAll; const re=/(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})/g;
  while((mAll=re.exec(text))){ const n=parseFloat(mAll[1].replace(/,/g,'')); if(!isNaN(n)) amts.push(n); }
  const amount=totalAmt!=null?totalAmt:(amts.length?Math.max(...amts):null);
  let month=null,year=null;
  const dm=text.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})/);
  if(dm){ month=parseInt(dm[2],10); let y=parseInt(dm[3],10); if(y<100)y+=2000; year=y; }
  if(!month){ const mn=text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})/i);
    if(mn){ const idx=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(mn[1].slice(0,3).toLowerCase()); month=idx+1; year=parseInt(mn[2],10); } }
  let kind='invoice';
  if(/(receipt|ใบเสร็จ|ใบรับเงิน)/i.test(text)) kind='receipt';
  return { company, amount, month, year, kind };
}

// ---- entry + router ----
async function renderCreditCard(){
  const root=$('creditcard-root'); if(!root) return;
  root.innerHTML=`
    <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn cc-nav" data-cc-view="bills">🧾 ใบแจ้งหนี้บัตรเครดิต</button>
      <button class="btn cc-nav" data-cc-view="pool">📥 ใบเสร็จ / ใบแจ้งหนี้ จากแพลตฟอร์ม</button>
      <button class="btn cc-nav" data-cc-view="summary">📊 Summary</button>
    </div>
    <div id="cc-view"><div class="empty">กำลังโหลด…</div></div>`;
  root.querySelectorAll('.cc-nav').forEach(b=>b.addEventListener('click',()=>{ _ccState.view=b.dataset.ccView; _ccState.billId=null; _ccRender(); }));
  await Promise.all([_ccLoadBills(), _ccLoadMembers()]); _ccRender();
}
async function _ccLoadBills(){ try{ _ccState.bills=(await fetchJson('/api/creditcard/bills')).bills||[]; }catch(e){ _ccState.bills=[]; } }
function _ccRender(){
  document.querySelectorAll('.cc-nav').forEach(b=>b.classList.toggle('primary', b.dataset.ccView===_ccState.view && !_ccState.billId));
  const v=$('cc-view'); if(!v) return;
  if(_ccState.billId) return _ccRenderDetail(v);
  if(_ccState.view==='pool') return _ccRenderPool(v);
  if(_ccState.view==='summary') return _ccRenderSummary(v);
  return _ccRenderBills(v);
}

// ---- bills list (home) ----
function _ccRenderBills(v){
  const bills=_ccState.bills;
  v.innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn primary" id="cc-new-bill">+ สร้างใบแจ้งหนี้บัตรเครดิต</button>
      <button class="btn" id="cc-up-invoice">⬆️ อัพโหลด</button>
    </div>
    ${bills.length?bills.map(_ccBillCard).join(''):'<div class="empty">ยังไม่มีบิล — กด “สร้างใบแจ้งหนี้บัตรเครดิต” แล้วอัพโหลดใบแจ้งยอดบัตรเครดิต</div>'}`;
  $('cc-new-bill').onclick=()=>_ccCreateBill();
  $('cc-up-invoice').onclick=()=>_ccUploadInvoice(null);
  v.querySelectorAll('[data-cc-bill]').forEach(c=>c.addEventListener('click',()=>{ _ccState.billId=parseInt(c.dataset.ccBill,10); _ccRender(); }));
}
function _ccBillCard(b){
  const complete=b.txn_count>0 && b.matched_txn>=b.txn_count;
  const pct=b.txn_count?Math.round(b.matched_txn/b.txn_count*100):0;
  return `<div class="card hw-card" data-cc-bill="${b.id}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;padding:12px 16px">
    <div style="min-width:0">
      <div style="font-size:15px;font-weight:800">💳 ${escapeHtml(b.card_number||'บัตรเครดิต')} · ${_ccMonthLabel(b.bill_month,b.bill_year)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:3px">${b.txn_count} รายการ · ยอดรวม ${_ccMoney(b.txn_total)} · invoice ${b.invoice_count} ใบ${b.created_by?' · โดย '+escapeHtml(b.created_by):''}</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
      <span style="display:inline-flex;align-items:center;padding:3px 11px;border-radius:999px;font-size:12px;font-weight:700;${complete?'background:rgba(16,185,129,.12);color:var(--green)':'background:rgba(245,158,11,.14);color:#92400e'}">${complete?'✓ ครบ':'จับคู่ '+pct+'%'}</span>
      <span class="hw-chev" style="font-size:22px;line-height:1">›</span>
    </div>
  </div>`;
}

// ---- create monthly bill (upload statement images → OCR → preview → save) ----
function _ccCreateBill(){
  const pages=[];
  showModal({
    title:'+ สร้างใบแจ้งหนี้บัตรเครดิต', slide:true, size:'wide',
    body:`
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px">อัพโหลดรูปใบแจ้งยอดบัตรเครดิต (หลายใบได้) → ระบบ OCR ดึงรายการ → ตรวจ/แก้ก่อนบันทึก</div>
      <input id="cc-bill-files" type="file" accept="image/*" multiple style="margin-bottom:10px" />
      <div id="cc-bill-status" style="font-size:12.5px;color:var(--primary)"></div>
      <div id="cc-bill-fields" style="display:none;margin-top:12px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
          <label style="flex:1;min-width:150px;font-size:12px">เลขบัตร<input id="cc-bill-card" style="width:100%" /></label>
          <label style="width:120px;font-size:12px">เดือน${_ccMonthSelect('cc-bill-month')}</label>
          <label style="width:110px;font-size:12px">ปี (ค.ศ.)<input id="cc-bill-year" type="number" placeholder="${new Date().getFullYear()}" style="width:100%" /></label>
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:6px">รายการจากบัตร (<span id="cc-bill-count">0</span>)</div>
        <div id="cc-bill-txns"></div>
        <button type="button" class="btn" id="cc-bill-addrow" style="margin-top:8px;font-size:12px">+ เพิ่มแถว</button>
      </div>`,
    onSubmit: async ()=>{
      if(!pages.length) throw new Error('อัพโหลดรูปใบแจ้งยอดก่อน');
      const rows=Array.from(document.querySelectorAll('#cc-bill-txns .cc-txn-row')).map(r=>({
        txn_date:r.querySelector('.cc-t-date').value.trim()||null,
        description:r.querySelector('.cc-t-desc').value.trim()||null,
        amount:parseFloat(r.querySelector('.cc-t-amt').value)||null,
      })).filter(t=>t.description||t.amount!=null);
      const body={ card_number:$('cc-bill-card').value.trim()||null, bill_month:parseInt($('cc-bill-month').value,10)||null,
        bill_year:parseInt($('cc-bill-year').value,10)||null, pages, transactions:rows };
      await fetchJson('/api/creditcard/bills',{method:'POST',body:JSON.stringify(body)});
      await _ccLoadBills(); _ccState.view='bills'; _ccState.billId=null; _ccRender();
    },
  });
  setTimeout(()=>{
    const updateCount=()=>{ const el=$('cc-bill-count'); if(el) el.textContent=document.querySelectorAll('#cc-bill-txns .cc-txn-row').length; };
    const addRow=(t)=>{
      const w=document.createElement('div'); w.className='cc-txn-row';
      w.style.cssText='display:flex;gap:6px;margin-bottom:5px;align-items:center';
      w.innerHTML=`<input class="cc-t-date" placeholder="วันที่" value="${escapeHtml((t&&t.txn_date)||'')}" style="width:88px;font-size:12px" />
        <input class="cc-t-desc" placeholder="รายละเอียด" value="${escapeHtml((t&&t.description)||'')}" style="flex:1;min-width:0;font-size:12px" />
        <input class="cc-t-amt" placeholder="ยอด" type="number" step="0.01" value="${(t&&t.amount!=null)?t.amount:''}" style="width:100px;font-size:12px;text-align:right" />
        <button type="button" class="btn danger cc-t-del" style="padding:3px 8px;font-size:12px">✕</button>`;
      w.querySelector('.cc-t-del').onclick=()=>{ w.remove(); updateCount(); };
      $('cc-bill-txns').appendChild(w);
    };
    const addBtn=$('cc-bill-addrow'); if(addBtn) addBtn.onclick=()=>{ addRow(null); updateCount(); };
    const inp=$('cc-bill-files'); const st=$('cc-bill-status');
    inp.onchange=async ()=>{
      const files=Array.from(inp.files||[]); if(!files.length) return;
      pages.length=0; $('cc-bill-txns').innerHTML=''; let allText='';
      for(let i=0;i<files.length;i++){
        st.textContent=`OCR รูปที่ ${i+1}/${files.length}…`;
        let dataUrl; try{ dataUrl=await _ccFileToDataUrl(files[i]); }catch(_){ continue; }
        let text=''; try{ text=await ocrImage(dataUrl,'eng',(p)=>{ st.textContent=`OCR รูปที่ ${i+1}/${files.length} … ${Math.round((p.progress||0)*100)}%`; }); }catch(_){ text=''; }
        const stored=await _ccDownscale(dataUrl,1600);   // OCR ทำบน full-res แล้ว → เก็บแบบย่อ
        pages.push({ image_data:stored, ocr_text:text }); allText+=text+'\n';
      }
      const parsed=_ccParseStatement(allText);
      $('cc-bill-fields').style.display='';
      $('cc-bill-card').value=parsed.card_number||'';
      if(parsed.bill_month) $('cc-bill-month').value=parsed.bill_month;
      if(parsed.bill_year) $('cc-bill-year').value=parsed.bill_year;
      parsed.transactions.forEach(addRow); updateCount();
      st.textContent=`✓ อ่านได้ ${parsed.transactions.length} รายการ — ตรวจ/แก้แล้วกดบันทึก`;
    };
  },0);
}

// ---- upload invoice/receipt (PDF/รูป → อ่าน บริษัท/เดือน/ยอด → preview → save) ----
function _ccInvUploadRow(idx,fname,p){
  return `<div class="cc-invrow card" data-idx="${idx}" style="padding:10px 12px;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
      <div style="font-size:11px;color:var(--text-muted);word-break:break-all;min-width:0">📎 ${escapeHtml(fname)}</div>
      <button type="button" class="btn cc-ir-preview" data-idx="${idx}" style="font-size:11px;padding:3px 9px;flex-shrink:0">👁 เปิดดู</button>
    </div>
    <label style="display:block;margin-bottom:6px;font-size:12px">บริษัท / Platform<input class="cc-ir-company" value="${escapeHtml(p.company||'')}" style="width:100%" /></label>
    <label style="display:block;margin-bottom:6px;font-size:12px">รายละเอียดเอกสาร<input class="cc-ir-desc" placeholder="เช่น ค่าโฆษณา Facebook เดือน พ.ค." style="width:100%" /></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
      <label style="flex:1;min-width:100px;font-size:12px">เลข Job<input class="cc-ir-job" placeholder="J2026-..." style="width:100%" /></label>
      <label style="flex:1;min-width:100px;font-size:12px">ชื่อสินค้า<input class="cc-ir-product" style="width:100%" /></label>
      <label style="flex:1;min-width:100px;font-size:12px">AM ที่ดูแล<input class="cc-ir-am" style="width:100%" /></label>
    </div>
    <label style="display:block;margin-bottom:6px;font-size:12px">หมายเหตุ<input class="cc-ir-note" placeholder="เช่น ตัดแบบนี้ทุกเดือน" style="width:100%" /></label>
    <label style="display:block;margin-bottom:6px;font-size:12px">หมวดค่าใช้จ่าย<select class="cc-ir-expcat" style="width:100%">${_CC_EXP_CATS.map(c=>`<option value="${c.key}" ${c.key==='unspecified'?'selected':''}>${c.icon} ${c.label}</option>`).join('')}</select></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <label style="width:120px;font-size:12px">ประเภท<select class="cc-ir-kind" style="width:100%"><option value="invoice" ${p.kind!=='receipt'?'selected':''}>Invoice</option><option value="receipt" ${p.kind==='receipt'?'selected':''}>Receipt</option></select></label>
      <label style="width:110px;font-size:12px">เดือน${_ccMonthSelectCls('cc-ir-month',p.month)}</label>
      <label style="width:90px;font-size:12px">ปี<input class="cc-ir-year" type="number" value="${p.year||''}" style="width:100%" /></label>
      <label style="flex:1;min-width:110px;font-size:12px">ยอดเงิน<input class="cc-ir-amount" type="number" step="0.01" value="${p.amount!=null?p.amount:''}" style="width:100%" /></label>
    </div>
  </div>`;
}
function _ccUploadInvoice(defaultBillId, preFiles){
  const items=[];   // {fileData, fileMime, fileName, parsed}
  const billOpts=`<option value="">— ยังไม่ผูกบิล (ลอยไว้ก่อน) —</option>`+_ccState.bills.map(b=>`<option value="${b.id}" ${b.id===defaultBillId?'selected':''}>${escapeHtml(b.card_number||'บัตร')} · ${_ccMonthLabel(b.bill_month,b.bill_year)}</option>`).join('');
  showModal({
    title:'⬆️ อัพโหลด Invoice / Receipt (หลายไฟล์ได้)', slide:true, size:'wide',
    body:`
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px">อัพโหลด PDF/รูป <b>หลายไฟล์พร้อมกันได้</b> → ระบบอ่านแต่ละใบ → ตรวจ/แก้ → บันทึกทั้งหมด · ไม่ผูกบิลก็ได้ (ลอยไว้)</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <label style="flex:1;min-width:180px;font-size:12px">บิลปลายทาง (ทุกไฟล์ · ไม่บังคับ)<select id="cc-inv-bill" style="width:100%">${billOpts}</select></label>
        <div style="flex:1;min-width:180px;font-size:12px">ผู้อัพโหลด / เจ้าของเอกสาร${_memberPickerHtml('cc-inv-uploader',null,'— ฉัน (ผู้ล็อกอิน) —')}</div>
      </div>
      <input id="cc-inv-file" type="file" accept="application/pdf,image/*" multiple style="margin-bottom:8px" />
      <div id="cc-inv-status" style="font-size:12.5px;color:var(--primary)"></div>
      <div id="cc-inv-list" style="margin-top:12px"></div>`,
    onSubmit: async ()=>{
      const rows=Array.from(document.querySelectorAll('#cc-inv-list .cc-invrow'));
      if(!rows.length) throw new Error('อัพโหลดไฟล์ก่อน');
      const bv=$('cc-inv-bill').value; const bill_id=bv?parseInt(bv,10):null;
      const uv=$('cc-inv-uploader').value; const uploaded_by_id=uv?parseInt(uv,10):null;
      let ok=0;
      for(const r of rows){
        const it=items[parseInt(r.dataset.idx,10)]; if(!it) continue;
        const body={ bill_id, uploaded_by_id, company:r.querySelector('.cc-ir-company').value.trim()||null,
          description:r.querySelector('.cc-ir-desc').value.trim()||null,
          job_number:r.querySelector('.cc-ir-job').value.trim()||null,
          product_name:r.querySelector('.cc-ir-product').value.trim()||null,
          am_name:r.querySelector('.cc-ir-am').value.trim()||null,
          note:r.querySelector('.cc-ir-note').value.trim()||null,
          expense_category:r.querySelector('.cc-ir-expcat').value||null,
          kind:r.querySelector('.cc-ir-kind').value, inv_month:parseInt(r.querySelector('.cc-ir-month').value,10)||null,
          inv_year:parseInt(r.querySelector('.cc-ir-year').value,10)||null, amount:parseFloat(r.querySelector('.cc-ir-amount').value)||null,
          file_data:it.fileData, file_name:it.fileName, file_mime:it.fileMime };
        await fetchJson('/api/creditcard/invoices',{method:'POST',body:JSON.stringify(body)}); ok++;
      }
      await _ccLoadBills();
      if(_ccState.billId) _ccRenderDetail($('cc-view'));
      else if(_ccState.view==='pool') _ccRenderPool($('cc-view'));
      else _ccRender();
    },
  });
  setTimeout(()=>{
    _initMemberPicker('cc-inv-uploader', _ccMembers, '— ฉัน (ผู้ล็อกอิน) —');   // searchable picker (รูป+ชื่อ)
    const inp=$('cc-inv-file'); const st=$('cc-inv-status'); const listEl=$('cc-inv-list');
    // v1.9.305 — กดดูไฟล์ที่อัพ (ก่อน OCR/บันทึก) — delegated (อยู่รอด innerHTML rebuild)
    listEl.addEventListener('click',(e)=>{ const b=e.target.closest('.cc-ir-preview'); if(!b) return; const it=items[parseInt(b.dataset.idx,10)]; if(it) _ccPreviewDataUrl(it.fileData,it.fileMime,it.fileName); });
    // v1.9.308 — แยก process ไฟล์ เพื่อรองรับทั้งเลือกไฟล์ + ลากวาง (drag-drop)
    const processFiles=async (files)=>{
      files=Array.from(files||[]).filter(f=>/pdf|image\//.test(f.type)||/\.(pdf|png|jpe?g|gif|webp|bmp)$/i.test(f.name));
      if(!files.length) return;
      items.length=0; listEl.innerHTML='';
      for(let i=0;i<files.length;i++){
        const f=files[i];
        if(f.size>12*1024*1024){ st.textContent=`⚠️ ข้าม ${f.name} (เกิน 12MB)`; continue; }
        st.textContent=`อ่านไฟล์ ${i+1}/${files.length}: ${f.name}…`;
        let fileData,text='';
        try{
          fileData=await _ccFileToDataUrl(f);
          if((f.type||'').includes('pdf')||/\.pdf$/i.test(f.name)){ text=await _ccPdfToText(await f.arrayBuffer(),(p,tot)=>{ st.textContent=`${f.name}: PDF ${p?p+'/'+tot:'สแกน'}…`; }); }
          else { text=await ocrImage(fileData,'eng',(p)=>{ st.textContent=`${f.name}: OCR ${Math.round((p.progress||0)*100)}%`; }); }
        }catch(e){ st.textContent=`อ่าน ${f.name} ไม่สำเร็จ`; continue; }
        const parsed=_ccParseInvoice(text);
        const idx=items.length;
        items.push({ fileData, fileMime:f.type||'application/octet-stream', fileName:f.name, parsed });
        listEl.insertAdjacentHTML('beforeend', _ccInvUploadRow(idx, f.name, parsed));
      }
      st.textContent=`✓ อ่าน ${items.length} ไฟล์ — ตรวจ/แก้แล้วกดบันทึกทั้งหมด`;
    };
    inp.onchange=()=>processFiles(inp.files);
    if(preFiles && preFiles.length) processFiles(preFiles);   // ลากไฟล์มาวาง → process เลย
  },0);
}

// ---- bill detail (left=transactions, right=invoices, drag-drop / click-to-match) ----
async function _ccRenderDetail(v){
  v.innerHTML='<div class="empty">กำลังโหลด…</div>';
  let d; try{ d=await fetchJson('/api/creditcard/bills/'+_ccState.billId); }
  catch(e){ v.innerHTML=`<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const invById={}; d.invoices.forEach(i=>invById[i.id]=i);
  const allInvById={}; d.invoices.forEach(i=>allInvById[i.id]=i); (d.pool_invoices||[]).forEach(i=>allInvById[i.id]=i);
  const matchByTxn={}; const matchedInvIds=new Set();
  d.matches.forEach(m=>{ (matchByTxn[m.transaction_id]=matchByTxn[m.transaction_id]||[]).push({matchId:m.id,inv:invById[m.invoice_id]}); matchedInvIds.add(m.invoice_id); });
  const total=d.transactions.length, matchedTxn=Object.keys(matchByTxn).filter(k=>matchByTxn[k].length).length;
  const complete=total>0 && matchedTxn>=total;
  v.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn" id="cc-back" style="font-size:12px">← กลับ</button>
        <span style="font-size:16px;font-weight:800">💳 ${escapeHtml(d.bill.card_number||'บัตร')} · ${_ccMonthLabel(d.bill.bill_month,d.bill.bill_year)}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="font-size:12.5px;font-weight:700;${complete?'color:var(--green)':'color:#92400e'}">${complete?'✓ จับคู่ครบ':matchedTxn+'/'+total+' จับคู่แล้ว'}</span>
        <button class="btn" id="cc-edit-bill" style="font-size:12px">✏️ แก้ไขบิล</button>
        <button class="btn" id="cc-add-inv" style="font-size:12px">⬆️ เพิ่ม invoice</button>
        <button class="btn danger" id="cc-del-bill" style="font-size:12px">🗑 ลบบิล</button>
      </div>
    </div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px">ลาก invoice จากขวา → วางบนรายการซ้ายเพื่อจับคู่ · หรือคลิก invoice แล้วคลิกรายการ</div>
    <div style="display:grid;grid-template-columns:minmax(300px,460px) 320px;gap:14px;align-items:start">
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700;color:var(--text-muted)">รายการจากบัตร (${total})</span>
          <input id="cc-txn-search" placeholder="🔍 ค้นหารายการ…" style="font-size:12px;padding:5px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);width:180px;max-width:55%" />
        </div>
        <div id="cc-txn-col"></div>
      </div>
      <div><div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:8px">Invoice / Receipt (${d.invoices.length})</div><div id="cc-inv-col"></div></div>
    </div>`;
  // v1.9.314 — รายการในบัตรกดเพื่อ edit description (user_note) ได้ inline
  $('cc-txn-col').innerHTML=d.transactions.map(t=>{
    const ms=matchByTxn[t.id]||[];
    const chips=ms.map(mm=>`<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;background:rgba(16,185,129,.12);color:var(--green);font-weight:600;margin:3px 3px 0 0">${escapeHtml((mm.inv&&mm.inv.company)||'invoice')} ${_ccMoney(mm.inv&&mm.inv.amount)} <span class="cc-unmatch" data-match="${mm.matchId}" style="cursor:pointer;opacity:.7">✕</span></span>`).join('');
    const note=t.user_note||'';
    const noteLine=`<div class="cc-txn-note" style="${note?'':'display:none;'}font-size:11px;color:var(--text-muted);margin-top:3px;font-style:italic">${note?'📝 '+escapeHtml(note):''}</div>`;
    return `<div class="cc-txn card" data-txn="${t.id}" style="padding:9px 12px;margin-bottom:6px;border:1px solid ${ms.length?'rgba(16,185,129,.45)':'var(--border)'};transition:background .1s;cursor:pointer" title="คลิกเพื่อเพิ่ม description">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600">${escapeHtml(t.description||'—')}</div>
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(t.txn_date||'')}</div>
          ${noteLine}
        </div>
        <div style="font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap">${_ccMoney(t.amount)}</div>
      </div>${chips?`<div>${chips}</div>`:''}
      <div class="cc-txn-edit" style="display:none;margin-top:8px;gap:6px;align-items:center">
        <input class="cc-txn-input" type="text" value="${escapeHtml(note)}" placeholder="ใส่ description..." maxlength="500" style="flex:1;font-size:12px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);min-width:0" />
        <button type="button" class="btn cc-txn-save" title="บันทึก (Enter)" style="font-size:13px;padding:4px 9px;line-height:1;color:var(--green)">✓</button>
        <button type="button" class="btn cc-txn-cancel" title="ยกเลิก (Esc)" style="font-size:13px;padding:4px 9px;line-height:1">✕</button>
      </div>
    </div>`;
  }).join('')||'<div class="empty" style="font-size:12px">ไม่มีรายการ</div>';
  const poolInv=d.pool_invoices||[];
  $('cc-inv-col').innerHTML=(
    d.invoices.map(i=>_ccInvCardHtml(i, matchedInvIds.has(i.id), false)).join('')
    + (poolInv.length?`<div style="font-size:11px;color:#92400e;margin:10px 0 6px;font-weight:700">📥 ลอย (ยังไม่ผูกบิล) — ลากมาจับคู่เพื่อผูกเข้าบิลนี้</div>`+poolInv.map(i=>_ccInvCardHtml(i,false,true)).join(''):'')
  )||'<div class="empty" style="font-size:12px">ยังไม่มี invoice — กด “เพิ่ม invoice”</div>';
  $('cc-back').onclick=()=>{ _ccState.billId=null; _ccState.selInvoice=null; _ccRender(); };
  $('cc-edit-bill').onclick=()=>_ccEditBill(d);
  $('cc-add-inv').onclick=()=>_ccUploadInvoice(_ccState.billId);
  $('cc-del-bill').onclick=async ()=>{ if(!confirm('ลบบิลนี้ทั้งหมด? (รายการ/invoice/การจับคู่จะถูกลบด้วย)'))return; await fetchJson('/api/creditcard/bills/'+_ccState.billId,{method:'DELETE'}); _ccState.billId=null; await _ccLoadBills(); _ccRender(); };
  v.querySelectorAll('.cc-unmatch').forEach(x=>x.addEventListener('click',async(e)=>{ e.stopPropagation(); await fetchJson('/api/creditcard/matches/'+x.dataset.match,{method:'DELETE'}); _ccRenderDetail($('cc-view')); }));
  v.querySelectorAll('.cc-inv-prev').forEach(x=>x.addEventListener('click',(e)=>{ e.stopPropagation(); const inv=allInvById[parseInt(x.dataset.inv,10)]; if(inv) _ccPreviewInvoice(inv); }));
  v.querySelectorAll('.cc-inv-edit').forEach(x=>x.addEventListener('click',(e)=>{ e.stopPropagation(); const inv=allInvById[parseInt(x.dataset.inv,10)]; if(inv) _ccEditInvoice(inv,()=>_ccRenderDetail($('cc-view'))); }));
  v.querySelectorAll('.cc-inv-del').forEach(x=>x.addEventListener('click',async(e)=>{ e.stopPropagation(); if(!confirm('ลบ invoice นี้?'))return; await fetchJson('/api/creditcard/invoices/'+x.dataset.inv,{method:'DELETE'}); await _ccLoadBills(); _ccRenderDetail($('cc-view')); }));
  const _ccTxnSearch=$('cc-txn-search');
  if(_ccTxnSearch) _ccTxnSearch.addEventListener('input',()=>{ const q=_ccTxnSearch.value.trim().toLowerCase(); v.querySelectorAll('.cc-txn').forEach(el=>{ el.style.display=(!q||(el.textContent||'').toLowerCase().includes(q))?'':'none'; }); });
  let dragInv=null;
  const doMatch=async(txnId,invId)=>{ try{ await fetchJson('/api/creditcard/matches',{method:'POST',body:JSON.stringify({transaction_id:txnId,invoice_id:invId})}); _ccState.selInvoice=null; await _ccLoadBills(); _ccRenderDetail($('cc-view')); }catch(e){ alert(e.message); } };
  v.querySelectorAll('.cc-inv').forEach(el=>{
    el.addEventListener('dragstart',e=>{ dragInv=parseInt(el.dataset.inv,10); e.dataTransfer.effectAllowed='move'; });
    el.addEventListener('click',(e)=>{ if(e.target.closest('a,.cc-inv-del,.cc-inv-edit,.cc-inv-prev'))return; const id=parseInt(el.dataset.inv,10); _ccState.selInvoice=(_ccState.selInvoice===id)?null:id; v.querySelectorAll('.cc-inv').forEach(x=>x.style.outline=''); if(_ccState.selInvoice) el.style.outline='2px solid var(--primary)'; });
  });
  v.querySelectorAll('.cc-txn').forEach(el=>{
    el.addEventListener('dragover',e=>{ e.preventDefault(); el.style.background='var(--bg-soft)'; });
    el.addEventListener('dragleave',()=>{ el.style.background=''; });
    el.addEventListener('drop',e=>{ e.preventDefault(); el.style.background=''; if(dragInv) doMatch(parseInt(el.dataset.txn,10),dragInv); dragInv=null; });
    el.addEventListener('click',(e)=>{
      // ไม่ทำอะไรถ้าคลิกใน inline editor / chip ✕
      if(e.target.closest('.cc-txn-edit')||e.target.closest('.cc-unmatch')) return;
      // โหมดจับคู่ invoice — กระทำตามเดิม
      if(_ccState.selInvoice){ doMatch(parseInt(el.dataset.txn,10),_ccState.selInvoice); return; }
      // toggle inline note editor
      const editEl=el.querySelector('.cc-txn-edit'); if(!editEl) return;
      const isOpen=editEl.style.display==='flex';
      v.querySelectorAll('.cc-txn-edit').forEach(x=>{ x.style.display='none'; });
      if(!isOpen){ editEl.style.display='flex'; const inp=editEl.querySelector('.cc-txn-input'); if(inp){ inp.focus(); inp.select(); } }
    });
  });
  // v1.9.314 — inline save/cancel ของ description ใต้รายการ
  const _ccSaveTxnNote=async(card)=>{
    const tid=parseInt(card.dataset.txn,10);
    const inp=card.querySelector('.cc-txn-input'); if(!inp) return;
    const saveBtn=card.querySelector('.cc-txn-save'); if(saveBtn) saveBtn.disabled=true;
    try{
      const r=await fetchJson('/api/creditcard/transactions/'+tid,{method:'PATCH',body:JSON.stringify({user_note:inp.value})});
      const newNote=r.user_note||'';
      const t=d.transactions.find(x=>x.id===tid); if(t) t.user_note=newNote;
      const noteEl=card.querySelector('.cc-txn-note');
      if(noteEl){ if(newNote){ noteEl.style.display=''; noteEl.innerHTML='📝 '+escapeHtml(newNote); } else { noteEl.style.display='none'; noteEl.textContent=''; } }
      card.querySelector('.cc-txn-edit').style.display='none';
    }catch(err){ alert(err.message); }
    finally{ if(saveBtn) saveBtn.disabled=false; }
  };
  v.querySelectorAll('.cc-txn-save').forEach(btn=>btn.addEventListener('click',(e)=>{ e.stopPropagation(); _ccSaveTxnNote(btn.closest('.cc-txn')); }));
  v.querySelectorAll('.cc-txn-cancel').forEach(btn=>btn.addEventListener('click',(e)=>{ e.stopPropagation(); const card=btn.closest('.cc-txn'); const t=d.transactions.find(x=>x.id===parseInt(card.dataset.txn,10)); const inp=card.querySelector('.cc-txn-input'); if(inp&&t) inp.value=t.user_note||''; card.querySelector('.cc-txn-edit').style.display='none'; }));
  v.querySelectorAll('.cc-txn-input').forEach(inp=>{
    inp.addEventListener('click',e=>e.stopPropagation());
    inp.addEventListener('keydown',(e)=>{
      if(e.key==='Enter'){ e.preventDefault(); _ccSaveTxnNote(inp.closest('.cc-txn')); }
      else if(e.key==='Escape'){ e.preventDefault(); inp.closest('.cc-txn').querySelector('.cc-txn-cancel').click(); }
    });
  });
}

// v1.9.309 — หมวดค่าใช้จ่ายของใบเสร็จ/ใบแจ้งหนี้
const _CC_EXP_CATS=[
  {key:'credit_card',label:'ระบุค่าใช้จ่ายในบัตรเครดิต',short:'จ่ายผ่านบัตร',icon:'💳'},
  {key:'paid_self',label:'จ่ายเองไปก่อน',short:'จ่ายเองไปก่อน',icon:'🙋'},
  {key:'unspecified',label:'ยังไม่ได้ระบุค่าใช้จ่าย',short:'ยังไม่ระบุ',icon:'❓'},
  {key:'other',label:'อื่น ๆ',short:'อื่น ๆ',icon:'📌'},
];
const _ccExpCat=(v)=>_CC_EXP_CATS.find(c=>c.key===(v||'unspecified'))||_CC_EXP_CATS[2];
let _ccPoolCatFilter='all';
function _ccInvCardHtml(i,isMatched,isPool){
  return `<div class="cc-inv card" draggable="true" data-inv="${i.id}" style="padding:9px 11px;margin-bottom:6px;cursor:grab;border:1px solid ${isPool?'rgba(245,158,11,.5)':(isMatched?'rgba(16,185,129,.45)':'var(--border)')}">
    <div style="font-size:12.5px;font-weight:700">${escapeHtml(i.company||'—')} <span style="font-size:10px;color:var(--text-muted);font-weight:500">${i.kind==='receipt'?'ใบเสร็จ':'invoice'}</span>${isPool?' <span style="font-size:9.5px;color:#92400e;background:rgba(245,158,11,.15);padding:1px 6px;border-radius:999px">ลอย</span>':''}</div>
    ${i.description?`<div style="font-size:11px;color:var(--text);margin-top:1px">📝 ${escapeHtml(i.description)}</div>`:''}
    ${(i.job_number||i.product_name||i.am_name)?`<div style="font-size:10.5px;color:var(--text-muted);margin-top:1px;display:flex;gap:7px;flex-wrap:wrap">${i.job_number?`<span>🔖 ${escapeHtml(i.job_number)}</span>`:''}${i.product_name?`<span>📦 ${escapeHtml(i.product_name)}</span>`:''}${i.am_name?`<span>👤 ${escapeHtml(i.am_name)}</span>`:''}</div>`:''}
    ${i.note?`<div style="font-size:10.5px;color:#92400e;margin-top:1px">🗒️ ${escapeHtml(i.note)}</div>`:''}
    <div style="font-size:11px;color:var(--text-muted)">${_ccMonthLabel(i.inv_month,i.inv_year)} · ${_ccUploaderChip(i)}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px">
      <span style="font-weight:700;color:var(--green);font-variant-numeric:tabular-nums">${_ccMoney(i.amount)}</span>
      <span style="display:flex;gap:11px">
        <span class="cc-inv-prev" data-inv="${i.id}" style="font-size:12px;cursor:pointer" title="preview">👁</span>
        <span class="cc-inv-edit" data-inv="${i.id}" style="font-size:12px;cursor:pointer" title="แก้ไข">✏️</span>
        <span class="cc-inv-del" data-inv="${i.id}" style="font-size:11px;color:var(--critical);cursor:pointer">ลบ</span>
      </span>
    </div>
  </div>`;
}

// ---- preview ไฟล์ invoice/receipt ในแอป (PDF=iframe, รูป=img) ----
// v1.9.305 — preview ไฟล์จาก data URL (ตอนอัพโหลด ก่อนบันทึก/OCR)
function _ccPreviewDataUrl(dataUrl,mime,name){
  if(!dataUrl) return;
  const isImg=(mime||'').startsWith('image/')||/\.(png|jpe?g|gif|webp|bmp)$/i.test(name||'');
  const inner=isImg
    ? `<img src="${dataUrl}" alt="" style="width:100%;max-height:78vh;object-fit:contain;display:block;background:#0f172a" />`
    : `<iframe src="${dataUrl}" style="width:100%;height:78vh;border:0;background:#fff;display:block" title="preview"></iframe>`;
  const bg=document.createElement('div'); bg.className='modal-bg'; bg.style.zIndex='1300';
  bg.innerHTML=`<div class="modal modal-xwide" style="max-width:940px;padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
      <div style="font-size:13px;font-weight:700;min-width:0;word-break:break-all">📎 ${escapeHtml(name||'ไฟล์')}</div>
      <button class="btn" id="cc-dprev-close" style="font-size:12px;flex-shrink:0">ปิด</button>
    </div>
    <div style="border-radius:10px;overflow:hidden;border:1px solid var(--border)">${inner}</div>
  </div>`;
  document.body.appendChild(bg);
  const close=()=>bg.remove();
  bg.querySelector('#cc-dprev-close').onclick=close;
  bg.addEventListener('click',e=>{ if(e.target===bg) close(); });
}
function _ccPreviewInvoice(inv){
  const url=API+'/api/creditcard/invoices/'+inv.id+'/file';
  const isImg=(inv.file_mime||'').startsWith('image/')||/\.(png|jpe?g|gif|webp|bmp)$/i.test(inv.file_name||'');
  const inner=isImg
    ? `<img src="${url}" alt="" style="width:100%;max-height:78vh;object-fit:contain;display:block;background:#0f172a" />`
    : `<iframe src="${url}" style="width:100%;height:78vh;border:0;background:#fff;display:block" title="preview"></iframe>`;
  const bg=document.createElement('div'); bg.className='modal-bg'; bg.style.zIndex='1200';
  bg.innerHTML=`<div class="modal modal-xwide" style="max-width:940px;padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
      <div style="min-width:0">
        <div style="font-size:15px;font-weight:800">${escapeHtml(inv.company||'—')} · ${_ccMoney(inv.amount)}</div>
        <div style="font-size:11.5px;color:var(--text-muted)">${inv.kind==='receipt'?'ใบเสร็จ':'invoice'} · ${_ccMonthLabel(inv.inv_month,inv.inv_year)} · ${_ccUploaderChip(inv)}${inv.description?' · 📝 '+escapeHtml(inv.description):''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <a href="${url}" target="_blank" rel="noopener" class="btn" style="font-size:12px">↗ แท็บใหม่</a>
        <button class="btn" id="cc-prev-close" style="font-size:12px">ปิด</button>
      </div>
    </div>
    <div style="border-radius:10px;overflow:hidden;border:1px solid var(--border)">${inner}</div>
  </div>`;
  document.body.appendChild(bg);
  const close=()=>bg.remove();
  bg.querySelector('#cc-prev-close').onclick=close;
  bg.addEventListener('click',e=>{ if(e.target===bg) close(); });
}

// ---- edit invoice (แก้ไขข้อมูล invoice/receipt ที่อัพไปแล้ว) ----
function _ccEditInvoice(inv,onDone){
  const _euLabel='— คงเดิม ('+(inv.uploaded_by||'—')+') —';
  showModal({
    title:'✏️ แก้ไข Invoice / Receipt', slide:true,
    body:`
      <label style="display:block;margin-bottom:8px;font-size:12px">บริษัท / Platform<input id="cc-ei-company" value="${escapeHtml(inv.company||'')}" style="width:100%" /></label>
      <label style="display:block;margin-bottom:8px;font-size:12px">รายละเอียดเอกสาร<input id="cc-ei-desc" value="${escapeHtml(inv.description||'')}" placeholder="เช่น ค่าโฆษณา Facebook เดือน พ.ค." style="width:100%" /></label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        <label style="flex:1;min-width:130px;font-size:12px">เลข Job<input id="cc-ei-job" value="${escapeHtml(inv.job_number||'')}" placeholder="เช่น J2026-0142" style="width:100%" /></label>
        <label style="flex:1;min-width:130px;font-size:12px">ชื่อสินค้า<input id="cc-ei-product" value="${escapeHtml(inv.product_name||'')}" placeholder="เช่น น้ำดื่ม XXX" style="width:100%" /></label>
        <label style="flex:1;min-width:130px;font-size:12px">AM ที่ดูแล<input id="cc-ei-am" value="${escapeHtml(inv.am_name||'')}" placeholder="ชื่อ AM" style="width:100%" /></label>
      </div>
      <label style="display:block;margin-bottom:8px;font-size:12px">หมายเหตุ<textarea id="cc-ei-note" rows="2" placeholder="เช่น ตัดแบบนี้ทุกเดือน" style="width:100%;resize:vertical;font-family:inherit">${escapeHtml(inv.note||'')}</textarea></label>
      <label style="display:block;margin-bottom:8px;font-size:12px">หมวดค่าใช้จ่าย<select id="cc-ei-expcat" style="width:100%">${_CC_EXP_CATS.map(c=>`<option value="${c.key}" ${(inv.expense_category||'unspecified')===c.key?'selected':''}>${c.icon} ${c.label}</option>`).join('')}</select></label>
      <div style="margin-bottom:8px;font-size:12px">ผู้อัพโหลด / เจ้าของเอกสาร${_memberPickerHtml('cc-ei-uploader',inv.uploaded_by_id,_euLabel)}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <label style="width:130px;font-size:12px">ประเภท<select id="cc-ei-kind" style="width:100%"><option value="invoice" ${inv.kind!=='receipt'?'selected':''}>Invoice</option><option value="receipt" ${inv.kind==='receipt'?'selected':''}>Receipt</option></select></label>
        <label style="width:120px;font-size:12px">เดือน${_ccMonthSelect('cc-ei-month',inv.inv_month||null)}</label>
        <label style="width:100px;font-size:12px">ปี<input id="cc-ei-year" type="number" value="${inv.inv_year||''}" style="width:100%" /></label>
        <label style="flex:1;min-width:120px;font-size:12px">ยอดเงิน<input id="cc-ei-amount" type="number" step="0.01" value="${inv.amount!=null?inv.amount:''}" style="width:100%" /></label>
      </div>
      <div style="margin-top:10px"><a href="${API}/api/creditcard/invoices/${inv.id}/file" target="_blank" rel="noopener" style="font-size:12px">📄 ดูไฟล์ต้นฉบับ</a></div>`,
    onSubmit: async ()=>{
      const uv=$('cc-ei-uploader').value;
      const body={ company:$('cc-ei-company').value.trim()||null, kind:$('cc-ei-kind').value,
        inv_month:parseInt($('cc-ei-month').value,10)||null, inv_year:parseInt($('cc-ei-year').value,10)||null,
        amount:parseFloat($('cc-ei-amount').value)||null, description:$('cc-ei-desc').value.trim()||null,
        job_number:$('cc-ei-job').value.trim()||null, product_name:$('cc-ei-product').value.trim()||null,
        am_name:$('cc-ei-am').value.trim()||null, note:$('cc-ei-note').value.trim()||null,
        expense_category:$('cc-ei-expcat').value||null,
        uploaded_by_id: uv?parseInt(uv,10):null };
      await fetchJson('/api/creditcard/invoices/'+inv.id,{method:'PUT',body:JSON.stringify(body)});
      await _ccLoadBills(); if(onDone) onDone();
    },
  });
  setTimeout(()=>{ _initMemberPicker('cc-ei-uploader', _ccMembers, _euLabel); }, 0);   // searchable picker (รูป+ชื่อ)
}

// ---- edit bill (แก้ไขใบแจ้งหนี้บัตรเครดิต: เลขบัตร/เดือน/ปี + รายการ — รักษา match ของแถวเดิม) ----
function _ccEditBill(d){
  const bill=d.bill;
  showModal({
    title:'✏️ แก้ไขใบแจ้งหนี้บัตรเครดิต', slide:true, size:'wide',
    body:`
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <label style="flex:1;min-width:150px;font-size:12px">เลขบัตร<input id="cc-eb-card" value="${escapeHtml(bill.card_number||'')}" style="width:100%" /></label>
        <label style="width:120px;font-size:12px">เดือน${_ccMonthSelect('cc-eb-month',bill.bill_month||null)}</label>
        <label style="width:110px;font-size:12px">ปี (ค.ศ.)<input id="cc-eb-year" type="number" value="${bill.bill_year||''}" style="width:100%" /></label>
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:6px">รายการจากบัตร (<span id="cc-eb-count">0</span>) · ลบแถว = ยกเลิกการจับคู่ของแถวนั้นด้วย</div>
      <div id="cc-eb-txns"></div>
      <button type="button" class="btn" id="cc-eb-addrow" style="margin-top:8px;font-size:12px">+ เพิ่มแถว</button>`,
    onSubmit: async ()=>{
      const rows=Array.from(document.querySelectorAll('#cc-eb-txns .cc-txn-row')).map(r=>({
        id: r.dataset.tid?parseInt(r.dataset.tid,10):undefined,
        txn_date:r.querySelector('.cc-t-date').value.trim()||null,
        description:r.querySelector('.cc-t-desc').value.trim()||null,
        amount:parseFloat(r.querySelector('.cc-t-amt').value)||null,
      })).filter(t=>t.description||t.amount!=null||t.id);
      const body={ card_number:$('cc-eb-card').value.trim()||null, bill_month:parseInt($('cc-eb-month').value,10)||null,
        bill_year:parseInt($('cc-eb-year').value,10)||null, transactions:rows };
      await fetchJson('/api/creditcard/bills/'+bill.id,{method:'PUT',body:JSON.stringify(body)});
      await _ccLoadBills(); _ccRenderDetail($('cc-view'));
    },
  });
  setTimeout(()=>{
    const updateCount=()=>{ const el=$('cc-eb-count'); if(el) el.textContent=document.querySelectorAll('#cc-eb-txns .cc-txn-row').length; };
    const addRow=(t)=>{
      const w=document.createElement('div'); w.className='cc-txn-row';
      if(t&&t.id) w.dataset.tid=t.id;
      w.style.cssText='display:flex;gap:6px;margin-bottom:5px;align-items:center';
      w.innerHTML=`<input class="cc-t-date" placeholder="วันที่" value="${escapeHtml((t&&t.txn_date)||'')}" style="width:88px;font-size:12px" />
        <input class="cc-t-desc" placeholder="รายละเอียด" value="${escapeHtml((t&&t.description)||'')}" style="flex:1;min-width:0;font-size:12px" />
        <input class="cc-t-amt" placeholder="ยอด" type="number" step="0.01" value="${(t&&t.amount!=null)?t.amount:''}" style="width:100px;font-size:12px;text-align:right" />
        <button type="button" class="btn danger cc-t-del" style="padding:3px 8px;font-size:12px">✕</button>`;
      w.querySelector('.cc-t-del').onclick=()=>{ w.remove(); updateCount(); };
      $('cc-eb-txns').appendChild(w);
    };
    (d.transactions||[]).forEach(addRow); updateCount();
    const addBtn=$('cc-eb-addrow'); if(addBtn) addBtn.onclick=()=>{ addRow(null); updateCount(); };
  },0);
}

// ---- pool: invoice ลอย (ยังไม่ผูกบิล) ----
async function _ccRenderPool(v){
  v.innerHTML=`
    <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">
      <button class="btn primary" id="cc-pool-up">⬆️ อัพโหลด</button>
      <span style="font-size:12px;color:var(--text-muted)">invoice ที่ยังไม่ผูกบิล — เปิดบิลแล้วลากจับคู่เพื่อผูกเข้าบิลอัตโนมัติ</span>
    </div>
    <div id="cc-pool-drop" style="border:2px dashed var(--border);border-radius:12px;padding:16px;text-align:center;color:var(--text-muted);font-size:12.5px;margin-bottom:14px;transition:border-color .12s,background .12s;cursor:pointer;line-height:1.6">
      📥 <b>ลากไฟล์ Invoice / Receipt</b> (PDF / รูป) มาวางที่นี่เพื่ออัพโหลด<br><span style="font-size:11px">หรือคลิกเพื่อเลือกไฟล์</span>
    </div>
    <div id="cc-pool-filter" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px"></div>
    <div id="cc-pool-list"><div class="empty">กำลังโหลด…</div></div>`;
  $('cc-pool-up').onclick=()=>_ccUploadInvoice(null);
  // v1.9.308 — drag-drop zone
  const dz=$('cc-pool-drop');
  if(dz){
    dz.onclick=()=>_ccUploadInvoice(null);
    const on=()=>{ dz.style.borderColor='var(--primary)'; dz.style.background='rgba(37,99,235,.06)'; };
    const off=()=>{ dz.style.borderColor='var(--border)'; dz.style.background='transparent'; };
    dz.addEventListener('dragover',e=>{ e.preventDefault(); on(); });
    dz.addEventListener('dragleave',e=>{ e.preventDefault(); off(); });
    dz.addEventListener('drop',e=>{ e.preventDefault(); off(); const fs=e.dataTransfer&&e.dataTransfer.files; if(fs&&fs.length) _ccUploadInvoice(null,fs); });
  }
  let list;
  try{ list=(await fetchJson('/api/creditcard/pool-invoices')).invoices||[]; }
  catch(e){ $('cc-pool-filter').innerHTML=''; $('cc-pool-list').innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  const byId={}; list.forEach(i=>byId[i.id]=i);
  const catOf=(i)=>(i.expense_category||'unspecified');
  // v1.9.309 — filter bar (ทั้งหมด + แต่ละหมวด พร้อมจำนวน)
  const renderFilter=()=>{
    const fe=$('cc-pool-filter'); if(!fe) return;
    const chip=(key,label,n,active)=>`<button type="button" class="cc-pool-fchip" data-cat="${key}" style="border:1px solid ${active?'var(--primary)':'var(--border)'};background:${active?'var(--primary)':'var(--bg-card)'};color:${active?'#fff':'var(--text-muted)'};font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;cursor:pointer;font-family:inherit">${label} <span style="opacity:.75">(${n})</span></button>`;
    fe.innerHTML=chip('all','📋 ทั้งหมด',list.length,_ccPoolCatFilter==='all')
      +_CC_EXP_CATS.map(c=>chip(c.key,c.icon+' '+c.label,list.filter(i=>catOf(i)===c.key).length,_ccPoolCatFilter===c.key)).join('');
    fe.querySelectorAll('.cc-pool-fchip').forEach(b=>b.addEventListener('click',()=>{ _ccPoolCatFilter=b.dataset.cat; renderFilter(); paint(); }));
  };
  const paint=()=>{
    const le=$('cc-pool-list'); if(!le) return;
    if(!list.length){ le.innerHTML='<div class="empty">ไม่มีใบเสร็จลอย — ทุกใบผูกบิลแล้ว หรือยังไม่ได้อัพโหลด</div>'; return; }
    const shown=_ccPoolCatFilter==='all'?list:list.filter(i=>catOf(i)===_ccPoolCatFilter);
    if(!shown.length){ le.innerHTML='<div class="empty" style="padding:22px">— ไม่มีใบเสร็จในหมวดนี้ —</div>'; return; }
    le.innerHTML=shown.map(i=>{ const ec=_ccExpCat(i.expense_category); return `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;padding:11px 15px">
        <div style="min-width:0">
          <div style="font-size:14px;font-weight:700">${escapeHtml(i.company||'—')} <span style="font-size:10px;color:var(--text-muted);font-weight:500">${i.kind==='receipt'?'ใบเสร็จ':'invoice'}</span> <span style="font-size:10px;background:var(--bg-soft);color:var(--text-muted);padding:1px 8px;border-radius:999px;font-weight:600">${ec.icon} ${escapeHtml(ec.short)}</span></div>
          ${i.description?`<div style="font-size:12px;color:var(--text);margin-top:2px">📝 ${escapeHtml(i.description)}</div>`:''}
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${_ccMonthLabel(i.inv_month,i.inv_year)} · ${_ccUploaderChip(i)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:14px;flex-shrink:0">
          <span style="font-weight:800;color:var(--green);font-variant-numeric:tabular-nums">${_ccMoney(i.amount)}</span>
          <span class="cc-pool-prev" data-inv="${i.id}" style="font-size:13px;cursor:pointer" title="preview">👁</span>
          <span class="cc-pool-edit" data-inv="${i.id}" style="font-size:13px;cursor:pointer" title="แก้ไข">✏️</span>
          <span class="cc-pool-del" data-inv="${i.id}" style="font-size:12px;color:var(--critical);cursor:pointer">ลบ</span>
        </div>
      </div>`; }).join('');
    le.querySelectorAll('.cc-pool-prev').forEach(x=>x.addEventListener('click',()=>{ const inv=byId[parseInt(x.dataset.inv,10)]; if(inv) _ccPreviewInvoice(inv); }));
    le.querySelectorAll('.cc-pool-edit').forEach(x=>x.addEventListener('click',()=>{ const inv=byId[parseInt(x.dataset.inv,10)]; if(inv) _ccEditInvoice(inv,()=>_ccRenderPool($('cc-view'))); }));
    le.querySelectorAll('.cc-pool-del').forEach(x=>x.addEventListener('click',async()=>{ if(!confirm('ลบใบเสร็จนี้?'))return; await fetchJson('/api/creditcard/invoices/'+x.dataset.inv,{method:'DELETE'}); _ccRenderPool($('cc-view')); }));
  };
  renderFilter(); paint();
}

// ---- summary (completeness per bill + navigate bills) ----
async function _ccRenderSummary(v){
  const bills=_ccState.bills;
  if(!bills.length){ v.innerHTML='<div class="empty">ยังไม่มีบิล</div>'; return; }
  if(!_ccState.summaryBillId||!bills.find(b=>b.id===_ccState.summaryBillId)) _ccState.summaryBillId=bills[0].id;
  v.innerHTML=`
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <span style="font-size:12.5px;color:var(--text-muted)">เลือกบิล:</span>
      <select id="cc-sum-bill" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);min-width:240px">
        ${bills.map(b=>`<option value="${b.id}" ${b.id===_ccState.summaryBillId?'selected':''}>${escapeHtml(b.card_number||'บัตร')} · ${_ccMonthLabel(b.bill_month,b.bill_year)} ${b.txn_count&&b.matched_txn>=b.txn_count?'✓':''}</option>`).join('')}
      </select>
    </div>
    <div id="cc-sum-body"><div class="empty">กำลังโหลด…</div></div>`;
  $('cc-sum-bill').onchange=(e)=>{ _ccState.summaryBillId=parseInt(e.target.value,10); _ccRenderSummary(v); };
  let d; try{ d=await fetchJson('/api/creditcard/bills/'+_ccState.summaryBillId); }
  catch(e){ $('cc-sum-body').innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`; return; }
  const invById={}; d.invoices.forEach(i=>invById[i.id]=i);
  const matchByTxn={}; d.matches.forEach(m=>{ (matchByTxn[m.transaction_id]=matchByTxn[m.transaction_id]||[]).push(invById[m.invoice_id]); });
  const total=d.transactions.length, matched=Object.keys(matchByTxn).filter(k=>matchByTxn[k].length).length, unmatched=total-matched;
  const txnTotal=d.transactions.reduce((s,t)=>s+(t.amount||0),0);
  const invTotal=d.invoices.reduce((s,i)=>s+(i.amount||0),0);
  const matchedInvIds=new Set(d.matches.map(m=>m.invoice_id));
  const unusedInv=d.invoices.filter(i=>!matchedInvIds.has(i.id)).length;
  // v1.9.223 — platform ของแต่ละรายการ (จาก description ก่อน, ไม่เจอลองจาก invoice ที่จับคู่, สุดท้าย 'อื่น ๆ')
  const platOf=(t)=>{
    const p=_ccDetectPlatform(t.description||''); if(p) return p;
    for(const i of (matchByTxn[t.id]||[])){ if(i){ const q=_ccDetectPlatform(i.company||''); if(q) return q; } }
    return 'อื่น ๆ';
  };
  const platCount={}; d.transactions.forEach(t=>{ const p=platOf(t); platCount[p]=(platCount[p]||0)+1; });
  const orderedPlats=[...Object.keys(platCount).filter(p=>p!=='อื่น ๆ').sort(), ...(platCount['อื่น ๆ']?['อื่น ๆ']:[])];
  // v1.9.317 — Summary: แสดง user_note ของรายการในบัตร + แก้ไข inline เหมือนหน้า bill detail
  const rows=d.transactions.map(t=>{
    const ms=matchByTxn[t.id]||[]; const ok=ms.length>0;
    const invSum=ms.reduce((s,i)=>s+((i&&i.amount)||0),0); const diff=Math.abs(invSum-(t.amount||0));
    const invCells=ms.length
      ? ms.map(i=>i?`<span class="cc-sum-prev" data-inv="${i.id}" title="ดู PDF / ไฟล์" style="cursor:pointer;color:var(--primary);border-bottom:1px dashed var(--primary);white-space:nowrap">👁 ${escapeHtml(i.company||'invoice')} ${_ccMoney(i.amount)}</span>`:'invoice').join('<br>')
      : '<span style="color:var(--text-muted)">— ยังไม่จับคู่ —</span>';
    const ownerCells=ms.length
      ? ms.map(i=>i?`<div style="margin-bottom:4px">${i.description?`<div style="font-size:13px;color:var(--text)">📝 ${escapeHtml(i.description)}</div>`:'<span style="font-size:11px;color:var(--text-muted)">— ไม่มีรายละเอียด —</span>'}<div style="font-size:10.5px;color:var(--text-muted)">${_ccUploaderChip(i,13)}</div></div>`:'').join('')
      : '<span style="color:var(--text-muted);font-size:12px">—</span>';
    const un=t.user_note||'';
    const noteHtml=`<div class="cc-sum-note" style="${un?'':'display:none;'}font-size:11px;color:var(--text-muted);margin-top:3px;font-style:italic">${un?'📝 '+escapeHtml(un):''}</div>`;
    const editHtml=`<div class="cc-sum-edit" style="display:none;margin-top:6px;gap:6px;align-items:center">
      <input class="cc-sum-input" type="text" value="${escapeHtml(un)}" placeholder="ใส่ description..." maxlength="500" style="flex:1;font-size:12px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);min-width:0" />
      <button type="button" class="btn cc-sum-save" title="บันทึก (Enter)" style="font-size:13px;padding:4px 9px;line-height:1;color:var(--green)">✓</button>
      <button type="button" class="btn cc-sum-cancel" title="ยกเลิก (Esc)" style="font-size:13px;padding:4px 9px;line-height:1">✕</button>
    </div>`;
    return `<tr data-platform="${escapeHtml(platOf(t))}" data-txn="${t.id}" style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 3px;text-align:center;width:18px;vertical-align:top">${ok?'<span style="color:var(--green);font-weight:800">✓</span>':'<span style="color:var(--critical);font-weight:800">✗</span>'}</td>
      <td style="padding:7px 8px;font-size:12.5px;vertical-align:top">
        <div class="cc-sum-desc" style="cursor:pointer" title="คลิกเพื่อเพิ่ม/แก้ไข description">
          ${escapeHtml(t.description||'—')}
          <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(t.txn_date||'')}</div>
          ${noteHtml}
        </div>
        ${editHtml}
      </td>
      <td style="padding:7px 8px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;vertical-align:top">${_ccMoney(t.amount)}</td>
      <td style="padding:7px 8px;font-size:12px;vertical-align:top">${invCells}</td>
      <td style="padding:7px 8px;vertical-align:top">${ownerCells}</td>
      <td style="padding:7px 8px;text-align:right;font-size:12px;white-space:nowrap;vertical-align:top;${ok&&diff>0.01?'color:#92400e;font-weight:700':''}">${ok?(diff>0.01?'Δ '+_ccMoney(diff):'ตรง'):''}</td>
    </tr>`;
  }).join('');
  const filterChips=`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
    <span style="font-size:11.5px;color:var(--text-muted)">กรองตาม platform:</span>
    <button class="btn cc-sum-filter" data-plat="" style="font-size:12px">ทั้งหมด (${total})</button>
    ${orderedPlats.map(p=>`<button class="btn cc-sum-filter" data-plat="${escapeHtml(p)}" style="font-size:12px">${escapeHtml(p)} (${platCount[p]})</button>`).join('')}
  </div>`;
  $('cc-sum-body').innerHTML=`
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin-bottom:16px">
      ${_ccStat('รายการทั้งหมด',total)}
      ${_ccStat('จับคู่แล้ว',matched,'var(--green)')}
      ${_ccStat('ยังไม่จับคู่',unmatched,unmatched?'#92400e':'var(--text)')}
      ${_ccStat('ยอดบัตรรวม',_ccMoney(txnTotal))}
      ${_ccStat('ยอด invoice รวม',_ccMoney(invTotal))}
      ${_ccStat('invoice ยังไม่ใช้',unusedInv,unusedInv?'#92400e':'var(--text)')}
    </div>
    ${filterChips}
    <div style="overflow-x:auto"><table id="cc-sum-table" style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase">
        <th style="padding:6px 3px;width:18px"></th><th style="padding:6px 8px">รายการบัตร</th><th style="padding:6px 8px;text-align:right">ยอด</th><th style="padding:6px 8px">Invoice / Receipt</th><th style="padding:6px 8px">รายละเอียด / เจ้าของ</th><th style="padding:6px 8px;text-align:right">ผลต่าง</th>
      </tr></thead><tbody>${rows||'<tr><td colspan="6" style="padding:14px;text-align:center;color:var(--text-muted)">ไม่มีรายการ</td></tr>'}</tbody>
    </table></div>`;
  v.querySelectorAll('.cc-sum-prev').forEach(x=>x.addEventListener('click',()=>{ const inv=invById[parseInt(x.dataset.inv,10)]; if(inv) _ccPreviewInvoice(inv); }));
  // v1.9.317 — inline edit user_note ใน Summary
  v.querySelectorAll('.cc-sum-desc').forEach(el=>el.addEventListener('click',(e)=>{
    e.stopPropagation();
    const tr=el.closest('tr[data-txn]'); if(!tr) return;
    const editEl=tr.querySelector('.cc-sum-edit'); if(!editEl) return;
    const isOpen=editEl.style.display==='flex';
    v.querySelectorAll('.cc-sum-edit').forEach(x=>{ x.style.display='none'; });
    if(!isOpen){ editEl.style.display='flex'; const inp=editEl.querySelector('.cc-sum-input'); if(inp){ inp.focus(); inp.select(); } }
  }));
  const _ccSaveSumNote=async(tr)=>{
    const tid=parseInt(tr.dataset.txn,10);
    const inp=tr.querySelector('.cc-sum-input'); if(!inp) return;
    const saveBtn=tr.querySelector('.cc-sum-save'); if(saveBtn) saveBtn.disabled=true;
    try{
      const r=await fetchJson('/api/creditcard/transactions/'+tid,{method:'PATCH',body:JSON.stringify({user_note:inp.value})});
      const newNote=r.user_note||'';
      const t=d.transactions.find(x=>x.id===tid); if(t) t.user_note=newNote;
      const noteEl=tr.querySelector('.cc-sum-note');
      if(noteEl){ if(newNote){ noteEl.style.display=''; noteEl.innerHTML='📝 '+escapeHtml(newNote); } else { noteEl.style.display='none'; noteEl.textContent=''; } }
      tr.querySelector('.cc-sum-edit').style.display='none';
    }catch(err){ alert(err.message); }
    finally{ if(saveBtn) saveBtn.disabled=false; }
  };
  v.querySelectorAll('.cc-sum-save').forEach(b=>b.addEventListener('click',(e)=>{ e.stopPropagation(); _ccSaveSumNote(b.closest('tr[data-txn]')); }));
  v.querySelectorAll('.cc-sum-cancel').forEach(b=>b.addEventListener('click',(e)=>{
    e.stopPropagation();
    const tr=b.closest('tr[data-txn]'); if(!tr) return;
    const t=d.transactions.find(x=>x.id===parseInt(tr.dataset.txn,10));
    const inp=tr.querySelector('.cc-sum-input'); if(inp&&t) inp.value=t.user_note||'';
    tr.querySelector('.cc-sum-edit').style.display='none';
  }));
  v.querySelectorAll('.cc-sum-input').forEach(inp=>{
    inp.addEventListener('click',e=>e.stopPropagation());
    inp.addEventListener('keydown',(e)=>{
      if(e.key==='Enter'){ e.preventDefault(); _ccSaveSumNote(inp.closest('tr[data-txn]')); }
      else if(e.key==='Escape'){ e.preventDefault(); inp.closest('tr[data-txn]').querySelector('.cc-sum-cancel').click(); }
    });
  });
  const applyFilter=(plat)=>{
    v.querySelectorAll('.cc-sum-filter').forEach(b=>b.classList.toggle('primary', b.dataset.plat===plat));
    v.querySelectorAll('#cc-sum-table tbody tr[data-platform]').forEach(tr=>{ tr.style.display=(!plat||tr.dataset.platform===plat)?'':'none'; });
  };
  v.querySelectorAll('.cc-sum-filter').forEach(b=>b.addEventListener('click',()=>applyFilter(b.dataset.plat)));
  applyFilter('');
}
function _ccStat(label,val,color){
  return `<div class="card" style="padding:10px 12px"><div style="font-size:11px;color:var(--text-muted)">${label}</div><div style="font-size:18px;font-weight:800;${color?'color:'+color:''}">${val}</div></div>`;
}

// ===== Claude RateLimit (Platform tab) =====
let _clrlSub = 'dashboard';
async function renderClaudeRL() {
  const root = $('claude-rl-root');
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap">
      <div style="display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden">
        <button class="clrl-sub-btn" data-sub="dashboard" style="border:0;padding:8px 16px;font-size:13px;cursor:pointer">📊 Dashboard</button>
        <button class="clrl-sub-btn" data-sub="settings" style="border:0;padding:8px 16px;font-size:13px;cursor:pointer">⚙️ Settings</button>
      </div>
      <div style="flex:1"></div>
      <div style="font-size:11px;color:var(--text-soft)">⏱️ ติดตาม usage/limit ของ Claude.ai subscription (ใช้ส่วนตัว)</div>
    </div>
    <div id="clrl-body"><div class="empty">กำลังโหลด…</div></div>`;
  root.querySelectorAll('.clrl-sub-btn').forEach(b => {
    const on = b.dataset.sub === _clrlSub;
    b.style.background = on ? 'var(--primary)' : 'var(--bg-card)';
    b.style.color = on ? '#fff' : 'var(--text-muted)';
    b.style.fontWeight = on ? '700' : '500';
    b.onclick = () => { _clrlSub = b.dataset.sub; renderClaudeRL(); };
  });
  if (_clrlSub === 'settings') _clrlRenderSettings(); else _clrlRenderDashboard();
}
function _clrlBadge(a) {
  // โหมด local-runner: ดูจาก session_status + snapshot ล่าสุด (ไม่ใช้ has_session)
  const L = a.latest;
  if (a.session_status === 'expired' || (L && L.status === 'expired'))
    return { t: '⚠️ Session expired', c: '#b45309', bg: 'rgba(245,158,11,.15)' };
  if (!L) return { t: '⏱ ยังไม่เคยเช็ค', c: 'var(--text-muted)', bg: 'var(--bg-soft)' };
  if (L.status === 'full') return { t: '🔴 Limit reached', c: '#dc2626', bg: 'rgba(220,38,38,.12)' };
  if (L.status === 'error') return { t: '⚠️ Error', c: '#b45309', bg: 'rgba(245,158,11,.15)' };
  return { t: '✅ OK', c: '#16a34a', bg: 'rgba(22,163,74,.12)' };
}
function _clrlPct(p) { return p == null ? '—' : (Math.round(p) + '%'); }
function _clrlBar(p, color) {
  const v = p == null ? 0 : Math.max(0, Math.min(100, p));
  return `<div style="height:7px;border-radius:999px;background:var(--bg-soft);overflow:hidden;margin-top:3px"><div style="height:100%;width:${v}%;background:${color}"></div></div>`;
}
function _clrlTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  return isNaN(d.getTime()) ? escapeHtml(String(t)) : d.toLocaleString('th-TH');
}
async function _clrlRenderDashboard() {
  const body = $('clrl-body'); if (!body) return;
  let d;
  try { d = await fetchJson('/api/claude-ratelimit'); }
  catch (e) { body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  if (!d.accounts || !d.accounts.length) {
    body.innerHTML = `<div class="empty" style="padding:30px;text-align:center">ยังไม่มี account — ไปที่ <b>⚙️ Settings</b> เพื่อเพิ่มและอัปโหลด session</div>`;
    return;
  }
  const cards = d.accounts.map(a => {
    const b = _clrlBadge(a), L = a.latest || {};
    return `<div class="card" style="display:block">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.label)}</div>
        <span style="font-size:11.5px;font-weight:700;padding:3px 11px;border-radius:999px;background:${b.bg};color:${b.c};white-space:nowrap">${b.t}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div>
          <div style="font-size:11px;color:var(--text-muted)">Session (5h) · <b>${_clrlPct(L.session_pct)}</b></div>
          ${_clrlBar(L.session_pct, '#2563eb')}
          <div style="font-size:10px;color:var(--text-soft);margin-top:4px">reset: ${_clrlTime(L.session_reset_at)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">Weekly · <b>${_clrlPct(L.weekly_pct)}</b>${L.weekly_opus_pct != null ? ` · Opus ${_clrlPct(L.weekly_opus_pct)}` : ''}</div>
          ${_clrlBar(L.weekly_pct, '#8b5cf6')}
          <div style="font-size:10px;color:var(--text-soft);margin-top:4px">reset: ${_clrlTime(L.weekly_reset_at)}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;gap:8px">
        <span style="font-size:10.5px;color:var(--text-soft)">last checked: ${L.checked_at ? _clrlTime(L.checked_at) : 'ยังไม่เคย'}</span>
        <button class="btn clrl-refresh" style="font-size:12px;padding:6px 12px">🔄 รีเฟรช</button>
      </div>
    </div>`;
  }).join('');
  body.innerHTML = `<div style="font-size:10.5px;color:var(--text-soft);margin-bottom:10px">⏱️ เช็คอัตโนมัติจากเครื่อง local ทุกชั่วโมง (cron) · กดรีเฟรชเพื่อดึงค่าล่าสุด</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px">${cards}</div>`;
  body.querySelectorAll('.clrl-refresh').forEach(btn => { btn.onclick = () => _clrlRenderDashboard(); });
}
async function _clrlRenderSettings() {
  const body = $('clrl-body'); if (!body) return;
  let accs, st;
  try { accs = (await fetchJson('/api/claude-ratelimit/accounts')).accounts || []; st = await fetchJson('/api/claude-ratelimit/settings'); }
  catch (e) { body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const stBadge = s => s === 'healthy' ? '<span style="color:#16a34a;font-weight:700">healthy</span>' : s === 'expired' ? '<span style="color:#dc2626;font-weight:700">expired · re-auth</span>' : '<span style="color:var(--text-soft)">ยังไม่มี session</span>';
  const accRows = accs.map(a => `
    <div class="card" style="display:block" data-acc="${a.id}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input class="clrl-label" value="${escapeHtml(a.label)}" style="flex:1;min-width:160px;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)">
        <span style="font-size:11.5px">session: ${stBadge(a.session_status)}</span>
        <button class="btn clrl-save-label" style="font-size:12px;padding:6px 11px">💾</button>
        <button class="btn clrl-del" style="font-size:12px;padding:6px 11px;color:#dc2626">🗑</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px">อัปโหลด/วาง <b>storageState JSON</b> (จาก scripts/save_session.py) ${a.has_session ? '· <span style="color:#16a34a">มี session แล้ว</span>' : ''}</div>
      <input type="file" class="clrl-file" accept=".json,application/json" style="font-size:12px;margin-bottom:6px">
      <textarea class="clrl-ss" placeholder='วาง JSON เช่น {"cookies":[...],"origins":[...]}' style="width:100%;height:64px;font-size:11px;font-family:ui-monospace,Menlo,monospace;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);resize:vertical"></textarea>
      <div style="text-align:right;margin-top:6px"><button class="btn clrl-save-ss" style="font-size:12px;padding:6px 13px">📤 บันทึก session</button></div>
    </div>`).join('');
  const a2 = st.alert || {};
  body.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <input id="clrl-new-label" placeholder="ชื่อ account ใหม่ (label)" style="flex:1;padding:9px 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text)">
      <button class="btn" id="clrl-add" style="font-size:13px;padding:9px 16px">+ เพิ่ม account</button>
    </div>
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">Accounts (${accs.length})</div>
    ${accRows || '<div class="empty" style="padding:18px">— ยังไม่มี account —</div>'}
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin:18px 0 8px">⚙️ การตั้งค่า / แจ้งเตือน</div>
    <div class="card" style="display:block">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label style="font-size:12px;color:var(--text-muted)">Check interval (cron)<br><input id="clrl-cron" value="${escapeHtml(st.check_cron || '0 * * * *')}" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:ui-monospace,monospace;font-size:12px"></label>
        <label style="font-size:12px;color:var(--text-muted)">Alert threshold (%)<br><input id="clrl-thr" type="number" min="1" max="100" value="${st.threshold_pct || 90}" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)"></label>
        <label style="font-size:12px;color:var(--text-muted);grid-column:1/3">Webhook URL (Teams / Power Automate / generic — POST {"text":...})<br><input id="clrl-webhook" value="${escapeHtml(a2.webhook_url || '')}" placeholder="https://..." style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)"></label>
        <label style="font-size:12px;color:var(--text-muted)">LINE token ${a2.line_token_set ? '· <span style="color:#16a34a">ตั้งไว้แล้ว</span>' : ''}<br><input id="clrl-linetoken" type="password" placeholder="${a2.line_token_set ? 'เว้นว่าง = คงเดิม' : 'channel access token'}" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)"></label>
        <label style="font-size:12px;color:var(--text-muted)">LINE to (userId/groupId — เว้นว่าง=broadcast)<br><input id="clrl-lineto" value="${escapeHtml(a2.line_to || '')}" style="width:100%;margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)"></label>
        <label style="font-size:12px;color:var(--text-muted)">Quiet hours (เริ่ม)<br><input id="clrl-qs" type="time" value="${escapeHtml(a2.quiet_start || '')}" style="margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)"></label>
        <label style="font-size:12px;color:var(--text-muted)">Quiet hours (สิ้นสุด)<br><input id="clrl-qe" type="time" value="${escapeHtml(a2.quiet_end || '')}" style="margin-top:3px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)"></label>
      </div>
      ${a2.line_token_set ? '<label style="font-size:11px;color:var(--text-soft);display:block;margin-top:8px"><input type="checkbox" id="clrl-clear-token"> ลบ LINE token ที่ตั้งไว้</label>' : ''}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn" id="clrl-save-cfg" style="font-size:13px;padding:8px 16px">💾 บันทึกการตั้งค่า</button>
        <button class="btn" id="clrl-test" style="font-size:13px;padding:8px 16px">🔔 Test alert</button>
      </div>
      <div style="font-size:10.5px;color:var(--text-soft);margin-top:10px;line-height:1.6">⚠️ การเช็คจริงทำโดย <b>worker service แยก</b> (Playwright headless) ตาม cron · session = credential เต็ม เก็บแบบเข้ารหัส ไม่ commit/ไม่ log · ดู <code style="background:var(--bg-soft);padding:1px 5px;border-radius:4px">README</code> + <code style="background:var(--bg-soft);padding:1px 5px;border-radius:4px">scripts/save_session.py</code></div>
    </div>`;
  // add account
  const add = $('clrl-add');
  if (add) add.onclick = async () => {
    const lbl = $('clrl-new-label').value.trim();
    if (!lbl) { alert('ใส่ชื่อ account'); return; }
    try { await fetchJson('/api/claude-ratelimit/accounts', { method: 'POST', body: JSON.stringify({ label: lbl }) }); _clrlRenderSettings(); }
    catch (e) { alert('เพิ่มไม่สำเร็จ: ' + e.message); }
  };
  // per-account handlers
  body.querySelectorAll('[data-acc]').forEach(card => {
    const id = card.dataset.acc;
    const fileEl = card.querySelector('.clrl-file'), ssEl = card.querySelector('.clrl-ss');
    if (fileEl) fileEl.onchange = () => { const f = fileEl.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { ssEl.value = r.result; }; r.readAsText(f); };
    card.querySelector('.clrl-save-label').onclick = async () => {
      const lbl = card.querySelector('.clrl-label').value.trim(); if (!lbl) return;
      try { await fetchJson('/api/claude-ratelimit/accounts/' + id, { method: 'PUT', body: JSON.stringify({ label: lbl }) }); alert('บันทึกชื่อแล้ว'); }
      catch (e) { alert('ไม่สำเร็จ: ' + e.message); }
    };
    card.querySelector('.clrl-del').onclick = async () => {
      if (!confirm('ลบ account นี้?')) return;
      try { await fetchJson('/api/claude-ratelimit/accounts/' + id, { method: 'DELETE' }); _clrlRenderSettings(); }
      catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
    };
    card.querySelector('.clrl-save-ss').onclick = async () => {
      const ss = ssEl.value.trim(); if (!ss) { alert('วางหรืออัปโหลดไฟล์ storageState ก่อน'); return; }
      try { const r = await fetchJson('/api/claude-ratelimit/accounts/' + id + '/session', { method: 'POST', body: JSON.stringify({ storage_state: ss }) }); alert('บันทึก session แล้ว (' + r.cookies + ' cookies)'); _clrlRenderSettings(); }
      catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message); }
    };
  });
  // save config + test
  $('clrl-save-cfg').onclick = async () => {
    const tokEl = $('clrl-linetoken'), clearTok = $('clrl-clear-token');
    let line_token = null;
    if (clearTok && clearTok.checked) line_token = '';
    else if (tokEl.value) line_token = tokEl.value;
    const payload = {
      check_cron: $('clrl-cron').value, threshold_pct: parseFloat($('clrl-thr').value) || 90,
      webhook_url: $('clrl-webhook').value, line_to: $('clrl-lineto').value,
      quiet_start: $('clrl-qs').value, quiet_end: $('clrl-qe').value,
    };
    if (line_token !== null) payload.line_token = line_token;
    try { await fetchJson('/api/claude-ratelimit/settings', { method: 'POST', body: JSON.stringify(payload) }); alert('บันทึกการตั้งค่าแล้ว'); _clrlRenderSettings(); }
    catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message); }
  };
  $('clrl-test').onclick = async () => {
    try { const r = await fetchJson('/api/claude-ratelimit/test-alert', { method: 'POST' }); alert('ส่ง test alert แล้ว' + (r.note ? ' (' + r.note + ')' : '')); }
    catch (e) { alert('ส่งไม่สำเร็จ: ' + e.message); }
  };
}
// ===== Campaign (รายการแคมเปญจาก Google Sheet) =====
async function renderAdsCampaigns() {
  _subMain().innerHTML = `
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn" id="camp-refresh" style="font-size:13px;padding:8px 14px">🔄 รีเฟรช</button>
    </div>
    <div id="camp-body"><div class="empty">กำลังโหลด…</div></div>`;
  const rb = $('camp-refresh');
  if (rb) rb.onclick = () => loadCampaigns();
  loadCampaigns();
}
async function loadCampaigns() {
  const body = $('camp-body');
  if (!body) return;
  body.innerHTML = '<div class="empty">⏳ กำลังดึงจาก Google Sheet…</div>';
  try { _campData = await fetchJson('/api/ads-campaigns'); }
  catch (e) {
    const msg = e.message || '';
    if (/แชร์|สาธารณะ|HTTP 502/.test(msg)) {
      body.innerHTML = `<div class="card" style="display:block;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.06)">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">⚠️ อ่าน Google Sheet ไม่ได้</div>
        <div style="font-size:13.5px;color:var(--text-muted);line-height:1.7">${escapeHtml(msg)}<br>เปิดชีต → <strong>Share</strong> → <strong>Anyone with the link</strong> → <strong>Viewer</strong></div></div>`;
      return;
    }
    body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(msg)}</div>`;
    return;
  }
  renderCampaignsBody();
}
function renderCampaignsBody() {
  const body = $('camp-body');
  if (!body || !_campData) return;
  const all = _campData.campaigns || [];
  if (all.length === 0) {
    body.innerHTML = '<div class="empty" style="padding:30px;text-align:center">— ไม่มีรายการแคมเปญในชีต —</div>';
    return;
  }
  const objs = _campData.objectives || [];
  const inStyle = 'padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text)';
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <span style="font-size:12px;color:var(--text-soft)">📅 เดือน</span>
      <input type="month" id="camp-from" value="${escapeHtml(_campFrom)}" title="เดือนเริ่ม" style="${inStyle}">
      <span style="color:var(--text-soft)">–</span>
      <input type="month" id="camp-to" value="${escapeHtml(_campTo)}" title="เดือนสิ้นสุด" style="${inStyle}">
      <select id="camp-bid" style="${inStyle};cursor:pointer">
        <option value="__all__">🙋 ทุกคน (Bid.)</option>
        ${(_campData.bids || []).map(b => `<option value="${escapeHtml(b)}" ${_campBid === b ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
      </select>
      <select id="camp-obj" style="${inStyle};cursor:pointer">
        <option value="__all__">🎯 ทุก Objective</option>
        ${objs.map(o => `<option value="${escapeHtml(o)}" ${_campObj === o ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}
      </select>
      <input id="camp-search" type="text" value="${escapeHtml(_campSearch)}" placeholder="🔍 ค้นหาแคมเปญ..." autocomplete="off" style="${inStyle};min-width:170px">
      <button class="btn" id="camp-clear" style="font-size:12.5px;padding:7px 12px">ล้าง</button>
      <div style="display:inline-flex;border:1px solid var(--border);border-radius:9px;overflow:hidden;margin-left:auto">
        <button class="camp-view-btn" data-view="gantt" style="border:0;padding:7px 13px;font-size:12.5px;cursor:pointer">📊 Gantt</button>
        <button class="camp-view-btn" data-view="table" style="border:0;padding:7px 13px;font-size:12.5px;cursor:pointer">📋 ตาราง</button>
      </div>
    </div>
    <div id="camp-cards"></div>`;
  const f = $('camp-from'), t = $('camp-to'), ob = $('camp-obj'), bd = $('camp-bid'), si = $('camp-search'), cl = $('camp-clear');
  if (f) f.onchange = () => { _campFrom = f.value; renderCampaignsTable(); };
  if (t) t.onchange = () => { _campTo = t.value; renderCampaignsTable(); };
  if (ob) ob.onchange = () => { _campObj = ob.value; renderCampaignsTable(); };
  if (bd) bd.onchange = () => { _campBid = bd.value; renderCampaignsTable(); };
  if (si) { let _tm; si.addEventListener('input', e => { clearTimeout(_tm); const val = e.target.value; _tm = setTimeout(() => { _campSearch = val; renderCampaignsTable(); }, 220); }); }
  if (cl) cl.onclick = () => { _campFrom = ''; _campTo = ''; _campObj = '__all__'; _campBid = '__all__'; _campSearch = ''; renderCampaignsBody(); };
  _subMain().querySelectorAll('.camp-view-btn').forEach(b => {
    const on = b.dataset.view === _campView;
    b.style.background = on ? 'var(--primary)' : 'var(--bg-card)';
    b.style.color = on ? '#fff' : 'var(--text-muted)';
    b.style.fontWeight = on ? '700' : '500';
    b.onclick = () => { if (_campView !== b.dataset.view) { _campView = b.dataset.view; renderCampaignsBody(); } };
  });
  renderCampaignsTable();
}
function _campInRange(c, from, to) {
  if (!from && !to) return true;
  if (!c.start && !c.end) return true;   // ไม่มีวันที่ → ไม่กรองออก
  const s = c.start || c.end, e = c.end || c.start;
  if (from && e < from) return false;
  if (to && s > to) return false;
  return true;
}
function renderCampaignsTable() {
  const wrap = $('camp-cards');
  if (!wrap || !_campData) return;
  const q = _campSearch.trim().toLowerCase();
  // filter เดือน: แปลงเป็นช่วงวันที่ (ต้นเดือน – ปลายเดือน)
  const fromD = _campFrom ? _campFrom + '-01' : '';
  const toD = _campTo ? _campTo + '-31' : '';
  _campFiltered = (_campData.campaigns || []).filter(c =>
    (_campObj === '__all__' || c.objective === _campObj) &&
    (_campBid === '__all__' || c.bid === _campBid) &&
    _campInRange(c, fromD, toD) &&
    (!q || (c.name || '').toLowerCase().includes(q))
  );
  // เรียงวันที่ล่าสุดอยู่บนสุด (start desc) — ไม่มีวันที่ไปท้าย
  _campFiltered.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  if (_campFiltered.length === 0) {
    wrap.innerHTML = '<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">— ไม่พบแคมเปญที่ตรงกับตัวกรอง —</div>';
    return;
  }
  if (_campView === 'gantt') { _renderGantt(wrap); return; }
  const rows = _campFiltered.map((c, i) => {
    const dateCell = c.start_txt
      ? `<div style="font-weight:700;font-size:13px;color:var(--primary);white-space:nowrap">📅 ${escapeHtml(c.start_txt)}</div>${c.end_txt ? `<div style="font-size:10.5px;color:var(--text-soft);white-space:nowrap">ถึง ${escapeHtml(c.end_txt)}</div>` : ''}`
      : `<div style="font-weight:600;white-space:nowrap">${escapeHtml(c.period || '—')}</div>`;
    return `
    <tr class="camp-row" data-idx="${i}" style="cursor:pointer">
      <td>
        <div style="font-weight:600">${escapeHtml(c.name)}</div>
        ${c.objective ? `<div style="font-size:10px;color:var(--text-soft);margin-top:1px">🎯 ${escapeHtml(c.objective)}</div>` : ''}
      </td>
      <td>${dateCell}</td>
      <td class="tnum" style="font-weight:600">${escapeHtml(c.budget || '—')}</td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `
    <div style="font-size:11.5px;color:var(--text-soft);margin-bottom:8px">${_campFiltered.length} / ${(_campData.campaigns || []).length} แคมเปญ · 👆 คลิกเพื่อดูรายละเอียด</div>
    <div class="card" style="display:block;padding:0;overflow-x:auto">
      <table class="ads-table" style="min-width:max-content">
        <thead><tr><th style="text-align:left">Campaign Name</th><th style="text-align:left">Period</th><th style="text-align:right">Budget</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  wrap.querySelectorAll('.camp-row').forEach(row => {
    row.addEventListener('click', () => { const c = _campFiltered[parseInt(row.dataset.idx, 10)]; if (c) openCampaignPanel(c); });
  });
}
// v1.9.204 — Gantt: ยุบตาม Project Code → กด + ขยายเห็น Objective (objective เดียวกันยุบเป็น 1 แท่ง)
function _renderGantt(wrap) {
  const allGroups = _campGroupProjects(_campFiltered);
  const groups = allGroups.filter(g => g.start && g.end).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const undatedG = allGroups.length - groups.length;
  if (groups.length === 0) {
    wrap.innerHTML = `<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">— ไม่มีโปรเจกต์ที่มีวันที่สำหรับ Gantt —</div>`;
    return;
  }
  const DAY = 86400000;
  const dayOf = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY);
  let minD = Infinity, maxD = -Infinity;
  groups.forEach(g => { const s = dayOf(g.start), e = dayOf(g.end); if (s < minD) minD = s; if (e > maxD) maxD = e; });
  const dMin = new Date(minD * DAY), dMax = new Date(maxD * DAY);
  minD = Math.round(Date.UTC(dMin.getUTCFullYear(), dMin.getUTCMonth(), 1) / DAY);
  maxD = Math.round(Date.UTC(dMax.getUTCFullYear(), dMax.getUTCMonth() + 1, 0) / DAY);
  const totalDays = Math.max(maxD - minD + 1, 1);
  const PX = 2.6, labelW = 250, rowH = 26, headH = 26;
  const tlW = Math.max(Math.round(totalDays * PX), 360);
  const MN = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const ticks = [];
  let cur = minD;
  while (cur <= maxD) {
    const dt = new Date(cur * DAY);
    ticks.push({ left: (cur - minD) * PX, label: `${MN[dt.getUTCMonth()]} ${String(dt.getUTCFullYear()).slice(2)}` });
    cur = Math.round(Date.UTC(dt.getUTCMonth() === 11 ? dt.getUTCFullYear() + 1 : dt.getUTCFullYear(), (dt.getUTCMonth() + 1) % 12, 1) / DAY);
  }
  const gridlines = ticks.map(t => `<div style="position:absolute;top:0;bottom:0;left:${t.left.toFixed(1)}px;width:1px;background:var(--border);opacity:.55"></div>`).join('');
  const axis = ticks.map(t => `<div style="position:absolute;left:${(t.left + 3).toFixed(1)}px;top:6px;font-size:9.5px;color:var(--text-soft);white-space:nowrap">${t.label}</div>`).join('');
  const money = n => n ? n.toLocaleString('th-TH') : '';
  // สร้างแถวที่มองเห็น (project + objective ที่ขยาย)
  const vis = [];
  groups.forEach((g, gi) => {
    vis.push({ kind: 'proj', gi });
    if (_campExpanded.has(g.key)) {
      g.objectives.filter(o => o.start && o.end).forEach((o, oi) => vis.push({ kind: 'obj', gi, oi }));
    }
  });
  const labelRows = vis.map(v => {
    const g = groups[v.gi];
    if (v.kind === 'proj') {
      const open = _campExpanded.has(g.key);
      const bsum = g.ads.reduce((s, a) => s + _campBudgetNum(a.budget), 0);
      return `<div class="gantt-row" data-k="proj" data-gi="${v.gi}" style="height:${rowH}px;display:flex;align-items:center;gap:5px;padding:0 8px;border-bottom:1px solid var(--border);cursor:pointer;background:var(--bg-soft);overflow:hidden">
        <span style="width:15px;flex-shrink:0;text-align:center;font-weight:700;color:var(--primary)">${open ? '−' : '+'}</span>
        <span style="font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(g.code + ' ' + g.name)}">${escapeHtml(g.code)} <span style="font-weight:400;color:var(--text-soft)">${escapeHtml(g.name)}</span></span>
        <span style="font-size:9px;color:var(--text-soft);flex-shrink:0">· ${g.objectives.length} obj${bsum ? ' · 💰' + money(bsum) : ''}</span>
      </div>`;
    }
    const o = g.objectives[v.oi];
    const bsum = o.ads.reduce((s, a) => s + _campBudgetNum(a.budget), 0);
    return `<div class="gantt-row" data-k="obj" data-gi="${v.gi}" data-oi="${v.oi}" style="height:${rowH}px;display:flex;align-items:center;gap:6px;padding:0 8px 0 26px;border-bottom:1px solid var(--border);cursor:pointer;overflow:hidden">
      <span style="width:9px;height:9px;border-radius:2px;background:${_campObjColor(o.objective)};flex-shrink:0"></span>
      <span style="font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(o.objective)}</span>
      <span style="font-size:9px;color:var(--text-soft);flex-shrink:0">· ${o.ads.length} ads${bsum ? ' · 💰' + money(bsum) : ''}</span>
    </div>`;
  }).join('');
  const barRows = vis.map(v => {
    const g = groups[v.gi];
    if (v.kind === 'proj') {
      const s = dayOf(g.start) - minD, e = dayOf(g.end) - minD;
      const left = s * PX, w = Math.max((e - s + 1) * PX, 4);
      return `<div class="gantt-row" data-k="proj" data-gi="${v.gi}" style="height:${rowH}px;position:relative;border-bottom:1px solid var(--border);cursor:pointer;background:var(--bg-soft)">
        <div style="position:absolute;left:${left.toFixed(1)}px;width:${w.toFixed(1)}px;top:6px;height:14px;background:#94a3b8;border-radius:7px;z-index:1;opacity:.9" title="${escapeHtml(g.code)} · ${escapeHtml(g.start)} → ${escapeHtml(g.end)} · ${g.objectives.length} objectives, ${g.ads.length} ads"></div>
      </div>`;
    }
    const o = g.objectives[v.oi];
    const s = dayOf(o.start) - minD, e = dayOf(o.end) - minD;
    const left = s * PX, w = Math.max((e - s + 1) * PX, 4);
    const tip = `${g.code} · ${o.objective}\n${o.start} → ${o.end}\n${o.ads.length} ads`;
    return `<div class="gantt-row" data-k="obj" data-gi="${v.gi}" data-oi="${v.oi}" style="height:${rowH}px;position:relative;border-bottom:1px solid var(--border);cursor:pointer">
      <div style="position:absolute;left:${left.toFixed(1)}px;width:${w.toFixed(1)}px;top:5px;height:16px;background:${_campObjColor(o.objective)};border-radius:8px;z-index:1;box-shadow:0 1px 2px rgba(0,0,0,.14);display:flex;align-items:center;overflow:hidden;padding:0 6px" title="${escapeHtml(tip)}">
        <span style="font-size:8.5px;color:#fff;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(o.objective)}${o.ads.length > 1 ? ' (' + o.ads.length + ')' : ''}</span>
      </div>
    </div>`;
  }).join('');
  wrap.innerHTML = `
    <div style="font-size:11.5px;color:var(--text-soft);margin-bottom:8px">${groups.length} โปรเจกต์${undatedG ? ` · ${undatedG} ไม่มีวันที่ (ไม่แสดง)` : ''} · 👆 กด <b>+</b> เพื่อขยายดู Objective · คลิก Objective ดูรายละเอียด ads · สี = Objective</div>
    <div class="card" style="display:block;padding:0;overflow:hidden">
      <div style="display:flex">
        <div style="width:${labelW}px;flex-shrink:0;border-right:2px solid var(--border)">
          <div style="height:${headH}px;border-bottom:1px solid var(--border);background:var(--bg-soft);display:flex;align-items:center;padding:0 8px;font-size:10px;font-weight:700;color:var(--text-muted)">Project / Objective</div>
          ${labelRows}
        </div>
        <div style="flex:1;overflow-x:auto">
          <div style="width:${tlW}px;position:relative">
            <div style="height:${headH}px;border-bottom:1px solid var(--border);background:var(--bg-soft);position:relative">${axis}</div>
            <div style="position:relative">${gridlines}${barRows}</div>
          </div>
        </div>
      </div>
    </div>`;
  wrap.querySelectorAll('.gantt-row').forEach(row => {
    row.addEventListener('click', () => {
      const g = groups[parseInt(row.dataset.gi, 10)];
      if (!g) return;
      if (row.dataset.k === 'proj') {
        if (_campExpanded.has(g.key)) _campExpanded.delete(g.key); else _campExpanded.add(g.key);
        _renderGantt(wrap);
      } else {
        const o = g.objectives[parseInt(row.dataset.oi, 10)];
        if (o) openCampaignGroupPanel(g, o);
      }
    });
  });
}
function openCampaignGroupPanel(g, o) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const ads = o ? o.ads : g.ads;
  const multi = ads.length > 1;
  // ตารางเทียบ: แถว = field, คอลัมน์ = ad (1 คอลัมน์ต่อ 1 ad) — ไฮไลต์ field ที่ต่างกัน
  const matCol = (_campData.columns || []).find(c => c.toLowerCase().includes('material name'));
  const cols = (_campData.columns || []).filter(col => ads.some(a => String((a.fields || {})[col] || '').trim() !== ''));
  const adHead = ads.map((a, i) => {
    const lbl = (matCol && a.fields[matCol]) ? a.fields[matCol] : ('Ad ' + (i + 1));
    return `<th style="text-align:left;padding:8px 9px;border-bottom:2px solid var(--border);width:200px;min-width:200px;max-width:200px;vertical-align:bottom;background:var(--bg-card)" title="${escapeHtml(a.name)}">
      <div style="font-size:11px;font-weight:700;white-space:normal;word-break:break-word;line-height:1.3">${escapeHtml(lbl)}</div>
      ${a.budget ? `<div style="font-size:9.5px;color:var(--text-soft);font-weight:600;margin-top:2px">💰 ${escapeHtml(a.budget)}</div>` : ''}
    </th>`;
  }).join('');
  const bodyRows = cols.map(col => {
    const vals = ads.map(a => String((a.fields || {})[col] || '').trim());
    const diff = multi && vals.some(v => v !== vals[0]);
    const cells = vals.map(v => `<td style="padding:6px 9px;font-size:11.5px;border-bottom:1px solid var(--border);word-break:break-word;vertical-align:top;line-height:1.5${diff ? ';background:rgba(245,158,11,.10)' : ''}">${escapeHtml(v || '—')}</td>`).join('');
    return `<tr><td style="padding:6px 9px;font-size:10.5px;color:var(--text-muted);border-bottom:1px solid var(--border);position:sticky;left:0;background:var(--bg-soft);white-space:nowrap;z-index:1;font-weight:${diff ? '700' : '400'}">${escapeHtml(col)}</td>${cells}</tr>`;
  }).join('');
  const tableW = 120 + ads.length * 200;
  const matrix = cols.length ? `<div style="overflow-x:auto;border:1px solid var(--border);border-radius:11px">
    <table style="border-collapse:collapse;table-layout:fixed;width:${tableW}px">
      <thead><tr><th style="text-align:left;padding:8px 9px;font-size:10px;color:var(--text-muted);border-bottom:2px solid var(--border);position:sticky;left:0;background:var(--bg-soft);z-index:2;white-space:nowrap;width:120px">Field \\ Ad</th>${adHead}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>${multi ? '<div style="font-size:10px;color:var(--text-soft);margin-top:7px">🟡 = field ที่ค่าต่างกันระหว่าง ads</div>' : ''}` : '<div class="empty" style="padding:14px;font-size:12px">— ไม่มีข้อมูล —</div>';
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:${multi ? 'min(840px,96vw)' : '480px'}">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 22px 28px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">📋 ${escapeHtml(g.code)}</div>
        <div style="font-size:15px;font-weight:800;margin:3px 0 8px;line-height:1.35;word-break:break-word">${escapeHtml(g.name || g.code)}</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:16px">
          ${o ? `<span style="font-size:12px;padding:3px 11px;border-radius:999px;background:${_campObjColor(o.objective)};color:#fff;font-weight:700">🎯 ${escapeHtml(o.objective)}</span>` : ''}
          <span style="font-size:12px;padding:3px 11px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border);font-weight:600">${ads.length} ads</span>
        </div>
        ${matrix}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
}
function openCampaignPanel(c) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const fieldsHtml = Object.entries(c.fields || {}).filter(([k, val]) => k && String(val).trim() !== '').map(([k, val]) => `
    <div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:11px;color:var(--text-muted);min-width:130px;max-width:130px;flex-shrink:0;word-break:break-word">${escapeHtml(k)}</div>
      <div style="font-size:12.5px;word-break:break-word;line-height:1.5">${escapeHtml(String(val))}</div>
    </div>`).join('');
  const chip = (icon, txt) => txt ? `<span style="font-size:12px;padding:3px 11px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border);font-weight:600">${icon} ${escapeHtml(txt)}</span>` : '';
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:460px">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 24px 28px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">📋 Campaign</div>
        <div style="font-size:15.5px;font-weight:800;margin:3px 0 10px;line-height:1.35;word-break:break-word">${escapeHtml(c.name)}</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:18px">
          ${chip('🎯', c.objective)}${chip('📅', c.period)}${chip('💰', c.budget)}
        </div>
        <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">ข้อมูลทั้งหมด</div>
        ${fieldsHtml || '<div class="empty" style="padding:14px;font-size:12px">— ไม่มีข้อมูล —</div>'}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
}
// ===== Benchmark (CPM แยกตาม Brand × Ad Type — ดึงจาก Google Sheet) =====
function _benchColor(cpm, min, max) {
  if (cpm == null) return 'transparent';
  const t = max > min ? (cpm - min) / (max - min) : 0;   // 0=ต่ำ(ดี) 1=สูง(แย่)
  const hue = 125 * (1 - t);                              // เขียว→แดง
  return `hsl(${hue.toFixed(0)}, 70%, 90%)`;
}
async function renderAdsBenchmark() {
  _subMain().innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      <div style="font-size:12.5px;color:var(--text-muted)">📈 Benchmark CPM — ดึงสดจาก Google Sheet (ถ่วงน้ำหนักด้วย impressions)</div>
      <div style="display:flex;gap:10px;align-items:center">
        <div style="display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden" id="bench-toggle">
          <button class="bench-mode-btn" data-mode="brand">ตาม Brand</button>
          <button class="bench-mode-btn" data-mode="category">ตาม Category</button>
        </div>
        <button class="btn" id="bench-refresh" style="font-size:13px;padding:8px 14px">🔄 รีเฟรช</button>
      </div>
    </div>
    <div id="bench-body"><div class="empty">กำลังโหลด…</div></div>`;
  _subMain().querySelectorAll('.bench-mode-btn').forEach(btn => {
    btn.onclick = () => { if (_benchMode === btn.dataset.mode) return; _benchMode = btn.dataset.mode; _syncBenchToggle(); if (_benchData) renderBenchTable(); };
  });
  _syncBenchToggle();
  const rb = $('bench-refresh');
  if (rb) rb.onclick = loadBenchmark;
  loadBenchmark();
}
function _syncBenchToggle() {
  document.querySelectorAll('.bench-mode-btn').forEach(b => {
    const on = b.dataset.mode === _benchMode;
    b.style.cssText = `border:0;padding:7px 16px;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .15s;${on ? 'background:var(--primary);color:#fff' : 'background:var(--bg-card);color:var(--text-muted)'}`;
  });
}
async function loadBenchmark() {
  const body = $('bench-body');
  if (!body) return;
  body.innerHTML = '<div class="empty">⏳ กำลังดึงจาก Google Sheet…</div>';
  try { _benchData = await fetchJson('/api/ads-benchmark'); }
  catch (e) { body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  renderBenchTable();
}
// คืน view ตามโหมดปัจจุบัน (รองรับ response เดิมที่ยังไม่มี views)
function _benchView() {
  const d = _benchData || {};
  if (d.views && d.views[_benchMode]) return d.views[_benchMode];
  return { rows: d.brands || [], adtypes: d.adtypes || [], matrix: d.matrix || {}, row_totals: d.brand_totals || {}, adtype_totals: d.adtype_totals || {}, grand: d.grand, details: d.details || {} };
}
function renderBenchTable() {
  const body = $('bench-body');
  if (!body || !_benchData) return;
  const v = _benchView();
  const isBrand = _benchMode === 'brand';
  const rows0 = v.rows || [], adtypes = v.adtypes || [];
  if (rows0.length === 0) { body.innerHTML = '<div class="empty">— ไม่มีข้อมูลในชีต —</div>'; return; }
  const bc = _benchData.brand_category || {};
  // โหมด category: รวมรายชื่อแบรนด์ในแต่ละหมวด (เรียงตาม spend)
  const brandsByCat = {};
  if (!isBrand) {
    const bt = (_benchData.views && _benchData.views.brand && _benchData.views.brand.row_totals) || _benchData.brand_totals || {};
    Object.keys(bc).forEach(b => { (brandsByCat[bc[b]] = brandsByCat[bc[b]] || []).push(b); });
    Object.keys(brandsByCat).forEach(cg => brandsByCat[cg].sort((a, b) => (((bt[b] || {}).spend) || 0) - (((bt[a] || {}).spend) || 0)));
  }
  let cmin = Infinity, cmax = -Infinity;
  rows0.forEach(r => adtypes.forEach(t => { const c = v.matrix[r] && v.matrix[r][t]; if (c && c.avg != null) { cmin = Math.min(cmin, c.avg); cmax = Math.max(cmax, c.avg); } }));
  const f2 = v2 => v2 == null ? '—' : Number(v2).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const mcell = (c, colored, rk, t) => {
    if (!c || c.avg == null) return `<td class="tnum"><span style="color:var(--text-soft)">—</span></td>`;
    const bg = colored ? `background:${_benchColor(c.avg, cmin, cmax)};` : '';
    const click = (rk !== undefined || t !== undefined);
    return `<td class="tnum"${click ? ` data-bench-click="1" data-bench-r="${escapeHtml(rk || '')}" data-bench-t="${escapeHtml(t || '')}"` : ''} style="${bg}line-height:1.3${click ? ';cursor:pointer' : ''}" title="avg CPM ${f2(c.avg)} · ต่ำสุด ${f2(c.min)} · สูงสุด ${f2(c.max)} · ${c.n} แคมเปญ · spend ${_adsMoney(c.spend)}${click ? ' · คลิกดูรายแคมเปญ' : ''}">
      <div style="font-weight:600">${f2(c.avg)}</div>
      <div style="font-size:9.5px;color:var(--text-soft)">${f2(c.min)}–${f2(c.max)}</div>
    </td>`;
  };
  const head = `<thead><tr>
    <th style="text-align:left;position:sticky;left:0;background:var(--bg-soft);z-index:1">${isBrand ? 'Brand' : 'Category'} \\ Ad Type</th>
    ${adtypes.map(t => `<th style="text-align:right">${escapeHtml(t)}</th>`).join('')}
    <th style="text-align:right;background:var(--bg-soft)">รวม</th>
  </tr></thead>`;
  const rows = rows0.map(r => `
    <tr>
      <td style="position:sticky;left:0;background:var(--bg-card);z-index:1">
        <div style="font-weight:600">${escapeHtml(r)}</div>
        ${isBrand
        ? (bc[r] ? `<div style="font-size:9.5px;color:var(--text-soft);font-weight:400;margin-top:1px">${escapeHtml(bc[r])}</div>` : '')
        : ((brandsByCat[r] && brandsByCat[r].length) ? `<div style="font-size:9.5px;color:var(--text-soft);font-weight:400;margin-top:1px;max-width:230px;white-space:normal;line-height:1.4">${escapeHtml(brandsByCat[r].join(', '))}</div>` : '')}
      </td>
      ${adtypes.map(t => mcell(v.matrix[r] && v.matrix[r][t], true, r, t)).join('')}
      ${mcell(v.row_totals[r], false, r, '')}
    </tr>`).join('');
  const foot = `<tr class="ads-tot-row">
    <td style="position:sticky;left:0;background:var(--bg-soft);z-index:1">รวม (Ad Type)</td>
    ${adtypes.map(t => mcell(v.adtype_totals[t], false, '', t)).join('')}
    ${mcell(v.grand, false)}
  </tr>`;
  // v1.9.194/196 — box plot ต่อ Ad Type + capsule (รวมไว้ด้านบนนอกกราฟ) ชี้ทุกกราฟพร้อมกัน
  const dimLabel = isBrand ? 'แบรนด์' : 'category';
  const boxCards = adtypes.map(t => {
    const pairs = rows0.map(r => { const c = v.matrix[r] && v.matrix[r][t]; return (c && c.avg != null) ? { label: r, value: c.avg } : null; }).filter(Boolean);
    return _benchBoxCard(t, dimLabel, pairs, f2);
  }).join('');
  const chips = rows0.map(r => `<span class="bp-chip" data-label="${escapeHtml(r)}" title="ชี้ตำแหน่ง ${escapeHtml(r)} ในทุกกราฟ">${escapeHtml(r)}</span>`).join('');
  const boxplots = `<div class="bp-section" style="margin-bottom:18px">
    <div style="font-size:12.5px;font-weight:700;margin-bottom:5px">📦 การกระจาย CPM ต่อ Ad Type <span style="font-weight:400;color:var(--text-soft);font-size:11px">· box plot ของแต่ละ ${dimLabel} (${adtypes.length} Ad Type)</span></div>
    <div style="font-size:10px;color:var(--text-soft);margin-bottom:7px">👆 hover/คลิก ${dimLabel} ด้านล่าง → ชี้ตำแหน่งในทุกกราฟพร้อมกัน (คลิก = ปักหมุด, คลิกซ้ำ = ยกเลิก)</div>
    <div class="bp-chips" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px">${chips}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">${boxCards}</div>
  </div>`;
  body.innerHTML = `
    ${boxplots}
    <div style="font-size:11.5px;color:var(--text-soft);margin-bottom:10px">${_benchData.row_count} แถว · ${rows0.length} ${isBrand ? 'brand' : 'category'} × ${adtypes.length} ad type · แต่ละช่อง: <strong>Average CPM</strong> (บน) · <strong>min–max</strong> (ล่าง) · ยิ่งต่ำ/เขียว = ดี · 👆 คลิกช่องเพื่อดูรายแคมเปญ · ดึงเมื่อ ${new Date().toLocaleString('th-TH')}</div>
    <div class="card" style="display:block;padding:0;overflow-x:auto">
      <table class="ads-table" style="min-width:max-content">${head}<tbody>${rows}${foot}</tbody></table>
    </div>`;
  body.onclick = (e) => {
    const td = e.target.closest('[data-bench-click]');
    if (!td) return;
    openBenchCellPanel(td.dataset.benchR || null, td.dataset.benchT || null);
  };
  // capsule (รวมด้านบน) — hover ชี้ทุกกราฟ, คลิกปักหมุด/ยกเลิก
  body.querySelectorAll('.bp-chip').forEach(chip => {
    chip.addEventListener('mouseenter', () => _bpChipEnter(chip));
    chip.addEventListener('mouseleave', () => _bpChipLeave(chip));
    chip.addEventListener('click', (e) => { e.stopPropagation(); _bpChipClick(chip); });
  });
}
// v1.9.175/176 — คลิกช่องใน Benchmark matrix → slide-out แสดงรายแคมเปญ (ที่มาของ CPM)
async function openBenchCellPanel(rowKey, adtype) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  if (!_benchData) { try { _benchData = await fetchJson('/api/ads-benchmark'); } catch (e) { return; } }
  const v = _benchView();
  const dimName = _benchMode === 'brand' ? 'Brand' : 'Category';
  const det = v.details || {};
  let rows = [];
  if (rowKey && adtype) rows = (det[rowKey] && det[rowKey][adtype]) || [];
  else if (rowKey) rows = Object.values(det[rowKey] || {}).reduce((a, x) => a.concat(x), []);
  else if (adtype) rows = Object.keys(det).reduce((a, b) => a.concat(det[b][adtype] || []), []);
  rows = rows.slice().sort((a, b) => (b.spend || 0) - (a.spend || 0));
  let stat, label, sub;
  if (rowKey && adtype) { stat = (v.matrix[rowKey] || {})[adtype]; label = `${rowKey} × ${adtype}`; sub = `${dimName} × Ad Type`; }
  else if (rowKey) { stat = v.row_totals[rowKey]; label = rowKey; sub = 'ทุก Ad Type'; }
  else { stat = v.adtype_totals[adtype]; label = adtype; sub = `ทุก ${dimName}`; }
  const f2 = v => v == null ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fi = v => v == null ? '—' : Number(v).toLocaleString('th-TH');
  const cpms = rows.map(r => r.cpm).filter(v => v != null);
  const minC = cpms.length ? Math.min(...cpms) : null, maxC = cpms.length ? Math.max(...cpms) : null;
  // ---- รายการแบบแนวยาว (table-like): หัวตารางครั้งเดียว + ค่าตรงคอลัมน์ ----
  const vcol = (val, hi) => `<div style="min-width:60px;text-align:right;font-weight:${hi ? '800' : '600'};font-size:${hi ? '14px' : '12.5px'};${hi ? 'color:var(--primary)' : ''};line-height:1.2">${val}</div>`;
  const hcol = lbl => `<div style="min-width:60px;text-align:right;font-size:9px;color:var(--text-soft);text-transform:uppercase;letter-spacing:.4px">${lbl}</div>`;
  const listHead = `<div style="display:flex;gap:14px;align-items:center;padding:0 6px 8px">
    <div style="width:22px;flex-shrink:0"></div>
    <div style="flex:1;min-width:0;font-size:9px;color:var(--text-soft);text-transform:uppercase;letter-spacing:.4px">แคมเปญ</div>
    <div style="display:flex;gap:14px;flex-shrink:0">${['CPM', 'Spend', 'Impr', 'Reach', 'Freq', 'CPP'].map(hcol).join('')}</div>
  </div>`;
  const cards = rows.map((r, i) => {
    const isMin = r.cpm != null && r.cpm === minC, isMax = r.cpm != null && r.cpm === maxC;
    const badge = isMin ? `<span style="font-size:9px;padding:1px 7px;border-radius:999px;background:rgba(22,163,74,.12);color:#16a34a;font-weight:700;white-space:nowrap">▼ ต่ำสุด</span>`
      : isMax ? `<span style="font-size:9px;padding:1px 7px;border-radius:999px;background:rgba(220,38,38,.12);color:#dc2626;font-weight:700;white-space:nowrap">▲ สูงสุด</span>` : '';
    return `<div style="display:flex;gap:14px;align-items:center;padding:11px 6px;border-top:1px solid var(--border)">
      <div style="width:22px;flex-shrink:0;text-align:right;font-size:11px;color:var(--text-soft);font-weight:600">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;gap:7px;align-items:flex-start;flex-wrap:wrap">
          <span style="font-size:12px;font-weight:600;line-height:1.45;word-break:break-word">${escapeHtml(r.campaign)}</span>${badge}
        </div>
        ${(r.objective || r.source) ? `<div style="font-size:10px;color:var(--text-soft);margin-top:3px">${escapeHtml(r.objective || '')}${r.source ? ' · ' + escapeHtml(r.source) : ''}</div>` : ''}
      </div>
      <div style="display:flex;gap:14px;align-items:center;flex-shrink:0">
        ${vcol(f2(r.cpm), true)}${vcol(_adsMoney(r.spend))}${vcol(fi(r.impressions))}${vcol(fi(r.reach))}${vcol(r.frequency != null ? f2(r.frequency) : '—')}${vcol(f2(r.cpp))}
      </div>
    </div>`;
  }).join('');
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:min(820px,95vw)">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 22px 28px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">📈 Benchmark CPM · ${escapeHtml(sub)}</div>
        <div style="font-size:16px;font-weight:800;margin:3px 0 12px;line-height:1.3;word-break:break-word">${escapeHtml(label)}</div>
        ${stat ? `<div style="border:1px solid var(--primary);background:var(--primary-soft);border-radius:12px;padding:14px;margin-bottom:14px">
          <div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:28px;font-weight:800;color:var(--primary)">${f2(stat.avg)}</span><span style="font-size:12px;color:var(--text-muted)">average CPM</span></div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-top:5px">ช่วง ${f2(stat.min)} – ${f2(stat.max)} · จาก <b>${stat.n}</b> แคมเปญ · spend ${_adsMoney(stat.spend)}</div>
        </div>` : ''}
        <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:9px">รายแคมเปญที่ประกอบเป็นค่านี้ (${rows.length})</div>
        ${rows.length ? listHead + cards : '<div class="empty" style="padding:16px;font-size:12px">— ไม่มีรายการ —</div>'}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
}
// v1.9.170 — คลิกแคมเปญใน Report → slide-out แสดง benchmark ของ Brand × Ad Type นั้น
// v1.9.192 — Box Plot สำหรับการกระจายตัวของค่า (min/Q1/median/Q3/max) + จุดค่าแคมเปญนี้
function _quantile(sorted, q) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function _benchBoxPlot(values, fmt, ownVal, benchAvg) {
  const vals = (values || []).filter(v => v != null && isFinite(v) && v > 0).sort((a, b) => a - b);
  const n = vals.length;
  if (n < 2) return '';
  const q1 = _quantile(vals, 0.25), med = _quantile(vals, 0.5), q3 = _quantile(vals, 0.75);
  const dmin = vals[0], dmax = vals[n - 1];
  let lo = dmin, hi = dmax;
  [ownVal, benchAvg].forEach(v => { if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
  const pad = ((hi - lo) || 1) * 0.08; lo -= pad; hi += pad;
  const W = 360, H = 84, padL = 10, padR = 10, cy = 34, boxH = 22;
  const innerW = W - padL - padR, span = (hi - lo) || 1;
  const X = v => padL + (v - lo) / span * innerW;
  const top = cy - boxH / 2, bot = cy + boxH / 2;
  const whisk = `<line x1="${X(dmin).toFixed(1)}" y1="${cy}" x2="${X(q1).toFixed(1)}" y2="${cy}" stroke="#94a3b8" stroke-width="1.4"/>
    <line x1="${X(q3).toFixed(1)}" y1="${cy}" x2="${X(dmax).toFixed(1)}" y2="${cy}" stroke="#94a3b8" stroke-width="1.4"/>
    <line x1="${X(dmin).toFixed(1)}" y1="${cy - 6}" x2="${X(dmin).toFixed(1)}" y2="${cy + 6}" stroke="#94a3b8" stroke-width="1.4"/>
    <line x1="${X(dmax).toFixed(1)}" y1="${cy - 6}" x2="${X(dmax).toFixed(1)}" y2="${cy + 6}" stroke="#94a3b8" stroke-width="1.4"/>`;
  const box = `<rect x="${X(q1).toFixed(1)}" y="${top}" width="${Math.max(1, X(q3) - X(q1)).toFixed(1)}" height="${boxH}" fill="rgba(100,116,139,.10)" stroke="#94a3b8" stroke-width="1.4" rx="3"/>
    <line x1="${X(med).toFixed(1)}" y1="${top}" x2="${X(med).toFixed(1)}" y2="${bot}" stroke="#64748b" stroke-width="1.8"/>`;
  let bench = '';
  if (benchAvg != null && isFinite(benchAvg)) {
    bench = `<line x1="${X(benchAvg).toFixed(1)}" y1="${top - 5}" x2="${X(benchAvg).toFixed(1)}" y2="${bot + 10}" stroke="var(--primary)" stroke-width="2.2"/>
      <text x="${X(benchAvg).toFixed(1)}" y="${bot + 19}" font-size="9" fill="var(--primary)" text-anchor="middle" font-weight="700">avg ${fmt(benchAvg)}</text>`;
  }
  let own = '';
  if (ownVal != null && isFinite(ownVal)) {
    own = `<line x1="${X(ownVal).toFixed(1)}" y1="${top - 10}" x2="${X(ownVal).toFixed(1)}" y2="${bot + 4}" stroke="#dc2626" stroke-width="1.6" stroke-dasharray="3 2"/>
      <circle cx="${X(ownVal).toFixed(1)}" cy="${cy}" r="4" fill="#dc2626"/>
      <text x="${X(ownVal).toFixed(1)}" y="${top - 13}" font-size="9" fill="#dc2626" text-anchor="middle" font-weight="700">${fmt(ownVal)}</text>`;
  }
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">${whisk}${box}${bench}${own}</svg>`;
  const sc = (l, v) => `<div style="text-align:center"><div style="font-size:8px;color:var(--text-soft);text-transform:uppercase;letter-spacing:.3px">${l}</div><div style="font-size:11px;font-weight:700">${fmt(v)}</div></div>`;
  const stats = `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-top:2px">${sc('Min', dmin)}${sc('Q1', q1)}${sc('Median', med)}${sc('Q3', q3)}${sc('Max', dmax)}</div>`;
  return svg + stats;
}
// v1.9.196 — box plot card (capsule แยกไว้ด้านบนนอกกราฟ) — card เก็บ map label→value ไว้ใน data-vals
function _benchBoxCard(title, dimLabel, pairs, fmt) {
  const head = `<div style="font-size:12.5px;font-weight:700;line-height:1.3">${escapeHtml(title)}</div>
    <div style="font-size:9.5px;color:var(--text-soft);margin-bottom:6px">CPM จาก ${pairs.length} ${dimLabel}</div>`;
  const vals = pairs.map(p => p.value).filter(v => v != null && isFinite(v) && v > 0).sort((a, b) => a - b);
  const n = vals.length;
  const map = {};
  pairs.forEach(p => { if (p.value != null && isFinite(p.value)) map[p.label] = p.value; });
  const dataVals = ` data-vals="${escapeHtml(JSON.stringify(map))}"`;
  if (n < 2) {
    return `<div class="bp-card"${dataVals} style="border:1px solid var(--border);border-radius:12px;padding:11px 12px;min-width:0">${head}<div class="empty" style="padding:14px;font-size:11px;text-align:center">— ข้อมูลไม่พอสำหรับ box plot —</div></div>`;
  }
  const q1 = _quantile(vals, 0.25), med = _quantile(vals, 0.5), q3 = _quantile(vals, 0.75);
  const dmin = vals[0], dmax = vals[n - 1];
  const pad = ((dmax - dmin) || 1) * 0.08, lo = dmin - pad, hi = dmax + pad, span = (hi - lo) || 1;
  const W = 360, H = 60, padL = 10, innerW = W - padL - 10, cy = 30, boxH = 16, top = cy - boxH / 2, bot = cy + boxH / 2;
  const X = v => padL + (v - lo) / span * innerW;
  const whisk = `<line x1="${X(dmin).toFixed(1)}" y1="${cy}" x2="${X(q1).toFixed(1)}" y2="${cy}" stroke="#94a3b8" stroke-width="1.4"/>
    <line x1="${X(q3).toFixed(1)}" y1="${cy}" x2="${X(dmax).toFixed(1)}" y2="${cy}" stroke="#94a3b8" stroke-width="1.4"/>
    <line x1="${X(dmin).toFixed(1)}" y1="${cy - 6}" x2="${X(dmin).toFixed(1)}" y2="${cy + 6}" stroke="#94a3b8" stroke-width="1.4"/>
    <line x1="${X(dmax).toFixed(1)}" y1="${cy - 6}" x2="${X(dmax).toFixed(1)}" y2="${cy + 6}" stroke="#94a3b8" stroke-width="1.4"/>`;
  const box = `<rect x="${X(q1).toFixed(1)}" y="${top}" width="${Math.max(1, X(q3) - X(q1)).toFixed(1)}" height="${boxH}" fill="rgba(100,116,139,.10)" stroke="#94a3b8" stroke-width="1.4" rx="3"/>
    <line x1="${X(med).toFixed(1)}" y1="${top}" x2="${X(med).toFixed(1)}" y2="${bot}" stroke="#64748b" stroke-width="1.8"/>`;
  const marker = `<line class="bp-marker" x1="0" x2="0" y1="${top - 11}" y2="${bot + 4}" stroke="#7c3aed" stroke-width="2" style="display:none"/>
    <circle class="bp-marker-dot" cx="0" cy="${cy}" r="3.6" fill="#7c3aed" style="display:none"/>
    <text class="bp-marker-label" x="0" y="${top - 14}" font-size="9" fill="#7c3aed" text-anchor="middle" font-weight="700" style="display:none"></text>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">${whisk}${box}${marker}</svg>`;
  const sc = (l, vv) => `<div style="text-align:center"><div style="font-size:8px;color:var(--text-soft);text-transform:uppercase;letter-spacing:.3px">${l}</div><div style="font-size:10.5px;font-weight:700">${fmt(vv)}</div></div>`;
  const stats = `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-top:2px">${sc('Min', dmin)}${sc('Q1', q1)}${sc('Median', med)}${sc('Q3', q3)}${sc('Max', dmax)}</div>`;
  return `<div class="bp-card" data-lo="${lo}" data-span="${span}"${dataVals} style="border:1px solid var(--border);border-radius:12px;padding:11px 12px;min-width:0">${head}${svg}${stats}</div>`;
}
function _bpFmt(v) { return Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _bpPlaceCard(card, val) {
  const lo = parseFloat(card.dataset.lo);
  if (isNaN(lo)) return;
  const span = parseFloat(card.dataset.span) || 1, padL = 10, innerW = 340;
  let x = padL + (val - lo) / span * innerW;
  x = Math.max(padL, Math.min(padL + innerW, x));
  const m = card.querySelector('.bp-marker'), dot = card.querySelector('.bp-marker-dot'), lbl = card.querySelector('.bp-marker-label');
  if (m) { m.setAttribute('x1', x.toFixed(1)); m.setAttribute('x2', x.toFixed(1)); m.style.display = ''; }
  if (dot) { dot.setAttribute('cx', x.toFixed(1)); dot.style.display = ''; }
  if (lbl) { lbl.setAttribute('x', x.toFixed(1)); lbl.textContent = _bpFmt(val); lbl.style.display = ''; }
}
function _bpHide(card) {
  ['.bp-marker', '.bp-marker-dot', '.bp-marker-label'].forEach(s => { const e = card.querySelector(s); if (e) e.style.display = 'none'; });
}
function _bpShowLabel(section, label) {
  section.querySelectorAll('.bp-card').forEach(card => {
    let vals = {};
    try { vals = JSON.parse(card.dataset.vals || '{}'); } catch (e) { vals = {}; }
    if (Object.prototype.hasOwnProperty.call(vals, label) && vals[label] != null) _bpPlaceCard(card, vals[label]);
    else _bpHide(card);
  });
}
function _bpHideAll(section) { section.querySelectorAll('.bp-card').forEach(c => _bpHide(c)); }
function _bpChipEnter(chip) {
  const sec = chip.closest('.bp-section'); if (sec) _bpShowLabel(sec, chip.dataset.label);
}
function _bpChipLeave(chip) {
  const sec = chip.closest('.bp-section'); if (!sec) return;
  const pinned = sec.querySelector('.bp-chip.is-pinned');
  if (pinned) _bpShowLabel(sec, pinned.dataset.label); else _bpHideAll(sec);
}
function _bpChipClick(chip) {
  const sec = chip.closest('.bp-section'); if (!sec) return;
  const was = chip.classList.contains('is-pinned');
  sec.querySelectorAll('.bp-chip.is-pinned').forEach(c => c.classList.remove('is-pinned'));
  if (was) _bpHideAll(sec);
  else { chip.classList.add('is-pinned'); _bpShowLabel(sec, chip.dataset.label); }
}
async function openBenchmarkPanel(campaign, ownVal, metric) {
  metric = metric || 'cpm';
  const isCpv = metric === 'cpv';
  const mLabel = isCpv ? 'CPV' : 'CPM';
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const brand = _benchBrandOf(campaign), adtype = _benchAdTypeOf(campaign);
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:420px">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 24px 28px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">📈 Benchmark ${mLabel}</div>
        <div style="font-size:14.5px;font-weight:700;margin:3px 0 10px;line-height:1.35;word-break:break-word">${escapeHtml(campaign)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          <span style="font-size:12px;padding:3px 11px;border-radius:999px;background:rgba(37,99,235,.10);color:var(--primary);font-weight:600">🏷️ ${escapeHtml(brand)}</span>
          <span style="font-size:12px;padding:3px 11px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border);font-weight:600">📊 ${escapeHtml(adtype)}</span>
        </div>
        <div id="bench-panel-body"><div class="empty">กำลังโหลด benchmark…</div></div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
  const pbody = wrap.querySelector('#bench-panel-body');
  try { if (!_benchData) _benchData = await fetchJson('/api/ads-benchmark'); }
  catch (e) { pbody.innerHTML = `<div class="empty">โหลด benchmark ไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const fmt = isCpv
    ? (v => v == null ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 4 }))
    : (v => v == null ? '—' : Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pick = c => !c ? null : (isCpv ? c.cpv : c);   // CPV stats อยู่ใน c.cpv
  const cell = pick((_benchData.matrix[brand] || {})[adtype]);
  const bt = pick(_benchData.brand_totals[brand]);
  const at = pick(_benchData.adtype_totals[adtype]);
  const statBox = (title, c, hi) => (c && c.avg != null) ? `
    <div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px;${hi ? 'border-color:var(--primary);background:var(--primary-soft)' : ''}">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${title}</div>
      <div style="display:flex;align-items:baseline;gap:8px"><span style="font-size:27px;font-weight:800;color:var(--primary)">${fmt(c.avg)}</span><span style="font-size:12px;color:var(--text-muted)">avg ${mLabel}</span></div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-top:5px">ช่วง ${fmt(c.min)} – ${fmt(c.max)} · จาก ${c.n} แคมเปญ</div>
    </div>` : '';
  const hasCell = cell && cell.avg != null;
  // Box Plot — การกระจายของค่าในชีต (brand × adtype) + จุดค่าแคมเปญนี้
  const det = (_benchData.details && _benchData.details[brand] && _benchData.details[brand][adtype]) || [];
  const detVals = det.map(x => x[metric]).filter(v => v != null && v > 0);
  const boxHtml = _benchBoxPlot(detVals, fmt, ownVal, hasCell ? cell.avg : null);
  const boxBlock = boxHtml ? `<div style="border:1px solid var(--border);border-radius:12px;padding:12px 12px 10px;margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;gap:8px;flex-wrap:wrap">
      <div style="font-size:11.5px;font-weight:700;color:var(--text-muted)">การกระจายตัว ${mLabel} (Box Plot)</div>
      <div style="font-size:9.5px;color:var(--text-soft);white-space:nowrap"><span style="color:var(--primary)">▮</span> avg benchmark · <span style="color:#dc2626">●</span> แคมเปญนี้ · ${detVals.length} จุด</div>
    </div>${boxHtml}</div>` : '';
  let cmp = '';
  if (ownVal != null && hasCell) {
    const diff = ((ownVal - cell.avg) / cell.avg) * 100;
    const better = diff <= 0;
    cmp = `<div style="padding:13px 15px;border-radius:11px;background:${better ? 'rgba(16,185,129,.10)' : 'rgba(220,38,38,.08)'};margin-bottom:14px">
      <div style="font-size:12px;color:var(--text-muted)">${mLabel} ของแคมเปญนี้ (Report)</div>
      <div style="font-size:22px;font-weight:800;color:${better ? 'var(--green)' : 'var(--critical)'}">${fmt(ownVal)}</div>
      <div style="font-size:12px;font-weight:600;color:${better ? 'var(--green)' : 'var(--critical)'};margin-top:2px">${better ? '▼ ต่ำกว่า' : '▲ สูงกว่า'} ค่าเฉลี่ย benchmark ${Math.abs(diff).toFixed(0)}% ${better ? '· ดีกว่ามาตรฐาน' : '· แพงกว่ามาตรฐาน'}</div>
    </div>`;
  } else if (ownVal != null) {
    cmp = `<div style="padding:13px 15px;border-radius:11px;background:var(--bg-soft);margin-bottom:14px"><div style="font-size:12px;color:var(--text-muted)">${mLabel} ของแคมเปญนี้ (Report)</div><div style="font-size:22px;font-weight:800">${fmt(ownVal)}</div></div>`;
  }
  pbody.innerHTML = `
    ${boxBlock}
    ${cmp}
    ${hasCell ? statBox(`Benchmark — ${escapeHtml(brand)} × ${escapeHtml(adtype)}`, cell, true)
           : `<div class="empty" style="padding:18px;text-align:center;font-size:12.5px">— ไม่มีข้อมูล benchmark ${mLabel} สำหรับ brand × ad type นี้ —</div>`}
    ${statBox(`Brand: ${escapeHtml(brand)} (รวมทุก Ad Type)`, bt, false)}
    ${statBox(`Ad Type: ${escapeHtml(adtype)} (รวมทุก Brand)`, at, false)}
    <div style="border-top:1px solid var(--border);margin-top:6px;padding-top:16px">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px">🎯 Audience / Targeting</div>
      <div id="bench-targeting"><div class="empty" style="padding:14px;font-size:12.5px">⏳ กำลังดึงข้อมูล targeting… (อาจช้าสักครู่)</div></div>
    </div>`;
  // โหลด targeting (หลาย breakdown — ช้า) แล้วเติมด้านล่าง
  try {
    const tg = await fetchJson(`/api/ads-campaign-targeting?campaign=${encodeURIComponent(campaign)}&days=${_adsDays}`);
    const tbox = wrap.querySelector('#bench-targeting');
    if (!tbox) return;
    const d = tg._diag || {};
    const diagLine = Object.keys(d).length
      ? `<div style="font-size:10px;color:var(--text-muted);margin-top:12px;border-top:1px dashed var(--border);padding-top:7px;line-height:1.7;word-break:break-word">` +
        Object.entries(d).map(([k, v]) => `${k}: <b>${v.matched}</b>/${v.fetched}${v.err ? ' ⚠️' + escapeHtml(String(v.err).slice(0, 70)) : ''}`).join(' · ') +
        ` · <span style="opacity:.7">${tg.days || _adsDays}d</span></div>`
      : '';
    if (!tg.found) { tbox.innerHTML = '<div class="empty" style="padding:14px;font-size:12px">— ไม่พบข้อมูล targeting (ส่วนใหญ่มีเฉพาะ Meta · ช่วงเวลานี้อาจไม่มีแคมเปญนี้) —</div>' + diagLine; return; }
    const pretty = s => (s || '').replace(/_/g, ' ');
    let html = '';
    html += _adsTgtBars('อายุ (Age)', tg.age, 8);
    html += _adsTgtBars('เพศ (Gender)', tg.gender, 5);
    html += _adsTgtBars('Placement', tg.placement, 8, pretty);
    html += _adsTgtBars('พื้นที่ (Region)', tg.region, 8);
    if (tg.adsets && tg.adsets.length) {
      html += `<div style="margin-bottom:4px"><div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:9px">Ad Set &amp; การตั้งค่า (${tg.adsets.length})</div>${
        tg.adsets.slice(0, 15).map(a => `<div style="border:1px solid var(--border);border-radius:9px;padding:9px 11px;margin-bottom:7px">
          <div style="font-size:12.5px;font-weight:600;word-break:break-word">${escapeHtml(a.name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:${a.optimization.length || a.destination.length ? '6px' : '0'}">
            ${a.optimization.map(o => `<span style="font-size:10px;padding:1px 8px;border-radius:999px;background:rgba(37,99,235,.10);color:var(--primary);font-weight:600">🎯 ${escapeHtml(o)}</span>`).join('')}
            ${a.destination.map(dd => `<span style="font-size:10px;padding:1px 8px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border)">📍 ${escapeHtml(dd)}</span>`).join('')}
          </div>
        </div>`).join('')}</div>`;
    }
    tbox.innerHTML = (html || '<div class="empty" style="padding:14px;font-size:12px">— ไม่มีข้อมูล —</div>') + diagLine;
  } catch (e) {
    const tbox = wrap.querySelector('#bench-targeting');
    if (tbox) tbox.innerHTML = `<div class="empty" style="padding:14px;font-size:12px">โหลด targeting ไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
  }
}
// v1.9.172 — bar list สำหรับ targeting breakdown (label + แถบ spend %)
function _adsTgtBars(title, items, limit, labelFn) {
  if (!items || !items.length) return '';
  const total = items.reduce((s, i) => s + (i.spend || 0), 0) || 1;
  const lf = labelFn || (x => x);
  const rows = items.slice(0, limit || 8).map(it => {
    const pct = it.spend / total * 100;
    return `<div style="margin-bottom:7px">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:3px"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(lf(it.label))}</span><span style="color:var(--text-muted);white-space:nowrap">${pct.toFixed(0)}%</span></div>
      <div style="height:6px;border-radius:999px;background:var(--bg-soft);overflow:hidden"><div style="height:100%;width:${pct.toFixed(1)}%;background:var(--primary)"></div></div>
    </div>`;
  }).join('');
  return `<div style="margin-bottom:18px"><div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:9px">${title}</div>${rows}</div>`;
}
async function loadAdsSpend() {
  const body = $('ads-body');
  if (!body) return;
  body.innerHTML = '<div class="empty">⏳ กำลังดึงข้อมูลจาก Windsor… (อาจใช้เวลาสักครู่)</div>';
  const qs = (_adsFrom && _adsTo) ? `date_from=${encodeURIComponent(_adsFrom)}&date_to=${encodeURIComponent(_adsTo)}` : `days=${_adsDays}`;
  try { _adsData = await fetchJson(`/api/ads-spend?${qs}`); }
  catch (e) {
    const msg = e.message || '';
    if (/WINDSOR_API_KEY/.test(msg)) {
      body.innerHTML = `<div class="card" style="display:block;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.06)">
        <div style="font-size:15px;font-weight:700;margin-bottom:8px">⚙️ ยังไม่ได้ตั้งค่า Windsor API</div>
        <div style="font-size:13.5px;color:var(--text-muted);line-height:1.7">
          เมนูนี้ดึงข้อมูลจาก <strong>Windsor.ai</strong> — ต้องตั้งค่า environment variable <code style="background:var(--bg-soft);padding:1px 6px;border-radius:5px;font-family:ui-monospace,Menlo,monospace">WINDSOR_API_KEY</code> บน Railway ก่อน
        </div></div>`;
      return;
    }
    body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(msg)}</div>`;
    return;
  }
  renderAdsBody();
  // โหลด benchmark (พื้นหลัง) เพื่อระบายสี CPM เทียบ benchmark — re-render เมื่อพร้อม
  if (!_benchData) {
    fetchJson('/api/ads-benchmark').then(d => { _benchData = d; if ($('ads-cards')) renderAdsCards(); }).catch(() => {});
  }
}
function renderAdsBody() {
  const body = $('ads-body');
  if (!body || !_adsData) return;
  const plats = _adsData.platforms || [];
  const dateRange = `${escapeHtml(_adsData.date_from)} → ${escapeHtml(_adsData.date_to)}`;
  if (plats.length === 0) {
    body.innerHTML = `<div class="empty" style="padding:30px;text-align:center">— ไม่มีข้อมูลใช้จ่ายในช่วง ${dateRange} —</div>`;
    return;
  }
  const grand = {};
  plats.forEach(p => Object.entries(p.total_by_cur || {}).forEach(([c, v]) => { grand[c] = (grand[c] || 0) + v; }));
  body.innerHTML = `
    ${_adsTrendSvg(_adsData.trend)}
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div style="font-size:12.5px;color:var(--text-muted)">📅 ${dateRange} · รวมทั้งหมด <strong style="color:var(--primary)">${_adsTotalTxt(grand)}</strong>
        <span style="margin-left:6px;font-size:10.5px;white-space:nowrap">CPM/CPV vs benchmark:
          <span style="padding:0 6px;border-radius:999px;background:rgba(22,163,74,.14);color:#16a34a;font-weight:700">ต่ำ</span>
          <span style="padding:0 6px;border-radius:999px;background:rgba(245,158,11,.18);color:#b45309;font-weight:700">+เล็กน้อย</span>
          <span style="padding:0 6px;border-radius:999px;background:rgba(220,38,38,.14);color:#dc2626;font-weight:700">สูง</span>
        </span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="ads-type" style="padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text);cursor:pointer">
          <option value="__all__">📂 ทุกรูปแบบโฆษณา</option>
          ${_adsAllTypes().map(t => `<option value="${escapeHtml(t)}" ${_adsType === t ? 'selected' : ''}>${escapeHtml(_adsFmtLabel(t))}</option>`).join('')}
        </select>
        <input id="ads-search" type="text" value="${escapeHtml(_adsSearch)}" placeholder="🔍 ค้นหาบัญชี / แคมเปญ..." autocomplete="off"
               style="padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text);min-width:200px" />
        <button class="btn" id="ads-export" style="font-size:13px;padding:8px 14px">⬇ CSV</button>
      </div>
    </div>
    <div id="ads-cards"></div>`;
  const ty = $('ads-type');
  if (ty) ty.onchange = () => { _adsType = ty.value; renderAdsCards(); };
  const si = $('ads-search');
  if (si) {
    let _t;
    si.addEventListener('input', e => { clearTimeout(_t); const v = e.target.value; _t = setTimeout(() => { _adsSearch = v; renderAdsCards(); }, 220); });
  }
  const ex = $('ads-export');
  if (ex) ex.onclick = exportAdsCsv;
  renderAdsCards();
}
// v1.9.161 — metrics เป็นคอลัมน์ในตาราง
function _adsDash() { return '<span style="color:var(--text-soft)">—</span>'; }
// v1.9.189/190 — เทียบค่ากับ benchmark → capsule สี (เขียว/เหลือง/แดง)
function _benchCapsule(val, benchAvg, fmt) {
  if (val == null) return _adsDash();
  if (benchAvg == null || !(benchAvg > 0)) return fmt(val);
  const ratio = val / benchAvg;
  let bg, fg, tip;
  if (ratio <= 1.0) { bg = 'rgba(22,163,74,.14)'; fg = '#16a34a'; tip = 'ต่ำกว่า/เท่า benchmark'; }
  else if (ratio <= 1.10) { bg = 'rgba(245,158,11,.18)'; fg = '#b45309'; tip = 'สูงกว่า benchmark เล็กน้อย'; }
  else { bg = 'rgba(220,38,38,.14)'; fg = '#dc2626'; tip = 'สูงกว่า benchmark'; }
  const pct = Math.round((ratio - 1) * 100);
  const sign = pct > 0 ? '+' : '';
  return `<span style="display:inline-block;padding:1px 9px;border-radius:999px;background:${bg};color:${fg};font-weight:700" title="benchmark ${fmt(benchAvg)} · ${tip} (${sign}${pct}%)">${fmt(val)}</span>`;
}
function _adsMetricCells(m, cur, benchAvg, benchCpvAvg, clickable) {
  const d = _adsDash();
  const cpmAttr = clickable ? ` class="tnum bench-cell" data-bench-metric="cpm" data-bench-val="${m.cpm == null ? '' : m.cpm}" style="font-weight:600;cursor:pointer" title="คลิกดู Benchmark CPM"` : ' class="tnum" style="font-weight:600"';
  const cpvAttr = clickable ? ` class="tnum bench-cell" data-bench-metric="cpv" data-bench-val="${m.cpv == null ? '' : m.cpv}" style="font-weight:600;cursor:pointer" title="คลิกดู Benchmark CPV"` : ' class="tnum" style="font-weight:600"';
  return `
    <td${cpmAttr}>${m.cpm != null ? _benchCapsule(m.cpm, benchAvg, _adsMoney) : d}</td>
    <td${cpvAttr}>${m.cpv != null ? _benchCapsule(m.cpv, benchCpvAvg, _adsMoney4) : d}</td>
    <td class="tnum">${m.spend != null ? `${_adsMoney(m.spend)} <span style="color:var(--text-soft);font-size:10px;font-weight:400">${escapeHtml(cur || '')}</span>` : d}</td>
    <td class="tnum">${m.impressions ? _adsInt(m.impressions) : d}</td>
    <td class="tnum">${m.reach ? _adsInt(m.reach) : d}</td>
    <td class="tnum">${m.frequency != null ? m.frequency : d}</td>
    <td class="tnum">${m.clicks ? _adsInt(m.clicks) : d}</td>
    <td class="tnum">${m.ctr != null ? m.ctr + '%' : d}</td>
    <td class="tnum">${m.cpc != null ? _adsMoney(m.cpc) : d}</td>`;
}
function renderAdsCards() {
  const wrap = $('ads-cards');
  if (!wrap || !_adsData) return;
  const q = _adsSearch.trim().toLowerCase();
  const tf = _adsType !== '__all__';
  const filtering = q !== '' || tf;
  const thead = `<thead><tr>
    <th style="text-align:left">บัญชี / แคมเปญ</th>
    <th style="text-align:right">CPM</th>
    <th style="text-align:right">CPV</th>
    <th style="text-align:right">Spend</th>
    <th style="text-align:right">Impr.</th>
    <th style="text-align:right">Reach</th>
    <th style="text-align:right">Freq.</th>
    <th style="text-align:right">Clicks</th>
    <th style="text-align:right">CTR</th>
    <th style="text-align:right">CPC</th>
  </tr></thead>`;
  const cards = (_adsData.platforms || []).map(p => {
    const meta = _adsSrcMeta(p.source);
    const accounts = (p.accounts || []).map(a => {
      const accHit = !!q && (a.account_name || '').toLowerCase().includes(q);
      const camps = (a.campaigns || []).filter(c => {
        if (tf && c.ad_format !== _adsType) return false;      // filter ตามรูปแบบโฆษณา (format)
        if (!q || accHit) return true;
        return (c.campaign || '').toLowerCase().includes(q);
      });
      if (camps.length === 0) return null;
      // recompute account metrics จากแคมเปญที่ผ่าน filter
      return { account_name: a.account_name, account_id: a.account_id, currency: a.currency, campaigns: camps, _expand: filtering, ..._adsAgg(camps) };
    }).filter(Boolean);
    if (accounts.length === 0) return '';
    const tbc = {};
    accounts.forEach(a => { tbc[a.currency] = (tbc[a.currency] || 0) + a.spend; });
    const pt = _adsAgg(accounts.flatMap(a => a.campaigns));
    const rows = accounts.map((a, ai) => {
      const camps = a.campaigns || [];
      const open = !!a._expand;
      const accRow = `
        <tr class="ads-acc-row" data-acc="${ai}">
          <td>
            <span style="display:inline-flex;align-items:center;gap:7px;max-width:300px">
              <span class="ads-caret" style="font-size:9px;color:var(--text-soft);transition:transform .15s;transform:${open ? 'rotate(90deg)' : ''}">▶</span>
              <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(a.account_name)}">${escapeHtml(a.account_name)}</span>
              <span style="font-size:10.5px;color:var(--text-soft);white-space:nowrap">· ${camps.length}</span>
            </span>
          </td>
          ${_adsMetricCells(a, a.currency)}
        </tr>`;
      const campRows = camps.map(c => `
        <tr class="ads-camp-row" data-camp-of="${ai}" data-bench-camp="${escapeHtml(c.campaign)}" style="display:${open ? '' : 'none'}">
          <td style="padding-left:32px;max-width:380px"><span style="display:inline-flex;align-items:center;gap:6px;max-width:100%"><span style="color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.campaign)}</span>${c.ad_format && _ADS_FMT_ICON[c.ad_format] ? `<span style="flex-shrink:0" title="${escapeHtml(_adsFmtLabel(c.ad_format))}">${_ADS_FMT_ICON[c.ad_format]}</span>` : ''}${c.ad_type ? `<span style="flex-shrink:0;font-size:9px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--bg-hover);color:var(--text-soft)" title="Objective">${escapeHtml(_adsTypeLabel(c.ad_type))}</span>` : ''}</span></td>
          ${_adsMetricCells(c, a.currency, _benchAvgFor(c.campaign), _benchCpvAvgFor(c.campaign), true)}
        </tr>`).join('');
      return accRow + campRows;
    }).join('');
    const oneCur = Object.keys(tbc).length === 1;   // CPM/CPC รวมมีความหมายเมื่อสกุลเงินเดียว
    const totRow = `
      <tr class="ads-tot-row">
        <td>รวมทั้งแพลตฟอร์ม</td>
        <td class="tnum">${oneCur && pt.cpm != null ? _adsMoney(pt.cpm) : _adsDash()}</td>
        <td class="tnum">${oneCur && pt.cpv != null ? _adsMoney4(pt.cpv) : _adsDash()}</td>
        <td class="tnum">${_adsTotalTxt(tbc)}</td>
        <td class="tnum">${pt.impressions ? _adsInt(pt.impressions) : _adsDash()}</td>
        <td class="tnum">${pt.reach ? _adsInt(pt.reach) : _adsDash()}</td>
        <td class="tnum">${pt.frequency != null ? pt.frequency : _adsDash()}</td>
        <td class="tnum">${pt.clicks ? _adsInt(pt.clicks) : _adsDash()}</td>
        <td class="tnum">${pt.ctr != null ? pt.ctr + '%' : _adsDash()}</td>
        <td class="tnum">${oneCur && pt.cpc != null ? _adsMoney(pt.cpc) : _adsDash()}</td>
      </tr>`;
    return `
      <div class="card" style="display:block;margin-bottom:16px;padding:0;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:13px 16px;background:var(--bg-soft);border-bottom:1px solid var(--border)">
          <div style="font-size:15px;font-weight:700">${meta.icon} ${escapeHtml(meta.label)} <span style="font-size:12px;color:var(--text-muted);font-weight:500">· ${accounts.length} บัญชี</span></div>
          <div style="font-size:15px;font-weight:800;color:var(--primary)">${_adsTotalTxt(tbc)}</div>
        </div>
        <div style="overflow-x:auto">
          <table class="ads-table">${thead}<tbody>${rows}${totRow}</tbody></table>
        </div>
      </div>`;
  }).join('');
  wrap.innerHTML = cards || '<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">— ไม่พบบัญชี/แคมเปญที่ตรงกับคำค้น —</div>';
  wrap.querySelectorAll('table.ads-table').forEach(tbl => {
    tbl.querySelectorAll('.ads-acc-row').forEach(row => {
      row.addEventListener('click', () => {
        const ai = row.dataset.acc;
        const caret = row.querySelector('.ads-caret');
        const camps = tbl.querySelectorAll(`.ads-camp-row[data-camp-of="${ai}"]`);
        const isOpen = camps.length && camps[0].style.display !== 'none';
        camps.forEach(cr => { cr.style.display = isOpen ? 'none' : ''; });
        if (caret) caret.style.transform = isOpen ? '' : 'rotate(90deg)';
      });
    });
    // v1.9.191 — คลิกที่ค่า CPM → Benchmark CPM, คลิกที่ค่า CPV → Benchmark CPV
    tbl.querySelectorAll('.bench-cell').forEach(cell => {
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = cell.closest('.ads-camp-row');
        if (!row) return;
        const val = cell.dataset.benchVal === '' ? null : parseFloat(cell.dataset.benchVal);
        openBenchmarkPanel(row.dataset.benchCamp, val, cell.dataset.benchMetric);
      });
    });
  });
}
function exportAdsCsv() {
  if (!_adsData || !_adsData.platforms) return;
  const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [['Platform', 'Account', 'Account ID', 'Campaign', 'Objective', 'Ad Format', 'Spend', 'Currency', 'Impressions', 'Reach', 'Frequency', 'Clicks', 'CTR(%)', 'CPC', 'CPM', 'Views', 'CPV'].join(',')];
  _adsData.platforms.forEach(p => {
    const label = _adsSrcMeta(p.source).label;
    (p.accounts || []).forEach(a => {
      (a.campaigns || []).forEach(c => {
        const nz = v => (v == null ? '' : v);
        lines.push([label, a.account_name, a.account_id, c.campaign, _adsTypeLabel(c.ad_type || ''), _adsFmtLabel(c.ad_format || 'other'), c.spend, a.currency, c.impressions, c.reach, nz(c.frequency), c.clicks, nz(c.ctr), nz(c.cpc), nz(c.cpm), nz(c.views), nz(c.cpv)].map(esc).join(','));
      });
    });
  });
  const csv = '﻿' + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ads-spend_${_adsData.date_from}_${_adsData.date_to}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- pages ----------
async function renderSitesList() {
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🌐 Websites</h2>
      <button class="btn primary" id="add-site-btn">+ เพิ่มเว็บใหม่</button>
    </div>
    <div id="sites-list">${skelStack(5)}</div>
  `;
  $('add-site-btn').addEventListener('click', showAddSiteModal);
  await loadSites();
}

async function loadSites() {
  const list = $('sites-list');
  list.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  const { sites } = await fetchJson('/api/admin/sites');
  if (sites.length === 0) {
    list.innerHTML = '<div class="empty">ยังไม่มีเว็บ — กด <strong>+ เพิ่มเว็บใหม่</strong> ด้านบน</div>';
    return;
  }
  list.innerHTML = sites.map(s => {
    const initial = (s.name || '?').trim().charAt(0).toUpperCase();
    const avatar = s.logo_data
      ? `<img src="${s.logo_data}" alt="${escapeHtml(s.name)}" style="width:42px;height:42px;border-radius:10px;object-fit:cover;background:#fff;flex-shrink:0;border:1px solid var(--border)" />`
      : `<div style="width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:16px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
    return `
      <div class="card card-clickable" data-id="${s.id}" style="display:flex;align-items:center;gap:14px">
        ${avatar}
        <div style="flex:1;min-width:0">
          <div class="card-title">${escapeHtml(s.name)}</div>
          <div class="card-sub">URL pattern: <code>${escapeHtml(s.url_pattern)}</code> · ${s.cred_count} credentials</div>
        </div>
        <div style="color:var(--text-muted)">→</div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('.card[data-id]').forEach(card => {
    card.addEventListener('click', () => {
      location.hash = '#/sites/' + card.dataset.id;
    });
  });
}

