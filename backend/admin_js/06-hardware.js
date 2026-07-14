// ============== Hardware (PC / Device / Network — admin only) ==============

const HW_TYPES = [
  { id: 'pc',      label: 'Personal Computer', icon: '💻',  emptyText: 'ยังไม่มี Personal Computer' },
  { id: 'device',  label: 'Device',            icon: '📱',  emptyText: 'ยังไม่มี Device' },
  { id: 'network', label: 'Network Devices',   icon: '📡',  emptyText: 'ยังไม่มี Network Device' },
];

// v1.9.337 — สถานะเครื่อง: single source of truth
// เพิ่ม/แก้สถานะที่นี่ที่เดียว → badge ทุกหน้า + dropdown ในฟอร์มแก้ไขตามอัตโนมัติ
// label = ป้ายสั้น (ใช้ในการ์ด/ตาราง) · full = ป้ายเต็ม (dropdown + detail panel)
const HW_STATUS_META = {
  active:         { label: '✓ ใช้งาน',    full: '✓ ใช้งาน',         fg: 'var(--green)',    bg: 'rgba(16,185,129,.12)' },
  repair:         { label: '🔧 ซ่อม',      full: '🔧 ซ่อม / รอซ่อม',  fg: '#92400e',         bg: 'rgba(245,158,11,.15)' },
  stock:          { label: '📦 Stock',      full: '📦 เก็บ stock',     fg: '#3730a3',         bg: 'rgba(99,102,241,.10)' },
  retired:        { label: '⚠ สำรอง',      full: '⚠ สำรอง',          fg: 'var(--critical)', bg: 'rgba(220,38,38,.10)' },
  decommissioned: { label: '⛔ ปลดระวาง',  full: '⛔ ปลดระวาง',       fg: '#404040',         bg: 'rgba(82,82,82,.15)' },
};
// pill badge — size: 'sm' (การ์ดเล็ก) | 'md' (การ์ดทั่วไป) | 'lg' (detail panel)
function hwStatusBadge(status, { size = 'md', fullLabel = false } = {}) {
  const m = HW_STATUS_META[status];
  if (!m) return '';
  const s = size === 'sm' ? 'padding:1px 8px;font-size:10.5px'
    : size === 'lg' ? 'padding:3px 11px;font-size:11.5px'
    : 'padding:2px 9px;font-size:11px';
  return `<span style="display:inline-flex;align-items:center;border-radius:999px;font-weight:700;background:${m.bg};color:${m.fg};white-space:nowrap;${s}">${fullLabel ? m.full : m.label}</span>`;
}

// suggestion list สำหรับ device subtype — pre-fill dropdown
const HW_DEVICE_SUBTYPES = [
  'External HDD', 'External SSD', 'USB Flash Drive',
  'Monitor', 'WACOM', 'Drawing Tablet',
  'Keyboard', 'Mouse', 'Headphones',
  'Webcam', 'Microphone', 'Printer',
  'Tablet', 'iPad', 'Phone',
];

let _hwCache = [];          // hardware ของ tab ปัจจุบัน
let _hwActiveType = 'pc';   // 'pc' | 'device' | 'network'
let _hwSearch = '';
let _hwOsFilter = '';       // PC only: '' | 'mac' | 'windows' | 'linux' | 'other'
let _hwDeptFilter = '';     // PC only: '' หรือ team_id string (subtree) — v1.9.61: เปลี่ยนจาก dept name → team tree
let _hwLinkFilter = '';     // PC only: '' (ทั้งหมด) | 'linked' (มี owner) | 'unlinked' (ยังไม่ผูก)
let _hwGraveyard = false;   // v1.9.366 PC only: true = แสดงเฉพาะเครื่องพัง (note_category general + notes มี 'พัง')
let _hwSort = '';           // v1.9.251 PC only: '' (ชื่อ) | 'purchase_desc' | 'purchase_asc'
let _hwTeamsCache = [];     // v1.9.61: cache teams (hierarchy) สำหรับ "แผนก" filter
let _hwMembersCache = [];   // members list (สำหรับ owner dropdown)

// แบ่ง os string เป็นกลุ่มสำหรับ filter — รองรับการพิมพ์อิสระ (case-insensitive)
function classifyHwOs(os) {
  const v = (os || '').toLowerCase();
  if (!v) return '';
  if (v.includes('mac') || v.includes('osx') || v.includes('os x')) return 'mac';
  if (v.includes('win')) return 'windows';
  if (v.includes('linux') || v.includes('ubuntu') || v.includes('debian')
      || v.includes('fedora') || v.includes('arch') || v.includes('mint')) return 'linux';
  return 'other';
}

// v1.9.68 — Page: คอมส่วนกลาง (PC ที่ยังไม่มี owner ทั้งหมดในระบบ)
let _hwUnassignedCache = [];
let _hwUnassignedSearch = '';
let _hwUnassignedSort = '';   // v1.9.318 — '' = group by ที่เก็บ, 'age_new' = ใหม่→เก่า, 'age_old' = เก่า→ใหม่

async function renderHardwareUnassignedPcsPage() {
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">📦 คอมส่วนกลาง (Personal Computer ที่ไม่มี owner)</h2>
      <span id="hu-count" class="card-sub">—</span>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      รายการ PC ทั้งหมดที่ยังไม่ผูก owner — จัดกลุ่มตามทีม/แผนกที่สังกัด (จากฟิลด์ <code>unassigned_team_id</code>)
      ระบุที่เก็บใน field <code>storage_location</code> ของ PC แต่ละเครื่อง
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <input id="hu-search" type="text" placeholder="🔍 ค้นหาชื่อ / asset / ทีม / ที่เก็บ..." autocomplete="off"
        style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);box-sizing:border-box" />
      <select id="hu-sort" title="เรียงลำดับ" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer;font-weight:600;box-sizing:border-box">
        <option value="">📦 แยกตามที่เก็บ</option>
        <option value="age_new">🆕 ใหม่ → เก่า</option>
        <option value="age_old">🕰 เก่า → ใหม่</option>
      </select>
    </div>
    <div id="hu-list">${skelGrid(6)}</div>
  `;
  // โหลด members + teams cache (ใช้ใน edit modal)
  if (_hwMembersCache.length === 0 || _hwTeamsCache.length === 0) {
    try {
      const [md, td] = await Promise.all([
        fetchJson('/api/admin/members'),
        fetchJson('/api/admin/teams'),
      ]);
      _hwMembersCache = md.members || [];
      _hwTeamsCache = td.teams || [];
    } catch (_) { /* ignore */ }
  }
  await loadUnassignedPcs();
  $('hu-search').addEventListener('input', (e) => {
    _hwUnassignedSearch = e.target.value;
    renderUnassignedPcsList();
  });
  $('hu-sort').value = _hwUnassignedSort;
  $('hu-sort').addEventListener('change', (e) => {
    _hwUnassignedSort = e.target.value;
    renderUnassignedPcsList();
  });
}

async function loadUnassignedPcs() {
  let data;
  try {
    data = await fetchJson('/api/admin/hardware/unassigned-pcs');
  } catch (e) {
    const el = $('hu-list');
    if (el) el.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _hwUnassignedCache = data.hardware || [];
  renderUnassignedPcsList();
}

function renderUnassignedPcsList() {
  const listEl = $('hu-list');
  const countEl = $('hu-count');
  if (!listEl) return;
  const q = _hwUnassignedSearch.trim().toLowerCase();
  const filtered = !q ? _hwUnassignedCache : _hwUnassignedCache.filter(h => {
    return (h.name || '').toLowerCase().includes(q)
        || (h.asset_number || '').toLowerCase().includes(q)
        || (h.unassigned_team_name || '').toLowerCase().includes(q)
        || (h.storage_location || '').toLowerCase().includes(q)
        || (h.model || '').toLowerCase().includes(q);
  });
  if (countEl) {
    countEl.textContent = q
      ? `${filtered.length} / ${_hwUnassignedCache.length} เครื่อง`
      : `${_hwUnassignedCache.length} เครื่อง`;
  }
  if (_hwUnassignedCache.length === 0) {
    listEl.innerHTML = `
      <div class="empty" style="padding:32px;text-align:center;line-height:1.7">
        <div style="font-size:48px;margin-bottom:6px">📭</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px">ยังไม่มีคอมพิวเตอร์ส่วนกลาง</div>
        <div style="font-size:12.5px;color:var(--text-muted)">PC ที่ตั้ง owner = '— ไม่ผูก —' จะแสดงที่นี่</div>
      </div>
    `;
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty">ไม่พบรายการที่ตรงกับ "<strong>${escapeHtml(_hwUnassignedSearch)}</strong>"</div>`;
    return;
  }
  // v1.9.318 — โหมดเรียง: '' = group ตามที่เก็บ · age_new/age_old = flat grid เรียงตามวันซื้อ
  if (_hwUnassignedSort === 'age_new' || _hwUnassignedSort === 'age_old') {
    const dir = _hwUnassignedSort === 'age_new' ? -1 : 1;
    const ageSorted = [...filtered].sort((a, b) => {
      const pa = (a.purchased_at || '').slice(0, 10);
      const pb = (b.purchased_at || '').slice(0, 10);
      if (!pa && !pb) return 0;
      if (!pa) return 1;     // ไม่มีวันซื้อ → ท้ายสุดเสมอ
      if (!pb) return -1;
      return pa < pb ? -dir : pa > pb ? dir : 0;
    });
    const label = _hwUnassignedSort === 'age_new' ? '🆕 ใหม่ → เก่า' : '🕰 เก่า → ใหม่';
    listEl.innerHTML = `
      <div style="margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
          ${label}
          <span style="background:var(--bg-soft);color:var(--text-muted);font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600">${ageSorted.length}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px">${ageSorted.map(pc => renderHwUnassignedPcCard(pc)).join('')}</div>
      </div>`;
  } else {
    // group by unassigned_team_name (or '(ไม่ระบุทีม)')
    const sorted = [...filtered].sort((a, b) => {
      const ta = a.unassigned_team_name || 'zzz_no_team';
      const tb = b.unassigned_team_name || 'zzz_no_team';
      const cmp = ta.localeCompare(tb, 'th');
      if (cmp !== 0) return cmp;
      return (a.name || '').localeCompare(b.name || '', 'th');
    });
    const groups = new Map();
    sorted.forEach(pc => {
      const k = pc.unassigned_team_name || '(ไม่ระบุทีม)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(pc);
    });
    listEl.innerHTML = Array.from(groups.entries()).map(([teamName, items]) => `
      <div style="margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
          🏢 ${escapeHtml(teamName)}
          <span style="background:var(--bg-soft);color:var(--text-muted);font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600">${items.length}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px">${items.map(pc => renderHwUnassignedPcCard(pc)).join('')}</div>
      </div>
    `).join('');
  }
  listEl.querySelectorAll('[data-hu-pc-id]').forEach(b => {
    b.addEventListener('click', () => {
      const id = parseInt(b.dataset.huPcId, 10);
      const pc = _hwUnassignedCache.find(x => x.id === id);
      // v1.9.249 — slide-in detail (เหมือนหน้า Dashboard) แทน popup
      if (pc) showHardwareDetail(pc, async () => { await loadUnassignedPcs(); });
    });
  });
}

function renderHwUnassignedPcCard(pc) {
  // v1.9.248 — compact card grid style (เหมือนการ์ด Dashboard) · ใช้ที่เก็บ แทน owner
  const isMac = (typeof _pcDashIsMac === 'function') ? _pcDashIsMac(pc) : /mac/i.test((pc.os || '') + (pc.model || '') + (pc.name || ''));
  const ageStr = calcHwAgeStr(pc.purchased_at);
  const typeBadge = isMac
    ? '<span style="font-size:10px;color:#7c3aed;font-weight:700">🍎 Mac</span>'
    : '<span style="font-size:10px;color:var(--text-muted)">💻 Notebook/PC</span>';
  const st = HW_STATUS_META[pc.status];
  const loc = pc.storage_location
    ? `<span style="color:#3730a3;font-weight:600">📍 ${escapeHtml(pc.storage_location)}</span>`
    : '<span style="color:var(--critical);font-style:italic">⚠ ยังไม่ระบุที่เก็บ</span>';
  const sub = [escapeHtml(pc.model || '—'), pc.os ? escapeHtml(pc.os) : null].filter(Boolean).join(' · ');
  return `
    <div class="card hw-card" data-hu-pc-id="${pc.id}" title="คลิกดูรายละเอียด + แก้ไข"
      style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 13px;margin-bottom:0;border-left:3px solid ${isMac ? '#7c3aed' : '#6366f1'};cursor:pointer">
      <div style="min-width:0">
        <div style="font-weight:700;font-size:13.5px">${escapeHtml(pc.name)} ${typeBadge}</div>
        <div style="font-size:11.5px;color:var(--text-muted)">${sub}</div>
        <div style="font-size:11px;margin-top:3px">${loc}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        ${st ? `<div style="font-size:10.5px;font-weight:700;color:${st.fg};white-space:nowrap">${st.label}</div>` : ''}
        ${ageStr ? `<div style="font-size:15px;color:var(--accent);font-weight:800;margin-top:4px;white-space:nowrap;letter-spacing:.2px">⏱ ${escapeHtml(ageStr)}</div>` : '<div style="font-size:11px;color:var(--text-muted);font-style:italic;margin-top:4px;white-space:nowrap">⏱ ไม่ระบุอายุ</div>'}
      </div>
    </div>
  `;
}

// =========================================================================
// v1.9.76 — Financial Documents (เอกสารการสั่งซื้อ + OCR auto-fill)
// =========================================================================
let _findocList = [];
let _findocCurrentDoc = null;
let _findocCurrentPages = [];
let _findocViewMode = 'list';   // 'list' | 'detail'
let _findocCurrentId = null;
let _fdTagFilter = [];   // v1.9.301 — tag ที่เลือก filter (OR)

