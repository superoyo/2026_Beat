const $ = id => document.getElementById(id);
const API = '';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// v1.9.253 — Skeleton loading helpers — แสดงโครงร่างเทา ๆ ระหว่างโหลด (ดูไวขึ้น)
function _skelLine(w, h) { return `<div class="skel skel-line" style="width:${w};${h ? 'height:' + h + ';' : ''}"></div>`; }
function skelCard() {
  return `<div class="skel-card">
    <div class="skel" style="width:46px;height:46px;border-radius:9px;flex-shrink:0"></div>
    <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
      ${_skelLine('38%')}${_skelLine('72%')}${_skelLine('28%')}
    </div>
    <div class="skel" style="width:40px;height:30px;border-radius:6px;flex-shrink:0"></div>
  </div>`;
}
function skelGrid(n) {
  return `<div class="skel-grid">${Array.from({ length: n || 6 }, skelCard).join('')}</div>`;
}
function skelStack(n) {
  return `<div class="skel-stack">${Array.from({ length: n || 5 }, skelCard).join('')}</div>`;
}
// Dashboard: summary cards + แท่งกราฟ + การ์ดรายการ
function skelDashboard() {
  const stat = `<div class="card" style="display:block;padding:14px"><div class="skel skel-line" style="width:50%;margin-bottom:10px"></div><div class="skel" style="width:60px;height:26px;border-radius:6px"></div></div>`;
  const bar = (w) => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:9px"><div class="skel skel-line" style="width:54px"></div><div class="skel" style="height:16px;width:${w};border-radius:5px"></div></div>`;
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:18px">${stat}${stat}${stat}${stat}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div class="card" style="flex:1;min-width:300px;padding:16px">${_skelLine('40%', '13px')}<div style="height:12px"></div>${bar('70%')}${bar('55%')}${bar('85%')}${bar('40%')}${bar('60%')}</div>
      <div class="card" style="flex:1;min-width:280px;padding:16px">${_skelLine('45%', '13px')}<div style="height:12px"></div>${skelStack(4)}</div>
    </div>`;
}
// Profile: avatar กลม + ชื่อ + การ์ดข้อมูล
function skelProfile() {
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px 0 22px">
      <div class="skel" style="width:96px;height:96px;border-radius:50%"></div>
      <div class="skel skel-line" style="width:160px;height:16px"></div>
      <div class="skel skel-line" style="width:110px"></div>
    </div>
    <div class="card" style="padding:6px 16px">${Array.from({ length: 4 }, () => `<div style="display:flex;gap:14px;padding:11px 0;border-bottom:1px solid var(--border)">${_skelLine('22%')}<div style="flex:1"></div>${_skelLine('40%')}</div>`).join('')}</div>`;
}

// v1.9.83 — Wazzup SSO helpers (token เก็บใน sessionStorage)
const WAZZUP_STORAGE_KEY = 'fct_wazzup_session';
function getWazzupSession() {
  try { return JSON.parse(sessionStorage.getItem(WAZZUP_STORAGE_KEY) || 'null'); } catch { return null; }
}
function getWazzupToken() {
  const s = getWazzupSession();
  if (!s || !s.access_token) return null;
  // ตรวจ expiration
  if (s.expiration) {
    const exp = new Date(s.expiration).getTime();
    if (!isNaN(exp) && exp < Date.now()) return null;   // หมดอายุ
  }
  return s.access_token;
}
// helper: เรียก Wazzup API ด้วย bearer token (auto-handle 401 → clear + return null)
async function wazzupFetch(path, opts = {}) {
  const token = getWazzupToken();
  if (!token) throw new Error('ยังไม่มี Wazzup token / หมดอายุ — ออกแล้ว login ใหม่');
  const headers = { ...(opts.headers || {}), 'Authorization': `Bearer ${token}` };
  const base = opts.baseUrl || 'https://api.fareastfamelineddb.com';
  const res = await fetch(base + path, { ...opts, headers });
  if (res.status === 401) {
    sessionStorage.removeItem(WAZZUP_STORAGE_KEY);
    throw new Error('Wazzup token หมดอายุ — login ใหม่');
  }
  if (!res.ok) {
    throw new Error(`Wazzup API HTTP ${res.status}`);
  }
  return res.json();
}