// v1.9.80 — Read file → data URL (preserve original — no recompress/crop)
async function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Compress image to JPEG dataURL (max width + quality) — ใช้สำหรับ thumbnail / OCR
// v1.9.79 — high-quality smoothing + บัฟใหญ่ขึ้นเป็น 2000px q=0.92 default
async function compressImageToJpeg(input, maxWidth = 2000, quality = 0.92) {
  const dataUrl = (typeof input === 'string')
    ? input
    : await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.onerror = rej;
        r.readAsDataURL(input);
      });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const ratio = Math.min(1, maxWidth / img.naturalWidth);
  const w = Math.round(img.naturalWidth * ratio);
  const h = Math.round(img.naturalHeight * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // v1.9.79 — high-quality downsampling เพื่อให้ตัวอักษรในเอกสารคมชัด
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

// Try parse "ใบสั่งจ่าย" → { name, doc_date, amount }
function parsePaymentOrderText(text) {
  const t = String(text || '');
  const isPaymentOrder = /ใบสั่ง\s*จ่าย|payment\s*order|ใบสั่ง\s*ซื้อ|purchase\s*order/i.test(t);
  if (!isPaymentOrder) return null;
  const out = { name: null, doc_date: null, amount: null };
  // Particulars / รายการ → next non-empty line
  const partMatch = /(?:รายการ|particulars)\s*:?[ \t]*([^\n\r]{2,200})/i.exec(t)
                 || /(?:รายการ|particulars)[\s\S]{0,3}\n+\s*([^\n\r]{2,200})/i.exec(t);
  if (partMatch) out.name = partMatch[1].trim().replace(/\s+/g, ' ').slice(0, 200);
  // Date — DD/MM/YYYY, DD-MM-YYYY, etc.
  const dateMatch = /(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{2,4})/.exec(t);
  if (dateMatch) {
    let d = parseInt(dateMatch[1], 10);
    let mo = parseInt(dateMatch[2], 10);
    let y = parseInt(dateMatch[3], 10);
    if (y < 100) y += 2500;        // 2-digit BE
    if (y > 2400 && y < 2700) y -= 543;  // BE → Gregorian
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
      out.doc_date = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }
  // Amount — look for big number near รวม/total/บาท
  const amtMatch = /(?:รวม|total|จำนวนเงิน|ยอดเงิน|amount)\D*([\d,]+\.?\d{0,2})/i.exec(t)
                || /([\d,]{4,}\.\d{2})\s*(?:บาท|baht)/i.exec(t)
                || /([\d,]{4,})\s*(?:บาท|baht)\b/i.exec(t);
  if (amtMatch) {
    const n = parseFloat(amtMatch[1].replace(/,/g, ''));
    if (!isNaN(n) && n > 0) out.amount = n;
  }
  return out;
}

function fmtFinDocDate(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const monthsTh = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return `${parseInt(m[3], 10)} ${monthsTh[parseInt(m[2], 10) - 1]} ${parseInt(m[1], 10) + 543}`;
}
function fmtFinDocAmount(amt, ccy) {
  if (amt == null) return '—';
  const n = Number(amt);
  if (isNaN(n)) return '—';
  return n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (ccy || 'THB');
}

async function renderFinancialDocumentsPage() {
  if (_findocViewMode === 'detail' && _findocCurrentId != null) {
    return renderFinDocDetailPage(_findocCurrentId);
  }
  return renderFinDocListPage();
}

async function renderFinDocListPage() {
  _findocViewMode = 'list';
  _findocCurrentId = null;
  _subMain().innerHTML = `
    <style id="fd-style">
      /* v1.9.301 — preview เล็กลง ~ครึ่ง (เห็นได้หลายอันต่อแถว) */
      .fd-grid { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
      .fd-card { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:8px; transition:border-color .12s, box-shadow .12s; display:flex; flex-direction:column; gap:6px; }
      .fd-card:hover { border-color:var(--primary); box-shadow:0 2px 8px rgba(0,0,0,.08); }
      .fd-thumb { width:100%; aspect-ratio:3/4; background:#0f172a; border-radius:7px; overflow:hidden; display:flex; align-items:center; justify-content:center; color:#64748b; font-size:28px; }
      .fd-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
      .fd-name { font-weight:700; font-size:12.5px; color:var(--text); line-height:1.35; word-break:break-word; }
      .fd-meta { font-size:11px; color:var(--text-muted); line-height:1.5; }
      .fd-amount { font-weight:700; font-size:12px; color:var(--green); font-variant-numeric:tabular-nums; }
      .fd-tag { display:inline-flex; align-items:center; gap:3px; font-size:10px; font-weight:600; background:rgba(37,99,235,.1); color:var(--primary); padding:2px 6px 2px 8px; border-radius:999px; }
      .fd-tag .fd-rm { cursor:pointer; opacity:.6; font-size:9px; }
      .fd-tag .fd-rm:hover { opacity:1; color:var(--critical); }
      .fd-addtag { border:1px dashed var(--border); background:transparent; color:var(--text-muted); font-size:10px; font-weight:600; padding:2px 8px; border-radius:999px; cursor:pointer; font-family:inherit; }
      .fd-addtag:hover { border-color:var(--primary); color:var(--primary); }
      .fd-fchip { border:1px solid var(--border); background:var(--bg-card); color:var(--text-muted); font-size:12px; font-weight:600; padding:4px 12px; border-radius:999px; cursor:pointer; font-family:inherit; transition:.12s; }
      .fd-fchip.on { background:var(--primary); color:#fff; border-color:var(--primary); }
      @media (max-width: 768px) {
        .fd-grid { grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); }
        #fd-add-btn { font-size:15px; padding:11px 18px; min-height:44px; width:100%; }
      }
    </style>
    <div class="page-head" style="flex-wrap:wrap;gap:10px">
      <h2 class="page-title">💰 Financial Document</h2>
      <button class="btn primary" id="fd-add-btn">+ เพิ่มเอกสาร</button>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      เอกสารการสั่งซื้อ (ใบสั่งจ่าย/ใบเสร็จ/อื่น ๆ) — 1 ชุดมีหลายหน้า อัพโหลดทีละหน้าหรือถ่ายจากมือถือ
      OCR จะอ่าน "ใบสั่งจ่าย" อัตโนมัติแล้ว auto-fill ชื่อ/วันที่/จำนวนเงิน
    </div>
    <div id="fd-list">${skelStack(5)}</div>
  `;
  $('fd-add-btn').addEventListener('click', () => showFinDocCreateModal());
  await loadFinDocList();
}

async function loadFinDocList() {
  try {
    const d = await fetchJson('/api/admin/financial-documents');
    _findocList = d.documents || [];
  } catch (e) {
    const el = $('fd-list');
    if (el) el.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  renderFinDocList();
}

function renderFinDocList() {
  const el = $('fd-list');
  if (!el) return;
  if (_findocList.length === 0) {
    el.innerHTML = `
      <div class="empty" style="padding:32px;text-align:center;line-height:1.7">
        <div style="font-size:48px;margin-bottom:8px">📄</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px">ยังไม่มีเอกสาร</div>
        <div style="font-size:12.5px;color:var(--text-muted)">กดปุ่ม <strong>+ เพิ่มเอกสาร</strong> เพื่ออัพโหลด</div>
      </div>
    `;
    return;
  }
  // v1.9.301 — filter bar (capsule) + cards พร้อม tag chips
  const allTags = [...new Set(_findocList.flatMap(_fdTagsOf))].sort((a, b) => a.localeCompare(b, 'th'));
  _fdTagFilter = _fdTagFilter.filter(t => allTags.includes(t));   // ตัด tag ที่หายไปแล้ว
  const docs = _fdTagFilter.length
    ? _findocList.filter(d => { const ts = _fdTagsOf(d); return _fdTagFilter.some(f => ts.includes(f)); })
    : _findocList;
  const filterBar = allTags.length ? `
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;align-items:center">
      <span style="font-size:12px;color:var(--text-muted);font-weight:700">🏷️ กรอง:</span>
      <button type="button" class="fd-fchip ${_fdTagFilter.length === 0 ? 'on' : ''}" data-fd-fall="1">ทั้งหมด</button>
      ${allTags.map(t => `<button type="button" class="fd-fchip ${_fdTagFilter.includes(t) ? 'on' : ''}" data-fd-ftag="${encodeURIComponent(t)}">${escapeHtml(t)}</button>`).join('')}
    </div>` : '';
  const card = (d) => {
    const tags = _fdTagsOf(d);
    return `<div class="fd-card" data-fd-id="${d.id}">
      <div data-fd-open="${d.id}" style="cursor:pointer;display:flex;flex-direction:column;gap:5px">
        <div class="fd-thumb">${d.first_page_image ? `<img src="${d.first_page_image}" alt="" />` : '📄'}</div>
        <div class="fd-name">${escapeHtml(d.name)}</div>
        <div class="fd-meta">📅 ${escapeHtml(fmtFinDocDate(d.doc_date))} · 📃 ${d.page_count} หน้า</div>
        <div class="fd-amount">${escapeHtml(fmtFinDocAmount(d.amount, d.currency))}</div>
      </div>
      <div class="fd-tags" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;border-top:1px solid var(--border);padding-top:6px">
        ${tags.map(t => `<span class="fd-tag">${escapeHtml(t)}<span class="fd-rm" data-fd-rmtag="${d.id}" data-fd-tag="${encodeURIComponent(t)}" title="ลบ tag">✕</span></span>`).join('')}
        <button type="button" class="fd-addtag" data-fd-addtag="${d.id}">＋ tag</button>
      </div>
    </div>`;
  };
  el.innerHTML = filterBar + (docs.length
    ? `<div class="fd-grid">${docs.map(card).join('')}</div>`
    : '<div class="empty" style="padding:28px;text-align:center">— ไม่มีเอกสารในหมวดที่เลือก —</div>');
  el.querySelectorAll('[data-fd-open]').forEach(b => b.addEventListener('click', () => {
    const id = parseInt(b.dataset.fdOpen, 10);
    _findocViewMode = 'detail'; _findocCurrentId = id; renderFinDocDetailPage(id);
  }));
  el.querySelectorAll('[data-fd-fall]').forEach(b => b.addEventListener('click', () => { _fdTagFilter = []; renderFinDocList(); }));
  el.querySelectorAll('[data-fd-ftag]').forEach(b => b.addEventListener('click', () => {
    const t = decodeURIComponent(b.dataset.fdFtag);
    const i = _fdTagFilter.indexOf(t);
    if (i >= 0) _fdTagFilter.splice(i, 1); else _fdTagFilter.push(t);
    renderFinDocList();
  }));
  el.querySelectorAll('[data-fd-rmtag]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation(); _fdRemoveTag(parseInt(b.dataset.fdRmtag, 10), decodeURIComponent(b.dataset.fdTag));
  }));
  el.querySelectorAll('[data-fd-addtag]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); _fdStartAddTag(b); }));
}

// v1.9.301 — helpers สำหรับ tag ของ Financial Document
function _fdTagsOf(d) { return (d.tags || '').split(',').map(t => t.trim()).filter(Boolean); }
async function _fdSetTags(id, tagsArr) {
  const tags = [...new Set(tagsArr.map(t => t.replace(/,/g, ' ').trim()).filter(Boolean))].join(',');
  const d = _findocList.find(x => x.id === id); if (d) d.tags = tags;   // optimistic
  renderFinDocList();
  try { await fetchJson('/api/admin/financial-documents/' + id, { method: 'PATCH', body: JSON.stringify({ tags }) }); }
  catch (e) { alert('บันทึก tag ไม่สำเร็จ: ' + (e.message || e)); await loadFinDocList(); }
}
function _fdAddTag(id, tag) { const d = _findocList.find(x => x.id === id); if (d) _fdSetTags(id, [..._fdTagsOf(d), tag]); }
function _fdRemoveTag(id, tag) { const d = _findocList.find(x => x.id === id); if (d) _fdSetTags(id, _fdTagsOf(d).filter(t => t !== tag)); }
function _fdStartAddTag(btn) {
  const id = parseInt(btn.dataset.fdAddtag, 10);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.placeholder = 'หมวด…'; inp.maxLength = 30;
  inp.style.cssText = 'width:84px;padding:2px 8px;font-size:10.5px;border:1px solid var(--primary);border-radius:999px;font-family:inherit;outline:none;background:var(--bg-input);color:var(--text)';
  btn.replaceWith(inp); inp.focus();
  let done = false;
  const commit = (save) => { if (done) return; done = true; const v = inp.value.trim(); if (save && v) _fdAddTag(id, v); else renderFinDocList(); };
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  inp.addEventListener('blur', () => commit(true));
}

async function renderFinDocDetailPage(docId) {
  _findocViewMode = 'detail';
  _findocCurrentId = docId;
  _subMain().innerHTML = `
    <style id="fd-style">
      .fd-pages { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); }
      .fd-page-card { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:6px; position:relative; }
      .fd-page-card img { width:100%; aspect-ratio:3/4; object-fit:cover; border-radius:5px; display:block; cursor:zoom-in; }
      .fd-page-num { position:absolute; top:8px; left:8px; background:rgba(15,23,42,.85); color:#fff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px; }
      .fd-page-del { position:absolute; top:8px; right:8px; background:var(--critical); color:#fff; border:none; width:24px; height:24px; border-radius:50%; cursor:pointer; font-size:12px; }
      @media (max-width: 768px) {
        .fd-pages { grid-template-columns:repeat(2,1fr); }
        .fd-form-grid { grid-template-columns:1fr !important; }
        .fd-page-del { width:32px; height:32px; font-size:14px; }
      }
    </style>
    <div class="page-head" style="flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <button class="btn" id="fd-back" style="font-size:12.5px;padding:5px 12px">← ย้อนกลับ</button>
        <h2 class="page-title" style="margin:0">📄 รายละเอียดเอกสาร</h2>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn danger" id="fd-del" style="font-size:12.5px;padding:5px 12px">🗑 ลบ</button>
      </div>
    </div>
    <div id="fd-detail-body">${skelStack(4)}</div>
  `;
  // v1.9.77 — กลับโดยเรียก render ตรง ๆ (hash ไม่เปลี่ยน → router ไม่ fire)
  $('fd-back').addEventListener('click', () => {
    _findocViewMode = 'list';
    _findocCurrentId = null;
    renderFinDocListPage();
  });
  $('fd-del').addEventListener('click', async () => {
    if (!confirm('ลบเอกสารชุดนี้ทั้งหมด? (รวมทุกหน้า)')) return;
    try {
      await fetchJson(`/api/admin/financial-documents/${docId}`, { method: 'DELETE' });
      _findocViewMode = 'list';
      _findocCurrentId = null;
      renderFinDocListPage();
    } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
  });
  await loadFinDocDetail(docId);
}

async function loadFinDocDetail(docId) {
  let data;
  try {
    data = await fetchJson(`/api/admin/financial-documents/${docId}`);
  } catch (e) {
    const el = $('fd-detail-body');
    if (el) el.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _findocCurrentDoc = data.document;
  _findocCurrentPages = data.pages || [];
  renderFinDocDetailBody();
}

function renderFinDocDetailBody() {
  const el = $('fd-detail-body');
  if (!el || !_findocCurrentDoc) return;
  const d = _findocCurrentDoc;
  el.innerHTML = `
    <!-- v1.9.82 — Pages grid อยู่บน (ผู้ใช้เน้นรูป ไม่ใช่ form) -->
    <div class="card" style="display:block;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h3 style="margin:0;font-size:14.5px;font-weight:700">📃 หน้าเอกสาร (${_findocCurrentPages.length})</h3>
        <button class="btn primary" id="fd-add-page-btn">+ เพิ่มหน้า</button>
      </div>
      ${_findocCurrentPages.length === 0
        ? '<div class="empty" style="padding:18px">ยังไม่มีหน้า — กด <strong>+ เพิ่มหน้า</strong></div>'
        : `<div class="fd-pages">${_findocCurrentPages.map((p, i) => `
            <div class="fd-page-card">
              <div class="fd-page-num">${i + 1}</div>
              <button class="fd-page-del" data-fd-page-del="${p.id}" title="ลบหน้านี้">×</button>
              <img src="${p.thumb_data || p.image_data}" alt="page ${i + 1}" data-fd-page-preview="${p.id}" loading="lazy" />
            </div>
          `).join('')}</div>`
      }
    </div>

    <!-- Header form อยู่ล่าง -->
    <div class="card" style="display:block;padding:14px">
      <h3 style="margin:0 0 12px;font-size:14.5px;font-weight:700">📋 ข้อมูลชุดเอกสาร</h3>
      <div class="field">
        <label>ชื่อชุดเอกสาร *</label>
        <input id="fd-h-name" type="text" value="${escapeHtml(d.name || '')}" placeholder="เช่น ใบสั่งจ่าย — ค่าโฮสติ้ง" maxlength="300" />
      </div>
      <div class="fd-form-grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div class="field">
          <label>วันที่</label>
          <input id="fd-h-date" type="date" value="${escapeHtml(d.doc_date || '')}" />
        </div>
        <div class="field">
          <label>จำนวนเงิน</label>
          <input id="fd-h-amount" type="number" step="0.01" value="${d.amount != null ? d.amount : ''}" placeholder="0.00" />
        </div>
        <div class="field">
          <label>สกุลเงิน</label>
          <input id="fd-h-ccy" type="text" value="${escapeHtml(d.currency || 'THB')}" maxlength="10" />
        </div>
      </div>
      <div class="field">
        <label>ผู้รับเงิน / vendor</label>
        <input id="fd-h-vendor" type="text" value="${escapeHtml(d.vendor || '')}" placeholder="ชื่อผู้รับเงิน" maxlength="200" />
      </div>
      <div class="field">
        <label>หมายเหตุ</label>
        <textarea id="fd-h-notes" rows="2" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical">${escapeHtml(d.notes || '')}</textarea>
      </div>
      <div class="hint" id="fd-h-msg" style="display:none;margin:6px 0"></div>
      <button class="btn primary" id="fd-save-header">บันทึก</button>
    </div>
  `;
  // Wire header save
  $('fd-save-header').addEventListener('click', async () => {
    const body = {
      name: $('fd-h-name').value.trim(),
      doc_date: $('fd-h-date').value || null,
      amount: $('fd-h-amount').value ? parseFloat($('fd-h-amount').value) : null,
      currency: $('fd-h-ccy').value.trim() || null,
      vendor: $('fd-h-vendor').value.trim() || null,
      notes: $('fd-h-notes').value.trim() || null,
    };
    if (!body.name) { setFdMsg('fd-h-msg', 'กรอกชื่อชุดเอกสาร', true); return; }
    try {
      await fetchJson(`/api/admin/financial-documents/${_findocCurrentId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      setFdMsg('fd-h-msg', '✓ บันทึกแล้ว', false);
    } catch (e) { setFdMsg('fd-h-msg', e.message, true); }
  });
  // Wire add page
  $('fd-add-page-btn').addEventListener('click', () => showFinDocAddPageModal(_findocCurrentId, false));
  // Wire delete page
  document.querySelectorAll('button[data-fd-page-del]').forEach(b => {
    b.addEventListener('click', async () => {
      const pid = parseInt(b.dataset.fdPageDel, 10);
      if (!confirm('ลบหน้านี้?')) return;
      try {
        await fetchJson(`/api/admin/financial-document-pages/${pid}`, { method: 'DELETE' });
        await loadFinDocDetail(_findocCurrentId);
      } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
    });
  });
  // Wire preview (lightbox) — v1.9.80 ใช้ image_data ต้นฉบับ (ไม่ใช่ thumb)
  document.querySelectorAll('img[data-fd-page-preview]').forEach(img => {
    img.addEventListener('click', () => {
      const pageId = parseInt(img.dataset.fdPagePreview, 10);
      const page = _findocCurrentPages.find(p => p.id === pageId);
      const fullSrc = (page && page.image_data) || img.src;
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.style.zIndex = '1100';
      bg.style.padding = '12px';
      bg.innerHTML = `
        <div class="modal" style="width:95vw;max-width:none;max-height:95vh;padding:12px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;color:var(--text-muted)">
            <span>คลิกที่ภาพเพื่อ <strong>ซูม 1:1</strong> / ดูเต็ม</span>
            <button class="btn primary" id="fdp-close" style="font-size:12px;padding:5px 12px">ปิด</button>
          </div>
          <div id="fdp-img-wrap" style="flex:1;overflow:auto;background:#0f172a;border-radius:8px;display:flex;align-items:center;justify-content:center;min-height:0">
            <img id="fdp-img" src="${fullSrc}" data-zoomed="0" style="display:block;max-width:100%;max-height:calc(95vh - 80px);object-fit:contain;cursor:zoom-in;transition:transform .15s" />
          </div>
        </div>`;
      document.body.appendChild(bg);
      const close = () => bg.remove();
      bg.querySelector('#fdp-close').addEventListener('click', close);
      bg.addEventListener('click', e => { if (e.target === bg) close(); });
      // click image → toggle zoom 1:1 (natural size, scrollable inside wrap)
      const imgEl = bg.querySelector('#fdp-img');
      imgEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const zoomed = imgEl.dataset.zoomed === '1';
        if (zoomed) {
          imgEl.dataset.zoomed = '0';
          imgEl.style.maxWidth = '100%';
          imgEl.style.maxHeight = 'calc(95vh - 80px)';
          imgEl.style.width = '';
          imgEl.style.height = '';
          imgEl.style.cursor = 'zoom-in';
        } else {
          imgEl.dataset.zoomed = '1';
          imgEl.style.maxWidth = 'none';
          imgEl.style.maxHeight = 'none';
          imgEl.style.width = imgEl.naturalWidth + 'px';
          imgEl.style.height = imgEl.naturalHeight + 'px';
          imgEl.style.cursor = 'zoom-out';
        }
      });
    });
  });
}
function setFdMsg(id, text, isErr) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.display = '';
  el.style.color = isErr ? 'var(--critical)' : 'var(--green)';
}

// Modal: เพิ่มเอกสารชุดใหม่ — drag-drop ไฟล์ + ถ่ายกล้อง + auto-OCR หน้าแรก
function showFinDocCreateModal() {
  showModal({
    title: '+ เพิ่มเอกสารใหม่',
    size: 'wide',
    body: `
      <div class="hint" style="margin-bottom:10px;color:var(--text-muted);font-size:12.5px">
        อัพโหลดรูปหน้าแรกของเอกสาร — ระบบจะ OCR หาคำว่า "ใบสั่งจ่าย" แล้วเติมข้อมูลให้อัตโนมัติ
      </div>
      <div id="fd-drop" style="border:2.5px dashed var(--border);border-radius:10px;padding:24px;text-align:center;background:var(--bg-soft);cursor:pointer;transition:border-color .12s, background .12s">
        <div style="font-size:36px;margin-bottom:8px">📥</div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">ลากไฟล์มาวาง หรือคลิกเพื่อเลือก</div>
        <div style="font-size:11.5px;color:var(--text-muted)">รองรับ JPG / PNG / HEIC</div>
        <input type="file" id="fd-create-file" accept="image/*" style="display:none" />
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button type="button" class="btn" id="fd-create-camera" style="flex:1;min-width:140px;font-size:13px;padding:9px">📸 ถ่ายจากกล้อง</button>
      </div>
      <div id="fd-create-status" style="display:none;margin-top:10px;padding:8px 10px;background:rgba(37,99,235,.08);border-radius:6px;font-size:12.5px;color:var(--primary-dark)"></div>
    `,
    onSubmit: async () => { /* no submit — actions inline */ },
  });
  setTimeout(() => {
    const okBtn = document.querySelector('.modal-bg .modal #m-ok');
    if (okBtn) okBtn.style.display = 'none';
    const drop = document.querySelector('.modal-bg #fd-drop');
    const fileInp = document.querySelector('.modal-bg #fd-create-file');
    const camBtn = document.querySelector('.modal-bg #fd-create-camera');
    const status = document.querySelector('.modal-bg #fd-create-status');
    if (!drop || !fileInp || !camBtn) return;
    const handleFile = (file) => processFinDocFirstPage(file, status);
    drop.addEventListener('click', () => fileInp.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; drop.style.background = 'rgba(37,99,235,.05)'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = 'var(--border)'; drop.style.background = 'var(--bg-soft)'; });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.style.borderColor = 'var(--border)';
      drop.style.background = 'var(--bg-soft)';
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });
    fileInp.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFile(f);
      fileInp.value = '';
    });
    camBtn.addEventListener('click', () => {
      // v1.9.81 — skipCrop = เก็บภาพต้นฉบับจากกล้อง (ไม่ผ่าน crop)
      openCameraModal(async (dataUrl) => {
        if (dataUrl) processFinDocFirstPage(dataUrl, status);
      }, { skipCrop: true });
    });
  }, 10);
}

async function processFinDocFirstPage(input, statusEl) {
  const setStatus = (msg) => {
    if (statusEl) { statusEl.style.display = ''; statusEl.innerHTML = msg; }
  };
  try {
    // v1.9.80 — read original (no recompress) + gen thumb แยก
    setStatus('⏳ กำลังเตรียมรูป...');
    const originalDataUrl = (typeof input === 'string')
      ? input
      : await fileToDataUrl(input);
    const thumbDataUrl = await compressImageToJpeg(originalDataUrl, 300, 0.8);
    // OCR ใช้ตัวกลาง (1500px) เพื่อลด memory/CPU โดยไม่กระทบรูปต้นฉบับที่จะบันทึก
    setStatus('⏳ กำลัง OCR อ่านเอกสาร... (อาจใช้เวลา 5-15 วินาที)');
    let ocrText = '';
    try {
      const ocrInput = await compressImageToJpeg(originalDataUrl, 1500, 0.88);
      ocrText = await ocrImage(ocrInput, 'eng+tha', (m) => {
        if (m && m.status && typeof m.progress === 'number') {
          const pct = Math.round(m.progress * 100);
          setStatus(`⏳ OCR: ${m.status} ${pct}%`);
        }
      });
    } catch (e) {
      ocrText = '';
    }
    const parsed = parsePaymentOrderText(ocrText) || {};
    // สร้างเอกสารใหม่
    const name = parsed.name || `เอกสาร ${new Date().toLocaleDateString('th-TH')}`;
    setStatus('⏳ กำลังบันทึกเอกสาร...');
    const created = await fetchJson('/api/admin/financial-documents', {
      method: 'POST',
      body: JSON.stringify({
        name,
        doc_date: parsed.doc_date || null,
        amount: parsed.amount || null,
        currency: 'THB',
      }),
    });
    // Upload หน้าแรก — เก็บภาพต้นฉบับ + thumb
    await fetchJson(`/api/admin/financial-documents/${created.id}/pages`, {
      method: 'POST',
      body: JSON.stringify({
        image_data: originalDataUrl,
        thumb_data: thumbDataUrl,
        ocr_text: ocrText || null,
      }),
    });
    // Close modal + navigate to detail
    const bg = document.querySelector('.modal-bg');
    if (bg) bg.remove();
    _findocViewMode = 'detail';
    _findocCurrentId = created.id;
    location.hash = '#/financial-documents';
    await renderFinDocDetailPage(created.id);
    if (parsed.name || parsed.doc_date || parsed.amount) {
      showSavedToast(`✓ OCR สำเร็จ — เติม ${[parsed.name && 'ชื่อ', parsed.doc_date && 'วันที่', parsed.amount && 'จำนวนเงิน'].filter(Boolean).join('/')} ให้แล้ว`);
    } else {
      showSavedToast('✓ บันทึกหน้าแรกแล้ว (OCR ไม่เจอ "ใบสั่งจ่าย" — กรอกข้อมูลเอง)');
    }
  } catch (e) {
    setStatus('❌ ' + e.message);
  }
}

// Modal: เพิ่มหน้าใหม่เข้าเอกสารที่มีอยู่ (drag-drop + camera, ไม่ OCR auto-fill)
function showFinDocAddPageModal(docId) {
  showModal({
    title: '+ เพิ่มหน้าเอกสาร',
    size: 'wide',
    body: `
      <div id="fd-drop2" style="border:2.5px dashed var(--border);border-radius:10px;padding:24px;text-align:center;background:var(--bg-soft);cursor:pointer">
        <div style="font-size:36px;margin-bottom:8px">📥</div>
        <div style="font-weight:600;font-size:14px;margin-bottom:4px">ลากไฟล์มาวาง หรือคลิกเพื่อเลือก</div>
        <input type="file" id="fd-page-file" accept="image/*" multiple style="display:none" />
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button type="button" class="btn" id="fd-page-cam" style="flex:1;font-size:13px;padding:9px">📸 ถ่ายจากกล้อง</button>
      </div>
      <div id="fd-page-status" style="display:none;margin-top:10px;padding:8px 10px;background:rgba(37,99,235,.08);border-radius:6px;font-size:12.5px;color:var(--primary-dark)"></div>
    `,
    onSubmit: async () => {},
  });
  setTimeout(() => {
    const okBtn = document.querySelector('.modal-bg .modal #m-ok');
    if (okBtn) okBtn.style.display = 'none';
    const drop = document.querySelector('.modal-bg #fd-drop2');
    const fileInp = document.querySelector('.modal-bg #fd-page-file');
    const cam = document.querySelector('.modal-bg #fd-page-cam');
    const status = document.querySelector('.modal-bg #fd-page-status');
    const addPage = async (input) => {
      try {
        status.style.display = '';
        status.textContent = '⏳ กำลังเตรียมรูป...';
        // v1.9.80 — เก็บต้นฉบับ + gen thumb
        const original = (typeof input === 'string') ? input : await fileToDataUrl(input);
        const thumb = await compressImageToJpeg(original, 300, 0.8);
        status.textContent = '⏳ กำลังบันทึก...';
        await fetchJson(`/api/admin/financial-documents/${docId}/pages`, {
          method: 'POST',
          body: JSON.stringify({ image_data: original, thumb_data: thumb }),
        });
        const bg = document.querySelector('.modal-bg');
        if (bg) bg.remove();
        await loadFinDocDetail(docId);
        showSavedToast('✓ เพิ่มหน้าแล้ว');
      } catch (e) {
        status.textContent = '❌ ' + e.message;
      }
    };
    drop.addEventListener('click', () => fileInp.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = 'var(--border)'; });
    drop.addEventListener('drop', async (e) => {
      e.preventDefault();
      drop.style.borderColor = 'var(--border)';
      const files = Array.from(e.dataTransfer.files || []);
      // Upload sequentially
      for (const f of files) await addPage(f);
    });
    fileInp.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) await addPage(f);
      fileInp.value = '';
    });
    cam.addEventListener('click', () => {
      // v1.9.81 — skipCrop = เก็บภาพต้นฉบับ
      openCameraModal(async (dataUrl) => {
        if (dataUrl) await addPage(dataUrl);
      }, { skipCrop: true });
    });
  }, 10);
}

// v1.9.235 — PC Dashboard: ภาพรวมคอมทั้งบริษัท + ปฏิทินการซื้อ + รายการควรพิจารณาเปลี่ยน (notebook>3ปี / mac>5ปี)
function _pcDashAgeMonths(p) {
  const m = /^(\d{4})-(\d{2})/.exec(String(p.purchased_at || ''));
  if (!m) return null;
  const now = new Date();
  const mo = (now.getFullYear() - (+m[1])) * 12 + (now.getMonth() - ((+m[2]) - 1));
  return mo < 0 ? 0 : mo;
}
function _pcDashIsMac(p) {
  return /\bmac\b|macos|mac ?os|os ?x|osx|macbook|imac|mac ?mini|mac ?studio/i.test((p.os || '') + ' ' + (p.model || '') + ' ' + (p.name || ''));
}
let _pcDashTeam = '';   // '' = ทุกทีม | team_id (string)
let _pcdReplaceFilter = 'all';   // v1.9.257 — 'all' | 'mac' | 'windows' (toggle ในส่วนควรพิจารณาเปลี่ยน)
let _pcdAllPcs = [];    // PC list เต็ม (ก่อน filter ทีม) — ใช้ใน owner panel
// v1.9.244 — panel เจ้าของเครื่อง (จากข้อมูลที่ dashboard โหลดไว้ — ใช้บน admin ได้) + คลิกดู device
// v1.9.285 — modal แก้ไขโปรไฟล์ (BYOD + Alumni) — ยุบจาก inline
function _pcdEditProfile(memberId, st, onSaved) {
  const on = !!st.uses_own_computer, aon = !!st.is_alumni;
  const inp = 'width:100%;padding:8px 11px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;box-sizing:border-box';
  showModal({
    title: '✏️ แก้ไขโปรไฟล์',
    body: `
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px;font-weight:600">
          <input type="checkbox" id="ep-byod" ${on ? 'checked' : ''} style="width:17px;height:17px;accent-color:#7c3aed;cursor:pointer" />
          <span>🙋 ใช้คอมพิวเตอร์ของตนเอง <span style="font-weight:500;color:var(--text-muted);font-size:11.5px">(เครื่องส่วนตัว / BYOD)</span></span>
        </label>
        <div id="ep-byod-wrap" style="margin-top:10px;${on ? '' : 'display:none'}">
          <label style="display:block;font-size:11.5px;color:var(--text-muted);margin-bottom:4px">เป็นคอมฯอะไร</label>
          <input id="ep-byod-info" type="text" maxlength="300" value="${escapeHtml(st.own_computer_info || '')}" placeholder="เช่น Macbook Pro M2 ส่วนตัว" style="${inp}" />
        </div>
      </div>
      <div style="border:1px solid var(--border);border-radius:12px;padding:12px 14px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13.5px;font-weight:600">
          <input type="checkbox" id="ep-alum" ${aon ? 'checked' : ''} style="width:17px;height:17px;accent-color:#d97706;cursor:pointer" />
          <span>🎓 เป็น Alumni <span style="font-weight:500;color:var(--text-muted);font-size:11.5px">(อดีตพนักงาน — ไม่นับรวมจำนวนพนักงาน)</span></span>
        </label>
        <div id="ep-alum-wrap" style="margin-top:10px;${aon ? '' : 'display:none'}">
          <label style="display:block;font-size:11.5px;color:var(--text-muted);margin-bottom:4px">วันทำงานวันสุดท้าย</label>
          <input id="ep-alum-date" type="date" value="${escapeHtml(st.last_working_day || '')}" style="${inp}" />
        </div>
      </div>`,
    onSubmit: async () => {
      const byod = $('ep-byod').checked, info = ($('ep-byod-info') ? $('ep-byod-info').value : '').trim();
      const alum = $('ep-alum').checked, lwd = ($('ep-alum-date') ? $('ep-alum-date').value : '').trim();
      await fetchJson('/api/admin/members/' + memberId + '/own-computer', { method: 'PATCH', body: JSON.stringify({ uses_own_computer: byod, own_computer_info: info || null }) });
      await fetchJson('/api/admin/members/' + memberId + '/alumni', { method: 'PATCH', body: JSON.stringify({ is_alumni: alum, last_working_day: lwd || null }) });
      if (typeof onSaved === 'function') onSaved({ uses_own_computer: byod, own_computer_info: info, is_alumni: alum, last_working_day: lwd });
    },
  });
  setTimeout(() => {
    const bt = $('ep-byod'), bw = $('ep-byod-wrap'); if (bt && bw) bt.addEventListener('change', () => bw.style.display = bt.checked ? '' : 'none');
    const at = $('ep-alum'), aw = $('ep-alum-wrap'); if (at && aw) at.addEventListener('change', () => aw.style.display = at.checked ? '' : 'none');
  }, 0);
}

function _pcdOwnerPanel(memberId, onChange, memberObj, deviceList) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  // v1.9.260 — รับ memberObj + deviceList ได้ (เปิดจากหน้า Teams ที่ไม่มี hardware cache)
  const m = memberObj || _hwMembersCache.find(x => x.id === memberId);
  // v1.9.255 — เปิดจากหน้า PC ได้ด้วย → ถ้ายังไม่เข้า Dashboard ใช้ _hwCache แทน
  const _ownerSrc = (_pcdAllPcs && _pcdAllPcs.length) ? _pcdAllPcs : ((typeof _hwCache !== 'undefined' && _hwCache.length) ? _hwCache : []);
  const devices = deviceList || _ownerSrc.filter(p => p.current_member_id === memberId);
  const name = (m && (m.display_name || m.email)) || 'ผู้ใช้';
  const avatar = (m && m.avatar_data)
    ? `<img src="${m.avatar_data}" style="width:84px;height:84px;border-radius:50%;object-fit:cover;display:block;margin:0 auto" />`
    : `<div style="width:84px;height:84px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:34px;font-weight:700;display:flex;align-items:center;justify-content:center;margin:0 auto">${escapeHtml((String(name).trim().charAt(0) || '?').toUpperCase())}</div>`;
  const teamsChips = (m && m.teams && m.teams.length)
    ? m.teams.map(t => `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;background:rgba(37,99,235,.10);color:var(--primary);margin:2px 3px 0 0">${escapeHtml(t.name)}</span>`).join('')
    : '<span style="color:var(--text-muted)">—</span>';
  const row = (label, val) => `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)"><div style="width:90px;flex-shrink:0;font-size:12px;color:var(--text-muted)">${label}</div><div style="flex:1;font-size:13px;color:var(--text);word-break:break-word">${val}</div></div>`;
  // v1.9.256 — แสดงหมายเหตุ (+ หมวด) ใต้อุปกรณ์
  const _catLabel = { keep: '🔸 ยังไม่เปลี่ยน', procuring: '🛒 อยู่ระหว่างจัดหา', transferring: '🔄 ได้เครื่องใหม่ — transfer', transferring_rotation: '♻️ ได้เครื่องใหม่ (หมุนเวียน) — transfer' };
  const devCard = (p) => {
    const a = calcHwAgeStr(p.purchased_at);
    const cat = _catLabel[p.note_category];
    const noteHtml = (p.notes || cat)
      ? `<div style="font-size:11px;color:#92400e;margin-top:5px;background:rgba(245,158,11,.1);padding:4px 8px;border-radius:6px;line-height:1.45">📝 ${cat ? `<b>${cat}</b>${p.notes ? ' · ' : ''}` : ''}${escapeHtml(p.notes || '')}</div>`
      : '';
    return `<div class="hw-card" data-pcd-dev="${p.id}" title="คลิกดูรายละเอียด + แก้ไข" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;border:1px solid var(--border);border-radius:10px;padding:8px 11px;margin-bottom:6px;cursor:pointer">
      <div style="min-width:0;flex:1">
        <div style="font-size:12.5px;font-weight:700">${_pcDashIsMac(p) ? '🍎' : '💻'} ${escapeHtml(p.name)}${p.is_personal_owned ? ' <span style="font-size:10px;color:#7c3aed;font-weight:700">🙋 เครื่องตนเอง</span>' : ''}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${escapeHtml(p.model || '—')}${a ? ' · ⏱ ' + escapeHtml(a) : ''}</div>
        ${noteHtml}
      </div>
      <span style="flex-shrink:0;font-size:10px;font-weight:700;background:rgba(16,185,129,.12);color:var(--green);padding:2px 8px;border-radius:999px;white-space:nowrap">current</span>
    </div>`;
  };
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:440px">
      <div class="sup-panel-head" style="justify-content:flex-end;gap:8px"><button type="button" id="pcd-edit-profile-btn" class="btn" style="font-size:12px;padding:6px 12px">✏️ แก้ไขโปรไฟล์</button><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 24px 28px">
        ${avatar}
        <div style="text-align:center;font-size:18px;font-weight:800;margin:10px 0 16px">${escapeHtml(name)}</div>
        <div style="border:1px solid var(--border);border-radius:12px;padding:2px 14px;margin-bottom:18px">
          ${row('เบอร์มือถือ', (m && m.phone) ? '📞 ' + escapeHtml(m.phone) : '—')}
          ${row('อีเมล', (m && m.email) ? escapeHtml(m.email) : '—')}
          ${row('ทีม', teamsChips)}
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">💻 Devices</div>
        ${devices.map(devCard).join('')}
        <div id="pcd-prev-dev"><div class="empty" style="font-size:12px;padding:10px">กำลังโหลด…</div></div>
        <div id="pcd-own-comp" style="margin-top:18px"></div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
  wrap.querySelectorAll('[data-pcd-dev]').forEach(el => el.addEventListener('click', () => {
    const p = devices.find(x => x.id === parseInt(el.dataset.pcdDev, 10));
    if (p) showHardwareDetail(p, onChange || renderPcDashboard);
  }));
  // v1.9.286 — โปรไฟล์ (BYOD + Alumni) — ปุ่มแก้ไขอยู่บนขวา · แก้ไข inline ในสไลด์ (ไม่ใช้ popup)
  (async () => {
    const box = wrap.querySelector('#pcd-own-comp');
    const abox = wrap.querySelector('#pcd-alumni'); if (abox) abox.remove();
    const editBtn = wrap.querySelector('#pcd-edit-profile-btn');
    if (!box) return;
    let st = { uses_own_computer: false, own_computer_info: '', is_alumni: false, last_working_day: '', replaces_member_id: null, alumni_options: [] };
    try { st = await fetchJson('/api/admin/members/' + memberId + '/own-computer'); } catch (e) { /* default */ }
    const inp = 'width:100%;padding:8px 11px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;box-sizing:border-box';
    const _findAlum = (id) => (st.alumni_options || []).find(a => a.id === id);
    const renderView = () => {
      const chips = [];
      if (st.uses_own_computer) chips.push(`<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;background:rgba(124,58,237,.1);color:#7c3aed;padding:3px 10px;border-radius:999px;font-weight:600">🙋 ใช้เครื่องตนเอง${st.own_computer_info ? ': ' + escapeHtml(st.own_computer_info) : ''}</span>`);
      if (st.is_alumni) chips.push(`<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;background:rgba(245,158,11,.12);color:#92400e;padding:3px 10px;border-radius:999px;font-weight:600">🎓 Alumni${st.last_working_day ? ' · ' + escapeHtml(fmtDateThai(st.last_working_day)) : ''}</span>`);
      // v1.9.328 — chip 'มาแทน' — แสดงเฉพาะพนักงานปัจจุบัน (ไม่ใช่ alumni)
      if (!st.is_alumni && st.replaces_member_id) {
        const alum = _findAlum(st.replaces_member_id);
        const lbl = alum ? alum.display_name : ('member#' + st.replaces_member_id);
        chips.push(`<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;background:rgba(37,99,235,.10);color:var(--primary);padding:3px 10px;border-radius:999px;font-weight:600">🔄 มาแทน ${escapeHtml(lbl)}</span>`);
      }
      box.innerHTML = chips.length
        ? `<div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">โปรไฟล์</div><div style="display:flex;flex-wrap:wrap;gap:6px">${chips.join('')}</div>`
        : '';
      if (editBtn) editBtn.onclick = renderEdit;
    };
    const renderEdit = () => {
      const on = !!st.uses_own_computer, aon = !!st.is_alumni;
      // v1.9.332 — searchable combobox + create-new สำหรับ "มาแทน"
      // state ภายใน: replacesPick = { id } | { createName } | null
      const currentAlum = st.replaces_member_id ? _findAlum(st.replaces_member_id) : null;
      let replacesPick = currentAlum ? { id: currentAlum.id, display: currentAlum.display_name } : null;
      box.innerHTML = `
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">✏️ แก้ไขโปรไฟล์</div>
        <div style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;font-weight:600"><input type="checkbox" id="ep-byod" ${on ? 'checked' : ''} style="width:16px;height:16px;accent-color:#7c3aed;cursor:pointer" /><span>🙋 ใช้คอมพิวเตอร์ของตนเอง <span style="font-weight:500;color:var(--text-muted);font-size:11px">(BYOD)</span></span></label>
          <div id="ep-byod-wrap" style="margin-top:9px;${on ? '' : 'display:none'}"><input id="ep-byod-info" type="text" maxlength="300" value="${escapeHtml(st.own_computer_info || '')}" placeholder="เป็นคอมฯอะไร เช่น Macbook Pro M2 ส่วนตัว" style="${inp}" /></div>
        </div>
        <div style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:10px">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;font-weight:600"><input type="checkbox" id="ep-alum" ${aon ? 'checked' : ''} style="width:16px;height:16px;accent-color:#d97706;cursor:pointer" /><span>🎓 เป็น Alumni <span style="font-weight:500;color:var(--text-muted);font-size:11px">(อดีตพนักงาน)</span></span></label>
          <div id="ep-alum-wrap" style="margin-top:9px;${aon ? '' : 'display:none'}"><label style="display:block;font-size:11px;color:var(--text-muted);margin-bottom:4px">วันทำงานวันสุดท้าย</label><input id="ep-alum-date" type="date" value="${escapeHtml(st.last_working_day || '')}" style="${inp}" /></div>
        </div>
        <div id="ep-replaces-wrap" style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;${aon ? 'display:none' : ''}">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:7px">🔄 มาแทนใคร <span style="font-weight:500;color:var(--text-muted);font-size:11px">(พิมพ์เพื่อค้นหา หรือสร้างใหม่)</span></label>
          <div style="position:relative">
            <input id="ep-replaces-input" type="text" autocomplete="off" placeholder="พิมพ์ชื่อ alumni..." value="${escapeHtml(replacesPick ? replacesPick.display : '')}" style="${inp}" />
            <div id="ep-replaces-dropdown" style="display:none;position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--bg-card);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.14);z-index:10;max-height:240px;overflow-y:auto"></div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px">
            <div id="ep-replaces-hint" style="font-size:11px;color:var(--text-muted);flex:1;min-width:0"></div>
            <button type="button" id="ep-replaces-clear" style="font-size:11px;background:none;border:none;color:var(--text-muted);cursor:pointer;padding:2px 6px;font-family:inherit">✕ เคลียร์</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button type="button" id="ep-cancel" class="btn" style="font-size:12.5px;padding:6px 14px">ยกเลิก</button><button type="button" id="ep-save" class="btn primary" style="font-size:12.5px;padding:6px 16px">บันทึก</button></div>`;
      const bt = box.querySelector('#ep-byod'), bw = box.querySelector('#ep-byod-wrap');
      bt.addEventListener('change', () => bw.style.display = bt.checked ? '' : 'none');
      const at = box.querySelector('#ep-alum'), aw = box.querySelector('#ep-alum-wrap');
      const rw = box.querySelector('#ep-replaces-wrap');
      at.addEventListener('change', () => {
        aw.style.display = at.checked ? '' : 'none';
        if (rw) rw.style.display = at.checked ? 'none' : '';   // alumni ไม่ต้องเลือก 'มาแทน'
      });
      // === Combobox: search + create-new ===
      const rInp = box.querySelector('#ep-replaces-input');
      const rList = box.querySelector('#ep-replaces-dropdown');
      const rHint = box.querySelector('#ep-replaces-hint');
      const updateHint = () => {
        if (!rHint) return;
        if (!replacesPick) { rHint.textContent = ''; return; }
        rHint.textContent = replacesPick.id
          ? `เลือกแล้ว: ${replacesPick.display}`
          : `จะสร้าง alumni ใหม่: ${replacesPick.display}`;
        rHint.style.color = replacesPick.id ? 'var(--text-muted)' : '#0284c7';
      };
      const renderDropdown = () => {
        const q = (rInp.value || '').trim();
        const qLow = q.toLowerCase();
        const opts = st.alumni_options || [];
        const matched = q ? opts.filter(a => (a.display_name || '').toLowerCase().includes(qLow)) : opts.slice(0, 30);
        const exactExists = q && opts.some(a => (a.display_name || '').trim().toLowerCase() === qLow);
        const items = matched.slice(0, 20).map(a => {
          const lwd = a.last_working_day ? ' <span style="color:var(--text-muted);font-size:10.5px">· ' + escapeHtml(fmtDateThai(a.last_working_day)) + '</span>' : '';
          const initial = (a.display_name || '?').trim().charAt(0).toUpperCase();
          const av = a.avatar_data
            ? `<img src="${a.avatar_data}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
            : `<div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#d97706,#92400e);color:#fff;font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
          return `<div data-pick-id="${a.id}" data-pick-name="${escapeHtml(a.display_name)}" style="display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;font-size:12.5px" onmouseenter="this.style.background='var(--bg-soft)'" onmouseleave="this.style.background='transparent'">${av}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.display_name)}</span>${lwd}</div>`;
        }).join('');
        const createItem = (q && !exactExists) ? `<div data-pick-create="${escapeHtml(q)}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;font-size:12.5px;border-top:1px solid var(--border);color:#0284c7;font-weight:600" onmouseenter="this.style.background='rgba(14,165,233,.06)'" onmouseleave="this.style.background='transparent'">➕ สร้างใหม่: "${escapeHtml(q)}"</div>` : '';
        if (!items && !createItem) {
          rList.innerHTML = '<div style="padding:14px;font-size:12px;color:var(--text-muted);text-align:center">ไม่พบ · พิมพ์ชื่อเพื่อสร้างใหม่</div>';
        } else {
          rList.innerHTML = items + createItem;
        }
        rList.style.display = '';
        rList.querySelectorAll('[data-pick-id]').forEach(el => el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          replacesPick = { id: parseInt(el.dataset.pickId, 10), display: el.dataset.pickName };
          rInp.value = el.dataset.pickName;
          rList.style.display = 'none';
          updateHint();
        }));
        rList.querySelectorAll('[data-pick-create]').forEach(el => el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          replacesPick = { createName: el.dataset.pickCreate, display: el.dataset.pickCreate };
          rInp.value = el.dataset.pickCreate;
          rList.style.display = 'none';
          updateHint();
        }));
      };
      rInp.addEventListener('input', () => { replacesPick = null; updateHint(); renderDropdown(); });
      rInp.addEventListener('focus', renderDropdown);
      rInp.addEventListener('blur', () => setTimeout(() => { rList.style.display = 'none'; }, 150));
      box.querySelector('#ep-replaces-clear').addEventListener('click', () => {
        replacesPick = null;
        rInp.value = '';
        rList.style.display = 'none';
        updateHint();
      });
      updateHint();

      box.querySelector('#ep-cancel').addEventListener('click', renderView);
      box.querySelector('#ep-save').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const byod = bt.checked, info = (box.querySelector('#ep-byod-info').value || '').trim();
        const alum = at.checked, lwd = (box.querySelector('#ep-alum-date').value || '').trim();
        btn.disabled = true; btn.textContent = 'กำลังบันทึก…';
        try {
          await fetchJson('/api/admin/members/' + memberId + '/own-computer', { method: 'PATCH', body: JSON.stringify({ uses_own_computer: byod, own_computer_info: info || null }) });
          await fetchJson('/api/admin/members/' + memberId + '/alumni', { method: 'PATCH', body: JSON.stringify({ is_alumni: alum, last_working_day: lwd || null }) });
          // v1.9.332 — handle มาแทน: create-new / select-existing / clear
          let newReplacesId = null;
          if (!alum && replacesPick) {
            if (replacesPick.createName) {
              // สร้าง alumni ใหม่ + set replaces atomically
              const teamIds = (m && Array.isArray(m.teams)) ? m.teams.map(t => t.id).filter(Boolean) : [];
              const dept = (m && Array.isArray(m.teams) && m.teams[0]) ? m.teams[0].name : (m && m.temp_department) || null;
              const res = await fetchJson('/api/admin/members/' + memberId + '/create-replaces', {
                method: 'POST',
                body: JSON.stringify({ name: replacesPick.createName, department: dept, team_ids: teamIds }),
              });
              newReplacesId = res.id;
              // refresh alumni_options (เพราะเพิ่ง create ใหม่)
              try {
                const fresh = await fetchJson('/api/admin/members/' + memberId + '/own-computer');
                st.alumni_options = fresh.alumni_options || st.alumni_options;
              } catch (_) { /* ignore */ }
            } else if (replacesPick.id) {
              newReplacesId = replacesPick.id;
              await fetchJson('/api/admin/members/' + memberId + '/replaces', { method: 'PATCH', body: JSON.stringify({ replaces_member_id: newReplacesId }) });
            }
          } else {
            // clear
            await fetchJson('/api/admin/members/' + memberId + '/replaces', { method: 'PATCH', body: JSON.stringify({ replaces_member_id: null }) });
          }
          st = { ...st, uses_own_computer: byod, own_computer_info: info, is_alumni: alum, last_working_day: lwd, replaces_member_id: newReplacesId };
          renderView();
          if (typeof onChange === 'function') { try { onChange(); } catch (_) {} }
        } catch (err) { alert('บันทึกไม่สำเร็จ: ' + (err.message || err)); btn.disabled = false; btn.textContent = 'บันทึก'; }
      });
    };
    renderView();
  })();
  // v1.9.247 — Previous Device: เครื่องที่เคยใช้ + ตอนนี้อยู่ไหน
  (async () => {
    const box = wrap.querySelector('#pcd-prev-dev');
    if (!box) return;
    let prev = [];
    try { prev = (await fetchJson('/api/admin/members/' + memberId + '/device-history')).previous || []; }
    catch (e) { box.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted)">โหลดประวัติเครื่องไม่ได้</div>'; return; }
    box.innerHTML = prev.length
      ? prev.map(p => {
          const fr = (p.assigned_at || '').slice(0, 7), to = (p.unassigned_at || '').slice(0, 7);
          const period = (fr ? fmtMonthYearThai(fr) : '') + (to ? '–' + fmtMonthYearThai(to) : '');
          const inFleet = _ownerSrc.some(x => x.id === p.hardware_id);
          const attrs = inFleet ? `class="hw-card" data-pcd-prev="${p.hardware_id}" title="คลิกดูรายละเอียดเครื่อง"` : '';
          return `<div ${attrs} style="${inFleet ? 'cursor:pointer;' : ''}display:flex;justify-content:space-between;align-items:flex-start;gap:8px;border:1px solid var(--border);border-radius:10px;padding:8px 11px;margin-bottom:6px;opacity:.92">
            <div style="min-width:0;flex:1">
              <div style="font-size:12.5px;font-weight:700">${escapeHtml(p.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:1px">${escapeHtml(p.model || '—')}</div>
              <div style="font-size:10.5px;color:var(--primary);margin-top:2px">📍 ${escapeHtml(p.where_now)}</div>
            </div>
            <span style="flex-shrink:0;text-align:right">
              <span style="font-size:10px;font-weight:700;background:var(--bg-soft);color:var(--text-muted);padding:2px 8px;border-radius:999px;white-space:nowrap">previous</span>
              ${period ? `<div style="font-size:9.5px;color:var(--text-soft);margin-top:3px;white-space:nowrap">(${escapeHtml(period)})</div>` : ''}
            </span>
          </div>`;
        }).join('')
      : (devices.length === 0 ? '<div class="empty" style="font-size:12px">— ไม่มีอุปกรณ์ —</div>' : '');
    box.querySelectorAll('[data-pcd-prev]').forEach(el => el.addEventListener('click', () => {
      const dev = _ownerSrc.find(x => x.id === parseInt(el.dataset.pcdPrev, 10));
      if (dev) showHardwareDetail(dev, onChange || renderPcDashboard);
    }));
  })();
}
function _pcMatchTeam(p, subtree) {
  const ownerTids = getHwOwnerTeamIds(p);
  if (ownerTids && ownerTids.size > 0) {
    for (const t of ownerTids) if (subtree.has(t)) return true;
    return false;
  }
  if (p.unassigned_team_id != null) return subtree.has(p.unassigned_team_id);
  return false;   // ไม่มี owner + ไม่มีทีมที่สังกัด → ไม่เข้าทีมใด
}
async function renderPcDashboard() {
  const root = _subMain();
  if (!root) return;
  root.innerHTML = skelDashboard();
  let pcs;
  try { pcs = (await fetchJson('/api/admin/hardware?type=pc')).hardware || []; }
  catch (e) { root.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }

  // โหลด teams + members (ใช้จับ PC เข้าทีม) ถ้ายังไม่มีใน cache
  if (_hwTeamsCache.length === 0 || _hwMembersCache.length === 0) {
    try {
      const [td, md] = await Promise.all([fetchJson('/api/admin/teams'), fetchJson('/api/admin/members')]);
      _hwTeamsCache = td.teams || _hwTeamsCache;
      _hwMembersCache = md.members || _hwMembersCache;
    } catch { /* ไม่มี team filter ก็ยังดู dashboard ได้ */ }
  }
  if (_pcDashTeam && !_hwTeamsCache.some(t => String(t.id) === _pcDashTeam)) _pcDashTeam = '';
  // dropdown ทีม (โครงสร้าง indent)
  const _teamFlat = flattenTeamTreeDFS(buildTeamTree(_hwTeamsCache));
  const teamOpts = `<option value="">— ทุกทีม —</option>` + _teamFlat.map(({ team, depth }) =>
    `<option value="${team.id}" ${String(team.id) === _pcDashTeam ? 'selected' : ''}>${escapeHtml('  '.repeat(depth) + (depth > 0 ? '↳ ' : '') + team.name)}</option>`).join('');
  _pcdAllPcs = pcs;   // เก็บ list เต็มก่อน filter (owner panel แสดงอุปกรณ์ครบ)
  // filter ตามทีม (รวมทีมย่อย) — ผ่าน owner's teams หรือ unassigned_team_id
  if (_pcDashTeam) {
    const sub = getTeamDescendantIds(_hwTeamsCache, parseInt(_pcDashTeam, 10));
    pcs = pcs.filter(p => _pcMatchTeam(p, sub));
  }

  const SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  // v1.9.293 — สถานะระหว่างดำเนินการเปลี่ยนเครื่อง (โชว์บน dashboard เสมอ แม้ไม่เกินเกณฑ์อายุ/เป็นมือสอง)
  // v1.9.294 — transferring_rotation แยกเป็นบล็อกของตัวเองด้านบน (ไม่รวมในควรพิจารณาเปลี่ยน)
  const _IN_PROGRESS = ['procuring', 'transferring'];
  pcs.forEach(p => {
    p._age = _pcDashAgeMonths(p);
    p._mac = _pcDashIsMac(p);
    p._thr = p._mac ? 60 : 36;                 // mac 5 ปี / notebook 3 ปี
    p._retired = p.status === 'retired';
    // v1.9.290 — คอมฯส่งต่อมาจากท่านอื่น (มือสอง) ไม่นำมาคิดว่าควรเปลี่ยน (ตามอายุ)
    p._overThr = !p._retired && !p.is_handed_down && p._age != null && p._age > p._thr;
    // v1.9.293 — มี status ระหว่างจัดหา/transfer → ถือว่ากำลังดำเนินการ (โชว์เสมอ)
    p._inProgress = !p._retired && _IN_PROGRESS.includes(p.note_category);
    p._needsReplace = p._overThr || p._inProgress;
  });
  const total = pcs.length;
  const active = pcs.filter(p => !p._retired);
  const withAge = active.filter(p => p._age != null);
  const avgAge = withAge.length ? Math.round(withAge.reduce((s, p) => s + p._age, 0) / withAge.length) : null;
  const _replKey = (p) => (p._age != null ? p._age - p._thr : -1e9);   // เครื่องไม่มีอายุ/ไม่เกินเกณฑ์ → ท้ายสุด
  const needReplace = pcs.filter(p => p._needsReplace && p.note_category !== 'transferring_rotation').sort((a, b) => _replKey(b) - _replKey(a));
  const _inProgOnly = needReplace.filter(p => !p._overThr).length;   // นับเฉพาะที่เข้ามาเพราะ status (ไม่เกินเกณฑ์)
  // v1.9.294 — กลุ่มแยก: ได้เครื่องใหม่ (เครื่องจากการหมุนเวียน) — กำลัง transfer (โชว์ทุกเครื่องในหมวดนี้)
  const rotationList = pcs.filter(p => !p._retired && p.note_category === 'transferring_rotation').sort((a, b) => _replKey(b) - _replKey(a));
  let win = 0, mac = 0, other = 0;
  pcs.forEach(p => { if (p._mac) mac++; else if (/win/i.test(p.os || '')) win++; else other++; });
  let assigned = 0, central = 0, unassigned = 0;
  pcs.forEach(p => { if (p.current_member_id) assigned++; else if (_isHwCentral(p)) central++; else unassigned++; });
  const noDate = pcs.filter(p => p._age == null && !p._retired).length;

  // ปฏิทินการซื้อ (year × month)
  const byYm = {};
  pcs.forEach(p => { const m = /^(\d{4})-(\d{2})/.exec(String(p.purchased_at || '')); if (m) { const k = (+m[1]) + '-' + (+m[2]); (byYm[k] = byYm[k] || []).push(p); } });
  const years = [...new Set(Object.keys(byYm).map(k => +k.split('-')[0]))].sort((a, b) => b - a);
  const maxMonth = Math.max(1, ...Object.values(byYm).map(a => a.length));

  // การกระจายอายุ (เฉพาะที่ใช้งานอยู่ + มีวันที่ซื้อ)
  const buckets = [
    { label: '< 1 ปี', min: 0, max: 12, color: '#10b981' },
    { label: '1–2 ปี', min: 12, max: 24, color: '#22c55e' },
    { label: '2–3 ปี', min: 24, max: 36, color: '#eab308' },
    { label: '3–5 ปี', min: 36, max: 60, color: '#f97316' },
    { label: 'เกิน 5 ปี', min: 60, max: Infinity, color: '#dc2626' },
  ];
  buckets.forEach(b => b.count = withAge.filter(p => p._age >= b.min && p._age < b.max).length);
  const maxBucket = Math.max(1, ...buckets.map(b => b.count));

  const card = (label, val, color, sub) =>
    `<div class="card" style="display:block;padding:12px 14px;margin-bottom:0"><div style="font-size:11.5px;color:var(--text-muted);margin-bottom:3px">${label}</div><div style="font-size:24px;font-weight:800;line-height:1.15;${color ? 'color:' + color : ''}">${val}</div>${sub ? `<div style="font-size:11px;color:var(--text-soft);margin-top:4px;line-height:1.4">${sub}</div>` : ''}</div>`;

  const ownerOf = (p) => p.current_member_label ? escapeHtml(p.current_member_label) : (p._retired ? 'สำรอง' : (_isHwCentral(p) ? 'ส่วนกลาง' : 'ยังไม่ผูก'));
  // v1.9.287 — ชื่อแผนก/ทีมของเครื่อง (จากเจ้าของ หรือทีมที่สังกัดของคอมส่วนกลาง)
  const _pcDeptOf = (p) => {
    if (p.current_member_id) { const m = _hwMembersCache.find(x => x.id === p.current_member_id); if (m && m.teams && m.teams.length) return m.teams[0].name; }
    if (p.unassigned_team_id) { const t = _hwTeamsCache.find(x => x.id === p.unassigned_team_id); if (t) return t.name; }
    return (p.department || '').trim() || null;
  };
  const replaceRow = (p, showNote) => {
    const over = (p._age != null) ? p._age - p._thr : null;
    const isOver = over != null && over > 0;
    const borderC = isOver ? (p._mac ? '#7c3aed' : '#dc2626') : '#15803d';
    const noteHtml = (showNote && p.notes) ? `<div style="font-size:11px;color:#92400e;margin-top:4px;background:rgba(245,158,11,.1);padding:3px 8px;border-radius:6px;line-height:1.45">📝 ${escapeHtml(p.notes)}</div>` : '';
    return `<div class="card hw-card" data-pcd-replace="${p.id}" title="คลิกดูรายละเอียด + แก้ไข" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 13px;margin-bottom:6px;border-left:3px solid ${borderC}">
      <div style="min-width:0">
        <div style="font-weight:700;font-size:13.5px">${escapeHtml(p.name)} ${p._mac ? '<span style="font-size:10px;color:#7c3aed;font-weight:700">🍎 Mac</span>' : '<span style="font-size:10px;color:var(--text-muted)">💻 Notebook</span>'}</div>
        <div style="font-size:11.5px;color:var(--text-muted)">${escapeHtml(p.model || '—')} · ${escapeHtml(ownerOf(p))} · ${escapeHtml(p.os || '')}</div>
        ${p.for_new_position ? '<div style="margin-top:4px"><span style="display:inline-block;font-size:10px;font-weight:700;background:rgba(14,165,233,.12);color:#0284c7;padding:2px 8px;border-radius:999px">🆕 คอมฯสำหรับตำแหน่งเปิดใหม่</span></div>' : ''}
        ${noteHtml}
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-weight:800;color:${isOver ? '#dc2626' : 'var(--text-muted)'};font-size:13px">${escapeHtml(calcHwAgeStr(p.purchased_at) || '—')}</div>
        ${isOver
          ? `<div style="font-size:10.5px;color:#92400e">เกินเกณฑ์ ${Math.round(over)} เดือน (เกณฑ์ ${p._thr / 12} ปี)</div>`
          : `<div style="font-size:10.5px;color:#15803d;font-weight:700">🔧 อยู่ระหว่างดำเนินการ</div>`}
      </div>
    </div>`;
  };
  // v1.9.245 — แยกกลุ่มตามหมวดหมายเหตุ: ทั่วไป (ไม่มี header/note) → ยังไม่เปลี่ยน → อยู่ระหว่างจัดหา (แสดง note)
  const _replGrid = (arr, showNote) => `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px">${arr.map(p => replaceRow(p, showNote)).join('')}</div>`;
  const _replSection = (arr, label, color) => arr.length ? `<div style="margin-top:16px"><div style="font-size:12.5px;font-weight:800;margin-bottom:8px;color:${color}">${label} (${arr.length})</div>${_replGrid(arr, true)}</div>` : '';
  // v1.9.257 — toggle Mac/Windows: build body จาก list ที่ filter แล้ว
  const _replMacCount = needReplace.filter(p => p._mac).length;
  const _replWinCount = needReplace.length - _replMacCount;
  const _buildReplaceBody = () => {
    const list = _pcdReplaceFilter === 'mac' ? needReplace.filter(p => p._mac)
               : _pcdReplaceFilter === 'windows' ? needReplace.filter(p => !p._mac)
               : needReplace;
    if (list.length === 0) {
      const lbl = _pcdReplaceFilter === 'mac' ? 'Mac' : _pcdReplaceFilter === 'windows' ? 'Windows' : '';
      return `<div class="empty" style="padding:24px">🎉 ไม่มีเครื่อง${lbl ? ' ' + lbl : ''}ที่เกินเกณฑ์</div>`;
    }
    const byCat = { general: [], keep: [], procuring: [], transferring: [] };
    list.forEach(p => { const c = ['keep', 'procuring', 'transferring'].includes(p.note_category) ? p.note_category : 'general'; byCat[c].push(p); });
    return _replGrid(byCat.general, false)
      + _replSection(byCat.keep, '🔸 ยังไม่เปลี่ยน', '#92400e')
      + _replSection(byCat.procuring, '🛒 อยู่ระหว่างจัดหา', '#3730a3')
      + _replSection(byCat.transferring, '🔄 ได้เครื่องใหม่แล้ว — transfer ข้อมูล', '#15803d');
  };
  const replaceBody = _buildReplaceBody();
  const _replToggle = needReplace.length === 0 ? '' : `<div id="pcd-repl-toggle" style="display:inline-flex;gap:2px;background:var(--bg-soft);border:1px solid var(--border);border-radius:9px;padding:3px">${[['all', 'ทั้งหมด', needReplace.length], ['mac', '🍎 Mac', _replMacCount], ['windows', '🪟 Windows', _replWinCount]].map(([k, lb, n]) => `<button type="button" data-repl-filter="${k}" style="border:none;background:${_pcdReplaceFilter === k ? 'var(--bg-card)' : 'transparent'};color:${_pcdReplaceFilter === k ? 'var(--text)' : 'var(--text-muted)'};font-weight:${_pcdReplaceFilter === k ? 700 : 500};font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer;font-family:inherit;box-shadow:${_pcdReplaceFilter === k ? 'var(--shadow-sm)' : 'none'};transition:.12s">${lb} <span style="opacity:.7">(${n})</span></button>`).join('')}</div>`;

  // heatmap cell
  const cellHtml = (y, mo1) => {
    const arr = byYm[y + '-' + mo1] || [];
    const c = arr.length;
    const intensity = c ? (0.14 + 0.66 * c / maxMonth) : 0;
    const bg = c ? `rgba(37,99,235,${intensity.toFixed(2)})` : 'transparent';
    const fg = (c && intensity > 0.45) ? '#fff' : 'var(--text)';
    return `<td style="padding:0;text-align:center"><button type="button" ${c ? `data-pcd-ym="${y}-${mo1}"` : 'disabled'} style="width:100%;height:34px;border:none;background:${bg};color:${fg};cursor:${c ? 'pointer' : 'default'};font-size:12px;font-weight:${c ? 700 : 400};font-family:inherit;border-radius:5px">${c || ''}</button></td>`;
  };
  const calRows = years.map(y => {
    const yearTotal = SHORT.reduce((s, _, i) => s + ((byYm[y + '-' + (i + 1)] || []).length), 0);
    return `<tr>
      <td style="padding:4px 8px;font-weight:800;font-size:13px;white-space:nowrap">${y + 543}</td>
      ${SHORT.map((_, i) => cellHtml(y, i + 1)).join('')}
      <td style="padding:0 4px;text-align:center"><button type="button" ${yearTotal ? `data-pcd-year="${y}"` : 'disabled'} title="${yearTotal ? 'คลิกดูคอมทั้งปี' : ''}" style="min-width:34px;height:30px;border:none;background:transparent;color:var(--primary);font-weight:800;font-size:13px;font-family:inherit;cursor:${yearTotal ? 'pointer' : 'default'};border-radius:6px" ${yearTotal ? "onmouseenter=\"this.style.background='rgba(37,99,235,.1)'\" onmouseleave=\"this.style.background='transparent'\"" : ''}>${yearTotal}</button></td>
    </tr>`;
  }).join('');

  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <div style="font-size:13px;color:var(--text-muted)">ภาพรวมคอมพิวเตอร์ทั้งบริษัท + ข้อมูลช่วยตัดสินใจจัดซื้อ/เปลี่ยนเครื่อง${_pcDashTeam ? ' · <strong style="color:var(--primary)">กรองตามทีม</strong>' : ''}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--text-muted)">ทีม:</span>
        <select id="pcd-team" style="padding:7px 11px;font-size:12.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);max-width:260px;cursor:pointer">${teamOpts}</select>
        <button class="btn" id="pcd-refresh" style="font-size:12px">🔄 รีเฟรช</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px">
      ${card('คอมทั้งหมด', total, '', `ใช้งานอยู่ ${active.length} · สำรอง ${total - active.length}`)}
      ${card('⚠️ ควรพิจารณาเปลี่ยน', needReplace.length, needReplace.length ? '#dc2626' : 'var(--green)', 'notebook&gt;3ปี · mac&gt;5ปี' + (_inProgOnly ? ` · +${_inProgOnly} กำลังดำเนินการ` : ''))}
      ${card('อายุเฉลี่ย', avgAge != null ? (Math.floor(avgAge / 12) + ' ปี ' + (avgAge % 12) + ' ด.') : '—', '', `จาก ${withAge.length} เครื่องที่มีวันที่ซื้อ`)}
      ${card('แยกตาม OS', `${win}<span style="font-size:13px;color:var(--text-muted)"> win</span> · ${mac}<span style="font-size:13px;color:var(--text-muted)"> mac</span>`, '', other ? other + ' อื่น ๆ' : '')}
      ${card('การผูก owner', assigned, 'var(--green)', `ส่วนกลาง ${central} · ยังไม่ผูก ${unassigned}`)}
    </div>

    <!-- v1.9.294 — กลุ่มแยก: ได้เครื่องใหม่ (เครื่องจากการหมุนเวียน) — กำลัง transfer -->
    ${rotationList.length ? `
    <div style="margin-bottom:18px;border:1px solid rgba(21,128,61,.35);background:rgba(21,128,61,.05);border-radius:12px;padding:14px 16px">
      <div style="font-size:13px;font-weight:800;color:#15803d;margin-bottom:3px">♻️ ได้เครื่องใหม่แล้ว (เครื่องจากการหมุนเวียน) — กำลัง transfer ข้อมูล (${rotationList.length})</div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:11px">เครื่องที่ได้รับเครื่องใหม่จากการหมุนเวียน และอยู่ระหว่างย้าย/transfer ข้อมูล</div>
      ${_replGrid(rotationList, true)}
    </div>` : ''}

    <!-- ปฏิทินการซื้อ (ซ้าย) | รายการเดือนที่คลิก (ขวา) -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start;margin-bottom:18px">
      <div>
        <div style="font-size:13px;font-weight:800;margin-bottom:8px">📅 ปฏิทินการซื้อ (ตามเดือน/ปี)</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px">สีเข้ม = ซื้อเยอะ · คลิกช่องเพื่อดูว่าเดือนนั้นซื้ออะไร (แสดงคอลัมน์ขวา)</div>
        <div id="pcd-cal-wrap" style="overflow-x:auto;border:1px solid var(--border);border-radius:10px;padding:6px">
          <table style="width:100%;border-collapse:separate;border-spacing:2px;font-size:11px">
            <thead><tr style="color:var(--text-muted)">
              <th style="padding:2px 6px;text-align:left">ปี</th>${SHORT.map(m => `<th style="padding:2px;text-align:center;font-weight:600">${m.replace('.', '')}</th>`).join('')}<th style="padding:2px 6px">รวม</th>
            </tr></thead>
            <tbody>${calRows || '<tr><td colspan="14" style="padding:18px;text-align:center;color:var(--text-muted)">ยังไม่มีข้อมูลวันที่ซื้อ</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:800;margin-bottom:8px">🛒 รายการที่ซื้อ</div>
        <div id="pcd-month-detail"><div class="empty" style="padding:28px 16px;font-size:12.5px;line-height:1.7">👈 คลิกช่องเดือนในปฏิทิน<br>เพื่อดูว่าเดือนนั้นซื้อคอมอะไรบ้าง</div></div>
      </div>
    </div>

    <!-- การกระจายอายุ (เต็มความกว้าง) -->
    <div style="margin-bottom:18px">
      <div style="font-size:13px;font-weight:800;margin-bottom:8px">📊 การกระจายอายุ (เครื่องที่ใช้งานอยู่)</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-width:720px">
        ${buckets.map(b => `<div style="display:flex;align-items:center;gap:8px">
          <div style="width:64px;font-size:12px;color:var(--text-muted);flex-shrink:0">${b.label}</div>
          <div style="flex:1;background:var(--bg-soft);border-radius:6px;height:20px;overflow:hidden"><div style="height:100%;width:${Math.round(b.count / maxBucket * 100)}%;background:${b.color};border-radius:6px;min-width:${b.count ? 3 : 0}px"></div></div>
          <div style="width:32px;text-align:right;font-weight:700;font-size:12.5px;flex-shrink:0">${b.count}</div>
        </div>`).join('')}
      </div>
      ${noDate ? `<div style="font-size:11px;color:var(--text-soft);margin-top:8px">* อีก ${noDate} เครื่องที่ใช้งานอยู่ยังไม่ได้ระบุวันที่ซื้อ — เติมข้อมูลเพื่อความแม่นยำ</div>` : ''}
    </div>

    <!-- ควรพิจารณาเปลี่ยน (ล่างสุด เต็มความกว้าง) -->
    <div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px">
        <div style="font-size:13px;font-weight:800">⚠️ ควรพิจารณาเปลี่ยน (${needReplace.length})</div>
        ${_replToggle}
      </div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px">เกณฑ์: notebook ใช้เกิน 3 ปี · Mac เกิน 5 ปี · แยกกลุ่มตามหมวดหมายเหตุ</div>
      <div id="pcd-replace-body">${replaceBody}</div>
    </div>`;

  $('pcd-refresh').onclick = () => renderPcDashboard();
  const _pcdTeamSel = $('pcd-team');
  if (_pcdTeamSel) _pcdTeamSel.onchange = () => { _pcDashTeam = _pcdTeamSel.value; renderPcDashboard(); };
  // คลิกการ์ด "ควรเปลี่ยน" → เปิด slide-in รายละเอียดเครื่อง (แก้/ลบแล้ว refresh dashboard)
  const _wireReplaceCards = () => {
    root.querySelectorAll('#pcd-replace-body [data-pcd-replace]').forEach(el => el.addEventListener('click', () => {
      const p = needReplace.find(x => x.id === parseInt(el.dataset.pcdReplace, 10));
      if (p) showHardwareDetail(p, renderPcDashboard);
    }));
  };
  _wireReplaceCards();
  // v1.9.257 — toggle Mac/Windows → re-render เฉพาะ body + re-wire
  root.querySelectorAll('#pcd-repl-toggle [data-repl-filter]').forEach(btn => btn.addEventListener('click', () => {
    _pcdReplaceFilter = btn.dataset.replFilter;
    const body = $('pcd-replace-body');
    if (body) { body.innerHTML = _buildReplaceBody(); _wireReplaceCards(); }
    root.querySelectorAll('#pcd-repl-toggle [data-repl-filter]').forEach(b => {
      const on = b.dataset.replFilter === _pcdReplaceFilter;
      b.style.background = on ? 'var(--bg-card)' : 'transparent';
      b.style.color = on ? 'var(--text)' : 'var(--text-muted)';
      b.style.fontWeight = on ? 700 : 500;
      b.style.boxShadow = on ? 'var(--shadow-sm)' : 'none';
    });
  }));
  // v1.9.287 — แสดงรายการที่ซื้อด้านขวา (เดือน หรือ ทั้งปี) + บรรทัดแผนก
  const _pcdShowDetail = (label, arr) => {
    const det = $('pcd-month-detail');
    const calEl = document.getElementById('pcd-cal-wrap');
    const calH = (calEl && calEl.offsetHeight) ? calEl.offsetHeight : 520;
    det.innerHTML = `<div style="border:1px solid var(--border);border-radius:12px;display:flex;flex-direction:column;max-height:${calH}px;overflow:hidden">
      <div style="font-weight:800;font-size:13px;padding:10px 13px;border-bottom:1px solid var(--border);flex-shrink:0">🛒 ${escapeHtml(label)} — ซื้อ ${arr.length} เครื่อง</div>
      <div style="overflow-y:auto;padding:2px 13px 6px">
        ${arr.map(p => { const dept = _pcDeptOf(p); return `<div data-pcd-item="${p.id}" title="${p.current_member_id ? 'คลิกดูเจ้าของ + อุปกรณ์' : 'คลิกดูรายละเอียดเครื่อง'}" style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12px;cursor:pointer;border-radius:6px;transition:background .1s" onmouseenter="this.style.background='var(--bg-soft)'" onmouseleave="this.style.background='transparent'">
          <span style="flex:1;min-width:0;padding-left:4px"><span style="font-weight:600">${escapeHtml(p.name)}</span> <span style="color:var(--text-muted)">${escapeHtml(p.model || '')}</span>${dept ? `<br><span style="font-size:10.5px;color:var(--text-soft)">🏢 ${escapeHtml(dept)}</span>` : ''}${p.for_new_position ? `<br><span style="display:inline-block;font-size:9.5px;font-weight:700;background:rgba(14,165,233,.12);color:#0284c7;padding:1px 7px;border-radius:999px;margin-top:2px">🆕 ตำแหน่งเปิดใหม่</span>` : ''}</span>
          <span style="color:var(--text-muted);white-space:nowrap;flex-shrink:0;text-align:right;padding-right:4px">${escapeHtml(ownerOf(p))}${p._needsReplace ? '<br><span style="color:#dc2626;font-weight:700">⚠ ควรเปลี่ยน</span>' : ''}</span>
        </div>`; }).join('')}
      </div>
    </div>`;
    det.querySelectorAll('[data-pcd-item]').forEach(el => el.addEventListener('click', () => {
      const p = arr.find(x => x.id === parseInt(el.dataset.pcdItem, 10));
      if (!p) return;
      if (p.current_member_id) _pcdOwnerPanel(p.current_member_id);
      else showHardwareDetail(p, renderPcDashboard);
    }));
  };
  root.querySelectorAll('[data-pcd-ym]').forEach(btn => btn.addEventListener('click', () => {
    const [yy, mm] = btn.dataset.pcdYm.split('-');
    _pcdShowDetail(`${SHORT[(+mm) - 1]} ${(+yy) + 543}`, byYm[btn.dataset.pcdYm] || []);
  }));
  root.querySelectorAll('[data-pcd-year]').forEach(btn => btn.addEventListener('click', () => {
    const y = parseInt(btn.dataset.pcdYear, 10);
    const arr = SHORT.reduce((acc, _, i) => acc.concat(byYm[y + '-' + (i + 1)] || []), []);
    _pcdShowDetail(`ปี ${y + 543} (ทั้งปี)`, arr);
  }));
}

// v1.9.311 — Report: ตารางการเปลี่ยนเครื่อง PC (ปี · เดือน · เครื่องใหม่ · ผู้ใช้ · คอมเดิม 1-3)
// v1.9.315 — คอลัมน์ "ชื่อ" แสดง avatar+display_name+email+แผนก + filter popup (Tableau-style)
let _hwReportData = null;     // { events, years }
let _hwReportYear = '';        // '' = ทุกปี
let _hwReportTeam = '';        // v1.9.323 — '' = ทุกแผนก, หรือ team_id (string) — รวมทีมย่อยอัตโนมัติ
let _hwReportPcCount = '';     // v1.9.326 — '' = ทุกจำนวน, '1' / '2' / '3+' — จำนวน PC ที่ถือครอง
let _hwReportPrev1 = '';       // v1.9.327 — '' = ทั้งหมด, 'empty' = คอมเดิม#1 ว่าง, 'filled' = กรอกแล้ว
let _hwReportMemberFilter = new Set();  // member_ids ที่เลือกแสดง — ว่าง = แสดงทั้งหมด
let _hwReportMemberSearch = '';          // search ใน popup
// v1.9.331 — Tableau-style filter สำหรับคอมเดิม #1 / #2 (Set ของ hardware_id)
let _hwReportPrevSelections = [new Set(), new Set()];   // index 0 = คอมเดิม #1, 1 = คอมเดิม #2
let _hwReportPrevSearch = ['', ''];                     // search text ต่อ slot
const _THAI_MONTHS = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

async function renderHardwareReportPage() {
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">📑 รายงานการเปลี่ยนเครื่อง</h2>
      <span id="hr-count" class="card-sub">—</span>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      Personal Computer ทุกเครื่องที่มีวันสั่งซื้อ (purchased_at) — ตรงกับปฏิทินการซื้อใน Dashboard · ใช้ตามหาว่าใครยังไม่มีบันทึก "คอมเดิม"
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <label style="font-size:12.5px;color:var(--text-muted);font-weight:600">📅 ปี:</label>
      <select id="hr-f-year" style="padding:7px 11px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer;font-weight:600;box-sizing:border-box">
        <option value="">— ทุกปี —</option>
      </select>
      <label style="font-size:12.5px;color:var(--text-muted);font-weight:600;margin-left:6px">🏢 แผนก:</label>
      <select id="hr-f-team" style="padding:7px 11px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer;font-weight:600;box-sizing:border-box;min-width:220px;max-width:340px">
        <option value="">— ทุกแผนก —</option>
      </select>
      <label style="font-size:12.5px;color:var(--text-muted);font-weight:600;margin-left:6px">💻 คอมในครอบครอง:</label>
      <select id="hr-f-pccount" style="padding:7px 11px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer;font-weight:600;box-sizing:border-box">
        <option value="">— ทุกจำนวน —</option>
        <option value="0">0 เครื่อง (ไม่ถือครอง)</option>
        <option value="1">1 เครื่อง</option>
        <option value="2">2 เครื่อง</option>
        <option value="3+">3 เครื่องขึ้นไป</option>
      </select>
      <label style="font-size:12.5px;color:var(--text-muted);font-weight:600;margin-left:6px">📝 คอมเดิม #1:</label>
      <select id="hr-f-prev1" style="padding:7px 11px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer;font-weight:600;box-sizing:border-box">
        <option value="">— ทั้งหมด —</option>
        <option value="empty">ยังไม่มีคอมเดิม (ว่าง)</option>
        <option value="filled">มีคอมเดิมแล้ว</option>
      </select>
    </div>
    <div id="hr-summary" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:14px"></div>
    <div id="hr-list">${skelStack(5)}</div>
  `;
  // v1.9.316 — เตรียม cache ของ members + teams + PC list ไว้ก่อนสำหรับ slide-out (คลิกชื่อ/คลิกเครื่อง)
  let data;
  try {
    const [r, pcRes] = await Promise.all([
      fetchJson('/api/admin/hardware/pc-replacement-report'),
      fetchJson('/api/admin/hardware?type=pc'),
      _ensureHwCaches(),
    ]);
    data = r;
    _pcdAllPcs = pcRes.hardware || [];
  } catch (e) {
    $('hr-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _hwReportData = data;
  const sel = $('hr-f-year');
  (data.years || []).forEach(y => {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = `พ.ศ. ${y + 543}`;
    sel.appendChild(opt);
  });
  sel.value = _hwReportYear;
  sel.addEventListener('change', (e) => {
    _hwReportYear = e.target.value;
    _renderHwReportTable();
  });
  // v1.9.323 — แผนก dropdown: ใช้ team-tree จาก _hwTeamsCache + indent ตาม depth + รวมทีมย่อยอัตโนมัติ
  // v1.9.334 — ใช้   (nbsp) 3 ตัวต่อ depth + prefix '↳' ทุกลูก เพื่อให้ browser ไม่ collapse spaces
  const teamSel = $('hr-f-team');
  const flat = flattenTeamTreeDFS(buildTeamTree(_hwTeamsCache || []));
  flat.forEach(({ team, depth }) => {
    const opt = document.createElement('option');
    opt.value = String(team.id);
    const indent = depth > 0 ? '   '.repeat(depth - 1) + '↳ ' : '';
    opt.textContent = indent + team.name;
    teamSel.appendChild(opt);
  });
  // reset ถ้า team_id ที่จำไว้ไม่อยู่ใน cache แล้ว
  if (_hwReportTeam && !(_hwTeamsCache || []).some(t => String(t.id) === _hwReportTeam)) {
    _hwReportTeam = '';
  }
  teamSel.value = _hwReportTeam;
  teamSel.addEventListener('change', (e) => {
    _hwReportTeam = e.target.value;
    _renderHwReportTable();
  });
  // v1.9.326 — จำนวน PC ที่ถือครอง
  const pcCountSel = $('hr-f-pccount');
  if (pcCountSel) {
    pcCountSel.value = _hwReportPcCount;
    pcCountSel.addEventListener('change', (e) => {
      _hwReportPcCount = e.target.value;
      _renderHwReportTable();
    });
  }
  // v1.9.327 — filter คอมเดิม #1 ว่าง/มี
  const prev1Sel = $('hr-f-prev1');
  if (prev1Sel) {
    prev1Sel.value = _hwReportPrev1;
    prev1Sel.addEventListener('change', (e) => {
      _hwReportPrev1 = e.target.value;
      _renderHwReportTable();
    });
  }
  _renderHwReportTable();
}

function _renderHwReportTable() {
  const wrap = $('hr-list');
  const countEl = $('hr-count');
  const sumEl = $('hr-summary');
  if (!wrap || !_hwReportData) return;
  const events = _hwReportData.events || [];
  // step 1: filter by year
  const byYear = _hwReportYear ? events.filter(e => String(e.year) === _hwReportYear) : events;
  // step 2: filter by team (แผนก) — v1.9.323 รวมทีมย่อยอัตโนมัติ + จับคู่ผ่านชื่อ
  let byTeam = byYear;
  let teamLabel = '';
  if (_hwReportTeam) {
    const tid = parseInt(_hwReportTeam, 10);
    if (Number.isFinite(tid)) {
      const descIds = getTeamDescendantIds(_hwTeamsCache || [], tid);
      const nameSet = new Set();
      (_hwTeamsCache || []).forEach(t => { if (descIds.has(t.id)) nameSet.add(t.name); });
      byTeam = byYear.filter(e => (e.member_teams || []).some(n => nameSet.has(n)));
      const sel = (_hwTeamsCache || []).find(t => t.id === tid);
      teamLabel = sel ? sel.name : '';
    }
  }
  // v1.9.326 — คำนวณจำนวน PC ปัจจุบันต่อ member (จาก _pcdAllPcs)
  const _pcCountByMemberEarly = new Map();
  (_pcdAllPcs || []).forEach(p => {
    if (p.current_member_id != null) _pcCountByMemberEarly.set(p.current_member_id, (_pcCountByMemberEarly.get(p.current_member_id) || 0) + 1);
  });
  const _matchPcCount = (mid) => {
    if (!_hwReportPcCount) return true;
    const n = _pcCountByMemberEarly.get(mid) || 0;
    if (_hwReportPcCount === '3+') return n >= 3;
    return n === parseInt(_hwReportPcCount, 10);
  };
  const byPcCount = _hwReportPcCount ? byTeam.filter(e => e.member_id != null && _matchPcCount(e.member_id)) : byTeam;
  // v1.9.327 — filter คอมเดิม #1 ว่าง/มี
  const byPrev1 = !_hwReportPrev1 ? byPcCount : byPcCount.filter(e => {
    const has = Array.isArray(e.prev_pcs) && !!e.prev_pcs[0];
    return _hwReportPrev1 === 'empty' ? !has : has;
  });
  // v1.9.331 — filter เฉพาะเจาะจง (checkbox popup) ต่อ slot 0/1
  const _prevId = (p) => (p && typeof p === 'object') ? p.id : null;
  const _matchPrevSel = (e, slot) => {
    const sel = _hwReportPrevSelections[slot]; if (!sel || sel.size === 0) return true;
    const pid = _prevId((e.prev_pcs || [])[slot]);
    return pid != null && sel.has(pid);
  };
  const byPrevSel = byPrev1.filter(e => _matchPrevSel(e, 0) && _matchPrevSel(e, 1));
  // step: filter by selected members (empty = all)
  const filtered = _hwReportMemberFilter.size === 0
    ? byPrevSel
    : byPrevSel.filter(e => e.member_id != null && _hwReportMemberFilter.has(e.member_id));
  const filterActive = _hwReportMemberFilter.size > 0;
  const teamFilterActive = !!_hwReportTeam;
  const pcCountActive = !!_hwReportPcCount;
  const prev1Active = !!_hwReportPrev1;
  if (countEl) {
    const tail = [];
    if (teamFilterActive && teamLabel) tail.push(`แผนก ${teamLabel}`);
    if (pcCountActive) tail.push(_hwReportPcCount === '3+' ? 'ถือ ≥3 เครื่อง' : `ถือ ${_hwReportPcCount} เครื่อง`);
    if (prev1Active) tail.push(_hwReportPrev1 === 'empty' ? 'คอมเดิมว่าง' : 'มีคอมเดิม');
    // v1.9.331 — filter คอมเดิม เฉพาะเจาะจง
    if (_hwReportPrevSelections[0].size > 0) tail.push(`คอมเดิม #1: ${_hwReportPrevSelections[0].size} เครื่อง`);
    if (_hwReportPrevSelections[1].size > 0) tail.push(`คอมเดิม #2: ${_hwReportPrevSelections[1].size} เครื่อง`);
    if (filterActive) tail.push(`กรอง ${_hwReportMemberFilter.size} คน`);
    countEl.textContent = tail.length
      ? `${filtered.length} / ${byYear.length} รายการ (${tail.join(' · ')})`
      : `${filtered.length} รายการ`;
  }
  // v1.9.312 — สรุปจำนวนคอมใหม่ + จำนวนที่กรอกคอมเดิม #1 แล้ว
  const withPrev1 = filtered.filter(e => Array.isArray(e.prev_pcs) && e.prev_pcs[0]).length;
  const total = filtered.length;
  const pct = total ? Math.round((withPrev1 / total) * 100) : 0;
  if (sumEl) {
    const cardS = 'background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px';
    const labelS = 'font-size:12px;color:var(--text-muted);font-weight:600;margin-bottom:6px';
    const valS = 'font-size:24px;font-weight:700;color:var(--text);line-height:1.1';
    const subS = 'font-size:11.5px;color:var(--text-muted);margin-top:4px';
    sumEl.innerHTML = `
      <div style="${cardS}">
        <div style="${labelS}">💻 คอมฯใหม่ทั้งหมด</div>
        <div style="${valS}">${total}</div>
        <div style="${subS}">${_hwReportYear ? `พ.ศ. ${parseInt(_hwReportYear, 10) + 543}` : 'ทุกปี'}${filterActive ? ` · กรอง ${_hwReportMemberFilter.size} คน` : ''}</div>
      </div>
      <div style="${cardS}">
        <div style="${labelS}">📝 กรอกคอมเดิมแล้ว (#1)</div>
        <div style="${valS};color:var(--primary)">${withPrev1}</div>
        <div style="${subS}">${pct}% ของ ${total} รายการ · เหลือ ${total - withPrev1}</div>
      </div>
    `;
  }
  const th = 'text-align:left;padding:9px 12px;font-size:12px;color:var(--text-muted);font-weight:600;background:var(--bg-soft);border-bottom:1px solid var(--border);position:sticky;top:0';
  const td = 'padding:10px 12px;font-size:13px;border-bottom:1px solid var(--border);vertical-align:top';
  const tdMuted = td + ';color:var(--text-muted)';
  // v1.9.317 — นับคอมที่อยู่ในครอบครอง (current_member_id) ต่อ member
  const _pcCountByMember = new Map();
  (_pcdAllPcs || []).forEach(p => {
    if (p.current_member_id != null) {
      _pcCountByMember.set(p.current_member_id, (_pcCountByMember.get(p.current_member_id) || 0) + 1);
    }
  });
  const _renderNameCell = (e) => {
    if (!e.member_id) return `<td style="${tdMuted}">—</td>`;
    const name = e.member_name || '—';
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    const av = e.member_avatar
      ? `<img src="${e.member_avatar}" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
      : `<div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:13px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
    const teams = (e.member_teams || []).slice(0, 2);
    const moreTeams = (e.member_teams || []).length - teams.length;
    const teamChips = teams.map(t => `<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:500;background:rgba(37,99,235,.10);color:var(--primary);border:1px solid rgba(37,99,235,.18)">${escapeHtml(t)}</span>`).join('');
    const moreChip = moreTeams > 0 ? `<span style="font-size:10px;color:var(--text-muted)">+${moreTeams}</span>` : '';
    // v1.9.317 — chip แสดงจำนวนเครื่องที่ถือครองปัจจุบัน
    const pcCount = _pcCountByMember.get(e.member_id) || 0;
    const pcChip = `<span title="คอมพิวเตอร์ที่ถือครองปัจจุบัน" style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(16,185,129,.10);color:var(--green);border:1px solid rgba(16,185,129,.22)">💻 ${pcCount} เครื่อง</span>`;
    const emailLine = e.member_email
      ? `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.member_email)}</div>`
      : '';
    const chipLine = `<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px;align-items:center">${teamChips}${moreChip}${pcChip}</div>`;
    // v1.9.332 — กล่องเล็ก 'พนักงานคนก่อน: ...' ถ้ามี replaces_member_id
    const prevPersonBox = (e.replaces_member_id && e.replaces_member_name)
      ? `<div style="margin-top:6px;padding:5px 9px;border:1px dashed rgba(217,119,6,.35);border-radius:7px;background:rgba(245,158,11,.06);font-size:11px;line-height:1.4">
           <span style="color:var(--text-muted);font-weight:500">พนักงานคนก่อน:</span>
           <span style="color:#92400e;font-weight:700">${escapeHtml(e.replaces_member_name)}</span>
         </div>`
      : '';
    return `<td style="${td};cursor:pointer" class="hr-name-click" data-mid="${e.member_id}" title="คลิกดูรายละเอียดผู้ใช้">
      <div style="display:flex;gap:9px;align-items:flex-start;min-width:0">
        ${av}
        <div style="min-width:0;overflow:hidden">
          <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>
          ${emailLine}
          ${chipLine}
          ${prevPersonBox}
        </div>
      </div>
    </td>`;
  };
  // v1.9.316 — เซลล์เครื่อง (คอมที่เปลี่ยน + คอมเดิม) คลิกได้ → showHardwareDetail
  // v1.9.320 — คอมเดิม: เพิ่ม chip ใต้ชื่อ ว่าตอนนี้อยู่ไหน (เจ้าของ / สำรอง / ส่วนกลาง)
  const _prevPcWhereNow = (pcId) => {
    const pc = (_pcdAllPcs || []).find(x => x.id === pcId);
    if (!pc) return null;
    if (pc.current_member_id) {
      const label = pc.current_member_label || ('member#' + pc.current_member_id);
      return { txt: '👤 ' + label, bg: 'rgba(37,99,235,.10)', fg: 'var(--primary)', bd: 'rgba(37,99,235,.20)' };
    }
    if (pc.status === 'retired' || pc.status === 'decommissioned') {
      const m = HW_STATUS_META[pc.status];
      const bd = pc.status === 'retired' ? 'rgba(220,38,38,.20)' : 'rgba(82,82,82,.25)';
      return { txt: m.label, bg: m.bg, fg: m.fg, bd };
    }
    if (pc.unassigned_team_id != null || (pc.storage_location && String(pc.storage_location).trim()) || pc.status === 'stock') {
      const loc = pc.storage_location ? ' · ' + pc.storage_location : '';
      return { txt: '📦 ส่วนกลาง' + loc, bg: 'rgba(245,158,11,.12)', fg: '#92400e', bd: 'rgba(245,158,11,.25)' };
    }
    return { txt: '— ไม่ผูก —', bg: 'var(--bg-soft)', fg: 'var(--text-muted)', bd: 'var(--border)' };
  };
  // v1.9.322 — แสดงอายุคอม (จาก purchased_at) ใต้ชื่อทุกเครื่อง
  const _pcAgeLine = (pcId) => {
    const pc = (_pcdAllPcs || []).find(x => x.id === pcId);
    if (!pc || !pc.purchased_at) return '';
    const ageStr = calcHwAgeStr(pc.purchased_at);
    if (!ageStr) return '';
    return `<div style="font-size:11px;color:var(--accent);font-weight:600;margin-top:2px;white-space:nowrap">⏱ ${escapeHtml(ageStr)}</div>`;
  };
  // v1.9.333 — กล่องเล็ก ๆ แสดง 'หมายเหตุ' ของเครื่อง
  const _pcNotesBox = (pcId) => {
    const pc = (_pcdAllPcs || []).find(x => x.id === pcId);
    if (!pc || !pc.notes || !String(pc.notes).trim()) return '';
    return `<div style="margin-top:5px;padding:4px 8px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:6px;font-size:11px;color:#92400e;line-height:1.4;word-break:break-word;white-space:normal;font-style:italic">📝 ${escapeHtml(pc.notes)}</div>`;
  };
  const _prevCell = (p) => {
    if (!p) return `<td style="${tdMuted}">—</td>`;
    const id = (typeof p === 'object') ? p.id : null;
    const name = (typeof p === 'object') ? (p.name || '—') : String(p);
    const w = id ? _prevPcWhereNow(id) : null;
    const ageLine = id ? _pcAgeLine(id) : '';
    const notesBox = id ? _pcNotesBox(id) : '';
    const chip = w
      ? `<div style="margin-top:3px"><span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:${w.bg};color:${w.fg};border:1px solid ${w.bd};max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(w.txt)}</span></div>`
      : '';
    if (id) return `<td style="${td};cursor:pointer" class="hr-hw-click" data-hwid="${id}" title="คลิกดูรายละเอียดเครื่อง">${escapeHtml(name)}${ageLine}${chip}${notesBox}</td>`;
    return `<td style="${td}">${escapeHtml(name)}${ageLine}${chip}${notesBox}</td>`;
  };
  // v1.9.324 — chip 'ตำแหน่งเปิดใหม่' ใต้คอมที่เปลี่ยน (ถ้า for_new_position=1)
  const _newPositionChip = (pcId) => {
    const pc = (_pcdAllPcs || []).find(x => x.id === pcId);
    if (!pc || !pc.for_new_position) return '';
    return `<div style="margin-top:3px"><span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;background:rgba(14,165,233,.12);color:#0284c7;border:1px solid rgba(14,165,233,.28)">🆕 ตำแหน่งเปิดใหม่</span></div>`;
  };
  // v1.9.330 — chip 'สถานะคอมเก่า' ใต้คอมเดิม #1 — ดึงจาก flag ของ 'คอมที่เปลี่ยน' (เพราะ flag บันทึกเมื่อได้เครื่องใหม่)
  const _oldPcStatusChips = (newHwId) => {
    const pc = (_pcdAllPcs || []).find(x => x.id === newHwId);
    if (!pc) return '';
    const chips = [];
    if (pc.old_pc_bought_by_employee) chips.push({ t: '💵 พนักงานซื้อไป', bg: 'rgba(245,158,11,.12)', fg: '#b45309', bd: 'rgba(245,158,11,.28)' });
    if (pc.old_pc_broken) chips.push({ t: '🛠 ชำรุดซ่อมไม่ได้', bg: 'rgba(220,38,38,.10)', fg: 'var(--critical)', bd: 'rgba(220,38,38,.22)' });
    if (pc.old_pc_donated_sold) chips.push({ t: '🎁 บริจาค/จำหน่าย', bg: 'rgba(14,165,233,.12)', fg: '#0284c7', bd: 'rgba(14,165,233,.28)' });
    if (!chips.length) return '';
    return `<div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:3px">${chips.map(c => `<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;background:${c.bg};color:${c.fg};border:1px solid ${c.bd}">${c.t}</span>`).join('')}</div>`;
  };
  // v1.9.334 — จับกลุ่มแถวของคนเดียวกันให้ติดกัน (คนที่มี 2+ เครื่อง)
  //   preserves purchased_at DESC ordering of the group's first occurrence
  const _grouped = (() => {
    const byMember = new Map();
    const order = [];
    for (const e of filtered) {
      if (e.member_id == null) { order.push({ solo: e }); continue; }
      if (!byMember.has(e.member_id)) { byMember.set(e.member_id, []); order.push({ mid: e.member_id }); }
      byMember.get(e.member_id).push(e);
    }
    const out = [];
    for (const it of order) {
      if (it.solo) out.push(it.solo);
      else out.push(...byMember.get(it.mid));
    }
    return out;
  })();
  // v1.9.335 — highlight สีให้กลุ่มที่คนเดียวกันมี 2+ เครื่อง (สลับ palette)
  const _memberRowCount = new Map();
  _grouped.forEach(e => { if (e.member_id != null) _memberRowCount.set(e.member_id, (_memberRowCount.get(e.member_id) || 0) + 1); });
  const _GROUP_PALETTE = [
    { bg: 'rgba(37,99,235,.07)',  bd: '#2563eb' },  // blue
    { bg: 'rgba(16,185,129,.08)', bd: '#10b981' },  // green
    { bg: 'rgba(245,158,11,.09)', bd: '#f59e0b' },  // amber
    { bg: 'rgba(168,85,247,.07)', bd: '#a855f7' },  // purple
    { bg: 'rgba(14,165,233,.08)', bd: '#0ea5e9' },  // sky
    { bg: 'rgba(236,72,153,.06)', bd: '#ec4899' },  // pink
  ];
  const _groupColorIdx = new Map();
  let _paletteCounter = 0;
  _grouped.forEach(e => {
    if (e.member_id != null && _memberRowCount.get(e.member_id) >= 2 && !_groupColorIdx.has(e.member_id)) {
      _groupColorIdx.set(e.member_id, _paletteCounter++);
    }
  });
  const rows = _grouped.map(e => {
    const prev = e.prev_pcs || [];
    const newAge = e.hardware_id ? _pcAgeLine(e.hardware_id) : '';
    const newPos = e.hardware_id ? _newPositionChip(e.hardware_id) : '';
    const newNotes = e.hardware_id ? _pcNotesBox(e.hardware_id) : '';
    const newCell = e.hardware_id
      ? `<td style="${td};font-weight:600;cursor:pointer" class="hr-hw-click" data-hwid="${e.hardware_id}" title="คลิกดูรายละเอียดเครื่อง">${escapeHtml(e.new_pc || '—')}${newAge}${newPos}${newNotes}</td>`
      : `<td style="${td};font-weight:600">${escapeHtml(e.new_pc || '—')}${newAge}${newPos}${newNotes}</td>`;
    // คอมเดิม #1 — ต่อท้ายด้วย chip สถานะคอมเก่า (ถ้ามี tick)
    const prev1Cell = _prevCell(prev[0]);
    const oldStatus = e.hardware_id ? _oldPcStatusChips(e.hardware_id) : '';
    const prev1WithStatus = oldStatus ? prev1Cell.replace(/<\/td>$/, oldStatus + '</td>') : prev1Cell;
    // v1.9.335 — inline background + left border สำหรับ row ที่อยู่ในกลุ่ม
    const gIdx = (e.member_id != null && _groupColorIdx.has(e.member_id)) ? _groupColorIdx.get(e.member_id) : -1;
    const trStyle = gIdx >= 0
      ? ` style="background:${_GROUP_PALETTE[gIdx % _GROUP_PALETTE.length].bg};box-shadow:inset 3px 0 0 ${_GROUP_PALETTE[gIdx % _GROUP_PALETTE.length].bd}"`
      : '';
    return `<tr${trStyle}>
      <td style="${td};white-space:nowrap;color:var(--text-muted)">${e.year + 543}</td>
      <td style="${td};white-space:nowrap;color:var(--text-muted)">${_THAI_MONTHS[e.month] || e.month}</td>
      ${newCell}
      ${_renderNameCell(e)}
      ${prev1WithStatus}${_prevCell(prev[1])}${_prevCell(prev[2])}
    </tr>`;
  }).join('');
  // ปุ่ม filter ในหัวคอลัมน์ "ชื่อ" — สีเปลี่ยนเมื่อมี filter
  const filterBtn = `
    <button type="button" id="hr-name-filter-btn" title="กรองรายชื่อที่จะแสดง"
      style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:6px;border-radius:5px;border:1px solid ${filterActive ? 'var(--primary)' : 'var(--border)'};background:${filterActive ? 'rgba(37,99,235,.10)' : 'var(--bg-card)'};color:${filterActive ? 'var(--primary)' : 'var(--text-muted)'};cursor:pointer;font-size:11px;font-family:inherit;padding:0;line-height:1;vertical-align:middle">
      ${filterActive ? '▼' : '⏷'}
    </button>`;
  // v1.9.331 — filter button สำหรับคอมเดิม #1 / #2
  const _prevFilterBtn = (slot) => {
    const active = _hwReportPrevSelections[slot].size > 0;
    return `<button type="button" class="hr-prev-filter-btn" data-slot="${slot}" title="กรองคอมเดิมที่จะแสดง"
      style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:6px;border-radius:5px;border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'rgba(37,99,235,.10)' : 'var(--bg-card)'};color:${active ? 'var(--primary)' : 'var(--text-muted)'};cursor:pointer;font-size:11px;font-family:inherit;padding:0;line-height:1;vertical-align:middle">
      ${active ? '▼' : '⏷'}
    </button>`;
  };
  wrap.innerHTML = filtered.length === 0
    ? `<div class="empty" style="padding:32px;text-align:center">
        <div style="font-size:48px;margin-bottom:6px">📭</div>
        <div style="font-weight:600;color:var(--text)">ไม่มีข้อมูลตาม filter</div>
        ${filterActive ? '<button type="button" id="hr-clear-from-empty" class="btn" style="margin-top:10px;font-size:12.5px">เคลียร์ตัวกรองรายชื่อ</button>' : ''}
      </div>`
    : `
    <div style="position:relative;border:1px solid var(--border);border-radius:10px;overflow:visible;background:var(--bg-card)">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-family:inherit">
          <thead><tr>
            <th style="${th}">ปี</th>
            <th style="${th}">เดือน</th>
            <th style="${th}">คอมฯที่เปลี่ยน</th>
            <th style="${th};position:relative"><span style="vertical-align:middle">ชื่อ</span>${filterBtn}</th>
            <th style="${th};position:relative"><span style="vertical-align:middle">คอมเดิม #1</span>${_prevFilterBtn(0)}</th>
            <th style="${th};position:relative"><span style="vertical-align:middle">คอมเดิม #2</span>${_prevFilterBtn(1)}</th>
            <th style="${th}">คอมเดิม #3</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
  // wire filter button + clear-from-empty button
  const fBtn = $('hr-name-filter-btn');
  if (fBtn) fBtn.addEventListener('click', (ev) => { ev.stopPropagation(); _toggleHwReportMemberPopup(fBtn); });
  const cBtn = $('hr-clear-from-empty');
  if (cBtn) cBtn.addEventListener('click', () => { _hwReportMemberFilter.clear(); _renderHwReportTable(); });
  // v1.9.331 — wire filter buttons ของคอลัมน์คอมเดิม
  wrap.querySelectorAll('.hr-prev-filter-btn').forEach(btn => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const slot = parseInt(btn.dataset.slot, 10);
    if (Number.isFinite(slot)) _toggleHwReportPrevPopup(btn, slot);
  }));
  // v1.9.316 — คลิกชื่อ → owner panel · คลิกเครื่อง → hardware detail
  const _refresh = async () => {
    try {
      const [r, pcRes] = await Promise.all([
        fetchJson('/api/admin/hardware/pc-replacement-report'),
        fetchJson('/api/admin/hardware?type=pc'),
      ]);
      _hwReportData = r;
      _pcdAllPcs = pcRes.hardware || [];
    } catch (_) { /* ignore */ }
    _renderHwReportTable();
  };
  wrap.querySelectorAll('.hr-name-click').forEach(el => el.addEventListener('click', () => {
    const mid = parseInt(el.dataset.mid, 10);
    if (Number.isFinite(mid)) _pcdOwnerPanel(mid, _refresh);
  }));
  wrap.querySelectorAll('.hr-hw-click').forEach(el => el.addEventListener('click', () => {
    const hid = parseInt(el.dataset.hwid, 10);
    const pc = _pcdAllPcs.find(p => p.id === hid);
    if (pc) showHardwareDetail(pc, _refresh);
  }));
}

// v1.9.315 — popup เลือกคนแสดงในตาราง — Tableau-style
function _toggleHwReportMemberPopup(anchor) {
  const existing = document.getElementById('hr-name-popup');
  if (existing) { existing.remove(); document.removeEventListener('mousedown', _hwReportMemberPopupClickOutside, true); return; }
  if (!_hwReportData) return;
  // unique members from current year + team filter + pc-count filter (v1.9.326)
  const events = _hwReportData.events || [];
  const byYear = _hwReportYear ? events.filter(e => String(e.year) === _hwReportYear) : events;
  let byTeam = byYear;
  if (_hwReportTeam) {
    const tid = parseInt(_hwReportTeam, 10);
    if (Number.isFinite(tid)) {
      const descIds = getTeamDescendantIds(_hwTeamsCache || [], tid);
      const nameSet = new Set();
      (_hwTeamsCache || []).forEach(t => { if (descIds.has(t.id)) nameSet.add(t.name); });
      byTeam = byYear.filter(e => (e.member_teams || []).some(n => nameSet.has(n)));
    }
  }
  let byPcCount = byTeam;
  if (_hwReportPcCount) {
    const cnt = new Map();
    (_pcdAllPcs || []).forEach(p => { if (p.current_member_id != null) cnt.set(p.current_member_id, (cnt.get(p.current_member_id) || 0) + 1); });
    const match = (mid) => {
      const n = cnt.get(mid) || 0;
      if (_hwReportPcCount === '3+') return n >= 3;
      return n === parseInt(_hwReportPcCount, 10);
    };
    byPcCount = byTeam.filter(e => e.member_id != null && match(e.member_id));
  }
  // v1.9.327 — filter คอมเดิม #1 ว่าง/มี
  const byPrev1 = !_hwReportPrev1 ? byPcCount : byPcCount.filter(e => {
    const has = Array.isArray(e.prev_pcs) && !!e.prev_pcs[0];
    return _hwReportPrev1 === 'empty' ? !has : has;
  });
  const seen = new Map();
  byPrev1.forEach(e => {
    if (e.member_id != null && !seen.has(e.member_id)) {
      seen.set(e.member_id, { id: e.member_id, name: e.member_name || '—', email: e.member_email || '', avatar: e.member_avatar || null, teams: e.member_teams || [] });
    }
  });
  const members = Array.from(seen.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));

  const popup = document.createElement('div');
  popup.id = 'hr-name-popup';
  popup.style.cssText = 'position:absolute;z-index:200;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);width:320px;max-height:420px;display:flex;flex-direction:column;font-family:inherit';
  popup.innerHTML = `
    <div style="padding:10px 12px 8px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
        <span style="font-size:12.5px;font-weight:700;color:var(--text)">กรองรายชื่อ</span>
        <button type="button" id="hr-popup-clear" style="font-size:11px;border:none;background:none;color:var(--primary);cursor:pointer;padding:2px 4px;font-family:inherit;font-weight:600">เคลียร์ทั้งหมด</button>
      </div>
      <input id="hr-popup-search" type="text" placeholder="🔍 ค้นหา..." autocomplete="off"
        style="width:100%;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);box-sizing:border-box;font-family:inherit" />
    </div>
    <div id="hr-popup-list" style="flex:1;overflow-y:auto;padding:4px"></div>
    <div style="padding:8px 12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span id="hr-popup-count" style="font-size:11px;color:var(--text-muted)"></span>
      <button type="button" id="hr-popup-done" class="btn primary" style="font-size:12px;padding:5px 12px">เสร็จ</button>
    </div>
  `;
  // position relative to anchor — append to body, use viewport coords
  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.top = (r.bottom + 6) + 'px';
  // align to right edge of anchor, but clip to viewport
  let left = r.left;
  const vw = window.innerWidth;
  if (left + 320 > vw - 12) left = vw - 320 - 12;
  if (left < 12) left = 12;
  popup.style.left = left + 'px';

  const listEl = popup.querySelector('#hr-popup-list');
  const countEl = popup.querySelector('#hr-popup-count');
  const renderList = () => {
    const q = _hwReportMemberSearch.trim().toLowerCase();
    const matched = !q ? members : members.filter(m =>
      (m.name || '').toLowerCase().includes(q) ||
      (m.email || '').toLowerCase().includes(q) ||
      (m.teams || []).some(t => (t || '').toLowerCase().includes(q))
    );
    if (matched.length === 0) {
      listEl.innerHTML = '<div style="padding:18px 12px;font-size:12px;color:var(--text-muted);text-align:center">ไม่พบ</div>';
    } else {
      listEl.innerHTML = matched.map(m => {
        const checked = _hwReportMemberFilter.has(m.id);
        const initial = (m.name || '?').trim().charAt(0).toUpperCase();
        const av = m.avatar
          ? `<img src="${m.avatar}" alt="" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
          : `<div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
        const team = (m.teams || [])[0] || '';
        return `<label data-mid="${m.id}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;transition:background .1s" onmouseenter="this.style.background='var(--bg-soft)'" onmouseleave="this.style.background='transparent'">
          <input type="checkbox" data-mid="${m.id}" ${checked ? 'checked' : ''} style="margin:0;cursor:pointer" />
          ${av}
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.name)}</div>
            ${team ? `<div style="font-size:10.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(team)}</div>` : ''}
          </div>
        </label>`;
      }).join('');
      listEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          const mid = parseInt(cb.dataset.mid, 10);
          if (cb.checked) _hwReportMemberFilter.add(mid); else _hwReportMemberFilter.delete(mid);
          updateCount();
        });
      });
    }
    updateCount();
  };
  const updateCount = () => {
    if (countEl) countEl.textContent = _hwReportMemberFilter.size === 0
      ? `แสดงทั้งหมด (${members.length} คน)`
      : `เลือก ${_hwReportMemberFilter.size} / ${members.length} คน`;
  };
  renderList();
  popup.querySelector('#hr-popup-search').addEventListener('input', (e) => { _hwReportMemberSearch = e.target.value; renderList(); });
  popup.querySelector('#hr-popup-clear').addEventListener('click', () => { _hwReportMemberFilter.clear(); renderList(); });
  popup.querySelector('#hr-popup-done').addEventListener('click', () => {
    popup.remove();
    document.removeEventListener('mousedown', _hwReportMemberPopupClickOutside, true);
    _renderHwReportTable();
  });
  setTimeout(() => popup.querySelector('#hr-popup-search').focus(), 30);
  document.addEventListener('mousedown', _hwReportMemberPopupClickOutside, true);
}
function _hwReportMemberPopupClickOutside(e) {
  const popup = document.getElementById('hr-name-popup');
  if (!popup) return;
  if (popup.contains(e.target)) return;
  if (e.target.closest('#hr-name-filter-btn')) return;
  popup.remove();
  document.removeEventListener('mousedown', _hwReportMemberPopupClickOutside, true);
  _renderHwReportTable();
}

// v1.9.331 — popup เลือกคอมเดิม (Tableau-style) ต่อ slot (0 = #1, 1 = #2)
function _toggleHwReportPrevPopup(anchor, slot) {
  const existing = document.getElementById('hr-prev-popup');
  if (existing) { existing.remove(); document.removeEventListener('mousedown', _hwReportPrevPopupClickOutside, true); return; }
  if (!_hwReportData) return;
  // Apply upstream filters (year/team/pcCount/prev1) — respect other filters so the list is contextual
  const events = _hwReportData.events || [];
  const byYear = _hwReportYear ? events.filter(e => String(e.year) === _hwReportYear) : events;
  let byTeam = byYear;
  if (_hwReportTeam) {
    const tid = parseInt(_hwReportTeam, 10);
    if (Number.isFinite(tid)) {
      const descIds = getTeamDescendantIds(_hwTeamsCache || [], tid);
      const nameSet = new Set();
      (_hwTeamsCache || []).forEach(t => { if (descIds.has(t.id)) nameSet.add(t.name); });
      byTeam = byYear.filter(e => (e.member_teams || []).some(n => nameSet.has(n)));
    }
  }
  let byPcCount = byTeam;
  if (_hwReportPcCount) {
    const cnt = new Map();
    (_pcdAllPcs || []).forEach(p => { if (p.current_member_id != null) cnt.set(p.current_member_id, (cnt.get(p.current_member_id) || 0) + 1); });
    const match = (mid) => {
      const n = cnt.get(mid) || 0;
      if (_hwReportPcCount === '3+') return n >= 3;
      return n === parseInt(_hwReportPcCount, 10);
    };
    byPcCount = byTeam.filter(e => e.member_id != null && match(e.member_id));
  }
  const byPrev1 = !_hwReportPrev1 ? byPcCount : byPcCount.filter(e => {
    const has = Array.isArray(e.prev_pcs) && !!e.prev_pcs[0];
    return _hwReportPrev1 === 'empty' ? !has : has;
  });
  // แต่ละ slot: unique PCs (id + name) จาก prev_pcs[slot]
  const seen = new Map();
  byPrev1.forEach(e => {
    const p = (e.prev_pcs || [])[slot];
    if (p && typeof p === 'object' && p.id != null && !seen.has(p.id)) {
      seen.set(p.id, { id: p.id, name: p.name || ('PC#' + p.id) });
    }
  });
  const pcs = Array.from(seen.values()).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));
  const sel = _hwReportPrevSelections[slot];

  const popup = document.createElement('div');
  popup.id = 'hr-prev-popup';
  popup.dataset.slot = String(slot);
  popup.style.cssText = 'position:fixed;z-index:200;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);width:320px;max-height:420px;display:flex;flex-direction:column;font-family:inherit';
  popup.innerHTML = `
    <div style="padding:10px 12px 8px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
        <span style="font-size:12.5px;font-weight:700;color:var(--text)">กรองคอมเดิม #${slot + 1}</span>
        <button type="button" id="hr-prev-clear" style="font-size:11px;border:none;background:none;color:var(--primary);cursor:pointer;padding:2px 4px;font-family:inherit;font-weight:600">เคลียร์ทั้งหมด</button>
      </div>
      <input id="hr-prev-search" type="text" placeholder="🔍 ค้นหาชื่อเครื่อง..." autocomplete="off"
        style="width:100%;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);box-sizing:border-box;font-family:inherit" />
    </div>
    <div id="hr-prev-list" style="flex:1;overflow-y:auto;padding:4px"></div>
    <div style="padding:8px 12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span id="hr-prev-count" style="font-size:11px;color:var(--text-muted)"></span>
      <button type="button" id="hr-prev-done" class="btn primary" style="font-size:12px;padding:5px 12px">เสร็จ</button>
    </div>
  `;
  document.body.appendChild(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.top = (r.bottom + 6) + 'px';
  let left = r.left;
  const vw = window.innerWidth;
  if (left + 320 > vw - 12) left = vw - 320 - 12;
  if (left < 12) left = 12;
  popup.style.left = left + 'px';

  const listEl = popup.querySelector('#hr-prev-list');
  const countEl = popup.querySelector('#hr-prev-count');
  const renderList = () => {
    const q = (_hwReportPrevSearch[slot] || '').trim().toLowerCase();
    const matched = !q ? pcs : pcs.filter(p => (p.name || '').toLowerCase().includes(q));
    if (matched.length === 0) {
      listEl.innerHTML = '<div style="padding:18px 12px;font-size:12px;color:var(--text-muted);text-align:center">ไม่พบ</div>';
    } else {
      listEl.innerHTML = matched.map(p => {
        const checked = sel.has(p.id);
        return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12.5px;transition:background .1s" onmouseenter="this.style.background='var(--bg-soft)'" onmouseleave="this.style.background='transparent'">
          <input type="checkbox" data-pid="${p.id}" ${checked ? 'checked' : ''} style="margin:0;cursor:pointer" />
          <div style="min-width:0;flex:1">
            <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.name)}</div>
          </div>
        </label>`;
      }).join('');
      listEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          const pid = parseInt(cb.dataset.pid, 10);
          if (cb.checked) sel.add(pid); else sel.delete(pid);
          updateCount();
        });
      });
    }
    updateCount();
  };
  const updateCount = () => {
    if (countEl) countEl.textContent = sel.size === 0
      ? `แสดงทั้งหมด (${pcs.length} เครื่อง)`
      : `เลือก ${sel.size} / ${pcs.length} เครื่อง`;
  };
  renderList();
  popup.querySelector('#hr-prev-search').addEventListener('input', (e) => { _hwReportPrevSearch[slot] = e.target.value; renderList(); });
  popup.querySelector('#hr-prev-clear').addEventListener('click', () => { sel.clear(); renderList(); });
  popup.querySelector('#hr-prev-done').addEventListener('click', () => {
    popup.remove();
    document.removeEventListener('mousedown', _hwReportPrevPopupClickOutside, true);
    _renderHwReportTable();
  });
  setTimeout(() => popup.querySelector('#hr-prev-search').focus(), 30);
  document.addEventListener('mousedown', _hwReportPrevPopupClickOutside, true);
}
function _hwReportPrevPopupClickOutside(e) {
  const popup = document.getElementById('hr-prev-popup');
  if (!popup) return;
  if (popup.contains(e.target)) return;
  if (e.target.closest('.hr-prev-filter-btn')) return;
  popup.remove();
  document.removeEventListener('mousedown', _hwReportPrevPopupClickOutside, true);
  _renderHwReportTable();
}