// v1.9.69 — Tesseract.js (OCR) lazy loader + helper สำหรับอ่านรูปภาพหมายเลข asset
let _tesseractLoading = null;
function ensureTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (_tesseractLoading) return _tesseractLoading;
  _tesseractLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { _tesseractLoading = null; reject(new Error('โหลด Tesseract OCR ไม่สำเร็จ (เช็คอินเทอร์เน็ต)')); };
    document.head.appendChild(s);
  });
  return _tesseractLoading;
}
async function ocrImage(dataUrl, lang = 'eng', onProgress) {
  const T = await ensureTesseract();
  const opts = onProgress ? { logger: onProgress } : undefined;
  const result = await T.recognize(dataUrl, lang, opts);
  return ((result && result.data && result.data.text) || '').trim();
}
// แยก OCR text → guess asset number ที่น่าจะถูก (บรรทัดที่มีตัวเลข + ความยาวเหมาะ)
function guessAssetFromOcrText(text) {
  const lines = (text || '').split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  // priority: short lines with digits (typical asset codes like "A-001", "FCT-2024-005")
  const candidates = lines
    .filter(l => /\d/.test(l) && l.length <= 40)
    .sort((a, b) => a.length - b.length);
  if (candidates.length > 0) return candidates[0];
  return lines[0];
}

let currentRole = null;  // 'admin' | 'member' | null