async function renderHardwarePage(type) {
  if (type) _hwActiveType = type;
  _hwSearch = '';
  _hwOsFilter = '';
  _hwDeptFilter = '';
  _hwLinkFilter = '';
  _hwGraveyard = false;
  _hwSort = '';
  const tab = HW_TYPES.find(t => t.id === _hwActiveType) || HW_TYPES[0];
  const isPc = _hwActiveType === 'pc';
  // v1.9.250 — filter เป็น dropdown ด้านบน (ประหยัดที่)
  const selS = 'padding:7px 11px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer;max-width:260px;font-weight:600;box-sizing:border-box';
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">${tab.icon} ${escapeHtml(tab.label)}</h2>
      <div style="display:flex;gap:8px;align-items:center">
        ${isPc ? `<button class="btn" id="hw-graveyard-btn" title="เครื่องพัง (สถานะทั่วไป + หมายเหตุมีคำว่า 'พัง')" style="font-size:13px">🪦 Graveyard</button>` : ''}
        <button class="btn primary" id="hw-add-btn">+ เพิ่ม ${escapeHtml(tab.label)}</button>
      </div>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      จัดการ ${escapeHtml(tab.label)} — ผูกกับผู้ดูแลปัจจุบัน + เก็บประวัติการครอบครอง
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <input id="hw-search" type="text" placeholder="🔍 ค้นหาชื่อ / asset / owner..." autocomplete="off"
        style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);box-sizing:border-box" />
      <span id="hw-count" style="color:var(--text-muted);font-size:12.5px;font-weight:600;white-space:nowrap">— รายการ</span>
    </div>
    ${isPc ? `
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <select id="hw-f-link" style="${selS}"></select>
        <select id="hw-f-dept" style="${selS}"></select>
        <select id="hw-f-os" style="${selS}"></select>
        <select id="hw-f-sort" style="${selS}">
          <option value="">↕️ เรียง: ชื่อ (ก-ฮ)</option>
          <option value="purchase_desc">🛒 ซื้อล่าสุด → เก่า</option>
          <option value="purchase_asc">🛒 ซื้อเก่าสุด → ใหม่</option>
          <option value="created_desc">➕ เพิ่มล่าสุด → เก่า</option>
          <option value="created_asc">➕ เพิ่มเก่าสุด → ใหม่</option>
        </select>
      </div>
    ` : ''}
    <div id="hw-list">${isPc ? skelGrid(6) : skelStack(5)}</div>
  `;
  $('hw-add-btn').addEventListener('click', () => showHardwareModal(null, _hwActiveType));
  $('hw-search').addEventListener('input', (e) => {
    _hwSearch = e.target.value;
    renderHardwareRows();
  });
  // v1.9.366 — Graveyard toggle: แสดงเฉพาะเครื่องพัง
  if (isPc) {
    const gvBtn = $('hw-graveyard-btn');
    if (gvBtn) gvBtn.addEventListener('click', () => {
      _hwGraveyard = !_hwGraveyard;
      gvBtn.classList.toggle('primary', _hwGraveyard);
      renderHardwareRows();
    });
  }
  if (isPc) {
    $('hw-f-link').addEventListener('change', (e) => { _hwLinkFilter = e.target.value; renderHardwareRows(); });
    $('hw-f-dept').addEventListener('change', (e) => { _hwDeptFilter = e.target.value; renderHardwareRows(); });
    $('hw-f-os').addEventListener('change', (e) => { _hwOsFilter = e.target.value; renderHardwareRows(); });
    $('hw-f-sort').addEventListener('change', (e) => { _hwSort = e.target.value; renderHardwareRows(); });
  }
  // โหลด members + teams refresh ทุกครั้ง — กัน stale cache
  // owner picker แสดง "ทุก member" ไม่ว่า is_admin หรือ enabled เป็นอะไร
  // teams cache ใช้ใน sidebar filter (แผนก = team tree)
  try {
    const [md, td] = await Promise.all([
      fetchJson('/api/admin/members'),
      fetchJson('/api/admin/teams'),
    ]);
    _hwMembersCache = md.members || [];
    _hwTeamsCache = td.teams || [];
  } catch (_) { /* ignore */ }
  await loadHardware();
}

// v1.9.61 — helpers สำหรับ team-based dept filter + cross-filter counts
function getHwOwnerTeamIds(h) {
  if (!h.current_member_id) return null;
  const owner = _hwMembersCache.find(m => m.id === h.current_member_id);
  if (!owner) return null;
  return new Set((owner.teams || []).map(t => t.id));
}
function _searchMatchHw(h, q) {
  if (!q) return true;
  return (h.name || '').toLowerCase().includes(q)
      || (h.asset_number || '').toLowerCase().includes(q)
      || (h.current_member_label || '').toLowerCase().includes(q)
      || (h.current_member_username || '').toLowerCase().includes(q)
      || (h.device_subtype || '').toLowerCase().includes(q)
      || (h.notes || '').toLowerCase().includes(q);
}
// v1.9.232 — คอมส่วนกลาง = ไม่มี owner แต่ถูก "ระบุ" แล้ว (มีทีมที่สังกัด / ที่เก็บ / status=stock)
function _isHwCentral(h) {
  if (h.current_member_id) return false;
  return h.unassigned_team_id != null
    || (h.storage_location && String(h.storage_location).trim() !== '')
    || h.status === 'stock';
}
// apply all PC filters except `excludeKey` ('os' | 'dept' | 'link' | null = all)
function applyHwFiltersExcept(h, excludeKey, q) {
  if (!_searchMatchHw(h, q)) return false;
  // v1.9.366 — Graveyard: สถานะทั่วไป (note_category ว่าง/general) + หมายเหตุมีคำว่า 'พัง'
  if (_hwGraveyard) {
    const cat = h.note_category || 'general';
    if (cat !== 'general') return false;
    if (!(h.notes && h.notes.includes('พัง'))) return false;
  }
  if (excludeKey !== 'os' && _hwOsFilter && classifyHwOs(h.os) !== _hwOsFilter) return false;
  if (excludeKey !== 'link') {
    if (_hwLinkFilter === 'linked' && !h.current_member_id) return false;
    if (_hwLinkFilter === 'central' && !_isHwCentral(h)) return false;
    // ยังไม่ได้เชื่อมจริง ๆ = ไม่มี owner และไม่ใช่คอมส่วนกลาง
    if (_hwLinkFilter === 'unlinked' && (h.current_member_id || _isHwCentral(h))) return false;
    // v1.9.252 — คอมพิวเตอร์ของตนเอง (BYOD)
    if (_hwLinkFilter === 'personal' && !h.is_personal_owned) return false;
  }
  if (excludeKey !== 'dept' && _hwDeptFilter) {
    const tid = parseInt(_hwDeptFilter, 10);
    if (!Number.isFinite(tid)) return false;
    const subtree = getTeamDescendantIds(_hwTeamsCache, tid);
    const ownerTids = getHwOwnerTeamIds(h);
    let hit = false;
    if (ownerTids && ownerTids.size > 0) {
      for (const t of ownerTids) { if (subtree.has(t)) { hit = true; break; } }
    } else if (h.unassigned_team_id != null) {
      // v1.9.65 — unlinked PC: ใช้ unassigned_team_id
      if (subtree.has(h.unassigned_team_id)) hit = true;
    }
    if (!hit) return false;
  }
  return true;
}

// v1.9.251 — เรียงลำดับ PC ตามวันสั่งซื้อ (purchased_at = ISO YYYY-MM-DD CE → string sort ตรง)
// v1.9.310 — เพิ่มเรียงตามวันที่เพิ่มเข้าระบบ (created_at)
function _hwSortList(list) {
  const byPurchase = _hwSort === 'purchase_desc' || _hwSort === 'purchase_asc';
  const byCreated  = _hwSort === 'created_desc'  || _hwSort === 'created_asc';
  if (!byPurchase && !byCreated) return list;
  const field = byPurchase ? 'purchased_at' : 'created_at';
  const sliceLen = byPurchase ? 10 : 32;   // purchased_at = วันเดียว, created_at = full ISO timestamp
  const dir = (_hwSort === 'purchase_desc' || _hwSort === 'created_desc') ? -1 : 1;
  return [...list].sort((a, b) => {
    const pa = (a[field] || '').slice(0, sliceLen);
    const pb = (b[field] || '').slice(0, sliceLen);
    if (!pa && !pb) return 0;
    if (!pa) return 1;            // เครื่องที่ไม่มีข้อมูล → ท้ายสุดเสมอ
    if (!pb) return -1;
    return pa < pb ? -dir : pa > pb ? dir : 0;
  });
}

// v1.9.250 — Filter dropdowns (PC only) — การเชื่อมโยง / แผนก team-tree / OS — cross-filter counts
function renderHwFilters() {
  const q = _hwSearch.trim().toLowerCase();

  // คำนวณชุด PCs "ที่จะเหลือ" สำหรับแต่ละ filter (โดยไม่นับ filter ของตัวเอง)
  const visForLink = _hwCache.filter(h => applyHwFiltersExcept(h, 'link', q));
  const visForOs   = _hwCache.filter(h => applyHwFiltersExcept(h, 'os', q));
  const visForDept = _hwCache.filter(h => applyHwFiltersExcept(h, 'dept', q));

  // === Link ===
  let linkedCount = 0, centralCount = 0, unlinkedCount = 0, personalCount = 0;
  visForLink.forEach(h => {
    if (h.current_member_id) linkedCount++;
    else if (_isHwCentral(h)) centralCount++;
    else unlinkedCount++;
    if (h.is_personal_owned) personalCount++;   // v1.9.252 — orthogonal
  });

  // === OS ===
  const osLabels = { mac: '🍎 Mac', windows: '🪟 Windows', linux: '🐧 Linux', other: '🖥 อื่น ๆ' };
  const osCounts = { mac: 0, windows: 0, linux: 0, other: 0 };
  visForOs.forEach(h => {
    if (!h.os) return;
    const c = classifyHwOs(h.os);
    if (osCounts[c] != null) osCounts[c]++;
  });

  // === Dept (team tree) ===
  const teamCounts = {};   // team_id → count
  const teamById = new Map(_hwTeamsCache.map(t => [t.id, t]));
  const walkUpToAncestors = (startId, out) => {
    let cur = startId;
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      out.add(cur);
      const t = teamById.get(cur);
      cur = t ? (t.parent_team_id ?? null) : null;
    }
  };
  visForDept.forEach(h => {
    const contributedTo = new Set();
    const ownerTids = getHwOwnerTeamIds(h);
    if (ownerTids && ownerTids.size > 0) {
      for (const tid of ownerTids) walkUpToAncestors(tid, contributedTo);
    } else if (h.unassigned_team_id != null) {
      walkUpToAncestors(h.unassigned_team_id, contributedTo);
    }
    contributedTo.forEach(tid => { teamCounts[tid] = (teamCounts[tid] || 0) + 1; });
  });
  if (_hwDeptFilter && !teamById.has(parseInt(_hwDeptFilter, 10))) _hwDeptFilter = '';

  // populate <select>s (ถ้ามีในหน้า)
  const linkSel = $('hw-f-link');
  if (linkSel) {
    linkSel.innerHTML = [
      `<option value="">🔗 การเชื่อมโยง: ทั้งหมด (${visForLink.length})</option>`,
      `<option value="linked">✅ เชื่อมแล้ว (${linkedCount})</option>`,
      `<option value="central">📦 คอมฯส่วนกลาง (${centralCount})</option>`,
      `<option value="unlinked">🔓 ยังไม่ได้เชื่อม (${unlinkedCount})</option>`,
      `<option value="personal">🙋 ใช้เครื่องตนเอง (${personalCount})</option>`,
    ].join('');
    linkSel.value = _hwLinkFilter;
  }
  const osSel = $('hw-f-os');
  if (osSel) {
    osSel.innerHTML = [
      `<option value="">💿 ทุก OS (${visForOs.length})</option>`,
      ...['mac', 'windows', 'linux', 'other']
        .filter(k => osCounts[k] > 0 || _hwOsFilter === k)
        .map(k => `<option value="${k}">${osLabels[k]} (${osCounts[k]})</option>`),
    ].join('');
    osSel.value = _hwOsFilter;
  }
  const deptSel = $('hw-f-dept');
  if (deptSel) {
    const tree = buildTeamTree(_hwTeamsCache);
    const flat = flattenTeamTreeDFS(tree);
    const opts = [`<option value="">🏢 ทุกแผนก (${visForDept.length})</option>`];
    flat.forEach(({ team: t, depth }) => {
      const count = teamCounts[t.id] || 0;
      if (count === 0 && _hwDeptFilter !== String(t.id)) return;   // ซ่อนทีมที่ไม่มี PC
      const indent = '   '.repeat(depth);
      const prefix = depth > 0 ? '└ ' : '';
      opts.push(`<option value="${t.id}">${indent}${prefix}${escapeHtml(t.name)} (${count})</option>`);
    });
    deptSel.innerHTML = opts.join('');
    deptSel.value = _hwDeptFilter;
  }
}

async function loadHardware() {
  let data;
  try {
    data = await fetchJson('/api/admin/hardware?type=' + encodeURIComponent(_hwActiveType));
  } catch (e) {
    if ($('hw-list')) $('hw-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _hwCache = data.hardware || [];
  renderHardwareRows();
}

function renderHardwareRows() {
  const listEl = $('hw-list');
  if (!listEl) return;
  const tab = HW_TYPES.find(t => t.id === _hwActiveType);
  const isPc = _hwActiveType === 'pc';

  // Re-render filter dropdowns (PC only) — counts + active state
  if (isPc) renderHwFilters();

  const q = _hwSearch.trim().toLowerCase();
  // v1.9.61 — list = ผ่าน filter ทุกตัว (PC) หรือ search อย่างเดียว (Device/Network)
  const list = isPc
    ? _hwCache.filter(h => applyHwFiltersExcept(h, null, q))
    : _hwCache.filter(h => _searchMatchHw(h, q));

  const filterActive = !!q || (isPc && (_hwOsFilter || _hwDeptFilter || _hwLinkFilter || _hwGraveyard));
  if ($('hw-count')) {
    $('hw-count').textContent = filterActive
      ? `${list.length} / ${_hwCache.length} รายการ`
      : `${_hwCache.length} รายการ`;
  }
  if (_hwCache.length === 0) {
    listEl.innerHTML = `<div class="empty">${escapeHtml(tab.emptyText)} — กด <strong>+ เพิ่ม</strong></div>`;
    return;
  }
  if (list.length === 0) {
    const reasons = [];
    if (q) reasons.push(`คำค้น "<strong>${escapeHtml(_hwSearch)}</strong>"`);
    if (isPc && _hwOsFilter) {
      const labels = { mac: '🍎 Mac', windows: '🪟 Windows', linux: '🐧 Linux', other: 'อื่น ๆ' };
      reasons.push(`OS = <strong>${labels[_hwOsFilter] || _hwOsFilter}</strong>`);
    }
    if (isPc && _hwDeptFilter) {
      const tid = parseInt(_hwDeptFilter, 10);
      const team = _hwTeamsCache.find(t => t.id === tid);
      reasons.push(`แผนก = <strong>${escapeHtml(team ? team.name : _hwDeptFilter)}</strong>`);
    }
    if (isPc && _hwLinkFilter) {
      const linkLabels = { linked: '✅ เชื่อมแล้ว', central: '📦 คอมฯส่วนกลาง', unlinked: '🔓 ยังไม่ได้เชื่อม', personal: '🙋 ใช้เครื่องตนเอง' };
      reasons.push(`การเชื่อมโยง = <strong>${linkLabels[_hwLinkFilter] || _hwLinkFilter}</strong>`);
    }
    listEl.innerHTML = `<div class="empty">ไม่พบรายการที่ตรงกับ ${reasons.join(' + ')}</div>`;
    return;
  }
  // v1.9.250 — PC แสดงเป็น card grid (เหมือนหน้าคอมส่วนกลาง) · Device/Network แสดงเป็น list เดิม
  const ordered = isPc ? _hwSortList(list) : list;   // v1.9.251 — เรียงตามวันสั่งซื้อ (ถ้าเลือก)
  const cardsHtml = ordered.map(h => renderHardwareRow(h)).join('');
  listEl.innerHTML = isPc
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:8px">${cardsHtml}</div>`
    : cardsHtml;
  // v1.9.217 — คลิกที่การ์ดทั้งใบ → เปิด slide-in รายละเอียด (ปุ่มดูรูปยังคลิกได้)
  listEl.querySelectorAll('.hw-card[data-hw-card]').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button[data-hw-act]')) return;   // ปล่อยให้ปุ่มในการ์ด (ดูรูป) ทำงานเอง
      const h = _hwCache.find(x => x.id === parseInt(card.dataset.hwCard, 10));
      if (h) showHardwareDetail(h);
    });
  });
  listEl.querySelectorAll('button[data-hw-act]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); handleHardwareAction(btn); });
  });
}

// v1.9.73 — Asset line component: chip + เลข asset แบบ monospace — ใช้เป็นบรรทัดแรกใน PC card
function renderHwAssetLine(assetNumber, opts) {
  if (!assetNumber) return '';
  opts = opts || {};
  const compact = opts.compact === true;
  const chipFs = compact ? '10px' : '11px';
  const numFs = compact ? '12.5px' : '14px';
  return `<div style="display:flex;align-items:center;gap:6px;font-weight:800;letter-spacing:.3px">
    <span style="display:inline-flex;align-items:center;padding:2px 9px;border-radius:6px;font-size:${chipFs};font-weight:700;background:rgba(37,99,235,.12);color:var(--primary);letter-spacing:.5px;text-transform:uppercase">🔖 Asset</span>
    <span style="font-family:ui-monospace,Menlo,monospace;font-size:${numFs};color:var(--text)">${escapeHtml(assetNumber)}</span>
  </div>`;
}

// v1.9.250 — การ์ด PC แบบ compact grid (เหมือนหน้าคอมส่วนกลาง) + owner/อายุ/รูป
function _renderPcGridCard(h) {
  const isMac = (typeof _pcDashIsMac === 'function') ? _pcDashIsMac(h) : /mac/i.test((h.os || '') + (h.model || '') + (h.name || ''));
  const ageStr = calcHwAgeStr(h.purchased_at);
  const typeBadge = isMac
    ? '<span style="font-size:10px;color:#7c3aed;font-weight:700">🍎 Mac</span>'
    : '<span style="font-size:10px;color:var(--text-muted)">💻 PC</span>';
  const st = h.status ? HW_STATUS_META[h.status] : null;
  let ownerHtml;
  if (h.current_member_label) {
    const m = _hwMembersCache.find(x => x.id === h.current_member_id);
    const av = (m && m.avatar_data)
      ? `<img src="${m.avatar_data}" alt="" style="width:15px;height:15px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
      : `<span style="width:15px;height:15px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:9px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml((h.current_member_label.trim().charAt(0) || '?').toUpperCase())}</span>`;
    ownerHtml = `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-soft);font-weight:500;font-size:10px;min-width:0"><span style="flex-shrink:0;display:inline-flex">${av}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(h.current_member_label)}</span></span>`;
  } else if (_isHwCentral(h)) {
    ownerHtml = `<span style="color:#3730a3;font-weight:600">📦 ส่วนกลาง${h.storage_location ? ' · ' + escapeHtml(h.storage_location) : ''}</span>`;
  } else {
    ownerHtml = '<span style="color:var(--text-muted)">🔓 ยังไม่ผูก</span>';
  }
  // v1.9.254 — รุ่นเป็น headline ตัวหน้า → sub ตัด model ออก (เหลือ OS/CPU/RAM/Storage)
  const sub = [h.os, h.cpu, h.ram, h.storage].filter(Boolean).map(escapeHtml).join(' · ');
  const assetTag = h.asset_number
    ? `<span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--primary);background:rgba(37,99,235,.1);padding:1px 6px;border-radius:4px;white-space:nowrap">🔖 ${escapeHtml(h.asset_number)}</span>`
    : '';
  const personalBadge = h.is_personal_owned
    ? '<span style="font-size:10px;font-weight:700;color:#7c3aed;background:rgba(124,58,237,.12);padding:1px 7px;border-radius:999px;white-space:nowrap">🙋 เครื่องตนเอง</span>'
    : '';
  // v1.9.258 — หมายเหตุ (+ หมวด) ใต้การ์ด
  const _pcCatLabel = { keep: '🔸 ยังไม่เปลี่ยน', procuring: '🛒 อยู่ระหว่างจัดหา', transferring: '🔄 ได้เครื่องใหม่ — transfer', transferring_rotation: '♻️ ได้เครื่องใหม่ (หมุนเวียน) — transfer' };
  const _pcCat = _pcCatLabel[h.note_category];
  const noteHtml = (h.notes || _pcCat)
    ? `<div style="font-size:10.5px;color:#92400e;margin-top:5px;background:rgba(245,158,11,.1);padding:3px 8px;border-radius:6px;line-height:1.4">📝 ${_pcCat ? `<b>${_pcCat}</b>${h.notes ? ' · ' : ''}` : ''}${escapeHtml(h.notes || '')}</div>`
    : '';
  const photoBtn = h.photo_data
    ? `<button type="button" data-hw-act="preview-photo" data-hw-id="${h.id}" data-hw-name="${escapeHtml(h.name)}" title="ดูรูป" style="background:transparent;border:none;padding:0;cursor:pointer;display:block"><img src="${h.photo_data}" alt="" style="width:46px;height:35px;object-fit:cover;border-radius:6px;border:1px solid var(--border);display:block" /></button>`
    : '';
  return `
    <div class="card hw-card" data-hw-card="${h.id}" title="คลิกดูรายละเอียด + แก้ไข"
      style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 13px;margin-bottom:0;border-left:3px solid ${isMac ? '#7c3aed' : '#6366f1'};cursor:pointer">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:7px;flex-wrap:wrap">
          <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(h.model || h.name || '—')}</span> ${typeBadge}
          ${st ? `<span style="font-size:10px;font-weight:700;color:${st.fg}">${st.label}</span>` : ''}
        </div>
        ${(h.model && h.name && h.name !== h.model) ? `<div style="font-size:10.5px;color:var(--text-soft);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🖥 ${escapeHtml(h.name)}</div>` : ''}
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">${sub || '—'}</div>
        <div style="font-size:11px;margin-top:4px;display:flex;align-items:center;gap:7px;flex-wrap:wrap">${ownerHtml} ${assetTag} ${personalBadge}</div>
        ${noteHtml}
      </div>
      <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        ${photoBtn}
        ${ageStr ? `<div style="font-size:11px;color:var(--accent);font-weight:600;white-space:nowrap">⏱ ${escapeHtml(ageStr)}</div>` : ''}
      </div>
    </div>
  `;
}

function renderHardwareRow(h) {
  // v1.9.250 — PC ใช้การ์ด compact grid · Device/Network ใช้ row เดิม
  if (h.hw_type === 'pc') return _renderPcGridCard(h);
  // v1.9.217 — spec line สะอาด: ตัด emoji ต่อรายการ + แยก meta รอง (SN/วันที่/ที่เก็บ) เป็นบรรทัดจาง
  const specs = [];
  if (h.hw_type === 'pc') {
    if (h.model) specs.push(escapeHtml(h.model));
    if (h.os) specs.push(escapeHtml(h.os) + (h.os_version ? ' ' + escapeHtml(h.os_version) : ''));
    if (h.cpu) specs.push(escapeHtml(h.cpu));
    if (h.ram) specs.push(escapeHtml(h.ram));
    if (h.storage) specs.push(escapeHtml(h.storage));
    if (h.display) specs.push(escapeHtml(h.display));
  } else if (h.hw_type === 'device') {
    if (h.device_subtype) specs.push(escapeHtml(h.device_subtype));
    if (h.capacity) specs.push(escapeHtml(h.capacity));
  }
  // v1.9.231 — PC: วันที่ซื้อแสดงเป็นบล็อกปฏิทิน (เดือน+ปี พ.ศ.) + อายุการใช้งาน แทนข้อความบรรทัดรอง
  const isPc = h.hw_type === 'pc';
  const tile = isPc ? renderMyDevicePurchaseTile(h.purchased_at) : '';
  const ageStr = isPc ? calcHwAgeStr(h.purchased_at) : '';
  const meta2 = [];
  if (h.serial_number) meta2.push('SN ' + escapeHtml(h.serial_number));
  if (h.purchased_at && !isPc) meta2.push(escapeHtml(fmtDateThai(h.purchased_at)));
  if (h.department || h.location) meta2.push([h.department, h.location].filter(Boolean).map(escapeHtml).join(' / '));
  const _sep = ' <span style="color:var(--border)">·</span> ';
  const specLine = specs.length ? specs.join(_sep) : '<span style="color:var(--text-muted);font-style:italic">— ไม่มีรายละเอียด</span>';
  const meta2Line = meta2.length ? `<div style="font-size:11px;color:var(--text-soft);line-height:1.5;margin-top:1px">${meta2.join(_sep)}</div>` : '';

  // Status badge (PC only — device/network ไม่มี status field)
  const statusBadge = (h.hw_type === 'pc') ? hwStatusBadge(h.status) : '';

  // Owner badge — มี owner = 👤 / คอมส่วนกลาง = 📦 ส่วนกลาง / ที่เหลือ = 🔓 ยังไม่ผูก
  const ownerBadge = h.current_member_label
    ? `<span title="${escapeHtml(h.current_member_username || '')}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.10);color:var(--green)">👤 ${escapeHtml(h.current_member_label)}</span>`
    : (_isHwCentral(h)
        ? `<span title="คอมส่วนกลาง${h.storage_location ? ' · ที่เก็บ: ' + escapeHtml(h.storage_location) : ''}" style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(99,102,241,.12);color:#3730a3">📦 ส่วนกลาง</span>`
        : `<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:var(--bg-soft);color:var(--text-muted)">🔓 ยังไม่ผูก</span>`);

  // Owner avatar overlay (มุมขวาล่างของรูปอุปกรณ์) — แสดงเฉพาะถ้าผูกกับ owner
  let ownerAvatarOverlay = '';
  if (h.current_member_id) {
    const m = _hwMembersCache.find(x => x.id === h.current_member_id);
    if (m) {
      const display = h.current_member_label || m.display_name || m.email || '?';
      const inner = m.avatar_data
        ? `<img src="${m.avatar_data}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />`
        : `<span style="width:100%;height:100%;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:20px">${escapeHtml((display.trim().charAt(0) || '?').toUpperCase())}</span>`;
      // ขนาดเท่าความสูงของรูปอุปกรณ์ (45px) วงกลม + offset เล็กน้อยให้ลอยออกมุมขวาล่าง
      ownerAvatarOverlay = `<div title="${escapeHtml(display)}" style="position:absolute;right:-8px;bottom:-8px;width:45px;height:45px;border-radius:50%;overflow:hidden;border:2.5px solid var(--bg-card);background:var(--bg-card);box-shadow:0 2px 6px rgba(0,0,0,.22);pointer-events:none">${inner}</div>`;
    }
  }
  // Photo thumbnail (left side) — 60x45 4:3 thumb + owner overlay มุมขวาล่าง
  const thumbStyleCommon = 'position:relative;flex-shrink:0;overflow:visible';
  const thumb = h.photo_data
    ? `<button type="button" data-hw-act="preview-photo" data-hw-id="${h.id}" data-hw-name="${escapeHtml(h.name)}" style="${thumbStyleCommon};background:transparent;border:none;padding:0;cursor:pointer" title="คลิกเพื่อดูภาพเต็ม"><img src="${h.photo_data}" alt="photo" style="width:60px;height:45px;object-fit:cover;border-radius:6px;border:1px solid var(--border);display:block" />${ownerAvatarOverlay}</button>`
    : `<div style="${thumbStyleCommon};width:60px;height:45px;border-radius:6px;border:1px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;font-size:18px">${HW_TYPES.find(t => t.id === h.hw_type)?.icon || '📦'}${ownerAvatarOverlay}</div>`;

  // v1.9.73 — Asset No เป็นบรรทัดแรกที่เด่น (ถ้ามี) — รายการอื่นอยู่ถัดไป
  const assetLine = renderHwAssetLine(h.asset_number);
  return `
    <div class="card hw-card" data-hw-card="${h.id}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;padding:10px 14px">
      ${thumb}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;overflow:hidden">
        ${assetLine}
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-weight:700;font-size:14.5px;color:var(--text)">${escapeHtml(h.name)}</span>
          ${statusBadge}
          ${ownerBadge}
        </div>
        <div style="font-size:12px;color:var(--text-muted);line-height:1.5;overflow:hidden;text-overflow:ellipsis">${specLine}</div>
        ${meta2Line}
        ${ageStr ? `<div style="font-size:11.5px;color:var(--accent);font-weight:600;margin-top:1px">⏱ ใช้งานมาแล้ว ${escapeHtml(ageStr)}</div>` : ''}
        ${h.notes ? `<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;margin-top:2px">📝 ${escapeHtml(h.notes.length > 80 ? h.notes.slice(0, 77) + '…' : h.notes)}</div>` : ''}
      </div>
      ${tile}
      <div class="hw-chev" style="flex-shrink:0;font-size:22px;line-height:1">›</div>
    </div>
  `;
}

// v1.9.217 — Slide-in รายละเอียดอุปกรณ์ (คลิกการ์ด) + ปุ่ม ประวัติ/แก้ไข/ลบ อยู่ข้างใน
function showHardwareDetail(h, onChange) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const statusBadge = (h.hw_type === 'pc') ? hwStatusBadge(h.status, { size: 'lg', fullLabel: true }) : '';
  // v1.9.255 — เจ้าของ = การ์ดคลิกได้ (รูป+ชื่อ) → เปิดโปรไฟล์ · ไม่มี owner = badge เดิม
  let ownerCardHtml = '', ownerBadge = '';
  if (h.current_member_id) {
    const om = _hwMembersCache.find(x => x.id === h.current_member_id);
    const oname = h.current_member_label || (om && (om.display_name || om.email)) || 'ผู้ใช้';
    const oav = (om && om.avatar_data)
      ? `<img src="${om.avatar_data}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
      : `<span style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:20px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml((String(oname).trim().charAt(0) || '?').toUpperCase())}</span>`;
    ownerCardHtml = `<button type="button" data-detail-act="owner" title="คลิกดูโปรไฟล์เจ้าของ"
      style="display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--bg-card);border:1px solid var(--border);border-radius:13px;padding:11px 14px;margin-bottom:16px;cursor:pointer;font-family:inherit;transition:border-color .12s,background .12s,box-shadow .12s"
      onmouseenter="this.style.borderColor='var(--primary)';this.style.background='var(--bg-hover)';this.style.boxShadow='var(--shadow-sm)'"
      onmouseleave="this.style.borderColor='var(--border)';this.style.background='var(--bg-card)';this.style.boxShadow='none'">
      ${oav}
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;margin-bottom:1px">👤 เจ้าของเครื่อง · คลิกดูโปรไฟล์</div>
        <div style="font-size:15.5px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(oname)}</div>
      </div>
      <span style="font-size:22px;color:var(--text-muted);flex-shrink:0;line-height:1">›</span>
    </button>`;
  } else if (_isHwCentral(h)) {
    ownerBadge = `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:999px;font-size:11.5px;font-weight:600;background:rgba(99,102,241,.12);color:#3730a3">📦 ส่วนกลาง${h.storage_location ? ' · ' + escapeHtml(h.storage_location) : ''}</span>`;
  } else {
    ownerBadge = `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--bg-soft);color:var(--text-muted)">🔓 ยังไม่ผูก</span>`;
  }
  const personalBadge = h.is_personal_owned ? '<span style="display:inline-flex;align-items:center;padding:3px 11px;border-radius:999px;font-size:11.5px;font-weight:700;background:rgba(124,58,237,.12);color:#7c3aed">🙋 ใช้คอมพิวเตอร์ของตนเอง</span>' : '';
  const rows = [];
  const add = (label, val) => {
    if (val == null || String(val).trim() === '') return;
    rows.push(`<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)"><div style="width:108px;flex-shrink:0;font-size:12px;color:var(--text-muted)">${label}</div><div style="flex:1;font-size:13px;color:var(--text);font-weight:500;word-break:break-word">${escapeHtml(String(val))}</div></div>`);
  };
  if (h.hw_type === 'pc') {
    add('รุ่น', h.model);
    add('OS', (h.os || '') + (h.os_version ? ' ' + h.os_version : ''));
    add('CPU', h.cpu);
    add('RAM', h.ram);
    add('Storage', h.storage);
    add('จอภาพ', h.display);
  } else if (h.hw_type === 'device') {
    add('ประเภท', h.device_subtype);
    add('ความจุ', h.capacity);
  }
  add('Serial', h.serial_number);
  if (h.purchased_at) add('ซื้อเมื่อ', (h.hw_type === 'pc') ? fmtMonthYearThai(h.purchased_at) : fmtDateThai(h.purchased_at));
  add('แผนก / ที่เก็บ', [h.department, h.location].filter(Boolean).join(' / '));
  add('โน้ต', h.notes);
  const photo = h.photo_data
    ? `<img src="${h.photo_data}" alt="" style="width:100%;max-height:200px;object-fit:contain;border-radius:10px;border:1px solid var(--border);background:var(--bg-soft);display:block;margin-bottom:14px" />`
    : '';
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:460px">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 24px 28px">
        ${renderHwAssetLine(h.asset_number)}
        <div style="font-size:18px;font-weight:800;margin:6px 0 8px">${escapeHtml(h.name)}</div>
        ${(statusBadge || ownerBadge || personalBadge) ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:${ownerCardHtml ? '12px' : '16px'}">${statusBadge}${ownerBadge}${personalBadge}</div>` : ''}
        ${ownerCardHtml}
        ${photo}
        <div style="border:1px solid var(--border);border-radius:12px;padding:4px 14px;margin-bottom:16px">${rows.join('') || '<div style="padding:14px 0;color:var(--text-muted);font-style:italic">— ไม่มีรายละเอียด —</div>'}</div>
        <div style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">📜 ประวัติการครอบครอง</div>
          <div id="hwd-history-list"><div class="empty" style="font-size:12px;padding:10px">กำลังโหลด…</div></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" data-detail-act="edit" style="flex:1;justify-content:center">✏️ แก้ไข / จัดการประวัติ</button>
          <button class="btn danger" data-detail-act="delete" style="flex:1;justify-content:center">🗑 ลบ</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
  const _ownerBtn = wrap.querySelector('[data-detail-act="owner"]');
  if (_ownerBtn) _ownerBtn.addEventListener('click', () => { _pcdOwnerPanel(h.current_member_id, onChange); });
  wrap.querySelector('[data-detail-act="edit"]').addEventListener('click', () => { close(); showHardwareModal(h, h.hw_type, onChange); });
  // v1.9.284 — แสดงประวัติการครอบครอง inline (read-only) ในแผงเลย
  (async () => {
    const box = wrap.querySelector('#hwd-history-list');
    if (!box) return;
    let items = [];
    try { items = (await fetchJson('/api/admin/hardware/' + h.id + '/history')).history || []; }
    catch (e) { box.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);padding:6px 0">โหลดประวัติไม่ได้</div>'; return; }
    if (!items.length) { box.innerHTML = '<div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:6px 0">— ยังไม่มีประวัติ —</div>'; return; }
    // v1.9.302 — current (ยังครอบครองอยู่) ต้องอยู่บนสุด → เรียง active ก่อน แล้วตาม assigned ใหม่→เก่า
    items.sort((a, b) => { const aA = !a.unassigned_at, bA = !b.unassigned_at; if (aA !== bA) return aA ? -1 : 1; return (b.assigned_at || '').localeCompare(a.assigned_at || ''); });
    // v1.9.295/297 — การ์ด: period ซ้าย · ขวา = avatar + ชื่อ + แผนก(ใต้ชื่อ) + capsule
    const _miniAv = (m, nm) => (m && m.avatar_data)
      ? `<img src="${m.avatar_data}" alt="" style="width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
      : `<span style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml((String(nm).trim().charAt(0) || '?').toUpperCase())}</span>`;
    box.innerHTML = items.map(r => {
      const fromYm = (r.assigned_at || '').slice(0, 7), toYm = r.unassigned_at ? r.unassigned_at.slice(0, 7) : null;
      const fromLabel = fromYm ? fmtMonthYearThai(fromYm) : '—';
      const isActive = !r.unassigned_at;
      const toLabel = toYm ? fmtMonthYearThai(toYm) : 'ปัจจุบัน';
      const m = r.member_id ? _hwMembersCache.find(x => x.id === r.member_id) : null;
      const nm = r.member_label || '— ไม่ผูก —';
      const dept = (m && m.teams && m.teams.length) ? m.teams[0].name : '';
      const cap = isActive
        ? '<span style="flex-shrink:0;font-size:10px;font-weight:700;background:rgba(16,185,129,.12);color:var(--green);padding:2px 8px;border-radius:999px">current</span>'
        : '<span style="flex-shrink:0;font-size:10px;font-weight:700;background:var(--bg-soft);color:var(--text-muted);padding:2px 8px;border-radius:999px">previous</span>';
      return `<div style="border:1px solid var(--border);border-radius:10px;padding:8px 11px;margin-bottom:6px;${isActive ? '' : 'opacity:.92'}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <span style="font-size:12px;font-weight:600;min-width:0;flex-shrink:0">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</span>
          <span style="display:flex;align-items:center;gap:8px;min-width:0">
            ${_miniAv(m, nm)}
            <span style="min-width:0">
              <span style="display:flex;align-items:center;gap:6px">
                <span style="font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(nm)}</span>
                ${cap}
              </span>
              ${dept ? `<div style="font-size:10px;color:var(--text-muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(dept)}</div>` : ''}
            </span>
          </span>
        </div>
        ${r.note ? `<div style="font-size:11px;color:var(--text-muted);font-style:italic;margin-top:5px">📝 ${escapeHtml(r.note)}</div>` : ''}
      </div>`;
    }).join('');
  })();
  wrap.querySelector('[data-detail-act="delete"]').addEventListener('click', async () => {
    if (!confirm(`ลบ "${h.name}"?\n\n(ประวัติการครอบครองจะถูกลบด้วย)`)) return;
    try { await fetchJson('/api/admin/hardware/' + h.id, { method: 'DELETE' }); close(); await (onChange || loadHardware)(); }
    catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
  });
}

async function handleHardwareAction(btn) {
  const id = parseInt(btn.dataset.hwId, 10);
  const act = btn.dataset.hwAct;
  if (act === 'edit') {
    const h = _hwCache.find(x => x.id === id);
    if (h) showHardwareModal(h, h.hw_type);
  } else if (act === 'delete') {
    const name = btn.dataset.hwName;
    if (!confirm(`ลบ "${name}"?\n\n(ประวัติการครอบครองจะถูกลบด้วย)`)) return;
    try {
      await fetchJson('/api/admin/hardware/' + id, { method: 'DELETE' });
      await loadHardware();
    } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
  } else if (act === 'history') {
    showHardwareHistoryModal(id, btn.dataset.hwName);
  } else if (act === 'preview-photo') {
    const h = _hwCache.find(x => x.id === id);
    if (h && h.photo_data) showHardwarePhotoModal(h);
  }
}

// Lightbox modal — แสดงรูปเต็ม
function showHardwarePhotoModal(h) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.style.zIndex = '1100';
  bg.innerHTML = `
    <div class="modal modal-wide" style="max-width:720px">
      <h3 style="margin:0 0 10px;font-size:16px;font-weight:700">🖼 ${escapeHtml(h.name)}</h3>
      <div style="background:#0f172a;border-radius:10px;overflow:hidden">
        <img src="${h.photo_data}" alt="photo" style="display:block;width:100%;height:auto;max-height:70vh;object-fit:contain;background:#0f172a" />
      </div>
      <div class="modal-actions" style="margin-top:14px">
        <button class="btn primary" id="hp-close">ปิด</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#hp-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
}