async function fetchJson(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('unauthorized');
  }
  if (res.status === 403) {
    throw new Error('คุณไม่มีสิทธิ์ทำรายการนี้');
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(_extractErrDetail(j) || ('HTTP ' + res.status));
  }
  return res.json();
}
// v1.9.141 — แปลง detail ของ FastAPI ให้เป็นข้อความเสมอ (กัน "[object Object]" จาก 422 Pydantic ที่ detail เป็น list)
function _extractErrDetail(j) {
  if (!j) return '';
  const d = j.detail !== undefined ? j.detail : j;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(x => (x && (x.msg || x.detail)) ? (x.msg || x.detail) : (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  if (d && typeof d === 'object') return d.msg || d.detail || d.message || JSON.stringify(d);
  return d != null ? String(d) : '';
}

// admin-only routes — member ห้ามเข้า (bounce ไป default)
const ADMIN_ONLY_ROUTES = new Set(['security', 'iam', 'members', 'sites', 'logs', 'teams', 'access-requests', 'domains-config', 'services-config', 'websites', 'hardware-pc-dashboard', 'hardware-pc', 'hardware-pc-unassigned', 'hardware-device', 'hardware-network', 'hardware-report', 'financial-documents', 'ads', 'ads-benchmark', 'ads-audience', 'ads-campaigns', 'sso']);
// menu items ที่ซ่อนใน sidebar สำหรับ member
// (dashboard เห็นได้ทุกบทบาท — ใช้เป็นหน้าแรกของ member ด้วย)
const HIDE_FROM_MEMBER_NAV = new Set(['security', 'iam', 'members', 'sites', 'logs', 'teams', 'access-requests', 'domains-config', 'services-config', 'websites', 'hardware-pc-dashboard', 'hardware-pc', 'hardware-pc-unassigned', 'hardware-device', 'hardware-network', 'hardware-report', 'financial-documents', 'ads', 'ads-benchmark', 'ads-audience', 'ads-campaigns', 'sso']);
// v1.9.162 — IAM: route → module ที่ต้องมีสิทธิ์ (member ที่ถูก grant ถึงเข้าได้)
const ROUTE_MODULE = { platforms: 'platform', ads: 'ads', 'ads-benchmark': 'ads', 'ads-audience': 'ads', 'ads-campaigns': 'ads', calendar: 'customer', domains: 'customer', websites: 'customer', 'services-config': 'customer', 'domains-config': 'customer', tv: 'tv', 'tv-scheduling': 'tv',
  // v1.9.339 — Device & Software: สิทธิ์ระดับเมนูย่อย
  'hardware-pc-dashboard': 'hw-dashboard', 'hardware-pc': 'hw-pc', 'hardware-pc-unassigned': 'hw-central',
  'hardware-device': 'hw-device', 'hardware-network': 'hw-network', 'hardware-report': 'hw-report',
  'financial-documents': 'hw-findoc' };
// ลำดับเมนูย่อยของ Device & Software — ใช้หา "เมนูแรกที่มีสิทธิ์" ของ member
const HW_NAV_ROUTES = ['hardware-pc-dashboard', 'hardware-pc', 'hardware-pc-unassigned', 'hardware-device', 'hardware-network', 'hardware-report', 'financial-documents'];
let currentModules = new Set();   // module ที่ผู้ใช้ปัจจุบันเข้าถึงได้ (member)

// ---------- routing ----------
const routes = {
  'dashboard':        renderDashboardEmbed,
  'platforms':        renderPlatformsPage,
  'calendar':         () => renderCustomerPage('calendar'),   // Customer submenu
  'domains':          () => renderCustomerPage('calendar'),   // legacy alias
  'websites':         () => renderCustomerPage('websites'),
  'services-config':  () => renderCustomerPage('services-config'),
  'sites':            renderSitesList,           // v1.9.314 — ย้ายเป็น standalone (เข้าทาง ปุ่ม Configuration ใน Platforms)
  'hardware-pc-dashboard': () => renderDeviceSoftwarePage('hardware-pc-dashboard'),
  'hardware-pc':      () => renderDeviceSoftwarePage('hardware-pc'),
  'hardware-pc-unassigned': () => renderDeviceSoftwarePage('hardware-pc-unassigned'),
  'hardware-device':  () => renderDeviceSoftwarePage('hardware-device'),
  'hardware-network': () => renderDeviceSoftwarePage('hardware-network'),
  'hardware-report':  () => renderDeviceSoftwarePage('hardware-report'),
  'financial-documents': () => renderDeviceSoftwarePage('financial-documents'),
  'logs':             () => renderSettingPage('logs'),
  'security':         () => renderSettingPage('security'),
  'iam':              () => renderSettingPage('iam'),
  'sso':              () => renderSettingPage('sso'),
  'ads':              () => renderAdsSection('ads'),
  'ads-benchmark':    () => renderAdsSection('ads-benchmark'),
  'ads-audience':     () => renderAdsSection('ads-audience'),
  'ads-campaigns':    () => renderAdsSection('ads-campaigns'),
  'tv':               () => renderTvSection('tv-scheduling'),
  'tv-scheduling':    () => renderTvSection('tv-scheduling'),
  'my-device':        renderMyDevicePage,
  'domains-config':   renderDomainsConfigPage,
  'members':          () => renderPeoplesPage('members'),
  'teams':            () => renderPeoplesPage('teams'),
  'access-requests':  () => renderPeoplesPage('access-requests'),
  'extension':        renderExtensionPage,
  'account':          renderAccountPage,
  'workflow':         renderWorkflowPage,
};

function setActive(route) {
  document.querySelectorAll('.nav a[data-route]').forEach(a => {
    // v1.9.123 — data-route-extra: route เพิ่มที่ทำให้ link นี้ active ด้วย (เช่น Peoples → teams/access-requests)
    const extra = (a.dataset.routeExtra || '').split(',');
    a.classList.toggle('active', a.dataset.route === route || extra.includes(route));
  });
  // อัพเดท collapsible nav-group: ถ้า child route active → expand + highlight parent
  document.querySelectorAll('.nav-group').forEach(group => {
    const groupRoutes = (group.dataset.groupRoutes || '').split(',');
    const childActive = groupRoutes.includes(route);
    const toggle = group.querySelector('.nav-group-toggle');
    if (toggle) toggle.classList.toggle('has-active', childActive);
    // Auto-expand เมื่อ child active (กรณีก่อนหน้านี้ user collapse ไว้)
    if (childActive) group.classList.remove('collapsed');
  });
}

// Wire toggle ของ nav-group — collapse/expand (mobile) หรือ flyout (rail/desktop)
function wireNavGroups() {
  // v1.9.100 — rail mode (≥769px): flyout เป็น position:fixed เพื่อหนี overflow clipping ของ .nav
  const isRail = () => window.matchMedia('(min-width: 769px)').matches;
  const positionFlyout = (group) => {
    const btn = group.querySelector('.nav-group-toggle');
    const flyout = group.querySelector('.nav-group-children');
    if (!btn || !flyout) return;
    const r = btn.getBoundingClientRect();
    flyout.style.position = 'fixed';
    flyout.style.left = (r.right + 6) + 'px';
    flyout.style.top = (r.top - 4) + 'px';
  };
  document.querySelectorAll('.nav-group').forEach(group => {
    const btn = group.querySelector('.nav-group-toggle');
    const flyout = group.querySelector('.nav-group-children');
    if (btn) {
      btn.addEventListener('click', (e) => {
        if (isRail()) {
          // rail mode → toggle pinned (สำหรับ touch / click) + reposition
          e.stopPropagation();
          const wasPinned = group.classList.contains('rail-pinned');
          document.querySelectorAll('.nav-group.rail-pinned').forEach(g => g.classList.remove('rail-pinned'));
          if (!wasPinned) { positionFlyout(group); group.classList.add('rail-pinned'); }
          // v1.9.104 — ถ้ามี data-landing → นำทางไปหน้า landing ของกลุ่มนี้ด้วย
          const landing = btn.dataset.landing;
          if (landing) location.hash = '#/' + landing;
        } else {
          group.classList.toggle('collapsed');
        }
      });
    }
    if (flyout) {
      // hover (mouse) → reposition flyout ก่อนแสดง
      group.addEventListener('mouseenter', () => { if (isRail()) positionFlyout(group); });
    }
  });
  // click นอก nav-group หรือคลิก sub-link → ปิด pinned flyout
  document.addEventListener('click', (e) => {
    const insideGroup = e.target.closest('.nav-group');
    const isSubLink = e.target.closest('.nav-group-children a');
    if (!insideGroup || isSubLink) {
      document.querySelectorAll('.nav-group.rail-pinned').forEach(g => g.classList.remove('rail-pinned'));
    }
  });
}
function resetMainPadding() { $('main').classList.remove('no-pad'); }

async function navigate() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const parts = hash.split('/');
  const route = parts[0];

  // Member: เช็คสิทธิ์ — route ที่ผูก module ต้องได้รับสิทธิ์ก่อน; route admin-only อื่น ๆ ห้ามเข้า
  if (currentRole === 'member') {
    const reqMod = ROUTE_MODULE[route];
    if (reqMod) {
      if (!currentModules.has(reqMod)) { location.hash = '#/dashboard'; return; }
    } else if (ADMIN_ONLY_ROUTES.has(route) || HIDE_FROM_MEMBER_NAV.has(route)) {
      location.hash = '#/dashboard';
      return;
    }
  }

  // ออกจากหน้า extension → หยุด polling status
  if (route !== 'extension' && typeof stopExtStatusPolling === 'function') {
    stopExtStatusPolling();
  }

  resetMainPadding();
  if (route === 'sites' && parts[1]) {
    setActive('sites');                                              // v1.9.314 — highlight Platforms (มี data-route-extra='sites')
    await renderSiteDetail(parseInt(parts[1], 10));
  } else if (route === 'teams' && parts[1]) {
    // Teams page now uses tabs — pass team_id เพื่อ select tab
    setActive('teams');
    await renderPeoplesPage('teams', parseInt(parts[1], 10));
  } else if (route === 'platforms' && parts[1]) {
    // v1.9.153 — deep-link ไป sub-tab ของ Platforms (#/platforms/skill, /aiproject)
    setActive('platforms');
    await renderPlatformsPage(parts[1]);
  } else if (routes[route]) {
    setActive(route);
    await routes[route]();
  } else {
    location.hash = '#/dashboard';
  }
}

window.addEventListener('hashchange', navigate);
// Wire collapsible nav groups (Members → sub-menu) — รันครั้งเดียวตอน DOM load
document.addEventListener('DOMContentLoaded', wireNavGroups);
// fallback: ถ้า script รันหลัง DOMContentLoaded แล้ว
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  wireNavGroups();
}

function renderDashboardEmbed() {
  const m = $('main');
  m.classList.add('no-pad');
  m.innerHTML = `<iframe src="/dashboard" title="FEFL Beat Dashboard"></iframe>`;
}

